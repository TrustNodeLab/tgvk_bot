// Мультигрупповая публикация в VK-группы DGC / LostLink / LostArt.
//
//  DGC      — игровые новости (RU) из RSS-лент, текстовый пост на стену.
//  LostLink — игровые новости (EN) из RSS-лент, текстовый пост.
//  LostArt  — ИИ-арты из ТГ-каналов: скачиваем картинку, декодируем JPEG/PNG
//             в RGBA, конвертируем в GIF и публикуем как GIF-документ
//             (docs.getWallUploadServer -> docs.save -> wall.post) — единственный
//             рабочий для группового токена способ показать картинку на стене.
//
// Расписание — окна по 30 минут в ЕКБ. Каждый слот группы публикует 1 пост;
// повтор за слот предотвращается KV-ключом `vk_posted:mg:<group>:<yyyymmdd>:<slot>`.
//
// Токены: VK_TOKEN_DGC / VK_TOKEN_LOSTLINK / VK_TOKEN_LOSTART (wrangler secret).

import { ekbNow, parseRSS, parsePubDate, cleanRssTitle } from "./config.js";
import { vkUploadWallGifFor, vkPostWallFor } from "./telegram.js";
import { decodeJpeg } from "./jpeg.js";
import { rgbaToGif, pngToGif } from "./cardgen.js";

// ---------- конфиг групп ----------

export const MULTI_GROUPS = [
  {
    slug: "dgc",
    name: "DGC",
    groupId: 224546089,
    tokenKey: "VK_TOKEN_DGC",
    kind: "news",
    lang: "ru",
    footer: "DGC · игровые новости",
  },
  {
    slug: "lostlink",
    name: "LostLink",
    groupId: 226087950,
    tokenKey: "VK_TOKEN_LOSTLINK",
    kind: "news",
    lang: "en",
    footer: "LostLink · gaming news",
  },
  {
    slug: "lostart",
    name: "LostArt",
    groupId: 226242897,
    tokenKey: "VK_TOKEN_LOSTART",
    kind: "art",
    lang: "en",
    footer: "LostArt · AI art",
  },
];

// Окна в минутах от полуночи ЕКБ (каждое длится MULTI_WINDOW_LEN_MIN, 1 пост за слот).
export const MULTI_WINDOWS = {
  dgc: [5 * 60, 10 * 60, 15 * 60, 20 * 60],
  lostlink: [8 * 60, 11 * 60, 14 * 60, 17 * 60, 20 * 60],
  lostart: [9 * 60, 12 * 60, 15 * 60, 18 * 60],
};
export const MULTI_WINDOW_LEN_MIN = 30;

// ---------- RSS-ленты ----------

const FEEDS_RU = [
  "https://www.playground.ru/rss/news.xml",
  "https://vgtimes.ru/news/rss.xml",
  "https://dtf.ru/rss/all",
];
// Подтверждённые работоспособными EN-ленты (все отдают 200):
const FEEDS_EN = [
  "https://www.pcgamer.com/rss/",
  "https://www.polygon.com/rss/index.xml",
  "https://www.eurogamer.net/feed/",
  "https://www.rockpapershotgun.com/feed/",
  "https://www.vg247.com/feed/",
];
export const MULTI_FEEDS = { ru: FEEDS_RU, en: FEEDS_EN };

// ТГ-каналы с ИИ-артами (утверждены пользователем, все 6).
export const ART_CHANNELS = [
  "aiart",
  "aiartcommunity",
  "neuralart",
  "promptart",
  "aipainting",
  "psychedelic_ai",
];

const REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; TrustNodeBot/1.0)",
  Accept: "*/*",
};

// Максимум символов в текстовом посте VK (стена — до 16384, берём с запасом).
const VK_POST_LIMIT = 3000;

// ---------- окна ----------

// Активно ли сейчас какое-то окно группы (в ЕКБ). Возвращает start окна или null.
export function activeMultiWindow(group, now = new Date()) {
  const ekb = ekbNow(now);
  const mod = ekb.minuteOfDay;
  for (const start of MULTI_WINDOWS[group.slug] || []) {
    if (mod >= start && mod < start + MULTI_WINDOW_LEN_MIN) return start;
  }
  return null;
}

// Ключ занятости слота: дата + старт окна (ЕКБ).
function slotKey(group, slotStart, now = new Date()) {
  return `vk_posted:mg:${group.slug}:${ekbNow(now).date}:${slotStart}`;
}

// ---------- RSS-сканирование ----------

// Декодирует байты ленты (Windows-1251 для RU, иначе UTF-8), как в feeds.js.
function decodeFeedBytes(bytes) {
  const latin = new TextDecoder("latin1");
  const head = latin.decode(bytes.slice(0, 300));
  const m =
    /<\?xml[^>]*encoding=["']([^"']+)["']/i.exec(head) ||
    /charset=["']?([\w-]+)/i.exec(head);
  const declared = m ? m[1].toLowerCase() : "";
  if (declared && !/^utf-?8$/.test(declared)) {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch (e) {
      /* неизвестный label — пробуем дальше */
    }
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  if (text.includes("\uFFFD")) {
    try {
      return new TextDecoder("windows-1251").decode(bytes);
    } catch (e) {
      /* остаёмся на utf-8 */
    }
  }
  return text;
}

// Собирает свежие новости из лент нужного языка. Возвращает записи,
// отсортированные по дате публикации (новые первыми).
export async function fetchMultiFeeds(lang, { limit = 20, maxAgeMs = 24 * 3600 * 1000 } = {}) {
  const feeds = MULTI_FEEDS[lang] || [];
  const items = [];
  if (!feeds.length) return items;
  const settled = await Promise.allSettled(
    feeds.map(async (url) => {
      const res = await fetch(url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return [];
      const xml = decodeFeedBytes(new Uint8Array(await res.arrayBuffer()));
      const now = Date.now();
      const out = [];
      for (const item of parseRSS(xml)) {
        const pd = parsePubDate(item.pub_date);
        if (!pd || now - pd.getTime() > maxAgeMs) continue;
        out.push({ ...item, pub_ts: pd.getTime() });
      }
      return out;
    })
  );
  for (const r of settled) {
    if (r.status === "fulfilled") for (const it of r.value) items.push(it);
  }
  items.sort((a, b) => (b.pub_ts || 0) - (a.pub_ts || 0));
  return items.slice(0, limit);
}

// ---------- ТГ-арты ----------

// Парсит блоки t.me/s/<channel>: data-post, картинка, datetime. Возвращает
// список { post, image, time, channel } только с картинками (только https://).
export function parseTgArtBlocks(html, channel) {
  const out = [];
  const blockRe =
    /<div class="tgme_widget_message_wrap([\s\S]*?)(?=<div class="tgme_widget_message_wrap|<\/div>\s*<\/div>\s*<!--)/g;
  let m;
  while ((m = blockRe.exec(html)) !== null) {
    const b = m[1];
    const post = (b.match(/data-post="([^"]+)"/) || [])[1] || "";
    const time = (b.match(/datetime="([^"]+)"/) || [])[1] || "";
    const bg = (b.match(/background-image:url\('([^']+)'\)/) || [])[1] || "";
    const img = (b.match(/<img src="([^"]+)" class="tgme_widget_message_photo"/) || [])[1] || "";
    const image = [bg, img].find((s) => s.startsWith("https://"));
    if (!image || !post) continue;
    out.push({ post, image, time, channel });
  }
  return out;
}

// Скачивает свежий арт-кандидат с t.me/s/<channel> и возвращает { bytes, post, image, time, channel }.
export async function fetchArtFromChannel(channel) {
  const url = `https://t.me/s/${channel}`;
  const res = await fetch(url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`t.me/s/${channel}: HTTP ${res.status}`);
  const html = await res.text();
  const blocks = parseTgArtBlocks(html, channel);
  if (!blocks.length) return null;
  for (const block of blocks.slice(0, 8)) {
    try {
      const imgRes = await fetch(block.image, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(10000) });
      if (!imgRes.ok) continue;
      const bytes = new Uint8Array(await imgRes.arrayBuffer());
      if (bytes.length < 12) continue;
      return { bytes, post: block.post, image: block.image, time: block.time, channel };
    } catch (e) {
      continue;
    }
  }
  return null;
}

// ---------- конвертация картинки в GIF ----------

// Байты картинки -> GIF (для публикации GIF-доком). JPEG и PNG конвертируются
// в RGBA и обратно в GIF; готовый GIF возвращается без изменений.
export async function toGifBytes(bytes) {
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return bytes; // уже GIF
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const dec = decodeJpeg(bytes);
    return rgbaToGif(dec.width, dec.height, dec.px);
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return pngToGif(bytes);
  }
  throw new Error("арт не распознан как JPEG/PNG/GIF");
}

// Подпись для арта: канал + дата. Без генерации текста (модель не нужна).
export function artCaption(art) {
  const line = "🌌 LostArt · AI art";
  const ch = art && art.channel ? `\n🎨 Канал: @${art.channel}` : "";
  const stamp = art && art.time ? `\n🕒 ${String(art.time).slice(0, 10)}` : "";
  return line + ch + stamp;
}

// ---------- публикация ----------

// Публикует один пост для группы, если её слот сейчас активен и ещё не занят.
// Возвращает { slug, posted, detail }.
export async function publishMultiGroup(env, group, now = new Date()) {
  const token = env[group.tokenKey];
  if (!token) {
    return { slug: group.slug, posted: false, detail: `нет токена ${group.tokenKey}` };
  }
  const slot = activeMultiWindow(group, now);
  if (slot === null) {
    return { slug: group.slug, posted: false, detail: "не активный слот" };
  }
  const key = slotKey(group, slot, now);

  let already = false;
  try {
    already = !!(await env.BOT_KV.get(key));
  } catch (e) {
    /* KV недоступен — публикуем */
  }
  if (already) {
    return { slug: group.slug, posted: false, detail: "слот уже занят" };
  }

  let postId;
  try {
    if (group.kind === "art") {
      postId = await publishArt(env, group, token);
    } else {
      postId = await publishNews(env, group, token);
    }
  } catch (e) {
    throw new Error(`${group.name}: ${e.message}`);
  }

  try {
    await env.BOT_KV.put(key, String(postId || 1));
  } catch (e) {
    /* не критично */
  }
  return { slug: group.slug, posted: true, detail: `post_id=${postId}` };
}

async function publishNews(env, group, token) {
  const items = await fetchMultiFeeds(group.lang, { limit: 12 });
  if (!items.length) throw new Error("нет свежих новостей в лентах");
  // Пропускаем уже опубликованные по guid.
  let used = new Set();
  try {
    const keys = await listKvKeys(env);
    const prefix = `vk_posted:mg:${group.slug}:guid:`;
    for (const k of keys || []) if (k.startsWith(prefix)) used.add(k.slice(prefix.length));
  } catch (e) { /* KV недоступен — дедуп пропускаем */ }

  let it = items.find((i) => !used.has(String(i.guid || "").slice(0, 120)));
  if (!it) throw new Error("все свежие новости уже опубликованы сегодня");

  const title = cleanRssTitle(it.title).slice(0, 200);
  const desc = String(it.description || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  const text = (langBody(group.lang, title, desc, it.link) + `\n${group.footer}`).slice(0, VK_POST_LIMIT);

  const res = await vkPostWallFor(env, token, group.groupId, text, null);
  const postId = res && res.post_id;
  try {
    await env.BOT_KV.put(`vk_posted:mg:${group.slug}:guid:${String(it.guid || "").slice(0, 120)}`, String(postId || 1));
  } catch (e) { /* ignore */ }
  return postId;
}

function langBody(lang, title, desc, link) {
  if (lang === "ru") {
    return `🎮 ${title}\n\n${desc ? desc + "\n\n" : ""}🔗 ${link}`;
  }
  return `🎮 ${title}\n\n${desc ? desc + "\n\n" : ""}🔗 ${link}`;
}

async function publishArt(env, group, token) {
  let used = new Set();
  const usedPrefix = `vk_posted:mg:${group.slug}:guid:`;
  try {
    const keys = await listKvKeys(env);
    for (const k of keys || []) if (k.startsWith(usedPrefix)) used.add(k.slice(usedPrefix.length));
  } catch (e) { /* KV недоступен — дедуп пропускаем */ }

  for (const channel of ART_CHANNELS) {
    const art = await fetchArtFromChannel(channel).catch(() => null);
    if (!art) continue;
    const idKey = `${channel}:${art.post}`;
    if (used.has(idKey)) continue;
    const gifBytes = await toGifBytes(art.bytes).catch(() => null);
    if (!gifBytes) continue;
    const caption = artCaption(art);
    const attachment = await vkUploadWallGifFor(env, gifBytes, token, group.groupId);
    const res = await vkPostWallFor(env, token, group.groupId, caption, attachment);
    const postId = res && res.post_id;
    try { await env.BOT_KV.put(usedPrefix + idKey, String(postId || 1)); } catch (e) { /* ignore */ }
    return postId;
  }
  throw new Error("нет доступных артов (все каналы без картинок или уже использованы)");
}

// ---------- KV-хелперы ----------

async function listKvKeys(env) {
  if (env.BOT_KV && typeof env.BOT_KV.list === "function") {
    const page = await env.BOT_KV.list({ limit: 1000 });
    return (page && page.keys || []).map((k) => k.name);
  }
  return null;
}

// Сводка для /mg-статус.
export async function multiStatus(env) {
  const rows = [];
  let keys = null;
  try { keys = await listKvKeys(env); } catch (e) { keys = null; }
  const today = ekbNow().date;
  for (const g of MULTI_GROUPS) {
    let postedToday = 0;
    if (keys) {
      const prefix = `vk_posted:mg:${g.slug}:`;
      postedToday = keys.filter((k) => k.startsWith(prefix) && k.includes(today)).length;
    }
    rows.push({
      slug: g.slug,
      name: g.name,
      token: env[g.tokenKey] ? "✓" : "✗",
      slot: activeMultiWindow(g) !== null ? "активен" : "—",
      postedToday,
    });
  }
  return rows;
}

// Основная точка входа из scheduler.tick: гонит все группы, у которых сейчас
// активен слот, по одному посту на группу. Возвращает массив результатов.
export async function multigroupTick(env, now = new Date()) {
  const results = [];
  for (const g of MULTI_GROUPS) {
    try {
      results.push(await publishMultiGroup(env, g, now));
    } catch (e) {
      results.push({ slug: g.slug, posted: false, detail: e.message });
    }
  }
  return results;
}