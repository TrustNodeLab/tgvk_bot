// РџР»Р°РЅРёСЂРѕРІС‰РёРє: РєР°Р¶РґС‹Р№ РєСЂРѕРЅ РІС‹РїРѕР»РЅСЏРµС‚ РїРѕР»РЅС‹Р№ С†РёРєР» вЂ”
// СЃРєР°РЅ+РґРµРґСѓРї -> РЅР°РєРѕРїР»РµРЅРёРµ РєР°РЅРґРёРґР°С‚РѕРІ -> РїСѓР±Р»РёРєР°С†РёСЏ РїРѕ РѕРєРЅР°Рј
// (СѓС‚СЂРѕ/РґРµРЅСЊ/РІРµС‡РµСЂ: 1 РЅРѕРІРѕСЃС‚СЊ = 1 РїРѕСЃС‚) -> Р°РІС‚Рѕ-РѕС‚Р»РѕР¶РєР° С‡РµСЂРЅРѕРІРёРєРѕРІ ->
// РїСѓР±Р»РёРєР°С†РёСЏ РёР· В«СЃРєР»Р°РґР°В» РїРѕ СЃР»РѕС‚Р°Рј -> РґРѕРіРѕРЅРєР° РЅРµРґРѕСЃС‚Р°СЋС‰РµР№ РїР»Р°С‚С„РѕСЂРјС‹.

import {
  NEWS_WINDOWS,
  DIGEST_MAX_ITEMS,
  EKB_OFFSET_MIN,
  DRAFT_TIMEOUT_MIN, ekbNow, isStaleItem, cleanRssTitle,
} from "./config.js";
import * as kv from "./kv.js";
import { scanFeeds } from "./feeds.js";
import { mainTopic, analyzePost } from "./nlp.js";
import { renderCard } from "./cardgen.js";
import { renderCardBytes, sourceDomain, approveButtons } from "./preview.js";
import { generateDigestText, digestFreshScore, generatePostData, generateByRules } from "./llm.js";
import { getWindows, windowBySlug, currentWindow as schedCurrentWindow } from "./schedule.js";
import {
  publishToTelegram, publishToVk, sendMessage, vkCall, sendCard,
} from "./telegram.js";
import { sendPoll } from "./telegram.js";
import { fmtTime, escHtml, fitCaption, htmlToPlain } from "./text.js";
import { collectEngagement, maybeHealthAlert, maybeBackupToGitHub } from "./ops.js";
import { multigroupTick } from "./multigroup.js";

const CHUNK_COUNT = 4; // скан дробится на 4 части — за тик опрашиваем ~9 лент, чтобы уложиться в бюджет
const TICK_LOCK_TTL_MS = 4 * 60 * 1000; // Р°РЅС‚Рё-РїРµСЂРµРєСЂС‹С‚РёРµ РєСЂРѕРЅ: Р±РѕР»СЊС€Рµ TTL, С‡РµРј РєСЂРѕРЅ (5 РјРёРЅ) Р±С‹ Р·Р°СЃС‚Р°РІРёР»Рѕ РїСЂРѕРїСѓСЃРєР°С‚СЊ РєР°Р¶РґС‹Р№ РІС‚РѕСЂРѕР№ Р·Р°РїСѓСЃРє.
const OPS_BUDGET_MS = 20 * 1000; // Р±СЋРґР¶РµС‚ РѕРїРµСЂР°С†РёРѕРЅРЅС‹С… РґРѕРіРѕРЅСЏР»РѕРє (engagement/health/backup)

// РҐР°СЂРґ-Р±СЋРґР¶РµС‚ С‚РёРєР°. Free-РїР»Р°РЅ Cloudflare РґСѓС€РёС‚ С‚СЏР¶С‘Р»С‹Рµ РєСЂРѕРЅ-Р·Р°РїСѓСЃРєРё: С‚РёРє,
// РєРѕС‚РѕСЂС‹Р№ РЅРµ СѓСЃРїРµР» Р·Р°РІРµСЂС€РёС‚СЊСЃСЏ Р·Р° РѕС‚РІРµРґС‘РЅРЅС‹Р№ wall-clock Р»РёРјРёС‚, В«РјРѕР»С‡Р°В» СѓР±РёРІР°РµС‚СЃСЏ
// (РІ tail вЂ” РЅРѕР»СЊ Р»РѕРіРѕРІ Рё exceededCpu). РџРѕСЌС‚РѕРјСѓ РєР°Р¶РґС‹Р№ С‚РёРє Р¶С‘СЃС‚РєРѕ Р·Р°СЃС‚СЂР°С…РѕРІР°РЅ
// РІРѕР·РІСЂР°С‚РѕРј "timeout" СЃ РіСЂРѕРјРєРёРј Р»РѕРіРѕРј, Р° С‚СЏР¶С‘Р»С‹Рµ С€Р°РіРё (LLM/СЂРµРЅРґРµСЂ) РїРѕР»СѓС‡Р°СЋС‚ СЃРІРѕРё
// РєРѕСЂРѕС‚РєРёРµ Р±СЋРґР¶РµС‚С‹ СЃ С„РѕР»Р±СЌРєРѕРј РЅР° РїСЂР°РІРёР»Р° / JS-СЂРµРЅРґРµСЂ, С‡С‚РѕР±С‹ С‚РёРє РїРѕС‡С‚Рё РІСЃРµРіРґР°
// СѓРєР»Р°РґС‹РІР°Р»СЃСЏ РІ Р±СЋРґР¶РµС‚ Рё В«РЅРµ РґРѕР¶РёРјР°Р»СЃСЏВ» С‚Р°Рј.
const TICK_BUDGET_MS = 28000;
const LLM_BUDGET_MS = 4000;
const RENDER_BUDGET_MS = 4000;
const DIGEST_BUDGET_MS = 4000;
const SCAN_BUDGET_MS = 8000;
const ASSEMBLE_BUDGET_MS = 13000;
// Мультигрупповой шаг: скачивание арта + JPEG-декод + GIF + загрузка в VK +
// wall.post. Даём слабый бюджет — обычно всё укладывается в 8-10 с; при
// переборе окно просто пропускается (идемпотентность слота на следующем тике).
const MULTIGROUP_BUDGET_MS = 12000;

// Р—Р°РїСѓСЃРєР°РµС‚ promise СЃ Р¶С‘СЃС‚РєРёРј Р±СЋРґР¶РµС‚РѕРј: РїРѕ РёСЃС‚РµС‡РµРЅРёРё ms СЂРµРґР¶РµРєС‚РёС‚ (РїСЂРѕРјРёСЃ РїСЂРё
// СЌС‚РѕРј РїСЂРѕРґРѕР»Р¶Р°РµС‚ Р¶РёС‚СЊ РІ С„РѕРЅРµ, РЅРѕ СЂРµР·СѓР»СЊС‚Р°С‚ СѓР¶Рµ РЅРёРєРѕРјСѓ РЅРµ РЅСѓР¶РµРЅ вЂ” С‚РёРє РЅРµ Р¶РґС‘С‚).
function bounded(ms, label, promise) {
  let timer;
  return new Promise((resolve, reject) => {
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
    timer = setTimeout(() => {
      reject(new Error(`${label} РїСЂРµРІС‹СЃРёР» Р±СЋРґР¶РµС‚ ${ms}ms`));
    }, ms);
  });
}

// png РІ С‡РµСЂРЅРѕРІРёРєРµ С…СЂР°РЅРёС‚СЃСЏ base64 (KV СѓРјРµРµС‚ С‚РѕР»СЊРєРѕ СЃС‚СЂРѕРєРё) вЂ” РїСЂРµРІСЂР°С‰Р°РµРј РІ Р±Р°Р№С‚С‹.
function decodePng(b64) {
  if (!b64) return null;
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// Р‘Р°Р№С‚С‹ РєР°СЂС‚РѕС‡РєРё -> base64 РґР»СЏ С…СЂР°РЅРµРЅРёСЏ РІ KV.
function bytesToBase64(bytes) {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

// РЈРІРµРґРѕРјР»РµРЅРёРµ Р°РґРјРёРЅСѓ РІ Telegram Рѕ СЂРµР·СѓР»СЊС‚Р°С‚Рµ РїСѓР±Р»РёРєР°С†РёРё. РћС€РёР±РєР° РѕС‚РїСЂР°РІРєРё РЅРµ
// СЂРѕРЅСЏРµС‚ РїСѓР±Р»РёРєР°С†РёСЋ вЂ” СѓРІРµРґРѕРјР»РµРЅРёРµ РЅРµРєСЂРёС‚РёС‡РЅРѕ.
async function notifyAdmin(env, text) {
  if (!env.TELEGRAM_ADMIN_CHAT_ID) return;
  try {
    await sendMessage(env, env.TELEGRAM_ADMIN_CHAT_ID, text, { parse_mode: "HTML" });
  } catch (e) { /* ignore */ }
}

function vkPostUrl(env, postId) {
  return postId && env.VK_GROUP_ID ? `https://vk.com/wall-${env.VK_GROUP_ID}_${postId}` : null;
}

// РЎС‚Р°С‚СѓСЃРЅР°СЏ СЃС‚СЂРѕРєР° РїРѕ СЂРµР·СѓР»СЊС‚Р°С‚Р°Рј РїСѓР±Р»РёРєР°С†РёРё РІ РѕР±Рµ РїР»Р°С‚С„РѕСЂРјС‹.
function pubStatus(res) {
  const parts = [];
  parts.push(res.tgOk ? "рџџў TG вњ“" : "TG вњ—");
  parts.push(res.vkOk ? "рџ”µ VK вњ“" : "VK вњ—");
  return parts.join(" В· ");
}

// ---------- РІСЂРµРјСЏ Рё СЃР»РѕС‚С‹ ----------

export function ekbToUtcMs(dow, minuteOfDay, now = new Date()) {
  // Р±Р»РёР¶Р°Р№С€РµРµ РЅР°СЃС‚СѓРїР»РµРЅРёРµ dow (0=РїРЅ) РІ minuteOfDay РІ Р•РљР‘ -> epoch ms
  const ekb = new Date(now.getTime() + EKB_OFFSET_MIN * 60 * 1000);
  const todayDow = (ekb.getUTCDay() + 6) % 7;
  let delta = (dow - todayDow + 7) % 7;
  let y = ekb.getUTCFullYear();
  let m = ekb.getUTCMonth();
  let d = ekb.getUTCDate();
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
  const utcMinute = minuteOfDay - EKB_OFFSET_MIN;
  return Date.UTC(y, m, d, Math.floor(utcMinute / 60), utcMinute % 60) - (0);
}

export function currentWindow(minuteOfDay) {
  return NEWS_WINDOWS.find((w) => minuteOfDay >= w.start && minuteOfDay < w.end) || null;
}

// РўРµРєСѓС‰РµРµ РѕРєРЅРѕ РїРѕ РґРёРЅР°РјРёС‡РµСЃРєРѕРјСѓ СЂР°СЃРїРёСЃР°РЅРёСЋ (СЃРј. lib/schedule.js).
export async function dynamicCurrentWindow(env, minuteOfDay) {
  return schedCurrentWindow(env, minuteOfDay);
}

// РЎРєРѕР»СЊРєРѕ РЅРѕРІРѕСЃС‚РµР№/РґР°Р№РґР¶РµСЃС‚РѕРІ СѓР¶Рµ РѕРїСѓР±Р»РёРєРѕРІР°РЅРѕ РІ СЌС‚РѕРј РѕРєРЅРµ СЃРµРіРѕРґРЅСЏ. Р”Р°Р№РґР¶РµСЃС‚ Рё
// РѕРґРёРЅРѕС‡РЅР°СЏ РЅРѕРІРѕСЃС‚СЊ Р·Р°РЅРёРјР°СЋС‚ В«РІРјРµСЃС‚РёРјРѕСЃС‚СЊВ» РѕРєРЅР° РѕРґРёРЅР°РєРѕРІРѕ (cap=1 Р·Р° РѕРєРЅРѕ).
async function countInWindow(env, win, now) {
  const log = await kv.getLog(env);
  const ekb = ekbNow(now);
  return log.filter((e) => {
    const k = e.kind;
    if (k && k !== "news" && k !== "digest") return false;
    const t = new Date(e.published_at);
    if (Number.isNaN(t.getTime())) return false;
    const em = ekbNow(t);
    if (em.date !== ekb.date) return false;
    return em.minuteOfDay >= win.start && em.minuteOfDay < win.end;
  }).length;
}

// РЎР»РµРґСѓСЋС‰РёР№ СЃРІРѕР±РѕРґРЅС‹Р№ СЃР»РѕС‚ РґР»СЏ РїРѕСЃС‚Р° (epoch ms).
// РЎС‚СЂРѕРіРѕРµ СЂР°СЃРїРёСЃР°РЅРёРµ: РѕРґРёРЅ РїРѕСЃС‚ РІ РЅР°С‡Р°Р»Рµ РѕРєРЅР°. РћРєРЅР° РїРѕ СѓРјРѕР»С‡Р°РЅРёСЋ вЂ” РґР°Р№РґР¶РµСЃС‚С‹
// 3-5 РЅРѕРІРѕСЃС‚РµР№: 09:00, 13:00, 18:00 РњРЎРљ. РђРґР°РїС‚РёРІРЅРѕРµ СЂР°СЃРїРёСЃР°РЅРёРµ (lib/schedule.js)
// РјРѕР¶РµС‚ РґРѕР±Р°РІРёС‚СЊ РёР»Рё СѓР±СЂР°С‚СЊ СЃР»РѕС‚С‹ РїРѕ РѕС…РІР°С‚Р°Рј вЂ” Р·РґРµСЃСЊ СѓС‡РёС‚С‹РІР°СЋС‚СЃСЏ РґРёРЅР°РјРёС‡РµСЃРєРёРµ
// РѕРєРЅР°. Р‘РµР· СЂР°РЅРґРѕРјР° РІРЅСѓС‚СЂРё РѕРєРЅР°.
export async function nextFreeSlot(env, now = new Date()) {
  const nowMs = now.getTime();
  const wins = await getWindows(env);
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const t = new Date(nowMs + dayOffset * 86400000);
    const m2 = ekbNow(t);
    for (const w of wins) {
      const slot = ekbToUtcMs(m2.dow, w.start, new Date(t));
      if (slot < nowMs) continue; // СЃР»РѕС‚ СѓР¶Рµ РїСЂРѕС€С‘Р»
      const used = await countInWindow(env, w, new Date(slot));
      if (used < w.cap) return slot;
    }
  }
  return nowMs + 3600 * 1000;
}

// ---------- РґРёСЃРїР°С‚С‡ РєР°РЅРґРёРґР°С‚РѕРІ РЅР° РїРѕРґРіРѕС‚РѕРІРєСѓ (GitHub Actions) ----------

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

// ---------- РїСѓР±Р»РёРєР°С†РёСЏ ----------

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
    // РЎС‚СЂРѕРіРёР№ РїСѓР» VK/TG: Р°РІС‚Рѕ-РїРѕСЃС‚ РґРѕР»Р¶РµРЅ СѓР№С‚Рё РІ РѕР±Рµ РїР»Р°С‚С„РѕСЂРјС‹. Р•СЃР»Рё СѓС€Р»Р°
    // С‚РѕР»СЊРєРѕ РѕРґРЅР° вЂ” РЅРµРґРѕСЃС‚Р°СЋС‰СѓСЋ РґРѕРіРѕРЅСЏРµРј СЂРµС‚СЂР°СЏРјРё РЅР° СЃР»РµРґСѓСЋС‰РёС… С‚РёРєР°С…, Р° РІ Р»РѕРі
    // РїРёС€РµРј С‡Р°СЃС‚РёС‡РЅС‹Р№ СЃС‚Р°С‚СѓСЃ (РѕРЅ Р¶Рµ вЂ” РёСЃС‚РѕС‡РЅРёРє РїСЂР°РІРґС‹ РїРѕ РєРѕР»РёС‡РµСЃС‚РІСѓ РїРѕСЃС‚РѕРІ).
    if (mode === "all" && tgOk !== vkOk && !dry) {
      await kv.addVkRetry(env, { ...pkg, attempts: 0 }, { missing: [tgOk ? "vk" : "tg"] });
    }
    if (!tgOk && !vkOk) {
      throw new Error(`publish failed tg=[${tgErr}] vk=[${vkErr}]`);
    }
    // Слот окна (по факту публикации, не по расписанию): слагаем метрики по
    // временным окнам для расширенной аналитики и AI-расписания.
    const pubEkb = ekbNow();
    const pubWin = await schedCurrentWindow(env, pubEkb.minuteOfDay);
    await kv.addLog(env, {
      id: pkg.id,
      kind: pkg.kind || "news",
      title: pkg.title || "",
      guid: pkg.guid || "",
      link: pkg.link || "",
      tags: pkg.tags || [],
      source: pkg.source || "",
      published_at: new Date().toISOString(),
      ekb_hour: pubEkb.hour,
      ekb_minute: pubEkb.minuteOfDay,
      window_slug: (pubWin && pubWin.slug) || "off",
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
      // РђС‚СЂРёР±СѓС‚С‹ РґР»СЏ СЃС‚Р°С‚РёСЃС‚РёРєРё: СЃС…РµРјР° РјРѕС€РµРЅРЅРёС‡РµСЃС‚РІР° / Р¶Р°РЅСЂ / С‚РµРјР° / РїСЂРѕРІР°Р№РґРµСЂ.
      scheme_id: (pkg.data && pkg.data.scheme_id) || pkg.scheme_id || null,
      style_id: (pkg.data && pkg.data.style_id) || pkg.style_id || null,
      topic_id: (pkg.data && pkg.data.topic_id) || pkg.topic_id || null,
      llm_provider: (pkg.data && pkg.data.llm_provider) || pkg.llm_provider || null,
      // РљРѕРЅС‚РµРєСЃС‚ РґР»СЏ СЃР»РµРґСѓСЋС‰РµРіРѕ РїРѕСЃС‚Р°: СЃРµС‚РєР° Рё С‚РёРїС‹ РєР°СЂС‚РѕС‡РµРє РїСЂРµРґС‹РґСѓС‰РµРіРѕ,
      // С‡С‚РѕР±С‹ LLM РЅРµ РїРѕРІС‚РѕСЂСЏР» layout Рё РЅРµ РєР»РµРёР» РїРѕРґСЂСЏРґ РѕРґРёРЅР°РєРѕРІС‹Рµ РїРѕСЃС‚С‹.
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

// РџСѓР±Р»РёРєР°С†РёСЏ С‚РµРєСЃС‚РѕРІРѕРіРѕ РїРѕСЃС‚Р° (РёРІРµРЅС‚С‹ Р±РµР· РєР°СЂС‚РѕС‡РєРё).
export async function publishText(env, text, dry, kind, extra = {}) {
  let tgOk = false;
  let vkOk = false;
  let tgErr = null;
  let vkErr = null;
  if (dry) {
    console.log(`[dry-run] TG text -> ${env.TELEGRAM_CHANNEL_ID} (${text.length} СЃРёРјРІ.)`);
    tgOk = true;
  } else {
    try {
      await sendMessage(env, env.TELEGRAM_CHANNEL_ID, text, { parse_mode: "HTML" });
      tgOk = true;
    } catch (e) { tgErr = e.message; }
  }
  const plain = htmlToPlain(text);
  if (dry) {
    console.log(`[dry-run] VK wall.post text (${plain.length} СЃРёРјРІ.)`);
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

// ---------- СЂРµС‚СЂР°Рё: РґРѕРіРѕРЅРєР° РЅРµРґРѕСЃС‚Р°СЋС‰РµР№ РїР»Р°С‚С„РѕСЂРјС‹ (СЃС‚СЂРѕРіРёР№ РїСѓР» VK/TG) ----------

// РќР° РєР°Р¶РґРѕРј С‚РёРєРµ РїСЂРѕР±СѓРµРј РґРѕРіСЂСѓР·РёС‚СЊ РІ РЅРµРґРѕСЃС‚Р°СЋС‰СѓСЋ РїР»Р°С‚С„РѕСЂРјСѓ РїРѕСЃС‚С‹, РєРѕС‚РѕСЂС‹Рµ РЅРµ
// СѓС€Р»Рё СЃ РїРµСЂРІРѕР№ РїРѕРїС‹С‚РєРё (missing = ["vk"] | ["tg"]). РљРѕРіРґР° РѕР±Рµ РїР»Р°С‚С„РѕСЂРјС‹
// РѕРїСѓР±Р»РёРєРѕРІР°РЅС‹ вЂ” РѕР±РЅРѕРІР»СЏРµРј СЃСѓС‰РµСЃС‚РІСѓСЋС‰СѓСЋ Р·Р°РїРёСЃСЊ publish_log (РѕРґРЅР° Р·Р°РїРёСЃСЊ РЅР° РїРѕСЃС‚,
// СЃРѕ СЃС‚Р°С‚СѓСЃРѕРј РѕР±РµРёС…). РќРµСѓРґР°С‡Р° -> РІРѕР·РІСЂР°С‚ РІ РѕС‡РµСЂРµРґСЊ СЃ СЂРѕСЃС‚РѕРј СЃС‡С‘С‚С‡РёРєР°; РїСЂРµРІС‹С€РµРЅРёРµ
// Р»РёРјРёС‚Р° РёР»Рё РІС‹С…РѕРґ РёР· РѕРєРЅР° СЃРІРµР¶РµСЃС‚Рё -> РѕСЃС‚Р°РІР»СЏРµРј С‡Р°СЃС‚РёС‡РЅС‹Р№ СЃС‚Р°С‚СѓСЃ РІ Р»РѕРіРµ.
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
      console.log(`[vk-retry] РѕС‚РєР°Р· РїРѕСЃР»Рµ ${item.attempts} РїРѕРїС‹С‚РѕРє: ${item.title || item.id}`);
      await kv.removeVkRetry(env, item.id);
      processed++;
      continue;
    }
    // РЅРѕРІРѕСЃС‚СЊ РїСЂРѕС‚СѓС…Р»Р°, РїРѕРєР° Р¶РґР°Р»Р° РґРѕРіРѕРЅРєРё вЂ” РЅРµ РїСѓР±Р»РёРєСѓРµРј
    if (isStaleItem(item, nowMs)) {
      console.log(`[vk-retry] РїСЂРѕС‚СѓС…Р»Р°, СѓРґР°Р»СЏСЋ: ${item.title || item.id}`);
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
          if (!vkr || !vkr.post_id) throw new Error("РЅРµС‚ post_id РїРѕСЃР»Рµ СѓСЃРїРµС€РЅРѕРіРѕ upload");
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
      console.log(`[vk-retry] РѕРїСѓР±Р»РёРєРѕРІР°РЅРѕ РІ РѕР±Рµ РїР»Р°С‚С„РѕСЂРјС‹ (РїРѕРїС‹С‚РєР° ${item.attempts}): ${item.title || item.id}`);
      const url = vkPostUrl(env, vkPost);
      if (!dry) {
        await notifyAdmin(
          env,
          `вњ… <b>Р”РѕРіРЅР°РЅРѕ</b>: ${item.title || item.id}\n${pubStatus({ tgOk: true, vkOk: true })}${url ? ` В· ${url}` : ""}`
        );
      }
    } else {
      console.log(`[vk-retry] РїРѕРїС‹С‚РєР° ${item.attempts} РЅРµ СѓРґР°Р»Р°СЃСЊ РґР»СЏ В«${item.title || item.id}В»: ${tgErr || vkErr}`);
      await kv.removeVkRetry(env, item.id);
      await kv.addVkRetry(env, { ...item, attempts: item.attempts, missing });
      processed++;
    }
  }
  return { processed };
}

// ---------- С‡РµСЂРЅРѕРІРёРєРё ----------

// Ставит черновик на склад как отложенный пост. Используется и при авто-таймауте
// (нет ответа админа 30 минут), и при промоушене «отложенных» (кнопка 🕓).
async function promoteDraftToStock(env, d, slot) {
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
}

async function autoDeferDrafts(env, state, now = new Date()) {
  const drafts = await kv.listDrafts(env);
  const deadline = now.getTime() - DRAFT_TIMEOUT_MIN * 60 * 1000;
  for (const d of drafts) {
    // Отложенные админом (кнопка 🕓): публикуем, когда наступил их слот.
    if (d.status === "deferred") {
      if (!d.deferred_until) {
        d.status = "pending";
        delete d.deferred_until;
        await kv.saveDraft(env, d);
        continue;
      }
      if (now.getTime() < new Date(d.deferred_until).getTime()) continue;
      await promoteDraftToStock(env, d, new Date(d.deferred_until).getTime());
      const when = fmtTime(new Date(d.deferred_until).toISOString());
      try {
        await sendMessage(
          env,
          env.TELEGRAM_ADMIN_CHAT_ID,
          `🕓 <b>Отложенный пост «${escHtml(d.title || "")}» встал в слот</b> ${when}.`,
          { parse_mode: "HTML" }
        );
      } catch (e) { /* ignore */ }
      continue;
    }
    if (d.status && d.status !== "pending") continue;
    // Р§РµСЂРЅРѕРІРёРєРё РѕС‚ GitHub РїСЂРёС…РѕРґСЏС‚ Р±РµР· created_at вЂ” С‚Р°Р№РјРµСЂ 30 РјРёРЅСѓС‚ СЃС‚Р°СЂС‚СѓРµС‚
    // СЃ РјРѕРјРµРЅС‚Р°, РєРѕРіРґР° Worker РІРїРµСЂРІС‹Рµ СѓРІРёРґРµР» С‡РµСЂРЅРѕРІРёРє.
    if (!d.created_at) {
      d.created_at = now.toISOString();
      await kv.saveDraft(env, d);
      continue;
    }
    const created = new Date(d.created_at).getTime();
    if (created > deadline) continue;
    // РЅРѕРІРѕСЃС‚СЊ РїСЂРѕС‚СѓС…Р»Р°, РїРѕРєР° Р¶РґР°Р»Р° РѕС‚РІРµС‚Р° Р°РґРјРёРЅР° вЂ” С‡РµСЂРЅРѕРІРёРє С‚РёС…Рѕ СѓРґР°Р»СЏРµРј
    if (isStaleItem(d, now.getTime())) {
      await kv.deleteDraft(env, d.id);
      continue;
    }
    // Р°РґРјРёРЅ РЅРµ РѕС‚РІРµС‚РёР» Р·Р° 30 РјРёРЅСѓС‚ -> РѕС‚Р»РѕР¶РµРЅРЅС‹Р№ РїРѕСЃС‚ РІ Р±Р»РёР¶Р°Р№С€РёР№ СЃРІРѕР±РѕРґРЅС‹Р№ СЃР»РѕС‚
    const slot = await nextFreeSlot(env, now);
    await promoteDraftToStock(env, d, slot);
    const when = fmtTime(new Date(slot).toISOString());
    try {
      await sendMessage(
        env,
        env.TELEGRAM_ADMIN_CHAT_ID,
        `вЏі <b>РќРµ РїРѕР»СѓС‡РёР» РѕС‚РІРµС‚ Р·Р° ${DRAFT_TIMEOUT_MIN} РјРёРЅСѓС‚</b> вЂ” РїРѕСЃС‚ В«${d.title || ""}В» РїРѕСЃС‚Р°РІР»РµРЅ РІ РѕС‚Р»РѕР¶РµРЅРЅС‹Рµ РЅР° СЃР»РѕС‚ ${when}.`,
        { parse_mode: "HTML" }
      );
    } catch (e) { /* ignore */ }
  }
}

// ---------- РѕРґРёРЅРѕС‡РЅС‹Рµ РЅРѕРІРѕСЃС‚Рё РїРѕ РѕРєРЅР°Рј (1 РЅРѕРІРѕСЃС‚СЊ = 1 РїРѕСЃС‚) ----------

// РўРѕРї-1 СЃРІРµР¶Р°Р№С€РёР№ РєР°РЅРґРёРґР°С‚ РґР»СЏ РѕРґРёРЅРѕС‡РЅРѕРіРѕ РїРѕСЃС‚Р° (pickDigestItems(1) СѓР¶Рµ СЃРґРµР»Р°Р»
// СЃРѕСЂС‚РёСЂРѕРІРєСѓ РїРѕ СЃРІРµР¶РµСЃС‚Рё + Р±СѓСЃС‚ С‚РµРјС‹). РџСѓСЃС‚Рѕ вЂ” РЅРѕРІРѕСЃС‚СЊ РЅРµ РІС‹Р№РґРµС‚.
async function pickSingleItem(env) {
  const pool = await pickDigestItems(env, 8);
  if (!pool.length) return null;
  const ranked = await preferWeights(env, pool);
  return (ranked && ranked.length ? ranked[0] : null) || pool[0];
}

// A/B-ротация контента: пул свежайших кандидатов рескорим весами вовлечённости.
// Если победа новейшего кандидата «щадящая» (отрыв < 30 мин) и у лидера темы
// есть положительный вес (тема собирала стабильную вовлечённость в прошлом),
// тема-лидер перепрыгивает вперёд. Без весов/данных порядок не меняется.
async function preferWeights(env, pool) {
  let cw = null;
  try {
    const { getContentWeights } = await import("./stats.js");
    cw = await getContentWeights(env);
  } catch (e) { /* без весов ротации */ }
  const topicW = cw && cw.topic ? cw.topic : {};
  const hasTopics = Object.keys(topicW).some((k) => topicW[k] > 1.05);
  if (!hasTopics) return pool;

  const ranked = pool
    .map((c) => {
      let t = null;
      try {
        t = mainTopic(String(c.title || "") + " " + String(c.text || ""));
      } catch (e) { /* без темы */ }
      const w = t && topicW[t.id] ? topicW[t.id] : 0;
      return { c, fresh: digestFreshScore(c), w };
    })
    .sort((a, b) => b.fresh - a.fresh);

  const lead = ranked[0];
  const gapMs = Math.max(0, lead.fresh - (ranked[1] ? ranked[1].fresh : lead.fresh));
  if (gapMs < 30 * 60 * 1000) {
    // Отрыв меньше «щадящего» — даём весу темы право переставить лидера.
    ranked.sort((a, b) => (b.fresh + b.w * 45 * 60 * 1000) - (a.fresh + a.w * 45 * 60 * 1000));
  }
  return ranked.map((x) => x.c);
}

// Р‘СЋРґР¶РµС‚РЅР°СЏ СЃР±РѕСЂРєР° РєР°СЂС‚РѕС‡РєРё: С‚РµРєСЃС‚ С‡РµСЂРµР· LLM (РёР»Рё РїСЂР°РІРёР»Р° РїСЂРё РЅРµРґРѕСЃС‚СѓРїРЅРѕСЃС‚Рё/
// РїРµСЂРµСЂР°СЃС…РѕРґРµ Р±СЋРґР¶РµС‚Р°), РєР°СЂС‚РёРЅРєР° С‡РµСЂРµР· СЂРµРЅРґРµСЂ-СЃРµСЂРІРёСЃ (РёР»Рё JS-С„РѕР»Р±СЌРє). РќРёС‡РµРіРѕ
// РЅРµ РїСѓР±Р»РёРєСѓРµС‚ Рё РЅРµ РїРѕС‚СЂРµР±Р»СЏРµС‚ вЂ” С‚РѕР»СЊРєРѕ РіРѕС‚РѕРІРёС‚. Р’РѕР·РІСЂР°С‰Р°РµС‚ pkg РёР»Рё null.
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
    console.log("[scheduler] LLM РїСЂРµРІС‹СЃРёР» Р±СЋРґР¶РµС‚, РёСЃРїРѕР»СЊР·СѓСЋ РїСЂР°РІРёР»Р°:", e.message);
  }
  if (!data) data = generateByRules(src, { link, source });

  let b64 = "";
  try {
    const bytes = await bounded(RENDER_BUDGET_MS, "[scheduler] render",
      renderCardBytes(env, data, { link, source }));
    if (bytes && bytes.length > 100) b64 = bytesToBase64(bytes);
  } catch (e) {
    console.log("[scheduler] СЂРµРЅРґРµСЂ РїСЂРµРІС‹СЃРёР» Р±СЋРґР¶РµС‚, JS-С„РѕР»Р±СЌРє:", e.message);
  }
  if (!b64) {
    try {
      const bytes = await renderCard(data, { format: "png" });
      if (bytes && bytes.length > 100) b64 = bytesToBase64(bytes);
    } catch (e) {
      console.log("[scheduler] JS-СЂРµРЅРґРµСЂ РЅРµ СЃСЂР°Р±РѕС‚Р°Р»:", e.message);
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

// РђРІС‚РѕРїРѕСЃС‚С‹ Р’РљР›: С‚РѕРї-1 РєР°РЅРґРёРґР°С‚ Р°РєС‚РёРІРЅРѕРіРѕ РѕРєРЅР° -> РѕРґРёРЅРѕС‡РЅС‹Р№ РїРѕСЃС‚ РЅР° СЃРєР»Р°Рґ.
// РћРєРЅРѕ Р·Р°РЅРёРјР°РµС‚СЃСЏ РјР°СЂРєРµСЂРѕРј вЂ” РІС‚РѕСЂРѕР№ РїРѕСЃС‚ РІ С‚Рѕ Р¶Рµ РѕРєРЅРѕ РЅРµ СЃРѕР±РёСЂР°РµС‚СЃСЏ.
export async function assembleNewsPosts(env, now = new Date()) {
  const ekb = ekbNow(now);
  const made = [];
  for (const w of await getWindows(env)) {
    if (ekb.minuteOfDay < w.start || ekb.minuteOfDay >= w.end) continue;
    if (await kv.getDigestDone(env, ekb.date, w.slug)) continue;
    const cand = await pickSingleItem(env);
    if (!cand) continue;
    const res = await finalizeNewsPkg(env, cand, {
      slug: w.slug,
      date: ekb.date,
      slot: ekbToUtcMs(ekb.dow, w.start, now),
    });
    if (!res) continue;
    await kv.addStock(env, res.pkg);
    await commitSingle(env, ekb.date, w.slug, cand);
    made.push(res.pkg.guid);
    console.log("[scheduler] РѕРґРёРЅРѕС‡РЅР°СЏ РЅРѕРІРѕСЃС‚СЊ СЃРѕР±СЂР°РЅР°:", res.pkg.title, "в†’", new Date(res.pkg.scheduled_for).toISOString());
  }
  return made;
}

// РџРѕС‚СЂРµР±Р»СЏРµС‚ С‚РѕРї-1 РєР°РЅРґРёРґР°С‚Р° Рё СЃС‚Р°РІРёС‚ РјР°СЂРєРµСЂ РѕРєРЅР° вЂ” РїРѕСЃС‚ РІС‹Р№РґРµС‚ РѕРґРёРЅ СЂР°Р·.
async function commitSingle(env, date, slug, cand) {
  const rest = (await kv.getCandidates(env)).filter((c) => c.guid !== cand.guid);
  await kv.setCandidates(env, rest);
  await kv.setDigestDone(env, date, slug, { assembled_at: new Date().toISOString(), kind: "news", guid: cand.guid });
}

// РђРІС‚РѕРїРѕСЃС‚С‹ Р’Р«РљР›: РІРјРµСЃС‚Рѕ РїСѓР±Р»РёРєР°С†РёРё Р°РґРјРёРЅСѓ РїСЂРёС…РѕРґРёС‚ РїСЂРµРІСЊСЋ РЅРѕРІРѕСЃС‚Рё РЅР° РѕРґРѕР±СЂРµРЅРёРµ
// (РєРЅРѕРїРєРё рџЊђ/рџ”µ/рџџў/рџ”„/вќЊ) вЂ” С‚РѕС‚ Р¶Рµ РєРѕРЅС‚СЂР°РєС‚, С‡С‚Рѕ Сѓ РґР°Р№РґР¶РµСЃС‚-РїСЂРµРІСЊСЋ.
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
  const ekb = ekbNow(now);
  const adminChat = env.TELEGRAM_ADMIN_CHAT_ID;
  let sent = 0;
  for (const w of await getWindows(env)) {
    if (ekb.minuteOfDay < w.start || ekb.minuteOfDay >= w.end) continue;
    if (await kv.getDigestDone(env, ekb.date, w.slug)) continue;
    const cand = await pickSingleItem(env);
    if (!cand) continue;
    const res = await finalizeNewsPkg(env, cand, {
      slug: w.slug,
      date: ekb.date,
      slot: ekbToUtcMs(ekb.dow, w.start, now),
    });
    if (!res) continue;
    if (adminChat) await sendNewsPreview(env, adminChat, res.pkg);
    await commitSingle(env, ekb.date, w.slug, cand);
    sent++;
    console.log("[scheduler] РїСЂРµРІСЊСЋ РЅРѕРІРѕСЃС‚Рё Р°РґРјРёРЅСѓ:", res.pkg.title);
  }
  return sent;
}

// ---------- РїСѓР±Р»РёРєР°С†РёСЏ РёР· СЃРєР»Р°РґР° РїРѕ СЃР»РѕС‚Р°Рј ----------

async function publishDueStock(env, now = new Date()) {
  const stock = await kv.getStock(env);
  const nowMs = now.getTime();
  const state = await kv.loadState(env);
  const dry = !!state.dry_run;
  const due = stock.filter((p) => (p.scheduled_for || 0) <= nowMs);
  // Р”СѓР±Р»Рё РІ stock РІРѕР·РјРѕР¶РЅС‹ (С‚РёРє СѓРјРёСЂР°Р» РјРµР¶РґСѓ addStock Рё commitSingle) вЂ”
  // РѕРґРёРЅ Рё С‚РѕС‚ Р¶Рµ РїР°РєРµС‚ (id) РЅРµ РґРѕР»Р¶РµРЅ РІС‹С…РѕРґРёС‚СЊ РґРІР°Р¶РґС‹: РїСѓР±Р»РёРєСѓРµРј С‚РѕР»СЊРєРѕ
  // РїРµСЂРІСѓСЋ РєРѕРїРёСЋ РІ РѕС‡РµСЂРµРґРё, РѕСЃС‚Р°Р»СЊРЅС‹Рµ С‚РёС…Рѕ РІС‹РєРёРґС‹РІР°РµРј.
  const seenIds = new Set();
  for (const pkg of due) {
    if (seenIds.has(pkg.id)) {
      await kv.removeStock(env, pkg.id);
      continue;
    }
    seenIds.add(pkg.id);
    // Р”Р°Р№РґР¶РµСЃС‚ СЃРѕР±СЂР°РЅ РёР· СЃРІРµР¶РёС… РЅРѕРІРѕСЃС‚РµР№ РїСЂСЏРјРѕ РІ РѕРєРЅРµ (РјР°СЂРєРµСЂ digest_done) вЂ”
    // РїСЂРѕРІРµСЂРєСѓ СЃРІРµР¶РµСЃС‚Рё РЅРµ РїСЂРёРјРµРЅСЏРµРј, РѕРєРЅРѕ РЅРµ В«РїРµСЂРµРїРѕР»РЅСЏРµРјВ» РїРѕ cap: РѕРЅРѕ Рё РµСЃС‚СЊ
    // СЌС‚РѕС‚ РІС‹РїСѓСЃРє.
    if (pkg.kind === "digest") {
      // РїСѓСЃС‚Рѕ
    } else if (pkg.kind === "news" && isStaleItem(pkg, nowMs)) {
      // РЅРѕРІРѕСЃС‚СЊ РїСЂРѕС‚СѓС…Р»Р°, РїРѕРєР° Р¶РґР°Р»Р° СЃРІРѕРµРіРѕ СЃР»РѕС‚Р° вЂ” РІС‹РєРёРґС‹РІР°РµРј С‚РёС…Рѕ
      await kv.removeStock(env, pkg.id);
      continue;
    }
    if (pkg.kind === "news" || pkg.kind === "digest") {
      const ekb = ekbNow(new Date(pkg.scheduled_for || now.getTime()));
      const win = await dynamicCurrentWindow(env, ekb.minuteOfDay);
      if (win) {
        const used = await countInWindow(env, win, new Date(pkg.scheduled_for || now.getTime()));
        if (used >= win.cap) {
          // РѕРєРЅРѕ СѓР¶Рµ Р·Р°РЅСЏС‚Рѕ РґСЂСѓРіРёРј РїРѕСЃС‚РѕРј/РІС‹РїСѓСЃРєРѕРј вЂ” РїРµСЂРµРЅРѕСЃРёРј РІ СЃР»РµРґСѓСЋС‰РёР№ СЃР»РѕС‚
          const next = await nextFreeSlot(env, now);
          await kv.removeStock(env, pkg.id);
          await kv.addStock(env, { ...pkg, scheduled_for: next });
          continue;
        }
      }
    }
    // Р·Р°С‰РёС‚Р° РѕС‚ РґСѓР±Р»РµР№: РµСЃР»Рё СЌС‚РѕС‚ guid СѓР¶Рµ РїСѓР±Р»РёРєРѕРІР°Р»СЃСЏ вЂ” РїСЂРѕРїСѓСЃРєР°РµРј
    if (pkg.guid) {
      const log = await kv.getLog(env);
      if (log.some((e) => e.guid && e.guid === pkg.guid)) {
        await kv.removeStock(env, pkg.id);
        continue;
      }
    }
    // РЎРІРµР¶Р°СЏ РєР°СЂС‚РѕС‡РєР° РІ РјРѕРјРµРЅС‚ РїСѓР±Р»РёРєР°С†РёРё: РЅРµР±Рѕ СЂРёСЃСѓРµС‚СЃСЏ РїРѕРґ СЂРµР°Р»СЊРЅРѕРµ РІСЂРµРјСЏ
    // РІС‹С…РѕРґР° РїРѕСЃС‚Р° (СЂРµРЅРґРµСЂ-СЃРµСЂРІРёСЃ СЃС‡РёС‚Р°РµС‚ РњРЎРљ СЃР°Рј), Р° РЅРµ РїРѕРґ РІСЂРµРјСЏ РіРµРЅРµСЂР°С†РёРё.
    // Р¤РѕСЂРјР°С‚ вЂ” РїРѕ РЅР°СЃС‚СЂРѕР№РєРµ card_format (auto/gif/png); РґР°Р№РґР¶РµСЃС‚-РѕР±Р»РѕР¶РєР° вЂ” PNG
    // Рё Р±РµР· РїР»Р°С€РєРё С†РёС‚Р°С‚С‹ (РѕР±С‹С‡РЅС‹Рµ РЅРѕРІРѕСЃС‚Рё). РђРІС‚РѕРїРѕСЃС‚ РёР· РѕРєРЅР° (no_rereder) СѓР¶Рµ
    // РЅРµСЃС‘С‚ РіРѕС‚РѕРІСѓСЋ РєР°СЂС‚РѕС‡РєСѓ вЂ” РЅРµ С‚СЂР°С‚РёРј С‚СЏР¶С‘Р»С‹Р№ СЂРµРЅРґРµСЂ РµС‰С‘ СЂР°Р· РЅР° С‚РёРєРµ.
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
        // РёРІРµРЅС‚С‹ вЂ” С‚РµРєСЃС‚РѕРІС‹Р№ РїРѕСЃС‚ Р±РµР· РєР°СЂС‚РѕС‡РєРё (СЃРѕР·РґР°СЋС‚СЃСЏ Р°РґРјРёРЅРѕРј РІ РґРёР°Р»РѕРіРµ)
        const text = (pkg.caption || pkg.title || "").trim();
        if (!text) continue;
        const ok = await publishText(env, text, dry, "event", {
          id: pkg.id,
          title: pkg.title || "",
          guid: pkg.guid || "",
          link: pkg.link || "",
        });
        if (ok) {
          await notifyAdmin(env, `рџЋЄ <b>РРІРµРЅС‚ РѕРїСѓР±Р»РёРєРѕРІР°РЅ</b>: ${pkg.title || ""}`);
        } else {
          await kv.addStock(env, { ...pkg, scheduled_for: now.getTime() + 15 * 60 * 1000 });
        }
        continue;
      }
      const res = await publishPackage(env, pkg, dry);
      if (!dry) {
        // РЎС‚СЂРѕРіРёР№ РїСѓР»: РµСЃР»Рё СѓС€Р»Р° С‚РѕР»СЊРєРѕ РѕРґРЅР° РїР»Р°С‚С„РѕСЂРјР° вЂ” РЅРµРґРѕСЃС‚Р°СЋС‰Р°СЏ РґРѕРіРѕРЅСЏРµС‚СЃСЏ
        // СЂРµС‚СЂР°СЏРјРё, РїРёС€РµРј РѕР± СЌС‚РѕРј Р°РґРјРёРЅСѓ.
        const url = vkPostUrl(env, res.vkPost);
        const line = url ? `${pubStatus(res)} В· ${url}` : pubStatus(res);
        if (res.tgOk && res.vkOk) {
          await notifyAdmin(env, `вњ… <b>РћРїСѓР±Р»РёРєРѕРІР°РЅРѕ</b>: ${pkg.title || ""}\n${line}`);
        } else if (res.tgOk || res.vkOk) {
          const missing = res.tgOk ? "VK" : "TG";
          await notifyAdmin(env, `вЏі <b>Р§Р°СЃС‚РёС‡РЅРѕ РѕРїСѓР±Р»РёРєРѕРІР°РЅРѕ</b>: ${pkg.title || ""}\n${line}\nрџ”њ Р”РѕРіРѕРЅСЏСЋ ${missing} РІ Р±Р»РёР¶Р°Р№С€РёРµ С‚РёРєРё.`);
        }
      }
    } catch (e) {
      console.log("[scheduler] publish failed:", e.message);
      await notifyAdmin(env, `вќЊ <b>РќРµ СѓРґР°Р»РѕСЃСЊ РѕРїСѓР±Р»РёРєРѕРІР°С‚СЊ</b>: ${pkg.title || ""}\n${escHtml(e.message)}`);
      await kv.addStock(env, { ...pkg, scheduled_for: now.getTime() + 15 * 60 * 1000 });
    }
  }
}

// ---------- СЃР±РѕСЂРєР° РґР°Р№РґР¶РµСЃС‚РѕРІ РїРѕ РѕРєРЅР°Рј ----------

// РЎРІРµР¶РёС… РєР°РЅРґРёРґР°С‚РѕРІ РЅР° РІС‹РїСѓСЃРє: РЅРµ РїСЂРѕС‚СѓС…С€РёРµ, СЃРІРµР¶Р°Р№С€РёРµ РїРµСЂРІС‹РјРё, РЅРµ Р±РѕР»СЊС€Рµ
// DIGEST_MAX_ITEMS. РџСЂРёРѕСЂРёС‚РµС‚ С‚РµРјР°Рј, РєРѕС‚РѕСЂС‹Рµ СЃРµР№С‡Р°СЃ Р»СѓС‡С€Рµ РІСЃРµРіРѕ Р·Р°Р»РµС‚Р°СЋС‚ Сѓ
// Р°СѓРґРёС‚РѕСЂРёРё: РІРµСЃ С‚РµРјС‹-Р»РёРґРµСЂР° (РёР· СЃС‚Р°С‚РѕРІ) СЃРґРІРёРіР°РµС‚ РєР°РЅРґРёРґР°С‚Р° РІРІРµСЂС… РїРѕ СЃРІРµР¶РµСЃС‚Рё
// (1 Р±Р°Р»Р» РІРµСЃР° ~ 45 РјРёРЅСѓС‚), С‡С‚РѕР±С‹ РІС‹РїСѓСЃРє В«РґРµР»Р°Р» РїРѕРґРѕР±РЅС‹РµВ» СѓСЃРїРµС€РЅС‹Рј РїРѕСЃС‚Р°Рј.
// РџСѓСЃС‚Рѕ -> РґР°Р№РґР¶РµСЃС‚ РЅРµ РІС‹Р№РґРµС‚ (РєР°РЅРґРёРґР°С‚С‹ РјРѕРіР»Рё РїСЂРёР№С‚Рё РїРѕР·Р¶Рµ РІ РѕРєРЅРµ вЂ” РјР°СЂРєРµСЂ
// РЅРµ СЃС‚Р°РІРёРј).
async function pickDigestItems(env, count) {
  const nowMs = Date.now();
  const list = ((await kv.getCandidates(env)) || []).filter((c) => !isStaleItem(c, nowMs));
  let topicBoost = null;
  try {
    const { getContentWeights } = await import("./stats.js");
    const cw = await getContentWeights(env);
    if (cw && cw.topic && Object.keys(cw.topic).length) topicBoost = cw.topic;
  } catch (e) { /* Р±РµР· Р±СѓСЃС‚Р° С‚РµРј */ }
  const boostOf = (c) => {
    if (!topicBoost) return 0;
    try {
      const t = mainTopic(String(c.title || "") + " " + String(c.text || c.excerpt || ""));
      if (t && topicBoost[t.id]) return topicBoost[t.id];
    } catch (e) { /* РЅРµС‚ С‚РµРјС‹ */ }
    return 0;
  };
  const scored = list.map((c) => ({ c, fresh: digestFreshScore(c), boost: boostOf(c) }));
  // РљР°Р¶РґС‹Р№ Р±Р°Р»Р» РІРµСЃР° С‚РµРјС‹ в‰€ 45 РјРёРЅСѓС‚ В«СЃРІРµР¶РµСЃС‚РёВ»: Р»РёРґРµСЂ С‚РµРјС‹ РѕР±РіРѕРЅСЏРµС‚ СЃРѕСЃРµРґРЅРёРµ
  // РїРѕ РІСЂРµРјРµРЅРё, РЅРѕ РЅРµ РїРµСЂРµРІРѕСЂР°С‡РёРІР°РµС‚ РІС‹РїСѓСЃРє РґР»СЏ СЃС‚Р°СЂС‹С… РєР°РЅРґРёРґР°С‚РѕРІ.
  scored.sort((a, b) => (b.fresh + (b.boost || 0) * 45 * 60 * 1000) - (a.fresh + (a.boost || 0) * 45 * 60 * 1000));
  return scored.slice(0, count).map((x) => ({
    ...x.c,
    title: cleanRssTitle(x.c.title || ""),
  }));
}

// РЎРѕР±РёСЂР°РµС‚ РіРѕС‚РѕРІС‹Р№ РїР°РєРµС‚-РґР°Р№РґР¶РµСЃС‚ РёР· items (С‚РµРєСЃС‚ С‡РµСЂРµР· LLM/РїСЂР°РІРёР»Р° + РѕР±Р»РѕР¶РєР°).
// РќРёС‡РµРіРѕ РЅРµ РїСѓР±Р»РёРєСѓРµС‚ Рё РЅРµ РїРѕС‚СЂРµР±Р»СЏРµС‚ вЂ” С‚РѕР»СЊРєРѕ РіРѕС‚РѕРІРёС‚. Р’РѕР·РІСЂР°С‰Р°РµС‚ pkg РёР»Рё null,
// РµСЃР»Рё РѕР±Р»РѕР¶РєСѓ РЅРµ СѓРґР°Р»РѕСЃСЊ СЃРѕР±СЂР°С‚СЊ.
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
  // Р‘РµР· Р¶РёРІРѕРіРѕ LLM РІС‹РїСѓСЃРє РЅРµ СЃРѕР±РёСЂР°РµРј: С„РѕР»Р±СЌРє-РїСЂР°РІРёР»Р° РґР°СЋС‚ СЃС‹СЂС‹Рµ Р·Р°РіРѕР»РѕРІРєРё,
  // СЌС‚Рѕ РјСѓСЃРѕСЂ. РћРєРЅРѕ РїСЂРѕРїСѓСЃРєР°РµС‚СЃСЏ, РєР°РЅРґРёРґР°С‚С‹ РЅРµ С‚СЂР°С‚СЏС‚СЃСЏ.
  if (!digestText) return null;
  const { headline, caption, digest_text } = digestText;

  const data = {
    headline,
    headline_lines: [headline],
    caption,
    cards: [
      {
        type: "list",
        label: "Р’ СЌС‚РѕРј РІС‹РїСѓСЃРєРµ",
        items: itemMeta.map((m2) => m2.title || "РќРѕРІРѕСЃС‚СЊ").slice(0, DIGEST_MAX_ITEMS),
      },
    ],
    tier: "news",
    source: "TrustNode",
    scheme_id: null,
    style_id: "digest",
    topic_id: "digest",
  };

  // РћРґРЅР° РѕР±Р»РѕР¶РєР° РЅР° РІРµСЃСЊ РІС‹РїСѓСЃРє (СЂРµРЅРґРµСЂ РїРѕ РґР°РЅРЅС‹Рј РїР°РєРµС‚Р°, РїРµСЂРµ-СЂРёСЃСѓРµС‚СЃСЏ Рё РІ
  // РјРѕРјРµРЅС‚ РїСѓР±Р»РёРєР°С†РёРё РїРѕРґ СЂРµР°Р»СЊРЅРѕРµ РІСЂРµРјСЏ СЃСѓС‚РѕРє). Р’СЃРµРіРґР° PNG вЂ” С„РѕС‚Рѕ, Р° РЅРµ С„Р°Р№Р»;
  // Р±РµР· РїР»Р°С€РєРё С†РёС‚Р°С‚С‹ (РѕР±С‹С‡РЅС‹Рµ РЅРѕРІРѕСЃС‚Рё).
  let b64 = "";
  try {
    const bytes = await renderCardBytes(env, data, { link: "", source: "TrustNode", format: "png", quote: "" });
    if (bytes && bytes.length > 100) b64 = bytesToBase64(bytes);
  } catch (e) {
    console.log("[scheduler] РґР°Р№РґР¶РµСЃС‚: РѕР±Р»РѕР¶РєСѓ РЅРµ СЃРѕР±СЂР°Р»Рё:", e.message);
  }
  if (!b64) {
    // РћР±Р»РѕР¶РєР° РѕР±СЏР·Р°С‚РµР»СЊРЅР° (TG/VK РїРѕСЃС‚СЏС‚ РєР°СЂС‚РёРЅРєСѓ) вЂ” Р±РµР· РЅРµС‘ РІС‹РїСѓСЃРє РЅРµ РІС‹Р№РґРµС‚,
    // РєР°РЅРґРёРґР°С‚РѕРІ РЅРµ С‚СЂРѕРіР°РµРј, РѕРєРЅРѕ РїРѕРїСЂРѕР±СѓРµРј СЃРѕР±СЂР°С‚СЊ РЅР° СЃР»РµРґСѓСЋС‰РµРј С‚РёРєРµ.
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

// РЎРѕР±РёСЂР°РµС‚ РїР°РєРµС‚-РґР°Р№РґР¶РµСЃС‚ РґР»СЏ Р°РєС‚РёРІРЅРѕРіРѕ РѕРєРЅР°. Р’РѕР·РІСЂР°С‰Р°РµС‚ { pkg, items }
// (items вЂ” РІС‹Р±СЂР°РЅРЅС‹Рµ СЃРІРµР¶РёРµ РєР°РЅРґРёРґР°С‚С‹) РёР»Рё null, РµСЃР»Рё РѕРєРЅРѕ СѓР¶Рµ СЃРѕР±СЂР°РЅРѕ
// (РјР°СЂРєРµСЂ) РёР»Рё РЅРµС‚ СЃРІРµР¶РёС… РєР°РЅРґРёРґР°С‚РѕРІ.
async function buildDigestForWindow(env, win, now) {
  const ekb = ekbNow(now);
  const date = ekb.date;
  if (await kv.getDigestDone(env, date, win.slug)) return null;

  const items = await pickDigestItems(env, DIGEST_MAX_ITEMS);
  if (!items.length) return null;
  const res = await finalizeDigestPkg(env, items, {
    label: win.label,
    slug: win.slug,
    date,
    slot: ekbToUtcMs(ekb.dow, win.start, now),
  });
  if (!res) return null;
  return { pkg: res.pkg, items };
}

// РџРѕС‚СЂРµР±Р»СЏРµС‚ СЃРѕР±СЂР°РЅРЅС‹С… РєР°РЅРґРёРґР°С‚РѕРІ Рё СЃС‚Р°РІРёС‚ РјР°СЂРєРµСЂ вЂ” РґР°Р№РґР¶РµСЃС‚ РІС‹Р№РґРµС‚ РѕРґРёРЅ СЂР°Р·.
async function commitDigest(env, date, win, items) {
  const consumed = new Set(items.map((c) => c.guid));
  const rest = (await kv.getCandidates(env)).filter((c) => !consumed.has(c.guid));
  await kv.setCandidates(env, rest);
  await kv.setDigestDone(env, date, win.slug, { assembled_at: new Date().toISOString(), items: items.length });
}

// РђРІС‚РѕРїРѕСЃС‚РёРЅРі Р’РљР›: СЃРѕР±СЂР°РЅРЅС‹Р№ РІ Р°РєС‚РёРІРЅРѕРј РѕРєРЅРµ РґР°Р№РґР¶РµСЃС‚ Р»РѕР¶РёС‚СЃСЏ РЅР° СЃРєР»Р°Рґ Рё
// РїСѓР±Р»РёРєСѓРµС‚СЃСЏ С‚РµРј Р¶Рµ С‚РёРєРѕРј (slot СѓР¶Рµ РЅР°СЃС‚СѓРїРёР»). Р’РѕР·РІСЂР°С‰Р°РµС‚ РјР°СЃСЃРёРІ guid.
export async function assembleDigests(env, now = new Date()) {
  const ekb = ekbNow(now);
  const made = [];
  for (const w of await getWindows(env)) {
    if (ekb.minuteOfDay < w.start || ekb.minuteOfDay >= w.end) continue;
    const res = await buildDigestForWindow(env, w, now);
    if (!res) continue;
    await kv.addStock(env, res.pkg);
    await commitDigest(env, ekb.date, w, res.items);
    made.push(res.pkg.guid);
    console.log("[scheduler] РґР°Р№РґР¶РµСЃС‚ СЃРѕР±СЂР°РЅ:", res.pkg.title, "в†’", new Date(res.pkg.scheduled_for).toISOString());
  }
  return made;
}

// РђРІС‚РѕРїРѕСЃС‚РёРЅРі Р’Р«РљР›: РІРјРµСЃС‚Рѕ РїСѓР±Р»РёРєР°С†РёРё Р°РґРјРёРЅСѓ РїСЂРёС…РѕРґРёС‚ РґР°Р№РґР¶РµСЃС‚-РїСЂРµРІСЊСЋ РЅР°
// РѕРґРѕР±СЂРµРЅРёРµ (РєРЅРѕРїРєРё рџЊђ/рџ”µ/рџџў/рџ”„/вќЊ). РћР±Р»РѕР¶РєР° вЂ” СЃ РєРѕСЂРѕС‚РєРѕР№ РїРѕРґРїРёСЃСЊСЋ, РїРѕР»РЅС‹Р№
// СЂР°Р·Р±РѕСЂ СѓС…РѕРґРёС‚ РѕС‚РґРµР»СЊРЅС‹Рј СЃРѕРѕР±С‰РµРЅРёРµРј.
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
  const ekb = ekbNow(now);
  const adminChat = env.TELEGRAM_ADMIN_CHAT_ID;
  let sent = 0;
  for (const w of await getWindows(env)) {
    if (ekb.minuteOfDay < w.start || ekb.minuteOfDay >= w.end) continue;
    const res = await buildDigestForWindow(env, w, now);
    if (!res) continue;
    if (adminChat) await sendDigestPreview(env, adminChat, res.pkg);
    await commitDigest(env, ekb.date, w, res.items);
    sent++;
    console.log("[scheduler] РґР°Р№РґР¶РµСЃС‚-РїСЂРµРІСЊСЋ Р°РґРјРёРЅСѓ:", res.pkg.title);
  }
  return sent;
}

// РўРµСЃС‚РѕРІРѕРµ РїСЂРµРІСЊСЋ (/digesttest): СЃРѕР±РёСЂР°РµС‚ РґР°Р№РґР¶РµСЃС‚ РёР· С‚РµРєСѓС‰РёС… РєР°РЅРґРёРґР°С‚РѕРІ РєР°Рє
// Р±СѓРґС‚Рѕ РЅР°СЃС‚СѓРїРёР»Рѕ Р±Р»РёР¶Р°Р№С€РµРµ РѕРєРЅРѕ Рё С€Р»С‘С‚ РµРіРѕ Р°РґРјРёРЅСѓ. РљР°РЅРґРёРґР°С‚РѕРІ РќР• РїРѕС‚СЂРµР±Р»СЏРµС‚ Рё
// РјР°СЂРєРµСЂ digest_done РќР• СЃС‚Р°РІРёС‚. Р’РѕР·РІСЂР°С‰Р°РµС‚ { ok, reason?, title }.
export async function sendDigestTestPreview(env) {
  const ekb = ekbNow();
  const now = new Date();
  const wins = await getWindows(env);
  const win =
    wins.find((w) => ekb.minuteOfDay >= w.start && ekb.minuteOfDay < w.end) ||
    wins[0];

  const items = await pickDigestItems(env, DIGEST_MAX_ITEMS);
  if (!items.length) {
    return { ok: false, reason: "Р’ РѕС‡РµСЂРµРґРё РЅРµС‚ СЃРІРµР¶РёС… РєР°РЅРґРёРґР°С‚РѕРІ вЂ” Р·Р°РїСѓСЃС‚Рё /rescan" };
  }

  const date = ekb.date;
  const res = await finalizeDigestPkg(env, items, {
    label: win.label,
    slug: win.slug,
    date,
    slot: ekbToUtcMs(0, win.start, now),
  });
  if (!res) return { ok: false, reason: "РћР±Р»РѕР¶РєСѓ РЅРµ СѓРґР°Р»РѕСЃСЊ СЃРѕР±СЂР°С‚СЊ" };

  const adminChat = env.TELEGRAM_ADMIN_CHAT_ID;
  if (adminChat) await sendDigestPreview(env, adminChat, res.pkg);
  return { ok: true, title: res.pkg.title };
}

// В«РџРµСЂРµРґРµР»Р°С‚СЊВ» РґР»СЏ РґР°Р№РґР¶РµСЃС‚-РїСЂРµРІСЊСЋ: РєР°РЅРґРёРґР°С‚С‹ СѓР¶Рµ РїРѕС‚СЂРµР±Р»РµРЅС‹ РІС‹РїСѓСЃРєРѕРј, РїРѕСЌС‚РѕРјСѓ
// РїРµСЂРµСЃРѕР±РёСЂР°РµРј С‚РµРєСЃС‚ Рё РѕР±Р»РѕР¶РєСѓ РёР· РєРѕРјРїРѕРЅРµРЅС‚РѕРІ СЃРѕС…СЂР°РЅС‘РЅРЅРѕРіРѕ С‡РµСЂРЅРѕРІРёРєР° (Р±РµР·
// РїРѕРІС‚РѕСЂРЅРѕРіРѕ РґРёСЃРїР°С‚С‡Р° РЅР° GitHub) Рё С€Р»С‘Рј Р°РґРјРёРЅСѓ РЅРѕРІРѕРµ РїСЂРµРІСЊСЋ. Р’РѕР·РІСЂР°С‰Р°РµС‚
// { ok: true } РёР»Рё { ok: false, reason }.
export async function rebuildDigestPreview(env, draft) {
  const slug = String(draft.id || "").replace(/^dg\d{8}/, "");
  const win = windowBySlug(slug);
  const date = String(draft.guid || "").split(":")[1] || "";
  if (!win || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, reason: "РЅРµ СЂР°СЃРїРѕР·РЅР°РЅ РІС‹РїСѓСЃРє РґР°Р№РґР¶РµСЃС‚Р°" };
  }
  if (!Array.isArray(draft.items) || !draft.items.length) {
    return { ok: false, reason: "РЅРµС‚ СЃРѕС…СЂР°РЅС‘РЅРЅС‹С… РЅРѕРІРѕСЃС‚РµР№ РІС‹РїСѓСЃРєР°" };
  }

  const res = await finalizeDigestPkg(env, draft.items, {
    label: win.label,
    slug: win.slug,
    date,
    slot: ekbToUtcMs(0, win.start, new Date()),
  });
  if (!res) return { ok: false, reason: "РѕР±Р»РѕР¶РєСѓ РЅРµ СЃРѕР±СЂР°Р»Рё" };

  const adminChat = draft.admin_chat_id || env.TELEGRAM_ADMIN_CHAT_ID;
  await kv.deleteDraft(env, draft.id);
  if (adminChat) await sendDigestPreview(env, adminChat, res.pkg);
  return { ok: true };
}

// ---------- РіР»Р°РІРЅС‹Р№ С‚РёРє ----------

// ---------- авто-микс форматов (одиночная / дайджест / опрос) ----------

// Стабильный мэппинг «день:окно -> формат»: rotate-хэш + LLM (/mix) с
// фолбэком на правила. Решение хранится в KV (mix_plan), чтобы каждый крон
// не переспрашивал LLM и окно не «прыгало» между форматами.
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// LLM-решение формата через прокси (/mix). Недоступно — правила.
async function llmMixFormat(env, date, slug, count) {
  const base = String(env.LLM_PROXY_URL || "").replace(/\/+$/, "");
  if (base) {
    try {
      const res = await fetch(`${base}/mix`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ window: slug, date, count, provider: "gigachat" }),
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) {
        const data = JSON.parse(await res.text());
        const f = String((data && data.format) || "").toLowerCase();
        if (f === "single") return "news";
        if (f === "digest") return "digest";
        if (f === "poll") return "poll";
      }
    } catch (e) {
      console.log("[mix] LLM /mix недоступен, беру правила:", e.message);
    }
  }
  // Ротация по правилам: главная новость ~20%, дайджест ~60%, опрос ~20%.
  // Детерминированно от дня и окна — стабильно в течение всего окна.
  const r = hashStr(`${date}:${slug}`) % 10;
  if (r < 2) return "news";
  if (r < 8) return "digest";
  return "poll";
}

// Решает формат окна и кеширует в mix_plan. count — число свежих кандидатов.
// С одним кандидатом всегда одиночная новость (дайджест из одного — мусор).
async function decideMixFormat(env, date, slug, count) {
  const plan = await kv.getMixPlan(env);
  const key = `${date}:${slug}`;
  const cached = plan[key];
  if (cached === "news" || cached === "digest" || cached === "poll") return cached;
  if (count < 1) return null;
  const res = count === 1 ? "news" : await llmMixFormat(env, date, slug, count);
  if (res) {
    plan[key] = res;
    await kv.setMixPlan(env, plan);
  }
  return res;
}

// Опрос по правилам: вопрос привязываем к теме топ-новости, варианты —
// стандартные для кибербезопасности. /poll (LLM) может переписать их.
function pollByRules(items) {
  let subject = "этой схемой";
  try {
    const top = items[0];
    const a = analyzePost(String(top.text || "") + " " + String(top.title || ""));
    if (a && a.subject) subject = a.subject;
  } catch (e) { /* дефолтная тема */ }
  return {
    question: `Сталкивались ли вы с «${subject}»?`,
    options: [
      "Да, было такое",
      "Слышал о таком",
      "Впервые слышу",
      "Не знаю, как защититься",
    ],
  };
}

// Живые вопрос+варианты через прокси (/poll). Недоступно — правила.
async function llmPollData(env, items) {
  const base = String(env.LLM_PROXY_URL || "").replace(/\/+$/, "");
  if (!base) return null;
  const top = items[0];
  const text = String(top.text || top.title || "").slice(0, 2000);
  const res = await fetch(`${base}/poll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, provider: "gigachat" }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) return null;
  const data = JSON.parse(await res.text());
  const question = String((data && data.question) || "").trim();
  const options = Array.isArray(data && data.options)
    ? data.options.map((o) => String(o).trim()).filter(Boolean).slice(0, 4)
    : [];
  if (!question || options.length < 2) return null;
  return { question: question.slice(0, 255), options };
}

async function generatePollData(env, items) {
  try {
    const live = await bounded(LLM_BUDGET_MS, "[scheduler] poll LLM", llmPollData(env, items));
    if (live) return live;
  } catch (e) {
    console.log("[scheduler] вопрос опроса превысил бюджет, беру правила:", e.message);
  }
  return pollByRules(items);
}

// Собирает пост для одного активного окна в выбранном формате
// (одиночная новость / дайджест / новость + опрос). Возвращает guid или null.
async function assembleMixWindow(env, now, w) {
  const ekb = ekbNow(now);
  const date = ekb.date;
  if (await kv.getDigestDone(env, date, w.slug)) return null;
  const items = await pickDigestItems(env, DIGEST_MAX_ITEMS);
  if (!items.length) return null;
  const format = await decideMixFormat(env, date, w.slug, items.length);
  if (format === "digest") {
    let res = null;
    try {
      res = await bounded(DIGEST_BUDGET_MS, "[scheduler] digest",
        buildDigestForWindow(env, w, now));
    } catch (e) {
      console.log("[scheduler] digest превысил бюджет, окно на одиночную новость:", e.message);
    }
    if (res) {
      await kv.addStock(env, res.pkg);
      await commitDigest(env, date, w, res.items);
      console.log("[scheduler] микс: дайджест собран:", res.pkg.title);
      return res.pkg.guid;
    }
    // Дайджест не собрался (живой LLM/рендер недоступны) — окно не теряем,
    // опускаемся до одиночной новости.
  }
  // news / poll — база одна: одиночная карточка топ-1 кандидата.
  const cand = items[0];
  const res = await finalizeNewsPkg(env, cand, {
    slug: w.slug,
    date,
    slot: ekbToUtcMs(ekb.dow, w.start, now),
  });
  if (!res) return null;
  if (format === "poll") {
    const poll = await generatePollData(env, items);
    if (poll && poll.question) res.pkg.poll = poll;
    await kv.addStock(env, res.pkg);
    await commitSingle(env, date, w.slug, cand);
    console.log("[scheduler] микс: новость + опрос собраны:", res.pkg.title);
    return res.pkg.guid;
  }
  await kv.addStock(env, res.pkg);
  await commitSingle(env, date, w.slug, cand);
  console.log("[scheduler] микс: одиночная новость собрана:", res.pkg.title);
  return res.pkg.guid;
}

// Авто-микс: для каждого активного окна в узком формате (одиночная / дайджест /
// опрос) собирается пакет и попадает на склад. Возвращает массив guid.
// ВЫКЛ-режим (превью админу) по-прежнему собирает только одиночные превью.
export async function assembleMix(env, now = new Date()) {
  const made = [];
  for (const w of await getWindows(env)) {
    const ekb = ekbNow(now);
    if (ekb.minuteOfDay < w.start || ekb.minuteOfDay >= w.end) continue;
    const g = await assembleMixWindow(env, now, w);
    if (g) made.push(g);
  }
  return made;
}

export async function tick(env, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const started = Date.now();
  const marks = [];
  const mark = (name, from) => marks.push(`${name}=${Date.now() - from}ms`);
  let currentStep = "lock";

  const run = async () => {
    // РђРЅС‚Рё-РїРµСЂРµРєСЂС‹С‚РёРµ РєСЂРѕРЅ: Cloudflare РЅРµ Р¶РґС‘С‚ Р·Р°РІРµСЂС€РµРЅРёСЏ РїСЂРµРґС‹РґСѓС‰РµРіРѕ Р·Р°РїСѓСЃРєР°,
    // РµСЃР»Рё РєСЂРѕРЅ СЂР°Р· РІ 5 РјРёРЅСѓС‚ В«РЅРµ СѓСЃРїРµРІР°РµС‚В». Р”РІР° РїР°СЂР°Р»Р»РµР»СЊРЅС‹С… С‚РёРєР° С‡РёС‚Р°СЋС‚ РѕРґРЅСѓ
    // Рё С‚Сѓ Р¶Рµ РѕС‡РµСЂРµРґСЊ Рё РјРѕРіСѓС‚ РѕРїСѓР±Р»РёРєРѕРІР°С‚СЊ РѕРґРёРЅ РїРѕСЃС‚ РґРІР°Р¶РґС‹ вЂ” KV-Р»РѕРє РЅРµ РґР°С‘С‚ РёРј
    // Р±РµР¶Р°С‚СЊ РѕРґРЅРѕРІСЂРµРјРµРЅРЅРѕ (TTL СЃС‚СЂР°С…СѓРµС‚ РѕС‚ Р·Р°РІРёСЃС€РµРіРѕ С‚РёРєР°).
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

    // 1. СЃРєР°РЅ (С‡Р°СЃС‚СЊ Р»РµРЅС‚) + РґРµРґСѓРї + РєР°РЅРґРёРґР°С‚С‹ РІ РѕС‡РµСЂРµРґСЊ
    currentStep = "scan";
    let t = Date.now();
    const offset = state.meta.scan_chunk || 0;
    let scanFound = 0;
    try {
      scanFound = await bounded(SCAN_BUDGET_MS, "[scheduler] scan",
        scanFeeds(env, offset, CHUNK_COUNT).then((list) => list.length));
    } catch (e) {
      console.log("[scheduler] scan РѕС€РёР±РєР°/РїСЂРµРІС‹С€РµРЅ Р±СЋРґР¶РµС‚:", e.message);
    }
    state.meta.scan_chunk = (offset + 1) % CHUNK_COUNT;
    state.meta.last_scan = {
      at: new Date().toISOString(),
      chunk: offset,
      found: scanFound,
      took_ms: Date.now() - t,
    };
    mark("scan", t);

    // 2. РЅР°РєРѕРїР»РµРЅРёРµ РєР°РЅРґРёРґР°С‚РѕРІ Рё СЃР±РѕСЂРєР° РѕРґРёРЅРѕС‡РЅС‹С… РїРѕСЃС‚РѕРІ РїРѕ РѕРєРЅР°Рј.
    // РђРІС‚РѕРїРѕСЃС‚РёРЅРі Р’РљР›: С‚РѕРї-1 СЃРІРµР¶Р°СЏ РЅРѕРІРѕСЃС‚СЊ Р°РєС‚РёРІРЅРѕРіРѕ РѕРєРЅР° -> РєР°СЂС‚РѕС‡РєР° РЅР° СЃРєР»Р°Рґ,
    // РїСѓР±Р»РёРєСѓРµС‚СЃСЏ С‚РµРј Р¶Рµ С‚РёРєРѕРј (СЃР»РѕС‚ СѓР¶Рµ РЅР°СЃС‚СѓРїРёР»). Р’Р«РљР›: Р°РґРјРёРЅСѓ РїСЂРёС…РѕРґРёС‚ РїСЂРµРІСЊСЋ
    // РЅР° РѕРґРѕР±СЂРµРЅРёРµ. РњРЅРѕРіРѕС‚РµРјРЅС‹Рµ РґР°Р№РґР¶РµСЃС‚С‹ РѕСЃС‚Р°Р»РёСЃСЊ С‚РѕР»СЊРєРѕ РІ СЂСѓС‡РЅРѕРј СЂРµР¶РёРјРµ
    // (/digesttest, РїРµСЂРµСЃР±РѕСЂРєР°, approve).
    currentStep = "assemble";
    t = Date.now();
    try {
      const nowMs = now.getTime();
      // РІС‹РєРёРґС‹РІР°РµРј РїСЂРѕС‚СѓС…С€РёРµ РєР°РЅРґРёРґР°С‚С‹, С‡С‚РѕР±С‹ РѕРЅРё РЅРµ Р¶РґР°Р»Рё РІС‹РїСѓСЃРєР° РґРѕ Р»СѓС‡С€РёС… РІСЂРµРјС‘РЅ
      const candList = await kv.getCandidates(env);
      const freshCands = candList.filter((c) => !isStaleItem(c, nowMs));
      if (freshCands.length !== candList.length) await kv.setCandidates(env, freshCands);
      // РЎР±РѕСЂРєР° РїРѕСЃС‚Р° РЅРµ РґРѕР»Р¶РЅР° СЃСЉРµРґР°С‚СЊ РѕСЃС‚Р°С‚РѕРє С‚РёРєР°: Сѓ РЅРµС‘ СЃРѕР±СЃС‚РІРµРЅРЅС‹Р№ Р±СЋРґР¶РµС‚.
      // РџСЂРё РїРµСЂРµСЂР°СЃС…РѕРґРµ РєР°РЅРґРёРґР°С‚ РЅРµ С‚СЂР°С‚РёС‚СЃСЏ вЂ” РµРіРѕ РїРѕРґС…РІР°С‚РёС‚ СЃР»РµРґСѓСЋС‰РёР№ С‚РёРє.
      if (await kv.getAutopost(env)) {
        await bounded(ASSEMBLE_BUDGET_MS, "[scheduler] assemble",
          assembleMix(env, now));
      } else {
        await bounded(ASSEMBLE_BUDGET_MS, "[scheduler] assemble",
          assembleNewsDrafts(env, now));
      }
    } catch (e) {
      console.log("[scheduler] assemble error:", e.message);
    }
    mark("assemble", t);

    // 5. Р°РІС‚Рѕ-РѕС‚Р»РѕР¶РєР° С‡РµСЂРЅРѕРІРёРєРѕРІ (РЅРµС‚ РѕС‚РІРµС‚Р° Р°РґРјРёРЅР° 30 РјРёРЅ)
    currentStep = "defer";
    t = Date.now();
    try {
      await bounded(ASSEMBLE_BUDGET_MS, "[scheduler] defer", autoDeferDrafts(env, state, now));
    } catch (e) {
      console.log("[scheduler] defer error:", e.message);
    }
    mark("defer", t);

    // 6. РїСѓР±Р»РёРєР°С†РёСЏ РёР· СЃРєР»Р°РґР°
    currentStep = "publish";
    t = Date.now();
    try {
      await bounded(ASSEMBLE_BUDGET_MS, "[scheduler] publish", publishDueStock(env, now));
    } catch (e) {
      console.log("[scheduler] publish error:", e.message);
    }
    mark("publish", t);

    // 6a. мультигрупповая публикация (DGC / LostLink / LostArt): по одному посту
    // на группу в активном окне (30 мин ЕКБ). Идемпотентность — KV-ключи слотов.
    currentStep = "multigroup";
    t = Date.now();
    try {
      await bounded(MULTIGROUP_BUDGET_MS, "[scheduler] multigroup", multigroupTick(env, now));
    } catch (e) {
      console.log("[scheduler] multigroup error:", e.message);
    }
    mark("multigroup", t);

    // 6b. РґРѕРіРѕРЅРєР° РЅРµРґРѕСЃС‚Р°СЋС‰РµР№ РїР»Р°С‚С„РѕСЂРјС‹ (СЃС‚СЂРѕРіРёР№ РїСѓР» VK/TG)
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

    // 7. операционные догонялки (низкий приоритет): метрики охвата VK + дневные
    // метрики, ночной алерт здоровья, ночной бэкап в GitHub. Гоняем только в
    // «ровный» час (минута 0 ЕКБ), чтобы не жечь бюджет каждого тика и не
    // спорить с хард-бюджетом: вовлечённость и так троттлится на 45 минут.
    currentStep = "ops";
    t = Date.now();
    if (ekbNow(now).minuteOfDay % 60 === 0) {
      try {
        await bounded(OPS_BUDGET_MS, "[scheduler] ops",
          Promise.allSettled([
            collectEngagement(env, { now }),
            maybeHealthAlert(env, { now }),
            maybeBackupToGitHub(env, { now }),
          ]));
      } catch (e) {
        console.log("[scheduler] ops error:", e.message);
      }
    }
    mark("ops", t);

    console.log("[scheduler] tick:", marks.join(" "),
      `cands=${((await kv.getCandidates(env)) || []).length}`,
      `stock=${((await kv.getStock(env)) || []).length}`,
      `total=${Date.now() - started}ms`);
    return "ok";
  };

  // РҐР°СЂРґ-Р±СЋРґР¶РµС‚: РґР°Р¶Рµ РµСЃР»Рё С‡С‚Рѕ-С‚Рѕ РІРЅРµС€РЅРµРµ Р·Р°РІРёСЃР»Рѕ, С‚РёРє РѕР±СЏР·Р°РЅ РІРµСЂРЅСѓС‚СЊСЃСЏ РґРѕ
  // С‚РѕРіРѕ, РєР°Рє free-РїР»Р°РЅ СѓР±СЊС‘С‚ РµРіРѕ РјРѕР»С‡Р°. Р’РѕР·РІСЂР°С‰Р°РµРј "timeout" СЃ Р»РѕРіРѕРј Рё
  // СЃРЅРёРјР°РµРј lock, С‡С‚РѕР±С‹ СЃР»РµРґСѓСЋС‰РёР№ РєСЂРѕРЅ РјРѕРі РёРґС‚Рё РґР°Р»СЊС€Рµ.
  const TIMEOUT = Symbol("tick-timeout");
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), TICK_BUDGET_MS);
  });
  const result = await Promise.race([run(), timeoutPromise]);
  clearTimeout(timer);
  if (result === TIMEOUT) {
    console.log(`[scheduler] tick HARD BUDGET (${TICK_BUDGET_MS}ms) РїСЂРµРІС‹С€РµРЅ РЅР° С€Р°РіРµ "${currentStep}", lock СЃРЅРёРјР°СЋ`);
    try {
      if (env.BOT_KV) await env.BOT_KV.delete("scheduler_lock");
    } catch (e) { /* ignore */ }
    try {
      await notifyAdmin(env,
        `вљ пёЏ <b>РўРёРє РЅРµ СѓСЃРїРµР» Р·Р°РІРµСЂС€РёС‚СЊСЃСЏ</b> (Р±СЋРґР¶РµС‚ ${TICK_BUDGET_MS} РјСЃ, С€Р°Рі В«${currentStep}В»).\n` +
        `РЎР»РѕС‚РѕРІ/РїСѓР±Р»РёРєР°С†РёР№ СЃРµРіРѕРґРЅСЏ РјРѕР¶РµС‚ РЅРµ Р±С‹С‚СЊ вЂ” СЃР»РµРґРёС‚Рµ Р·Р° Р»РѕРіР°РјРё (<code>wrangler tail</code>).`);
    } catch (e) { /* ignore */ }
    return "timeout";
  }
  return result;
}
