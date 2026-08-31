// Cloudflare Worker — всегда-живой контур публикации SMM-студии TrustNode.
//
//  fetch  : REST API (/kv, /files, /health, /debug, /tick) для Python-контура
//           подготовки (GitHub Actions) + админ-TG-бот (команды и inline-кнопки
//           одобрения) + пользовательский контур (предложка, поддержка).
//  scheduled: cron каждые 5 минут -> scheduler.tick (скан+дедуп, автогенерация
//           карточек и наполнение склада, авто-отложка черновиков, публикация
//           из склада строго по слотам, догонка недостающей платформы).

import * as kv from "./lib/kv.js";
import { loadSources } from "./lib/feeds.js";
import {
  tick as schedulerTick,
  dispatchToGitHub,
  publishPackage,
  nextFreeSlot,
  rebuildDigestPreview,
  sendDigestTestPreview,
} from "./lib/scheduler.js";
import {
  getSchedule,
  setScheduleMode,
  setSlotsPerDay,
  resetSchedule,
  aiSchedulePlan,
  storeProposedSchedule,
  applyProposedSchedule,
  healthLine,
  moveWindow,
} from "./lib/schedule.js";
import {
  sendMessage,
  sendPhoto,
  editMessageReplyMarkup,
  answerCallbackQuery,
  setMyCommands,
  resolveTelegramChannel,
  vkCall,
} from "./lib/telegram.js";
import { fmtTime, escHtml } from "./lib/text.js";
import { ekbNow, plural } from "./lib/config.js";
import { sendGeneratedPreview, approveButtons } from "./lib/preview.js";
import { renderCard } from "./lib/cardgen.js";
import { eveningSummaryText, dayReportText, weekReportText, monthReportText, maybeSendReports, slotAnalyticsText, pollStatsText } from "./lib/analytics.js";
import { missedWindowsToday } from "./lib/ops.js";
import {
  handleUserStart,
  handleUserCallback,
  handleSuggestion,
  handleSuggestionCallback,
  handleSupportMessage,
  handleAdminSupportReply,
  startEventDialog,
  handleEventDialogMessage,
} from "./lib/support.js";
import {
  multiStatus,
  multigroupTick,
  multigroupTickGroup,
  approvePending,
  skipPending,
  loadMgConfig,
  saveMgConfig,
  resetMgConfig,
} from "./lib/multigroup.js";

const VERSION = "3.0.2";

// ---------- тексты ----------

const WELCOME_TEXT =
  "🛡️ <b>TrustNode — SMM-студия</b>\n\n" +
  "Привет! Я собираю новости о цифровой безопасности, делаю карточки и " +
  "публикую их в Telegram и VK.\n\n" +
  "Как работать:\n" +
  "• Отправьте текст — подготовлю карточку и покажу превью на одобрение\n" +
  "• Новости нахожу сам, с дедупликацией одинаковых сюжетов\n" +
  "• Кнопки у превью: 🌐 везде / 🔵 VK / 🟢 TG, 🔄 переделать, 🕓 отложить, ❌ отменить\n" +
  "• Меню внизу: 📊 контроль, 📝 черновики, 🗓 расписание\n" +
  "• Полный список — /help\n\n" +
  "Работаю даже при аутэдже GitHub (публикую готовые посты со склада).";

const HELP_TEXT =
  "📖 <b>Команды студии</b>\n\n" +
  "<b>Контроль:</b>\n" +
  "/status — статус, /stats — состав публикаций, /analytics — слоты окон\n" +
  "/report [вечер|день|неделя|месяц] — отчёты студии\n" +
  "<b>Контент:</b>\n" +
  "/draft &lt;текст&gt; — подготовить карточку (провайдер по расписанию)\n" +
  "/gemini | /gigachat | /noai &lt;текст&gt; — карточка конкретным провайдером\n" +
  "/drafts — черновики на одобрении, /defer [id] — отложить на слот\n" +
  "/stock — склад, /puball | /pubvk | /pubtg [id] — опубликовать\n" +
  "/skip &lt;guid&gt; — пропустить кандидата, /event — создать ивент\n" +
  "<b>Расписание:</b>\n" +
  "/schedule — окна, мод и AI-план по просадкам, /sources — источники и слова\n" +
  "<b>Настройки и служебное:</b>\n" +
  "/settings — настройки, /autopost on|off, /cardfmt gif|png|auto\n" +
  "/dryrun on|off — симуляция публикации\n" +
  "/blacklist add|del kw|src|guid &lt;значение&gt; — чёрный список\n" +
  "/keyword add|remove &lt;слова&gt; — ключевые слова\n" +
  "/rescan — полный тик, /export — история, /version — версия\n" +
  "/healthcheck — здоровье студии (пропуски окон, срывы, опросы)\n" +
  "<b>Мультигруппы VK:</b>\n" +
  "/mg — статус групп (DGC/LostLink/LostArt), /mg-tick — публикация по слотам\n" +
  "/mg-edit — конфиг групп, /mg-approve on|off — согласование постов\n" +
  "/mg-win · /mg-feed · /mg-chan — окна, ленты, арт-каналы\n" +
  "/menu — дополнительные кнопки (здоровье, рескан, экспорт…)";

const COMMANDS = [
  { command: "start", description: "Главное меню" },
  { command: "help", description: "Справка" },
  { command: "status", description: "Статус студии" },
  { command: "sources", description: "Источники и ключевые слова" },
  { command: "schedule", description: "Расписание постов" },
  { command: "draft", description: "Отправить текст на подготовку карточки" },
  { command: "gemini", description: "Создать пост от Gemini" },
  { command: "gigachat", description: "Создать пост от GigaChat" },
  { command: "noai", description: "Создать пост без ИИ" },
  { command: "publish", description: "Опубликовать сейчас (везде)" },
  { command: "puball", description: "Опубликовать со склада везде" },
  { command: "pubvk", description: "Опубликовать со склада в VK" },
  { command: "pubtg", description: "Опубликовать со склада в TG" },
  { command: "skip", description: "Пропустить кандидата" },
  { command: "event", description: "Создать ивент" },
  { command: "stats", description: "Состав публикаций" },
  { command: "report", description: "Отчёт студии: вечер|день|неделя|месяц" },
  { command: "analytics", description: "Аналитика слотов окон (день|неделя|месяц)" },
  { command: "blacklist", description: "Чёрный список" },
  { command: "keyword", description: "Ключевые слова" },
  { command: "settings", description: "Настройки" },
  { command: "cardfmt", description: "Формат карточек: gif|png|auto" },
  { command: "dryrun", description: "Dry-run вкл/выкл" },
  { command: "autopost", description: "Автопостинг вкл/выкл" },
  { command: "stock", description: "Склад постов" },
  { command: "drafts", description: "Черновики" },
  { command: "defer", description: "Отложить черновик на следующий слот" },
  { command: "export", description: "Экспорт истории" },
  { command: "rescan", description: "Полный тик" },
  { command: "digesttest", description: "Тестовое превью дайджеста" },
  { command: "version", description: "Версия" },
  { command: "mg", description: "Мультигруппы VK: статус" },
  { command: "mg-tick", description: "Мультигруппы VK: публикация сейчас" },
  { command: "mg-edit", description: "Мультигруппы VK: конфиг групп" },
  { command: "mg-approve", description: "Мультигруппы VK: согласование on|off" },
  { command: "healthcheck", description: "Здоровье студии" },
];

// ---------- меню: reply-клавиатура + инлайн-кнопки ----------

const BTN_STATUS = "📊 Статус";
const BTN_NEW_POST = "✍️ Сделать пост";
const BTN_NOAI = "📝 Пост без ИИ";
const BTN_STOCK = "🗄 Склад";
const BTN_DRAFTS = "📝 Черновики";
const BTN_STATS = "📜 Публикации";
const BTN_ANALYTICS = "📈 Аналитика";
const BTN_REPORT = "📉 Отчёты";
const BTN_SCHEDULE = "🗓 Расписание";
const BTN_SOURCES = "📡 Источники";
const BTN_SETTINGS = "⚙️ Настройки";
const BTN_HELP = "📖 Помощь";
const BTN_DRYRUN = "🧪 Dry-run";
const BTN_EVENT = "🎪 Ивент";
const BTN_MULTI = "👥 Мультигруппы";
const BTN_MORE = "☰ Ещё";

// Постоянная reply-клавиатура под строкой ввода.
function replyKeyboard(rows) {
  return {
    keyboard: rows.map((r) => r.map((t) => ({ text: t }))),
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Текст новости или команда…",
  };
}

// Мониторинг и контент — сверху (рабочий поток админа), система — ниже.
// Мультигруппы вынесены в первую строку: это основной ежедневный поток.
const MAIN_KB = replyKeyboard([
  [BTN_MULTI, BTN_STATUS, BTN_REPORT],
  [BTN_DRAFTS, BTN_STOCK, BTN_NEW_POST],
  [BTN_SCHEDULE, BTN_SOURCES, BTN_ANALYTICS],
  [BTN_SETTINGS, BTN_STATS, BTN_MORE],
  [BTN_HELP],
]);

// Ответ по нажатию reply-кнопки -> команда (кроме «Сделать пост» — там подсказка).
const BTN_CMDS = {
  [BTN_STATUS]: "/status",
  [BTN_STOCK]: "/stock",
  [BTN_DRAFTS]: "/drafts",
  [BTN_STATS]: "/stats",
  [BTN_ANALYTICS]: "/analytics",
  [BTN_REPORT]: "/report",
  [BTN_SCHEDULE]: "/schedule",
  [BTN_SOURCES]: "/sources",
  [BTN_SETTINGS]: "/settings",
  [BTN_HELP]: "/help",
  [BTN_DRYRUN]: "/dryrun",
  [BTN_NOAI]: "/noai",
  [BTN_EVENT]: "/event",
  [BTN_MULTI]: "/mg",
  [BTN_MORE]: "/menu",
};

// «☰ Ещё»: второстепенные команды, которым не место на главной клавиатуре.
const MORE_KB = {
  inline_keyboard: [
    [
      { text: "❤️ Здоровье", callback_data: "cmd:healthcheck" },
      { text: "🔄 Рескан", callback_data: "cmd:rescan" },
    ],
    [
      { text: "📤 Опубликовать всё", callback_data: "cmd:puball" },
      { text: BTN_STATS, callback_data: "cmd:stats" },
    ],
    [
      { text: "🎪 Ивент", callback_data: "cmd:event" },
      { text: BTN_DRYRUN, callback_data: "cmd:dryrun" },
    ],
    [
      { text: "🧪 Дайджест-тест", callback_data: "cmd:digesttest" },
      { text: "💾 Экспорт", callback_data: "cmd:export" },
    ],
  ],
};

// Быстрые inline-действия под отчётами/статусом — не выходя из ответа.
const QUICK_STATUS_KB = {
  inline_keyboard: [
    [
      { text: BTN_DRAFTS, callback_data: "cmd:drafts" },
      { text: BTN_STOCK, callback_data: "cmd:stock" },
      { text: BTN_REPORT, callback_data: "cmd:report" },
    ],
    [
      { text: "👥 Мультигруппы", callback_data: "cmd:mg" },
      { text: "🤖 AI-план", callback_data: "sched:ai" },
    ],
  ],
};

const QUICK_ANALYTICS_KB = {
  inline_keyboard: [
    [
      { text: BTN_STATUS, callback_data: "cmd:status" },
      { text: BTN_SCHEDULE, callback_data: "cmd:schedule" },
      { text: BTN_REPORT, callback_data: "cmd:report" },
    ],
  ],
};

// Быстрые действия под /mg: тик (всем/по группам), согласование, конфиг, статус.
const QUICK_MULTI_KB = {
  inline_keyboard: [
    [
      { text: "🚀 Всем", callback_data: "mg:tick" },
      { text: "✅ Согласование", callback_data: "mg:approve" },
    ],
    [
      { text: "🚀 DGC", callback_data: "mg:tick:dgc" },
      { text: "🚀 LostLink", callback_data: "mg:tick:lostlink" },
      { text: "🚀 LostArt", callback_data: "mg:tick:lostart" },
    ],
    [
      { text: "⚙️ Конфиг групп", callback_data: "cmd:mg-edit" },
      { text: BTN_STATUS, callback_data: "cmd:status" },
    ],
  ],
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

// Пингует Render-инстансы (/health), чтобы free tier не засыпал: без трафика
// ~15 мин инстанс уходит в cold start, и первый /digest или /render падает.
// Все ping — параллельно с коротким таймаутом: keep-warm не должен съедать
// wall-clock бюджет scheduled-хендлера, который нужен основному тику.
async function keepRenderWarm(env) {
  const urls = new Set();
  if (env.LLM_PROXY_URL) urls.add(String(env.LLM_PROXY_URL).trim());
  if (env.CARD_RENDER_URL) urls.add(String(env.CARD_RENDER_URL).trim());
  if (env.CARD_RENDER_URLS) {
    for (const u of Array.isArray(env.CARD_RENDER_URLS)
      ? env.CARD_RENDER_URLS
      : String(env.CARD_RENDER_URLS).split(",")) {
      if (u && String(u).trim()) urls.add(String(u).trim());
    }
  }
  const list = [...urls].filter(Boolean).slice(0, 3);
  await Promise.allSettled(list.map((base) =>
    fetch(`${String(base).replace(/\/+$/, "")}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(6000),
    }).then((r) => {
      if (!r.ok) throw new Error(`health ${r.status}`);
    })));
  for (const u of list) console.log(`[keep-warm] ping ${u}`);
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
  // Версионный флаг: команды переотправляются в Telegram при каждом деплое
  // (зафиксировали VERSION), а не только один раз в жизни бота.
  const done = await env.BOT_KV.get("commands_set");
  if (done === VERSION) return;
  await setMyCommands(env, COMMANDS);
  await env.BOT_KV.put("commands_set", VERSION);
}

// ---------- REST API (для GitHub-контура подготовки и диагностики) ----------

function escHtml2(s) {
  return String(s == null ? "" : s).replace(/[<>&"']/g, (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" }[m]));
}

// Лёгкий веб-дашборд без секретов: состояние студии из KV (публично открыт).
async function dashboardHtml(env, now = new Date()) {
  const sched = await getSchedule(env);
  const log = await kv.getLog(env) || [];
  const ekb = ekbNow();
  const missed = await missedWindowsToday(env, { now });
  const pollStats = await kv.getPollStats(env);
  const pollKeys = Object.keys(pollStats || {});
  const pollsTotal = pollKeys.reduce((s, k) => s + (pollStats[k].total || 0), 0);
  const todayCount = log.filter((e) => e && (e.vk_ok || e.tg_ok) && e.published_at && ekbNow(new Date(e.published_at)).date === ekb.date).length;

  const winRows = sched.windows.map((w) => `<tr><td>${escHtml2(w.label)}</td><td>${minutesToClock(w.start)}–${minutesToClock(w.end)}</td></tr>`).join("");
  const metricRows = [];
  for (let i = 6; i >= 0; i--) {
    const t = new Date(Date.UTC(ekb.date.slice(0,4), ekb.date.slice(5,7)-1, ekb.date.slice(8,10) - i));
    const d = t.toISOString().slice(0, 10);
    const r = await kv.getDayMetrics(env, d);
    if (r) metricRows.push(`<tr><td>${escHtml2(d)}</td><td>${r.posts || 0}</td><td>${r.vk_members != null ? r.vk_members : "—"}</td><td>${r.tg_members != null ? r.tg_members : "—"}</td><td>${r.vk_views || 0}</td><td>${r.vk_likes || 0}</td></tr>`);
  }
  const postRows = log.slice(-6).reverse().map((e) => `<tr><td>${escHtml2(e.window_slug || "—")}</td><td>${escHtml2(e.kind || "news")}</td><td>${escHtml2(e.published_at ? new Date(e.published_at).toISOString().slice(11, 16) : "—")} ЕКБ</td><td>${e.vk_ok ? "VK" : ""} ${e.tg_ok ? "TG" : ""}</td><td>${e.vk_views != null ? e.vk_views : "—"}</td></tr>`).join("");
  const cands = await kv.getCandidates(env) || [];
  const stock = await kv.getStock(env) || [];

  // Диагностика: смотрим KV глазами воркера (ключами и длинами), чтобы понять,
  // тот ли namespace читает рантайм (CLI и воркер расходились).
  let kvDiag = "нет (env.BOT_KV отсутствует)";
  try {
    if (env.BOT_KV && typeof env.BOT_KV.list === "function") {
      const res = await env.BOT_KV.list();
      const keys = (res.keys || []).map((k) => k.name);
      const sample = keys.slice(0, 40);
      const counts = {};
      for (const k of keys) {
        const prefix = k.split(":")[0];
        counts[prefix] = (counts[prefix] || 0) + 1;
      }
      const stateRaw = await env.BOT_KV.get("state", "json");
      kvDiag =
        `<b>ключей: ${keys.length}</b> | по префиксам: ${Object.entries(counts).map(([p, n]) => `${escHtml2(p)}:${n}`).join(" ")}` +
        `<br>попал 1-й: ${escHtml2(sample.join(",") || "—")}` +
        `<br>state запис. ${!!!stateRaw ? "НЕТ" : "есть"}${stateRaw && stateRaw.meta && stateRaw.meta.last_scan ? ` | last_scan=${escHtml2(JSON.stringify(stateRaw.meta.last_scan))}` : ""}`;
    }
  } catch (e) {
    kvDiag = `ошибка: ${escHtml2(e.message)}`;
  }

  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TrustNode · dashboard</title>
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;margin:24px}a{color:#38bdf8}table{border-collapse:collapse;width:100%;max-width:760px;margin:8px 0}th,td{border:1px solid #334155;padding:6px 10px;text-align:left}th{background:#1e293b}.badge{display:inline-block;padding:2px 8px;border-radius:10px;background:#1e293b;font-size:12px}.ok{color:#4ade80}.warn{color:#facc15}.bad{color:#f87171}</style></head>
<body><h1>🛡️ TrustNode <span style="color:#64748b">в${VERSION}</span></h1>
<p><span class="badge">Авто: <b>${await kv.getAutopost(env) ? '<span class="ok">вкл</span>' : '<span class="warn">выкл</span>'}</b></span>
<span class="badge">Постов сегодня: <b>${todayCount}</b></span>
<span class="badge">Пропущено окон: <b class="${missed.length ? "bad" : "ok"}">${missed.length}</b></span>
<span class="badge">Ответы на опросы: <b>${pollsTotal}</b></span>
<span class="badge">Кандидаты: <b>${cands.length}</b></span>
<span class="badge">Склад: <b>${stock.length}</b></span></p>

<h2>🔍 KV (глазами воркера)</h2>
<p style="font-family:monospace;font-size:12px;word-break:break-all">${kvDiag}</p>

<h2>🗓 Расписание (ЕКБ) · ${sched.mode}</h2>
<table><tr><th>Окно</th><th>Время</th></tr>${winRows}</table>
${missed.length ? `<p class="bad">Пропущенные окна сегодня: ${missed.map((w) => escHtml2(w.label)).join(", ")}</p>` : `<p class="ok">Пропущенных окон сегодня нет.</p>`}

<h2>📈 Метрики · 7 дней</h2>
<table><tr><th>Дата</th><th>Посты</th><th>VK</th><th>TG</th><th>Просмотры VK</th><th>Лайки</th></tr>${metricRows.join("") || `<tr><td colspan="6">пока нет данных</td></tr>`}</table>

<h2>📰 Последние публикации</h2>
<table><tr><th>Окно</th><th>Формат</th><th>Время</th><th>Платформы</th><th>Просмотры</th></tr>${postRows || `<tr><td colspan="5">пока нет постов</td></tr>`}</table>

<p style="color:#64748b">Страница без секретов — защищена только отсутствием публикации в меню. Это мониторинг, не панель управления.</p>
</body></html>`;
}

async function handleApi(env, request, url) {
  // Публичный health-чек.
  if (url.pathname === "/health") {
    return jsonResponse({ ok: true, ts: Date.now(), version: VERSION });
  }

  // Публичный веб-дашборд (read-only, без секретов).
  if (url.pathname === "/dashboard" && request.method === "GET") {
    const html = await dashboardHtml(env, new Date());
    return new Response(html, {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
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
          allowed_updates: ["message", "callback_query", "edited_message", "poll_answer"],
          drop_pending_updates: false,
        }),
      });
      const data = await res.json();
      return jsonResponse(data);
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  }

  // Диагностика VK: проверяет доступные пути загрузки фото групповому токену и
  // как VK парсит ссылку-карточку (wall.parseAttachedLink). Без секретов.
  if (url.pathname === "/vk-diag" && request.method === "GET") {
    if (!(await apiAuthorized(env, request))) return new Response("Forbidden", { status: 403 });
    try {
      const out = { group_id: env.VK_GROUP_ID || null, album_id: env.VK_ALBUM_ID || null, steps: [] };
      if (!env.VK_TOKEN) return jsonResponse({ ...out, error: "VK_TOKEN не задан" });
      const snap = (n, resp) => `${n}: ${typeof resp === "string" ? resp.slice(0, 220) : JSON.stringify(resp).slice(0, 220)}`;
      const png1x1 = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 218, 99, 96, 96, 96, 0, 0, 0, 5, 0, 1, 86, 143, 103, 42, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

      // -1. Какие права реально у токена (groups.getTokenPermissions) и кому он
      // принадлежит — объясняет error 27 на read-методах.
      try {
        const perms = await vkCall(env, "groups.getTokenPermissions");
        const names = (perms.permissions || []).map((p) => `${p.name}=${p.setting}`);
        const mask = perms.mask != null ? perms.mask : null;
        out.steps.push({ step: -1, ok: true, note: snap("getTokenPermissions", `mask=${mask} perms=${JSON.stringify(names)}`) });
      } catch (e) {
        out.steps.push({ step: -1, ok: false, note: "groups.getTokenPermissions " + e.message });
      }

      // 0. photos.getAlbums — доступен ли альбомный путь.
      try {
        const albums = await vkCall(env, "photos.getAlbums", { owner_id: -env.VK_GROUP_ID, need_system: 1 });
        out.steps.push({ step: 0, ok: true, note: snap("getAlbums", `count=${(albums.items || []).length}`) });
      } catch (e) {
        out.steps.push({ step: 0, ok: false, note: "photos.getAlbums " + e.message });
      }

      // 0c. docs.getWallUploadServer — загрузка документа-картинки на стену.
      // Изображение как doc (type 3) рендерится в посте картинкой. Это отдельный
      // от photos механизм; требует docs-scope (у нас есть) и group_id.
      try {
        const dws = await vkCall(env, "docs.getWallUploadServer", { group_id: env.VK_GROUP_ID });
        out.steps.push({ step: 0, ok: true, note: snap("docs.getWallUploadServer", `upload_url=${(dws.upload_url||"").slice(0,70)}...`) });
        if (dws.upload_url) {
          const cardUrl2 = env.OWNER && env.REPO
            ? `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.png`
            : null;
          const real2 = cardUrl2 ? await (await fetch(cardUrl2)).arrayBuffer() : null;
          const img = real2 && real2.byteLength > 100 ? new Uint8Array(real2) : png1x1;
          const fd2 = new FormData();
          fd2.append("file", new Blob([img], { type: "image/png" }), "card.png");
          // pu.vk.com может отдавать HTML-капчу/WAF — шлём браузерный UA и
          // читаем строку целиком, затем парсим JSON (не переиспользуем body).
          let bodyText = "";
          try {
            const resp = await fetch(dws.upload_url, {
              method: "POST",
              body: fd2,
              headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36", Accept: "*/*" },
            });
            bodyText = await resp.text();
          } catch (e3) {
            bodyText = "fetch ERR " + e3.message;
          }
          let ur = { _html: bodyText.slice(0, 120) };
          try { ur = JSON.parse(bodyText); } catch (e) { /* оставляем _html */ }
          out.steps[out.steps.length - 1].note += " | raw=" + JSON.stringify(ur).slice(0, 200);
          if (ur.file) {
            try {
              const saved = await vkCall(env, "docs.save", { file: ur.file });
              const d = (saved && saved[0]) || saved;
              out.steps[out.steps.length - 1].note += ` | docs.save raw=${JSON.stringify(saved).slice(0,160)}`;
              if (d && d.id) out.steps[out.steps.length - 1].note += ` | ok => doc${d.owner_id}_${d.id} type=${d.type} ext=${d.ext}`;
            } catch (e2) {
              out.steps[out.steps.length - 1].note += " | docs.save ERR " + e2.message;
            }
          }
        }
      } catch (e) {
        out.steps.push({ step: 0, ok: false, note: "docs.getWallUploadServer " + e.message });
      }

      // 0e. (только ?test_post=5) прикрепить doc-картинку к wall.post — проверить,
      // что VK рендерит документ-изображение в посте как фото. docId из ?doc=.
      if (url.searchParams.get("test_post") === "5" && env.VK_GROUP_ID) {
        const docId = url.searchParams.get("doc") || "";
        try {
          const p5 = await vkCall(env, "wall.post", {
            owner_id: -env.VK_GROUP_ID,
            from_group: 1,
            message: `Тест doc-фото: ${docId}`,
            attachments: `doc-${env.VK_GROUP_ID}_${docId}`,
          });
          out.steps.push({ step: 0, ok: true, note: snap("wall.post doc", `post=${p5.post_id} attach=doc-${env.VK_GROUP_ID}_${docId}`) });
        } catch (e) {
          out.steps.push({ step: 0, ok: false, note: "wall.post doc " + e.message });
        }
      }

      // 0e.2. (только ?test_post=6) прикрепить messages-фото (реальную карточку,
      // photo-<gid>_<pid>) к wall.post и проверить, рендерит ли VK его как фото.
      if (url.searchParams.get("test_post") === "6" && env.VK_GROUP_ID) {
        const pid = url.searchParams.get("photo") || "";
        try {
          const p6 = await vkCall(env, "wall.post", {
            owner_id: -env.VK_GROUP_ID,
            from_group: 1,
            message: "Тест messages-фото (реальная карточка)",
            attachments: `photo-${env.VK_GROUP_ID}_${pid}`,
          });
          out.steps.push({ step: 0, ok: true, note: snap("wall.post mphoto", `post=${p6.post_id} attach=photo-${env.VK_GROUP_ID}_${pid}`) });
        } catch (e) {
          out.steps.push({ step: 0, ok: false, note: "wall.post mphoto " + e.message });
        }
      }

      // 0f. photos.copy() (копирует messages-фото в публичный альбом сообщества)
      try {
        const cp = await vkCall(env, "photos.copy", {
          owner_id: -env.VK_GROUP_ID,
          photo_id: url.searchParams.get("photo") || "",
          access_key: url.searchParams.get("ak") || "",
        });
        out.steps.push({ step: 0, ok: true, note: snap("photos.copy", `copy=${JSON.stringify(cp)}`) });
      } catch (e) {
        out.steps.push({ step: 0, ok: false, note: "photos.copy " + e.message });
      }

      // 0d. docs.getMessagesUploadServer — тоже вариант загрузки doc-картинки.
      try {
        const dms = await vkCall(env, "docs.getMessagesUploadServer");
        out.steps.push({ step: 0, ok: true, note: snap("docs.getMessagesUploadServer", `upload_url=${(dms.upload_url||"").slice(0,70)}...`) });
      } catch (e) {
        out.steps.push({ step: 0, ok: false, note: "docs.getMessagesUploadServer " + e.message });
      }

      // 0a. photos.getWallUploadServer с group_id — единственный «стеновой» путь,
      // который community-токену положено вызывать именно с group_id.
      try {
        const ws = await vkCall(env, "photos.getWallUploadServer", { group_id: env.VK_GROUP_ID });
        out.steps.push({ step: 0, ok: true, note: snap("getWallUploadServer", `upload_url=${(ws.upload_url||"").slice(0,60)}...`) });
      } catch (e) {
        out.steps.push({ step: 0, ok: false, note: "photos.getWallUploadServer " + e.message });
      }

      // 0b. photos.saveMessagesPhoto путь (рабочий обход для вызыхализupload).
      try {
        const cardUrl = env.OWNER && env.REPO
          ? `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.png`
          : null;
        const real = cardUrl ? await (await fetch(cardUrl)).arrayBuffer() : null;
        const up = await vkCall(env, "photos.getMessagesUploadServer");
        const fd = new FormData();
        const pngBytes = real && real.byteLength > 100 ? new Uint8Array(real) : png1x1;
        fd.append("photo", new Blob([pngBytes], { type: "image/png" }), "photo.png");
        const r = await fetch(up.upload_url, { method: "POST", body: fd });
        const upRes = await r.json();
        const uploadedPhoto =
          upRes.photo ||
          (upRes.files && upRes.files.photo && `${upRes.files.photo.sha}_${upRes.files.photo.secret}`) ||
          "";
        out.steps.push({ step: 1, ok: !!uploadedPhoto, bytes: pngBytes.length, note: snap("upload", upRes) });
        if (uploadedPhoto) {
          try {
            const saved = await vkCall(env, "photos.saveMessagesPhoto", { photo: uploadedPhoto, server: upRes.server, hash: upRes.hash });
            const p = saved[0];
            out.steps[out.steps.length - 1].note = snap("saveMessagesPhoto", `photo${p.owner_id}_${p.id} sizes=${(p.sizes||[]).length}`);
          } catch (e) {
            out.steps[out.steps.length - 1].note += " | saveMessagesPhoto " + e.message;
          }
        }
      } catch (e) {
        out.steps.push({ step: 1, ok: false, note: "messages-upload " + e.message });
      }

      // 2. wall.parseAttachedLink — как VK видит ссылку-карточку (raw GitHub).
      if (env.OWNER && env.REPO) {
        const cardUrl = `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.png`;
        try {
          out.steps.push({ step: 2, note: "parseAttachedLink probe: " + cardUrl });
          const parsed = await vkCall(env, "wall.parseAttachedLink", { links: cardUrl });
          const l = parsed.links && parsed.links[0];
          out.steps[out.steps.length - 1].ok = !!l;
          out.steps[out.steps.length - 1].has_photo = !!(l && l.photo);
          out.steps[out.steps.length - 1].note = snap("parseAttachedLink", l ? { url: l.url, title: (l.title||"").slice(0,40), has_photo: !!l.photo } : parsed);
        } catch (e) {
          out.steps.push({ step: 2, ok: false, note: "wall.parseAttachedLink " + e.message });
        }
      }

// 3. (только ?test_post=1) живьём постим HTML-превью на стену и возвращаем
      // post_id — проверить, что VK поднял og:image-превью (не link_photo_sizing_rule).
      out.steps.push({ step: 3, note: `gate test_post=${url.searchParams.get("test_post")} owner=${env.OWNER} repo=${env.REPO} gid=${env.VK_GROUP_ID}` });
      if (url.searchParams.get("test_post") === "1" && env.OWNER && env.REPO && env.VK_GROUP_ID) {
        const githubHtml = `https://${env.OWNER}.github.io/${env.REPO}/data/cards/mmsiscsar155.html`;
        // Контроль: заведомо рабочий внешний пост с og:image (vs наша Pages-страница).
        const external = "https://habr.com/ru/articles/";
        for (const [label, link] of [
          ["html-страница (og:image)", githubHtml],
          ["внешняя статья (og:image)", external],
        ]) {
          try {
            const p = await vkCall(env, "wall.post", {
              owner_id: -env.VK_GROUP_ID,
              from_group: 1,
              message: `Тест превью: ${label}`,
              attachments: link,
            });
            out.steps.push({ step: 3, ok: true, note: snap("wall.post", `${label}: post=${p.post_id} ${link}`) });
          } catch (e) {
            out.steps.push({ step: 3, ok: false, note: `wall.post (${label}): ` + e.message });
          }
        }
      }

      // 4. (только ?test_post=3) загрузить СВЕЖЕЕ messages-фото и сразу прикрепить
  // его id к wall.post — проверить, рендерится ли фото при свежем id (не из кэша).
      out.steps.push({ step: 4, note: `gate test_post=${url.searchParams.get("test_post")}` });
      if (url.searchParams.get("test_post") === "3" && env.VK_GROUP_ID) {
        const cardUrl = env.OWNER && env.REPO
          ? `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.png`
          : null;
        const real = cardUrl ? await (await fetch(cardUrl)).arrayBuffer() : new Uint8Array([137, 80, 78, 71]);
        const up = await vkCall(env, "photos.getMessagesUploadServer");
        const fd = new FormData();
        fd.append("photo", new Blob([new Uint8Array(real)], { type: "image/png" }), "card.png");
        const upRes = await (await fetch(up.upload_url, { method: "POST", body: fd })).json();
        if (!upRes.photo) {
          out.steps.push({ step: 4, ok: false, note: "messages upload empty " + JSON.stringify(upRes) });
        } else {
          const saved = await vkCall(env, "photos.saveMessagesPhoto", { photo: upRes.photo, server: upRes.server, hash: upRes.hash });
          const ph = saved[0];
          const freshId = `photo${ph.owner_id}_${ph.id}`;
          out.steps.push({ step: 4, ok: true, note: snap("fresh message-photo", `id=${freshId} sizes=${(ph.sizes||[]).length}`) });
          // сразу постим с этим же (преднатав) photo-id
          const p = await vkCall(env, "wall.post", {
            owner_id: -env.VK_GROUP_ID, from_group: 1,
            message: `Свежее messages-фото: ${freshId}`,
            attachments: freshId,
          });
          p.post_id && out.steps.push({ step: 4, ok: true, note: snap("wall.post fresh", `post=${p.post_id} attach=${freshId}`) });
        }
      }

      // 7. (только ?test_post=7) перенос в публичный альбом
      if (url.searchParams.get("test_post") === "7" && env.VK_GROUP_ID) {
        const gid = env.VK_GROUP_ID;
        // 7a. создать (или пере) публичный альбом
        try {
          const alb = await vkCall(env, "photos.createAlbum", {
            title: "Card-album", group_id: gid, privacy_view: "all", privacy_comment: "all",
          });
          out.steps.push({ step: 7, ok: true, note: snap("createAlbum", `album_id=${alb.id} title=${alb.title}`) });
        } catch (e) {
          out.steps.push({ step: 7, ok: false, note: "photos.createAlbum " + e.message });
        }
        // 7b. загрузить свежее messages-фото
        try {
          const cardUrl = env.OWNER && env.REPO
            ? `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.png`
            : null;
          const real = cardUrl ? await (await fetch(cardUrl)).arrayBuffer() : new Uint8Array([137, 80, 78, 71]);
          const up = await vkCall(env, "photos.getMessagesUploadServer");
          const fd = new FormData();
          fd.append("photo", new Blob([new Uint8Array(real)], { type: "image/png" }), "card.png");
          const upRes = await (await fetch(up.upload_url, { method: "POST", body: fd })).json();
          const saved = await vkCall(env, "photos.saveMessagesPhoto", { photo: upRes.photo, server: upRes.server, hash: upRes.hash });
          const ph = saved[0];
          const phId = ph.id, phOwner = ph.owner_id;
          out.steps.push({ step: 7, ok: true, note: snap("saveMessagesPhoto#7", `photo${phOwner}_${phId} sizes=${(ph.sizes||[]).length}`) });
          // 7c. перенести в публичный альбом
          try {
            const moved = await vkCall(env, "photos.move", {
              owner_id: phOwner, photo_id: phId, target_album_id: 0, group_id: gid,
            });
            out.steps.push({ step: 7, ok: true, note: snap("photos.move", JSON.stringify(moved)) });
            const p = await vkCall(env, "wall.post", {
              owner_id: -gid, from_group: 1,
              message: "Тест move-фото",
              attachments: `photo${phOwner}_${phId}`,
            });
            out.steps.push({ step: 7, ok: true, note: snap("wall.post moved", `post=${p.post_id} attach=photo${phOwner}_${phId}`) });
          } catch (e) {
            out.steps.push({ step: 7, ok: false, note: "photos.move " + e.message });
          }
        } catch (e) {
          out.steps.push({ step: 7, ok: false, note: "7-upload " + e.message });
        }
      }

      // 13. (только ?test_post=13) прикрепить ПРЯМУЮ ссылку на PNG (github.io)
      // 15. (только ?test_post=15) saveMessagesPhoto c access_key + album: постить
      //      photo-owner_id_id_accessKey и photo-owner_id_albumId_id. VK при закрытом
      //      фото требует access_key в attachment, иначе рендерит пусто.
      // как attachment — VK сам подтянет фото из ссылки. Без HTML-страницы.
      if (url.searchParams.get("test_post") === "13" && env.OWNER && env.REPO && env.VK_GROUP_ID) {
        const pngUrl = `https://${env.OWNER}.github.io/${env.REPO}/data/cards/mmsiscsar155.png`;
        try {
          const p = await vkCall(env, "wall.post", {
            owner_id: -env.VK_GROUP_ID, from_group: 1,
            message: "Тест прямой PNG-ссылки",
            attachments: pngUrl,
          });
          out.steps.push({ step: 13, ok: true, note: snap("wall.post png-link", `post=${p.post_id} ${pngUrl}`) });
        } catch (e) {
          out.steps.push({ step: 13, ok: false, note: "wall.post png-link " + e.message });
        }
      }

      // 14. (только ?test_post=14) ссылка В ТЕКСТЕ сообщения (не attachment) —
      // VK сам парсит и строит превью из ссылки в message.
      if (url.searchParams.get("test_post") === "14" && env.OWNER && env.REPO && env.VK_GROUP_ID) {
        const pngUrl = `https://${env.OWNER}.github.io/${env.REPO}/data/cards/mmsiscsar155.png`;
        try {
          const p = await vkCall(env, "wall.post", {
            owner_id: -env.VK_GROUP_ID, from_group: 1,
            message: "Тест PNG-ссылки в тексте " + pngUrl,
          });
          out.steps.push({ step: 14, ok: true, note: snap("wall.post text-link", `post=${p.post_id} ${pngUrl}`) });
        } catch (e) {
          out.steps.push({ step: 14, ok: false, note: "wall.post text-link " + e.message });
        }
      }
      // 15. (только ?test_post=15) полный saveMessagesPhoto + постим с access_key.
      if (url.searchParams.get("test_post") === "15" && env.OWNER && env.REPO && env.VK_GROUP_ID) {
        const cardUrl = `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.png`;
        try {
          const real = await (await fetch(cardUrl)).arrayBuffer();
          const up = await vkCall(env, "photos.getMessagesUploadServer");
          const fd = new FormData();
          fd.append("photo", new Blob([new Uint8Array(real)], { type: "image/png" }), "card.png");
          const upRes = await (await fetch(up.upload_url, { method: "POST", body: fd })).json();
          const saved = await vkCall(env, "photos.saveMessagesPhoto", { photo: upRes.photo, server: upRes.server, hash: upRes.hash });
          const ph = saved[0];
          const ak = ph.access_key || "";
          const aid = ph.album_id || 0;
          out.steps.push({ step: 15, ok: true, note: snap("save#15", `photo=${ph.id} owner=${ph.owner_id} album=${aid} ak=${ak} sizes=${(ph.sizes||[]).length}`) });
          // постим с access_key (и альбомом) — разные формы
          const forms = [
            `photo${ph.owner_id}_${ph.id}`,
            ak ? `photo${ph.owner_id}_${ph.id}_${ak}` : null,
          ].filter(Boolean);
          for (const attach of forms) {
            try {
              const p = await vkCall(env, "wall.post", {
                owner_id: -env.VK_GROUP_ID, from_group: 1,
                message: "Тест access_key",
                attachments: attach,
              });
              out.steps.push({ step: 15, ok: true, note: snap("wall.post#15", `post=${p.post_id} attach=${attach}`) });
            } catch (e) {
              out.steps.push({ step: 15, ok: false, note: "wall.post#15 " + attach + " :: " + e.message });
            }
          }
        } catch (e) {
          out.steps.push({ step: 15, ok: false, note: "15 " + e.message });
        }
      }
      // 16. (только ?test_post=16) фото через аватар сообщества:
      //      photos.getOwnerPhotoUploadServer + photos.saveOwnerPhoto — картинка
      //      становится публичным фото группы (owner_id=-gid), затем wall.post.
      if (url.searchParams.get("test_post") === "16" && env.OWNER && env.REPO && env.VK_GROUP_ID) {
        const cardUrl = `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.png`;
        try {
          const real = await (await fetch(cardUrl)).arrayBuffer();
          const ups = await vkCall(env, "photos.getOwnerPhotoUploadServer", {});
          const fd = new FormData();
          fd.append("photo", new Blob([new Uint8Array(real)], { type: "image/png" }), "card.png");
          const upRes = await (await fetch(ups.upload_url, { method: "POST", body: fd })).json();
          out.steps.push({ step: 16, ok: true, note: snap("ownerPhoto upload", upRes) });
          const saved = await vkCall(env, "photos.saveOwnerPhoto", {
            photo: upRes.photo || "", server: upRes.server || "", hash: upRes.hash || "",
          });
          const ph = saved.photo || saved;
          out.steps.push({ step: 16, ok: true, note: snap("saveOwnerPhoto", `id=${ph.id} owner=${ph.owner_id} ak=${ph.access_key||""}`) });
          const attach = `photo${ph.owner_id}_${ph.id}` + (ph.access_key ? `_${ph.access_key}` : "");
          const p = await vkCall(env, "wall.post", {
            owner_id: -env.VK_GROUP_ID, from_group: 1,
            message: "Тест фото-аватар",
            attachments: attach,
          });
          out.steps.push({ step: 16, ok: true, note: snap("wall.post#16", `post=${p.post_id} attach=${attach}`) });
        } catch (e) {
          out.steps.push({ step: 16, ok: false, note: "16 " + e.message });
        }
      }
      // 17. (только ?test_post=17) товар в market с фото:
      //      photos.getMarketUploadServer + saveMarketPhoto + market.add + wall.post
      //      с attachments=market-owner_id_itemId — рендерится большой карточкой.
      if (url.searchParams.get("test_post") === "17" && env.OWNER && env.REPO && env.VK_GROUP_ID) {
        const gid = env.VK_GROUP_ID;
        try {
          const cardUrl = `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.png`;
          const real = await (await fetch(cardUrl)).arrayBuffer();
          // категории market
          let catId = "0";
          try {
            const cats = await vkCall(env, "market.getCategories", { count: 1, extended: 1 });
            const c = cats.categories && cats.categories[0];
            catId = String((c && (c.id || c.category && c.category.id)) || 0);
            out.steps.push({ step: 17, ok: true, note: snap("market.getCategories", `first=${catId}`) });
          } catch (e) { out.steps.push({ step: 17, ok: false, note: "market.getCategories " + e.message }); }
          // загрузка фото товара
          const ups = await vkCall(env, "photos.getMarketUploadServer", { group_id: gid, main_photo: 1 });
          const fd = new FormData();
          fd.append("file", new Blob([new Uint8Array(real)], { type: "image/png" }), "card.png");
          const upRes = await (await fetch(ups.upload_url, { method: "POST", body: fd })).json();
          out.steps.push({ step: 17, ok: true, note: snap("market upload", upRes) });
          const saved = await vkCall(env, "photos.saveMarketPhoto", {
            group_id: gid, photo: upRes.photo, server: upRes.server, hash: upRes.hash,
          });
          const mp = saved[0];
          out.steps.push({ step: 17, ok: true, note: snap("saveMarketPhoto", `id=${mp.id} owner=${mp.owner_id}`) });
          // создаём товар
          const item = await vkCall(env, "market.add", {
            owner_id: -gid, name: "TrustNode Card", description: "Тестовая карточка",
            category_id: catId, price: 100, main_photo_id: mp.id,
          });
          out.steps.push({ step: 17, ok: true, note: snap("market.add", `item=${item.id}`) });
          const p = await vkCall(env, "wall.post", {
            owner_id: -gid, from_group: 1,
            message: "Тест market-фото",
            attachments: `market-${gid}_${item.id}`,
          });
          out.steps.push({ step: 17, ok: true, note: snap("wall.post#17", `post=${p.post_id} attach=market-${gid}_${item.id}`) });
        } catch (e) {
          out.steps.push({ step: 17, ok: false, note: "17 " + e.message });
        }
      }
      // 18. (только ?test_post=18) GIF-документ: VK рендерит doc типа 3 (gif)
      //      в посте ВСТРОЕННОЙ картинкой (в отличие от png/jpg-doc=файл).
      if (url.searchParams.get("test_post") === "18" && env.OWNER && env.REPO && env.VK_GROUP_ID) {
        const gifUrl = `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.gif`;
        try {
          const gifBytes = new Uint8Array(await (await fetch(gifUrl)).arrayBuffer());
          const dws = await vkCall(env, "docs.getWallUploadServer", { group_id: env.VK_GROUP_ID });
          const fd = new FormData();
          fd.append("file", new Blob([gifBytes], { type: "image/gif" }), "card.gif");
          let bodyText = "";
          const resp = await fetch(dws.upload_url, {
            method: "POST", body: fd,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36", Accept: "*/*" },
          });
          bodyText = await resp.text();
          let ur = { _html: bodyText.slice(0, 120) };
          try { ur = JSON.parse(bodyText); } catch (e) {}
          out.steps.push({ step: 18, ok: !!ur.file, note: snap("gif upload", ur) });
          if (ur.file) {
            const saved = await vkCall(env, "docs.save", { file: ur.file });
            const raw = JSON.stringify(saved);
            let d = null;
            try {
              const arr = Array.isArray(saved) ? saved : [saved];
              const wrap = arr[0];
              d = (wrap && (wrap.doc || wrap)) || null;
            } catch (e) {}
            out.steps.push({ step: 18, ok: !!d, note: snap("docs.save gif", d ? `doc${d.owner_id}_${d.id} type=${d.type} ext=${d.ext}` : "RAW=" + raw.slice(0, 220)) });
            const p = await vkCall(env, "wall.post", {
              owner_id: -env.VK_GROUP_ID, from_group: 1,
              message: "Тест GIF-документа",
              attachments: `doc${d.owner_id}_${d.id}`,
            });
            out.steps.push({ step: 18, ok: true, note: snap("wall.post#18", `post=${p.post_id} attach=doc${d.owner_id}_${d.id}`) });
          }
        } catch (e) {
          out.steps.push({ step: 18, ok: false, note: "18 " + e.message });
        }
      }
      // 19. (только ?test_post=19) полный end-to-end: реальный publishToVk
      //      (PNG→GIF → docs.getWallUploadServer → docs.save → wall.post).
      if (url.searchParams.get("test_post") === "19") {
        const { publishToVk } = await import("./lib/telegram.js");
        const cardUrl = env.OWNER && env.REPO
          ? `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.png`
          : null;
        try {
          const real = cardUrl ? await (await fetch(cardUrl)).arrayBuffer() : null;
          if (!real) throw new Error("нет тестовой PNG-карточки");
          const pkg = {
            id: "diag19-" + Date.now(),
            guid: "diag19-" + Date.now(),
            title: "TrustNode",
            caption: "Тест end-to-end GIF-документа",
            png: new Uint8Array(real),
            png_key: null,
            link: "",
          };
          const res = await publishToVk(env, pkg, false);
          out.steps.push({ step: 19, ok: true, note: snap("publishToVk e2e", `post=${res.post_id} attach=${res.vk_attachment}`) });
        } catch (e) {
          out.steps.push({ step: 19, ok: false, note: "19 " + e.message });
        }
      }
      // 20. (только ?test_post=20) загружаем GIF из ПНГ-конвертера через docs и
      //      смотрим, какой type/ext VK определит для него (сравнение с PIL-GIF).
      if (url.searchParams.get("test_post") === "20" && env.OWNER && env.REPO && env.VK_GROUP_ID) {
        const { pngToGif } = await import("./lib/cardgen.js");
        const cardUrl = `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.png`;
        try {
          const png = new Uint8Array(await (await fetch(cardUrl)).arrayBuffer());
          const gifBytes = await pngToGif(png);
          out.steps.push({ step: 20, ok: true, note: `pngToGif: ${png.length} -> ${gifBytes.length} байт, magic=${gifBytes[0]}${gifBytes[1]}${gifBytes[2]}${gifBytes[3]}${gifBytes[4]}${gifBytes[5]}` });
          const dws = await vkCall(env, "docs.getWallUploadServer", { group_id: env.VK_GROUP_ID });
          const fd = new FormData();
          fd.append("file", new Blob([gifBytes], { type: "image/gif" }), "card.gif");
          let bodyText = "";
          try {
            const resp = await fetch(dws.upload_url, {
              method: "POST", body: fd,
              headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36", Accept: "*/*" },
            });
            bodyText = await resp.text();
          } catch (e) { bodyText = "fetch ERR " + e.message; }
          let ur = { _html: bodyText.slice(0, 200) };
          try { ur = JSON.parse(bodyText); } catch (e) {}
          out.steps.push({ step: 20, ok: !!ur.file, note: snap("conv gif upload", ur) });
          if (ur.file) {
            const saved = await vkCall(env, "docs.save", { file: ur.file });
            const wrap = Array.isArray(saved) ? saved[0] : saved;
            const d = (wrap && (wrap.doc || wrap)) || null;
            out.steps.push({ step: 20, ok: !!d, note: snap("conv docs.save", d ? `doc${d.owner_id}_${d.id} type=${d.type} ext=${d.ext} size=${d.size}` : "RAW=" + JSON.stringify(saved).slice(0, 200)) });
          }
        } catch (e) {
          out.steps.push({ step: 20, ok: false, note: "20 " + e.message });
        }
      }
return jsonResponse(out);
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
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
        autopost: await kv.getAutopost(env),
        scan_chunk: state.meta?.scan_chunk ?? 0,
      },
      stock: stock.length,
      candidates: cands.length,
      drafts: drafts.length,
      log: log.length,
      seen_guids: state.seen_guids?.length || 0,
    });
  }

  // Диагностика канала TG: резолвим текущий TELEGRAM_CHANNEL_ID через getChat
  // и пишем результат в KV (diag:channel). Помогает найти правильный chat_id.
  if (url.pathname === "/diag-channel" && request.method === "GET") {
    if (!(await apiAuthorized(env, request))) return new Response("Forbidden", { status: 403 });
    const candidates = [];
    if (env.TELEGRAM_CHANNEL_ID) candidates.push(String(env.TELEGRAM_CHANNEL_ID).trim());
    candidates.push("@TrustNode_team");
    const out = { ts: Date.now(), candidates: [] };
    for (const c of candidates) {
      const row = { id: c };
      try {
        const info = await tgCall(env, "getChat", { chat_id: c });
        row.ok = true;
        row.id = info.id;
        row.title = info.title || "";
        row.username = info.username || "";
        row.type = info.type || "";
      } catch (e) {
        row.ok = false;
        row.error = e.message;
      }
      out.candidates.push(row);
      if (row.ok) out.resolved = row.id;
    }
    if (env.BOT_KV && out.resolved) {
      await env.BOT_KV.put("telegram_channel_id", String(out.resolved));
    }
    if (env.BOT_KV) await env.BOT_KV.put("diag:channel", JSON.stringify(out));
return jsonResponse(out);
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
        // KV не хранит Content-Type: выводим по расширению, чтобы VK по ссылке
        // распознал фото («link_photo_sizing_rule» ↑1 when octet-stream).
        if (key.endsWith(".png")) ct = "image/png";
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

async function approveDraft(env, draft, dry, target = "all") {
  const title = draft.title || "";
  try {
    const res = await publishPackage(
      env,
      {
        id: draft.id,
        kind: draft.kind || "news",
        title,
        caption: draft.caption || "",
        digest_text: draft.digest_text || "",
        png_key: draft.png_key || null,
        png: decodePng(draft.png) || null,
        link: draft.link || "",
        guid: draft.guid || "",
        source: draft.source || "",
        tags: draft.tags || [],
        scheme_id: draft.scheme_id || null,
        style_id: draft.style_id || null,
        topic_id: draft.topic_id || null,
        llm_provider: draft.llm_provider || null,
      },
      dry,
      target
    );
    // Уведомляем админа о результате публикации
    if (!dry && res) {
      const status = `${res.tgOk ? "🟢 TG ✓" : "TG ✗"} · ${res.vkOk ? "🔵 VK ✓" : "VK ✗"}`;
      const vkUrl = res.vkPost && env.VK_GROUP_ID
        ? `https://vk.com/wall-${env.VK_GROUP_ID}_${res.vkPost}` : "";
      const line = vkUrl ? `${status} · ${vkUrl}` : status;
      if (res.tgOk && res.vkOk) {
        await sendMessage(env, env.TELEGRAM_ADMIN_CHAT_ID,
          `✅ <b>Опубликовано</b>: ${title}\n${line}`, { parse_mode: "HTML" });
      } else if (res.tgOk || res.vkOk) {
        const missing = res.tgOk ? "VK" : "TG";
        await sendMessage(env, env.TELEGRAM_ADMIN_CHAT_ID,
          `⏳ <b>Частично опубликовано</b>: ${title}\n${line}\n🔜 Догоняю ${missing} в ближайшие тики.`,
          { parse_mode: "HTML" });
      }
    }
  } catch (e) {
    await sendMessage(env, env.TELEGRAM_ADMIN_CHAT_ID,
      `❌ <b>Не удалось опубликовать</b>: ${title}\n${escHtml(e.message)}`,
      { parse_mode: "HTML" });
  }
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
  const segs = data.split(":");
  const action = segs[0];
  const draftId = segs[1] || "";
  const target = segs[2] || "all";

  // пользовательское меню (не админ)
  if (action === "user") {
    await handleUserCallback(env, cq);
    return;
  }

  // предложки: только админ может одобрять/отклонять
  if (action === "sugg") {
    if (!isAdmin(env, chatId)) {
      try { await answerCallbackQuery(env, qid, "Нет доступа"); } catch (e) { /* ignore */ }
      return;
    }
    await handleSuggestionCallback(env, cq);
    return;
  }

  if (!isAdmin(env, chatId)) {
    try { await answerCallbackQuery(env, qid, "Нет доступа"); } catch (e) { /* ignore */ }
    return;
  }

  // быстрые inline-действия мультигрупп (mg:tick[:slug] | mg:ok:<id> | mg:skip:<id>)
  if (action === "mg") {
    if (segs[1] === "tick") {
      const slug = segs[2];
      try {
        const results = slug
          ? [await multigroupTickGroup(env, slug)]
          : await multigroupTick(env, new Date(), { force: true });
        const lines = results.map(
          (r) => `${r.posted ? "✅" : "⏭"} <b>${escHtml(r.slug)}</b>: ${escHtml(r.detail)}`
        ).join("\n");
        await sendMessage(env, chatId, "👥 <b>multigroupTick</b>\n" + lines, { parse_mode: "HTML", reply_markup: QUICK_MULTI_KB });
        try { await answerCallbackQuery(env, qid, "Готово"); } catch (e) { /* ignore */ }
      } catch (e) {
        try { await answerCallbackQuery(env, qid, `Ошибка: ${e.message.slice(0, 90)}`); } catch (e2) { /* ignore */ }
      }
      return;
    }
    if (segs[1] === "ok" || segs[1] === "skip") {
      const pendingId = segs.slice(2).join(":");
      try {
        const verdict = segs[1] === "ok"
          ? await approvePending(env, pendingId)
          : await skipPending(env, pendingId);
        // убираем кнопки у превью, чтобы не нажалось дважды
        try { await editMessageReplyMarkup(env, chatId, msgId, null); } catch (e) { /* ignore */ }
        try { await answerCallbackQuery(env, qid, verdict.slice(0, 190)); } catch (e) { /* ignore */ }
        await sendMessage(env, chatId, `👥 ${escHtml(verdict)}`);
      } catch (e) {
        try { await answerCallbackQuery(env, qid, `Ошибка: ${e.message.slice(0, 90)}`); } catch (e2) { /* ignore */ }
      }
      return;
    }
    if (segs[1] === "approve") {
      try {
        const cfg = await loadMgConfig(env);
        cfg.approval = !cfg.approval;
        await saveMgConfig(env, cfg);
        try { await answerCallbackQuery(env, qid, `Согласование: ${cfg.approval ? "вкл" : "выкл"}`); } catch (e) { /* ignore */ }
        await handleCommand(env, state, chatId, "/mg-edit");
      } catch (e) {
        try { await answerCallbackQuery(env, qid, `Ошибка: ${e.message.slice(0, 90)}`); } catch (e2) { /* ignore */ }
      }
      return;
    }
  }

  // быстрые inline-действия под отчётами/статусом (cmd:<command>)
  if (action === "cmd") {
    const command = segs[1] || "";
    try {
      if (!/^[a-z][a-z-]*$/.test(command)) throw new Error("неверная команда");
      await handleCommand(env, state, chatId, `/${command}`);
      try { await answerCallbackQuery(env, qid, "Готово"); } catch (e) { /* ignore */ }
    } catch (e) {
      try { await answerCallbackQuery(env, qid, `Ошибка: ${e.message.slice(0, 90)}`); } catch (e2) { /* ignore */ }
    }
    return;
  }

  // переключатели настроек из /settings (set:autopost | set:cardfmt:<fmt> | set:dryrun)
  if (action === "set") {
    const op = segs[1] || "";
    try {
      if (op === "autopost") {
        const on = !(await kv.getAutopost(env));
        await kv.setAutopost(env, on);
      } else if (op === "dryrun") {
        state.dry_run = !state.dry_run;
        await kv.saveState(env, state);
      } else if (op === "cardfmt") {
        const f = ["gif", "png", "auto"].includes(segs[2]) ? segs[2] : "auto";
        await kv.setCardFormat(env, f);
      } else {
        throw new Error("неизвестная настройка");
      }
      await answerCallbackQuery(env, qid, "✅ Обновлено");
      // перерисовываем настройки, чтобы галочки/статусы были свежими
      await handleCommand(env, state, chatId, "/settings");
    } catch (e) {
      try { await answerCallbackQuery(env, qid, `Ошибка: ${e.message.slice(0, 90)}`); } catch (e2) { /* ignore */ }
    }
    return;
  }

  // отчёты студии (/report → кнопки): вечер/день/неделя/месяц
  if (action === "report") {
    const which = segs[1] || "evening";
    const builders = {
      evening: () => eveningSummaryText(env, { now: new Date() }),
      day: () => dayReportText(env, { now: new Date() }),
      week: () => weekReportText(env, { now: new Date() }),
      month: () => monthReportText(env, { now: new Date() }),
    };
    try {
      const text = await (builders[which] || builders.evening)();
      if (!text) {
        try { await answerCallbackQuery(env, qid, "Отчёт не собрался: пока мало данных"); } catch (e) { /* ignore */ }
        return;
      }
      try { await editMessageReplyMarkup(env, chatId, msgId, []); } catch (e) { /* ignore */ }
      await sendMessage(env, chatId, text, { parse_mode: "HTML" });
      try { await answerCallbackQuery(env, qid, "Готово"); } catch (e) { /* ignore */ }
    } catch (e) {
      try { await answerCallbackQuery(env, qid, `Ошибка: ${e.message.slice(0, 90)}`); } catch (e2) { /* ignore */ }
    }
    return;
  }

  // управление расписанием (/schedule): авто/ручной, +/− слот, сброс, AI-план
  if (action === "sched") {
    const op = segs[1] || "";
    try {
      if (op === "auto") {
        await setScheduleMode(env, "auto");
      } else if (op === "manual") {
        await setScheduleMode(env, "manual");
      } else if (op === "plus") {
        const sc = await getSchedule(env);
        await setSlotsPerDay(env, sc.windows.length + 1);
      } else if (op === "minus") {
        const sc = await getSchedule(env);
        await setSlotsPerDay(env, sc.windows.length - 1);
      } else if (op === "reset") {
        await resetSchedule(env);
      } else if (op === "ai") {
        // AI-план: здоровье окон за 7 дней + предложение переноса по просадкам
        const plan = await aiSchedulePlan(env, { days: 7 });
        if (!plan.health.length) {
          try { await answerCallbackQuery(env, qid, "Нет расписания"); } catch (e) { /* ignore */ }
          return;
        }
        const healthTxt = plan.health.map((h) => healthLine(h)).join("\n");
        if (!plan.proposed) {
          await answerCallbackQuery(env, qid, "Окна здоровы — перенос не нужен");
          await sendMessage(
            env,
            chatId,
            `🤖 <b>AI-план расписания</b>\n\n${healthTxt}\n\nВсе окна работают — перестановка не требуется.`,
            { parse_mode: "HTML" }
          );
          return;
        }
        await storeProposedSchedule(env, plan.proposed, "AI-перенос по просадкам");
        const proposedTxt = plan.proposed
          .map((w) => `• <b>${w.label}</b> — ${minutesToClock(w.start)} ЕКБ (1 пост)`)
          .join("\n");
        const movedTxt = plan.proposed
          .filter((w) => plan.windows.some((ow) => ow.slug === w.slug && ow.start !== w.start))
          .map((w) => `${w.label}: ${minutesToClock(plan.windows.find((ow) => ow.slug === w.slug).start)} → ${minutesToClock(w.start)}`)
          .join("\n");
        try { await editMessageReplyMarkup(env, chatId, msgId, []); } catch (e) { /* ignore */ }
        await sendMessage(
          env,
          chatId,
          `🤖 <b>AI-план расписания</b>\n\n<b>Здоровье окон (7 дней)</b>\n${healthTxt}\n\n<b>Предложение</b>\n${proposedTxt}\n\n<b>Переносы</b>\n${movedTxt || "—"}\n\nПрименить?`,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [[{ text: "✅ Применить план", callback_data: "sched:apply" }]] },
          }
        );
        await answerCallbackQuery(env, qid, "План готов");
        return;
      } else if (op === "apply") {
        const res = await applyProposedSchedule(env);
        if (!res) {
          try { await answerCallbackQuery(env, qid, "Нет сохранённого плана — запустите AI-план"); } catch (e) { /* ignore */ }
          return;
        }
        const label = `расписание: ${res.mode === "auto" ? "авто" : "ручной"}, ${res.windows.length} ${plural(res.windows.length, "слот", "слота", "слотов")} в день`;
        await answerCallbackQuery(env, qid, `✅ ${label}`);
        try { await editMessageReplyMarkup(env, chatId, msgId, []); } catch (e) { /* ignore */ }
        await sendMessage(env, chatId, `✅ <b>AI-план применён</b>\n${label}\nДетали — /schedule`, {
          parse_mode: "HTML",
        });
        return;
      } else if (op === "noop") {
        try { await answerCallbackQuery(env, qid, "Ручной режим: «⬅ −1ч» / «➡ +1ч» переносит окно"); } catch (e) { /* ignore */ }
        return;
      } else if (op === "mv") {
        const slug = segs[2] || "";
        const delta = Number(segs[3] || 0);
        if (!slug || !delta) throw new Error("неверные параметры");
        const res = await moveWindow(env, slug, delta);
        if (!res.ok) throw new Error(res.reason || "окно не найдено");
        try { await answerCallbackQuery(env, qid, `«${slug}» → ${minutesToClock(res.start)}`); } catch (e) { /* ignore */ }
        try { await editMessageReplyMarkup(env, chatId, msgId, []); } catch (e) { /* ignore */ }
        await sendMessage(env, chatId, `🗓 Окно «${slug}» перенесено на <b>${minutesToClock(res.start)}</b> ЕКБ.\nДетали — /schedule`, {
          parse_mode: "HTML",
        });
        return;
      } else {
        throw new Error("неизвестная операция");
      }
      const sc = await getSchedule(env);
      const label = `расписание: ${sc.mode === "auto" ? "авто" : "ручной"}, ${sc.windows.length} ${plural(sc.windows.length, "слот", "слота", "слотов")} в день`;
      await answerCallbackQuery(env, qid, label);
      try { await editMessageReplyMarkup(env, chatId, msgId, []); } catch (e) { /* ignore */ }
      try {
        await sendMessage(env, chatId, `🗓 ${label}\nДетали — /schedule`, { parse_mode: "HTML" });
      } catch (e) { /* ignore */ }
    } catch (e) {
      try { await answerCallbackQuery(env, qid, `Ошибка: ${e.message.slice(0, 90)}`); } catch (e2) { /* ignore */ }
    }
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
      await approveDraft(env, draft, dry, target);
      const label = target === "vk" ? "в VK" : target === "tg" ? "в TG" : "в VK и TG";
      await answerCallbackQuery(env, qid, `✅ Опубликовано ${label}`);
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

  // 🕓 Отложить: черновик не публикуется сразу, а встаёт в ближайший свободный
  // слот. Промоушен в склад делает авто-тик (статус deferred, deferred_until).
  if (action === "defer" && draftId) {
    const draft = await kv.loadDraft(env, draftId);
    if (!draft) {
      try { await answerCallbackQuery(env, qid, "Черновик не найден"); } catch (e) { /* ignore */ }
      return;
    }
    const slot = await nextFreeSlot(env);
    draft.status = "deferred";
    draft.deferred_until = new Date(slot).toISOString();
    await kv.saveDraft(env, draft);
    try { await editMessageReplyMarkup(env, chatId, msgId, []); } catch (e) { /* ignore */ }
    try {
      await answerCallbackQuery(
        env,
        qid,
        `🕓 Отложен до слота ${fmtTime(new Date(slot).toISOString())}`
      );
    } catch (e) { /* ignore */ }
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
          provider: draft.provider || undefined,
        });
      } catch (e) {
        try {
          await sendMessage(env, env.TELEGRAM_ADMIN_CHAT_ID, `⚠️ Не удалось перегенерировать: ${escHtml(e.message)}`);
        } catch (e2) { /* ignore */ }
      }
      return;
    }

    if (draft.kind === "digest") {
      // дайджест-превью: кандидаты уже потреблены выпуском, GitHub не нужен —
      // пересобираем текст и обложку из сохранённых новостей локально.
      const res = await rebuildDigestPreview(env, draft);
      if (!res.ok) {
        try {
          await sendMessage(
            env,
            env.TELEGRAM_ADMIN_CHAT_ID,
            `⚠️ Не удалось пересобрать дайджест: ${escHtml(res.reason || "ошибка")}`
          );
        } catch (e2) { /* ignore */ }
      } else {
        try {
          await editMessageReplyMarkup(
            env,
            draft.admin_chat_id || env.TELEGRAM_ADMIN_CHAT_ID,
            draft.preview_message_id,
            []
          );
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
      await sendMessage(env, chatId, WELCOME_TEXT, {
        parse_mode: "HTML",
        reply_markup: MAIN_KB,
      });
      break;

    case "/menu":
      await sendMessage(env, chatId, "☰ <b>Дополнительные команды</b>", { parse_mode: "HTML", reply_markup: MORE_KB });
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
      const ekb = ekbNow();
      const today = log.filter((e) => {
        const t = new Date(e.published_at);
        return !Number.isNaN(t.getTime()) && ekbNow(t).date === ekb.date;
      }).length;
      const next = await nextFreeSlot(env);
      const stockLines = stock.length
        ? "\n" + stock.slice(0, 5).map((p) => `   • ${escHtml(p.title || p.id)} → ${fmtTime(new Date(p.scheduled_for || Date.now()).toISOString())}`).join("\n") + (stock.length > 5 ? `\n   … и ещё ${stock.length - 5}` : "")
        : "";
      const msg =
        "📊 <b>Статус студии</b>\n\n" +
        `Режим: <b>${dry ? "dry-run" : "боевой"}</b>\n` +
        `Автопостинг: <b>${(await kv.getAutopost(env)) ? "вкл" : "выкл"}</b>\n` +
        `Источников: <b>${config.feeds?.length || 0}</b>, ключевых слов: <b>${config.keywords?.length || 0}</b>\n` +
        `Склад: <b>${stock.length}</b>, кандидатов: <b>${cands.length}</b>, черновиков: <b>${drafts.length}</b>\n` +
        `Опубликовано всего: <b>${log.length}</b>, сегодня: <b>${today}</b>\n` +
        `Следующий слот: <b>${fmtTime(new Date(next).toISOString())}</b>\n` +
        (stockLines ? `На складе:${stockLines}` : "") +
        `Последний пост: ${lastLine}\n\n` +
        "🛡️ TrustNode";
      await sendMessage(env, chatId, msg, { parse_mode: "HTML", reply_markup: QUICK_STATUS_KB });
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
      const sched = await getSchedule(env);
      const wins = sched.windows.map(
        (w) => `• <b>${w.label}</b> — ${minutesToClock(w.start)} ЕКБ: 1 пост — одна свежая новость`
      ).join("\n");
      const modeLabel = sched.mode === "auto" ? "авто" : "ручной";
      const schedLine =
        `Режим: <b>${modeLabel}</b> · ${sched.windows.length} ${plural(sched.windows.length, "слот", "слота", "слотов")} в день\n` +
        (sched.reason ? `Причина: ${escHtml(sched.reason)}\n` : "") +
        (sched.updated_at ? `Обновлено: ${fmtTime(sched.updated_at)}\n` : "");
      const nextSlot = await nextFreeSlot(env, new Date());
      const next = fmtTime(new Date(nextSlot).toISOString());
      const msg =
        "🗓 <b>Расписание (ЕКБ)</b>\n\n" +
        schedLine +
        "\n" +
        wins +
        "\n\nСледующий слот: <b>" + next + "</b>\n\n" +
        "<b>1 окно = 1 пост.</b> В каждом окне публикуется один пост — свежая новость. Без сводок и без многопостовых выпусков.\n" +
        "Ручной режим: вы сами управляете числом окон кнопками ниже.";
      const kb = {
        inline_keyboard: [
          [
            { text: "🤖 Авто", callback_data: "sched:auto" },
            { text: "✋ Ручной", callback_data: "sched:manual" },
          ],
          [
            { text: "➕ Слот", callback_data: "sched:plus" },
            { text: "➖ Слот", callback_data: "sched:minus" },
            { text: "🔄 Сброс", callback_data: "sched:reset" },
          ],
          ...sched.windows.map((w) => [
            { text: "⬅ −1ч", callback_data: `sched:mv:${w.slug}:-60` },
            { text: `${w.label} ${minutesToClock(w.start)}`, callback_data: `sched:noop:${w.slug}` },
            { text: "➕1ч ➡", callback_data: `sched:mv:${w.slug}:60` },
          ]),
          [
            { text: "🤖 AI-план по просадкам", callback_data: "sched:ai" },
          ],
        ],
      };
      await sendMessage(env, chatId, msg, { parse_mode: "HTML", reply_markup: kb });
      break;
    }

    case "/healthcheck": {
      const ekb = ekbNow();
      const log = await kv.getLog(env);
      const today = (log || []).filter(
        (e) => e && (e.vk_ok || e.tg_ok) && e.published_at && ekbNow(new Date(e.published_at)).date === ekb.date
      );
      const missed = await missedWindowsToday(env, { now: new Date() });
      const health = await kv.getHealthDay(env, ekb.date);
      const pollStats = await kv.getPollStats(env);
      const pollKeys = Object.keys(pollStats || {});
      const lines = [
        `Бот: <b>v${VERSION}</b> · авто: <b>${await kv.getAutopost(env) ? "вкл" : "выкл"}</b> · карточки: <b>${(await kv.getCardFormat(env)) || "auto"}</b>`,
        `Постов сегодня: <b>${today.length}</b>`,
        `Пропущенных окон сегодня: <b>${missed.length}</b>${missed.length ? " (" + missed.map((w) => w.label).join(", ") + ")" : ""}`,
        `Срывов публикации за день: <b>${health.publish_fails || 0}</b>`,
        `Ответов на опросы: <b>${pollKeys.reduce((s, k) => s + (pollStats[k].total || 0), 0)}</b> (${pollKeys.length} ${plural(pollKeys.length, "опрос", "опроса", "опросов")})`,
        `Кандидатов: <b>${(await kv.getCandidates(env) || []).length}</b> · на складе: <b>${(await kv.getStock(env) || []).length}</b>`,
      ];
      await sendMessage(env, chatId, "🩺 <b>Здоровье студии</b>\n\n" + lines.map((l) => "• " + l).join("\n"), { parse_mode: "HTML" });
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

    case "/event": {
      await startEventDialog(env, chatId);
      break;
    }

    case "/stats": {
      const log = await kv.getLog(env);
      const ekb = ekbNow();
      const today = log.filter((e) => {
        const t = new Date(e.published_at);
        return !Number.isNaN(t.getTime()) && ekbNow(t).date === ekb.date;
      }).length;
      const byKind = {};
      for (const e of log) byKind[e.kind || "news"] = (byKind[e.kind || "news"] || 0) + 1;
      const KIND_LABELS = {
        news: "новости",
        digest: "дайджесты",
        event: "ивенты",
        generated: "посты",
        suggestion: "предложки",
        retry: "повторы",
      };
      const lines = Object.entries(byKind)
        .map(([k, v]) => `• ${KIND_LABELS[k] || k}: ${v}`)
        .join("\n");
      const msg =
        "📊 <b>Состав публикаций</b>\n\n" +
        `Всего: <b>${log.length}</b>\nСегодня: <b>${today}</b>\n\n${lines || "—"}`;
      await sendMessage(env, chatId, msg, { parse_mode: "HTML" });
      break;
    }

    case "/analytics": {
      const days = args === "месяц" || args === "month" ? 30 : args === "неделя" || args === "week" ? 7 : 7;
      const text = await slotAnalyticsText(env, { days });
      const polls = await pollStatsText(env);
      if (!text && !polls) {
        await sendMessage(env, chatId, "Аналитика слотов пока не собралась: мало данных.", { parse_mode: "HTML" });
        break;
      }
      const body = [text, polls].filter(Boolean).join("\n\n");
      await sendMessage(env, chatId, body, { parse_mode: "HTML", reply_markup: QUICK_ANALYTICS_KB });
      break;
    }

    case "/report": {
      if (!args) {
        const kb = {
          inline_keyboard: [
            [{ text: "🌆 Вечерняя сводка", callback_data: "report:evening" }],
            [{ text: "📋 Отчёт за день", callback_data: "report:day" }],
            [{ text: "🗓 Недельная сводка", callback_data: "report:week" }],
            [{ text: "📅 Месячная сводка", callback_data: "report:month" }],
          ],
        };
        await sendMessage(
          env,
          chatId,
          "📈 <b>Отчёты студии</b>\n\nАвтоматически приходят: вечером 20:00 — сводка, в 23:30 — отчёт за день, в воскресенье — неделя, 1-го числа — месяц.\n\nВыберите отчёт:",
          { parse_mode: "HTML", reply_markup: kb }
        );
        break;
      }
      const period = args.toLowerCase();
      const builders = {
        "вечер": () => eveningSummaryText(env, { now: new Date() }),
        "день": () => dayReportText(env, { now: new Date() }),
        "неделя": () => weekReportText(env, { now: new Date() }),
        "месяц": () => monthReportText(env, { now: new Date() }),
        "today": () => eveningSummaryText(env, { now: new Date() }),
        "day": () => dayReportText(env, { now: new Date() }),
        "week": () => weekReportText(env, { now: new Date() }),
        "month": () => monthReportText(env, { now: new Date() }),
      };
      const build = builders[period] || builders["вечер"];
      const text = await build();
      if (!text) {
        await sendMessage(
          env,
          chatId,
          "Отчёт не собрался: пока мало данных. Автоматически приходит: вечером 20:00 — сводка, в 23:30 — отчёт за день, в воскресенье — неделя, 1-го числа — месяц.",
          { parse_mode: "HTML" }
        );
        break;
      }
      await sendMessage(env, chatId, text, { parse_mode: "HTML" });
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
      const fmt = await kv.getCardFormat(env);
      const autopost = await kv.getAutopost(env);
      const fmtLabel = fmt === "gif" ? "GIF (анимация неба)" : fmt === "png" ? "PNG (статик)" : "auto (GIF при наличии рендера)";
      const schedWins = (await getSchedule(env)).windows;
      const msg =
        "⚙️ <b>Настройки</b>\n\n" +
        `Режим: <b>${dry ? "dry-run" : "боевой"}</b>\n` +
        `Автопостинг: <b>${autopost ? "вкл" : "выкл"}</b>\n` +
        `Формат карточек: <b>${fmtLabel}</b>\n` +
        `Ключевые слова: +${extra} добавлено, −${removed} убрано\n` +
        `Окна (ЕКБ): ${schedWins.map((w) => `${minutesToClock(w.start)}–${minutesToClock(w.end)}`).join(", ")}\n\n` +
        "Переключатели — кнопками ниже:";
      await sendMessage(env, chatId, msg, {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: `Автопостинг: ${autopost ? "✅ вкл" : "⭕ выкл"}`, callback_data: "set:autopost" },
            ],
            [
              { text: fmt === "gif" ? "🖼 GIF ✓" : "🖼 GIF", callback_data: "set:cardfmt:gif" },
              { text: fmt === "png" ? "🖼 PNG ✓" : "🖼 PNG", callback_data: "set:cardfmt:png" },
              { text: fmt === "auto" ? "🖼 Auto ✓" : "🖼 Auto", callback_data: "set:cardfmt:auto" },
            ],
            [
              { text: dry ? "🧪 Dry-run: вкл ✓" : "🧪 Dry-run: выкл", callback_data: "set:dryrun" },
            ],
          ],
        },
      });
      break;
    }

    case "/cardfmt": {
      const next = args && ["gif", "png", "auto"].includes(args.trim().toLowerCase())
        ? args.trim().toLowerCase()
        : null;
      if (!next) {
        await sendMessage(env, chatId, "Формат: /cardfmt gif | png | auto");
        break;
      }
      await kv.setCardFormat(env, next);
      const label = next === "gif" ? "GIF (анимация неба)" : next === "png" ? "PNG (статик)" : "auto (GIF при наличии рендера)";
      await sendMessage(env, chatId, `✅ Формат карточек: <b>${label}</b>`, { parse_mode: "HTML" });
      break;
    }

    case "/dryrun": {
      state.dry_run = args ? args === "on" : !state.dry_run;
      await kv.saveState(env, state);
      await sendMessage(env, chatId, `✅ Dry-run ${state.dry_run ? "включён" : "выключен"}`);
      break;
    }

    case "/autopost": {
      const on = args ? args === "on" : !(await kv.getAutopost(env));
      state.autopost = on;
      await kv.saveState(env, state);
      await kv.setAutopost(env, on);
      await sendMessage(env, chatId, `✅ Автопостинг ${on ? "включён" : "выключен"}`);
      break;
    }

    case "/publish":
    case "/puball":
    case "/pubvk":
    case "/pubtg": {
      const stock = await kv.getStock(env);
      let pkg = null;
      if (args) pkg = stock.find((p) => p.id === args || p.guid === args);
      else pkg = stock[0];
      if (!pkg) {
        await sendMessage(env, chatId, args ? "Пост не найден на складе." : "Склад пуст.");
        break;
      }
      const tgt = cmd === "/pubvk" ? "vk" : cmd === "/pubtg" ? "tg" : "all";
      const tgtLabel = tgt === "vk" ? "→ VK" : tgt === "tg" ? "→ TG" : "→ VK+TG";
      await kv.removeStock(env, pkg.id);
      try {
        await publishPackage(env, { ...pkg, scheduled_for: Date.now() }, dry, tgt);
        await sendMessage(env, chatId, `✅ Опубликовано${dry ? " (dry-run)" : ""} ${tgtLabel}: ${escHtml(pkg.title || "")}`);
      } catch (e) {
        await kv.addStock(env, pkg);
        await sendMessage(env, chatId, `⚠️ Ошибка: ${escHtml(e.message)}`);
      }
      break;
    }

    case "/gemini":
    case "/gigachat":
    case "/noai": {
      const prov = cmd === "/gemini" ? "gemini" : cmd === "/gigachat" ? "gigachat" : "rules";
      if (!args) {
        await sendMessage(
          env,
          chatId,
          `Формат: ${cmd} &lt;текст новости&gt;\nСоздам карточку без сохранения текста в истории. Провайдер: <b>${prov}</b>.`,
          { parse_mode: "HTML" }
        );
        break;
      }
      const label = prov === "gemini" ? "✨ Gemini" : prov === "gigachat" ? "🧠 GigaChat" : "📝 по правилам";
      try {
        await sendGeneratedPreview(env, chatId, args, { provider: prov });
        await sendMessage(
          env,
          chatId,
          `🔨 <b>Карточка готова</b> (${label}). Кнопки под превью: 🌐 везде / 🔵 VK / 🟢 TG, 🔄 переделать, ❌ отменить.`,
          { parse_mode: "HTML" }
        );
      } catch (e) {
        await sendMessage(env, chatId, `⚠️ Не удалось подготовить: ${escHtml(e.message)}`);
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

    case "/defer": {
      const drafts = await kv.listDrafts(env);
      const draft = args ? drafts.find((d) => d.id === args) : drafts[0];
      if (!draft) {
        await sendMessage(env, chatId, "Черновиков для отложки нет. Список — /drafts");
        break;
      }
      const slot = await nextFreeSlot(env);
      draft.status = "deferred";
      draft.deferred_until = new Date(slot).toISOString();
      await kv.saveDraft(env, draft);
      await sendMessage(
        env,
        chatId,
        `🕓 «${escHtml(draft.title || "")}» отложен до слота ${fmtTime(new Date(slot).toISOString())}`,
        { parse_mode: "HTML" }
      );
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

    case "/digesttest": {
      const r = await sendDigestTestPreview(env);
      if (r.ok) {
        await sendMessage(env, chatId, `🌅 Тестовое превью дайджеста отправлено: ${escHtml(r.title || "")}`);
      } else {
        await sendMessage(env, chatId, `⚠️ ${escHtml(r.reason || "Не получилось собрать превью")}`);
      }
      break;
    }

    case "/version":
      await sendMessage(env, chatId, `🧬 TrustNode SMM v${VERSION} (Worker publish contour)`);
      break;

    case "/mg":
    case "/mg-status": {
      const rows = await multiStatus(env);
      const msg =
        "👥 <b>Мультигруппы (VK)</b>\n\n" +
        rows.map((r) => {
          const slotDot = r.slot === "активен" ? "🟢" : "⚪";
          return `${slotDot} <b>${escHtml(r.name)}</b> · токен ${r.token} · сегодня: ${r.postedToday} пост`
            + (r.slot === "активен" ? ` (${r.slot})` : "")
            + (r.lastPostAgo ? ` · последний: ${escHtml(r.lastPostAgo)}` : "")
            + `\n      🕐 окна: ${escHtml(r.wins || "—")} ЕКБ`;
        }).join("\n") +
        `\n\n📋 Согласование: ${rows.approval ? "включено" : "выключено"} (/mg-approve)` +
        "\n⚙️ Настройка: /mg-edit";
      await sendMessage(env, chatId, msg, { parse_mode: "HTML", reply_markup: QUICK_MULTI_KB });
      break;
    }

    case "/mg-tick": {
      const results = await multigroupTick(env, new Date(), { force: true });
      const lines = results.map(
        (r) => `${r.posted ? "✅" : "⏭"} <b>${escHtml(r.slug)}</b>: ${escHtml(r.detail)}`
      ).join("\n");
      await sendMessage(env, chatId, "👥 <b>multigroupTick</b>\n" + lines, { parse_mode: "HTML", reply_markup: QUICK_MULTI_KB });
      break;
    }

    case "/mg-edit": {
      const cfg = await loadMgConfig(env);
      const fmtWin = (arr) => (arr || []).slice().sort((a, b) => a - b)
        .map((m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`).join(" ");
      const msg =
        "⚙️ <b>Конфиг мультигрупп</b>\n\n" +
        "<b>Окна (ЕКБ):</b>\n" +
        Object.keys(cfg.windows).map((slug) => `  ${escHtml(slug)}: ${fmtWin(cfg.windows[slug])}`).join("\n") + "\n\n" +
        `<b>Ленты RU</b> (${cfg.feeds.ru.length}): ${cfg.feeds.ru.map((u) => escHtml(u.replace(/^https?:\/\/(www\.)?/, "").split("/")[0])).join(", ")}\n` +
        `<b>Ленты EN</b> (${cfg.feeds.en.length}): ${cfg.feeds.en.map((u) => escHtml(u.replace(/^https?:\/\/(www\.)?/, "").split("/")[0])).join(", ")}\n\n` +
        `<b>Арт-каналы</b>: ${cfg.channels.map((c) => "@" + escHtml(c)).join(", ")}` +
        `\n<b>Согласование</b>: ${cfg.approval ? "✅ включено" : "выключено"}` +
        "\n\n<i>Команды:</i>\n" +
        "<code>/mg-win dgc 05:00,10:00,15:00,20:00</code>\n" +
        "<code>/mg-feed en add https://…/rss</code>\n" +
        "<code>/mg-feed en del pcgamer.com/rss/</code>\n" +
        "<code>/mg-chan add neuralart | del neuralart</code>\n" +
        "<code>/mg-approve on|off</code> · <code>/mg-reset</code>";
      const kb = {
        inline_keyboard: [[
          { text: cfg.approval ? "🚫 Выключить согласование" : "✅ Включить согласование", callback_data: "mg:approve" },
        ]],
      };
      await sendMessage(env, chatId, msg, { parse_mode: "HTML", reply_markup: kb });
      break;
    }

    case "/mg-win": {
      // /mg-win dgc 05:00,10:00,15:00,20:00
      const parts = (text || "").trim().split(/\s+/);
      if (parts.length < 3) {
        await sendMessage(env, chatId, "Формат: <code>/mg-win dgc 05:00,10:00,15:00,20:00</code>", { parse_mode: "HTML" });
        break;
      }
      const slug = parts[1].toLowerCase();
      const times = parts[2].split(",").map((s) => {
        const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
        if (!m) throw new Error(`неверное время: ${s}`);
        return Number(m[1]) * 60 + Number(m[2]);
      });
      if (!times.length) throw new Error("пустой список окон");
      const cfg = await loadMgConfig(env);
      if (!(slug in cfg.windows)) throw new Error(`неизвестная группа: ${slug}`);
      cfg.windows[slug] = times;
      await saveMgConfig(env, cfg);
      await sendMessage(env, chatId, `✅ Окна ${escHtml(slug)} обновлены: ${times.join(", ")} (мин от полуночи ЕКБ)`);
      break;
    }

    case "/mg-feed": {
      // /mg-feed <ru|en> add <url> | /mg-feed <ru|en> del <часть-url>
      const parts = (text || "").trim().split(/\s+/);
      if (parts.length < 4) {
        await sendMessage(env, chatId, "Формат:\n<code>/mg-feed en add https://site/rss</code>\n<code>/mg-feed en del pcgamer.com/rss/</code>", { parse_mode: "HTML" });
        break;
      }
      const lang = parts[1].toLowerCase();
      const op = parts[2].toLowerCase();
      const val = parts.slice(3).join(" ");
      if (lang !== "ru" && lang !== "en") throw new Error("язык: ru или en");
      const cfg = await loadMgConfig(env);
      if (op === "add") {
        if (!/^https?:\/\//.test(val)) throw new Error("URL должен начинаться с http(s)://");
        if (cfg.feeds[lang].includes(val)) throw new Error("такая лента уже есть");
        cfg.feeds[lang].push(val);
        await saveMgConfig(env, cfg);
        await sendMessage(env, chatId, `✅ Лента добавлена в ${lang}: ${escHtml(val)} (всего: ${cfg.feeds[lang].length})`);
      } else if (op === "del") {
        const before = cfg.feeds[lang].length;
        cfg.feeds[lang] = cfg.feeds[lang].filter((u) => !u.includes(val));
        if (cfg.feeds[lang].length === before) throw new Error("лента не найдена");
        await saveMgConfig(env, cfg);
        await sendMessage(env, chatId, `✅ Лента удалена из ${lang} (осталось: ${cfg.feeds[lang].length})`);
      } else {
        throw new Error("операция: add или del");
      }
      break;
    }

    case "/mg-chan": {
      // /mg-chan add <channel> | /mg-chan del <channel>
      const parts = (text || "").trim().split(/\s+/);
      if (parts.length < 3) {
        await sendMessage(env, chatId, "Формат: <code>/mg-chan add neuralart</code> или <code>/mg-chan del neuralart</code>", { parse_mode: "HTML" });
        break;
      }
      const op = parts[1].toLowerCase();
      const ch = parts[2].replace(/^@/, "").trim();
      if (!/^[\w\d_]+$/.test(ch)) throw new Error("неверное имя канала");
      const cfg = await loadMgConfig(env);
      if (op === "add") {
        if (cfg.channels.includes(ch)) throw new Error("канал уже есть");
        cfg.channels.push(ch);
        await saveMgConfig(env, cfg);
        await sendMessage(env, chatId, `✅ Канал @${escHtml(ch)} добавлен (всего: ${cfg.channels.length})`);
      } else if (op === "del") {
        const before = cfg.channels.length;
        cfg.channels = cfg.channels.filter((c) => c !== ch);
        if (cfg.channels.length === before) throw new Error("канал не найден");
        await saveMgConfig(env, cfg);
        await sendMessage(env, chatId, `✅ Канал @${escHtml(ch)} удалён (осталось: ${cfg.channels.length})`);
      } else {
        throw new Error("операция: add или del");
      }
      break;
    }

    case "/mg-approve": {
      const arg = (text || "").trim().split(/\s+/)[1];
      if (arg !== "on" && arg !== "off") {
        const cfg = await loadMgConfig(env);
        await sendMessage(env, chatId, `Согласование сейчас: ${cfg.approval ? "включено" : "выключено"}.\nПереключить: <code>/mg-approve on</code> или <code>/mg-approve off</code>`, { parse_mode: "HTML" });
        break;
      }
      const cfg = await loadMgConfig(env);
      cfg.approval = arg === "on";
      await saveMgConfig(env, cfg);
      await sendMessage(env, chatId, `✅ Согласование ${cfg.approval ? "включено — черновики будут приходить с кнопками ✅/⏭" : "выключено — посты публикуются автоматически"}`);
      break;
    }

    case "/mg-reset": {
      await resetMgConfig(env);
      await sendMessage(env, chatId, "✅ Конфиг мультигрупп сброшен к дефолтному");
      break;
    }

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
  if (!chatId) return;

  // обычные пользователи: меню, предложка, поддержка
  if (!isAdmin(env, chatId)) {
    const text = (msg.text || "").trim();
    if (text === "/start" || text === "/menu") {
      await handleUserStart(env, chatId);
      return;
    }
    if (text.startsWith("/")) {
      if (text === "/cancel") {
        await kv.setUserMode(env, chatId, null);
        await handleUserStart(env, chatId);
        return;
      }
      await sendMessage(
        env,
        chatId,
        "Я бот TrustNode. Чтобы предложить пост или написать в поддержку, откройте меню: /start"
      );
      return;
    }
    const mode = await kv.getUserMode(env, chatId);
    if (mode === "suggest") {
      await handleSuggestion(env, msg);
    } else if (mode === "support") {
      await handleSupportMessage(env, msg);
    } else {
      await handleUserStart(env, chatId);
    }
    return;
  }

  // админ: ивент-диалог имеет приоритет над командами
  const dialog = await kv.getEventDialog(env);
  if (dialog && String(dialog.chat_id) === String(chatId)) {
    const handled = await handleEventDialogMessage(env, msg);
    if (handled) return;
  }

  // ответ реплаем на пересланное сообщение поддержки -> пользователю
  if (msg.reply_to_message) {
    const handledReply = await handleAdminSupportReply(env, msg);
    if (handledReply) return;
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
  } else if (update.poll_answer) {
    try {
      const pid = await kv.recordPollAnswer(env, update.poll_answer);
      if (pid) console.log(`[webhook] poll_answer: ${String(pid).slice(0, 12)}`);
    } catch (e) {
      console.log("[webhook] poll_answer error:", e.message);
    }
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
    // Держим Render-инстанс тёплым (free tier засыпает после ~15 мин без
    // трафика): ping в фоне, НЕ блокируя основной тик — у scheduled-хендлера
    // и так жёсткий wall-clock лимит, и каждая секунда важна для сборки/постов.
    try {
      ctx.waitUntil(keepRenderWarm(env).catch((e) => console.log("keepRenderWarm error:", e.message)));
    } catch (e) {
      console.log("keepRenderWarm error:", e.message);
    }
    // Отчёты студии (вечер/день/неделя/месяц) шлём в фоне, НЕ внутри тика:
    // раньше они выполнялись последним шагом тика и съедали остаток бюджета —
    // тик обрезался на «reports», не успев догнать публикации в VK. Теперь
    // reports идёт параллельно с тиком и не трогает его бюджет.
    try {
      ctx.waitUntil(maybeSendReports(env).catch((e) => console.log("reports error:", e.message)));
    } catch (e) {
      console.log("reports error:", e.message);
    }
    // Статистика вовлечённости (VK-опрос и TG-реакции) вырезана: групповой
    // токен VK не читает стену (error 27), вебхук реакций не подтверждён
    // тестами. Публикация работает напрямую на консенсус платформ.
    try {
      await schedulerTick(env);
    } catch (e) {
      console.log("scheduled error:", e.message);
    }
    // Диагностика канала: резолвим chat_id и кэшируем в KV на каждом тике,
    // чтобы всегда знать целевой канал и не терять его при смене секрета.
    try {
      await resolveTelegramChannel(env);
    } catch (e) {
      console.log("resolve channel error:", e.message);
    }
  },
};
