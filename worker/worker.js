// Cloudflare Worker — всегда-живой контур публикации SMM-студии TrustNode.
//
//  fetch  : REST API (/kv, /files, /health, /debug, /tick) для Python-контура
//           подготовки (GitHub Actions) + админ-TG-бот (команды и inline-кнопки
//           одобрения). Карточки готовит GitHub; Worker публикует и админит.
//  scheduled: cron каждые 5 минут -> scheduler.tick (скан+дедуп, диспатч на
//           подготовку, авто-отложка черновиков, публикация из склада, аудиты,
//           аварийный фолбэк при аутэдже GitHub).

import * as kv from "./lib/kv.js";
import { loadSources } from "./lib/feeds.js";
import {
  tick as schedulerTick,
  dispatchToGitHub,
  publishPackage,
  publishText,
} from "./lib/scheduler.js";
import {
  sendMessage,
  sendPhoto,
  editMessageReplyMarkup,
  answerCallbackQuery,
  setMyCommands,
} from "./lib/telegram.js";
import { fmtTime, escHtml } from "./lib/text.js";
import { NEWS_WINDOWS, mskNow } from "./lib/config.js";
import { buildDailyAudit, buildWeeklyAudit, buildEventFallback } from "./lib/audits.js";
import { sendGeneratedPreview, approveButtons } from "./lib/preview.js";
import { renderCard } from "./lib/cardgen.js";

const VERSION = "2.0.0";

// ---------- тексты ----------

const WELCOME_TEXT =
  "🛡️ <b>TrustNode — SMM-студия</b>\n\n" +
  "Привет! Я собираю новости о цифровой безопасности, делаю карточки и " +
  "публикую их в Telegram и VK.\n\n" +
  "Как работать:\n" +
  "• Отправьте текст — подготовлю карточку и покажу превью на одобрение\n" +
  "• Новости нахожу сам, с дедупликацией одинаковых сюжетов\n" +
  "• Кнопки у превью: ✅ опубликовать, 🔄 переделать, ❌ отменить\n" +
  "• Полный список — /help\n\n" +
  "Работаю даже при аутэдже GitHub (публикую готовые посты со склада).";

const HELP_TEXT =
  "📖 <b>Команды студии</b>\n\n" +
  "/status — статус\n" +
  "/sources — источники и ключевые слова\n" +
  "/schedule — расписание слотов\n" +
  "/draft &lt;текст&gt; — подготовить карточку вручную\n" +
  "/publish — опубликовать ближайший пост со склада сейчас\n" +
  "/skip &lt;guid&gt; — пропустить кандидата\n" +
  "/audit daily|weekly|event — опубликовать аудит сейчас\n" +
  "/stats — статистика публикаций\n" +
  "/stock — склад готовых постов\n" +
  "/drafts — черновики на одобрении\n" +
  "/blacklist [add|del kw|src|guid &lt;значение&gt;] — чёрный список\n" +
  "/keyword add|remove &lt;слова&gt; — ключевые слова\n" +
  "/settings — настройки\n" +
  "/dryrun on|off — режим симуляции публикации\n" +
  "/autopost on|off — автопостинг находок\n" +
  "/export — выгрузка истории\n" +
  "/rescan — запустить полный тик\n" +
  "/version — версия";

const COMMANDS = [
  { command: "start", description: "Главное меню" },
  { command: "help", description: "Справка" },
  { command: "status", description: "Статус студии" },
  { command: "sources", description: "Источники и ключевые слова" },
  { command: "schedule", description: "Расписание постов" },
  { command: "draft", description: "Отправить текст на подготовку карточки" },
  { command: "publish", description: "Опубликовать сейчас" },
  { command: "skip", description: "Пропустить кандидата" },
  { command: "audit", description: "Опубликовать аудит" },
  { command: "stats", description: "Статистика" },
  { command: "blacklist", description: "Чёрный список" },
  { command: "keyword", description: "Ключевые слова" },
  { command: "settings", description: "Настройки" },
  { command: "dryrun", description: "Dry-run вкл/выкл" },
  { command: "autopost", description: "Автопостинг вкл/выкл" },
  { command: "stock", description: "Склад постов" },
  { command: "drafts", description: "Черновики" },
  { command: "export", description: "Экспорт истории" },
  { command: "rescan", description: "Полный тик" },
  { command: "version", description: "Версия" },
];

// ---------- меню: reply-клавиатура + инлайн-кнопки ----------

const BTN_STATUS = "📊 Статус";
const BTN_NEW_POST = "✍️ Сделать пост";
const BTN_STOCK = "🗄 Склад";
const BTN_STATS = "📜 Статистика";
const BTN_SOURCES = "📡 Источники";
const BTN_SETTINGS = "⚙️ Настройки";
const BTN_HELP = "📖 Помощь";
const BTN_DRYRUN = "🧪 Dry-run";

// Постоянная reply-клавиатура под строкой ввода.
function replyKeyboard(rows) {
  return {
    keyboard: rows.map((r) => r.map((t) => ({ text: t }))),
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Текст новости или команда…",
  };
}

const MAIN_KB = replyKeyboard([
  [BTN_STATUS, BTN_NEW_POST],
  [BTN_STOCK, BTN_STATS],
  [BTN_SOURCES, BTN_SETTINGS],
  [BTN_DRYRUN, BTN_HELP],
]);

// Ответ по нажатию reply-кнопки -> команда (кроме «Сделать пост» — там подсказка).
const BTN_CMDS = {
  [BTN_STATUS]: "/status",
  [BTN_STOCK]: "/stock",
  [BTN_STATS]: "/stats",
  [BTN_SOURCES]: "/sources",
  [BTN_SETTINGS]: "/settings",
  [BTN_HELP]: "/help",
  [BTN_DRYRUN]: "/dryrun",
};

// ---------- утилиты ----------

function jsonResponse(value, status = 200) {
  return new Response(value === undefined || value === null ? "null" : JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function apiAuthorized(env, request) {
  const want = env.BOT_AUTH || env.WEBHOOK_SECRET || "";
  if (!want) return false;
  return request.headers.get("X-Bot-Auth") === want;
}

function bytesToBase64(bytes) {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

function minutesToClock(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function isAdmin(env, chatId) {
  return String(chatId) === String(env.TELEGRAM_ADMIN_CHAT_ID);
}

function toggle(list, value, add) {
  const arr = Array.isArray(list) ? list : [];
  if (add) {
    return arr.includes(value) ? arr : [...arr, value];
  }
  return arr.filter((x) => x !== value);
}

async function sendLong(env, chatId, text, opts = {}) {
  const CHUNK = 4000;
  const parts = [];
  for (let i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
  for (const p of parts.length ? parts : [""]) {
    await sendMessage(env, chatId, p, opts);
  }
}

async function ensureCommands(env) {
  if (!env.BOT_KV) return;
  const done = await env.BOT_KV.get("commands_set");
  if (done) return;
  await setMyCommands(env, COMMANDS);
  await env.BOT_KV.put("commands_set", String(Date.now()));
}

// ---------- REST API (для GitHub-контура подготовки и диагностики) ----------

async function handleApi(env, request, url) {
  // Публичный health-чек.
  if (url.pathname === "/health") {
    return jsonResponse({ ok: true, ts: Date.now(), version: VERSION });
  }

  // Диагностика webhook Telegram (getWebhookInfo; безопасно — токен не выдаётся).
  if (url.pathname === "/webhook" && request.method === "GET") {
    if (!env.TELEGRAM_BOT_TOKEN) return jsonResponse({ ok: false, error: "no token" });
    try {
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
      const data = await res.json();
      return jsonResponse(data);
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  }

  // Переустановка webhook на ТЕКУЩИЙ воркер. URL берётся из самого запроса
  // (атакующий не может увести webhook на свой сервер — только вернуть его сюда).
  if (url.pathname === "/setwebhook" && request.method === "POST") {
    if (!env.TELEGRAM_BOT_TOKEN || !env.WEBHOOK_SECRET) {
      return jsonResponse({ ok: false, error: "secrets missing" });
    }
    try {
      const origin = new URL(request.url).origin;
      const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: `${origin}/`,
          secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ["message", "callback_query", "edited_message"],
          drop_pending_updates: false,
        }),
      });
      const data = await res.json();
      return jsonResponse(data);
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  }

  // Ручной полный тик (диагностика/тесты, аналог /rescan для REST).
  if (url.pathname === "/tick" && request.method === "POST") {
    if (!(await apiAuthorized(env, request))) return new Response("Forbidden", { status: 403 });
    try {
      await schedulerTick(env);
      return jsonResponse({ ok: true });
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  }

  // Сводка внутреннего состояния (KV-слои, очереди).
  if (url.pathname === "/debug") {
    if (!(await apiAuthorized(env, request))) return new Response("Forbidden", { status: 403 });
    const state = await kv.loadState(env);
    const stock = await kv.getStock(env);
    const cands = await kv.getCandidates(env);
    const drafts = await kv.listDrafts(env);
    const log = await kv.getLog(env);
    return jsonResponse({
      state: {
        dry_run: !!state.dry_run,
        autopost: !!state.autopost,
        scan_chunk: state.meta?.scan_chunk ?? 0,
      },
      stock: stock.length,
      candidates: cands.length,
      drafts: drafts.length,
      log: log.length,
      seen_guids: state.seen_guids?.length || 0,
    });
  }

  // PNG-файлы (карточки): R2 приоритет, иначе base64 в KV.
  if (url.pathname.startsWith("/files/")) {
    const key = "files/" + url.pathname.slice("/files/".length);
    if (request.method === "PUT") {
      if (!(await apiAuthorized(env, request))) return new Response("Forbidden", { status: 403 });
      const ct = request.headers.get("Content-Type") || "application/octet-stream";
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (env.BOT_R2) {
        await env.BOT_R2.put(key, bytes, { httpMetadata: { contentType: ct } });
      } else if (env.BOT_KV) {
        await env.BOT_KV.put(key, bytesToBase64(bytes));
      } else {
        return new Response("No storage configured", { status: 500 });
      }
      return new Response("OK", { status: 200 });
    }
    if (request.method === "GET") {
      let body, ct = "application/octet-stream";
      if (env.BOT_R2) {
        const obj = await env.BOT_R2.get(key);
        if (!obj) return new Response("Not Found", { status: 404 });
        body = obj.body;
        ct = obj.httpMetadata?.contentType || ct;
      } else if (env.BOT_KV) {
        const b64 = await env.BOT_KV.get(key);
        if (b64 === null) return new Response("Not Found", { status: 404 });
        const bin = atob(b64);
        body = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      } else {
        return new Response("No storage configured", { status: 500 });
      }
      return new Response(body, {
        headers: { "Content-Type": ct, "Cache-Control": "public, max-age=3600" },
      });
    }
    return new Response("Method Not Allowed", { status: 405 });
  }

  // JSON-значения KV (state, draft:<id>, candidates, stock, publish_log).
  if (url.pathname === "/kv") {
    if (!(await apiAuthorized(env, request))) return new Response("Forbidden", { status: 403 });
    if (!env.BOT_KV) return new Response("KV not configured", { status: 500 });
    const key = url.searchParams.get("key");
    if (!key) return new Response("Bad Request", { status: 400 });
    if (request.method === "GET") {
      const value = await env.BOT_KV.get(key, "json");
      return jsonResponse(value);
    }
    if (request.method === "PUT") {
      await env.BOT_KV.put(key, await request.text());
      return new Response("OK", { status: 200 });
    }
    if (request.method === "DELETE") {
      await env.BOT_KV.delete(key);
      return new Response("OK", { status: 200 });
    }
    return new Response("Method Not Allowed", { status: 405 });
  }

  return null;
}

// ---------- одобрение черновиков (кнопки) ----------

// png в черновике хранится base64 (KV умеет только строки) — превращаем в байты.
function decodePng(b64) {
  if (!b64) return null;
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function approveDraft(env, draft, dry) {
  await publishPackage(
    env,
    {
      id: draft.id,
      kind: draft.kind || "news",
      title: draft.title || "",
      caption: draft.caption || "",
      png_key: draft.png_key || null,
      png: decodePng(draft.png) || null,
      link: draft.link || "",
      guid: draft.guid || "",
      source: draft.source || "",
      tags: draft.tags || [],
    },
    dry
  );
  await kv.deleteDraft(env, draft.id);
  try {
    await editMessageReplyMarkup(
      env,
      draft.admin_chat_id || env.TELEGRAM_ADMIN_CHAT_ID,
      draft.preview_message_id,
      []
    );
  } catch (e) {
    /* кнопки могли уже стереться */
  }
}

async function handleCallback(env, cq, state) {
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : null;
  const msgId = cq.message ? cq.message.message_id : null;
  const qid = cq.id;
  const data = cq.data || "";
  const sep = data.indexOf(":");
  const action = sep >= 0 ? data.slice(0, sep) : data;
  const draftId = sep >= 0 ? data.slice(sep + 1) : "";

  if (!isAdmin(env, chatId)) {
    try { await answerCallbackQuery(env, qid, "Нет доступа"); } catch (e) { /* ignore */ }
    return;
  }

  const dry = !!state.dry_run;

  if (action === "approve" && draftId) {
    const draft = await kv.loadDraft(env, draftId);
    if (!draft) {
      try { await answerCallbackQuery(env, qid, "Черновик уже обработан"); } catch (e) { /* ignore */ }
      return;
    }
    try {
      await approveDraft(env, draft, dry);
      await answerCallbackQuery(env, qid, "✅ Опубликовано в VK и TG");
    } catch (e) {
      try { await answerCallbackQuery(env, qid, `Ошибка: ${e.message.slice(0, 90)}`); } catch (e2) { /* ignore */ }
      try {
        await sendMessage(
          env,
          env.TELEGRAM_ADMIN_CHAT_ID,
          `⚠️ Не удалось опубликовать «${escHtml(draft.title || "")}»: ${escHtml(e.message)}`
        );
      } catch (e2) { /* ignore */ }
    }
    return;
  }

  if (action === "cancel" && draftId) {
    await kv.deleteDraft(env, draftId);
    try { await editMessageReplyMarkup(env, chatId, msgId, []); } catch (e) { /* ignore */ }
    try { await answerCallbackQuery(env, qid, "Черновик отменён"); } catch (e) { /* ignore */ }
    return;
  }

  if (action === "redo" && draftId) {
    const draft = await kv.loadDraft(env, draftId);
    if (!draft) {
      try { await answerCallbackQuery(env, qid, "Черновик не найден"); } catch (e) { /* ignore */ }
      return;
    }
    try { await answerCallbackQuery(env, qid, "🔨 Переделываю…"); } catch (e) { /* ignore */ }

    if (draft.kind === "generated") {
      // черновик создан воркером — перегенерируем текст и карточку локально
      const text = draft.raw_text || draft.caption || "";
      await kv.deleteDraft(env, draft.id);
      if (!text) {
        try { await sendMessage(env, env.TELEGRAM_ADMIN_CHAT_ID, "Нет исходного текста для переделки."); } catch (e2) { /* ignore */ }
        return;
      }
      try {
        await sendGeneratedPreview(env, env.TELEGRAM_ADMIN_CHAT_ID, text, {
          link: draft.link || "",
          source: draft.source || "",
        });
      } catch (e) {
        try {
          await sendMessage(env, env.TELEGRAM_ADMIN_CHAT_ID, `⚠️ Не удалось перегенерировать: ${escHtml(e.message)}`);
        } catch (e2) { /* ignore */ }
      }
      return;
    }

    const ok = await dispatchToGitHub(env, {
      guid: draft.id,
      auto_found: false,
      kind: "manual",
      title: draft.title || "",
      link: draft.link || "",
      text: draft.raw_text || draft.caption || "",
      chat_id: env.TELEGRAM_ADMIN_CHAT_ID,
    });
    if (!ok) {
      try {
        await sendMessage(
          env,
          env.TELEGRAM_ADMIN_CHAT_ID,
          "⚠️ GitHub недоступен — пересоздать карточку не смог. Черновик оставлен на одобрении."
        );
      } catch (e) { /* ignore */ }
      return;
    }
    // GitHub создаст новое превью с новыми кнопками — старый черновик гасим.
    await kv.deleteDraft(env, draft.id);
    try {
      await editMessageReplyMarkup(
        env,
        draft.admin_chat_id || env.TELEGRAM_ADMIN_CHAT_ID,
        draft.preview_message_id,
        []
      );
    } catch (e) { /* ignore */ }
    return;
  }

  // Инлайн-кнопки используются ТОЛЬКО на превью черновиков (✅/🔄/❌) выше.

  try { await answerCallbackQuery(env, qid, "Неизвестная кнопка"); } catch (e) { /* ignore */ }
}

// ---------- команды админа ----------

async function handleCommand(env, state, chatId, text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(" ").trim();
  const dry = !!state.dry_run;

  switch (cmd) {
    case "/start":
    case "/menu":
      await sendMessage(env, chatId, WELCOME_TEXT, {
        parse_mode: "HTML",
        reply_markup: MAIN_KB,
      });
      break;

    case "/help":
      await sendMessage(env, chatId, HELP_TEXT, {
        parse_mode: "HTML",
        reply_markup: MAIN_KB,
      });
      break;

    case "/status": {
      const config = await loadSources(env);
      const stock = await kv.getStock(env);
      const cands = await kv.getCandidates(env);
      const drafts = await kv.listDrafts(env);
      const log = await kv.getLog(env);
      const last = log[0];
      const lastLine = last
        ? `${escHtml(last.title || "")} — ${fmtTime(last.published_at)}`
        : "—";
      const msg =
        "📊 <b>Статус студии</b>\n\n" +
        `Режим: <b>${dry ? "dry-run" : "боевой"}</b>\n` +
        `Автопостинг: <b>${state.autopost ? "вкл" : "выкл"}</b>\n` +
        `Источников: <b>${config.feeds?.length || 0}</b>, ключевых слов: <b>${config.keywords?.length || 0}</b>\n` +
        `Склад: <b>${stock.length}</b>, кандидатов: <b>${cands.length}</b>, черновиков: <b>${drafts.length}</b>\n` +
        `Опубликовано всего: <b>${log.length}</b>\n` +
        `Последний пост: ${lastLine}\n\n` +
        "🛡️ TrustNode";
      await sendMessage(env, chatId, msg, { parse_mode: "HTML" });
      break;
    }

    case "/sources": {
      const config = await loadSources(env);
      const feeds = (config.feeds || []).map((f) => `• ${escHtml(f)}`).join("\n") || "—";
      const kw = escHtml((config.keywords || []).join(", ") || "—");
      const msg =
        "📡 <b>Источники</b>\n\n" + feeds + "\n\n🔑 <b>Ключевые слова:</b>\n" + kw;
      await sendLong(env, chatId, msg, { parse_mode: "HTML" });
      break;
    }

    case "/schedule": {
      const wins = NEWS_WINDOWS.map(
        (w) => `• ${minutesToClock(w.start)}–${minutesToClock(w.end)} → до ${w.cap} новостных постов`
      ).join("\n");
      const msg =
        "🗓 <b>Расписание (МСК)</b>\n\n" +
        wins +
        "\n" +
        `• ~21:30 — ежедневный аудит\n` +
        `• Вс ~21:00 — недельный аудит\n` +
        `• Пн ~20:00 — ивент`;
      await sendMessage(env, chatId, msg, { parse_mode: "HTML" });
      break;
    }

    case "/draft": {
      if (!args) {
        await sendMessage(env, chatId, "Формат: /draft &lt;текст новости&gt;");
        break;
      }
      await handleManualText(env, chatId, args, state);
      break;
    }

    case "/skip": {
      const cands = await kv.getCandidates(env);
      const target = args ? cands.find((c) => c.guid === args) : cands[0];
      if (!target) {
        await sendMessage(env, chatId, "Кандидатов на подготовку нет.");
        break;
      }
      await kv.setCandidates(env, cands.filter((c) => c.guid !== target.guid));
      await sendMessage(env, chatId, `⏭ Пропущен: ${escHtml(target.title || target.guid)}`);
      break;
    }

    case "/audit": {
      const kind = (args || "daily").toLowerCase();
      const msk = mskNow();
      const log = await kv.getLog(env);
      let text = null;
      let logKind = "daily_audit";
      if (kind === "weekly") {
        text = buildWeeklyAudit(log, msk);
        logKind = "weekly_audit";
      } else if (kind === "event") {
        text = buildEventFallback(log, msk);
        logKind = "event";
      } else {
        text = buildDailyAudit(log, msk);
      }
      if (!text) {
        await sendMessage(env, chatId, "Нет данных для аудита.");
        break;
      }
      const ok = await publishText(env, text, dry, logKind, {});
      await sendMessage(
        env,
        chatId,
        ok ? `✅ Аудит опубликован${dry ? " (dry-run)" : ""}` : "⚠️ Не удалось опубликовать аудит"
      );
      break;
    }

    case "/stats": {
      const log = await kv.getLog(env);
      const msk = mskNow();
      const today = log.filter((e) => {
        const t = new Date(e.published_at);
        return !Number.isNaN(t.getTime()) && mskNow(t).date === msk.date;
      }).length;
      const byKind = {};
      for (const e of log) byKind[e.kind || "news"] = (byKind[e.kind || "news"] || 0) + 1;
      const lines = Object.entries(byKind)
        .map(([k, v]) => `• ${k}: ${v}`)
        .join("\n");
      const msg =
        "📈 <b>Статистика</b>\n\n" +
        `Всего: <b>${log.length}</b>\nСегодня: <b>${today}</b>\n\n${lines || "—"}`;
      await sendMessage(env, chatId, msg, { parse_mode: "HTML" });
      break;
    }

    case "/blacklist": {
      const bl = state.blacklist || { sources: [], keywords: [], guids: [] };
      const m = args.match(/^(add|del|remove)\s+(source|src|keyword|kw|guid)\s+(.+)$/i);
      if (!m) {
        const src = bl.sources.join(", ") || "—";
        const kwL = bl.keywords.join(", ") || "—";
        const g = bl.guids.join(", ") || "—";
        await sendMessage(
          env,
          chatId,
          "🚫 <b>Чёрный список</b>\n\n" +
            `Источники: ${escHtml(src)}\nКлючевые слова: ${escHtml(kwL)}\nGUID: ${escHtml(g)}\n\n` +
            "Формат: /blacklist add|del kw|src|guid &lt;значение&gt;",
          { parse_mode: "HTML" }
        );
        break;
      }
      const add = m[1].toLowerCase() === "add";
      const what = m[2].toLowerCase();
      const value = m[3].trim();
      if (what === "src" || what === "source") bl.sources = toggle(bl.sources, value, add);
      else if (what === "kw" || what === "keyword") bl.keywords = toggle(bl.keywords, value, add);
      else bl.guids = toggle(bl.guids, value, add);
      state.blacklist = bl;
      await kv.saveState(env, state);
      await sendMessage(env, chatId, `✅ ${add ? "Добавлено" : "Удалено"} из чёрного списка: ${escHtml(value)}`);
      break;
    }

    case "/keyword": {
      const config = await loadSources(env);
      const m = args.match(/^(add|remove|del)\s+(.+)$/i);
      if (!m) {
        const kw = (config.keywords || []).join(", ") || "—";
        await sendMessage(env, chatId, `🔑 <b>Ключевые слова:</b>\n${escHtml(kw)}`, {
          parse_mode: "HTML",
        });
        break;
      }
      const add = m[1].toLowerCase() === "add";
      const value = m[2].trim();
      if (add) state.extra_keywords = toggle(state.extra_keywords, value, true);
      else state.removed_keywords = toggle(state.removed_keywords, value, true);
      await kv.saveState(env, state);
      await sendMessage(env, chatId, `✅ ${add ? "Добавлено" : "Удалено"} слово: ${escHtml(value)}`);
      break;
    }

    case "/settings": {
      const extra = state.extra_keywords?.length || 0;
      const removed = state.removed_keywords?.length || 0;
      const msg =
        "⚙️ <b>Настройки</b>\n\n" +
        `Режим: <b>${dry ? "dry-run" : "боевой"}</b>\n` +
        `Автопостинг: <b>${state.autopost ? "вкл" : "выкл"}</b>\n` +
        `Ключевые слова: +${extra} добавлено, −${removed} убрано\n` +
        `Окна (МСК): ${NEWS_WINDOWS.map((w) => `${minutesToClock(w.start)}–${minutesToClock(w.end)}`).join(", ")}`;
      await sendMessage(env, chatId, msg, { parse_mode: "HTML" });
      break;
    }

    case "/dryrun": {
      state.dry_run = args ? args === "on" : !state.dry_run;
      await kv.saveState(env, state);
      await sendMessage(env, chatId, `✅ Dry-run ${state.dry_run ? "включён" : "выключен"}`);
      break;
    }

    case "/autopost": {
      state.autopost = args === "on";
      await kv.saveState(env, state);
      await sendMessage(env, chatId, `✅ Автопостинг ${state.autopost ? "включён" : "выключен"}`);
      break;
    }

    case "/publish": {
      const stock = await kv.getStock(env);
      let pkg = null;
      if (args) pkg = stock.find((p) => p.id === args || p.guid === args);
      else pkg = stock[0];
      if (!pkg) {
        await sendMessage(env, chatId, args ? "Пост не найден на складе." : "Склад пуст.");
        break;
      }
      await kv.removeStock(env, pkg.id);
      try {
        await publishPackage(env, { ...pkg, scheduled_for: Date.now() }, dry);
        await sendMessage(env, chatId, `✅ Опубликовано${dry ? " (dry-run)" : ""}: ${escHtml(pkg.title || "")}`);
      } catch (e) {
        await kv.addStock(env, pkg);
        await sendMessage(env, chatId, `⚠️ Ошибка: ${escHtml(e.message)}`);
      }
      break;
    }

    case "/stock": {
      const stock = await kv.getStock(env);
      if (!stock.length) {
        await sendMessage(env, chatId, "🗄 Склад пуст.");
        break;
      }
      const lines = stock.map((p) => {
        const when = p.scheduled_for ? fmtTime(new Date(p.scheduled_for).toISOString()) : "—";
        return `• [${p.kind || "news"}] ${escHtml(p.title || p.id)} → ${when}`;
      });
      await sendLong(env, chatId, "🗄 <b>Склад</b>\n\n" + lines.join("\n"), { parse_mode: "HTML" });
      break;
    }

    case "/drafts": {
      const drafts = await kv.listDrafts(env);
      if (!drafts.length) {
        await sendMessage(env, chatId, "📝 Черновиков нет.");
        break;
      }
      const lines = drafts.map(
        (d) => `• ${escHtml(d.title || d.id)} [${d.status || "pending"}]`
      );
      await sendLong(env, chatId, "📝 <b>Черновики</b>\n\n" + lines.join("\n"), {
        parse_mode: "HTML",
      });
      break;
    }

    case "/export": {
      const log = await kv.getLog(env);
      const msg = "📦 <b>Экспорт publish_log</b>\n\n" + JSON.stringify(log, null, 1);
      await sendLong(env, chatId, msg, { parse_mode: "HTML" });
      break;
    }

    case "/rescan": {
      try {
        await schedulerTick(env);
        await sendMessage(env, chatId, "✅ Полный тик выполнен");
      } catch (e) {
        await sendMessage(env, chatId, `⚠️ Ошибка тика: ${escHtml(e.message)}`);
      }
      break;
    }

    case "/version":
      await sendMessage(env, chatId, `🧬 TrustNode SMM v${VERSION} (Worker publish contour)`);
      break;

    default:
      await sendMessage(env, chatId, "Неизвестная команда. Список — /help");
  }
}

// ---------- ручной черновик: текст -> генерация прямо в Worker ----------
// Текст -> генератор (LLM или правила) -> PNG-карточка -> превью админу
// с инлайн-кнопками одобрения. GitHub не нужен.

async function handleManualText(env, chatId, text, state) {
  try {
    await sendGeneratedPreview(env, chatId, text);
    await sendMessage(
      env,
      chatId,
      "🔨 <b>Карточка готова.</b> Кнопки под превью: ✅ опубликовать, 🔄 переделать, ❌ отменить.",
      { parse_mode: "HTML" }
    );
  } catch (e) {
    await sendMessage(
      env,
      chatId,
      `⚠️ Не удалось подготовить карточку: ${escHtml(e.message)}`
    );
  }
}

// ---------- входящие апдейты Telegram ----------

async function handleMessage(env, msg, state) {
  const chatId = msg.chat ? msg.chat.id : null;
  if (!chatId || !isAdmin(env, chatId)) {
    console.log(`[webhook] ignore msg from ${chatId}`);
    return;
  }
  const text = (msg.text || "").trim();
  if (!text) return;
  console.log(`[webhook] admin msg: ${text.slice(0, 60)}`);
  if (text === BTN_NEW_POST) {
    await sendMessage(
      env,
      chatId,
      "✍️ <b>Отправьте текст новости</b> — подготовлю карточку и пришлю превью на одобрение.",
      { parse_mode: "HTML", reply_markup: MAIN_KB }
    );
    return;
  }
  if (BTN_CMDS[text]) {
    await handleCommand(env, state, chatId, BTN_CMDS[text]);
    return;
  }
  if (text.startsWith("/")) {
    await handleCommand(env, state, chatId, text);
  } else {
    await handleManualText(env, chatId, text, state);
  }
}

async function handleUpdate(env, update) {
  const state = await kv.loadState(env);
  if (update.callback_query) {
    console.log(`[webhook] callback: ${(update.callback_query.data || "").slice(0, 40)}`);
    await handleCallback(env, update.callback_query, state);
  } else if (update.message) {
    await handleMessage(env, update.message, state);
  } else if (update.edited_message) {
    await handleMessage(env, update.edited_message, state);
  } else {
    console.log(`[webhook] unknown update ${update.update_id}`);
  }
}

// ---------- экспорт ----------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const api = await handleApi(env, request, url);
    if (api) return api;

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    let update;
    try {
      update = await request.json();
    } catch (e) {
      return new Response("Bad JSON", { status: 400 });
    }

    ctx.waitUntil(
      handleUpdate(env, update).catch((err) => console.log("webhook error:", err.message))
    );
    return new Response("OK", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    try {
      await ensureCommands(env);
    } catch (e) {
      console.log("ensureCommands error:", e.message);
    }
    try {
      await schedulerTick(env);
    } catch (e) {
      console.log("scheduled error:", e.message);
    }
  },
};
