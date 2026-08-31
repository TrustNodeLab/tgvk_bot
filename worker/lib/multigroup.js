// Мультигрупповая публикация в VK-группы DGC / LostLink / LostArt.
//
//  DGC      — игровые новости (RU) из RSS-лент, текстовый пост на стену.
//  LostLink — игровые новости (EN) из RSS-лент, адаптируются на русский LLM'ом.
//  LostArt  — ИИ-арты из ТГ-каналов: скачиваем картинку, декодируем JPEG/PNG
//             в RGBA, конвертируем в GIF и публикуем как GIF-документ
//             (docs.getWallUploadServer -> docs.save -> wall.post) — единственный
//             рабочий для группового токена способ показать картинку на стене.
//
// Расписание — окна по 30 минут в ЕКБ. Каждый слот группы публикует 1 пост;
// повтор за слот предотвращается KV-ключом `vk_posted:mg:<group>:<yyyymmdd>:<slot>`.
//
// Токены: VK_TOKEN_DGC / VK_TOKEN_LOSTLINK / VK_TOKEN_LOSTART (wrangler secret).
//
// Качество контента:
//  - EN-новости не переводятся дословно, а переписываются живым русским языком
//    (adaptNewsRu) + второй проход самокритики (critiqueMgText).
//  - Семантический дедуп: одна и та же новость из разных лент постится один раз
//    (Jaccard-похожесть нормализованных заголовков, порог MG_SIM_T).
//  - Кандидаты с .jpg/.png/.gif URL приоритетнее .webp (lossy VP8 не декодируем).
//  - Floyd-Steinberg дизеринг при квантизации GIF (toGifBytes -> rgbaToGif({dither})).
//
// Управление из бота:
//  - Конфиг (окна/ленты/каналы/режим согласования) хранится в KV `mg_config`,
//    редактируется командами /mg-edit, /mg-win, /mg-feed, /mg-chan, /mg-approve, /mg-reset.
//  - Режим согласования: перед постингом админу уходит превью с кнопками
//    ✅ Постить / ⏭ Пропустить (KV `mg_pending:<slug>:<slot>`).
//  - Ежедневный отчёт в 21:00 ЕКБ (mgDailyReport) и «мёртвый выключатель» —
//    алерт, если группа молчит дольше 12ч при пропущенных окнах (mgDeadManCheck).

import { ekbNow, parseRSS, parsePubDate, cleanRssTitle } from "./config.js";
import { vkUploadWallGifFor, vkPostWallFor, sendMessage } from "./telegram.js";
import { decodeJpeg } from "./jpeg.js";
import { rgbaToGif, pngToGif } from "./cardgen.js";

const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

// ---------- LLM: адаптация и самокритика ----------

// Переписывает новость живым русским языком (не дословный перевод).
// Возвращает {title, desc} или исходные значения при ошибке/отсутствии AI.
async function adaptNewsRu(env, title, desc) {
  if (!env.AI || typeof env.AI.run !== "function") {
    return { title, desc };
  }
  try {
    const res = await env.AI.run(AI_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "Ты редактор игрового новостного канала. Тебе дают заголовок и описание новости (возможно, на английском). " +
            "Перепиши её по-русски живым языком геймерского паблика: без канцелярита, без кальки с английского, " +
            "названия игр и имена не переводишь. Верни СТРОГО JSON вида " +
            '{"title":"заголовок до 120 символов","desc":"2-3 предложения, до 400 символов"}. Без пояснений.',
        },
        { role: "user", content: `Заголовок: ${title}\nОписание: ${desc || "(нет)"}` },
      ],
      max_tokens: 600,
    });
    const raw = (res?.response || "").trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { title, desc };
    const parsed = JSON.parse(m[0]);
    const outTitle = String(parsed.title || "").trim();
    const outDesc = String(parsed.desc || "").trim();
    return {
      title: outTitle.length >= 8 ? outTitle : title,
      desc: outDesc.length >= 20 ? outDesc : desc,
    };
  } catch (e) {
    console.log("[multigroup] adaptNewsRu error:", e.message);
    return { title, desc };
  }
}

// Второй проход: вычищает клише и пустые обобщения из готового текста поста.
async function critiqueMgText(env, text) {
  if (!env.AI || typeof env.AI.run !== "function") return text;
  try {
    const res = await env.AI.run(AI_MODEL, {
      messages: [
        {
          role: "system",
          content:
            "Отредактируй текст поста для VK-паблика: убери клише («в мире игр», «не может не радовать», «на повестке»), " +
            "водянистые фразы и повторы. Факты, цифры, названия и смысл сохрани. Верни только финальный текст без комментариев.",
        },
        { role: "user", content: text },
      ],
      max_tokens: 600,
    });
    const out = (res?.response || "").trim();
    return out.length > 40 ? out : text;
  } catch (e) {
    console.log("[multigroup] critiqueMgText error:", e.message);
    return text;
  }
}

// ---------- конфиг групп (дефолты + KV-оверрайды) ----------

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
    footer: "LostLink · игровые новости",
  },
  {
    slug: "lostart",
    name: "LostArt",
    groupId: 226242897,
    tokenKey: "VK_TOKEN_LOSTART",
    kind: "art",
    lang: "en",
    footer: "LostArt · ИИ-арты",
  },
];

// Окна в минутах от полуночи ЕКБ (каждое длится MULTI_WINDOW_LEN_MIN, 1 пост за слот).
export const MULTI_WINDOWS = {
  dgc: [5 * 60, 10 * 60, 15 * 60, 20 * 60],
  lostlink: [8 * 60, 11 * 60, 14 * 60, 17 * 60, 20 * 60],
  lostart: [9 * 60, 12 * 60, 15 * 60, 18 * 60],
};
export const MULTI_WINDOW_LEN_MIN = 30;

const FEEDS_RU = [
  "https://www.playground.ru/rss/news.xml",
  "https://vgtimes.ru/news/rss.xml",
  "https://dtf.ru/rss/all",
];
const FEEDS_EN = [
  "https://www.pcgamer.com/rss/",
  "https://www.polygon.com/rss/index.xml",
  "https://www.eurogamer.net/feed/",
  "https://www.rockpapershotgun.com/feed/",
  "https://www.vg247.com/feed/",
];
export const MULTI_FEEDS = { ru: FEEDS_RU, en: FEEDS_EN };

export const ART_CHANNELS = [
  // aiart последним: стабильно отдаёт таймаут, не должен тормозить рабочие каналы
  "aiartcommunity",
  "neuralart",
  "promptart",
  "aipainting",
  "psychedelic_ai",
  "aiart",
];

const MG_CONFIG_KEY = "mg_config";
const DEFAULT_CONFIG = () => ({
  windows: JSON.parse(JSON.stringify(MULTI_WINDOWS)),
  feeds: { ru: [...FEEDS_RU], en: [...FEEDS_EN] },
  channels: [...ART_CHANNELS],
  approval: false, // режим согласования: превью админу перед постингом
});

// Загружает конфиг мультигрупп из KV (или дефолт). Мержит поэлементно,
// чтобы частичный оверрайд не стирал остальные поля.
export async function loadMgConfig(env) {
  const def = DEFAULT_CONFIG();
  try {
    const raw = await env.BOT_KV.get(MG_CONFIG_KEY);
    if (!raw) return def;
    const saved = JSON.parse(raw);
    if (saved.windows && typeof saved.windows === "object") {
      for (const slug of Object.keys(def.windows)) {
        if (Array.isArray(saved.windows[slug])) def.windows[slug] = saved.windows[slug].map(Number).filter((n) => n >= 0 && n < 1440);
      }
    }
    if (saved.feeds && typeof saved.feeds === "object") {
      for (const lang of ["ru", "en"]) {
        if (Array.isArray(saved.feeds[lang])) def.feeds[lang] = saved.feeds[lang].filter((u) => /^https?:\/\//.test(u));
      }
    }
    if (Array.isArray(saved.channels)) def.channels = saved.channels.filter((c) => /^[\w\d_]+$/.test(c));
    def.approval = !!saved.approval;
  } catch (e) { /* битый конфиг — работаем на дефолтах */ }
  return def;
}

// Сохраняет конфиг целиком (используется /mg-* командами).
export async function saveMgConfig(env, cfg) {
  await env.BOT_KV.put(MG_CONFIG_KEY, JSON.stringify(cfg));
}

// Сброс к дефолтам (/mg-reset).
export async function resetMgConfig(env) {
  await env.BOT_KV.delete(MG_CONFIG_KEY);
  return DEFAULT_CONFIG();
}

const REQUEST_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; TrustNodeBot/1.0)",
  Accept: "*/*",
};

// Максимум символов в текстовом посте VK (стена — до 16384, берём с запасом).
const VK_POST_LIMIT = 3000;

// ---------- окна ----------

// Активно ли сейчас какое-то окно группы (в ЕКБ). Возвращает start окна или null.
// windows — опциональный оверрайд (из loadMgConfig); по умолчанию дефолтные окна.
export function activeMultiWindow(group, now = new Date(), windows = MULTI_WINDOWS) {
  const ekb = ekbNow(now);
  const mod = ekb.minuteOfDay;
  for (const start of windows[group.slug] || []) {
    if (mod >= start && mod < start + MULTI_WINDOW_LEN_MIN) return start;
  }
  return null;
}

// Ключ занятости слота: дата + старт окна (ЕКБ).
function slotKey(group, slotStart, now = new Date()) {
  return `vk_posted:mg:${group.slug}:${ekbNow(now).date}:${slotStart}`;
}

// ---------- семантический дедуп заголовков ----------

const TITLES_KEY = "mg_titles";
const MG_SIM_T = 0.55; // порог Jaccard-похожести (0..1)

// Нормализованный набор слов заголовка: нижний регистр, без пунктуации,
// слова короче 4 символов выбрасываются (предлоги/мусор).
export function titleFingerprint(title) {
  const words = String(title || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  return new Set(words);
}

// Jaccard-похожесть двух множеств слов: |A∩B| / |A∪B|.
export function titleSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

// Недавние отпечатки заголовков (все группы вместе — дубль между DGC и LostLink тоже ловим).
async function loadRecentTitles(env) {
  try {
    const raw = await env.BOT_KV.get(TITLES_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const cutoff = Date.now() - 48 * 3600 * 1000;
    return list.filter((t) => t.ts > cutoff);
  } catch (e) {
    return [];
  }
}

async function rememberTitle(env, fp) {
  try {
    const list = await loadRecentTitles(env);
    list.push({ fp: [...fp], ts: Date.now() });
    await env.BOT_KV.put(TITLES_KEY, JSON.stringify(list.slice(-120)));
  } catch (e) { /* некритично */ }
}

// Дубль ли этот заголовок среди недавних?
async function isDuplicateTitle(env, title) {
  const fp = titleFingerprint(title);
  const recent = await loadRecentTitles(env);
  for (const r of recent) {
    if (titleSimilarity(fp, new Set(r.fp)) >= MG_SIM_T) return true;
  }
  return false;
}

// ---------- RSS-сканирование ----------

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

// Собирает свежие новости из лент нужного языка. feedsOverride — список URL
// из KV-конфига; по умолчанию дефолтные ленты.
export async function fetchMultiFeeds(lang, { limit = 20, maxAgeMs = 24 * 3600 * 1000 } = {}, feedsOverride = null) {
  const feeds = feedsOverride || MULTI_FEEDS[lang] || [];
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
  // Дедуп внутри выборки: одинаковые/похожие заголовки из разных лент — оставляем первый.
  const seen = [];
  const unique = items.filter((it) => {
    const fp = titleFingerprint(it.title);
    for (const s of seen) {
      if (titleSimilarity(fp, s) >= MG_SIM_T) return false;
    }
    seen.push(fp);
    return true;
  });
  unique.sort((a, b) => (b.pub_ts || 0) - (a.pub_ts || 0));
  return unique.slice(0, limit);
}

// Приоритет картинки по расширению URL: jpg/png/gif раньше webp/unknown
// (lossy VP8 внутри WebP мы не декодируем — такие кандидаты уходят в конец).
function imageScore(url) {
  if (/\.(jpe?g|png|gif)(\?|$)/i.test(url || "")) return 0;
  if (/\.webp(\?|$)/i.test(url || "")) return 2;
  return 1;
}

// ---------- ТГ-арты ----------

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

export async function fetchArtFromChannel(channel) {
  const url = `https://t.me/s/${channel}`;
  const res = await fetch(url, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`t.me/s/${channel}: HTTP ${res.status}`);
  const html = await res.text();
  const blocks = parseTgArtBlocks(html, channel);
  if (!blocks.length) return null;
  for (const block of blocks.slice(0, 8)) {
    try {
      const imgRes = await fetch(block.image, { headers: { ...REQUEST_HEADERS, Accept: "image/jpeg, image/png, image/gif" }, signal: AbortSignal.timeout(10000) });
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
// maxSide=720: большие арты уменьшаются — иначе квантизация+LZW на мегапикселях
// выбивают лимит CPU воркера (outcome=exceededCpu). Дизеринг выключен по той же причине.
export async function toGifBytes(bytes, { dither = false, maxSide = 720 } = {}) {
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return bytes; // уже GIF
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    try {
      const dec = decodeJpeg(bytes);
      return rgbaToGif(dec.width, dec.height, dec.px, { dither, maxSide });
    } catch (e) {
      console.log(`[toGifBytes] JPEG decode failed: ${e.message}`);
      return null;
    }
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return pngToGif(bytes, { dither, maxSide });
  }
  // WebP detection (RIFF....WEBP)
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    console.log(`[toGifBytes] WebP image not supported (${bytes.length} bytes)`);
    return null;
  }
  console.log(`[toGifBytes] Unknown format: 0x${(bytes[0]||0).toString(16)}${(bytes[1]||0).toString(16)}${(bytes[2]||0).toString(16)}${(bytes[3]||0).toString(16)} (${bytes.length} bytes)`);
  return null;
}

// Подпись для арта: канал + дата. Без генерации текста (модель не нужна).
export function artCaption(art) {
  const ch = art && art.channel ? `\n🎨 Канал: @${art.channel}` : "";
  const stamp = art && art.time ? `\n🕒 ${String(art.time).slice(0, 10)}` : "";
  return `🌌 Искусственный интеллект · ИИ-арт` + ch + stamp;
}

// ---------- сборка контента (без публикации) ----------

// Готовит новость: текст + вложение. Не постит. Бросает, если публиковать нечего.
async function buildNewsPayload(env, group, cfg) {
  const items = await fetchMultiFeeds(group.lang, { limit: 12 }, cfg.feeds[group.lang]);
  if (!items.length) throw new Error("нет свежих новостей в лентах");

  let used = new Set();
  try {
    const keys = await listKvKeys(env);
    const prefix = `vk_posted:mg:${group.slug}:guid:`;
    for (const k of keys || []) if (k.startsWith(prefix)) used.add(k.slice(prefix.length));
  } catch (e) { /* KV недоступен — дедуп пропускаем */ }

  const candidates = items
    .filter((i) => !used.has(String(i.guid || "").slice(0, 120)))
    // приоритет кандидатам с конвертируемыми картинками
    .sort((a, b) => imageScore(a.image) - imageScore(b.image))
    .slice(0, 4);
  if (!candidates.length) throw new Error("все свежие новости уже опубликованы");

  let lastErr = null;
  for (const it of candidates) {
    try {
      let title = cleanRssTitle(it.title).slice(0, 200);
      let desc = String(it.description || "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);

      // Семантический дедуп: похожая новость уже выходила в любой группе — пропускаем.
      if (await isDuplicateTitle(env, title)) {
        console.log(`[multigroup] ${group.name}: дубль заголовка, пропускаю: ${title.slice(0, 50)}`);
        continue;
      }

      // Адаптация на русский (EN-ленты) + самокритика.
      if (group.lang === "en") {
        const adapted = await adaptNewsRu(env, title, desc);
        title = adapted.title;
        desc = adapted.desc;
      }
      const critiqued = group.lang === "ru" ? `${title}\n${desc}` : await critiqueMgText(env, `${title}\n${desc}`);
      const nl = critiqued.indexOf("\n");
      if (nl > 0) {
        title = critiqued.slice(0, nl).trim() || title;
        desc = critiqued.slice(nl + 1).trim() || desc;
      }

      const text = (`🎮 ${title}\n\n${desc ? desc + "\n\n" : ""}🔗 Подробнее: ${it.link}\n${group.footer}`).slice(0, VK_POST_LIMIT);

      const attachment = await uploadImageAsDoc(env, it.image, group, token_of(env, group));

      return { text, attachment, guidKey: String(it.guid || "").slice(0, 120) };
    } catch (e) {
      lastErr = e;
      console.log(`[multigroup] ${group.name}: кандидат не прошёл (${e.message}), пробую следующий`);
    }
  }
  throw lastErr || new Error("все кандидаты не прошли");
}

function token_of(env, group) {
  return env[group.tokenKey];
}

// Готовит арт: подпись + вложение. Не постит.
async function buildArtPayload(env, group, cfg) {
  let used = new Set();
  const usedPrefix = `vk_posted:mg:${group.slug}:guid:`;
  try {
    const keys = await listKvKeys(env);
    for (const k of keys || []) if (k.startsWith(usedPrefix)) used.add(k.slice(usedPrefix.length));
  } catch (e) { /* KV недоступен */ }

  for (const channel of cfg.channels) {
    const art = await fetchArtFromChannel(channel).catch(() => null);
    if (!art) continue;
    const idKey = `${channel}:${art.post}`;
    if (used.has(idKey)) continue;
    const gifBytes = await toGifBytes(art.bytes).catch(() => null);
    if (!gifBytes) continue;
    const attachment = await vkUploadWallGifFor(env, gifBytes, env[group.tokenKey], group.groupId);
    return { text: artCaption(art), attachment, guidKey: idKey };
  }
  throw new Error("нет доступных артов (все каналы без картинок или уже использованы)");
}

// Скачивает картинку и грузит как GIF-док. Ошибки не роняют пост — вернёт null.
async function uploadImageAsDoc(env, imageUrl, group, token) {
  if (!imageUrl) return null;
  try {
    const imgRes = await fetch(imageUrl, { headers: { ...REQUEST_HEADERS, Accept: "image/jpeg, image/png, image/gif" }, signal: AbortSignal.timeout(10000) });
    if (!imgRes.ok) {
      console.log(`[multigroup] ${group.name}: image HTTP ${imgRes.status} ${imageUrl.slice(0, 80)}`);
      return null;
    }
    const imgBytes = new Uint8Array(await imgRes.arrayBuffer());
    if (imgBytes.length <= 12) return null;
    const gifBytes = await toGifBytes(imgBytes);
    if (!gifBytes) {
      console.log(`[multigroup] ${group.name}: формат картинки не поддерживается (${imageUrl.slice(0, 60)})`);
      return null;
    }
    return await vkUploadWallGifFor(env, gifBytes, token, group.groupId);
  } catch (e) {
    console.log(`[multigroup] ${group.name}: image error: ${e.message} (${imageUrl.slice(0, 80)})`);
    return null;
  }
}

// ---------- публикация / согласование ----------

// Публикует один пост для группы, если её слот сейчас активен и ещё не занят.
// В режиме согласования (cfg.approval) вместо постинга уходит превью админу.
// opts.force — ручной тик (кнопка «🚀» / /mg-tick): публикует вне окна,
// слот-ключ в этом случае привязан к часу, чтобы ручной пост не блокировал окно.
export async function publishMultiGroup(env, group, now = new Date(), opts = {}) {
  const cfg = await loadMgConfig(env);
  const token = env[group.tokenKey];
  if (!token) {
    return { slug: group.slug, posted: false, detail: `нет токена ${group.tokenKey}` };
  }
  const slot = activeMultiWindow(group, now, cfg.windows);
  const force = !!opts.force;
  if (slot === null && !force) {
    return { slug: group.slug, posted: false, detail: "не активный слот" };
  }
  const key = slotKey(group, slot === null ? `manual-${ekbNow(now).hour}` : slot, now);

  let already = false;
  try {
    already = !!(await env.BOT_KV.get(key));
  } catch (e) {
    /* KV недоступен — публикуем */
  }
  if (already) {
    return { slug: group.slug, posted: false, detail: "слот уже занят" };
  }

  // Собираем контент (адаптация/critique/дедуп/картинка) — но ещё не постим.
  let payload;
  try {
    payload = group.kind === "art"
      ? await buildArtPayload(env, group, cfg)
      : await buildNewsPayload(env, group, cfg);
  } catch (e) {
    throw new Error(`${group.name}: ${e.message}`);
  }

  if (cfg.approval) {
    const sent = await sendApprovalPreview(env, group, slot, key, payload);
    return sent
      ? { slug: group.slug, posted: false, detail: "превью отправлено на согласование" }
      : { slug: group.slug, posted: false, detail: "не удалось отправить превью" };
  }

  const postId = await commitPost(env, group, key, payload);
  return { slug: group.slug, posted: true, detail: `post_id=${postId}` };
}

// Финальная публикация собранного payload: wall.post + все KV-отметки.
async function commitPost(env, group, key, payload) {
  const token = env[group.tokenKey];
  const res = await vkPostWallFor(env, token, group.groupId, payload.text, payload.attachment);
  const postId = res && res.post_id;
  try {
    await env.BOT_KV.put(key, String(postId || 1), { expirationTtl: 2 * 24 * 3600 });
    if (payload.guidKey) {
      await env.BOT_KV.put(`vk_posted:mg:${group.slug}:guid:${payload.guidKey}`, String(postId || 1), { expirationTtl: 2 * 24 * 3600 });
    }
    await env.BOT_KV.put(`mg_last_post:${group.slug}`, String(Date.now()), { expirationTtl: 3 * 24 * 3600 });
  } catch (e) { /* некритично */ }
  if (payload.text) {
    const titleLine = payload.text.split("\n")[0] || "";
    await rememberTitle(env, titleFingerprint(titleLine));
  }
  return postId;
}

// Превью на согласование: сообщение админу + inline-кнопки ✅/⏭.
async function sendApprovalPreview(env, group, slot, key, payload) {
  const chatId = env.TELEGRAM_ADMIN_CHAT_ID;
  if (!chatId) return false;
  const pendingId = `${group.slug}:${slot}`;
  try {
    await env.BOT_KV.put(
      `mg_pending:${pendingId}`,
      JSON.stringify({ slug: group.slug, key, text: payload.text, attachment: payload.attachment, guidKey: payload.guidKey }),
      { expirationTtl: 3 * 3600 }
    );
    const kb = {
      inline_keyboard: [[
        { text: "✅ Постить", callback_data: `mg:ok:${pendingId}` },
        { text: "⏭ Пропустить", callback_data: `mg:skip:${pendingId}` },
      ]],
    };
    await sendMessage(env, chatId, `👥 <b>${esc(group.name)}</b> — черновик слота\n\n${esc(payload.text)}`, {
      parse_mode: "HTML",
      reply_markup: kb,
    });
    return true;
  } catch (e) {
    console.log("[multigroup] approval preview error:", e.message);
    return false;
  }
}

function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Колбэк «✅ Постить» из превью. Возвращает текст для ответа на колбэк.
export async function approvePending(env, pendingId) {
  const raw = await env.BOT_KV.get(`mg_pending:${pendingId}`);
  if (!raw) return "черновик не найден (истёк или уже обработан)";
  const p = JSON.parse(raw);
  const group = MULTI_GROUPS.find((g) => g.slug === p.slug);
  if (!group) return "неизвестная группа";
  const postId = await commitPost(env, group, p.key, p);
  await env.BOT_KV.delete(`mg_pending:${pendingId}`);
  return `опубликовано в ${group.name} (post_id=${postId})`;
}

// Колбэк «⏭ Пропустить»: закрываем слот без постинга.
export async function skipPending(env, pendingId) {
  const raw = await env.BOT_KV.get(`mg_pending:${pendingId}`);
  if (!raw) return "черновик не найден (истёк или уже обработан)";
  const p = JSON.parse(raw);
  await env.BOT_KV.put(p.key, "skipped", { expirationTtl: 2 * 24 * 3600 });
  await env.BOT_KV.delete(`mg_pending:${pendingId}`);
  return "слот пропущен";
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
  const cfg = await loadMgConfig(env);
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
    let lastPostAgo = null;
    try {
      const ts = Number(await env.BOT_KV.get(`mg_last_post:${g.slug}`));
      if (ts > 0) {
        const mins = Math.round((Date.now() - ts) / 60000);
        lastPostAgo = mins < 60 ? `${mins} мин назад` : `${Math.round(mins / 60)} ч назад`;
      }
    } catch (e) { /* ignore */ }
    rows.push({
      slug: g.slug,
      name: g.name,
      token: env[g.tokenKey] ? "✓" : "✗",
      slot: activeMultiWindow(g, new Date(), cfg.windows) !== null ? "активен" : "—",
      postedToday,
      lastPostAgo,
      wins: (cfg.windows[g.slug] || []).slice().sort((a, b) => a - b).map(fmtMin).join(" "),
    });
  }
  rows.approval = cfg.approval;
  return rows;
}

// Основная точка входа из scheduler.tick: гонит все группы, у которых сейчас
// активен слот, по одному посту на группу. Группы обрабатываются ПАРАЛЛЕЛЬНО —
// иначе последняя группа (LostArt) не укладывалась в бюджет тика из-за
// суммарного времени RSS+картинок+VK предыдущих.
// opts.force — ручной запуск («🚀 Всем»): публикует вне окон.
export async function multigroupTick(env, now = new Date(), opts = {}) {
  const settled = await Promise.allSettled(
    MULTI_GROUPS.map((g) => publishMultiGroup(env, g, now, opts))
  );
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { slug: MULTI_GROUPS[i].slug, posted: false, detail: (r.reason && r.reason.message) || "ошибка" }
  );
}

// Тик одной группы (кнопки «🚀 DGC/LostLink/LostArt» в боте). Ручной запуск —
// публикует и вне окна (force), иначе кнопкой нельзя ничего проверить/починить.
export async function multigroupTickGroup(env, slug, now = new Date()) {
  const g = MULTI_GROUPS.find((x) => x.slug === slug);
  if (!g) return { slug, posted: false, detail: "неизвестная группа" };
  try {
    return await publishMultiGroup(env, g, now, { force: true });
  } catch (e) {
    return { slug, posted: false, detail: e.message };
  }
}

// ---------- ежедневный отчёт (21:00 ЕКБ) ----------

// Возвращает текст отчёта или null (если сегодня уже отправлен / рано).
export async function mgDailyReport(env, now = new Date()) {
  const ekb = ekbNow(now);
  if (ekb.hour !== 21 || ekb.minute >= 10) return null;
  const flagKey = `mg_report:${ekb.date}`;
  try { if (await env.BOT_KV.get(flagKey)) return null; } catch (e) { /* ignore */ }

  const cfg = await loadMgConfig(env);
  let keys = null;
  try { keys = await listKvKeys(env); } catch (e) {}
  const lines = [];
  for (const g of MULTI_GROUPS) {
    const wins = (cfg.windows[g.slug] || []).slice().sort((a, b) => a - b);
    const expected = wins.filter((w) => w <= ekb.minuteOfDay).length;
    let postedToday = 0;
    if (keys) {
      const prefix = `vk_posted:mg:${g.slug}:`;
      postedToday = keys.filter((k) => k.startsWith(prefix) && k.includes(ekb.date)).length;
    }
    const ok = postedToday >= expected;
    lines.push(`${ok ? "✅" : "⚠️"} <b>${esc(g.name)}</b>: ${postedToday}/${expected} постов`);
  }
  lines.push(`📋 Согласование: ${cfg.approval ? "включено" : "выключено"}`);
  try { await env.BOT_KV.put(flagKey, "1", { expirationTtl: 2 * 24 * 3600 }); } catch (e) {}
  return `📊 <b>Отчёт мультигрупп за ${ekb.date}</b>\n${lines.join("\n")}`;
}

// ---------- мёртвый выключатель ----------

const DEAD_HOURS = 12;

// Алерт, если группа должна была постить (первое окно прошло больше часа назад),
// но сегодня 0 постов и последний пост старше DEAD_HOURS. Один алерт в сутки.
export async function mgDeadManCheck(env, now = new Date()) {
  const ekb = ekbNow(now);
  const cfg = await loadMgConfig(env);
  const alerts = [];
  for (const g of MULTI_GROUPS) {
    const wins = (cfg.windows[g.slug] || []).slice().sort((a, b) => a - b);
    if (!wins.length) continue;
    const firstWin = wins[0];
    if (ekb.minuteOfDay < firstWin + 60) continue; // ещё рано бить тревогу
    const alertKey = `mg_alert:${ekb.date}:${g.slug}`;
    try { if (await env.BOT_KV.get(alertKey)) continue; } catch (e) {}

    let postedToday = 0;
    let keys = null;
    try { keys = await listKvKeys(env); } catch (e) {}
    if (keys) {
      const prefix = `vk_posted:mg:${g.slug}:`;
      postedToday = keys.filter((k) => k.startsWith(prefix) && k.includes(ekb.date)).length;
    }
    if (postedToday > 0) continue;

    let lastTs = 0;
    try { lastTs = Number(await env.BOT_KV.get(`mg_last_post:${g.slug}`)) || 0; } catch (e) {}
    const silentMs = lastTs ? Date.now() - lastTs : Infinity;
    if (silentMs < DEAD_HOURS * 3600 * 1000) continue;

    alerts.push(`🚨 <b>${esc(g.name)}</b>: сегодня 0 постов, окно ${fmtMin(firstWin)} пропущено` +
      (lastTs ? `, последний пост ${Math.round(silentMs / 3600000)} ч назад` : ", постов не было вообще"));
    try { await env.BOT_KV.put(alertKey, "1", { expirationTtl: 2 * 24 * 3600 }); } catch (e) {}
  }
  return alerts.length ? alerts.join("\n") : null;
}

function fmtMin(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
