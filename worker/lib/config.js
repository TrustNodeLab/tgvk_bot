// Константы и утилиты бота: часовой пояс МСК, окна публикации, лимиты, футер.
export const MSK_OFFSET_MIN = 3 * 60; // UTC+3

// Окна публикации дайджестов (минуты от полуночи МСК).
// Идеальная формула канала: 3 дайджеста в день — утро (09:00),
// день (13:00) и вечер (18:00). В каждом — сводка 3-5 свежих новостей.
// Публикация — ровно в начале окна.
export const NEWS_WINDOWS = [
  { start: 9 * 60, end: 12 * 60, cap: 1, slug: "morning", label: "утро" },
  { start: 13 * 60, end: 17 * 60, cap: 1, slug: "day", label: "день" },
  { start: 18 * 60, end: 24 * 60, cap: 1, slug: "evening", label: "вечер" },
];

// Дайджест: минимум и максимум новостей в сводке. MAX=3, чтобы весь выпуск
// (булеты по ~180 симв. + 2 совета + футер) влезал в лимит TG 1024 симв.
export const DIGEST_MIN_ITEMS = 3;
export const DIGEST_MAX_ITEMS = 3;

// Свежесть новости для поста: не старше 24 часов, приоритет последним 6 часам.
export const MAX_AGE_MS = 24 * 3600 * 1000;
export const FRESH_MS = 6 * 3600 * 1000;

// Якорь свежести предмета (кандидат/пакет/черновик/диспатч): дата статьи, если
// известна, иначе момент появления в конвейере. Возвращает epoch ms или null.
export function itemAgeMs(item) {
  if (!item) return null;
  for (const f of ["pub_ts", "found_at", "created_at", "queued_at", "at", "scheduled_for"]) {
    const v = item[f];
    if (v === null || v === undefined || v === "") continue;
    const t = typeof v === "number" ? v : Date.parse(String(v));
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

// Новость протухла, если с якоря свежести прошло больше MAX_AGE_MS.
// Отсутствие якоря не считаем протухшим (ручные/служебные посты).
export function isStaleItem(item, now = Date.now()) {
  const t = itemAgeMs(item);
  return t === null ? false : now - t > MAX_AGE_MS;
}

export const MAX_CANDIDATES_QUEUE = 20;

// Admin-черновики: без ответа 30 минут -> отложенный слот.
export const DRAFT_TIMEOUT_MIN = 30;

// Telegram ограничивает caption фото 1024 символами.
export const TG_CAPTION_LIMIT = 1024;

export const RUSTORE_URL = "https://www.rustore.ru/catalog/app/com.frauddetector.app";
export const SITE_URL = "https://trustnodelab.github.io";
export const PRODUCT_RADAR_URL = "https://productradar.ru/product/trustnode/";
export const POST_FOOTER =
  "🛡️ TrustNode\n" +
  `📲 Скачать приложение: ${RUSTORE_URL}\n` +
  `🌐 Сайт проекта: ${SITE_URL}\n` +
  `📄 Product Radar: ${PRODUCT_RADAR_URL}`;

// Минимальный RSS-парсер без зависимостей.
export function decodeEntities(s) {
  return (s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, "&");
}

// Чистит сырой RSS-заголовок: убирает обёртки <![CDATA[...]]>, раскодирует
// entities и срезает хвост «Источник: <url>», который некоторые ленты (tass,
// gazeta) вставляют прямо в title.
export function cleanRssTitle(s) {
  let t = String(s || "")
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .trim();
  t = decodeEntities(t);
  t = t.replace(/\s+источник\s*:\s*https?:\/\/\S+\s*$/i, "").trim();
  t = t.replace(/\s*[—–-]\s*источник\s*:\s*https?:\/\/\S+\s*$/i, "").trim();
  return t;
}

export function parseRSS(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
      const mm = block.match(re);
      return mm ? decodeEntities(mm[1]).trim() : "";
    };
    const title = cleanRssTitle(get("title"));
    const link = get("link");
    const guid = get("guid") || link || title;
    const description = get("description");
    const pub_date = get("pubDate") || get("dc:date");
    if (title && link) {
      items.push({ guid, title, link, description, pub_date });
    }
  }
  return items;
}

export function parsePubDate(raw) {
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  return Number.isNaN(t) ? null : new Date(t);
}

// Текущее время в МСК: {dow, hour, minute, minuteOfDay, iso}.
export function mskNow(date = new Date()) {
  const msk = new Date(date.getTime() + MSK_OFFSET_MIN * 60 * 1000);
  const dow = (msk.getUTCDay() + 6) % 7; // 0 = понедельник ... 6 = воскресенье
  const minuteOfDay = msk.getUTCHours() * 60 + msk.getUTCMinutes();
  const iso = msk.toISOString();
  return {
    dow,
    hour: msk.getUTCHours(),
    minute: msk.getUTCMinutes(),
    minuteOfDay,
    iso,
    date: msk.toISOString().slice(0, 10),
  };
}

// Склонение «пост/поста/постов».
export function plural(n, one, few, many) {
  const n10 = n % 10;
  const n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}
