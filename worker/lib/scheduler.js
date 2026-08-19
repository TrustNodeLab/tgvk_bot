// Планировщик: каждый крон выполняет полный цикл —
// скан+дедуп -> накопление кандидатов -> публикация по окнам
// (утро/день/вечер: 1 новость = 1 пост) -> авто-отложка черновиков ->
// публикация из «склада» по слотам -> догонка недостающей платформы.

import {
  NEWS_WINDOWS,
  DIGEST_MAX_ITEMS,
  MSK_OFFSET_MIN,
  DRAFT_TIMEOUT_MIN, mskNow, isStaleItem, cleanRssTitle,
} from "./config.js";
import * as kv from "./kv.js";
import { scanFeeds } from "./feeds.js";
import { mainTopic } from "./nlp.js";
import { renderCard } from "./cardgen.js";
import { renderCardBytes, sourceDomain, approveButtons } from "./preview.js";
import { generateDigestText, digestFreshScore, generatePostData, generateByRules } from "./llm.js";
import { getWindows, windowBySlug, currentWindow as schedCurrentWindow } from "./schedule.js";
import {
  publishToTelegram, publishToVk, sendMessage, vkCall, sendCard,
} from "./telegram.js";
import { fmtTime, escHtml, fitCaption, htmlToPlain } from "./text.js";

const CHUNK_COUNT = 2; // скан делится на 2 части (лимит подзапросов free-плана)
const TICK_LOCK_TTL_MS = 10 * 60 * 1000; // анти-перекрытие крон: не чаще 1 тика

// Хард-бюджет тика. Free-план Cloudflare душит тяжёлые крон-запуски: тик,
// который не успел завершиться за отведённый wall-clock лимит, «молча» убивается
// (в tail — ноль логов и exceededCpu). Поэтому каждый тик жёстко застрахован
// возвратом "timeout" с громким логом, а тяжёлые шаги (LLM/рендер) получают свои
// короткие бюджеты с фолбэком на правила / JS-рендер, чтобы тик почти всегда
// укладывался в бюджет и «не дожимался» там.
const TICK_BUDGET_MS = 28000;
const LLM_BUDGET_MS = 6000;
const RENDER_BUDGET_MS = 5000;
const SCAN_BUDGET_MS = 8000;
const ASSEMBLE_BUDGET_MS = 9000;

// Запускает promise с жёстким бюджетом: по истечении ms реджектит (промис при
// этом продолжает жить в фоне, но результат уже никому не нужен — тик не ждёт).
function bounded(ms, label, promise) {
  let timer;
  return new Promise((resolve, reject) => {
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
    timer = setTimeout(() => {
      reject(new Error(`${label} превысил бюджет ${ms}ms`));
    }, ms);
  });
}

// png в черновике хранится base64 (KV умеет только строки) — превращаем в байты.
function decodePng(b64) {
  if (!b64) return null;
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// Байты карточки -> base64 для хранения в KV.
function bytesToBase64(bytes) {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

// Уведомление админу в Telegram о результате публикации. Ошибка отправки не
// роняет публикацию — уведомление некритично.
async function notifyAdmin(env, text) {
  if (!env.TELEGRAM_ADMIN_CHAT_ID) return;
  try {
    await sendMessage(env, env.TELEGRAM_ADMIN_CHAT_ID, text, { parse_mode: "HTML" });
  } catch (e) { /* ignore */ }
}

function vkPostUrl(env, postId) {
  return postId && env.VK_GROUP_ID ? `https://vk.com/wall-${env.VK_GROUP_ID}_${postId}` : null;
}

// Статусная строка по результатам публикации в обе платформы.
function pubStatus(res) {
  const parts = [];
  parts.push(res.tgOk ? "🟢 TG ✓" : "TG ✗");
  parts.push(res.vkOk ? "🔵 VK ✓" : "VK ✗");
  return parts.join(" · ");
}

// ---------- время и слоты ----------

export function mskToUtcMs(dow, minuteOfDay, now = new Date()) {
  // ближайшее наступление dow (0=пн) в minuteOfDay в МСК -> epoch ms
  const msk = new Date(now.getTime() + MSK_OFFSET_MIN * 60 * 1000);
  const todayDow = (msk.getUTCDay() + 6) % 7;
  let delta = (dow - todayDow + 7) % 7;
  let y = msk.getUTCFullYear();
  let m = msk.getUTCMonth();
  let d = msk.getUTCDate();
  for (let i = 0; i < delta; i++) {
    d += 1;
    if (d > new Date(Date.UTC(y, m + 1, 0)).getUTCDate()) {
      d = 1;
      m += 1;
      if (m > 11) {
        m = 0;
        y += 1;
      }
    }
  }
  const utcMinute = minuteOfDay - MSK_OFFSET_MIN;
  return Date.UTC(y, m, d, Math.floor(utcMinute / 60), utcMinute % 60) - (0);
}

export function currentWindow(minuteOfDay) {
  return NEWS_WINDOWS.find((w) => minuteOfDay >= w.start && minuteOfDay < w.end) || null;
}

// Текущее окно по динамическому расписанию (см. lib/schedule.js).
export async function dynamicCurrentWindow(env, minuteOfDay) {
  return schedCurrentWindow(env, minuteOfDay);
}

// Сколько новостей/дайджестов уже опубликовано в этом окне сегодня. Дайджест и
// одиночная новость занимают «вместимость» окна одинаково (cap=1 за окно).
async function countInWindow(env, win, now) {
  const log = await kv.getLog(env);
  const msk = mskNow(now);
  return log.filter((e) => {
    const k = e.kind;
    if (k && k !== "news" && k !== "digest") return false;
    const t = new Date(e.published_at);
    if (Number.isNaN(t.getTime())) return false;
    const em = mskNow(t);
    if (em.date !== msk.date) return false;
    return em.minuteOfDay >= win.start && em.minuteOfDay < win.end;
  }).length;
}

// Следующий свободный слот для поста (epoch ms).
// Строгое расписание: один пост в начале окна. Окна по умолчанию — дайджесты
// 3-5 новостей: 09:00, 13:00, 18:00 МСК. Адаптивное расписание (lib/schedule.js)
// может добавить или убрать слоты по охватам — здесь учитываются динамические
// окна. Без рандома внутри окна.
export async function nextFreeSlot(env, now = new Date()) {
  const nowMs = now.getTime();
  const wins = await getWindows(env);
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const t = new Date(nowMs + dayOffset * 86400000);
    const m2 = mskNow(t);
    for (const w of wins) {
      const slot = mskToUtcMs(m2.dow, w.start, new Date(t));
      if (slot < nowMs) continue; // слот уже прошёл
      const used = await countInWindow(env, w, new Date(slot));
      if (used < w.cap) return slot;
    }
  }
  return nowMs + 3600 * 1000;
}

// ---------- диспатч кандидатов на подготовку (GitHub Actions) ----------

function chunkText(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

export async function dispatchToGitHub(env, cand) {
  const chunks = chunkText(cand.text || "", 600).slice(0, 9);
  const inputs = {
    telegram_update: JSON.stringify({
      auto_found: cand.auto_found !== false,
      guid: cand.guid,
      title: cand.title || "",
      link: cand.link || "",
      kind: cand.kind || "news",
      message: { chat: { id: cand.chat_id ?? null }, text: chunks[0] || "" },
    }),
  };
  for (let i = 1; i < chunks.length; i++) inputs[`telegram_update_${i + 1}`] = chunks[i];

  const res = await fetch(
    `https://api.github.com/repos/${env.OWNER}/${env.REPO}/actions/workflows/poll.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "tgvk-bot-webhook",
      },
      body: JSON.stringify({ ref: "main", inputs }),
    }
  );
  if (!res.ok) return false;
  await kv.markDispatch(env, cand.guid, {
    at: Date.now(),
    title: cand.title,
    link: cand.link,
    kind: cand.kind || "news",
    pub_ts: cand.pub_ts || null,
    status: "dispatched",
  });
  return true;
}

// ---------- публикация ----------

export async function publishPackage(env, pkg, dry, target = "all") {
  if (target === "vk") return publishOne("vk");
  if (target === "tg") return publishOne("tg");
  return publishOne("all");

  async function publishOne(mode) {
    let tgOk = false;
    let vkOk = false;
    let tgErr = null;
    let vkErr = null;
    let vkPost = null;
    let vkAttach = null;
    let tgMessageId = null;
    let tgDigestMessageId = null;
    if (mode !== "vk") {
      try {
        const tgRes = await publishToTelegram(env, pkg, dry);
        tgOk = true;
        tgMessageId = tgRes && tgRes.message_id;
        tgDigestMessageId = tgRes && tgRes.digest_message_id;
      } catch (e) {
        tgErr = e.message;
      }
    }
    if (mode !== "tg") {
      try {
        const vkr = await publishToVk(env, pkg, dry);
        vkOk = true;
        vkPost = (vkr && vkr.post_id) || null;
        vkAttach = (vkr && vkr.vk_attachment) || null;
      } catch (e) {
        vkErr = e.message;
      }
    }
    // Строгий пул VK/TG: авто-пост должен уйти в обе платформы. Если ушла
    // только одна — недостающую догоняем ретраями на следующих тиках, а в лог
    // пишем частичный статус (он же — источник правды по количеству постов).
    if (mode === "all" && tgOk !== vkOk && !dry) {
      await kv.addVkRetry(env, { ...pkg, attempts: 0 }, { missing: [tgOk ? "vk" : "tg"] });
    }
    if (!tgOk && !vkOk) {
      throw new Error(`publish failed tg=[${tgErr}] vk=[${vkErr}]`);
    }
    await kv.addLog(env, {
      id: pkg.id,
      kind: pkg.kind || "news",
      title: pkg.title || "",
      guid: pkg.guid || "",
      link: pkg.link || "",
      tags: pkg.tags || [],
      source: pkg.source || "",
      published_at: new Date().toISOString(),
      caption: pkg.caption || "",
      tg_ok: tgOk,
      vk_ok: vkOk,
      vk_post_id: vkPost,
      vk_attachment: vkAttach,
      tg_message_id: tgMessageId,
      tg_digest_message_id: tgDigestMessageId,
      tg_err: tgErr || null,
      vk_err: vkErr || null,
      target: mode,
      // Атрибуты для статистики: схема мошенничества / жанр / тема / провайдер.
      scheme_id: (pkg.data && pkg.data.scheme_id) || pkg.scheme_id || null,
      style_id: (pkg.data && pkg.data.style_id) || pkg.style_id || null,
      topic_id: (pkg.data && pkg.data.topic_id) || pkg.topic_id || null,
      llm_provider: (pkg.data && pkg.data.llm_provider) || pkg.llm_provider || null,
      // Контекст для следующего поста: сетка и типы карточек предыдущего,
      // чтобы LLM не повторял layout и не клеил подряд одинаковые посты.
      card_types: (pkg.data && pkg.data.cards && pkg.data.cards.length)
        ? pkg.data.cards.map((c) => c && c.type || "stat").slice(0, 4)
        : [],
      layout: (pkg.data && pkg.data.cards && pkg.data.cards.length)
        ? pkg.data.cards.map((c) => c && c.type || "stat").slice(0, 4).join("-")
        : "",
    });
    return { tgOk, vkOk, vkPost };
  }
}

// Публикация текстового поста (ивенты без карточки).
export async function publishText(env, text, dry, kind, extra = {}) {
  let tgOk = false;
  let vkOk = false;
  let tgErr = null;
  let vkErr = null;
  if (dry) {
    console.log(`[dry-run] TG text -> ${env.TELEGRAM_CHANNEL_ID} (${text.length} симв.)`);
    tgOk = true;
  } else {
    try {
      await sendMessage(env, env.TELEGRAM_CHANNEL_ID, text, { parse_mode: "HTML" });
      tgOk = true;
    } catch (e) { tgErr = e.message; }
  }
  const plain = htmlToPlain(text);
  if (dry) {
    console.log(`[dry-run] VK wall.post text (${plain.length} симв.)`);
    vkOk = true;
  } else {
    try {
      await vkCall(env, "wall.post", {
        owner_id: -env.VK_GROUP_ID,
        from_group: 1,
        message: plain,
      });
      vkOk = true;
    } catch (e) { vkErr = e.message; }
  }
  if (!tgOk && !vkOk) return false;
  await kv.addLog(env, {
    id: extra.id || `t${Date.now()}`,
    kind,
    title: extra.title || "",
    guid: extra.guid || "",
    link: extra.link || "",
    published_at: new Date().toISOString(),
    caption: text,
    tg_ok: tgOk,
    vk_ok: vkOk,
    tg_err: tgErr,
    vk_err: vkErr,
  });
  return true;
}

// ---------- ретраи: догонка недостающей платформы (строгий пул VK/TG) ----------

// На каждом тике пробуем догрузить в недостающую платформу посты, которые не
// ушли с первой попытки (missing = ["vk"] | ["tg"]). Когда обе платформы
// опубликованы — обновляем существующую запись publish_log (одна запись на пост,
// со статусом обеих). Неудача -> возврат в очередь с ростом счётчика; превышение
// лимита или выход из окна свежести -> оставляем частичный статус в логе.
export async function processVkRetries(env) {
  const { MAX_VK_RETRY_ATTEMPTS } = await import("./limits.js");
  const retries = await kv.getVkRetry(env);
  if (!retries.length) return { processed: 0 };
  const state = await kv.loadState(env);
  const dry = !!state.dry_run;
  let processed = 0;
  const nowMs = Date.now();
  for (const item of retries) {
    if (item.attempts >= MAX_VK_RETRY_ATTEMPTS) {
      console.log(`[vk-retry] отказ после ${item.attempts} попыток: ${item.title || item.id}`);
      await kv.removeVkRetry(env, item.id);
      processed++;
      continue;
    }
    // новость протухла, пока ждала догонки — не публикуем
    if (isStaleItem(item, nowMs)) {
      console.log(`[vk-retry] протухла, удаляю: ${item.title || item.id}`);
      await kv.removeVkRetry(env, item.id);
      processed++;
      continue;
    }
    const missing = item.missing && item.missing.length ? item.missing : ["vk"];
    let allDone = true;
    let tgErr = null;
    let vkErr = null;
    let vkPost = null;
    let vkAttach = null;
    for (const plat of missing) {
      try {
        if (plat === "tg") {
          await publishToTelegram(env, item, dry);
        } else {
          const vkr = await publishToVk(env, item, dry);
          if (!vkr || !vkr.post_id) throw new Error("нет post_id после успешного upload");
          vkPost = vkr.post_id;
          vkAttach = vkr.vk_attachment || null;
        }
      } catch (e) {
        allDone = false;
        if (plat === "tg") tgErr = e.message; else vkErr = e.message;
        break;
      }
    }
    if (allDone) {
      await kv.removeVkRetry(env, item.id);
      await kv.updateLog(env, item.id, {
        tg_ok: true,
        vk_ok: true,
        tg_err: null,
        vk_err: null,
        vk_post_id: vkPost,
        vk_attachment: vkAttach,
      });
      processed++;
      console.log(`[vk-retry] опубликовано в обе платформы (попытка ${item.attempts}): ${item.title || item.id}`);
      const url = vkPostUrl(env, vkPost);
      if (!dry) {
        await notifyAdmin(
          env,
          `✅ <b>Догнано</b>: ${item.title || item.id}\n${pubStatus({ tgOk: true, vkOk: true })}${url ? ` · ${url}` : ""}`
        );
      }
    } else {
      console.log(`[vk-retry] попытка ${item.attempts} не удалась для «${item.title || item.id}»: ${tgErr || vkErr}`);
      await kv.removeVkRetry(env, item.id);
      await kv.addVkRetry(env, { ...item, attempts: item.attempts, missing });
      processed++;
    }
  }
  return { processed };
}

// ---------- черновики ----------

async function autoDeferDrafts(env, state, now = new Date()) {
  const drafts = await kv.listDrafts(env);
  const deadline = now.getTime() - DRAFT_TIMEOUT_MIN * 60 * 1000;
  for (const d of drafts) {
    if (d.status && d.status !== "pending") continue;
    // Черновики от GitHub приходят без created_at — таймер 30 минут стартует
    // с момента, когда Worker впервые увидел черновик.
    if (!d.created_at) {
      d.created_at = now.toISOString();
      await kv.saveDraft(env, d);
      continue;
    }
    const created = new Date(d.created_at).getTime();
    if (created > deadline) continue;
    // новость протухла, пока ждала ответа админа — черновик тихо удаляем
    if (isStaleItem(d, now.getTime())) {
      await kv.deleteDraft(env, d.id);
      continue;
    }
    // админ не ответил за 30 минут -> отложенный пост в ближайший свободный слот
    const slot = await nextFreeSlot(env, now);
    await kv.deleteDraft(env, d.id);
    await kv.addStock(env, {
      id: d.id,
      kind: d.kind === "digest" ? "digest" : "news",
      title: d.title || "",
      caption: d.caption || "",
      digest_text: d.digest_text || "",
      png_key: d.png_key || null,
      png: d.png ? (typeof d.png === "string" ? decodePng(d.png) : d.png) : null,
      link: d.link || "",
      guid: d.guid || "",
      source: d.source || "",
      tags: d.tags || [],
      data: d.data || null,
      items: d.items || [],
      scheduled_for: slot,
      created_at: new Date().toISOString(),
      from_admin: false,
      scheme_id: d.scheme_id || null,
      style_id: d.style_id || null,
      topic_id: d.topic_id || null,
      llm_provider: d.llm_provider || null,
    });
    const when = fmtTime(new Date(slot).toISOString());
    try {
      await sendMessage(
        env,
        env.TELEGRAM_ADMIN_CHAT_ID,
        `⏳ <b>Не получил ответ за ${DRAFT_TIMEOUT_MIN} минут</b> — пост «${d.title || ""}» поставлен в отложенные на слот ${when}.`,
        { parse_mode: "HTML" }
      );
    } catch (e) { /* ignore */ }
  }
}

// ---------- одиночные новости по окнам (1 новость = 1 пост) ----------

// Топ-1 свежайший кандидат для одиночного поста (pickDigestItems(1) уже сделал
// сортировку по свежести + буст темы). Пусто — новость не выйдет.
async function pickSingleItem(env) {
  const items = await pickDigestItems(env, 1);
  return items[0] || null;
}

// Бюджетная сборка карточки: текст через LLM (или правила при недоступности/
// перерасходе бюджета), картинка через рендер-сервис (или JS-фолбэк). Ничего
// не публикует и не потребляет — только готовит. Возвращает pkg или null.
async function finalizeNewsPkg(env, cand, opts) {
  const { slug, date, slot } = opts;
  const link = cand.link || "";
  const source = sourceDomain(link) || cand.source || "";
  const src = String(cand.text || cand.title || "");

  let data = null;
  try {
    data = await bounded(LLM_BUDGET_MS, "[scheduler] LLM",
      generatePostData(src, env, { link, source, guid: cand.guid || "" }));
  } catch (e) {
    console.log("[scheduler] LLM превысил бюджет, использую правила:", e.message);
  }
  if (!data) data = generateByRules(src, { link, source });

  let b64 = "";
  try {
    const bytes = await bounded(RENDER_BUDGET_MS, "[scheduler] render",
      renderCardBytes(env, data, { link, source }));
    if (bytes && bytes.length > 100) b64 = bytesToBase64(bytes);
  } catch (e) {
    console.log("[scheduler] рендер превысил бюджет, JS-фолбэк:", e.message);
  }
  if (!b64) {
    try {
      const bytes = await renderCard(data, { format: "png" });
      if (bytes && bytes.length > 100) b64 = bytesToBase64(bytes);
    } catch (e) {
      console.log("[scheduler] JS-рендер не сработал:", e.message);
    }
  }
  if (!b64) return null;

  const id = `n${date.replace(/-/g, "")}${slug}`;
  return {
    pkg: {
      id,
      kind: "news",
      title: data.headline || cleanRssTitle(cand.title || ""),
      caption: data.caption || "",
      png: b64,
      data,
      link,
      guid: cand.guid || id,
      source,
      tags: cand.tags || [],
      items: cand.items || [],
      scheduled_for: slot,
      created_at: new Date().toISOString(),
      from_admin: false,
      window_slug: slug,
      no_rereder: true,
      scheme_id: data.scheme_id || null,
      style_id: data.style_id || null,
      topic_id: data.topic_id || null,
      llm_provider: data.llm_provider || null,
    },
  };
}

// Автопосты ВКЛ: топ-1 кандидат активного окна -> одиночный пост на склад.
// Окно занимается маркером — второй пост в то же окно не собирается.
export async function assembleNewsPosts(env, now = new Date()) {
  const msk = mskNow(now);
  const made = [];
  for (const w of await getWindows(env)) {
    if (msk.minuteOfDay < w.start || msk.minuteOfDay >= w.end) continue;
    if (await kv.getDigestDone(env, msk.date, w.slug)) continue;
    const cand = await pickSingleItem(env);
    if (!cand) continue;
    const res = await finalizeNewsPkg(env, cand, {
      slug: w.slug,
      date: msk.date,
      slot: mskToUtcMs(msk.dow, w.start, now),
    });
    if (!res) continue;
    await kv.addStock(env, res.pkg);
    await commitSingle(env, msk.date, w.slug, cand);
    made.push(res.pkg.guid);
    console.log("[scheduler] одиночная новость собрана:", res.pkg.title, "→", new Date(res.pkg.scheduled_for).toISOString());
  }
  return made;
}

// Потребляет топ-1 кандидата и ставит маркер окна — пост выйдет один раз.
async function commitSingle(env, date, slug, cand) {
  const rest = (await kv.getCandidates(env)).filter((c) => c.guid !== cand.guid);
  await kv.setCandidates(env, rest);
  await kv.setDigestDone(env, date, slug, { assembled_at: new Date().toISOString(), kind: "news", guid: cand.guid });
}

// Автопосты ВЫКЛ: вместо публикации админу приходит превью новости на одобрение
// (кнопки 🌐/🔵/🟢/🔄/❌) — тот же контракт, что у дайджест-превью.
async function sendNewsPreview(env, adminChat, pkg) {
  const bytes = decodePng(pkg.png);
  const sent = await sendCard(env, adminChat, bytes, pkg.caption, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: approveButtons(pkg.id) },
  });
  await kv.saveDraft(env, {
    id: pkg.id,
    kind: "news",
    status: "pending",
    title: pkg.title,
    caption: pkg.caption,
    png: pkg.png,
    link: pkg.link,
    source: pkg.source,
    guid: pkg.guid,
    items: pkg.items,
    admin_chat_id: adminChat,
    preview_message_id: sent && sent.message_id,
    created_at: new Date().toISOString(),
    scheme_id: pkg.scheme_id,
    style_id: pkg.style_id,
    topic_id: pkg.topic_id,
    llm_provider: pkg.llm_provider,
  });
}

export async function assembleNewsDrafts(env, now = new Date()) {
  const msk = mskNow(now);
  const adminChat = env.TELEGRAM_ADMIN_CHAT_ID;
  let sent = 0;
  for (const w of await getWindows(env)) {
    if (msk.minuteOfDay < w.start || msk.minuteOfDay >= w.end) continue;
    if (await kv.getDigestDone(env, msk.date, w.slug)) continue;
    const cand = await pickSingleItem(env);
    if (!cand) continue;
    const res = await finalizeNewsPkg(env, cand, {
      slug: w.slug,
      date: msk.date,
      slot: mskToUtcMs(msk.dow, w.start, now),
    });
    if (!res) continue;
    if (adminChat) await sendNewsPreview(env, adminChat, res.pkg);
    await commitSingle(env, msk.date, w.slug, cand);
    sent++;
    console.log("[scheduler] превью новости админу:", res.pkg.title);
  }
  return sent;
}

// ---------- публикация из склада по слотам ----------

async function publishDueStock(env, now = new Date()) {
  const stock = await kv.getStock(env);
  const nowMs = now.getTime();
  const state = await kv.loadState(env);
  const dry = !!state.dry_run;
  const due = stock.filter((p) => (p.scheduled_for || 0) <= nowMs);
  // Дубли в stock возможны (тик умирал между addStock и commitSingle) —
  // один и тот же пакет (id) не должен выходить дважды: публикуем только
  // первую копию в очереди, остальные тихо выкидываем.
  const seenIds = new Set();
  for (const pkg of due) {
    if (seenIds.has(pkg.id)) {
      await kv.removeStock(env, pkg.id);
      continue;
    }
    seenIds.add(pkg.id);
    // Дайджест собран из свежих новостей прямо в окне (маркер digest_done) —
    // проверку свежести не применяем, окно не «переполняем» по cap: оно и есть
    // этот выпуск.
    if (pkg.kind === "digest") {
      // пусто
    } else if (pkg.kind === "news" && isStaleItem(pkg, nowMs)) {
      // новость протухла, пока ждала своего слота — выкидываем тихо
      await kv.removeStock(env, pkg.id);
      continue;
    }
    if (pkg.kind === "news" || pkg.kind === "digest") {
      const msk = mskNow(new Date(pkg.scheduled_for || now.getTime()));
      const win = await dynamicCurrentWindow(env, msk.minuteOfDay);
      if (win) {
        const used = await countInWindow(env, win, new Date(pkg.scheduled_for || now.getTime()));
        if (used >= win.cap) {
          // окно уже занято другим постом/выпуском — переносим в следующий слот
          const next = await nextFreeSlot(env, now);
          await kv.removeStock(env, pkg.id);
          await kv.addStock(env, { ...pkg, scheduled_for: next });
          continue;
        }
      }
    }
    // защита от дублей: если этот guid уже публиковался — пропускаем
    if (pkg.guid) {
      const log = await kv.getLog(env);
      if (log.some((e) => e.guid && e.guid === pkg.guid)) {
        await kv.removeStock(env, pkg.id);
        continue;
      }
    }
    // Свежая карточка в момент публикации: небо рисуется под реальное время
    // выхода поста (рендер-сервис считает МСК сам), а не под время генерации.
    // Формат — по настройке card_format (auto/gif/png); дайджест-обложка — PNG
    // и без плашки цитаты (обычные новости). Автопост из окна (no_rereder) уже
    // несёт готовую карточку — не тратим тяжёлый рендер ещё раз на тике.
    if (!dry && pkg.data && pkg.kind !== "event" && !pkg.no_rereder) {
      try {
        const fresh = await renderCardBytes(env, pkg.data, {
          link: pkg.link || "",
          source: pkg.source || "",
          format: pkg.kind === "digest" ? "png" : undefined,
          quote: pkg.kind === "digest" ? "" : undefined,
        });
        if (fresh && fresh.length > 100) pkg.png = fresh;
      } catch (e) {
        console.log("[scheduler] re-render card failed, keep old:", e.message);
      }
    }
    await kv.removeStock(env, pkg.id);
    try {
      if (pkg.kind === "event") {
        // ивенты — текстовый пост без карточки (создаются админом в диалоге)
        const text = (pkg.caption || pkg.title || "").trim();
        if (!text) continue;
        const ok = await publishText(env, text, dry, "event", {
          id: pkg.id,
          title: pkg.title || "",
          guid: pkg.guid || "",
          link: pkg.link || "",
        });
        if (ok) {
          await notifyAdmin(env, `🎪 <b>Ивент опубликован</b>: ${pkg.title || ""}`);
        } else {
          await kv.addStock(env, { ...pkg, scheduled_for: now.getTime() + 15 * 60 * 1000 });
        }
        continue;
      }
      const res = await publishPackage(env, pkg, dry);
      if (!dry) {
        // Строгий пул: если ушла только одна платформа — недостающая догоняется
        // ретраями, пишем об этом админу.
        const url = vkPostUrl(env, res.vkPost);
        const line = url ? `${pubStatus(res)} · ${url}` : pubStatus(res);
        if (res.tgOk && res.vkOk) {
          await notifyAdmin(env, `✅ <b>Опубликовано</b>: ${pkg.title || ""}\n${line}`);
        } else if (res.tgOk || res.vkOk) {
          const missing = res.tgOk ? "VK" : "TG";
          await notifyAdmin(env, `⏳ <b>Частично опубликовано</b>: ${pkg.title || ""}\n${line}\n🔜 Догоняю ${missing} в ближайшие тики.`);
        }
      }
    } catch (e) {
      console.log("[scheduler] publish failed:", e.message);
      await notifyAdmin(env, `❌ <b>Не удалось опубликовать</b>: ${pkg.title || ""}\n${escHtml(e.message)}`);
      await kv.addStock(env, { ...pkg, scheduled_for: now.getTime() + 15 * 60 * 1000 });
    }
  }
}

// ---------- сборка дайджестов по окнам ----------

// Свежих кандидатов на выпуск: не протухшие, свежайшие первыми, не больше
// DIGEST_MAX_ITEMS. Приоритет темам, которые сейчас лучше всего залетают у
// аудитории: вес темы-лидера (из статов) сдвигает кандидата вверх по свежести
// (1 балл веса ~ 45 минут), чтобы выпуск «делал подобные» успешным постам.
// Пусто -> дайджест не выйдет (кандидаты могли прийти позже в окне — маркер
// не ставим).
async function pickDigestItems(env, count) {
  const nowMs = Date.now();
  const list = ((await kv.getCandidates(env)) || []).filter((c) => !isStaleItem(c, nowMs));
  let topicBoost = null;
  try {
    const { getContentWeights } = await import("./stats.js");
    const cw = await getContentWeights(env);
    if (cw && cw.topic && Object.keys(cw.topic).length) topicBoost = cw.topic;
  } catch (e) { /* без буста тем */ }
  const boostOf = (c) => {
    if (!topicBoost) return 0;
    try {
      const t = mainTopic(String(c.title || "") + " " + String(c.text || c.excerpt || ""));
      if (t && topicBoost[t.id]) return topicBoost[t.id];
    } catch (e) { /* нет темы */ }
    return 0;
  };
  const scored = list.map((c) => ({ c, fresh: digestFreshScore(c), boost: boostOf(c) }));
  // Каждый балл веса темы ≈ 45 минут «свежести»: лидер темы обгоняет соседние
  // по времени, но не переворачивает выпуск для старых кандидатов.
  scored.sort((a, b) => (b.fresh + (b.boost || 0) * 45 * 60 * 1000) - (a.fresh + (a.boost || 0) * 45 * 60 * 1000));
  return scored.slice(0, count).map((x) => ({
    ...x.c,
    title: cleanRssTitle(x.c.title || ""),
  }));
}

// Собирает готовый пакет-дайджест из items (текст через LLM/правила + обложка).
// Ничего не публикует и не потребляет — только готовит. Возвращает pkg или null,
// если обложку не удалось собрать.
async function finalizeDigestPkg(env, items, opts) {
  const { label, slug, date, slot } = opts;
  const itemMeta = items.map((c) => ({
    guid: c.guid || "",
    title: String(c.title || "").replace(/\s+/g, " ").trim().slice(0, 120),
    link: c.link || "",
    source: sourceDomain(c.link || "") || c.source || "",
    text: String(c.text || "").replace(/\s+/g, " ").trim().slice(0, 800),
  }));

  const digestText = await generateDigestText(items, env, { label, slug, date });
  // Без живого LLM выпуск не собираем: фолбэк-правила дают сырые заголовки,
  // это мусор. Окно пропускается, кандидаты не тратятся.
  if (!digestText) return null;
  const { headline, caption, digest_text } = digestText;

  const data = {
    headline,
    headline_lines: [headline],
    caption,
    cards: [
      {
        type: "list",
        label: "В этом выпуске",
        items: itemMeta.map((m2) => m2.title || "Новость").slice(0, DIGEST_MAX_ITEMS),
      },
    ],
    tier: "news",
    source: "TrustNode",
    scheme_id: null,
    style_id: "digest",
    topic_id: "digest",
  };

  // Одна обложка на весь выпуск (рендер по данным пакета, пере-рисуется и в
  // момент публикации под реальное время суток). Всегда PNG — фото, а не файл;
  // без плашки цитаты (обычные новости).
  let b64 = "";
  try {
    const bytes = await renderCardBytes(env, data, { link: "", source: "TrustNode", format: "png", quote: "" });
    if (bytes && bytes.length > 100) b64 = bytesToBase64(bytes);
  } catch (e) {
    console.log("[scheduler] дайджест: обложку не собрали:", e.message);
  }
  if (!b64) {
    // Обложка обязательна (TG/VK постят картинку) — без неё выпуск не выйдет,
    // кандидатов не трогаем, окно попробуем собрать на следующем тике.
    return null;
  }

  return {
    pkg: {
      id: `dg${date.replace(/-/g, "")}${slug}`,
      kind: "digest",
      title: headline,
      caption,
      digest_text,
      png: b64,
      data,
      link: "",
      guid: `digest:${date}:${slug}`,
      source: "TrustNode",
      tags: [],
      items: itemMeta,
      scheduled_for: slot,
      created_at: new Date().toISOString(),
      from_admin: false,
      window_slug: slug,
    },
  };
}

// Собирает пакет-дайджест для активного окна. Возвращает { pkg, items }
// (items — выбранные свежие кандидаты) или null, если окно уже собрано
// (маркер) или нет свежих кандидатов.
async function buildDigestForWindow(env, win, now) {
  const msk = mskNow(now);
  const date = msk.date;
  if (await kv.getDigestDone(env, date, win.slug)) return null;

  const items = await pickDigestItems(env, DIGEST_MAX_ITEMS);
  if (!items.length) return null;
  const res = await finalizeDigestPkg(env, items, {
    label: win.label,
    slug: win.slug,
    date,
    slot: mskToUtcMs(msk.dow, win.start, now),
  });
  if (!res) return null;
  return { pkg: res.pkg, items };
}

// Потребляет собранных кандидатов и ставит маркер — дайджест выйдет один раз.
async function commitDigest(env, date, win, items) {
  const consumed = new Set(items.map((c) => c.guid));
  const rest = (await kv.getCandidates(env)).filter((c) => !consumed.has(c.guid));
  await kv.setCandidates(env, rest);
  await kv.setDigestDone(env, date, win.slug, { assembled_at: new Date().toISOString(), items: items.length });
}

// Автопостинг ВКЛ: собранный в активном окне дайджест ложится на склад и
// публикуется тем же тиком (slot уже наступил). Возвращает массив guid.
export async function assembleDigests(env, now = new Date()) {
  const msk = mskNow(now);
  const made = [];
  for (const w of await getWindows(env)) {
    if (msk.minuteOfDay < w.start || msk.minuteOfDay >= w.end) continue;
    const res = await buildDigestForWindow(env, w, now);
    if (!res) continue;
    await kv.addStock(env, res.pkg);
    await commitDigest(env, msk.date, w, res.items);
    made.push(res.pkg.guid);
    console.log("[scheduler] дайджест собран:", res.pkg.title, "→", new Date(res.pkg.scheduled_for).toISOString());
  }
  return made;
}

// Автопостинг ВЫКЛ: вместо публикации админу приходит дайджест-превью на
// одобрение (кнопки 🌐/🔵/🟢/🔄/❌). Обложка — с короткой подписью, полный
// разбор уходит отдельным сообщением.
async function sendDigestPreview(env, adminChat, pkg) {
  const bytes = decodePng(pkg.png);
  const sent = await sendCard(env, adminChat, bytes, pkg.caption, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: approveButtons(pkg.id) },
  });
  let digestMsgId = null;
  if (pkg.digest_text) {
    const msg = await sendMessage(env, adminChat, fitCaption(pkg.digest_text, 4096), { parse_mode: "HTML" });
    digestMsgId = msg && msg.message_id;
  }
  await kv.saveDraft(env, {
    id: pkg.id,
    kind: "digest",
    status: "pending",
    title: pkg.title,
    caption: pkg.caption,
    digest_text: pkg.digest_text,
    png: pkg.png,
    link: "",
    source: "TrustNode",
    guid: pkg.guid,
    items: pkg.items,
    admin_chat_id: adminChat,
    preview_message_id: sent && sent.message_id,
    digest_message_id: digestMsgId,
    created_at: new Date().toISOString(),
  });
}

export async function assembleDigestDrafts(env, now = new Date()) {
  const msk = mskNow(now);
  const adminChat = env.TELEGRAM_ADMIN_CHAT_ID;
  let sent = 0;
  for (const w of await getWindows(env)) {
    if (msk.minuteOfDay < w.start || msk.minuteOfDay >= w.end) continue;
    const res = await buildDigestForWindow(env, w, now);
    if (!res) continue;
    if (adminChat) await sendDigestPreview(env, adminChat, res.pkg);
    await commitDigest(env, msk.date, w, res.items);
    sent++;
    console.log("[scheduler] дайджест-превью админу:", res.pkg.title);
  }
  return sent;
}

// Тестовое превью (/digesttest): собирает дайджест из текущих кандидатов как
// будто наступило ближайшее окно и шлёт его админу. Кандидатов НЕ потребляет и
// маркер digest_done НЕ ставит. Возвращает { ok, reason?, title }.
export async function sendDigestTestPreview(env) {
  const msk = mskNow();
  const now = new Date();
  const wins = await getWindows(env);
  const win =
    wins.find((w) => msk.minuteOfDay >= w.start && msk.minuteOfDay < w.end) ||
    wins[0];

  const items = await pickDigestItems(env, DIGEST_MAX_ITEMS);
  if (!items.length) {
    return { ok: false, reason: "В очереди нет свежих кандидатов — запусти /rescan" };
  }

  const date = msk.date;
  const res = await finalizeDigestPkg(env, items, {
    label: win.label,
    slug: win.slug,
    date,
    slot: mskToUtcMs(0, win.start, now),
  });
  if (!res) return { ok: false, reason: "Обложку не удалось собрать" };

  const adminChat = env.TELEGRAM_ADMIN_CHAT_ID;
  if (adminChat) await sendDigestPreview(env, adminChat, res.pkg);
  return { ok: true, title: res.pkg.title };
}

// «Переделать» для дайджест-превью: кандидаты уже потреблены выпуском, поэтому
// пересобираем текст и обложку из компонентов сохранённого черновика (без
// повторного диспатча на GitHub) и шлём админу новое превью. Возвращает
// { ok: true } или { ok: false, reason }.
export async function rebuildDigestPreview(env, draft) {
  const slug = String(draft.id || "").replace(/^dg\d{8}/, "");
  const win = windowBySlug(slug);
  const date = String(draft.guid || "").split(":")[1] || "";
  if (!win || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, reason: "не распознан выпуск дайджеста" };
  }
  if (!Array.isArray(draft.items) || !draft.items.length) {
    return { ok: false, reason: "нет сохранённых новостей выпуска" };
  }

  const res = await finalizeDigestPkg(env, draft.items, {
    label: win.label,
    slug: win.slug,
    date,
    slot: mskToUtcMs(0, win.start, new Date()),
  });
  if (!res) return { ok: false, reason: "обложку не собрали" };

  const adminChat = draft.admin_chat_id || env.TELEGRAM_ADMIN_CHAT_ID;
  await kv.deleteDraft(env, draft.id);
  if (adminChat) await sendDigestPreview(env, adminChat, res.pkg);
  return { ok: true };
}

// ---------- главный тик ----------

export async function tick(env, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const started = Date.now();
  const marks = [];
  const mark = (name, from) => marks.push(`${name}=${Date.now() - from}ms`);
  let currentStep = "lock";

  const run = async () => {
    // Анти-перекрытие крон: Cloudflare не ждёт завершения предыдущего запуска,
    // если крон раз в 5 минут «не успевает». Два параллельных тика читают одну
    // и ту же очередь и могут опубликовать один пост дважды — KV-лок не даёт им
    // бежать одновременно (TTL страхует от зависшего тика).
    currentStep = "lock";
    try {
      if (env.BOT_KV) {
        const raw = await env.BOT_KV.get("scheduler_lock");
        let lock = null;
        try { lock = raw ? JSON.parse(raw) : null; } catch (e) { lock = null; }
        if (lock && Date.now() - lock.at < TICK_LOCK_TTL_MS) {
          return "busy";
        }
        await env.BOT_KV.put("scheduler_lock", JSON.stringify({ at: Date.now() }), {
          expirationTtl: Math.floor(TICK_LOCK_TTL_MS / 1000),
        });
      }
    } catch (e) {
      console.log("[scheduler] lock error:", e.message);
    }

    const state = await kv.loadState(env);

    // 1. скан (часть лент) + дедуп + кандидаты в очередь
    currentStep = "scan";
    let t = Date.now();
    const offset = state.meta.scan_chunk || 0;
    let scanFound = 0;
    try {
      scanFound = await bounded(SCAN_BUDGET_MS, "[scheduler] scan",
        scanFeeds(env, offset, CHUNK_COUNT).then((list) => list.length));
    } catch (e) {
      console.log("[scheduler] scan ошибка/превышен бюджет:", e.message);
    }
    state.meta.scan_chunk = (offset + 1) % CHUNK_COUNT;
    state.meta.last_scan = {
      at: new Date().toISOString(),
      chunk: offset,
      found: scanFound,
      took_ms: Date.now() - t,
    };
    mark("scan", t);

    // 2. накопление кандидатов и сборка одиночных постов по окнам.
    // Автопостинг ВКЛ: топ-1 свежая новость активного окна -> карточка на склад,
    // публикуется тем же тиком (слот уже наступил). ВЫКЛ: админу приходит превью
    // на одобрение. Многотемные дайджесты остались только в ручном режиме
    // (/digesttest, пересборка, approve).
    currentStep = "assemble";
    t = Date.now();
    try {
      const nowMs = now.getTime();
      // выкидываем протухшие кандидаты, чтобы они не ждали выпуска до лучших времён
      const candList = await kv.getCandidates(env);
      const freshCands = candList.filter((c) => !isStaleItem(c, nowMs));
      if (freshCands.length !== candList.length) await kv.setCandidates(env, freshCands);
      // Сборка поста не должна съедать остаток тика: у неё собственный бюджет.
      // При перерасходе кандидат не тратится — его подхватит следующий тик.
      if (await kv.getAutopost(env)) {
        await bounded(ASSEMBLE_BUDGET_MS, "[scheduler] assemble",
          assembleNewsPosts(env, now));
      } else {
        await bounded(ASSEMBLE_BUDGET_MS, "[scheduler] assemble",
          assembleNewsDrafts(env, now));
      }
    } catch (e) {
      console.log("[scheduler] assemble error:", e.message);
    }
    mark("assemble", t);

    // 5. авто-отложка черновиков (нет ответа админа 30 мин)
    currentStep = "defer";
    t = Date.now();
    try {
      await bounded(ASSEMBLE_BUDGET_MS, "[scheduler] defer", autoDeferDrafts(env, state, now));
    } catch (e) {
      console.log("[scheduler] defer error:", e.message);
    }
    mark("defer", t);

    // 6. публикация из склада
    currentStep = "publish";
    t = Date.now();
    try {
      await bounded(ASSEMBLE_BUDGET_MS, "[scheduler] publish", publishDueStock(env, now));
    } catch (e) {
      console.log("[scheduler] publish error:", e.message);
    }
    mark("publish", t);

    // 6b. догонка недостающей платформы (строгий пул VK/TG)
    currentStep = "vkretry";
    t = Date.now();
    try {
      await bounded(ASSEMBLE_BUDGET_MS, "[scheduler] vkretry", processVkRetries(env));
    } catch (e) {
      console.log("[scheduler] vk-retry error:", e.message);
    }
    mark("vkretry", t);

    currentStep = "save";
    t = Date.now();
    await kv.saveState(env, state);
    mark("save", t);

    console.log("[scheduler] tick:", marks.join(" "),
      `cands=${((await kv.getCandidates(env)) || []).length}`,
      `stock=${((await kv.getStock(env)) || []).length}`,
      `total=${Date.now() - started}ms`);
    return "ok";
  };

  // Хард-бюджет: даже если что-то внешнее зависло, тик обязан вернуться до
  // того, как free-план убьёт его молча. Возвращаем "timeout" с логом и
  // снимаем lock, чтобы следующий крон мог идти дальше.
  const TIMEOUT = Symbol("tick-timeout");
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), TICK_BUDGET_MS);
  });
  const result = await Promise.race([run(), timeoutPromise]);
  clearTimeout(timer);
  if (result === TIMEOUT) {
    console.log(`[scheduler] tick HARD BUDGET (${TICK_BUDGET_MS}ms) превышен на шаге "${currentStep}", lock снимаю`);
    try {
      if (env.BOT_KV) await env.BOT_KV.delete("scheduler_lock");
    } catch (e) { /* ignore */ }
    try {
      await notifyAdmin(env,
        `⚠️ <b>Тик не успел завершиться</b> (бюджет ${TICK_BUDGET_MS} мс, шаг «${currentStep}»).\n` +
        `Слотов/публикаций сегодня может не быть — следите за логами (<code>wrangler tail</code>).`);
    } catch (e) { /* ignore */ }
    return "timeout";
  }
  return result;
}
