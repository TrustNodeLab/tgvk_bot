var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// lib/limits.js
var MAX_HISTORY, MAX_CANDIDATES_QUEUE;
var init_limits = __esm({
  "lib/limits.js"() {
    MAX_HISTORY = 500;
    MAX_CANDIDATES_QUEUE = 20;
  }
});

// lib/config.js
function itemAgeMs(item) {
  if (!item) return null;
  for (const f of ["pub_ts", "found_at", "created_at", "queued_at", "at", "scheduled_for"]) {
    const v = item[f];
    if (v === null || v === void 0 || v === "") continue;
    const t = typeof v === "number" ? v : Date.parse(String(v));
    if (!Number.isNaN(t)) return t;
  }
  return null;
}
function isStaleItem(item, now = Date.now()) {
  const t = itemAgeMs(item);
  return t === null ? false : now - t > MAX_AGE_MS;
}
function decodeEntities(s) {
  return (s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, "&");
}
function parseRSS(xml) {
  const items = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const get = /* @__PURE__ */ __name((tag) => {
      const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
      const mm = block.match(re);
      return mm ? decodeEntities(mm[1]).trim() : "";
    }, "get");
    const title = get("title");
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
function parsePubDate(raw) {
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  return Number.isNaN(t) ? null : new Date(t);
}
function mskNow(date = /* @__PURE__ */ new Date()) {
  const msk = new Date(date.getTime() + MSK_OFFSET_MIN * 60 * 1e3);
  const dow = (msk.getUTCDay() + 6) % 7;
  const minuteOfDay = msk.getUTCHours() * 60 + msk.getUTCMinutes();
  const iso = msk.toISOString();
  return {
    dow,
    hour: msk.getUTCHours(),
    minute: msk.getUTCMinutes(),
    minuteOfDay,
    iso,
    date: msk.toISOString().slice(0, 10)
  };
}
var MSK_OFFSET_MIN, NEWS_WINDOWS, DIGEST_MIN_ITEMS, DIGEST_MAX_ITEMS, MAX_AGE_MS, FRESH_MS, DRAFT_TIMEOUT_MIN, TG_CAPTION_LIMIT, RUSTORE_URL, SITE_URL, PRODUCT_RADAR_URL, POST_FOOTER;
var init_config = __esm({
  "lib/config.js"() {
    MSK_OFFSET_MIN = 3 * 60;
    NEWS_WINDOWS = [
      { start: 9 * 60, end: 12 * 60, cap: 1, slug: "morning", label: "\u0443\u0442\u0440\u043E" },
      { start: 13 * 60, end: 17 * 60, cap: 1, slug: "day", label: "\u0434\u0435\u043D\u044C" },
      { start: 18 * 60, end: 24 * 60, cap: 1, slug: "evening", label: "\u0432\u0435\u0447\u0435\u0440" }
    ];
    DIGEST_MIN_ITEMS = 3;
    DIGEST_MAX_ITEMS = 5;
    MAX_AGE_MS = 24 * 3600 * 1e3;
    FRESH_MS = 6 * 3600 * 1e3;
    __name(itemAgeMs, "itemAgeMs");
    __name(isStaleItem, "isStaleItem");
    DRAFT_TIMEOUT_MIN = 30;
    TG_CAPTION_LIMIT = 1024;
    RUSTORE_URL = "https://www.rustore.ru/catalog/app/com.frauddetector.app";
    SITE_URL = "https://trustnodelab.github.io";
    PRODUCT_RADAR_URL = "https://productradar.ru/product/trustnode/";
    POST_FOOTER = `\u{1F6E1}\uFE0F TrustNode
\u{1F4F2} \u0421\u043A\u0430\u0447\u0430\u0442\u044C \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0435: ${RUSTORE_URL}
\u{1F310} \u0421\u0430\u0439\u0442 \u043F\u0440\u043E\u0435\u043A\u0442\u0430: ${SITE_URL}
\u{1F4C4} Product Radar: ${PRODUCT_RADAR_URL}`;
    __name(decodeEntities, "decodeEntities");
    __name(parseRSS, "parseRSS");
    __name(parsePubDate, "parsePubDate");
    __name(mskNow, "mskNow");
  }
});

// lib/text.js
function fitCaption(caption, limit = TG_CAPTION_LIMIT) {
  if (caption.length <= limit) return caption;
  let body = caption;
  let footer = "";
  if (caption.endsWith(POST_FOOTER)) {
    body = caption.slice(0, -POST_FOOTER.length).trimEnd();
    footer = "\n\n" + POST_FOOTER;
  }
  const budget = limit - footer.length - 1;
  if (budget <= 0) return caption.slice(0, Math.max(0, limit - 1)) + "\u2026";
  let cut = body.slice(0, budget).trimEnd();
  for (const sep of [". ", "! ", "? ", "\u2026", " ", "\u2014 "]) {
    const idx = cut.lastIndexOf(sep);
    if (idx > budget / 2) {
      cut = cut.slice(0, idx).trimEnd() + "\u2026";
      break;
    }
  }
  if (!cut.endsWith("\u2026")) cut = body.slice(0, budget - 1).trimEnd() + "\u2026";
  return cut + footer;
}
function escHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function markdownToHtml(src) {
  if (!src) return "";
  let s = String(src).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, u) => `<a href="${u}">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*/g, "");
  return s;
}
function stripMarkdown(src) {
  return String(src ?? "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*/g, "").replace(/\*/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim();
}
function fmtTime(iso, withYear = false) {
  if (!iso) return "\u2014";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = /* @__PURE__ */ __name((n) => String(n).padStart(2, "0"), "p");
  const date = `${p(d.getDate())}.${p(d.getMonth() + 1)}${withYear ? "." + d.getFullYear() : ""}`;
  return `${date} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
var init_text = __esm({
  "lib/text.js"() {
    init_config();
    __name(fitCaption, "fitCaption");
    __name(escHtml, "escHtml");
    __name(markdownToHtml, "markdownToHtml");
    __name(stripMarkdown, "stripMarkdown");
    __name(fmtTime, "fmtTime");
  }
});

// lib/font.js
var FONT_H, FONT;
var init_font = __esm({
  "lib/font.js"() {
    FONT_H = 16;
    FONT = {
      "A": [11, 12, 0, 30, 0, 22, 0, 18, 0, 51, 0, 50, 0, 33, 0, 33, 0, 119, 128, 127, 128, 97, 128, 64, 128, 192, 192, 192, 192, 128, 64, 0, 0],
      "B": [9, 254, 0, 214, 0, 195, 0, 131, 0, 195, 0, 194, 0, 254, 0, 214, 0, 195, 0, 129, 0, 193, 128, 129, 0, 195, 0, 255, 0, 236, 0, 0, 0],
      "C": [9, 63, 0, 106, 0, 64, 0, 192, 0, 192, 0, 128, 0, 192, 0, 128, 0, 192, 0, 192, 0, 192, 0, 64, 0, 96, 0, 127, 0, 22, 0, 0, 0],
      "D": [9, 254, 0, 215, 0, 193, 0, 129, 128, 193, 128, 129, 128, 192, 128, 193, 128, 129, 128, 193, 128, 129, 0, 193, 128, 195, 0, 254, 0, 218, 0, 0, 0],
      "E": [8, 127, 212, 192, 128, 192, 192, 254, 212, 192, 128, 192, 128, 192, 255, 61, 0],
      "F": [8, 126, 213, 192, 128, 192, 192, 254, 212, 192, 128, 192, 128, 192, 192, 128, 0],
      "G": [9, 63, 0, 106, 128, 64, 0, 192, 0, 192, 0, 128, 0, 193, 128, 128, 128, 193, 128, 193, 128, 128, 128, 193, 128, 101, 128, 123, 128, 28, 128, 0, 0],
      "H": [9, 193, 128, 128, 128, 193, 128, 128, 128, 193, 128, 193, 128, 255, 128, 213, 128, 193, 128, 129, 128, 192, 128, 129, 128, 193, 128, 192, 128, 129, 128, 0, 0],
      "I": [2, 192, 128, 192, 128, 192, 128, 192, 128, 192, 128, 192, 128, 192, 192, 128, 0],
      "J": [5, 24, 16, 24, 16, 24, 16, 24, 16, 24, 16, 24, 16, 56, 112, 64, 0],
      "K": [9, 195, 0, 130, 0, 198, 0, 140, 0, 200, 0, 152, 0, 240, 0, 240, 0, 216, 0, 140, 0, 204, 0, 134, 0, 194, 0, 195, 0, 129, 0, 0, 0],
      "L": [8, 192, 128, 192, 128, 192, 128, 192, 128, 192, 128, 192, 128, 192, 254, 62, 0],
      "M": [13, 224, 112, 224, 88, 176, 80, 208, 216, 144, 144, 216, 152, 216, 144, 137, 152, 201, 16, 141, 24, 199, 16, 135, 24, 196, 16, 192, 24, 128, 16, 0, 0],
      "N": [10, 224, 192, 224, 128, 176, 192, 208, 128, 208, 192, 152, 128, 200, 192, 140, 128, 204, 192, 132, 128, 198, 192, 130, 128, 195, 192, 195, 128, 129, 128, 0, 0],
      "O": [10, 62, 0, 107, 128, 97, 128, 193, 128, 192, 128, 128, 192, 192, 128, 128, 192, 192, 128, 192, 192, 192, 128, 65, 128, 99, 128, 126, 0, 26, 0, 0, 0],
      "P": [8, 254, 214, 195, 131, 193, 131, 195, 254, 212, 192, 128, 192, 128, 192, 128, 0],
      "Q": [10, 62, 0, 103, 128, 65, 128, 192, 128, 192, 192, 128, 128, 192, 192, 192, 128, 128, 192, 193, 128, 97, 128, 119, 0, 28, 0, 0, 0, 15, 0, 0, 0],
      "R": [9, 254, 0, 215, 0, 193, 0, 129, 128, 193, 0, 129, 128, 195, 0, 253, 0, 238, 0, 194, 0, 131, 0, 195, 0, 129, 0, 193, 128, 129, 0, 0, 0],
      "S": [8, 126, 212, 192, 128, 192, 192, 120, 62, 6, 3, 3, 1, 7, 250, 92, 0],
      "T": [10, 255, 192, 93, 0, 12, 0, 8, 0, 12, 0, 12, 0, 8, 0, 12, 0, 8, 0, 12, 0, 8, 0, 12, 0, 8, 0, 12, 0, 8, 0, 0, 0],
      "U": [9, 193, 128, 128, 128, 193, 128, 128, 128, 193, 128, 129, 128, 192, 128, 129, 128, 192, 128, 193, 128, 129, 128, 193, 128, 99, 0, 126, 0, 20, 0, 0, 0],
      "V": [11, 192, 64, 64, 64, 96, 192, 96, 192, 32, 128, 32, 128, 49, 128, 49, 128, 17, 0, 17, 0, 27, 0, 26, 0, 11, 0, 14, 0, 12, 0, 0, 0],
      "W": [17, 65, 193, 0, 97, 195, 0, 97, 65, 0, 99, 99, 0, 33, 67, 0, 99, 98, 0, 34, 35, 0, 50, 38, 0, 50, 54, 0, 54, 38, 0, 22, 52, 0, 52, 54, 0, 22, 20, 0, 28, 28, 0, 28, 28, 0, 0, 0, 0],
      "X": [11, 96, 64, 32, 192, 48, 128, 17, 128, 25, 0, 11, 0, 14, 0, 15, 0, 11, 0, 25, 0, 17, 128, 48, 128, 32, 192, 96, 192, 32, 64, 0, 0],
      "Y": [10, 192, 128, 65, 128, 97, 128, 97, 0, 35, 0, 50, 0, 22, 0, 30, 0, 28, 0, 12, 0, 12, 0, 8, 0, 12, 0, 12, 0, 8, 0, 0, 0],
      "Z": [8, 255, 87, 2, 6, 4, 12, 24, 16, 16, 48, 96, 64, 192, 255, 255, 0],
      "a": [8, 124, 126, 2, 3, 2, 3, 126, 127, 194, 195, 130, 215, 238, 115, 16, 0],
      "b": [8, 192, 128, 192, 128, 200, 222, 230, 195, 131, 193, 131, 195, 194, 238, 252, 0],
      "c": [8, 62, 122, 96, 192, 192, 128, 192, 128, 192, 192, 192, 96, 110, 60, 18, 0],
      "d": [8, 3, 1, 3, 1, 19, 127, 195, 195, 131, 193, 131, 195, 199, 117, 57, 0],
      "e": [8, 62, 122, 71, 195, 195, 195, 222, 254, 192, 192, 192, 100, 118, 62, 8, 0],
      "f": [8, 30, 52, 48, 48, 254, 48, 48, 32, 48, 32, 48, 32, 48, 48, 32, 0],
      "g": [10, 63, 128, 119, 0, 67, 0, 195, 0, 67, 0, 195, 0, 118, 0, 126, 0, 64, 0, 104, 0, 116, 0, 127, 0, 193, 0, 129, 128, 129, 0, 0, 0],
      "h": [8, 192, 128, 192, 128, 200, 222, 230, 195, 130, 195, 130, 195, 130, 195, 130, 0],
      "i": [2, 192, 128, 0, 0, 192, 128, 192, 128, 192, 128, 192, 128, 192, 192, 128, 0],
      "j": [3, 96, 64, 0, 64, 96, 64, 96, 64, 96, 64, 96, 64, 96, 64, 64, 0],
      "k": [8, 192, 128, 192, 128, 194, 140, 204, 152, 240, 208, 152, 204, 140, 198, 130, 0],
      "l": [4, 192, 128, 192, 128, 192, 128, 192, 128, 192, 128, 192, 128, 192, 224, 112, 0],
      "m": [14, 222, 120, 214, 176, 235, 156, 195, 8, 195, 12, 131, 8, 194, 12, 131, 8, 194, 12, 131, 8, 195, 12, 130, 8, 195, 12, 195, 12, 0, 0, 0, 0],
      "n": [8, 158, 214, 246, 195, 194, 195, 194, 195, 194, 195, 194, 195, 194, 195, 0, 0],
      "o": [8, 60, 126, 70, 195, 195, 131, 193, 195, 131, 195, 194, 71, 122, 124, 4, 0],
      "p": [8, 158, 236, 227, 195, 131, 193, 131, 195, 131, 194, 254, 220, 128, 192, 128, 0],
      "q": [8, 63, 111, 195, 195, 129, 195, 195, 129, 195, 199, 127, 49, 3, 3, 1, 0],
      "r": [6, 152, 216, 224, 192, 192, 128, 192, 128, 192, 192, 128, 192, 128, 192, 0, 0],
      "s": [8, 126, 250, 192, 128, 192, 192, 124, 60, 6, 3, 2, 11, 118, 254, 16, 0],
      "t": [7, 0, 48, 32, 52, 252, 48, 48, 32, 48, 32, 48, 32, 48, 60, 20, 0],
      "u": [8, 195, 130, 195, 130, 195, 130, 195, 130, 195, 130, 195, 206, 247, 114, 8, 0],
      "v": [10, 193, 128, 65, 128, 97, 0, 97, 0, 33, 0, 99, 0, 35, 0, 50, 0, 50, 0, 22, 0, 22, 0, 28, 0, 28, 0, 12, 0, 4, 0, 0, 0],
      "w": [15, 67, 132, 67, 12, 99, 140, 66, 136, 102, 140, 34, 200, 102, 136, 36, 216, 52, 88, 52, 208, 20, 88, 60, 112, 28, 112, 24, 112, 0, 0, 0, 0],
      "x": [9, 97, 0, 97, 0, 35, 0, 50, 0, 18, 0, 22, 0, 28, 0, 28, 0, 30, 0, 22, 0, 50, 0, 35, 0, 97, 0, 97, 128, 0, 0, 0, 0],
      "y": [10, 193, 128, 65, 128, 97, 0, 97, 0, 35, 0, 35, 0, 50, 0, 50, 0, 22, 0, 22, 0, 28, 0, 12, 0, 12, 0, 8, 0, 8, 0, 0, 0],
      "z": [7, 254, 254, 6, 12, 8, 8, 24, 48, 32, 32, 96, 192, 220, 254, 68, 0],
      "\u0410": [11, 12, 0, 30, 0, 22, 0, 18, 0, 51, 0, 50, 0, 33, 0, 33, 0, 97, 128, 127, 128, 107, 128, 64, 128, 192, 192, 192, 192, 128, 64, 0, 0],
      "\u0411": [9, 255, 0, 212, 0, 192, 0, 128, 0, 192, 0, 192, 0, 192, 0, 254, 0, 199, 0, 193, 128, 129, 0, 193, 128, 195, 0, 219, 0, 254, 0, 0, 0],
      "\u0412": [9, 254, 0, 214, 0, 195, 0, 131, 0, 193, 0, 195, 0, 198, 0, 252, 0, 199, 0, 193, 0, 129, 128, 193, 0, 195, 128, 219, 0, 254, 0, 0, 0],
      "\u0413": [8, 126, 212, 192, 128, 192, 192, 128, 192, 192, 128, 192, 192, 128, 192, 128, 0],
      "\u0414": [12, 15, 192, 24, 192, 24, 192, 16, 192, 24, 64, 16, 192, 16, 192, 48, 64, 48, 192, 32, 192, 48, 64, 100, 192, 255, 240, 192, 48, 128, 32, 0, 0],
      "\u0415": [8, 127, 212, 192, 128, 192, 192, 192, 254, 192, 192, 128, 192, 192, 222, 123, 0],
      "\u0401": [9, 0, 0, 38, 0, 0, 0, 127, 0, 192, 0, 192, 0, 128, 0, 192, 0, 238, 0, 218, 0, 192, 0, 128, 0, 192, 0, 192, 0, 127, 0, 0, 0],
      "\u0416": [17, 96, 195, 0, 32, 130, 0, 48, 198, 0, 48, 198, 0, 16, 132, 0, 24, 204, 0, 12, 216, 0, 15, 240, 0, 26, 220, 0, 24, 204, 0, 48, 134, 0, 48, 198, 0, 32, 194, 0, 96, 131, 0, 96, 195, 0, 0, 0, 0],
      "\u0417": [9, 126, 0, 39, 0, 1, 0, 1, 128, 1, 0, 1, 128, 7, 0, 62, 0, 3, 0, 1, 128, 1, 128, 0, 128, 1, 128, 127, 0, 90, 0, 0, 0],
      "\u0418": [10, 192, 192, 129, 128, 193, 192, 195, 128, 134, 192, 196, 192, 196, 128, 140, 192, 216, 192, 208, 128, 176, 192, 224, 192, 224, 128, 192, 192, 192, 128, 0, 0],
      "\u0419": [10, 50, 0, 18, 0, 28, 0, 64, 128, 193, 192, 129, 128, 195, 192, 198, 128, 132, 192, 204, 192, 216, 128, 144, 192, 240, 192, 224, 128, 192, 192, 0, 0],
      "\u041A": [10, 193, 128, 129, 0, 195, 0, 195, 0, 130, 0, 198, 0, 204, 0, 248, 0, 222, 0, 198, 0, 131, 0, 195, 0, 193, 0, 129, 128, 193, 128, 0, 0],
      "\u041B": [11, 7, 224, 13, 96, 8, 96, 24, 64, 8, 96, 24, 96, 24, 64, 16, 96, 24, 96, 16, 64, 24, 96, 48, 96, 48, 64, 96, 96, 64, 64, 0, 0],
      "\u041C": [13, 224, 112, 224, 88, 176, 88, 208, 80, 208, 216, 152, 152, 200, 144, 201, 152, 137, 24, 205, 144, 205, 24, 135, 24, 197, 16, 192, 24, 128, 16, 0, 0],
      "\u041D": [9, 193, 128, 128, 128, 193, 128, 193, 128, 128, 128, 193, 128, 193, 128, 255, 128, 197, 128, 193, 128, 128, 128, 193, 128, 193, 128, 128, 128, 193, 128, 0, 0],
      "\u041E": [10, 62, 0, 107, 128, 65, 128, 192, 128, 192, 128, 128, 192, 192, 128, 192, 192, 128, 128, 192, 192, 192, 128, 65, 128, 97, 128, 127, 0, 21, 0, 0, 0],
      "\u041F": [9, 255, 128, 213, 128, 193, 128, 128, 128, 193, 128, 193, 128, 128, 128, 193, 128, 193, 128, 128, 128, 193, 128, 193, 128, 128, 128, 193, 128, 128, 128, 0, 0],
      "\u0420": [8, 252, 215, 195, 131, 193, 195, 131, 195, 254, 200, 192, 128, 192, 192, 128, 0],
      "\u0421": [9, 63, 0, 101, 0, 64, 0, 192, 0, 192, 0, 128, 0, 192, 0, 192, 0, 128, 0, 192, 0, 192, 0, 64, 0, 96, 0, 123, 0, 30, 0, 0, 0],
      "\u0422": [10, 255, 192, 93, 0, 12, 0, 8, 0, 12, 0, 12, 0, 8, 0, 12, 0, 12, 0, 8, 0, 12, 0, 12, 0, 8, 0, 12, 0, 8, 0, 0, 0],
      "\u0423": [10, 64, 192, 64, 128, 97, 128, 97, 128, 33, 0, 49, 0, 51, 0, 19, 0, 26, 0, 30, 0, 6, 0, 4, 0, 12, 0, 56, 0, 48, 0, 0, 0],
      "\u0424": [13, 0, 0, 6, 0, 6, 0, 63, 192, 102, 96, 198, 48, 194, 16, 134, 16, 198, 16, 194, 48, 198, 48, 102, 96, 63, 192, 6, 0, 2, 0, 0, 0],
      "\u0425": [10, 192, 128, 65, 128, 97, 0, 35, 0, 50, 0, 22, 0, 22, 0, 28, 0, 30, 0, 50, 0, 35, 0, 35, 0, 97, 0, 65, 128, 192, 128, 0, 0],
      "\u0426": [11, 193, 128, 129, 0, 193, 128, 193, 128, 129, 0, 193, 128, 193, 128, 129, 0, 193, 128, 193, 128, 129, 0, 201, 128, 255, 224, 0, 96, 0, 64, 0, 0],
      "\u0427": [9, 193, 128, 129, 0, 193, 128, 193, 128, 129, 0, 193, 128, 193, 128, 199, 0, 125, 128, 17, 128, 1, 0, 1, 128, 1, 128, 1, 0, 1, 128, 0, 0],
      "\u0428": [14, 195, 12, 130, 8, 195, 12, 195, 12, 130, 8, 195, 12, 195, 12, 130, 8, 195, 12, 195, 12, 130, 8, 195, 12, 195, 12, 219, 104, 255, 252, 0, 0],
      "\u0429": [15, 195, 12, 130, 8, 195, 12, 195, 12, 130, 8, 195, 12, 195, 12, 130, 8, 195, 12, 195, 12, 130, 8, 203, 76, 255, 254, 0, 2, 0, 6, 0, 0],
      "\u042A": [12, 252, 0, 88, 0, 12, 0, 8, 0, 12, 0, 12, 0, 12, 0, 15, 224, 12, 96, 12, 48, 8, 48, 12, 16, 12, 48, 13, 224, 15, 160, 0, 0],
      "\u042B": [12, 192, 48, 128, 16, 192, 48, 192, 48, 128, 16, 192, 48, 192, 48, 254, 16, 199, 48, 195, 48, 129, 16, 195, 48, 195, 48, 222, 16, 250, 48, 0, 0],
      "\u042C": [8, 192, 128, 192, 192, 128, 192, 192, 254, 199, 195, 129, 195, 195, 222, 250, 0],
      "\u042D": [10, 126, 0, 23, 0, 1, 128, 0, 128, 0, 128, 0, 192, 1, 128, 63, 192, 0, 128, 0, 192, 1, 128, 1, 128, 3, 0, 93, 0, 126, 0, 0, 0],
      "\u042E": [14, 193, 240, 135, 88, 198, 24, 196, 12, 140, 12, 196, 12, 204, 4, 252, 12, 204, 12, 140, 12, 196, 8, 198, 12, 134, 24, 195, 248, 129, 160, 0, 0],
      "\u042F": [9, 31, 128, 53, 128, 97, 128, 97, 128, 64, 128, 97, 128, 97, 128, 33, 128, 63, 128, 51, 128, 32, 128, 97, 128, 97, 128, 64, 128, 65, 128, 0, 0],
      "\u0430": [8, 126, 124, 6, 3, 3, 2, 127, 126, 195, 195, 194, 207, 214, 123, 0, 0],
      "\u0431": [8, 0, 30, 48, 64, 192, 156, 246, 195, 195, 131, 193, 195, 67, 110, 60, 0],
      "\u0432": [8, 252, 254, 195, 194, 131, 198, 250, 252, 198, 194, 131, 198, 250, 254, 68, 0],
      "\u0433": [7, 126, 248, 196, 192, 128, 192, 192, 128, 192, 192, 128, 192, 192, 128, 64, 0],
      "\u0434": [10, 31, 0, 59, 0, 51, 0, 35, 0, 49, 0, 35, 0, 35, 0, 99, 0, 33, 0, 99, 0, 255, 128, 255, 192, 192, 128, 128, 192, 128, 128, 0, 0],
      "\u0435": [8, 62, 122, 103, 195, 193, 131, 255, 254, 192, 192, 192, 98, 122, 62, 2, 0],
      "\u0451": [8, 38, 32, 0, 0, 20, 126, 67, 195, 195, 254, 212, 192, 64, 122, 62, 0],
      "\u0436": [15, 99, 12, 97, 8, 35, 12, 51, 24, 49, 24, 27, 48, 27, 176, 15, 224, 27, 112, 51, 24, 51, 24, 97, 8, 99, 12, 67, 12, 32, 0, 0, 0],
      "\u0437": [8, 124, 126, 2, 3, 2, 6, 60, 126, 6, 2, 3, 10, 238, 126, 72, 0],
      "\u0438": [8, 195, 131, 199, 199, 133, 203, 203, 155, 209, 227, 163, 225, 195, 195, 0, 0],
      "\u0439": [8, 0, 100, 100, 60, 0, 131, 195, 135, 205, 203, 147, 241, 195, 195, 193, 0],
      "\u043A": [8, 198, 134, 196, 196, 140, 216, 216, 240, 220, 204, 140, 198, 198, 130, 66, 0],
      "\u043B": [9, 31, 128, 27, 128, 21, 128, 49, 128, 17, 0, 49, 128, 49, 128, 33, 0, 49, 128, 33, 128, 33, 0, 97, 128, 97, 128, 193, 0, 0, 128, 0, 0],
      "\u043C": [11, 224, 224, 224, 192, 225, 224, 161, 64, 209, 96, 209, 96, 147, 64, 210, 96, 218, 96, 138, 64, 206, 96, 204, 96, 140, 64, 192, 96, 0, 0, 0, 0],
      "\u043D": [8, 195, 130, 195, 195, 130, 195, 238, 255, 194, 131, 195, 194, 131, 195, 0, 0],
      "\u043E": [8, 60, 126, 98, 195, 195, 131, 193, 195, 131, 195, 194, 71, 122, 124, 4, 0],
      "\u043F": [8, 255, 254, 195, 195, 130, 195, 195, 130, 195, 195, 130, 195, 195, 130, 65, 0],
      "\u0440": [8, 158, 238, 227, 195, 131, 193, 195, 131, 195, 194, 254, 220, 128, 192, 128, 0],
      "\u0441": [8, 62, 122, 96, 192, 192, 128, 192, 192, 128, 192, 192, 96, 118, 62, 8, 0],
      "\u0442": [9, 127, 128, 127, 0, 12, 0, 12, 0, 8, 0, 12, 0, 12, 0, 8, 0, 12, 0, 12, 0, 8, 0, 12, 0, 12, 0, 8, 0, 4, 0, 0, 0],
      "\u0443": [10, 65, 128, 65, 128, 97, 0, 97, 0, 35, 0, 35, 0, 50, 0, 50, 0, 22, 0, 28, 0, 28, 0, 12, 0, 12, 0, 8, 0, 8, 0, 0, 0],
      "\u0444": [11, 12, 0, 4, 0, 12, 0, 12, 0, 63, 0, 109, 192, 204, 192, 196, 64, 140, 64, 204, 64, 196, 192, 109, 192, 63, 0, 12, 0, 4, 0, 0, 0],
      "\u0445": [9, 97, 128, 97, 0, 35, 0, 50, 0, 18, 0, 22, 0, 28, 0, 28, 0, 30, 0, 22, 0, 50, 0, 35, 0, 97, 0, 97, 128, 0, 0, 0, 0],
      "\u0446": [9, 195, 0, 130, 0, 195, 0, 195, 0, 130, 0, 195, 0, 195, 0, 130, 0, 195, 0, 195, 0, 219, 0, 255, 128, 0, 128, 1, 128, 0, 128, 0, 0],
      "\u0447": [7, 198, 130, 198, 198, 130, 198, 198, 206, 254, 86, 6, 2, 6, 6, 0, 0],
      "\u0448": [12, 198, 48, 132, 32, 198, 48, 198, 48, 132, 32, 198, 48, 198, 48, 132, 32, 198, 48, 198, 48, 132, 32, 198, 48, 215, 96, 255, 240, 82, 64, 0, 0],
      "\u0449": [13, 198, 48, 132, 32, 198, 48, 198, 48, 132, 32, 198, 48, 198, 48, 132, 32, 198, 48, 198, 48, 222, 240, 255, 248, 0, 8, 0, 24, 0, 8, 0, 0],
      "\u044A": [10, 248, 0, 240, 0, 24, 0, 24, 0, 16, 0, 24, 0, 29, 0, 31, 128, 25, 192, 24, 192, 16, 192, 24, 192, 31, 128, 31, 128, 8, 0, 0, 0],
      "\u044B": [10, 192, 192, 128, 64, 192, 192, 192, 192, 128, 64, 192, 192, 232, 192, 252, 64, 198, 192, 198, 192, 134, 64, 198, 192, 254, 192, 252, 64, 64, 64, 0, 0],
      "\u044C": [7, 192, 128, 192, 192, 128, 192, 232, 252, 198, 198, 134, 198, 254, 248, 72, 0],
      "\u044D": [8, 252, 108, 22, 6, 2, 3, 62, 127, 3, 2, 6, 10, 118, 252, 0, 0],
      "\u044E": [12, 199, 192, 141, 224, 204, 96, 200, 48, 152, 48, 200, 48, 248, 48, 248, 48, 216, 16, 152, 48, 200, 48, 204, 160, 143, 96, 199, 192, 0, 128, 0, 0],
      "\u044F": [8, 63, 63, 99, 99, 65, 99, 99, 35, 63, 63, 99, 99, 65, 67, 64, 0],
      "0": [9, 60, 0, 110, 0, 67, 0, 193, 0, 193, 0, 129, 128, 193, 0, 129, 128, 193, 0, 193, 128, 129, 0, 195, 0, 103, 0, 122, 0, 28, 0, 0, 0],
      "1": [6, 28, 120, 76, 8, 12, 8, 12, 8, 12, 8, 12, 8, 12, 12, 8, 0],
      "2": [8, 252, 86, 3, 2, 3, 6, 6, 12, 24, 24, 48, 96, 192, 255, 221, 0],
      "3": [9, 126, 0, 23, 0, 1, 128, 1, 0, 1, 128, 3, 0, 62, 0, 23, 0, 1, 128, 1, 128, 0, 128, 1, 128, 3, 128, 126, 0, 42, 0, 0, 0],
      "4": [11, 12, 0, 8, 0, 24, 0, 17, 128, 49, 0, 33, 128, 33, 0, 97, 128, 65, 128, 101, 128, 127, 192, 17, 128, 1, 128, 1, 0, 1, 128, 0, 0],
      "5": [8, 127, 106, 96, 64, 96, 96, 126, 10, 3, 3, 3, 3, 6, 125, 116, 0],
      "6": [8, 62, 106, 64, 192, 192, 190, 235, 195, 195, 129, 195, 195, 70, 126, 52, 0],
      "7": [8, 255, 87, 2, 2, 6, 6, 4, 12, 12, 8, 8, 24, 24, 16, 16, 0],
      "8": [9, 126, 0, 87, 0, 193, 0, 193, 128, 129, 0, 195, 0, 126, 0, 111, 0, 193, 0, 129, 128, 193, 0, 193, 128, 195, 0, 127, 0, 52, 0, 0, 0],
      "9": [8, 60, 110, 195, 195, 129, 195, 195, 127, 51, 3, 3, 2, 6, 126, 116, 0],
      ".": [2, 0, 0, 0, 0, 128, 192, 128, 192, 128, 192, 128, 128, 0, 0, 0, 0],
      ",": [2, 0, 0, 0, 192, 128, 192, 128, 192, 128, 128, 128, 128, 0, 128, 0, 0],
      "!": [2, 192, 128, 192, 128, 192, 128, 192, 128, 192, 192, 0, 0, 0, 192, 128, 0],
      "?": [8, 252, 86, 6, 3, 2, 6, 12, 8, 24, 24, 0, 0, 16, 24, 16, 0],
      ":": [2, 128, 192, 128, 128, 0, 0, 0, 0, 0, 0, 0, 192, 128, 192, 0, 0],
      ";": [2, 128, 192, 128, 0, 0, 0, 0, 0, 0, 192, 128, 192, 64, 128, 0, 0],
      "\u2014": [14, 0, 0, 0, 0, 0, 0, 85, 84, 255, 248, 247, 188, 255, 252, 221, 244, 86, 84, 33, 8, 8, 64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      "\u2013": [8, 0, 0, 0, 85, 254, 247, 255, 223, 82, 41, 0, 0, 4, 0, 0, 0],
      "-": [5, 0, 0, 0, 80, 248, 248, 248, 216, 80, 32, 0, 16, 0, 0, 0, 0],
      "+": [9, 12, 0, 8, 0, 12, 0, 8, 0, 12, 0, 111, 0, 127, 128, 44, 0, 12, 0, 8, 0, 12, 0, 12, 0, 8, 0, 0, 0, 0, 0, 0, 0],
      "%": [15, 120, 32, 104, 32, 204, 64, 204, 64, 132, 128, 204, 128, 205, 56, 121, 108, 82, 68, 4, 198, 4, 196, 8, 70, 8, 204, 16, 124, 0, 48, 0, 0],
      "\u20BD": [10, 63, 0, 53, 128, 49, 128, 32, 192, 48, 128, 32, 192, 49, 128, 127, 128, 117, 0, 48, 0, 48, 0, 255, 0, 52, 0, 48, 0, 32, 0, 0, 0],
      "\u20AC": [11, 15, 192, 21, 0, 24, 0, 48, 0, 48, 0, 255, 0, 50, 0, 126, 0, 122, 0, 48, 0, 48, 0, 16, 0, 26, 64, 29, 128, 7, 192, 0, 0],
      "(": [5, 0, 24, 32, 96, 64, 192, 192, 128, 192, 192, 128, 192, 64, 96, 48, 0],
      ")": [6, 0, 64, 48, 16, 24, 8, 12, 8, 12, 8, 12, 8, 24, 16, 32, 0],
      "\xAB": [8, 0, 2, 50, 36, 100, 76, 200, 200, 76, 100, 36, 54, 18, 0, 0, 0],
      "\xBB": [8, 0, 8, 200, 76, 100, 38, 50, 50, 38, 36, 108, 72, 72, 0, 0, 0],
      "\u2026": [13, 0, 0, 0, 0, 0, 0, 2, 16, 194, 16, 134, 16, 194, 16, 134, 24, 198, 16, 130, 16, 198, 16, 2, 16, 128, 0, 0, 0, 0, 0, 0, 0],
      "'": [2, 192, 128, 192, 128, 192, 128, 192, 128, 192, 192, 128, 192, 128, 0, 0, 0],
      '"': [4, 208, 176, 208, 240, 144, 240, 176, 208, 176, 208, 240, 144, 160, 0, 0, 0],
      "\u2116": [17, 225, 128, 0, 224, 128, 0, 161, 128, 0, 209, 128, 0, 208, 128, 0, 153, 128, 0, 201, 159, 0, 200, 155, 0, 141, 177, 128, 197, 145, 0, 196, 177, 128, 135, 159, 0, 194, 141, 0, 195, 150, 0, 131, 191, 128, 0, 0, 0],
      "/": [9, 1, 0, 1, 0, 3, 0, 2, 0, 4, 0, 4, 0, 12, 0, 8, 0, 16, 0, 16, 0, 48, 0, 32, 0, 64, 0, 64, 0, 0, 0, 0, 0],
      "\\": [9, 64, 0, 64, 0, 32, 0, 48, 0, 16, 0, 16, 0, 8, 0, 8, 0, 4, 0, 6, 0, 2, 0, 2, 0, 1, 0, 1, 0, 0, 128, 0, 0]
    };
  }
});

// lib/astro.js
function julianDate(dtUtc) {
  let y = dtUtc.getUTCFullYear();
  let m = dtUtc.getUTCMonth() + 1;
  const d = dtUtc.getUTCDate();
  const h = dtUtc.getUTCHours() + dtUtc.getUTCMinutes() / 60 + dtUtc.getUTCSeconds() / 3600;
  if (m <= 2) {
    y -= 1;
    m += 12;
  }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  const jd = Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + h / 24 + B - 1524.5;
  return jd;
}
function gmstHours(jd) {
  const T = (jd - 2451545) / 36525;
  let gmst = 280.46061837 + 360.98564736629 * (jd - 2451545) + 387933e-9 * T * T - T * T * T / 3871e4;
  gmst = (gmst % 360 + 360) % 360;
  return gmst / 15;
}
function lstHours(dtUtc, lonDeg) {
  return ((gmstHours(julianDate(dtUtc)) + lonDeg / 15) % 24 + 24) % 24;
}
function altaz(raH, decDeg, lstH, latDeg) {
  const H2 = (lstH - raH) * 15;
  const Hr = H2 * Math.PI / 180;
  const dcr = decDeg * Math.PI / 180;
  const ltr = latDeg * Math.PI / 180;
  const sinAlt = Math.sin(dcr) * Math.sin(ltr) + Math.cos(dcr) * Math.cos(ltr) * Math.cos(Hr);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) * 180 / Math.PI;
  const cosAz = (Math.sin(dcr) - Math.sin(alt * Math.PI / 180) * Math.sin(ltr)) / (Math.cos(alt * Math.PI / 180) * Math.cos(ltr) + 1e-9);
  let az = Math.acos(Math.max(-1, Math.min(1, cosAz))) * 180 / Math.PI;
  if (Math.sin(Hr) > 0) az = 360 - az;
  return [alt, az];
}
function sunPosition(dtUtc) {
  const jd = julianDate(dtUtc);
  const n = jd - 2451545;
  const L = ((280.46 + 0.9856474 * n) % 360 + 360) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360 + 360) % 360 * Math.PI / 180;
  const lam = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * Math.PI / 180;
  const eps = (23.439 - 4e-7 * n) * Math.PI / 180;
  let ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) * 180 / Math.PI / 15;
  ra = (ra % 24 + 24) % 24;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam)) * 180 / Math.PI;
  return [ra, dec];
}
function sunAltitudeMoscow(dtMsk) {
  const dtUtc = new Date(dtMsk.getTime() - 3 * 3600 * 1e3);
  const lst = lstHours(dtUtc, MOSCOW_LON);
  const [ra, dec] = sunPosition(dtUtc);
  const [alt] = altaz(ra, dec, lst, MOSCOW_LAT);
  return alt;
}
function starsMoscow(dtMsk) {
  const dtUtc = new Date(dtMsk.getTime() - 3 * 3600 * 1e3);
  const lst = lstHours(dtUtc, MOSCOW_LON);
  const out = [];
  for (const [name, ra, dec, mag, con] of STARS) {
    const [alt, az] = altaz(ra, dec, lst, MOSCOW_LAT);
    out.push([name, alt, az, mag, con]);
  }
  return out;
}
var MOSCOW_LAT, MOSCOW_LON, STARS, CONSTELLATION_LINES;
var init_astro = __esm({
  "lib/astro.js"() {
    MOSCOW_LAT = 55.7558;
    MOSCOW_LON = 37.6173;
    STARS = [
      ["Sirius", 6.7525, -16.7161, -1.46, "CMa"],
      ["Canopus", 6.3992, -52.6957, -0.74, "Car"],
      ["Arcturus", 14.261, 19.1825, -0.05, "Boo"],
      ["Vega", 18.6156, 38.7837, 0.03, "Lyr"],
      ["Capella", 5.2782, 45.998, 0.08, "Aur"],
      ["Rigel", 5.2423, -8.2016, 0.13, "Ori"],
      ["Procyon", 7.655, 5.225, 0.34, "CMi"],
      ["Betelgeuse", 5.9195, 7.4071, 0.5, "Ori"],
      ["Altair", 19.8464, 8.8683, 0.77, "Aql"],
      ["Aldebaran", 4.5987, 16.5093, 0.85, "Tau"],
      ["Antares", 16.4901, -26.432, 1.09, "Sco"],
      ["Spica", 13.4199, -11.1613, 1.04, "Vir"],
      ["Pollux", 7.7553, 28.0262, 1.14, "Gem"],
      ["Fomalhaut", 22.9608, -29.6222, 1.16, "PsA"],
      ["Deneb", 20.6905, 45.2803, 1.25, "Cyg"],
      ["Regulus", 10.1395, 11.9672, 1.35, "Leo"],
      ["Castor", 7.5766, 31.8883, 1.58, "Gem"],
      ["Polaris", 2.5303, 89.2641, 1.98, "UMi"],
      // Big Dipper / Ursa Major
      ["Dubhe", 11.0621, 61.751, 1.79, "UMa"],
      ["Merak", 11.0307, 56.3824, 2.37, "UMa"],
      ["Phecda", 11.8972, 53.6948, 2.44, "UMa"],
      ["Megrez", 12.257, 57.0326, 3.31, "UMa"],
      ["Alioth", 12.9005, 55.9598, 1.77, "UMa"],
      ["Mizar", 13.3987, 54.9254, 2.23, "UMa"],
      ["Alkaid", 13.7923, 49.3133, 1.86, "UMa"],
      // Cassiopeia
      ["Schedar", 0.6751, 56.5373, 2.24, "Cas"],
      ["Caph", 0.153, 59.1498, 2.28, "Cas"],
      ["Gamma Cas", 0.9451, 60.7167, 2.47, "Cas"],
      ["Ruchbah", 1.4303, 60.2353, 2.68, "Cas"],
      ["Segin", 1.9066, 63.6701, 3.35, "Cas"],
      // Orion
      ["Bellatrix", 5.4189, 6.3497, 1.64, "Ori"],
      ["Alnilam", 5.6036, -1.2019, 1.69, "Ori"],
      ["Alnitak", 5.6793, -1.9426, 1.88, "Ori"],
      ["Mintaka", 5.5334, -0.2991, 2.23, "Ori"],
      ["Saiph", 5.7959, -9.6696, 2.09, "Ori"],
      // Cygnus (Northern Cross)
      ["Sadr", 20.3705, 40.2567, 2.23, "Cyg"],
      ["Gienah Cyg", 20.7702, 33.9702, 2.46, "Cyg"],
      ["Delta Cyg", 19.7497, 45.131, 2.87, "Cyg"],
      ["Albireo", 19.512, 27.9597, 3.18, "Cyg"],
      // Lyra
      ["Sheliak", 18.8347, 33.3627, 3.52, "Lyr"],
      ["Sulafat", 18.9825, 32.6896, 3.24, "Lyr"],
      // Cepheus / misc north
      ["Alderamin", 21.3097, 62.5856, 2.44, "Cep"],
      ["Kochab", 14.8451, 74.1555, 2.07, "UMi"]
    ];
    CONSTELLATION_LINES = {
      UMa: [
        ["Alkaid", "Mizar"],
        ["Mizar", "Alioth"],
        ["Alioth", "Megrez"],
        ["Megrez", "Phecda"],
        ["Phecda", "Merak"],
        ["Merak", "Dubhe"],
        ["Dubhe", "Megrez"]
      ],
      Cas: [["Caph", "Schedar"], ["Schedar", "Gamma Cas"], ["Gamma Cas", "Ruchbah"], ["Ruchbah", "Segin"]],
      Ori: [
        ["Bellatrix", "Mintaka"],
        ["Mintaka", "Alnilam"],
        ["Alnilam", "Alnitak"],
        ["Betelgeuse", "Alnilam"],
        ["Alnitak", "Saiph"],
        ["Bellatrix", "Betelgeuse"],
        ["Mintaka", "Rigel"],
        ["Rigel", "Saiph"]
      ],
      Cyg: [["Deneb", "Sadr"], ["Sadr", "Delta Cyg"], ["Delta Cyg", "Albireo"], ["Sadr", "Gienah Cyg"]],
      Lyr: [["Vega", "Sheliak"], ["Sheliak", "Sulafat"], ["Sulafat", "Vega"]]
    };
    __name(julianDate, "julianDate");
    __name(gmstHours, "gmstHours");
    __name(lstHours, "lstHours");
    __name(altaz, "altaz");
    __name(sunPosition, "sunPosition");
    __name(sunAltitudeMoscow, "sunAltitudeMoscow");
    __name(starsMoscow, "starsMoscow");
  }
});

// lib/cardgen.js
var cardgen_exports = {};
__export(cardgen_exports, {
  encodeGif: () => encodeGif,
  pngToGif: () => pngToGif,
  renderCard: () => renderCard
});
function lerp(a, b, t) {
  return a + (b - a) * t;
}
function lerpColor(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}
function skyTheme(sunAlt) {
  if (sunAlt <= -12) {
    return { top: NIGHT_TOP, bot: NIGHT_BOT, text: [255, 255, 255], starOp: 1, isLight: false };
  } else if (sunAlt <= -4) {
    const t = (sunAlt + 12) / 8;
    return {
      top: lerpColor(NIGHT_TOP, TWI_TOP, t),
      bot: lerpColor(NIGHT_BOT, TWI_BOT, t),
      text: [255, 255, 255],
      starOp: 1 - 0.35 * t,
      isLight: false
    };
  } else if (sunAlt <= 3) {
    const t = (sunAlt + 4) / 7;
    return {
      top: lerpColor(TWI_TOP, HORIZON_TOP, t),
      bot: lerpColor(TWI_BOT, HORIZON_BOT, t),
      text: [255, 255, 255],
      starOp: Math.max(0, 0.65 - 0.65 * t),
      isLight: false
    };
  } else if (sunAlt <= 15) {
    const t = (sunAlt - 3) / 12;
    const isLight = t > 0.5;
    return {
      top: lerpColor(HORIZON_TOP, DAY_TOP, t),
      bot: lerpColor(HORIZON_BOT, DAY_BOT, t),
      text: isLight ? [17, 17, 17] : [255, 255, 255],
      starOp: 0,
      isLight
    };
  }
  return { top: DAY_TOP, bot: DAY_BOT, text: [17, 17, 17], starOp: 0, isLight: true };
}
function project(alt, az, w, h) {
  const r = 90 - alt;
  const scale = h * 0.62 / 90;
  const azR = az * Math.PI / 180;
  return [w / 2 + r * Math.sin(azR) * scale, h * 0.42 - r * Math.cos(azR) * scale];
}
function drawSky(c, dtMsk, phase) {
  const sunAlt = sunAltitudeMoscow(dtMsk);
  const th = skyTheme(sunAlt);
  const w = c.w, h = c.h;
  const wave = 0.02 * Math.sin(phase * 2 * Math.PI);
  for (let y = 0; y < h; y++) {
    const t = Math.min(1, Math.max(0, y / h + wave));
    const col = lerpColor(th.top, th.bot, t);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      c.px[i] = col[0];
      c.px[i + 1] = col[1];
      c.px[i + 2] = col[2];
      c.px[i + 3] = 255;
    }
  }
  if (th.starOp > 0.01) {
    const positions = {};
    for (const [name, alt, az, mag] of starsMoscow(dtMsk)) {
      if (alt <= -2) continue;
      const [x, y] = project(alt, az, w, h);
      if (x > -50 && x < w + 50 && y > -50 && y < h + 50) {
        positions[name] = [x, y];
        const size = Math.max(1, (2.2 - mag) * 1.15);
        let h2 = 0;
        for (let i = 0; i < name.length; i++) h2 += name.charCodeAt(i);
        const tw = 0.75 + 0.25 * Math.sin(phase * 2 * Math.PI + h2 % 16 * 0.4);
        const b = Math.max(60, Math.min(255, Math.round(255 * th.starOp * tw)));
        const col = [b, b, Math.min(255, b + 15)];
        const s = Math.ceil(size);
        for (let dy = -s; dy <= s; dy++) {
          for (let dx = -s; dx <= s; dx++) {
            if (dx * dx + dy * dy > s * s) continue;
            const px = Math.round(x + dx), py = Math.round(y + dy);
            if (px < 0 || py < 0 || px >= w || py >= h2) continue;
            const i = (py * w + px) * 4;
            c.px[i] = col[0];
            c.px[i + 1] = col[1];
            c.px[i + 2] = col[2];
            c.px[i + 3] = 255;
          }
        }
      }
    }
    const lineCol = Math.max(35, Math.round(90 * th.starOp)) + 30 | 0;
    for (const pairs of Object.values(CONSTELLATION_LINES)) {
      for (const [a, b] of pairs) {
        if (positions[a] && positions[b]) {
          const [x1, y1] = positions[a], [x2, y2] = positions[b];
          const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
          for (let s = 0; s <= steps; s++) {
            const x = Math.round(x1 + (x2 - x1) * s / steps);
            const y = Math.round(y1 + (y2 - y1) * s / steps);
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const i = (y * w + x) * 4;
            c.px[i] = lineCol;
            c.px[i + 1] = lineCol;
            c.px[i + 2] = lineCol;
            c.px[i + 3] = 255;
          }
        }
      }
    }
  }
}
function glyphWidth(ch, scale) {
  const g = FONT[ch];
  return g ? g[0] * scale + scale : scale * 3;
}
function measureLine(text, scale) {
  let w = 0;
  for (const ch of text) w += glyphWidth(ch, scale);
  return w;
}
function wrapText(text, maxWidth, scale) {
  const words = text.split(/(\s+)/);
  const lines = [];
  let cur = "";
  for (const part of words) {
    const t = cur + part;
    if (measureLine(t, scale) <= maxWidth) {
      cur = t;
    } else {
      if (cur.trim()) lines.push(cur.replace(/\s+$/, ""));
      cur = part;
    }
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.length ? lines : [""];
}
function crc32(bytes) {
  let c = 4294967295;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ c >>> 8;
  return (c ^ 4294967295) >>> 0;
}
function chunk(type, data) {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  out.set(len, 0);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crc = new Uint8Array(4);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  new DataView(crc.buffer).setUint32(0, crc32(crcInput));
  out.set(crc, 8 + data.length);
  return out;
}
async function encodePng(canvas) {
  const { w, h, px } = canvas;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    raw.set(px.subarray(y * w * 4, y * w * 4 + w * 4), y * (w * 4 + 1) + 1);
  }
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(raw);
  writer.close();
  const idat = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
function drawHeadline(canvas, text, x, y, maxWidth) {
  const lines = wrapText(text, maxWidth, SCALE).slice(0, 4);
  let cy = y;
  for (const line of lines) {
    drawText(canvas, line, x, cy, SCALE, TEXT, maxWidth);
    cy += LINE_H;
  }
  return cy;
}
function drawText(canvas, text, x, y, scale, color, maxWidth) {
  let cx = x;
  for (const ch of text) {
    const g = FONT[ch];
    if (!g) {
      cx += scale * 4;
      continue;
    }
    cx += canvas.blitGlyph(g, cx, y, scale, color);
    cx += scale;
  }
  return cx;
}
function drawTextCentered(canvas, text, centerX, y, scale, color, maxWidth) {
  const w = measureLine(text, scale);
  return drawText(canvas, text, Math.max(0, centerX - w / 2), y, scale, color, maxWidth);
}
function drawFooter(canvas, tier, y) {
  drawText(canvas, "TRUSTNODE", PAD, y, 2, SUB);
  const right = "t.me / vk.com \u2014 \u043A\u0438\u0431\u0435\u0440\u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u044C \u043F\u0440\u043E\u0441\u0442\u044B\u043C\u0438 \u0441\u043B\u043E\u0432\u0430\u043C\u0438";
  drawText(canvas, right, W - PAD - measureLine(right, 2), y, 2, SUB);
  drawTextCentered(canvas, "\u0421\u0422\u0423\u0414\u0418\u042F \u0426\u0418\u0424\u0420\u041E\u0412\u041E\u0419 \u0411\u0415\u0417\u041E\u041F\u0410\u0421\u041D\u041E\u0421\u0422\u0418", W / 2, y + 34, 2, SUB);
}
async function renderCard(data, opts = {}) {
  const frames = opts.format === "gif" ? Math.max(2, Math.min(30, opts.frames || 12)) : 1;
  const dtMsk = opts.dtMsk || new Date(Date.now() + 3 * 3600 * 1e3);
  const canvases = [];
  for (let f = 0; f < frames; f++) {
    const c = new Canvas(W, H);
    drawSky(c, dtMsk, frames === 1 ? opts.phase || 0 : f / frames);
    drawContent(c, data);
    canvases.push(c);
  }
  if (frames === 1) return encodePng(canvases[0]);
  return encodeGif(canvases, 8);
}
function drawContent(c, data) {
  c.fillRect(0, 0, W, 14, ACCENT);
  drawText(c, "TRUSTNODE", W - PAD - measureLine("TRUSTNODE", 2), 36, 2, [41, 52, 78]);
  let y = 130;
  const headline = (data.headline || "\u0411\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u044C \u0432 \u0446\u0438\u0444\u0440\u043E\u0432\u043E\u043C \u043C\u0438\u0440\u0435").toUpperCase();
  y = drawHeadline(c, headline, PAD, y, W - PAD * 2);
  y += 20;
  c.fillRect(PAD, y, W - PAD * 2, 3, ACCENT);
  y += 40;
  const cards = data.cards || [];
  const stat = cards.find((x) => x.type === "stat" && x.number);
  const list = cards.filter((x) => x.type === "list" && x.items?.length).flatMap((x) => x.items);
  if (stat) {
    const boxH = 300;
    c.fillRect(PAD, y, W - PAD * 2, boxH, CARD_BG);
    const num = String(stat.number).slice(0, 12);
    drawTextCentered(c, num, W / 2, y + 60, 6, ACCENT, W - PAD * 2 - 40);
    const label = (stat.label || "").toUpperCase();
    drawTextCentered(c, label, W / 2, y + 60 + 6 * FONT_H + 40, 3, TEXT, W - PAD * 2 - 40);
    if (stat.desc) {
      const dl = wrapText(stat.desc, W - PAD * 2 - 60, 2);
      let dy = y + boxH - 30 - dl.length * (FONT_H * 2 + 8);
      for (const l of dl.slice(0, 2)) {
        drawTextCentered(c, l, W / 2, dy, 2, SUB, W - PAD * 2 - 60);
        dy += FONT_H * 2 + 8;
      }
    }
    y += boxH + 40;
  }
  const items = (list.length ? list : cards.filter((x) => x.type === "compare").slice(0, 1)).slice(0, 4);
  if (items.length) {
    let boxY = y;
    const boxH = 40 + items.length * 84;
    c.fillRect(PAD, y, W - PAD * 2, boxH, CARD_BG);
    y += 40;
    for (const it of items) {
      const tl = wrapText(String(it), W - PAD * 2 - 70, SCALE);
      drawText(c, "\u2013", PAD + 24, y, SCALE, ACCENT);
      let ty = y;
      for (const line of tl.slice(0, 2)) {
        drawText(c, line, PAD + 60, ty, SCALE, TEXT, W - PAD * 2 - 60);
        ty += LINE_H;
      }
      y += Math.max(84, (tl.length > 1 ? 2 : 1) * LINE_H + 14);
    }
    y = boxY + boxH + 40;
  }
  drawFooter(c, data.tier || "news", H - 130);
}
async function inflateDeflate(compressed) {
  const cs = new DecompressionStream("deflate");
  const writer = cs.writable.getWriter();
  await writer.write(compressed);
  await writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
async function parsePngToRgba(pngBytes) {
  let off = 8;
  let w = 0, h = 0, bitDepth = 8, colorType = 6;
  const idatParts = [];
  while (off + 8 <= pngBytes.length) {
    const len = new DataView(pngBytes.buffer, pngBytes.byteOffset + off, 4).getUint32(0);
    const type = String.fromCharCode(pngBytes[off + 4], pngBytes[off + 5], pngBytes[off + 6], pngBytes[off + 7]);
    const dataStart = off + 8;
    if (type === "IHDR") {
      const dv = new DataView(pngBytes.buffer, pngBytes.byteOffset + dataStart, 13);
      w = dv.getUint32(0);
      h = dv.getUint32(4);
      bitDepth = pngBytes[dataStart + 8];
      colorType = pngBytes[dataStart + 9];
    } else if (type === "IDAT") {
      idatParts.push(pngBytes.subarray(dataStart, dataStart + len));
    } else if (type === "IEND") {
      break;
    }
    off = dataStart + len + 4;
  }
  if (!w || !h) throw new Error("PNG: IHDR \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null;
  if (channels === null) throw new Error(`PNG: \u043D\u0435\u043F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0435\u043C\u044B\u0439 colorType=${colorType}`);
  const bpp = Math.ceil(channels * bitDepth / 8);
  const idat = new Uint8Array(idatParts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of idatParts) {
    idat.set(p, o);
    o += p.length;
  }
  const raw = await inflateDeflate(idat);
  const stride = w * channels * (bitDepth === 16 ? 2 : 1);
  const rgba = new Uint8Array(w * h * 4);
  const px = new Uint8Array(w * h * channels);
  let src = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[src++];
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      let v = raw[src + x];
      const left = x >= bpp ? px[i - bpp] : 0;
      const up = y > 0 ? px[i - stride] : 0;
      const ul = x >= bpp && y > 0 ? px[i - stride - bpp] : 0;
      if (filter === 1) v = v + left & 255;
      else if (filter === 2) v = v + up & 255;
      else if (filter === 3) v = v + (left + up >> 1) & 255;
      else if (filter === 4) {
        const p = left + up - ul;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul);
        const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
        v = v + pred & 255;
      }
      px[i] = v;
    }
    src += stride;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pi = (y * w + x) * channels;
      const oi = (y * w + x) * 4;
      for (let c = 0; c < channels; c++) {
        let v = px[pi + c];
        if (bitDepth === 16) v = px[pi + c * 2];
        rgba[oi + c] = v;
      }
      if (channels === 3) rgba[oi + 3] = 255;
    }
  }
  return { w, h, rgba };
}
function buildPalette(rgba) {
  const freq = /* @__PURE__ */ new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    const k = rgba[i] << 16 | rgba[i + 1] << 8 | rgba[i + 2];
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  const colors = Array.from(freq.entries()).map(([k, count]) => ({
    r: k >> 16 & 255,
    g: k >> 8 & 255,
    b: k & 255,
    count
  }));
  if (colors.length <= 256) return colors.map((c) => [c.r, c.g, c.b]);
  const range = /* @__PURE__ */ __name((box, ch) => {
    let lo = 255, hi = 0;
    for (const c of box) {
      const v = c[ch];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi - lo;
  }, "range");
  let boxes = [colors];
  while (boxes.length < 256) {
    let bi = -1, bestR = -1;
    for (let i = 0; i < boxes.length; i++) {
      const r = Math.max(range(boxes[i], "r"), range(boxes[i], "g"), range(boxes[i], "b"));
      if (r > bestR) {
        bestR = r;
        bi = i;
      }
    }
    if (bestR <= 0) break;
    const box = boxes[bi];
    const ch = range(box, "r") >= range(box, "g") ? range(box, "r") >= range(box, "b") ? "r" : "b" : range(box, "g") >= range(box, "b") ? "g" : "b";
    box.sort((a, b) => a[ch] - b[ch]);
    const cut = Math.floor(box.length / 2);
    let left = box.slice(0, cut), right = box.slice(cut);
    if (!left.length || !right.length) break;
    boxes[bi] = left;
    boxes.push(right);
  }
  return boxes.map((box) => {
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (const c of box) {
      sr += c.r * c.count;
      sg += c.g * c.count;
      sb += c.b * c.count;
      n += c.count;
    }
    return [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
  });
}
function nearestPaletteIdx(lutKeys, palette, r, g, b) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const dr = r - palette[i][0], dg = g - palette[i][1], db = b - palette[i][2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const MAX_DICT = 4096;
  const dict = /* @__PURE__ */ new Map();
  let freeCode = eoiCode + 1;
  const outCodes = [];
  outCodes.push(clearCode);
  let prev = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const cur = indices[i];
    const key = prev * 256 + cur;
    if (dict.has(key)) {
      prev = dict.get(key);
      continue;
    }
    outCodes.push(prev);
    if (freeCode < MAX_DICT) {
      dict.set(key, freeCode++);
    } else {
      outCodes.push(clearCode);
      dict.clear();
      freeCode = eoiCode + 1;
    }
    prev = cur;
  }
  outCodes.push(prev);
  outCodes.push(eoiCode);
  const buf = [];
  let bitPos = 0;
  let acc = 0;
  let codeSize = minCodeSize + 1;
  let nextFree = eoiCode + 1;
  const pushBit = /* @__PURE__ */ __name((bit) => {
    acc |= (bit & 1) << bitPos;
    bitPos++;
    if (bitPos === 8) {
      buf.push(acc & 255);
      bitPos = 0;
      acc = 0;
    }
  }, "pushBit");
  const emitCode = /* @__PURE__ */ __name((code) => {
    for (let b = 0; b < codeSize; b++) pushBit(code >> b & 1);
  }, "emitCode");
  let di = 0;
  emitCode(outCodes[di++]);
  codeSize = minCodeSize + 1;
  nextFree = eoiCode + 1;
  while (di < outCodes.length) {
    const code = outCodes[di++];
    emitCode(code);
    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      nextFree = eoiCode + 1;
    } else if (code !== eoiCode) {
      nextFree++;
      if (nextFree > 1 << codeSize && codeSize < 12) codeSize++;
    }
  }
  if (bitPos) buf.push(acc & 255);
  return buf;
}
async function pngToGif(pngBytes) {
  const { w, h, rgba } = await parsePngToRgba(pngBytes);
  const palette = buildPalette(rgba);
  const cache = /* @__PURE__ */ new Map();
  const idxFor = /* @__PURE__ */ __name((r, g, b) => {
    const key = r << 16 | g << 8 | b;
    let idx = cache.get(key);
    if (idx === void 0) {
      idx = nearestPaletteIdx(null, palette, r, g, b);
      cache.set(key, idx);
    }
    return idx;
  }, "idxFor");
  const indices = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    indices[i] = idxFor(r, g, b);
  }
  const nColors = palette.length;
  const colorBits = nColors > 128 ? 8 : nColors > 64 ? 7 : nColors > 32 ? 6 : nColors > 16 ? 5 : nColors > 8 ? 4 : nColors > 4 ? 3 : 2;
  const minCodeSize = Math.max(2, colorBits);
  const tableSize = 1 << colorBits;
  const colorTable = new Uint8Array(tableSize * 3);
  for (let i = 0; i < tableSize; i++) {
    const c = palette[i] || [0, 0, 0];
    colorTable[i * 3] = c[0];
    colorTable[i * 3 + 1] = c[1];
    colorTable[i * 3 + 2] = c[2];
  }
  const packed = new Uint8Array(w * h + h);
  for (let y = 0; y < h; y++) {
    packed[y * (w + 1)] = 0;
    packed.set(indices.subarray(y * w, y * w + w), y * (w + 1) + 1);
  }
  const encoded = new Uint8Array(lzwEncode(Array.from(indices), minCodeSize));
  const gctSize = colorBits - 1;
  const header = new Uint8Array([
    71,
    73,
    70,
    56,
    57,
    97,
    // GIF89a
    w & 255,
    w >> 8 & 255,
    h & 255,
    h >> 8 & 255,
    128 | gctSize & 7,
    // global color table flag + size
    0,
    // bg color index
    0
    // pixel aspect ratio
  ]);
  const parts = [header, colorTable];
  const imgDesc = new Uint8Array([
    44,
    0,
    0,
    0,
    0,
    w & 255,
    w >> 8 & 255,
    h & 255,
    h >> 8 & 255,
    0
  ]);
  parts.push(imgDesc);
  parts.push(Uint8Array.of(minCodeSize));
  for (let i = 0; i < encoded.length; i += 255) {
    const block = encoded.subarray(i, i + 255);
    const sub = new Uint8Array(block.length + 1);
    sub[0] = block.length;
    sub.set(block, 1);
    parts.push(sub);
  }
  parts.push(Uint8Array.of(0));
  parts.push(Uint8Array.of(59));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
function buildPaletteMulti(rgbaList) {
  const freq = /* @__PURE__ */ new Map();
  for (const rgba of rgbaList) {
    for (let i = 0; i < rgba.length; i += 4) {
      const k = rgba[i] << 16 | rgba[i + 1] << 8 | rgba[i + 2];
      freq.set(k, (freq.get(k) || 0) + 1);
    }
  }
  const colors = Array.from(freq.entries()).map(([k, count]) => ({
    r: k >> 16 & 255,
    g: k >> 8 & 255,
    b: k & 255,
    count
  }));
  if (colors.length <= 256) return colors.map((c) => [c.r, c.g, c.b]);
  const range = /* @__PURE__ */ __name((box, ch) => {
    let lo = 255, hi = 0;
    for (const c of box) {
      const v = c[ch];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    return hi - lo;
  }, "range");
  let boxes = [colors];
  while (boxes.length < 256) {
    let bi = -1, bestR = -1;
    for (let i = 0; i < boxes.length; i++) {
      const r = Math.max(range(boxes[i], "r"), range(boxes[i], "g"), range(boxes[i], "b"));
      if (r > bestR) {
        bestR = r;
        bi = i;
      }
    }
    if (bestR <= 0) break;
    const box = boxes[bi];
    const ch = range(box, "r") >= range(box, "g") ? range(box, "r") >= range(box, "b") ? "r" : "b" : range(box, "g") >= range(box, "b") ? "g" : "b";
    box.sort((a, b) => a[ch] - b[ch]);
    const cut = Math.floor(box.length / 2);
    const left = box.slice(0, cut), right = box.slice(cut);
    if (!left.length || !right.length) break;
    boxes[bi] = left;
    boxes.push(right);
  }
  return boxes.map((box) => {
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (const c of box) {
      sr += c.r * c.count;
      sg += c.g * c.count;
      sb += c.b * c.count;
      n += c.count;
    }
    return [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
  });
}
function indicesForFrame(rgba, palette, w, h) {
  const cache = /* @__PURE__ */ new Map();
  const indices = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    const key = r << 16 | g << 8 | b;
    let idx = cache.get(key);
    if (idx === void 0) {
      idx = nearestPaletteIdx(null, palette, r, g, b);
      cache.set(key, idx);
    }
    indices[i] = idx;
  }
  return indices;
}
function gceBlock(delayCs) {
  return Uint8Array.of(
    33,
    249,
    // extension introducer + GCE label
    4,
    // block size
    0,
    // packed: no transparency
    delayCs & 255,
    delayCs >> 8 & 255,
    // delay in centiseconds
    0,
    // transparent color index
    0
    // block terminator
  );
}
function netscapeLoop() {
  return Uint8Array.of(
    33,
    255,
    // extension introducer + app label
    11,
    // block size = 11
    78,
    69,
    84,
    83,
    67,
    65,
    80,
    69,
    50,
    46,
    48,
    // "NETSCAPE2.0"
    3,
    1,
    0,
    0,
    // loop count = 0 (forever)
    0
    // terminator
  );
}
function encodeGif(canvases, fps = 8) {
  const w = canvases[0].w, h = canvases[0].h;
  const rgbaList = canvases.map((c) => c.px);
  const palette = buildPaletteMulti(rgbaList);
  const nColors = palette.length;
  const colorBits = nColors > 128 ? 8 : nColors > 64 ? 7 : nColors > 32 ? 6 : nColors > 16 ? 5 : nColors > 8 ? 4 : nColors > 4 ? 3 : 2;
  const minCodeSize = Math.max(2, colorBits);
  const tableSize = 1 << colorBits;
  const colorTable = new Uint8Array(tableSize * 3);
  for (let i = 0; i < tableSize; i++) {
    const c = palette[i] || [0, 0, 0];
    colorTable[i * 3] = c[0];
    colorTable[i * 3 + 1] = c[1];
    colorTable[i * 3 + 2] = c[2];
  }
  const delayCs = Math.max(1, Math.round(100 / fps));
  const gctSize = colorBits - 1;
  const header = new Uint8Array([
    71,
    73,
    70,
    56,
    57,
    97,
    // GIF89a
    w & 255,
    w >> 8 & 255,
    h & 255,
    h >> 8 & 255,
    128 | gctSize & 7,
    // global color table flag + size
    0,
    // bg color index
    0
    // pixel aspect ratio
  ]);
  const parts = [header, colorTable, netscapeLoop()];
  const encCache = /* @__PURE__ */ new Map();
  const lzwFor = /* @__PURE__ */ __name((indices) => {
    const key = indices.length + ":" + Array.from(indices.slice(0, 32)).join(",");
    const hit = encCache.get(key);
    if (hit) return hit;
    const enc = new Uint8Array(lzwEncode(Array.from(indices), minCodeSize));
    if (encCache.size < 32) encCache.set(key, enc);
    return enc;
  }, "lzwFor");
  for (const c of canvases) {
    const indices = indicesForFrame(c.px, palette, w, h);
    const encoded = lzwFor(indices);
    const imgDesc = new Uint8Array([
      44,
      0,
      0,
      0,
      0,
      w & 255,
      w >> 8 & 255,
      h & 255,
      h >> 8 & 255,
      0
    ]);
    parts.push(gceBlock(delayCs), imgDesc, Uint8Array.of(minCodeSize));
    for (let i = 0; i < encoded.length; i += 255) {
      const block = encoded.subarray(i, i + 255);
      const sub = new Uint8Array(block.length + 1);
      sub[0] = block.length;
      sub.set(block, 1);
      parts.push(sub);
    }
    parts.push(Uint8Array.of(0));
  }
  parts.push(Uint8Array.of(59));
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
var W, H, PAD, SCALE, LINE_H, BG, TEXT, ACCENT, SUB, CARD_BG, NIGHT_TOP, NIGHT_BOT, TWI_TOP, TWI_BOT, HORIZON_TOP, HORIZON_BOT, DAY_TOP, DAY_BOT, Canvas, CRC_TABLE;
var init_cardgen = __esm({
  "lib/cardgen.js"() {
    init_font();
    init_astro();
    W = 1080;
    H = 1350;
    PAD = 72;
    SCALE = 3;
    LINE_H = FONT_H * SCALE + 16;
    BG = [11, 18, 32];
    TEXT = [242, 245, 250];
    ACCENT = [255, 210, 74];
    SUB = [138, 147, 166];
    CARD_BG = [19, 28, 48];
    NIGHT_TOP = [6, 8, 18];
    NIGHT_BOT = [10, 12, 28];
    TWI_TOP = [18, 22, 52];
    TWI_BOT = [60, 45, 90];
    HORIZON_TOP = [60, 70, 130];
    HORIZON_BOT = [255, 150, 90];
    DAY_TOP = [130, 185, 235];
    DAY_BOT = [225, 240, 252];
    __name(lerp, "lerp");
    __name(lerpColor, "lerpColor");
    __name(skyTheme, "skyTheme");
    __name(project, "project");
    __name(drawSky, "drawSky");
    Canvas = class {
      static {
        __name(this, "Canvas");
      }
      constructor(w, h) {
        this.w = w;
        this.h = h;
        this.px = new Uint8Array(w * h * 4);
        this.fillRect(0, 0, w, h, BG);
      }
      setPx(x, y, [r, g, b]) {
        if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
        const i = (y * this.w + x) * 4;
        this.px[i] = r;
        this.px[i + 1] = g;
        this.px[i + 2] = b;
        this.px[i + 3] = 255;
      }
      fillRect(x, y, w, h, color) {
        for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.setPx(xx, yy, color);
      }
      blitGlyph(glyph, x, y, scale, color) {
        const [w, ...data] = glyph;
        const rowBytes = Math.ceil(w / 8);
        for (let gy = 0; gy < FONT_H; gy++) {
          for (let gx = 0; gx < w; gx++) {
            const byte = data[gy * rowBytes + (gx >> 3)];
            const bit = byte & 128 >> (gx & 7);
            if (bit) this.fillRect(x + gx * scale, y + gy * scale, scale, scale, color);
          }
        }
        return w * scale;
      }
    };
    __name(glyphWidth, "glyphWidth");
    __name(measureLine, "measureLine");
    __name(wrapText, "wrapText");
    CRC_TABLE = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
        t[n] = c >>> 0;
      }
      return t;
    })();
    __name(crc32, "crc32");
    __name(chunk, "chunk");
    __name(encodePng, "encodePng");
    __name(drawHeadline, "drawHeadline");
    __name(drawText, "drawText");
    __name(drawTextCentered, "drawTextCentered");
    __name(drawFooter, "drawFooter");
    __name(renderCard, "renderCard");
    __name(drawContent, "drawContent");
    __name(inflateDeflate, "inflateDeflate");
    __name(parsePngToRgba, "parsePngToRgba");
    __name(buildPalette, "buildPalette");
    __name(nearestPaletteIdx, "nearestPaletteIdx");
    __name(lzwEncode, "lzwEncode");
    __name(pngToGif, "pngToGif");
    __name(buildPaletteMulti, "buildPaletteMulti");
    __name(indicesForFrame, "indicesForFrame");
    __name(gceBlock, "gceBlock");
    __name(netscapeLoop, "netscapeLoop");
    __name(encodeGif, "encodeGif");
  }
});

// lib/telegram.js
var telegram_exports = {};
__export(telegram_exports, {
  answerCallbackQuery: () => answerCallbackQuery,
  assertValidImage: () => assertValidImage,
  deleteMessage: () => deleteMessage,
  downloadFile: () => downloadFile,
  editMessageReplyMarkup: () => editMessageReplyMarkup,
  forwardMessage: () => forwardMessage,
  isGifBytes: () => isGifBytes,
  publishToTelegram: () => publishToTelegram,
  publishToVk: () => publishToVk,
  readFileBytes: () => readFileBytes,
  resolveTelegramChannel: () => resolveTelegramChannel,
  sendAnimation: () => sendAnimation,
  sendCard: () => sendCard,
  sendMessage: () => sendMessage,
  sendPhoto: () => sendPhoto,
  setMyCommands: () => setMyCommands,
  tgCall: () => tgCall2,
  vkCall: () => vkCall,
  vkPostWall: () => vkPostWall,
  vkUploadAlbumPhoto: () => vkUploadAlbumPhoto,
  vkUploadWallGif: () => vkUploadWallGif,
  vkUploadWallPhoto: () => vkUploadWallPhoto
});
async function tgCall2(env, method, params = {}, files = null) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const url = `${TG_API}${token}/${method}`;
  let res;
  if (files) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(files)) fd.append(k, v);
    for (const [k, v] of Object.entries(params)) fd.append(k, String(v));
    res = await fetch(url, { method: "POST", body: fd });
  } else {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params)
    });
  }
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
  }
  if (!res.ok || !data.ok) {
    throw new Error(`TG ${method}: ${data && data.description || res.status}`);
  }
  return data.result;
}
async function vkCall(env, method, params = {}) {
  const body = new URLSearchParams({
    access_token: env.VK_TOKEN,
    v: VK_VERSION,
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
  });
  const res = await fetch(VK_API + method, { method: "POST", body });
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
  }
  if (data.error) {
    const code = data.error.error_code;
    const msg = data.error.error_msg || "";
    if (code === 5) {
      throw new Error("VK access token \u043D\u0435\u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0442\u0435\u043B\u0435\u043D \u0438\u043B\u0438 \u0438\u0441\u0442\u0451\u043A (error 5)");
    }
    if (code === 27) {
      throw new Error("VK access token \u043D\u0435 \u0438\u043C\u0435\u0435\u0442 \u043D\u0435\u043E\u0431\u0445\u043E\u0434\u0438\u043C\u044B\u0445 \u043F\u0440\u0430\u0432 \u0434\u043B\u044F \u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0438 \u0444\u043E\u0442\u043E/\u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438 (error 27)");
    }
    if (code === 9 || code === 6) {
      throw new Error(`VK rate limit (error ${code}): ${msg}`);
    }
    throw new Error(`VK ${method}: ${code} ${msg}`);
  }
  return data.response;
}
function sendMessage(env, chatId, text, opts = {}) {
  const params = { chat_id: chatId, text };
  if (opts.parse_mode) params.parse_mode = opts.parse_mode;
  if (opts.reply_markup) params.reply_markup = JSON.stringify(opts.reply_markup);
  if (opts.disable_web_page_preview) params.disable_web_page_preview = true;
  return tgCall2(env, "sendMessage", params);
}
function sendPhoto(env, chatId, bytes, caption, opts = {}) {
  const files = { photo: new Blob([bytes], { type: "image/png" }) };
  const params = { chat_id: chatId };
  if (caption) params.caption = caption;
  if (opts.parse_mode) params.parse_mode = opts.parse_mode;
  if (opts.reply_markup) params.reply_markup = JSON.stringify(opts.reply_markup);
  return tgCall2(env, "sendPhoto", params, files);
}
function sendAnimation(env, chatId, bytes, caption, opts = {}) {
  const files = { animation: new Blob([bytes], { type: "image/gif" }) };
  const params = { chat_id: chatId };
  if (caption) params.caption = caption;
  if (opts.parse_mode) params.parse_mode = opts.parse_mode;
  if (opts.reply_markup) params.reply_markup = JSON.stringify(opts.reply_markup);
  return tgCall2(env, "sendAnimation", params, files);
}
function isGifBytes(bytes) {
  if (!bytes || bytes.length < 6) return false;
  const s = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
  return s === "GIF89a" || s === "GIF87a";
}
function sendCard(env, chatId, bytes, caption, opts = {}) {
  return isGifBytes(bytes) ? sendAnimation(env, chatId, bytes, caption, opts) : sendPhoto(env, chatId, bytes, caption, opts);
}
function editMessageReplyMarkup(env, chatId, messageId, markup = []) {
  return tgCall2(env, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: JSON.stringify({ inline_keyboard: markup })
  });
}
function answerCallbackQuery(env, id, text) {
  return tgCall2(env, "answerCallbackQuery", { callback_query_id: id, text });
}
function setMyCommands(env, commands) {
  return tgCall2(env, "setMyCommands", { commands: JSON.stringify(commands) });
}
function deleteMessage(env, chatId, messageId) {
  return tgCall2(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
}
function forwardMessage(env, chatId, fromChatId, messageId) {
  return tgCall2(env, "forwardMessage", {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId
  });
}
async function downloadFile(env, fileId) {
  const f = await tgCall2(env, "getFile", { file_id: fileId });
  const path = f && f.file_path;
  if (!path) throw new Error("file_path \u043F\u0443\u0441\u0442");
  const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`);
  if (!res.ok) throw new Error(`download file failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
async function vkUploadWallPhoto(env, bytes) {
  const MAX_ATTEMPTS = 5;
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const upload = await vkCall(env, "photos.getMessagesUploadServer");
    const fd = new FormData();
    fd.append("photo", new Blob([bytes], { type: "image/png" }), "photo.png");
    let up;
    try {
      const r = await fetch(upload.upload_url, { method: "POST", body: fd });
      up = await r.json();
    } catch (e) {
      up = { _err: e.message };
    }
    if (up && up.photo) {
      const saved = await vkCall(env, "photos.saveMessagesPhoto", {
        photo: up.photo,
        server: up.server,
        hash: up.hash
      });
      const p = saved[0];
      return `photo${p.owner_id}_${p.id}`;
    }
    lastErr = `VK: upload-\u0441\u0435\u0440\u0432\u0435\u0440 \u0432\u0435\u0440\u043D\u0443\u043B \u043F\u0443\u0441\u0442\u043E\u0439 photo (${JSON.stringify(up).slice(0, 200)})`;
    if (attempt < MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, 2e3 * (attempt + 1)));
    }
  }
  throw new Error(lastErr);
}
async function vkPostWall(env, message, attachment) {
  return vkCall(env, "wall.post", {
    owner_id: -env.VK_GROUP_ID,
    from_group: 1,
    message,
    attachments: attachment
  });
}
async function vkUploadWallGif(env, gifBytes) {
  const MAX_ATTEMPTS = 4;
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const dws = await vkCall(env, "docs.getWallUploadServer", { group_id: env.VK_GROUP_ID });
    if (!dws || !dws.upload_url) {
      lastErr = "VK: docs.getWallUploadServer \u043D\u0435 \u0432\u0435\u0440\u043D\u0443\u043B upload_url";
      if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 2e3 * (attempt + 1)));
      continue;
    }
    const fd = new FormData();
    fd.append("file", new Blob([gifBytes], { type: "image/gif" }), "card.gif");
    let bodyText = "";
    try {
      const resp = await fetch(dws.upload_url, {
        method: "POST",
        body: fd,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          Accept: "*/*"
        }
      });
      bodyText = await resp.text();
    } catch (e) {
      bodyText = "";
      lastErr = `VK: gif upload fetch error: ${e.message}`;
      if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 2e3 * (attempt + 1)));
      continue;
    }
    let ur = null;
    try {
      ur = JSON.parse(bodyText);
    } catch (e) {
      ur = null;
    }
    if (!ur || !ur.file) {
      lastErr = `VK: gif upload \u0432\u0435\u0440\u043D\u0443\u043B \u0431\u0435\u0437 file (${bodyText.slice(0, 120)})`;
      if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 2e3 * (attempt + 1)));
      continue;
    }
    const saved = await vkCall(env, "docs.save", { file: ur.file });
    const wrap = Array.isArray(saved) ? saved[0] : saved;
    const doc = wrap && (wrap.doc || wrap) || null;
    if (!doc || !doc.id) {
      lastErr = `VK: docs.save \u0432\u0435\u0440\u043D\u0443\u043B \u0431\u0435\u0437 doc (${JSON.stringify(saved).slice(0, 200)})`;
      if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 2e3 * (attempt + 1)));
      continue;
    }
    return `doc${doc.owner_id}_${doc.id}`;
  }
  throw new Error(lastErr || "VK: gif upload \u043D\u0435 \u0443\u0434\u0430\u043B\u0441\u044F");
}
async function vkUploadAlbumPhoto(env, bytes, albumId) {
  const upload = await vkCall(env, "photos.getUploadServer", {
    album_id: albumId,
    group_id: env.VK_GROUP_ID
  });
  const fd = new FormData();
  fd.append("file1", new Blob([bytes], { type: "image/png" }), "photo.png");
  let up;
  try {
    const r = await fetch(upload.upload_url, { method: "POST", body: fd });
    up = await r.json();
  } catch (e) {
    throw new Error(`VK: album upload exception: ${e.message}`);
  }
  if (!up || !up.photos_list) {
    throw new Error(`VK: album upload-\u0441\u0435\u0440\u0432\u0435\u0440 \u0432\u0435\u0440\u043D\u0443\u043B \u043F\u0443\u0441\u0442\u043E\u0439 photos_list (${JSON.stringify(up).slice(0, 200)})`);
  }
  const saved = await vkCall(env, "photos.save", {
    album_id: albumId,
    group_id: env.VK_GROUP_ID,
    server: up.server,
    photos_list: up.photos_list,
    hash: up.hash
  });
  const p = saved[0];
  return `photo${p.owner_id}_${p.id}`;
}
async function pkgBytes(env, pkg) {
  const png = pkg && pkg.png;
  if (png) {
    if (typeof png === "string") {
      const bin = atob(png);
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    }
    if (png instanceof Uint8Array || png instanceof ArrayBuffer) return png;
    if (Array.isArray(png) || typeof png === "object") {
      const vals = Array.isArray(png) ? png : Object.values(png);
      return Uint8Array.from(vals, (b) => Number(b) & 255);
    }
    return png;
  }
  return readPng(env, pkg && pkg.png_key);
}
async function resolveTelegramChannel(env) {
  const candidates = [];
  if (env.TELEGRAM_CHANNEL_ID) candidates.push(String(env.TELEGRAM_CHANNEL_ID).trim());
  if (env.TELEGRAM_PUBLIC_CHANNEL) candidates.push(String(env.TELEGRAM_PUBLIC_CHANNEL).trim());
  candidates.push("@TrustNode_team");
  if (env.BOT_KV) {
    const cached = await env.BOT_KV.get("telegram_channel_id");
    if (cached) return cached;
  }
  for (const c of candidates) {
    if (!c) continue;
    try {
      const info = await tgCall2(env, "getChat", { chat_id: c });
      const resolved = String(info && (info.id !== void 0 ? info.id : c));
      if (env.BOT_KV) await env.BOT_KV.put("telegram_channel_id", resolved);
      return resolved;
    } catch (e) {
    }
  }
  return candidates[0] || String(env.TELEGRAM_CHANNEL_ID || "");
}
async function publishToTelegram(env, pkg, dry) {
  const caption = fitCaption(pkg.caption || "");
  const bytes = await pkgBytes(env, pkg);
  if (!bytes || !bytes.length) {
    throw new Error("\u043D\u0435\u0442 \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0438 \u0434\u043B\u044F TG (png/png_key \u043F\u0443\u0441\u0442)");
  }
  assertValidImage(bytes);
  const dedupKey = String(pkg.guid || pkg.id || "");
  if (dedupKey) {
    try {
      const prev = await env.BOT_KV.get(`tg_posted:${dedupKey}`, "json");
      if (prev && prev.message_id) {
        console.log(`[tg] \u0443\u0436\u0435 \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u043D message=${prev.message_id}, \u043F\u043E\u0432\u0442\u043E\u0440\u043D\u0430\u044F \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u0430: ${pkg.title || pkg.id}`);
        return { ok: true, target: "tg", message_id: prev.message_id, deduped: true };
      }
    } catch (e) {
    }
  }
  const chatId = await resolveTelegramChannel(env);
  if (dry) {
    console.log(`[dry-run] TG sendCard(${isGifBytes(bytes) ? "gif" : "png"}) -> ${chatId}, len=${bytes?.length || 0}, caption=${caption.length} \u0441\u0438\u043C\u0432.`);
    return { ok: true, dry: true, target: "tg" };
  }
  const res = await sendCard(env, chatId, bytes, caption, { parse_mode: "HTML" });
  if (dedupKey && res && res.message_id) {
    try {
      await env.BOT_KV.put(`tg_posted:${dedupKey}`, JSON.stringify({ message_id: res.message_id, at: (/* @__PURE__ */ new Date()).toISOString() }));
    } catch (e) {
    }
  }
  return { ok: true, target: "tg", message_id: res && res.message_id };
}
async function publishToVk(env, pkg, dry) {
  const message = (pkg.caption || "").replace(/<[^>]+>/g, "").trim() || pkg.title || "\u{1F6E1}\uFE0F TrustNode";
  if (dry) {
    console.log(`[dry-run] VK wall.post message=${message.length} \u0441\u0438\u043C\u0432.`);
    return { ok: true, dry: true, target: "vk" };
  }
  const dedupKey = String(pkg.guid || pkg.id || "");
  if (dedupKey) {
    try {
      const prev = await env.BOT_KV.get(`vk_posted:${dedupKey}`, "json");
      if (prev && prev.post_id) {
        console.log(`[vk] \u0443\u0436\u0435 \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u043D post=${prev.post_id}, \u043F\u043E\u0432\u0442\u043E\u0440\u043D\u0430\u044F \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F \u043F\u0440\u043E\u043F\u0443\u0449\u0435\u043D\u0430: ${pkg.title || pkg.id}`);
        return { ok: true, target: "vk", post_id: prev.post_id, vk_attachment: prev.vk_attachment, deduped: true };
      }
    } catch (e) {
    }
  }
  const bytes = await pkgBytes(env, pkg);
  if (!bytes || !bytes.length) {
    throw new Error("\u043D\u0435\u0442 \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0438 \u0434\u043B\u044F VK (png/png_key \u043F\u0443\u0441\u0442)");
  }
  assertValidImage(bytes);
  let gifBytes;
  if (isGifBytes(bytes)) {
    gifBytes = bytes;
    console.log(`[vk] \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0430 \u0443\u0436\u0435 GIF (${gifBytes.length} \u0431\u0430\u0439\u0442), \u043A\u043E\u043D\u0432\u0435\u0440\u0441\u0438\u044F \u043D\u0435 \u043D\u0443\u0436\u043D\u0430`);
  } else {
    console.log("[vk] PNG \u2192 GIF\u2026");
    gifBytes = await pngToGif(bytes);
    console.log(`[vk] GIF \u0433\u043E\u0442\u043E\u0432: ${gifBytes.length} \u0431\u0430\u0439\u0442`);
  }
  console.log("[vk] docs.getWallUploadServer + upload + docs.save\u2026");
  const attachment = await vkUploadWallGif(env, gifBytes);
  console.log(`[vk] doc \u043F\u0440\u0438\u043A\u0440\u0435\u043F\u043B\u0451\u043D: ${attachment}`);
  console.log("[vk] wall.post\u2026");
  const res = await vkPostWall(env, message, attachment);
  const postId = res && res.post_id;
  console.log(`[vk] wall.post \u0443\u0441\u043F\u0435\u0448\u0435\u043D: post=${postId}`);
  if (dedupKey && postId) {
    try {
      await env.BOT_KV.put(`vk_posted:${dedupKey}`, JSON.stringify({ post_id: postId, vk_attachment: attachment, at: (/* @__PURE__ */ new Date()).toISOString() }));
    } catch (e) {
    }
  }
  return { ok: true, target: "vk", post_id: postId, vk_attachment: attachment };
}
function assertValidImage(bytes) {
  if (!bytes || bytes.length < 8) {
    throw new Error("VK: \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0430 \u043F\u0443\u0441\u0442\u0430\u044F \u0438\u043B\u0438 \u0441\u043B\u0438\u0448\u043A\u043E\u043C \u043C\u0430\u043B\u0435\u043D\u044C\u043A\u0430\u044F, \u0447\u0442\u043E\u0431\u044B \u0431\u044B\u0442\u044C \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435\u043C");
  }
  const b = bytes;
  const isPng = b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71 && // .PNG
  b[4] === 13 && b[5] === 10 && b[6] === 26 && b[7] === 10;
  const isJpeg = b[0] === 255 && b[1] === 216 && b[2] === 255;
  const isGif = b[0] === 71 && b[1] === 73 && b[2] === 70 && // "GIF"
  b[3] === 56 && (b[4] === 55 || b[4] === 57) && b[5] === 97;
  if (!isPng && !isJpeg && !isGif) {
    throw new Error("VK: \u0444\u0430\u0439\u043B \u043D\u0435 \u044F\u0432\u043B\u044F\u0435\u0442\u0441\u044F \u0438\u0437\u043E\u0431\u0440\u0430\u0436\u0435\u043D\u0438\u0435\u043C (\u043E\u0436\u0438\u0434\u0430\u043B\u0441\u044F PNG, JPEG \u0438\u043B\u0438 GIF)");
  }
}
async function readPng(env, pngKey) {
  if (!pngKey) return null;
  for (const key of [pngKey, `files/${pngKey}`]) {
    const bytes = await readPngKey(env, key);
    if (bytes) return bytes;
  }
  return null;
}
async function readPngKey(env, key) {
  if (env.BOT_R2) {
    const obj = await env.BOT_R2.get(key);
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }
  if (env.BOT_KV) {
    const b64 = await env.BOT_KV.get(key);
    if (b64 === null) return null;
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }
  return null;
}
async function readFileBytes(env, key) {
  return readPng(env, key);
}
var TG_API, VK_API, VK_VERSION;
var init_telegram = __esm({
  "lib/telegram.js"() {
    init_cardgen();
    init_text();
    TG_API = "https://api.telegram.org/bot";
    VK_API = "https://api.vk.com/method/";
    VK_VERSION = "5.199";
    __name(tgCall2, "tgCall");
    __name(vkCall, "vkCall");
    __name(sendMessage, "sendMessage");
    __name(sendPhoto, "sendPhoto");
    __name(sendAnimation, "sendAnimation");
    __name(isGifBytes, "isGifBytes");
    __name(sendCard, "sendCard");
    __name(editMessageReplyMarkup, "editMessageReplyMarkup");
    __name(answerCallbackQuery, "answerCallbackQuery");
    __name(setMyCommands, "setMyCommands");
    __name(deleteMessage, "deleteMessage");
    __name(forwardMessage, "forwardMessage");
    __name(downloadFile, "downloadFile");
    __name(vkUploadWallPhoto, "vkUploadWallPhoto");
    __name(vkPostWall, "vkPostWall");
    __name(vkUploadWallGif, "vkUploadWallGif");
    __name(vkUploadAlbumPhoto, "vkUploadAlbumPhoto");
    __name(pkgBytes, "pkgBytes");
    __name(resolveTelegramChannel, "resolveTelegramChannel");
    __name(publishToTelegram, "publishToTelegram");
    __name(publishToVk, "publishToVk");
    __name(assertValidImage, "assertValidImage");
    __name(readPng, "readPng");
    __name(readPngKey, "readPngKey");
    __name(readFileBytes, "readFileBytes");
  }
});

// lib/kv.js
init_limits();
async function kvGet(env, key, fallback = null) {
  try {
    const raw = await env.BOT_KV.get(key, "json");
    return raw === null || raw === void 0 ? fallback : raw;
  } catch (e) {
    return fallback;
  }
}
__name(kvGet, "kvGet");
async function kvSet(env, key, value) {
  try {
    await env.BOT_KV.put(key, JSON.stringify(value));
  } catch (e) {
  }
}
__name(kvSet, "kvSet");
async function kvDel(env, key) {
  try {
    await env.BOT_KV.delete(key);
  } catch (e) {
  }
}
__name(kvDel, "kvDel");
async function loadState(env) {
  const s = await kvGet(env, "state", {}) || {};
  s.seen_guids = Array.isArray(s.seen_guids) ? s.seen_guids : [];
  if (!s.counters) s.counters = {};
  if (!s.meta) s.meta = {};
  if (!s.blacklist) s.blacklist = { sources: [], keywords: [], guids: [] };
  if (!s.extra_keywords) s.extra_keywords = [];
  if (!s.removed_keywords) s.removed_keywords = [];
  return s;
}
__name(loadState, "loadState");
async function saveState(env, state) {
  await kvSet(env, "state", state);
}
__name(saveState, "saveState");
async function getAutopost(env) {
  const v = await kvGet(env, "autopost", null);
  if (v !== null && v !== void 0) return !!v;
  const s = await loadState(env);
  const legacy = !!s.autopost;
  await kvSet(env, "autopost", legacy);
  return legacy;
}
__name(getAutopost, "getAutopost");
async function setAutopost(env, on) {
  await kvSet(env, "autopost", !!on);
}
__name(setAutopost, "setAutopost");
async function getCardFormat(env) {
  const v = await kvGet(env, "card_format", "auto");
  return v === "gif" || v === "png" ? v : "auto";
}
__name(getCardFormat, "getCardFormat");
async function setCardFormat(env, fmt) {
  await kvSet(env, "card_format", fmt === "gif" || fmt === "png" ? fmt : "auto");
}
__name(setCardFormat, "setCardFormat");
async function getCandidates(env) {
  return await kvGet(env, "candidates", []) || [];
}
__name(getCandidates, "getCandidates");
async function setCandidates(env, list) {
  await kvSet(env, "candidates", list);
}
__name(setCandidates, "setCandidates");
async function addCandidate(env, cand) {
  const list = await getCandidates(env);
  if (list.some((c) => c.guid === cand.guid)) return;
  list.push(cand);
  if (list.length > MAX_CANDIDATES_QUEUE) list.splice(0, list.length - MAX_CANDIDATES_QUEUE);
  await setCandidates(env, list);
}
__name(addCandidate, "addCandidate");
async function getStock(env) {
  return await kvGet(env, "stock", []) || [];
}
__name(getStock, "getStock");
async function setStock(env, list) {
  await kvSet(env, "stock", list);
}
__name(setStock, "setStock");
async function addStock(env, pkg) {
  const list = await getStock(env);
  if (list.some((p) => p.id === pkg.id)) return;
  list.push(pkg);
  list.sort((a, b) => (a.scheduled_for || 0) - (b.scheduled_for || 0));
  await setStock(env, list);
}
__name(addStock, "addStock");
async function removeStock(env, id) {
  const list = await getStock(env);
  const next = list.filter((p) => p.id !== id);
  await setStock(env, next);
  return next.length !== list.length;
}
__name(removeStock, "removeStock");
async function getLog(env) {
  return await kvGet(env, "publish_log", []) || [];
}
__name(getLog, "getLog");
async function addLog(env, entry) {
  const list = await getLog(env);
  list.unshift(entry);
  if (list.length > MAX_HISTORY) list.length = MAX_HISTORY;
  await kvSet(env, "publish_log", list);
}
__name(addLog, "addLog");
async function loadDraft(env, id) {
  return kvGet(env, `draft:${id}`, null);
}
__name(loadDraft, "loadDraft");
async function saveDraft(env, draft) {
  await kvSet(env, `draft:${draft.id}`, draft);
  const idx = await kvGet(env, "draft_index", []) || [];
  if (!idx.includes(draft.id)) {
    idx.push(draft.id);
    await kvSet(env, "draft_index", idx);
  }
}
__name(saveDraft, "saveDraft");
async function deleteDraft(env, id) {
  await kvDel(env, `draft:${id}`);
  const idx = await kvGet(env, "draft_index", []) || [];
  const next = idx.filter((x) => x !== id);
  await kvSet(env, "draft_index", next);
}
__name(deleteDraft, "deleteDraft");
async function listDrafts(env) {
  const idx = await kvGet(env, "draft_index", []) || [];
  const drafts = [];
  for (const id of idx) {
    const d = await loadDraft(env, id);
    if (d) drafts.push(d);
  }
  return drafts;
}
__name(listDrafts, "listDrafts");
async function getVkRetry(env) {
  return await kvGet(env, "vk_retry", []) || [];
}
__name(getVkRetry, "getVkRetry");
async function setVkRetry(env, list) {
  await kvSet(env, "vk_retry", list);
}
__name(setVkRetry, "setVkRetry");
async function addVkRetry(env, pkg, extra = {}) {
  const list = await getVkRetry(env);
  if (list.some((p) => p.id === pkg.id)) return;
  const missing = extra.missing && extra.missing.length ? extra.missing : ["vk"];
  list.push({
    id: pkg.id,
    kind: pkg.kind || "news",
    title: pkg.title || "",
    caption: pkg.caption || "",
    png_key: pkg.png_key || null,
    png: pkg.png || null,
    // base64-строка или байты
    link: pkg.link || "",
    guid: pkg.guid || "",
    source: pkg.source || "",
    tags: pkg.tags || [],
    missing,
    attempts: Number(pkg.attempts || 0) + 1,
    queued_at: (/* @__PURE__ */ new Date()).toISOString()
  });
  if (list.length > MAX_CANDIDATES_QUEUE) list.splice(0, list.length - MAX_CANDIDATES_QUEUE);
  await setVkRetry(env, list);
}
__name(addVkRetry, "addVkRetry");
async function getDigestDone(env, date, slug) {
  return kvGet(env, `digest_done:${date}:${slug}`, null);
}
__name(getDigestDone, "getDigestDone");
async function setDigestDone(env, date, slug, info = {}) {
  await kvSet(env, `digest_done:${date}:${slug}`, info);
}
__name(setDigestDone, "setDigestDone");
async function markDispatch(env, guid, info) {
  await kvSet(env, `dispatch:${guid}`, info);
}
__name(markDispatch, "markDispatch");
async function getUserMode(env, chatId) {
  return kvGet(env, `user_mode:${chatId}`, null);
}
__name(getUserMode, "getUserMode");
async function setUserMode(env, chatId, mode) {
  if (mode === null) await kvDel(env, `user_mode:${chatId}`);
  else await kvSet(env, `user_mode:${chatId}`, mode);
}
__name(setUserMode, "setUserMode");
async function getSuggestions(env) {
  return await kvGet(env, "suggestions", []) || [];
}
__name(getSuggestions, "getSuggestions");
async function setSuggestions(env, list) {
  await kvSet(env, "suggestions", list);
}
__name(setSuggestions, "setSuggestions");
async function addSuggestion(env, sug) {
  const list = await getSuggestions(env);
  if (list.some((s) => s.id === sug.id)) return;
  list.push(sug);
  if (list.length > 50) list.splice(0, list.length - 50);
  await setSuggestions(env, list);
}
__name(addSuggestion, "addSuggestion");
async function removeSuggestion(env, id) {
  const list = await getSuggestions(env);
  const next = list.filter((s) => s.id !== id);
  await setSuggestions(env, next);
  return next.length !== list.length;
}
__name(removeSuggestion, "removeSuggestion");
async function getSupportFwd(env, adminMessageId) {
  return kvGet(env, `support_fwd:${adminMessageId}`, null);
}
__name(getSupportFwd, "getSupportFwd");
async function setSupportFwd(env, adminMessageId, userChatId) {
  await kvSet(env, `support_fwd:${adminMessageId}`, userChatId);
}
__name(setSupportFwd, "setSupportFwd");
async function delSupportFwd(env, adminMessageId) {
  await kvDel(env, `support_fwd:${adminMessageId}`);
}
__name(delSupportFwd, "delSupportFwd");
async function getEventDialog(env) {
  return kvGet(env, "event_dialog", null);
}
__name(getEventDialog, "getEventDialog");
async function setEventDialog(env, dialog) {
  if (dialog === null) await kvDel(env, "event_dialog");
  else await kvSet(env, "event_dialog", dialog);
}
__name(setEventDialog, "setEventDialog");

// lib/feeds.js
init_config();

// lib/dedup.js
function normalizeTitle(title) {
  let t = (title || "").toLowerCase();
  t = t.replace(/\s+[—–-]\s+[^\s]+(?:\s+[^\s]+){0,3}\s*$/, "");
  t = t.replace(/\s+[\/|]\s+[^\s]+(?:\s+[^\s]+){0,3}\s*$/, "");
  t = t.replace(/[^а-яёa-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  return t;
}
__name(normalizeTitle, "normalizeTitle");
function tokenize(text) {
  const t = normalizeTitle(text);
  return t ? t.split(" ") : [];
}
__name(tokenize, "tokenize");
function jaccard(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.length || !tb.length) return 0;
  const sa = new Set(ta);
  const sb = new Set(tb);
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}
__name(jaccard, "jaccard");
var DUP_THRESHOLD = 0.62;
function clusterDuplicates(cands) {
  const groups = [];
  for (const c of cands) {
    const nt = normalizeTitle(c.title);
    let placed = false;
    for (const g of groups) {
      if (jaccard(g.norm, nt) >= DUP_THRESHOLD) {
        g.items.push(c);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ norm: nt, items: [c] });
  }
  return groups.map((g, i) => {
    const best = g.items.reduce(
      (a, b) => (b.description || "").length > (a.description || "").length ? b : a
    );
    return { cluster_id: `c${i}`, items: g.items, best };
  });
}
__name(clusterDuplicates, "clusterDuplicates");
function buildClusterText(cluster, excerpt) {
  const seen = /* @__PURE__ */ new Set();
  const links = [];
  for (const it of cluster.items) {
    if (seen.has(it.link)) continue;
    seen.add(it.link);
    links.push(it.link);
  }
  const primary = excerpt || cluster.best.description || "";
  const extra = links.slice(1).map((l) => `- ${l}`).join("\n");
  let text = `${cluster.best.title}

${primary}

\u0418\u0441\u0442\u043E\u0447\u043D\u0438\u043A: ${links[0]}`;
  if (extra) text += `

\u0421\u0432\u044F\u0437\u0430\u043D\u043D\u044B\u0435 \u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A\u0438 \u044D\u0442\u043E\u0439 \u0436\u0435 \u043D\u043E\u0432\u043E\u0441\u0442\u0438:
${extra}`;
  return text;
}
__name(buildClusterText, "buildClusterText");

// lib/feeds.js
var REQUEST_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; TrustNodeBot/1.0)" };
function decodeFeedBytes(bytes) {
  const latin = new TextDecoder("latin1");
  const head = latin.decode(bytes.slice(0, 300));
  const m = /<\?xml[^>]*encoding=["']([^"']+)["']/i.exec(head) || /charset=["']?([\w-]+)/i.exec(head);
  const declared = m ? m[1].toLowerCase() : "";
  if (declared && !/^utf-?8$/.test(declared)) {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch (e) {
    }
  }
  const text = new TextDecoder("utf-8").decode(bytes);
  if (text.includes("\uFFFD")) {
    try {
      return new TextDecoder("windows-1251").decode(bytes);
    } catch (e) {
    }
  }
  return text;
}
__name(decodeFeedBytes, "decodeFeedBytes");
var DEFAULT_SOURCES = {
  feeds: [
    "https://ria.ru/export/rss2/index.xml",
    "https://lenta.ru/rss/news",
    "https://www.gazeta.ru/export/rss/social_more.xml",
    "https://www.kommersant.ru/RSS/news.xml",
    "https://tass.ru/rss/v2.xml",
    "https://www.interfax.ru/rss.asp",
    "https://rg.ru/xml/index.xml",
    "https://vz.ru/rss.xml",
    "https://rssexport.rbc.ru/rbcnews/news/30/full.rss"
  ],
  keywords: ["\u043C\u043E\u0448\u0435\u043D\u043D\u0438\u043A", "\u043C\u043E\u0448\u0435\u043D\u043D\u0438\u0447\u0435\u0441\u0442\u0432", "\u0444\u0438\u0448\u0438\u043D\u0433", "\u043A\u0438\u0431\u0435\u0440\u043C\u043E\u0448\u0435\u043D\u043D\u0438\u043A", "\u0434\u0440\u043E\u043F\u043F\u0435\u0440"],
  exclude_keywords: []
};
async function fetchJson(env, path) {
  if (!env.GITHUB_TOKEN) return null;
  const res = await fetch(
    `https://api.github.com/repos/${env.OWNER}/${env.REPO}/contents/${path}`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "tgvk-bot-webhook"
      }
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.content) return null;
  const bin = atob(data.content.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}
__name(fetchJson, "fetchJson");
async function loadSources(env) {
  const repo = await fetchJson(env, "config/sources.json");
  if (repo && Array.isArray(repo.feeds) && repo.feeds.length) return repo;
  return DEFAULT_SOURCES;
}
__name(loadSources, "loadSources");
function applyOverrides(config, state) {
  const keywords = [...config.keywords || []];
  for (const k of state.extra_keywords || []) if (!keywords.includes(k)) keywords.push(k);
  for (const k of state.removed_keywords || []) {
    const i = keywords.indexOf(k);
    if (i >= 0) keywords.splice(i, 1);
  }
  return {
    ...config,
    keywords,
    exclude_keywords: [...config.exclude_keywords || [], ...state.blacklist?.keywords || []]
  };
}
__name(applyOverrides, "applyOverrides");
function hasAny(text, keywords) {
  const low = (text || "").toLowerCase();
  return keywords.some((k) => low.includes((k || "").toLowerCase()));
}
__name(hasAny, "hasAny");
var CODE_HINTS = [
  "function",
  "window.",
  "document.",
  "=>",
  "var ",
  "counter",
  "topmailru",
  "yandex",
  "liveinternet",
  "advad",
  "adblock",
  "script",
  "push({"
];
function looksLikeCode(text) {
  if (text.includes("{") && text.includes("}")) return true;
  const low = text.toLowerCase();
  return CODE_HINTS.some((h) => low.includes(h));
}
__name(looksLikeCode, "looksLikeCode");
function isRussianText(text) {
  const t = (text || "").replace(/\s+/g, "");
  if (t.length < 12) return true;
  const cyr = (t.match(/[\u0400-\u04FF]/g) || []).length;
  return cyr / t.length >= 0.35;
}
__name(isRussianText, "isRussianText");
async function fetchArticleExcerpt(url, maxChars = 2500) {
  try {
    const res = await fetch(url, { headers: REQUEST_HEADERS });
    if (!res.ok) return "";
    const html = await res.text();
    const pRe = /<p[^>]*>(.*?)<\/p>/gis;
    const parts = [];
    let m;
    while ((m = pRe.exec(html)) !== null) {
      const p = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (p.length > 40 && !looksLikeCode(p)) {
        parts.push(p);
        if (parts.join(" ").length > maxChars) break;
      }
    }
    return parts.join(" ").slice(0, maxChars);
  } catch (e) {
    return "";
  }
}
__name(fetchArticleExcerpt, "fetchArticleExcerpt");
async function scanFeeds(env, chunkOffset = 0, chunkCount = 2) {
  const config = applyOverrides(await loadSources(env), await loadState(env));
  const feeds = config.feeds || [];
  const keywords = config.keywords || [];
  const exclude = config.exclude_keywords || [];
  if (!feeds.length) return [];
  const step = Math.max(1, Math.ceil(feeds.length / chunkCount));
  const slice = feeds.filter((_, i) => i % chunkCount === chunkOffset);
  const seenState = await loadState(env);
  const seenGuids = new Set(seenState.seen_guids || []);
  const queueGuids = new Set((await getCandidates(env)).map((c) => c.guid));
  const now = Date.now();
  const raw = [];
  const fetched = [];
  for (const feedUrl of slice) {
    try {
      const res = await fetch(feedUrl, { headers: REQUEST_HEADERS });
      if (!res.ok) continue;
      const xml = decodeFeedBytes(new Uint8Array(await res.arrayBuffer()));
      for (const item of parseRSS(xml)) {
        if (seenGuids.has(item.guid) || queueGuids.has(item.guid)) continue;
        const pd = parsePubDate(item.pub_date);
        if (!pd || now - pd.getTime() > MAX_AGE_MS) continue;
        const haystack = item.title + " " + item.description;
        if (!hasAny(haystack, keywords)) continue;
        if (hasAny(haystack, exclude)) continue;
        if (!isRussianText(haystack)) continue;
        raw.push(item);
      }
    } catch (e) {
    }
  }
  const clusters = clusterDuplicates(raw);
  for (const cl of clusters) {
    const bestPd = parsePubDate(cl.best.pub_date);
    const cand = {
      guid: cl.best.guid,
      cluster_id: cl.cluster_id,
      title: cl.best.title,
      link: cl.best.link,
      links: cl.items.map((i) => i.link),
      description: cl.best.description,
      pub_ts: bestPd ? bestPd.getTime() : null,
      fresh: bestPd ? now - bestPd.getTime() <= FRESH_MS : false,
      found_at: (/* @__PURE__ */ new Date()).toISOString()
    };
    if (cand.fresh || true) {
      cand.excerpt = await fetchArticleExcerpt(cand.link);
      cand.text = buildClusterText(cl, cand.excerpt);
    }
    await addCandidate(env, cand);
    fetched.push(cand);
  }
  return fetched;
}
__name(scanFeeds, "scanFeeds");

// lib/scheduler.js
init_config();

// lib/llm.js
init_config();
init_text();

// lib/nlp.js
var NON_END_ABBR = /* @__PURE__ */ new Set([
  "\u0442.\u0435",
  "\u0442.\u0435.",
  "\u0442.\u0434",
  "\u0442.\u0434.",
  "\u0442.\u043F",
  "\u0442.\u043F.",
  "\u0442.\u043A",
  "\u0442.\u043A.",
  "\u0442.\u043D",
  "\u0442.\u043D.",
  "\u0433",
  "\u0433.",
  "\u0433\u0433",
  "\u0433\u0433.",
  "\u0440\u0443\u0431",
  "\u0440\u0443\u0431.",
  "\u043C\u043B\u043D",
  "\u043C\u043B\u043D.",
  "\u043C\u043B\u0440\u0434",
  "\u043C\u043B\u0440\u0434.",
  "\u0442\u044B\u0441",
  "\u0442\u044B\u0441.",
  "\u0441\u0442\u0440",
  "\u0441\u0442\u0440.",
  "\u0441\u043C",
  "\u0441\u043C.",
  "\u0434\u0440",
  "\u0434\u0440.",
  "\u043F\u0440\u043E\u0447",
  "\u043F\u0440\u043E\u0447.",
  "\u043D\u0430\u043F\u0440",
  "\u043D\u0430\u043F\u0440.",
  "\u0438\u043C",
  "\u0438\u043C.",
  "\u0443\u043B",
  "\u0443\u043B.",
  "\u043F\u043B",
  "\u043F\u043B.",
  "\u043E\u0431\u043B",
  "\u043E\u0431\u043B.",
  "\u0432 \u0442.\u0447",
  "\u0432 \u0442.\u0447.",
  "\u0441",
  "\u0441.",
  "\u043E\u043A",
  "\u043E\u043A.",
  "\u043D\u043E\u043C\u0435\u0440",
  "\u043D\u043E\u043C\u0435\u0440."
]);
function splitSentences(text) {
  const src = String(text || "").replace(/\s+/g, " ").trim();
  if (!src) return [];
  const parts = src.split(/(?<=[.!?…])\s+/);
  const out = [];
  for (let p of parts) {
    p = p.trim();
    if (!p) continue;
    const prev = out[out.length - 1];
    const m = p.match(/(?:^|\s)([а-яёa-z.]{1,5}\.\.?)$/i);
    if (m && NON_END_ABBR.has(m[1].toLowerCase())) {
      if (prev) out[out.length - 1] = prev + " " + p;
      else out.push(p);
      continue;
    }
    out.push(p);
  }
  return out;
}
__name(splitSentences, "splitSentences");
function tokens(text) {
  return String(text || "").toLowerCase().match(/[а-яёa-z0-9]+/g) || [];
}
__name(tokens, "tokens");
var TOPIC_MODEL = [
  {
    id: "call",
    label: "\u0422\u0435\u043B\u0435\u0444\u043E\u043D\u043D\u043E\u0435 \u043C\u043E\u0448\u0435\u043D\u043D\u0438\u0447\u0435\u0441\u0442\u0432\u043E",
    hint: "\u0417\u0432\u043E\u043D\u043E\u043A \u043C\u043E\u0448\u0435\u043D\u043D\u0438\u043A\u0430",
    weight: 2,
    threat: 2,
    re: [
      /звон(?:ят|ит|ают)|позвонил|телефонн\w+|по телефону|оператор|колл-центр|представился\w*\s*(сотрудником|банк|оператором)/,
      /безопасн\w*\s*счёт|безопасный счет|перевести\s+деньги|перевод\s+денег|лжеоператор\w*|снят\w+\s+по\s+телефону/,
      /из\s+банка|банка\s+звонят|служб\w*\s+безопасност\w*/
    ],
    tips: [
      "\u041F\u043E\u043B\u043E\u0436\u0438\u0442\u0435 \u0442\u0440\u0443\u0431\u043A\u0443 \u0438 \u043F\u0435\u0440\u0435\u0437\u0432\u043E\u043D\u0438\u0442\u0435 \u0432 \u0431\u0430\u043D\u043A \u043F\u043E \u043D\u043E\u043C\u0435\u0440\u0443 \u0441 \u043E\u0431\u0440\u0430\u0442\u043D\u043E\u0439 \u0441\u0442\u043E\u0440\u043E\u043D\u044B \u043A\u0430\u0440\u0442\u044B",
      "\u0421\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u0438 \u0431\u0430\u043D\u043A\u0430 \u043D\u0438\u043A\u043E\u0433\u0434\u0430 \u043D\u0435 \u043F\u0440\u043E\u0441\u044F\u0442 \u043A\u043E\u0434 \u0438\u0437 SMS \u0438\u043B\u0438 \u043F\u0435\u0440\u0435\u0432\u043E\u0434 \xAB\u043D\u0430 \u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u044B\u0439 \u0441\u0447\u0451\u0442\xBB"
    ]
  },
  {
    id: "sms",
    label: "\u041A\u043E\u0434 \u0438\u0437 SMS",
    hint: "\u041A\u043E\u0434 \u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u044F",
    weight: 1.5,
    threat: 2,
    re: [
      /код (?:из |в )?[сs]мс?|код подтверждени\w*|смс-код|подтверждени\w*\s+вход|телефонную подтвержден/,
      /не\s+(?:называй|сообщай|передавай|говори)\w*\s+код/,
      /смс|сообщени\w+\s+с\s+кодом|sms/
    ],
    tips: [
      "\u041A\u043E\u0434 \u0438\u0437 SMS \u2014 \u044D\u0442\u043E \u043A\u043B\u044E\u0447 \u043A \u0432\u0430\u0448\u0435\u043C\u0443 \u0430\u043A\u043A\u0430\u0443\u043D\u0442\u0443. \u041D\u0438\u043A\u043E\u043C\u0443 \u0435\u0433\u043E \u043D\u0435 \u043D\u0430\u0437\u044B\u0432\u0430\u0439\u0442\u0435.",
      "\u0411\u0430\u043D\u043A, \u0433\u043E\u0441\u043E\u0440\u0433\u0430\u043D \u0438 \xAB\u0441\u043B\u0443\u0436\u0431\u0430 \u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u0438\xBB \u043D\u0438\u043A\u043E\u0433\u0434\u0430 \u043D\u0435 \u0437\u0430\u043F\u0440\u0430\u0448\u0438\u0432\u0430\u044E\u0442 \u043A\u043E\u0434 \u043F\u043E \u0442\u0435\u043B\u0435\u0444\u043E\u043D\u0443"
    ]
  },
  {
    id: "phishing",
    label: "\u0424\u0438\u0448\u0438\u043D\u0433",
    hint: "\u0424\u0438\u0448\u0438\u043D\u0433-\u0441\u0441\u044B\u043B\u043A\u0430",
    weight: 2,
    threat: 2,
    re: [
      /фишинг|фишингов\w+|фейков\w+\s*(?:сайт|страниц|приложени|ссылк)|поддельн\w+\s*(?:сайт|ссылк|страниц)/,
      /перейти\s+по\s+ссылк|ссылка\s+на\s+сайт|подозрительн\w+\s+ссылк|ссылк\w+\s+заблокирован/,
      /qr-код|qr\s+код|фейк\w*|поддел\w+\s+(?:сайт|приложени)/
    ],
    tips: [
      "\u041F\u0440\u043E\u0432\u0435\u0440\u044F\u0439\u0442\u0435 \u0430\u0434\u0440\u0435\u0441 \u0441\u0430\u0439\u0442\u0430 \u043F\u0435\u0440\u0435\u0434 \u0432\u0432\u043E\u0434\u043E\u043C \u0434\u0430\u043D\u043D\u044B\u0445 \u2014 \u043F\u043E\u0434\u0434\u0435\u043B\u043A\u0430 \u043C\u043E\u0436\u0435\u0442 \u043E\u0442\u043B\u0438\u0447\u0430\u0442\u044C\u0441\u044F \u043E\u0434\u043D\u043E\u0439 \u0431\u0443\u043A\u0432\u043E\u0439",
      "\u041D\u0435 \u043F\u0435\u0440\u0435\u0445\u043E\u0434\u0438\u0442\u0435 \u043F\u043E \u0441\u0441\u044B\u043B\u043A\u0430\u043C \u0438 QR-\u043A\u043E\u0434\u0430\u043C \u043E\u0442 \u043D\u0435\u0437\u043D\u0430\u043A\u043E\u043C\u0446\u0435\u0432 \u0438 \u0432 \u0441\u043E\u043C\u043D\u0438\u0442\u0435\u043B\u044C\u043D\u044B\u0445 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F\u0445"
    ]
  },
  {
    id: "invest",
    label: "\u0424\u0435\u0439\u043A\u043E\u0432\u044B\u0435 \u0438\u043D\u0432\u0435\u0441\u0442\u0438\u0446\u0438\u0438",
    hint: "\u0418\u043D\u0432\u0435\u0441\u0442\u0438\u0446\u0438\u0438/\u043A\u0440\u0438\u043F\u0442\u043E",
    weight: 1.8,
    threat: 2,
    re: [
      /инвест\w+|крипто|криптовалют\w+|биткоин|пассивн\w+\s+доход|гарантированн\w+\s+доход/,
      /вложени\w+|доходност\w+\s+до|заработ\w+\s+без\s+вложени|брокер\w+|пирамид\w+/,
      /обман\w*\s+вклад|реклам\w*\s+заработ/
    ],
    tips: [
      "\u0413\u0430\u0440\u0430\u043D\u0442\u0438\u0440\u043E\u0432\u0430\u043D\u043D\u044B\u0439 \u0434\u043E\u0445\u043E\u0434 \xAB\u043F\u0440\u044F\u043C\u043E \u0441\u0435\u0439\u0447\u0430\u0441\xBB \u2014 \u043F\u0440\u0438\u0437\u043D\u0430\u043A \u043C\u043E\u0448\u0435\u043D\u043D\u0438\u0447\u0435\u0441\u0442\u0432\u0430",
      "\u041D\u0435 \u0432\u044B\u0432\u043E\u0434\u0438\u0442\u0435 \u0441\u0440\u0435\u0434\u0441\u0442\u0432\u0430 \u043D\u0430 \xAB\u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u044B\u0439 \u0441\u0447\u0451\u0442\xBB \u0438 \u043D\u0435 \u043F\u0435\u0440\u0435\u0434\u0430\u0432\u0430\u0439\u0442\u0435 \u0434\u043E\u0441\u0442\u0443\u043F \u043A \u043A\u043E\u0448\u0435\u043B\u044C\u043A\u0443"
    ]
  },
  {
    id: "gosuslugi",
    label: "\u0413\u043E\u0441\u0443\u0441\u043B\u0443\u0433\u0438",
    hint: "\u0410\u043A\u043A\u0430\u0443\u043D\u0442 \u043D\u0430 \u0413\u043E\u0441\u0443\u0441\u043B\u0443\u0433\u0430\u0445",
    weight: 1.6,
    threat: 2,
    re: [
      /госуслуг\w+|аккаунт\s+взлома\w*|взлом\w+\s+аккаунт|восстанови\w*\s+доступ/,
      /портал\s+госуслуг|мошенник\w*\s+госуслуг/
    ],
    tips: [
      "\u041D\u0430\u0441\u0442\u043E\u044F\u0449\u0438\u0435 \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A\u0438 \u043D\u0435 \u043F\u0440\u043E\u0441\u044F\u0442 \u043A\u043E\u0434 \u0438\u0437 SMS \u0438\u043B\u0438 \xAB\u043F\u043E\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043D\u0438\u0435 \u0432\u0445\u043E\u0434\u0430\xBB \u043F\u043E \u0442\u0435\u043B\u0435\u0444\u043E\u043D\u0443",
      "\u0421\u043C\u0435\u043D\u0438\u0442\u0435 \u043F\u0430\u0440\u043E\u043B\u044C \u0442\u043E\u043B\u044C\u043A\u043E \u0447\u0435\u0440\u0435\u0437 \u043E\u0444\u0438\u0446\u0438\u0430\u043B\u044C\u043D\u044B\u0439 \u043F\u043E\u0440\u0442\u0430\u043B, \u043D\u0435 \u043F\u043E \u0441\u0441\u044B\u043B\u043A\u0435 \u0438\u0437 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F"
    ]
  },
  {
    id: "fake_org",
    label: "\u0424\u0435\u0439\u043A\u043E\u0432\u044B\u0439 \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A",
    hint: "\u0424\u0435\u0439\u043A\u043E\u0432\u044B\u0439 \u0441\u043E\u0442\u0440\u0443\u0434\u043D\u0438\u043A",
    weight: 1.7,
    threat: 2,
    re: [
      /представил\w*\s+(?:полицейск\w+|сотрудник\w+\s+фсб|следовател\w+|прокурор\w+|фсб|полицейск\w+)/,
      /служб\w*\s+безопасност\w+|следовател\w+|фсб|прокурор\w+|полицейск\w+/,
      /звон\w+\s+из\s+прокуратур\w+|орган\w+\s+(?:следстви\w+|дознани\w+)/
    ],
    tips: [
      "\u041D\u0435\u0437\u043D\u0430\u043A\u043E\u043C\u0435\u0446 \xAB\u0438\u0437 \u043E\u0440\u0433\u0430\u043D\u043E\u0432\xBB \u043D\u0435 \u0438\u043C\u0435\u0435\u0442 \u043F\u0440\u0430\u0432\u0430 \u0442\u0440\u0435\u0431\u043E\u0432\u0430\u0442\u044C \u0434\u0435\u043D\u044C\u0433\u0438 \u0438\u043B\u0438 \u0434\u043E\u0441\u0442\u0443\u043F \u043F\u043E \u0442\u0435\u043B\u0435\u0444\u043E\u043D\u0443",
      "\u041F\u0435\u0440\u0435\u043F\u0440\u043E\u0432\u0435\u0440\u044F\u0439\u0442\u0435 \u043B\u0438\u0447\u043D\u043E\u0441\u0442\u044C \u0437\u0432\u043E\u043D\u044F\u0449\u0435\u0433\u043E, \u043F\u043E\u0437\u0432\u043E\u043D\u0438\u0432 \u043F\u043E \u043E\u0444\u0438\u0446\u0438\u0430\u043B\u044C\u043D\u043E\u043C\u0443 \u043D\u043E\u043C\u0435\u0440\u0443 \u0432\u0435\u0434\u043E\u043C\u0441\u0442\u0432\u0430"
    ]
  },
  {
    id: "card",
    label: "\u0411\u0430\u043D\u043A\u043E\u0432\u0441\u043A\u0438\u0435 \u043A\u0430\u0440\u0442\u044B",
    hint: "\u041A\u0430\u0440\u0442\u044B \u0438 \u043F\u043B\u0430\u0442\u0435\u0436\u0438",
    weight: 1.4,
    threat: 1,
    re: [
      /банковск\w+\s+карт\w+|платежн\w+\s+карт\w+|виртуальн\w+\s+карт\w+/,
      /списан\w+\s+(?:деньги|средств\w+|карт\w+)|деньги\s+с\s+карт\w*|списани\w*\s+средств/,
      /перевыпуск\w*\s+карт\w+|привязанн\w+\s+карт\w+|бесконтактн\w+\s+платеж\w+/
    ],
    tips: [
      "\u0414\u0435\u0440\u0436\u0438\u0442\u0435 \u043B\u0438\u043C\u0438\u0442 \u043D\u0430 \u0438\u043D\u0442\u0435\u0440\u043D\u0435\u0442-\u043F\u043B\u0430\u0442\u0435\u0436\u0438 \u0438 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0439\u0442\u0435 \u0432\u0438\u0440\u0442\u0443\u0430\u043B\u044C\u043D\u0443\u044E \u043A\u0430\u0440\u0442\u0443 \u0434\u043B\u044F \u043F\u043E\u043A\u0443\u043F\u043E\u043A",
      "\u041F\u0440\u0438 \u043F\u043E\u0434\u043E\u0437\u0440\u0438\u0442\u0435\u043B\u044C\u043D\u043E\u043C \u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0438 \u0441\u0440\u0430\u0437\u0443 \u0437\u0430\u0431\u043B\u043E\u043A\u0438\u0440\u0443\u0439\u0442\u0435 \u043A\u0430\u0440\u0442\u0443 \u0432 \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0438 \u0431\u0430\u043D\u043A\u0430"
    ]
  },
  {
    id: "malware",
    label: "\u0412\u0440\u0435\u0434\u043E\u043D\u043E\u0441\u043D\u043E\u0435 \u041F\u041E",
    hint: "\u0412\u0438\u0440\u0443\u0441/\u0442\u0440\u043E\u044F\u043D",
    weight: 1.6,
    threat: 2,
    re: [
      /вредоносн\w+\s+по|вредонос\w+|троян\w+|шпионск\w+\s+по|вирус\w+/,
      /зловред\w+|зараженн\w+\s+(?:устройств|приложени)|malware|ransomware/,
      /приложени\w+\s+мошенник\w*|поддел\w+\s+приложени\w+|перехват\w+\s+смс/
    ],
    tips: [
      "\u0421\u0442\u0430\u0432\u044C\u0442\u0435 \u043F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u0442\u043E\u043B\u044C\u043A\u043E \u0438\u0437 \u043E\u0444\u0438\u0446\u0438\u0430\u043B\u044C\u043D\u044B\u0445 \u043C\u0430\u0433\u0430\u0437\u0438\u043D\u043E\u0432 \u0438 \u043F\u0440\u043E\u0432\u0435\u0440\u044F\u0439\u0442\u0435 \u0440\u0430\u0437\u0440\u0430\u0431\u043E\u0442\u0447\u0438\u043A\u0430",
      "\u041D\u0435 \u043E\u0442\u043A\u0440\u044B\u0432\u0430\u0439\u0442\u0435 \u0432\u043B\u043E\u0436\u0435\u043D\u0438\u044F \u0438\u0437 \u043D\u0435\u0437\u043D\u0430\u043A\u043E\u043C\u044B\u0445 \u043F\u0438\u0441\u0435\u043C \u2014 \u0442\u0430\u043C \u0447\u0430\u0441\u0442\u043E \u0431\u044B\u0432\u0430\u044E\u0442 \u0442\u0440\u043E\u044F\u043D\u044B"
    ]
  },
  {
    id: "leak",
    label: "\u0423\u0442\u0435\u0447\u043A\u0430 \u0434\u0430\u043D\u043D\u044B\u0445",
    hint: "\u0423\u0442\u0435\u0447\u043A\u0430 \u0434\u0430\u043D\u043D\u044B\u0445",
    weight: 1.4,
    threat: 1,
    re: [
      /утечк\w+\s+(?:данн\w+|персональн\w+|баз\w+)|слили\s+баз\w+|слит\w+\s+данн\w+/,
      /персональн\w+\s+данн\w+|база\s+данн\w+\s+(?:оказалась|попал\w*|появилась)/,
      /данные\s+(?:попали|утекли|были\s+скомпрометированы)/
    ],
    tips: [
      "\u041F\u043E\u0441\u043B\u0435 \u0443\u0442\u0435\u0447\u043A\u0438 \u0441\u043C\u0435\u043D\u0438\u0442\u0435 \u043F\u0430\u0440\u043E\u043B\u0438 \u0438 \u0432\u043A\u043B\u044E\u0447\u0438\u0442\u0435 \u0434\u0432\u0443\u0445\u0444\u0430\u043A\u0442\u043E\u0440\u043D\u0443\u044E \u0430\u0443\u0442\u0435\u043D\u0442\u0438\u0444\u0438\u043A\u0430\u0446\u0438\u044E",
      "\u041F\u0440\u043E\u0432\u0435\u0440\u044C\u0442\u0435, \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u043B\u0438 \u043B\u0438 \u0432\u044B \u043E\u0434\u0438\u043D\u0430\u043A\u043E\u0432\u044B\u0439 \u043F\u0430\u0440\u043E\u043B\u044C \u043D\u0430 \u0443\u0442\u0451\u043A\u0448\u0438\u0445 \u0441\u0435\u0440\u0432\u0438\u0441\u0430\u0445"
    ]
  },
  {
    id: "job",
    label: "\u041B\u043E\u0436\u043D\u044B\u0435 \u0432\u0430\u043A\u0430\u043D\u0441\u0438\u0438",
    hint: "\u0412\u0430\u043A\u0430\u043D\u0441\u0438\u0438-\u043F\u0440\u0438\u043C\u0430\u043D\u043A\u0438",
    weight: 1.4,
    threat: 1,
    re: [
      /ваканси\w+|работодател\w+|зaрплат\w+|набор\s+сотрудник\w+|удалённ\w+\s+работ/,
      /предлагают\s+заработок|заработок\s+в\s+интернет|заработ\w+\s+на\s+отзыв\w+/,
      /оформление\w*\s+займ\w+|кредит\w+\s+на\s+вас/
    ],
    tips: [
      "\u041D\u0435 \u043E\u0442\u043F\u0440\u0430\u0432\u043B\u044F\u0439\u0442\u0435 \u043F\u0430\u0441\u043F\u043E\u0440\u0442\u043D\u044B\u0435 \u0434\u0430\u043D\u043D\u044B\u0435 \u0432 \xAB\u043B\u0438\u0447\u043D\u044B\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u044F\xBB \u043D\u0435\u0437\u043D\u0430\u043A\u043E\u043C\u044B\u043C \u0440\u0430\u0431\u043E\u0442\u043E\u0434\u0430\u0442\u0435\u043B\u044F\u043C",
      "\u041F\u0440\u043E\u0432\u0435\u0440\u044F\u0439\u0442\u0435 \u043A\u043E\u043C\u043F\u0430\u043D\u0438\u044E \u043F\u043E \u0418\u041D\u041D \u0438 \u043E\u0444\u0438\u0446\u0438\u0430\u043B\u044C\u043D\u043E\u043C\u0443 \u0441\u0430\u0439\u0442\u0443 \u043F\u0435\u0440\u0435\u0434 \u043F\u0435\u0440\u0435\u0434\u0430\u0447\u0435\u0439 \u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u043E\u0432"
    ]
  }
];
function classifyTopics(text) {
  const src = String(text || "").toLowerCase();
  const scored = TOPIC_MODEL.map((t) => {
    let hits = 0;
    for (const re of t.re) if (re.test(src)) hits++;
    return { ...t, score: hits ? t.weight + Math.min(hits - 1, 2) * 0.5 : 0 };
  }).filter((t) => t.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
__name(classifyTopics, "classifyTopics");
function mainTopic(text) {
  const list = classifyTopics(text);
  return list.length ? list[0] : null;
}
__name(mainTopic, "mainTopic");
var STAT_RE = /(\d[\d\s.,]*\d?)\s*(%|млн|млрд|тыс\.?|₽|руб(?:лей)?|миллион\w*|тысяч\w*|млрд\s*руб|процент\w*|из\s+\d+)/gi;
function extractStats(text) {
  const sents = splitSentences(text);
  const out = [];
  for (let i = 0; i < sents.length; i++) {
    const s = sents[i];
    const m = s.match(STAT_RE);
    if (!m) continue;
    for (const raw of m) {
      const val = raw.replace(/\s+/g, " ");
      if (!/\d/.test(val)) continue;
      out.push({
        value: val.slice(0, 14),
        context: stripInSentence(s),
        sentenceIdx: i
      });
      break;
    }
  }
  return out;
}
__name(extractStats, "extractStats");
var ORG_RE = /(?:^|[^а-яёa-z])(МВД|ЦБ|Центробанк|Банк России|Госуслуг\w*|ФСБ|Минцифры|Роскомнадзор|прокуратур\w*|СКР|Следственн\w+\s+комитет|РЖД|Сбербанк|ВТБ|Т-Банк|Альфа-Банк|Минфин|ФНС|ФАС)(?=$|[^а-яёa-z])/gi;
function extractOrgs(text) {
  const found = /* @__PURE__ */ new Set();
  const m = String(text || "").match(ORG_RE);
  if (m) for (const o of m) found.add(o.trim());
  return [...found];
}
__name(extractOrgs, "extractOrgs");
var LEAD_WORDS = [
  "\u043F\u043E \u0434\u0430\u043D\u043D\u044B\u043C",
  "\u043A\u0430\u043A \u0441\u043E\u043E\u0431\u0449",
  "\u043F\u043E \u0438\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u0438",
  "\u0441\u043E\u0433\u043B\u0430\u0441\u043D\u043E",
  "\u0441\u043E\u043E\u0431\u0449\u0438\u043B",
  "\u0441\u043E\u043E\u0431\u0449\u0438\u043B\u0430",
  "\u0440\u0430\u0441\u0441\u043A\u0430\u0437\u0430\u043B",
  "\u0440\u0430\u0441\u0441\u043A\u0430\u0437\u0430\u043B\u0430",
  "\u0437\u0430\u044F\u0432\u0438\u043B",
  "\u0437\u0430\u044F\u0432\u0438\u043B\u0430",
  "\u043E\u0442\u043C\u0435\u0442\u0438\u043B\u0430",
  "\u043F\u043E\u0434\u0447\u0435\u0440\u043A\u043D\u0443\u043B",
  "\u043A\u0430\u043A \u043F\u0435\u0440\u0435\u0434\u0430\u0451\u0442",
  "\u043F\u043E \u0441\u043B\u043E\u0432\u0430\u043C",
  "\u0441\u0442\u0430\u043B\u043E \u0438\u0437\u0432\u0435\u0441\u0442\u043D\u043E",
  "\u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A \u0441\u043A\u0430\u0437\u0430\u043B",
  "\u0432\u044B\u044F\u0441\u043D\u0438\u043B\u043E\u0441\u044C"
];
function stripLead(sent) {
  let s = String(sent || "").trim();
  const low = s.toLowerCase();
  for (const w of LEAD_WORDS) {
    if (!low.startsWith(w)) continue;
    const afterWord = s.slice(w.length).replace(/^[,: ]+/, "");
    const commaIdx = afterWord.indexOf(",");
    if (commaIdx > 3 && commaIdx < 40) s = afterWord.slice(commaIdx + 1).trim();
    else s = afterWord;
    if (s.length < 20) return String(sent || "").trim();
    break;
  }
  return capFirst(s);
}
__name(stripLead, "stripLead");
function capFirst(s) {
  const t = String(s || "").trim();
  if (!t) return t;
  return t[0].toUpperCase() + t.slice(1);
}
__name(capFirst, "capFirst");
function factScore(sent, topic, idx) {
  let score = 10 - Math.min(idx, 5) * 1.2;
  if (/\d/.test(sent)) score += 4;
  if (topic) {
    for (const re of topic.re) if (re.test(sent.toLowerCase())) score += 2;
  }
  if (/(мошенник|атака|взлом|утечк|схем|фрод)/i.test(sent)) score += 1.5;
  const len = sent.length;
  if (len >= 40 && len <= 170) score += 2;
  else if (len < 20) score -= 2;
  if (stripLead(sent) !== sent.trim()) score -= 0.5;
  return score;
}
__name(factScore, "factScore");
function rankFacts(sentences, topic, { max = 4, minLen = 25, maxLen = 180 } = {}) {
  const skipFirst = sentences.length > 1;
  return sentences.map((s, i) => ({ s, i, score: factScore(s, topic, i) })).filter((f) => {
    if (skipFirst && f.i === 0) return false;
    const t = f.s.replace(/^[\s\d.,\-–:]+/, "").trim();
    return t.length >= minLen && t.length <= maxLen && !/^(москва|риа|tass|интерфакс)/i.test(t);
  }).sort((a, b) => b.score - a.score).slice(0, max).map((f) => stripPunct(stripLead(f.s))).map((s) => s.slice(0, 150));
}
__name(rankFacts, "rankFacts");
function stripPunct(s) {
  return String(s || "").replace(/^[\s\d.,:–-]+/, "").replace(/[.;,]+$/, "").trim();
}
__name(stripPunct, "stripPunct");
var NEWS_PREFIX = /^([а-яё]+(?:[ —-]+[а-яё]+)?),\s*\d{1,2}\s+[а-яё]+(?:[,.]|\s*[,.]?\s+\d{4})?\.?\s+/i;
function stripNewsPrefix(s) {
  return String(s || "").trim().replace(NEWS_PREFIX, "");
}
__name(stripNewsPrefix, "stripNewsPrefix");
function headlineWorthy(line) {
  const l = stripNewsPrefix(String(line || "").trim());
  return l.length >= 10 && l.length <= 110 && !/^(москва|риа|tass|интерфакс)/i.test(l);
}
__name(headlineWorthy, "headlineWorthy");
function buildHeadline(raw, meta, analysis) {
  const title = stripLink(String(meta.title || "")).trim();
  if (title) return trimEndPunct(truncate(title, 85));
  const lines = String(raw || "").split(/\n+/).map((l) => stripLink(l).trim()).filter(Boolean);
  const firstLine = lines[0] || "";
  if (headlineWorthy(firstLine)) return trimEndPunct(truncate(stripNewsPrefix(firstLine), 85));
  const theme = analysis.topic;
  const lead = analysis.lead;
  if (theme && theme.template) {
    const subject = leadWord(lead) || "\u043C\u043E\u0448\u0435\u043D\u043D\u0438\u043A\u0438";
    const h = theme.template.replace("{subject}", capFirst(subject));
    if (h.length >= 10) return trimEndPunct(truncate(h, 85));
  }
  if (lead) return trimEndPunct(truncate(lead, 85));
  return "\u041A\u0438\u0431\u0435\u0440\u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u044C: \u0433\u043B\u0430\u0432\u043D\u043E\u0435";
}
__name(buildHeadline, "buildHeadline");
function trimEndPunct(s) {
  return String(s || "").replace(/\s*[.,;:]+$/, "").trim();
}
__name(trimEndPunct, "trimEndPunct");
function leadWord(sent) {
  const words = tokens(sent).filter((w) => w.length > 3 && !STOP.has(w));
  return words[0] ? capFirst(words[0]) : "";
}
__name(leadWord, "leadWord");
function truncate(s, max) {
  const t = String(s || "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[.,;:]+$/, "") + "\u2026";
}
__name(truncate, "truncate");
function stripLink(s) {
  return String(s || "").replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
}
__name(stripLink, "stripLink");
function stripInSentence(s) {
  return stripLink(s).replace(/^[\s\d.,:–-]+/, "").replace(/[.;,]+$/, "").trim();
}
__name(stripInSentence, "stripInSentence");
function sanitizeLink(url) {
  return String(url || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
__name(sanitizeLink, "sanitizeLink");
var STOP = /* @__PURE__ */ new Set([
  "\u044D\u0442\u043E",
  "\u0447\u0442\u043E",
  "\u043A\u0430\u043A",
  "\u0434\u043B\u044F",
  "\u043F\u0440\u0438",
  "\u0432\u0441\u0435",
  "\u0435\u0449\u0435",
  "\u0443\u0436\u0435",
  "\u043E\u043D\u0438",
  "\u043D\u0430\u043C",
  "\u0432\u0430\u0441",
  "\u0431\u044B\u043B\u043E",
  "\u0431\u044B\u0442\u044C",
  "\u0431\u0443\u0434\u0435\u0442",
  "\u0441\u0442\u0430\u043B\u043E",
  "\u0435\u0441\u0442\u044C",
  "\u0442\u0430\u043A\u0436\u0435",
  "\u0442\u043E\u043B\u044C\u043A\u043E",
  "\u043C\u043E\u0436\u043D\u043E",
  "\u043D\u0443\u0436\u043D\u043E",
  "\u043A\u043E\u0442\u043E\u0440\u044B\u0435",
  "\u043A\u043E\u0442\u043E\u0440\u044B\u0439",
  "\u043E\u0434\u043D\u0430\u043A\u043E",
  "\u043F\u043E\u044D\u0442\u043E\u043C\u0443",
  "\u043F\u043E\u0442\u043E\u043C\u0443",
  "\u0441\u0435\u0439\u0447\u0430\u0441",
  "\u0441\u0435\u0433\u043E\u0434\u043D\u044F",
  "\u0432\u0435\u0441\u044C"
]);
function estimateTier(text, topic) {
  const t = String(text || "").toLowerCase();
  const danger = /(атаку\w+|взлом\w+|похитил\w+|украл\w+|утрата\w+|кража\w+|мошенничество|реальн\w+\s+угроз\w+)/i;
  if (danger.test(t) || topic && topic.threat >= 2) return "real_threat";
  if (/(совету\w+|предупредил\w+|посоветовал\w+|не\s+верьте|будьте\s+внимательн\w+)/i.test(t)) return "medium";
  if (topic) return "medium";
  return "safe";
}
__name(estimateTier, "estimateTier");
function analyzePost(text, meta = {}) {
  const src = String(meta.text || text || "");
  const lines = src.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const firstLine = lines[0] || "";
  const bodyText = lines.slice(1).join(" ").trim();
  const cleaned = lines.join(" ");
  const sents = splitSentences(bodyText || firstLine || src);
  const topic = mainTopic(cleaned || firstLine);
  const lead = sents.length ? stripLead(sents[0]) : null;
  const facts = rankFacts(sents, topic);
  const stats = extractStats(cleaned);
  const orgs = extractOrgs(cleaned);
  const tier = estimateTier(cleaned, topic);
  const analysis = {
    headline: null,
    // заполнит buildHeadline
    lead,
    facts,
    topic,
    stats,
    orgs,
    tier,
    firstLine,
    bodyText,
    sents
  };
  analysis.headline = buildHeadline(src, meta, analysis);
  return analysis;
}
__name(analyzePost, "analyzePost");
function buildCards(analysis, meta = {}) {
  const cards = [];
  const stat = analysis.stats[0];
  if (stat) {
    cards.push({
      type: "stat",
      number: stat.value,
      label: "\u043A\u043B\u044E\u0447\u0435\u0432\u0430\u044F \u0446\u0438\u0444\u0440\u0430",
      desc: capFirst(stat.context || analysis.headline).slice(0, 160)
    });
  }
  if (analysis.facts.length >= 1) {
    cards.push({
      type: "list",
      label: analysis.topic ? analysis.topic.hint : "\u0421\u0443\u0442\u044C",
      items: analysis.facts
    });
  }
  if (analysis.topic) {
    cards.push({
      type: "list",
      label: "\u041A\u0430\u043A \u0437\u0430\u0449\u0438\u0442\u0438\u0442\u044C\u0441\u044F",
      items: buildAdvice(analysis.topic)
    });
  }
  if (!cards.length) {
    cards.push({
      type: "list",
      label: "\u0421\u0443\u0442\u044C",
      items: analysis.sents.slice(0, 3).map((s) => stripLink(s).slice(0, 150))
    });
  }
  return cards.slice(0, 4);
}
__name(buildCards, "buildCards");
function buildAdvice(topic) {
  const tips = topic ? topic.tips.slice(0, 2) : [];
  tips.push("\u041F\u0440\u0438 \u043C\u0430\u043B\u0435\u0439\u0448\u0435\u043C \u0441\u043E\u043C\u043D\u0435\u043D\u0438\u0438 \u043F\u0435\u0440\u0435\u0437\u0432\u043E\u043D\u0438\u0442\u0435 \u0441\u0430\u043C\u0438 \u2014 \u043E\u0444\u0438\u0446\u0438\u0430\u043B\u044C\u043D\u044B\u0439 \u043D\u043E\u043C\u0435\u0440 \u0441 \u043E\u0431\u0440\u0430\u0442\u043D\u043E\u0439 \u0441\u0442\u043E\u0440\u043E\u043D\u044B \u043A\u0430\u0440\u0442\u044B \u0438\u043B\u0438 \u0441\u0430\u0439\u0442\u0430");
  tips.push("\u0420\u0430\u0441\u0441\u043A\u0430\u0436\u0438\u0442\u0435 \u043E \u0441\u0445\u0435\u043C\u0435 \u0431\u043B\u0438\u0437\u043A\u0438\u043C: \u043C\u043E\u0448\u0435\u043D\u043D\u0438\u043A\u0438 \u0447\u0430\u0441\u0442\u043E \u0434\u0430\u0432\u044F\u0442 \u043D\u0430 \u0434\u043E\u0432\u0435\u0440\u0438\u0435 \u0438 \u0441\u0442\u0440\u0430\u0445");
  return tips.slice(0, 3);
}
__name(buildAdvice, "buildAdvice");

// lib/llm.js
var RUSTORE = "https://www.rustore.ru/catalog/app/com.frauddetector.app";
var SITE = "https://trustnodelab.github.io";
var POST_STYLES = [
  {
    id: "razbor",
    name: "\u0420\u0430\u0437\u0431\u043E\u0440 \u0441\u0445\u0435\u043C\u044B",
    instruction: "\u0424\u043E\u0440\u043C\u0430\u0442 \u043F\u043E\u0441\u0442\u0430 \u2014 \xAB\u0420\u0430\u0437\u0431\u043E\u0440 \u0441\u0445\u0435\u043C\u044B\xBB: \u0441\u043D\u0430\u0447\u0430\u043B\u0430 \u043A\u043E\u0440\u043E\u0442\u043A\u043E \u043E \u0447\u0451\u043C \u043D\u043E\u0432\u043E\u0441\u0442\u044C, \u0437\u0430\u0442\u0435\u043C \u043F\u043E \u0448\u0430\u0433\u0430\u043C \u2014 \u043A\u0430\u043A \u0438\u043C\u0435\u043D\u043D\u043E \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442 \u0441\u0445\u0435\u043C\u0430 \u043E\u0431\u043C\u0430\u043D\u0430 (\u0447\u0442\u043E \u0433\u043E\u0432\u043E\u0440\u0438\u0442 \u043C\u043E\u0448\u0435\u043D\u043D\u0438\u043A, \u043A\u0430\u043A \u0434\u0430\u0432\u0438\u0442 \u043D\u0430 \u0441\u0442\u0440\u0430\u0445\u0438, \u0433\u0434\u0435 \u0442\u043E\u0447\u043A\u0430 \u043E\u0442\u043A\u0430\u0437\u0430), \u0438 \u0432 \u043A\u043E\u043D\u0446\u0435 \u2014 \u043A\u043E\u043D\u043A\u0440\u0435\u0442\u043D\u0430\u044F \u0437\u0430\u0449\u0438\u0442\u0430. \u041F\u0438\u0448\u0438 \u043A\u0430\u043A \u0430\u043D\u0430\u043B\u0438\u0442\u0438\u043A \u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u0438, \u043E\u0431\u044A\u044F\u0441\u043D\u044F\u044E\u0449\u0438\u0439 \u043C\u0435\u0445\u0430\u043D\u0438\u043A\u0443, \u0430 \u043D\u0435 \u043A\u0430\u043A \u043D\u043E\u0432\u043E\u0441\u0442\u043D\u0430\u044F \u043B\u0435\u043D\u0442\u0430."
  },
  {
    id: "warning",
    name: "\u041F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u0435",
    instruction: "\u0424\u043E\u0440\u043C\u0430\u0442 \u043F\u043E\u0441\u0442\u0430 \u2014 \xAB\u041F\u0440\u0435\u0434\u0443\u043F\u0440\u0435\u0436\u0434\u0435\u043D\u0438\u0435\xBB: \u043F\u043E\u0441\u0442\u0430\u0432\u044C \u0447\u0438\u0442\u0430\u0442\u0435\u043B\u044F \u0432 \u0441\u0438\u0442\u0443\u0430\u0446\u0438\u044E (\xAB\u0432\u044B \u043C\u043E\u0436\u0435\u0442\u0435 \u0441\u0442\u043E\u043B\u043A\u043D\u0443\u0442\u044C\u0441\u044F \u0441 \u044D\u0442\u0438\u043C \u0441\u0435\u0433\u043E\u0434\u043D\u044F\xBB), \u043E\u0431\u044A\u044F\u0441\u043D\u0438 \u0440\u0438\u0441\u043A \u0447\u0435\u043B\u043E\u0432\u0435\u0447\u0435\u0441\u043A\u0438\u043C \u044F\u0437\u044B\u043A\u043E\u043C, \u0434\u0430\u0439 2\u20143 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u044F, \u043A\u043E\u0442\u043E\u0440\u044B\u0435 \u043F\u0440\u044F\u043C\u043E \u0441\u0435\u0439\u0447\u0430\u0441 \u0441\u043D\u0438\u0436\u0430\u044E\u0442 \u0443\u0433\u0440\u043E\u0437\u0443. \u0422\u043E\u043D \u2014 \u0437\u0430\u0431\u043E\u0442\u043B\u0438\u0432\u044B\u0439, \u0431\u0435\u0437 \u043F\u0430\u043D\u0438\u043A\u0438 \u0438 \u043A\u043B\u0438\u043A\u0431\u0435\u0439\u0442\u0430."
  },
  {
    id: "fact",
    name: "\u0424\u0430\u043A\u0442-\u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0430",
    instruction: "\u0424\u043E\u0440\u043C\u0430\u0442 \u043F\u043E\u0441\u0442\u0430 \u2014 \xAB\u0424\u0430\u043A\u0442-\u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0430\xBB: \u0441\u0443\u0445\u043E \u0438 \u043F\u043E \u0434\u0435\u043B\u0443. \u0421\u043E\u0431\u0435\u0440\u0438 \u0433\u043B\u0430\u0432\u043D\u044B\u0435 \u0444\u0430\u043A\u0442\u044B \u043D\u043E\u0432\u043E\u0441\u0442\u0438 \u043A\u043E\u0440\u043E\u0442\u043A\u0438\u043C\u0438 \u0430\u0431\u0437\u0430\u0446\u0430\u043C\u0438, \u0446\u0438\u0444\u0440\u044B \u2014 \u0442\u043E\u0447\u043D\u043E \u0438\u0437 \u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A\u0430, \u0432\u044B\u0432\u043E\u0434 \u2014 \u043E\u0434\u043D\u0438\u043C \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u0435\u043C. \u0411\u0435\u0437 \u043B\u0438\u0448\u043D\u0438\u0445 \u0441\u043B\u043E\u0432 \u0438 \u043E\u0431\u0449\u0438\u0445 \u0441\u043E\u0432\u0435\u0442\u043E\u0432; \u0441\u0442\u0438\u043B\u044C \u2014 \u0438\u043D\u0444\u043E\u0440\u043C\u0430\u0446\u0438\u043E\u043D\u043D\u044B\u0439."
  },
  {
    id: "myth",
    name: "\u0420\u0430\u0437\u0431\u043E\u0440 \u0437\u0430\u0431\u043B\u0443\u0436\u0434\u0435\u043D\u0438\u044F",
    instruction: "\u0424\u043E\u0440\u043C\u0430\u0442 \u043F\u043E\u0441\u0442\u0430 \u2014 \xAB\u0420\u0430\u0437\u0431\u043E\u0440 \u0437\u0430\u0431\u043B\u0443\u0436\u0434\u0435\u043D\u0438\u044F\xBB: \u043D\u0430\u0439\u0434\u0438 \u0440\u0430\u0441\u043F\u0440\u043E\u0441\u0442\u0440\u0430\u043D\u0451\u043D\u043D\u044B\u0439 \u043C\u0438\u0444 \u0438\u043B\u0438 \u043D\u0430\u0438\u0432\u043D\u0443\u044E \u043E\u0448\u0438\u0431\u043A\u0443, \u0441\u0432\u044F\u0437\u0430\u043D\u043D\u0443\u044E \u0441 \u043D\u043E\u0432\u043E\u0441\u0442\u044C\u044E (\xAB\u044F \u0434\u0443\u043C\u0430\u043B, \u043C\u0435\u043D\u044F \u044D\u0442\u043E \u043D\u0435 \u043A\u0430\u0441\u0430\u0435\u0442\u0441\u044F\xBB), \u0440\u0430\u0437\u0431\u0435\u0440\u0438, \u043F\u043E\u0447\u0435\u043C\u0443 \u043E\u043D\u0430 \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442 \u043D\u0430 \u043B\u044E\u0434\u044F\u0445, \u0438 \u043F\u043E\u043A\u0430\u0436\u0438, \u043A\u0430\u043A \u043F\u0440\u0430\u0432\u0438\u043B\u044C\u043D\u043E \u043F\u043E\u0441\u0442\u0443\u043F\u0430\u0442\u044C. \u041F\u0438\u0448\u0438 \u0441\u043F\u043E\u043A\u043E\u0439\u043D\u043E, \u0441 \u043F\u0440\u0438\u043C\u0435\u0440\u0430\u043C\u0438 \xAB\u0445\u043E\u0440\u043E\u0448\u043E/\u043F\u043B\u043E\u0445\u043E\xBB."
  },
  {
    id: "case",
    name: "\u041A\u0435\u0439\u0441-\u0438\u0441\u0442\u043E\u0440\u0438\u044F",
    instruction: "\u0424\u043E\u0440\u043C\u0430\u0442 \u043F\u043E\u0441\u0442\u0430 \u2014 \xAB\u041A\u0435\u0439\u0441-\u0438\u0441\u0442\u043E\u0440\u0438\u044F\xBB: \u043F\u0435\u0440\u0435\u0441\u043A\u0430\u0436\u0438 \u0441\u0438\u0442\u0443\u0430\u0446\u0438\u044E \u0438\u0437 \u043D\u043E\u0432\u043E\u0441\u0442\u0438 \u043A\u0430\u043A \u0438\u0441\u0442\u043E\u0440\u0438\u044E \u043A\u043E\u043D\u043A\u0440\u0435\u0442\u043D\u043E\u0433\u043E \u0447\u0435\u043B\u043E\u0432\u0435\u043A\u0430 ( \u043A\u0442\u043E, \u0433\u0434\u0435, \u0447\u0442\u043E \u0441\u043B\u0443\u0447\u0438\u043B\u043E\u0441\u044C, \u0447\u0442\u043E \u043F\u043E\u0442\u0435\u0440\u044F\u043B ), \u0432\u044B\u0434\u0435\u043B\u0438 \u043C\u043E\u043C\u0435\u043D\u0442, \u0433\u0434\u0435 \u0435\u0433\u043E \u043C\u043E\u0436\u043D\u043E \u0431\u044B\u043B\u043E \u043E\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C, \u0438 \u0441\u0434\u0435\u043B\u0430\u0439 \u0432\u044B\u0432\u043E\u0434-\u0441\u043E\u0432\u0435\u0442. \u0420\u0430\u0441\u0441\u043A\u0430\u0437\u044B\u0432\u0430\u0439 \u0436\u0438\u0432\u043E \u0438 \u043F\u043E-\u0447\u0435\u043B\u043E\u0432\u0435\u0447\u0435\u0441\u043A\u0438, \u0431\u0435\u0437 \u043A\u0430\u043D\u0446\u0435\u043B\u044F\u0440\u0438\u0442\u0430."
  }
];
function pickPostStyle(meta = {}) {
  const seed = String(meta.guid || meta.link || meta.title || meta.text || "").trim();
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = h * 31 + seed.charCodeAt(i) >>> 0;
  return POST_STYLES[h % POST_STYLES.length];
}
__name(pickPostStyle, "pickPostStyle");
var FOOTER_HTML = `\u{1F6E1}\uFE0F <b>TrustNode</b>
\u{1F4F1} \u041F\u0440\u0438\u043B\u043E\u0436\u0435\u043D\u0438\u0435: <a href="${RUSTORE}">RuStore</a>
\u{1F310} \u0421\u0430\u0439\u0442: <a href="${SITE}">trustnodelab.github.io</a>`;
function sanitizeHtml(text) {
  return String(text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
__name(sanitizeHtml, "sanitizeHtml");
function truncateAt(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[.,;:]+$/, "") + "\u2026";
}
__name(truncateAt, "truncateAt");
function stripLink2(s) {
  return s.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
}
__name(stripLink2, "stripLink");
function generateByRules(text, meta = {}) {
  const src = String(meta.text || text || "");
  const analysis = analyzePost(src, meta);
  const cards = buildCards(analysis, meta);
  const headline = analysis.headline;
  const norm = /* @__PURE__ */ __name((s) => String(s || "").toLowerCase().replace(/[.,!?…]+$/g, "").trim(), "norm");
  const lead = analysis.lead && norm(analysis.lead) !== norm(headline) ? analysis.lead : null;
  const scheme = analysis.topic;
  const style = pickPostStyle(meta);
  const HOOKS = {
    razbor: ["\u0420\u0430\u0437\u0431\u0438\u0440\u0430\u0435\u043C, \u043A\u0430\u043A \u0440\u0430\u0431\u043E\u0442\u0430\u0435\u0442 \u0441\u0445\u0435\u043C\u0430 \u2014 \u043F\u043E \u0448\u0430\u0433\u0430\u043C."],
    warning: ["\u0421 \u044D\u0442\u0438\u043C \u043C\u043E\u0436\u043D\u043E \u0441\u0442\u043E\u043B\u043A\u043D\u0443\u0442\u044C\u0441\u044F \u0443\u0436\u0435 \u0441\u0435\u0433\u043E\u0434\u043D\u044F."],
    fact: ["\u041A\u043E\u0440\u043E\u0442\u043A\u043E \u043E \u0433\u043B\u0430\u0432\u043D\u043E\u043C."],
    myth: ["\u0427\u0442\u043E \u043D\u0430 \u0441\u0430\u043C\u043E\u043C \u0434\u0435\u043B\u0435 \u043F\u0440\u043E\u0438\u0441\u0445\u043E\u0434\u0438\u0442 \u2014 \u0438 \u0433\u0434\u0435 \u043F\u043E\u0434\u0432\u043E\u0445."],
    case: ["\u0421\u043B\u0443\u0447\u0430\u0439 \u0438\u0437 \u043D\u043E\u0432\u043E\u0441\u0442\u0438 \u2014 \u043A\u0430\u043A \u044D\u0442\u043E \u0432\u044B\u0433\u043B\u044F\u0434\u0435\u043B\u043E \u043D\u0430 \u0434\u0435\u043B\u0435."]
  };
  const hook = (HOOKS[style.id] || []).find(Boolean);
  const captionLines = [];
  if (hook) captionLines.push(`${sanitizeHtml(hook)}
`);
  captionLines.push(`<b>${sanitizeHtml(headline)}</b>`);
  if (lead) captionLines.push(`
${sanitizeHtml(lead)}`);
  if (analysis.facts.length) {
    captionLines.push("");
    captionLines.push("\u{1F50D} " + (scheme ? scheme.hint : "\u0421\u0443\u0442\u044C"));
    for (const f of analysis.facts) captionLines.push("\u2022 " + sanitizeHtml(f));
  }
  if (scheme) {
    captionLines.push("");
    captionLines.push("\u{1F6E1}\uFE0F \u0427\u0442\u043E \u0434\u0435\u043B\u0430\u0442\u044C");
    for (const t of buildAdvice(scheme)) captionLines.push("\u2022 " + sanitizeHtml(t));
  }
  if (meta.link) captionLines.push("", `\u0418\u0441\u0442\u043E\u0447\u043D\u0438\u043A: <a href="${sanitizeLink(meta.link)}">\u0441\u0441\u044B\u043B\u043A\u0430</a>`);
  captionLines.push("", FOOTER_HTML);
  const caption = captionLines.join("\n");
  return {
    headline,
    headline_lines: [headline],
    caption,
    cards,
    tier: analysis.tier,
    source: meta.source || ""
  };
}
__name(generateByRules, "generateByRules");
var DIGEST_EMOJI = { morning: "\u{1F305}", day: "\u2600\uFE0F", evening: "\u{1F306}" };
function itemFreshMs(c) {
  for (const f of ["pub_ts", "found_at", "created_at"]) {
    const v = c[f];
    if (v === null || v === void 0 || v === "") continue;
    const t = typeof v === "number" ? v : Date.parse(String(v));
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}
__name(itemFreshMs, "itemFreshMs");
function domainOf(link) {
  try {
    return String(new URL(link).hostname).replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}
__name(domainOf, "domainOf");
function humanDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}` : iso || "";
}
__name(humanDate, "humanDate");
function digestByRules(items, meta = {}) {
  const label = String(meta.label || "");
  const head = `\u0414\u0430\u0439\u0434\u0436\u0435\u0441\u0442 TrustNode \xB7 ${label}` + (meta.date ? ` \u2014 ${humanDate(meta.date)}` : "");
  const bulletTexts = [];
  const advice = [];
  const seenTips = /* @__PURE__ */ new Set();
  for (const it of items) {
    let a = null;
    try {
      a = analyzePost(it.text || it.title || "", { title: it.title || "" });
    } catch (e) {
    }
    const title = a && a.headline || String(it.title || "").replace(/\s+/g, " ").trim().slice(0, 90) || "\u041D\u043E\u0432\u043E\u0441\u0442\u044C";
    const fact = a && a.facts && a.facts[0] ? a.facts[0].slice(0, 140) : null;
    let text = sanitizeHtml(title);
    if (fact) text += ` \u2014 ${sanitizeHtml(fact)}`;
    bulletTexts.push({ text, link: it.link || "" });
    if (a && a.topic) {
      for (const t of buildAdvice(a.topic)) {
        if (advice.length >= 3) break;
        const key = String(t).toLowerCase();
        if (seenTips.has(key)) continue;
        seenTips.add(key);
        advice.push(sanitizeHtml(t));
      }
    }
  }
  return { headline: head, bulletTexts, advice };
}
__name(digestByRules, "digestByRules");
async function callLlmDigest(env, items) {
  const base = String(env.LLM_API_BASE || "").replace(/\/+$/, "");
  const model = env.LLM_MODEL || "gemini-flash-lite-latest";
  const list = items.map(
    (it, i) => `${i + 1}. ${String(it.title || "").replace(/\s+/g, " ").trim().slice(0, 200)}
${String(it.text || "").replace(/\s+/g, " ").trim().slice(0, 800)}
\u0421\u0441\u044B\u043B\u043A\u0430: ${it.link || ""}`
  ).join("\n\n");
  const prompt = '\u0422\u044B \u2014 \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440 \u043A\u0430\u043D\u0430\u043B\u0430 TrustNode \u043E \u043A\u0438\u0431\u0435\u0440\u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u0438. \u041F\u043E \u0441\u043F\u0438\u0441\u043A\u0443 \u043D\u043E\u0432\u043E\u0441\u0442\u0435\u0439 \u0441\u043E\u0431\u0435\u0440\u0438 \u0434\u0430\u0439\u0434\u0436\u0435\u0441\u0442:\n\u0432\u0435\u0440\u043D\u0438 \u0422\u041E\u041B\u042C\u041A\u041E \u0432\u0430\u043B\u0438\u0434\u043D\u044B\u0439 JSON \u0431\u0435\u0437 \u043F\u043E\u044F\u0441\u043D\u0435\u043D\u0438\u0439:\n{"headline":"\u043A\u043E\u0440\u043E\u0442\u043A\u0438\u0439 \u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A \u0432\u044B\u043F\u0443\u0441\u043A\u0430 (1 \u0444\u0440\u0430\u0437\u0430)", "bullets":["\u043F\u043E \u043A\u0430\u0436\u0434\u043E\u0439 \u043D\u043E\u0432\u043E\u0441\u0442\u0438 1-2 \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0435\u043D\u0438\u044F: \u0447\u0442\u043E \u043F\u0440\u043E\u0438\u0437\u043E\u0448\u043B\u043E \u0438 \u043F\u043E\u0447\u0435\u043C\u0443 \u044D\u0442\u043E \u043A\u0430\u0441\u0430\u0435\u0442\u0441\u044F \u0447\u0438\u0442\u0430\u0442\u0435\u043B\u044F"], "advice":["2-3 \u0441\u043E\u0432\u0435\u0442\u0430, \u043A\u0430\u043A \u0437\u0430\u0449\u0438\u0442\u0438\u0442\u044C\u0441\u044F"]}.\n\u041F\u0438\u0448\u0438 \u0436\u0438\u0432\u044B\u043C \u044F\u0437\u044B\u043A\u043E\u043C \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440\u0430, \u0431\u0435\u0437 \u043A\u0430\u043D\u0446\u0435\u043B\u044F\u0440\u0438\u0442\u0430; \u0441\u0443\u043C\u043C\u044B \u2014 \u0442\u043E\u0447\u043D\u043E \u0438\u0437 \u0442\u0435\u043A\u0441\u0442\u0430 \u043D\u043E\u0432\u043E\u0441\u0442\u0435\u0439.\n\n' + list;
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LLM_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "\u0422\u044B \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440 \u0442\u0435\u043B\u0435\u0433\u0440\u0430\u043C-\u043A\u0430\u043D\u0430\u043B\u0430 \u043E \u043A\u0438\u0431\u0435\u0440\u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u0438. \u041E\u0442\u0432\u0435\u0447\u0430\u0439 \u0442\u043E\u043B\u044C\u043A\u043E JSON." },
        { role: "user", content: prompt }
      ],
      temperature: 0.75
    }),
    signal: AbortSignal.timeout(9e4)
  });
  if (!res.ok) throw new Error(`LLM digest ${res.status}`);
  const m = String(await res.text()).match(/\{[\s\S]*\}/);
  if (!m) throw new Error("LLM digest: \u043D\u0435 JSON");
  const data = JSON.parse(m[0]);
  const bullets = Array.isArray(data.bullets) ? data.bullets.map((b) => String(b).trim()).filter(Boolean).slice(0, items.length) : [];
  const advice = Array.isArray(data.advice) ? data.advice.map((a) => String(a).trim()).filter(Boolean).slice(0, 3) : [];
  if (!bullets.length) throw new Error("LLM digest: \u043F\u0443\u0441\u0442\u044B\u0435 bullets");
  return { headline: String(data.headline || "").trim() || void 0, bullets, advice };
}
__name(callLlmDigest, "callLlmDigest");
async function generateDigestText(items, env = {}, meta = {}) {
  const fallback = digestByRules(items, meta);
  let headline = fallback.headline;
  let bulletTexts = fallback.bulletTexts;
  let advice = fallback.advice;
  if (env.LLM_API_BASE && env.LLM_API_KEY) {
    try {
      const llm = await callLlmDigest(env, items);
      if (llm.headline) headline = llm.headline;
      if (llm.bullets.length) {
        bulletTexts = llm.bullets.map((t, i) => ({
          text: markdownToHtml(t),
          link: items[i] && items[i].link
        }));
      }
      if (llm.advice.length) advice = llm.advice.map((t) => markdownToHtml(t));
    } catch (e) {
      console.log("[llm] LLM-\u0434\u0430\u0439\u0434\u0436\u0435\u0441\u0442 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D, \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u044E \u043F\u0440\u0430\u0432\u0438\u043B\u0430:", e.message);
    }
  }
  const emoji = DIGEST_EMOJI[meta.slug] || "\u{1F4F0}";
  const parts = [`${emoji} <b>${sanitizeHtml(headline)}</b>`];
  for (let i = 0; i < bulletTexts.length; i++) {
    let txt = `\u2022 <b>${i + 1}.</b> ${bulletTexts[i].text}`;
    if (bulletTexts[i].link) {
      txt += `
<a href="${sanitizeLink(bulletTexts[i].link)}">\u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A \u2192</a>`;
    }
    parts.push(txt);
  }
  if (advice.length) {
    parts.push("\u{1F6E1}\uFE0F <b>\u0427\u0442\u043E \u0434\u0435\u043B\u0430\u0442\u044C</b>");
    for (const t of advice) parts.push("\u2022 " + t);
  }
  parts.push(FOOTER_HTML);
  const caption = fitCaption(parts.join("\n\n"), 1024);
  return {
    headline,
    headline_lines: [headline],
    caption,
    items: items.map((it, i) => ({
      guid: it.guid || "",
      title: String(it.title || "").replace(/\s+/g, " ").trim().slice(0, 120),
      link: it.link || "",
      source: domainOf(it.link || "") || it.source || ""
    }))
  };
}
__name(generateDigestText, "generateDigestText");
function digestFreshScore(c) {
  return itemFreshMs(c);
}
__name(digestFreshScore, "digestFreshScore");
async function callProxyLlm(env, text, prevPost = null, provider = "gigachat", style = null) {
  const base = (env.LLM_PROXY_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("LLM_PROXY_URL \u043D\u0435 \u0437\u0430\u0434\u0430\u043D");
  const res = await fetch(`${base}/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, prev_post: prevPost, provider, style: style ? style.id : "" }),
    signal: AbortSignal.timeout(115e3)
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`LLM proxy ${res.status}: ${raw.slice(0, 160)}`);
  const data = JSON.parse(raw);
  if (data && data.error) throw new Error(`LLM \u0432\u0435\u0440\u043D\u0443\u043B error: ${data.error}`);
  return data;
}
__name(callProxyLlm, "callProxyLlm");
function normalizeProxyData(data, text) {
  const rawHeadline = Array.isArray(data.headline) ? data.headline : [data.headline];
  const headlineLines = rawHeadline.map((h) => stripMarkdown(h)).filter(Boolean).slice(0, 2);
  const headline = headlineLines.join(" ") || truncateAt(stripLink2(String(text || "").replace(/\s+/g, " ")), 90) || "\u041A\u0438\u0431\u0435\u0440\u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u044C: \u0433\u043B\u0430\u0432\u043D\u043E\u0435";
  let caption = markdownToHtml(String(data.caption || "")).trim();
  if (caption) caption += "\n\n" + FOOTER_HTML;
  caption = fitCaption(caption, 1024);
  const cards = Array.isArray(data.cards) ? data.cards.filter((c) => c && typeof c === "object").slice(0, 4).map((c) => ({
    type: ["stat", "list", "compare"].includes(c.type) ? c.type : "stat",
    number: String(c.number || "").slice(0, 12),
    label: stripMarkdown(c.label).slice(0, 80),
    desc: markdownToHtml(String(c.desc || "")).slice(0, 160),
    before: markdownToHtml(String(c.before || "")).slice(0, 160),
    after: markdownToHtml(String(c.after || "")).slice(0, 160),
    items: Array.isArray(c.items) ? c.items.map((i) => stripMarkdown(i).slice(0, 140)).slice(0, 4) : []
  })) : [];
  const tier = ["news", "real_threat", "medium", "safe"].includes(data.tier) ? data.tier : "news";
  return { headline, headline_lines: headlineLines, caption, cards, tier, source: "" };
}
__name(normalizeProxyData, "normalizeProxyData");
var LLM_SYSTEM = '\u0422\u044B \u2014 \u0440\u0435\u0434\u0430\u043A\u0442\u043E\u0440 \u043A\u0430\u043D\u0430\u043B\u0430 TrustNode \u043E \u043A\u0438\u0431\u0435\u0440\u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u0438. \u041F\u043E \u0442\u0435\u043A\u0441\u0442\u0443 \u043D\u043E\u0432\u043E\u0441\u0442\u0438 \u0432\u0435\u0440\u043D\u0438 \u0422\u041E\u041B\u042C\u041A\u041E \u0432\u0430\u043B\u0438\u0434\u043D\u044B\u0439 JSON \u0431\u0435\u0437 \u043F\u043E\u044F\u0441\u043D\u0435\u043D\u0438\u0439, \u0441 \u043F\u043E\u043B\u044F\u043C\u0438: "headline" (\u0437\u0430\u0433\u043E\u043B\u043E\u0432\u043E\u043A, 1 \u0444\u0440\u0430\u0437\u0430), "caption" (\u0442\u0435\u043A\u0441\u0442 \u043F\u043E\u0441\u0442\u0430 500-800 \u0441\u0438\u043C\u0432\u043E\u043B\u043E\u0432 \u043D\u0430 \u0440\u0443\u0441\u0441\u043A\u043E\u043C, \u043C\u043E\u0436\u0435\u0442 \u0441\u043E\u0434\u0435\u0440\u0436\u0430\u0442\u044C \u0442\u0435\u0433\u0438 <b> \u0438 <a href>), "cards" (\u043C\u0430\u0441\u0441\u0438\u0432: {"type":"stat","number":"...","label":"..."} \u0434\u043B\u044F \u0446\u0438\u0444\u0440 \u0438\u043B\u0438 {"type":"list","label":"...","items":["..."]} \u0434\u043B\u044F \u0442\u0435\u0437\u0438\u0441\u043E\u0432, 1-3 \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0438), "tier" (news|real_threat|medium|safe). \u041D\u0435 \u0432\u044B\u0434\u0443\u043C\u044B\u0432\u0430\u0439 \u0446\u0438\u0444\u0440\u044B \u0441\u0432\u0435\u0440\u0445 \u0442\u0435\u043A\u0441\u0442\u0430.';
async function callLlm(env, text, style = null) {
  const base = (env.LLM_API_BASE || "").replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const model = env.LLM_MODEL || "gemini-flash-lite-latest";
  const system = style ? `${LLM_SYSTEM}

${style.instruction}` : LLM_SYSTEM;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LLM_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: String(text).slice(0, 6e3) }
      ],
      temperature: 0.75
    })
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("LLM \u0432\u0435\u0440\u043D\u0443\u043B \u043D\u0435 JSON");
  return JSON.parse(m[0]);
}
__name(callLlm, "callLlm");
function validateLlm(data, text) {
  const headline = stripMarkdown(String(data.headline || "")).slice(0, 120) || "\u041A\u0438\u0431\u0435\u0440\u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u044C: \u0433\u043B\u0430\u0432\u043D\u043E\u0435";
  let caption = markdownToHtml(String(data.caption || "")).trim();
  if (!caption) {
    const body = [data.headline, ...(data.cards || []).map((c) => c.label || "").filter(Boolean)];
    caption = markdownToHtml(body.join("\n\n")).trim();
  }
  if (caption) caption += "\n\n" + FOOTER_HTML;
  caption = fitCaption(caption, 1024);
  const cards = Array.isArray(data.cards) ? data.cards.filter((c) => c && typeof c === "object").slice(0, 4).map((c) => ({
    type: ["stat", "list", "compare"].includes(c.type) ? c.type : "stat",
    number: String(c.number || "").slice(0, 12),
    label: stripMarkdown(c.label).slice(0, 80),
    desc: markdownToHtml(String(c.desc || "")).slice(0, 160),
    items: Array.isArray(c.items) ? c.items.map((i) => stripMarkdown(i).slice(0, 140)).slice(0, 4) : []
  })) : [];
  const tier = ["news", "real_threat", "medium", "safe"].includes(data.tier) ? data.tier : "news";
  return { headline, caption, cards, tier, source: "" };
}
__name(validateLlm, "validateLlm");
function mergeDualPost(a, b) {
  const score = /* @__PURE__ */ __name((d) => (d.caption ? d.caption.length : 0) + (d.cards || []).length * 60, "score");
  const primary = score(a) >= score(b) ? a : b;
  const secondary = primary === a ? b : a;
  const seen = /* @__PURE__ */ new Set();
  const cards = [];
  for (const c of [...primary.cards, ...secondary.cards]) {
    const key = `${c.type}|${c.number}|${c.label}|${(c.items || []).join("/")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cards.push(c);
    if (cards.length >= 4) break;
  }
  const headlineLines = [...primary.headline_lines];
  for (const h of secondary.headline_lines) {
    if (headlineLines.length >= 2) break;
    if (!headlineLines.includes(h)) headlineLines.push(h);
  }
  return {
    headline: headlineLines.join(" ") || primary.headline,
    headline_lines: headlineLines,
    caption: primary.caption,
    cards: cards.length ? cards : primary.cards,
    tier: primary.tier,
    source: primary.source || secondary.source
  };
}
__name(mergeDualPost, "mergeDualPost");
function providerPlan(env, msk) {
  const hasProxy = !!(env.LLM_PROXY_URL || "").trim();
  if (!hasProxy) return { joint: false, order: [] };
  const h = msk.hour;
  if (h >= 6 && h < 12) return { joint: false, order: ["gigachat", "gemini"] };
  if (h >= 12 && h < 17) return { joint: true, order: ["gigachat", "gemini"] };
  if (h >= 17 && h < 22) return { joint: false, order: ["gemini", "gigachat"] };
  return { joint: false, order: ["gigachat", "gemini"] };
}
__name(providerPlan, "providerPlan");
async function generateWithProviders(env, text, meta, order, joint) {
  const src = meta.text || text;
  const prev = meta.prev_post || null;
  const style = pickPostStyle(meta);
  const errors = [];
  if (joint) {
    const attempts = await Promise.allSettled(
      order.map((p) => callProxyLlm(env, src, prev, p, style).then((d) => normalizeProxyData(d, src)))
    );
    const ok = attempts.filter((a) => a.status === "fulfilled").map((a) => a.value);
    if (ok.length >= 2) return mergeDualPost(ok[0], ok[1]);
    if (ok.length === 1) return ok[0];
    for (const a of attempts) errors.push(a.reason?.message || "unknown");
    throw new Error(errors.join(" | "));
  }
  let lastErr = null;
  for (const p of order) {
    try {
      const data = await callProxyLlm(env, src, prev, p, style);
      return normalizeProxyData(data, src);
    } catch (e) {
      lastErr = e;
      errors.push(`${p}: ${e.message}`);
    }
  }
  throw new Error(errors.join(" | ") || lastErr && lastErr.message);
}
__name(generateWithProviders, "generateWithProviders");
async function generatePostData(text, env, meta = {}) {
  const forced = meta.provider || "";
  if (forced === "rules") {
    return generateByRules(text, meta);
  }
  const plan = providerPlan(env, mskNow());
  let order = plan.order;
  let joint = plan.joint;
  if (forced === "gemini" || forced === "gigachat") {
    order = [forced];
    joint = false;
  }
  if (order.length) {
    try {
      const data = await generateWithProviders(env, meta.text || text, meta, order, joint);
      return { ...data, llm_provider: joint ? "gigachat+gemini" : order[0] };
    } catch (e) {
      console.log("[llm] LLM-\u043F\u0440\u043E\u043A\u0441\u0438 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D, \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u044E \u043F\u0440\u0430\u0432\u0438\u043B\u0430:", e.message);
    }
  }
  if (!forced && env.LLM_API_KEY && env.LLM_API_BASE) {
    try {
      const data = await callLlm(env, meta.text || text, pickPostStyle(meta));
      return { ...validateLlm(data, text), llm_provider: "gemini-direct" };
    } catch (e) {
      console.log("[llm] LLM \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D, \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u044E \u043F\u0440\u0430\u0432\u0438\u043B\u0430:", e.message);
    }
  }
  return generateByRules(text, meta);
}
__name(generatePostData, "generatePostData");

// lib/preview.js
init_cardgen();
init_telegram();
function approveButtons(id) {
  return [
    [
      { text: "\u{1F310} \u041E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C \u0432\u0435\u0437\u0434\u0435", callback_data: `approve:${id}:all` },
      { text: "\u{1F535} \u0412 VK", callback_data: `approve:${id}:vk` },
      { text: "\u{1F7E2} \u0412 TG", callback_data: `approve:${id}:tg` }
    ],
    [
      { text: "\u{1F504} \u041F\u0435\u0440\u0435\u0434\u0435\u043B\u0430\u0442\u044C", callback_data: `redo:${id}` },
      { text: "\u274C \u041E\u0442\u043C\u0435\u043D\u0438\u0442\u044C", callback_data: `cancel:${id}` }
    ]
  ];
}
__name(approveButtons, "approveButtons");
function bytesToBase64(bytes) {
  let bin = "";
  const step = 32768;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}
__name(bytesToBase64, "bytesToBase64");
function sourceDomain(link) {
  try {
    return String(new URL(link).hostname).replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}
__name(sourceDomain, "sourceDomain");
async function renderCardBytes(env, data, meta = {}) {
  let format;
  if (meta.format === "gif" || meta.format === "png") {
    format = meta.format;
  } else {
    try {
      format = await getCardFormat(env);
    } catch (e) {
      format = "auto";
    }
  }
  const wantGif = format !== "png";
  const urls = [];
  if (env.CARD_RENDER_URLS) {
    for (const u of Array.isArray(env.CARD_RENDER_URLS) ? env.CARD_RENDER_URLS : String(env.CARD_RENDER_URLS).split(",")) {
      if (u && String(u).trim()) urls.push(String(u).trim());
    }
  }
  if (env.CARD_RENDER_URL) urls.push(String(env.CARD_RENDER_URL).trim());
  for (const base of urls) {
    try {
      const res = await fetch(`${base.replace(/\/+$/, "")}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          headline: data.headline_lines && data.headline_lines.length ? data.headline_lines : data.headline,
          caption: data.caption,
          cards: data.cards || [],
          tier: data.tier || "news",
          source: data.source || meta.source || sourceDomain(meta.link || ""),
          link: meta.link || "",
          format: wantGif ? "gif" : "png",
          frames: meta.frames || 12
        }),
        signal: AbortSignal.timeout(9e4)
      });
      if (res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > 100) return bytes;
      }
    } catch (e) {
      console.log(`[preview] render-service ${base} \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D, \u043F\u0440\u043E\u0431\u0443\u044E \u0441\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439:`, e.message);
    }
  }
  console.log("[preview] \u0432\u0441\u0435 \u0440\u0435\u043D\u0434\u0435\u0440-\u0441\u0435\u0440\u0432\u0438\u0441\u044B \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u044B, JS-\u0444\u043E\u043B\u0431\u044D\u043A");
  return renderCard(data, {
    format: wantGif ? "gif" : "png",
    frames: meta.frames || 12
  });
}
__name(renderCardBytes, "renderCardBytes");
async function buildCardPackage(env, text, meta = {}) {
  const data = await generatePostData(text, env, { ...meta, text });
  const png = await renderCardBytes(env, data, meta);
  const b64 = bytesToBase64(png);
  return { data, png, b64 };
}
__name(buildCardPackage, "buildCardPackage");
async function sendGeneratedPreview(env, chatId, text, meta = {}) {
  const { data, png, b64 } = await buildCardPackage(env, text, meta);
  const id = `m${Date.now().toString(36)}${Math.floor(Math.random() * 1e3)}`;
  const sent = await sendCard(env, chatId, png, data.caption, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: approveButtons(id) }
  });
  const draft = {
    id,
    kind: "generated",
    status: "pending",
    title: data.headline,
    caption: data.caption,
    png: b64,
    link: meta.link || "",
    source: meta.source || sourceDomain(meta.link || ""),
    guid: meta.guid || "",
    raw_text: text,
    cards: data.cards || [],
    tier: data.tier || "news",
    admin_chat_id: chatId,
    preview_message_id: sent && sent.message_id,
    created_at: (/* @__PURE__ */ new Date()).toISOString()
  };
  if (meta.provider) draft.provider = meta.provider;
  await saveDraft(env, draft);
  return data;
}
__name(sendGeneratedPreview, "sendGeneratedPreview");

// lib/scheduler.js
init_telegram();
init_text();
var CHUNK_COUNT = 2;
var TICK_LOCK_TTL_MS = 10 * 60 * 1e3;
function decodePng(b64) {
  if (!b64) return null;
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
__name(decodePng, "decodePng");
function bytesToBase642(bytes) {
  let bin = "";
  const step = 32768;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}
__name(bytesToBase642, "bytesToBase64");
async function notifyAdmin(env, text) {
  if (!env.TELEGRAM_ADMIN_CHAT_ID) return;
  try {
    await sendMessage(env, env.TELEGRAM_ADMIN_CHAT_ID, text, { parse_mode: "HTML" });
  } catch (e) {
  }
}
__name(notifyAdmin, "notifyAdmin");
function vkPostUrl(env, postId) {
  return postId && env.VK_GROUP_ID ? `https://vk.com/wall-${env.VK_GROUP_ID}_${postId}` : null;
}
__name(vkPostUrl, "vkPostUrl");
function pubStatus(res) {
  const parts = [];
  parts.push(res.tgOk ? "\u{1F7E2} TG \u2713" : "TG \u2717");
  parts.push(res.vkOk ? "\u{1F535} VK \u2713" : "VK \u2717");
  return parts.join(" \xB7 ");
}
__name(pubStatus, "pubStatus");
function mskToUtcMs(dow, minuteOfDay, now = /* @__PURE__ */ new Date()) {
  const msk = new Date(now.getTime() + MSK_OFFSET_MIN * 60 * 1e3);
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
  return Date.UTC(y, m, d, Math.floor(utcMinute / 60), utcMinute % 60) - 0;
}
__name(mskToUtcMs, "mskToUtcMs");
function currentWindow(minuteOfDay) {
  return NEWS_WINDOWS.find((w) => minuteOfDay >= w.start && minuteOfDay < w.end) || null;
}
__name(currentWindow, "currentWindow");
async function countInWindow(env, win, now) {
  const log = await getLog(env);
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
__name(countInWindow, "countInWindow");
async function nextFreeSlot(env, now = /* @__PURE__ */ new Date()) {
  const nowMs = now.getTime();
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const t = new Date(nowMs + dayOffset * 864e5);
    const m2 = mskNow(t);
    for (const w of NEWS_WINDOWS) {
      const slot = mskToUtcMs(m2.dow, w.start, new Date(t));
      if (slot < nowMs) continue;
      const used = await countInWindow(env, w, new Date(slot));
      if (used < w.cap) return slot;
    }
  }
  return nowMs + 3600 * 1e3;
}
__name(nextFreeSlot, "nextFreeSlot");
function chunkText(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}
__name(chunkText, "chunkText");
async function dispatchToGitHub(env, cand) {
  const chunks = chunkText(cand.text || "", 600).slice(0, 9);
  const inputs = {
    telegram_update: JSON.stringify({
      auto_found: cand.auto_found !== false,
      guid: cand.guid,
      title: cand.title || "",
      link: cand.link || "",
      kind: cand.kind || "news",
      message: { chat: { id: cand.chat_id ?? null }, text: chunks[0] || "" }
    })
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
        "User-Agent": "tgvk-bot-webhook"
      },
      body: JSON.stringify({ ref: "main", inputs })
    }
  );
  if (!res.ok) return false;
  await markDispatch(env, cand.guid, {
    at: Date.now(),
    title: cand.title,
    link: cand.link,
    kind: cand.kind || "news",
    pub_ts: cand.pub_ts || null,
    status: "dispatched"
  });
  return true;
}
__name(dispatchToGitHub, "dispatchToGitHub");
async function publishPackage(env, pkg, dry, target = "all") {
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
    if (mode !== "vk") {
      try {
        await publishToTelegram(env, pkg, dry);
        tgOk = true;
      } catch (e) {
        tgErr = e.message;
      }
    }
    if (mode !== "tg") {
      try {
        const vkr = await publishToVk(env, pkg, dry);
        vkOk = true;
        vkPost = vkr && vkr.post_id || null;
        vkAttach = vkr && vkr.vk_attachment || null;
      } catch (e) {
        vkErr = e.message;
      }
    }
    if (mode === "all" && tgOk !== vkOk && !dry) {
      await addVkRetry(env, { ...pkg, attempts: 0 }, { missing: [tgOk ? "vk" : "tg"] });
    }
    if (!tgOk && !vkOk) {
      throw new Error(`publish failed tg=[${tgErr}] vk=[${vkErr}]`);
    }
    await addLog(env, {
      id: pkg.id,
      kind: pkg.kind || "news",
      title: pkg.title || "",
      guid: pkg.guid || "",
      link: pkg.link || "",
      tags: pkg.tags || [],
      source: pkg.source || "",
      published_at: (/* @__PURE__ */ new Date()).toISOString(),
      caption: pkg.caption || "",
      tg_ok: tgOk,
      vk_ok: vkOk,
      vk_post_id: vkPost,
      vk_attachment: vkAttach,
      tg_err: tgErr || null,
      vk_err: vkErr || null,
      target: mode
    });
    return { tgOk, vkOk, vkPost };
  }
  __name(publishOne, "publishOne");
}
__name(publishPackage, "publishPackage");
async function publishText(env, text, dry, kind, extra = {}) {
  let tgOk = false;
  let vkOk = false;
  let tgErr = null;
  let vkErr = null;
  if (dry) {
    console.log(`[dry-run] TG text -> ${env.TELEGRAM_CHANNEL_ID} (${text.length} \u0441\u0438\u043C\u0432.)`);
    tgOk = true;
  } else {
    try {
      await sendMessage(env, env.TELEGRAM_CHANNEL_ID, text, { parse_mode: "HTML" });
      tgOk = true;
    } catch (e) {
      tgErr = e.message;
    }
  }
  const plain = text.replace(/<[^>]+>/g, "").trim();
  if (dry) {
    console.log(`[dry-run] VK wall.post text (${plain.length} \u0441\u0438\u043C\u0432.)`);
    vkOk = true;
  } else {
    try {
      await vkCall(env, "wall.post", {
        owner_id: -env.VK_GROUP_ID,
        from_group: 1,
        message: plain
      });
      vkOk = true;
    } catch (e) {
      vkErr = e.message;
    }
  }
  if (!tgOk && !vkOk) return false;
  await addLog(env, {
    id: extra.id || `t${Date.now()}`,
    kind,
    title: extra.title || "",
    guid: extra.guid || "",
    link: extra.link || "",
    published_at: (/* @__PURE__ */ new Date()).toISOString(),
    caption: text,
    tg_ok: tgOk,
    vk_ok: vkOk,
    tg_err: tgErr,
    vk_err: vkErr
  });
  return true;
}
__name(publishText, "publishText");
async function autoDeferDrafts(env, state, now = /* @__PURE__ */ new Date()) {
  const drafts = await listDrafts(env);
  const deadline = now.getTime() - DRAFT_TIMEOUT_MIN * 60 * 1e3;
  for (const d of drafts) {
    if (d.status && d.status !== "pending") continue;
    if (!d.created_at) {
      d.created_at = now.toISOString();
      await saveDraft(env, d);
      continue;
    }
    const created = new Date(d.created_at).getTime();
    if (created > deadline) continue;
    if (isStaleItem(d, now.getTime())) {
      await deleteDraft(env, d.id);
      continue;
    }
    const slot = await nextFreeSlot(env, now);
    await deleteDraft(env, d.id);
    await addStock(env, {
      id: d.id,
      kind: d.kind === "digest" ? "digest" : "news",
      title: d.title || "",
      caption: d.caption || "",
      png_key: d.png_key || null,
      png: d.png ? typeof d.png === "string" ? decodePng(d.png) : d.png : null,
      link: d.link || "",
      guid: d.guid || "",
      source: d.source || "",
      tags: d.tags || [],
      data: d.data || null,
      items: d.items || [],
      scheduled_for: slot,
      created_at: (/* @__PURE__ */ new Date()).toISOString(),
      from_admin: false
    });
    const when = fmtTime(new Date(slot).toISOString());
    try {
      await sendMessage(
        env,
        env.TELEGRAM_ADMIN_CHAT_ID,
        `\u23F3 <b>\u041D\u0435 \u043F\u043E\u043B\u0443\u0447\u0438\u043B \u043E\u0442\u0432\u0435\u0442 \u0437\u0430 ${DRAFT_TIMEOUT_MIN} \u043C\u0438\u043D\u0443\u0442</b> \u2014 \u043F\u043E\u0441\u0442 \xAB${d.title || ""}\xBB \u043F\u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D \u0432 \u043E\u0442\u043B\u043E\u0436\u0435\u043D\u043D\u044B\u0435 \u043D\u0430 \u0441\u043B\u043E\u0442 ${when}.`,
        { parse_mode: "HTML" }
      );
    } catch (e) {
    }
  }
}
__name(autoDeferDrafts, "autoDeferDrafts");
async function publishDueStock(env, now = /* @__PURE__ */ new Date()) {
  const stock = await getStock(env);
  const nowMs = now.getTime();
  const state = await loadState(env);
  const dry = !!state.dry_run;
  const due = stock.filter((p) => (p.scheduled_for || 0) <= nowMs);
  for (const pkg of due) {
    if (pkg.kind === "digest") {
    } else if (pkg.kind === "news" && isStaleItem(pkg, nowMs)) {
      await removeStock(env, pkg.id);
      continue;
    }
    if (pkg.kind === "news" || pkg.kind === "digest") {
      const msk = mskNow(new Date(pkg.scheduled_for || now.getTime()));
      const win = currentWindow(msk.minuteOfDay);
      if (win) {
        const used = await countInWindow(env, win, new Date(pkg.scheduled_for || now.getTime()));
        if (used >= win.cap) {
          const next = await nextFreeSlot(env, now);
          await removeStock(env, pkg.id);
          await addStock(env, { ...pkg, scheduled_for: next });
          continue;
        }
      }
    }
    if (pkg.guid) {
      const log = await getLog(env);
      if (log.some((e) => e.guid && e.guid === pkg.guid)) {
        await removeStock(env, pkg.id);
        continue;
      }
    }
    if (!dry && pkg.data && pkg.kind !== "event") {
      try {
        const fresh = await renderCardBytes(env, pkg.data, {
          link: pkg.link || "",
          source: pkg.source || ""
        });
        if (fresh && fresh.length > 100) pkg.png = fresh;
      } catch (e) {
        console.log("[scheduler] re-render card failed, keep old:", e.message);
      }
    }
    await removeStock(env, pkg.id);
    try {
      if (pkg.kind === "event") {
        const text = (pkg.caption || pkg.title || "").trim();
        if (!text) continue;
        const ok = await publishText(env, text, dry, "event", {
          id: pkg.id,
          title: pkg.title || "",
          guid: pkg.guid || "",
          link: pkg.link || ""
        });
        if (ok) {
          await notifyAdmin(env, `\u{1F3AA} <b>\u0418\u0432\u0435\u043D\u0442 \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u043D</b>: ${pkg.title || ""}`);
        } else {
          await addStock(env, { ...pkg, scheduled_for: now.getTime() + 15 * 60 * 1e3 });
        }
        continue;
      }
      const res = await publishPackage(env, pkg, dry);
      if (!dry) {
        const url = vkPostUrl(env, res.vkPost);
        const line = url ? `${pubStatus(res)} \xB7 ${url}` : pubStatus(res);
        if (res.tgOk && res.vkOk) {
          await notifyAdmin(env, `\u2705 <b>\u041E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u043D\u043E</b>: ${pkg.title || ""}
${line}`);
        } else if (res.tgOk || res.vkOk) {
          const missing = res.tgOk ? "VK" : "TG";
          await notifyAdmin(env, `\u23F3 <b>\u0427\u0430\u0441\u0442\u0438\u0447\u043D\u043E \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u043D\u043E</b>: ${pkg.title || ""}
${line}
\u{1F51C} \u0414\u043E\u0433\u043E\u043D\u044F\u044E ${missing} \u0432 \u0431\u043B\u0438\u0436\u0430\u0439\u0448\u0438\u0435 \u0442\u0438\u043A\u0438.`);
        }
      }
    } catch (e) {
      console.log("[scheduler] publish failed:", e.message);
      await notifyAdmin(env, `\u274C <b>\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C</b>: ${pkg.title || ""}
${escHtml(e.message)}`);
      await addStock(env, { ...pkg, scheduled_for: now.getTime() + 15 * 60 * 1e3 });
    }
  }
}
__name(publishDueStock, "publishDueStock");
async function pickDigestItems(env, count) {
  const nowMs = Date.now();
  const list = (await getCandidates(env) || []).filter((c) => !isStaleItem(c, nowMs));
  list.sort((a, b) => digestFreshScore(b) - digestFreshScore(a));
  return list.slice(0, count);
}
__name(pickDigestItems, "pickDigestItems");
async function finalizeDigestPkg(env, items, opts) {
  const { label, slug, date, slot } = opts;
  const itemMeta = items.map((c) => ({
    guid: c.guid || "",
    title: String(c.title || "").replace(/\s+/g, " ").trim().slice(0, 120),
    link: c.link || "",
    source: sourceDomain(c.link || "") || c.source || "",
    text: String(c.text || "").replace(/\s+/g, " ").trim().slice(0, 800)
  }));
  const { headline, caption } = await generateDigestText(items, env, { label, slug, date });
  const data = {
    headline,
    headline_lines: [headline],
    caption,
    cards: [
      {
        type: "list",
        label: "\u0412 \u044D\u0442\u043E\u043C \u0432\u044B\u043F\u0443\u0441\u043A\u0435",
        items: itemMeta.map((m2) => m2.title || "\u041D\u043E\u0432\u043E\u0441\u0442\u044C").slice(0, DIGEST_MAX_ITEMS)
      }
    ],
    tier: "news",
    source: "TrustNode"
  };
  let b64 = "";
  try {
    const bytes = await renderCardBytes(env, data, { link: "", source: "TrustNode" });
    if (bytes && bytes.length > 100) b64 = bytesToBase642(bytes);
  } catch (e) {
    console.log("[scheduler] \u0434\u0430\u0439\u0434\u0436\u0435\u0441\u0442: \u043E\u0431\u043B\u043E\u0436\u043A\u0443 \u043D\u0435 \u0441\u043E\u0431\u0440\u0430\u043B\u0438:", e.message);
  }
  if (!b64) {
    return null;
  }
  return {
    pkg: {
      id: `dg${date.replace(/-/g, "")}${slug}`,
      kind: "digest",
      title: headline,
      caption,
      png: b64,
      data,
      link: "",
      guid: `digest:${date}:${slug}`,
      source: "TrustNode",
      tags: [],
      items: itemMeta,
      scheduled_for: slot,
      created_at: (/* @__PURE__ */ new Date()).toISOString(),
      from_admin: false,
      window_slug: slug
    }
  };
}
__name(finalizeDigestPkg, "finalizeDigestPkg");
async function buildDigestForWindow(env, win, now) {
  const msk = mskNow(now);
  const date = msk.date;
  if (await getDigestDone(env, date, win.slug)) return null;
  const items = await pickDigestItems(env, DIGEST_MAX_ITEMS);
  if (!items.length) return null;
  const res = await finalizeDigestPkg(env, items, {
    label: win.label,
    slug: win.slug,
    date,
    slot: mskToUtcMs(msk.dow, win.start, now)
  });
  if (!res) return null;
  return { pkg: res.pkg, items };
}
__name(buildDigestForWindow, "buildDigestForWindow");
async function commitDigest(env, date, win, items) {
  const consumed = new Set(items.map((c) => c.guid));
  const rest = (await getCandidates(env)).filter((c) => !consumed.has(c.guid));
  await setCandidates(env, rest);
  await setDigestDone(env, date, win.slug, { assembled_at: (/* @__PURE__ */ new Date()).toISOString(), items: items.length });
}
__name(commitDigest, "commitDigest");
async function assembleDigests(env, now = /* @__PURE__ */ new Date()) {
  const msk = mskNow(now);
  const made = [];
  for (const w of NEWS_WINDOWS) {
    if (msk.minuteOfDay < w.start || msk.minuteOfDay >= w.end) continue;
    const res = await buildDigestForWindow(env, w, now);
    if (!res) continue;
    await addStock(env, res.pkg);
    await commitDigest(env, msk.date, w, res.items);
    made.push(res.pkg.guid);
    console.log("[scheduler] \u0434\u0430\u0439\u0434\u0436\u0435\u0441\u0442 \u0441\u043E\u0431\u0440\u0430\u043D:", res.pkg.title, "\u2192", new Date(res.pkg.scheduled_for).toISOString());
  }
  return made;
}
__name(assembleDigests, "assembleDigests");
async function sendDigestPreview(env, adminChat, pkg) {
  const bytes = decodePng(pkg.png);
  const sent = await sendCard(env, adminChat, bytes, pkg.caption, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: approveButtons(pkg.id) }
  });
  await saveDraft(env, {
    id: pkg.id,
    kind: "digest",
    status: "pending",
    title: pkg.title,
    caption: pkg.caption,
    png: pkg.png,
    link: "",
    source: "TrustNode",
    guid: pkg.guid,
    items: pkg.items,
    admin_chat_id: adminChat,
    preview_message_id: sent && sent.message_id,
    created_at: (/* @__PURE__ */ new Date()).toISOString()
  });
}
__name(sendDigestPreview, "sendDigestPreview");
async function assembleDigestDrafts(env, now = /* @__PURE__ */ new Date()) {
  const msk = mskNow(now);
  const adminChat = env.TELEGRAM_ADMIN_CHAT_ID;
  let sent = 0;
  for (const w of NEWS_WINDOWS) {
    if (msk.minuteOfDay < w.start || msk.minuteOfDay >= w.end) continue;
    const res = await buildDigestForWindow(env, w, now);
    if (!res) continue;
    if (adminChat) await sendDigestPreview(env, adminChat, res.pkg);
    await commitDigest(env, msk.date, w, res.items);
    sent++;
    console.log("[scheduler] \u0434\u0430\u0439\u0434\u0436\u0435\u0441\u0442-\u043F\u0440\u0435\u0432\u044C\u044E \u0430\u0434\u043C\u0438\u043D\u0443:", res.pkg.title);
  }
  return sent;
}
__name(assembleDigestDrafts, "assembleDigestDrafts");
async function rebuildDigestPreview(env, draft) {
  const slug = String(draft.id || "").replace(/^dg\d{8}/, "");
  const win = NEWS_WINDOWS.find((w) => w.slug === slug);
  const date = String(draft.guid || "").split(":")[1] || "";
  if (!win || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, reason: "\u043D\u0435 \u0440\u0430\u0441\u043F\u043E\u0437\u043D\u0430\u043D \u0432\u044B\u043F\u0443\u0441\u043A \u0434\u0430\u0439\u0434\u0436\u0435\u0441\u0442\u0430" };
  }
  if (!Array.isArray(draft.items) || !draft.items.length) {
    return { ok: false, reason: "\u043D\u0435\u0442 \u0441\u043E\u0445\u0440\u0430\u043D\u0451\u043D\u043D\u044B\u0445 \u043D\u043E\u0432\u043E\u0441\u0442\u0435\u0439 \u0432\u044B\u043F\u0443\u0441\u043A\u0430" };
  }
  const res = await finalizeDigestPkg(env, draft.items, {
    label: win.label,
    slug: win.slug,
    date,
    slot: mskToUtcMs(0, win.start, /* @__PURE__ */ new Date())
  });
  if (!res) return { ok: false, reason: "\u043E\u0431\u043B\u043E\u0436\u043A\u0443 \u043D\u0435 \u0441\u043E\u0431\u0440\u0430\u043B\u0438" };
  const adminChat = draft.admin_chat_id || env.TELEGRAM_ADMIN_CHAT_ID;
  await deleteDraft(env, draft.id);
  if (adminChat) await sendDigestPreview(env, adminChat, res.pkg);
  return { ok: true };
}
__name(rebuildDigestPreview, "rebuildDigestPreview");
async function tick(env, opts = {}) {
  const now = opts.now ? new Date(opts.now) : /* @__PURE__ */ new Date();
  try {
    if (env.BOT_KV) {
      const raw = await env.BOT_KV.get("scheduler_lock");
      let lock = null;
      try {
        lock = raw ? JSON.parse(raw) : null;
      } catch (e) {
        lock = null;
      }
      if (lock && Date.now() - lock.at < TICK_LOCK_TTL_MS) {
        return "busy";
      }
      await env.BOT_KV.put("scheduler_lock", JSON.stringify({ at: Date.now() }), {
        expirationTtl: Math.floor(TICK_LOCK_TTL_MS / 1e3)
      });
    }
  } catch (e) {
    console.log("[scheduler] lock error:", e.message);
  }
  const state = await loadState(env);
  const offset = state.meta.scan_chunk || 0;
  try {
    await scanFeeds(env, offset, CHUNK_COUNT);
  } catch (e) {
    console.log("[scheduler] scan error:", e.message);
  }
  state.meta.scan_chunk = (offset + 1) % CHUNK_COUNT;
  try {
    const nowMs = now.getTime();
    const candList = await getCandidates(env);
    const freshCands = candList.filter((c) => !isStaleItem(c, nowMs));
    if (freshCands.length !== candList.length) await setCandidates(env, freshCands);
    if (await getAutopost(env)) {
      await assembleDigests(env, now);
    } else {
      await assembleDigestDrafts(env, now);
    }
  } catch (e) {
    console.log("[scheduler] digest error:", e.message);
  }
  try {
    await autoDeferDrafts(env, state, now);
  } catch (e) {
    console.log("[scheduler] defer error:", e.message);
  }
  try {
    await publishDueStock(env, now);
  } catch (e) {
    console.log("[scheduler] publish error:", e.message);
  }
  await saveState(env, state);
  return "ok";
}
__name(tick, "tick");

// worker.js
init_telegram();
init_text();
init_config();
init_cardgen();

// lib/support.js
init_telegram();
init_config();
init_text();
var USER_MENU_KB = [
  [
    { text: "\u{1F4EE} \u041F\u0440\u0435\u0434\u043B\u043E\u0436\u0438\u0442\u044C \u043F\u043E\u0441\u0442/\u0440\u0435\u043A\u043B\u0430\u043C\u0443", callback_data: "user:suggest" },
    { text: "\u{1F4AC} \u041F\u043E\u0434\u0434\u0435\u0440\u0436\u043A\u0430", callback_data: "user:support" }
  ],
  [{ text: "\u{1F4D6} \u041E \u0431\u043E\u0442\u0435", callback_data: "user:about" }]
];
var USER_WELCOME = "\u{1F6E1}\uFE0F <b>TrustNode \u2014 SMM-\u0441\u0442\u0443\u0434\u0438\u044F</b>\n\n\u041F\u0440\u0438\u0432\u0435\u0442! \u0417\u0434\u0435\u0441\u044C \u043C\u043E\u0436\u043D\u043E \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0438\u0442\u044C \u043F\u043E\u0441\u0442 \u0438\u043B\u0438 \u0440\u0435\u043A\u043B\u0430\u043C\u0443 \u0434\u043B\u044F \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438, \u0430 \u0442\u0430\u043A\u0436\u0435 \u043D\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u0432 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u043A\u0443.\n\n\u2022 \u{1F4EE} <b>\u041F\u0440\u0435\u0434\u043B\u043E\u0436\u0438\u0442\u044C \u043F\u043E\u0441\u0442/\u0440\u0435\u043A\u043B\u0430\u043C\u0443</b> \u2014 \u0442\u0435\u043A\u0441\u0442 \u0443\u0439\u0434\u0451\u0442 \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0443 \u043D\u0430 \u043E\u0434\u043E\u0431\u0440\u0435\u043D\u0438\u0435\n\u2022 \u{1F4AC} <b>\u041F\u043E\u0434\u0434\u0435\u0440\u0436\u043A\u0430</b> \u2014 \u0432\u043E\u043F\u0440\u043E\u0441 \u0443\u0439\u0434\u0451\u0442 \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0443, \u043E\u0442\u0432\u0435\u0442 \u043F\u0440\u0438\u0434\u0451\u0442 \u0441\u044E\u0434\u0430\n\n\u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 /start, \u0447\u0442\u043E\u0431\u044B \u0432\u0435\u0440\u043D\u0443\u0442\u044C\u0441\u044F \u0432 \u043C\u0435\u043D\u044E.";
var USER_ABOUT = "\u{1F6E1}\uFE0F <b>TrustNode</b> \u2014 \u0441\u0442\u0443\u0434\u0438\u044F \u0446\u0438\u0444\u0440\u043E\u0432\u043E\u0439 \u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u0438.\n\n\u041F\u0443\u0431\u043B\u0438\u043A\u0443\u0435\u043C \u043D\u043E\u0432\u043E\u0441\u0442\u0438, \u0430\u043D\u0430\u043B\u0438\u0442\u0438\u043A\u0443 \u0438 \u0440\u0430\u0437\u0431\u043E\u0440\u044B \u043C\u043E\u0448\u0435\u043D\u043D\u0438\u0447\u0435\u0441\u043A\u0438\u0445 \u0441\u0445\u0435\u043C \u0432 Telegram \u0438 VK.\n\n\u{1F4EE} \u041F\u0440\u0435\u0434\u043B\u043E\u0436\u0438\u0442\u044C \u043F\u043E\u0441\u0442 \u2014 \u043E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u0442\u0435\u043A\u0441\u0442 \u0438\u043B\u0438 \u0444\u043E\u0442\u043E \u0440\u0435\u043A\u043B\u0430\u043C\u044B/\u043D\u043E\u0432\u043E\u0441\u0442\u0438, \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440 \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u0443\u0435\u0442 \u0435\u0451 \u043F\u043E\u0441\u043B\u0435 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0438.\n\u{1F4AC} \u041F\u043E\u0434\u0434\u0435\u0440\u0436\u043A\u0430 \u2014 \u043D\u0430\u043F\u0438\u0448\u0438\u0442\u0435 \u0432\u043E\u043F\u0440\u043E\u0441, \u043E\u0442\u0432\u0435\u0442 \u043F\u0440\u0438\u0434\u0451\u0442 \u0432 \u044D\u0442\u043E\u0442 \u0447\u0430\u0442.\n\n\u041C\u0435\u043D\u044E: /start";
function parseTimeInput(input, now = /* @__PURE__ */ new Date()) {
  const m = String(input || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  const msk = mskNow(now);
  const target = h * 60 + min;
  let ts = mskToUtcMs(msk.dow, target, now);
  if (ts < now.getTime()) {
    const nextDow = (msk.dow + 1) % 7;
    ts = mskToUtcMs(nextDow, target, now);
  }
  return ts;
}
__name(parseTimeInput, "parseTimeInput");
async function startEventDialog(env, chatId) {
  await setEventDialog(env, { step: "text", chat_id: chatId });
  await sendMessage(
    env,
    chatId,
    "\u{1F3AA} <b>\u0421\u043E\u0437\u0434\u0430\u043D\u0438\u0435 \u0438\u0432\u0435\u043D\u0442\u0430</b>\n\n\u0428\u0430\u0433 1/2. \u041F\u0440\u0438\u0448\u043B\u0438\u0442\u0435 \u0442\u0435\u043A\u0441\u0442 \u0438\u0432\u0435\u043D\u0442\u0430 (\u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440, \xAB\u0412\u0435\u0431\u0438\u043D\u0430\u0440 \u043F\u043E \u0446\u0438\u0444\u0440\u043E\u0432\u043E\u0439 \u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u0438\xBB).\n\n/cancel \u2014 \u043E\u0442\u043C\u0435\u043D\u0430.",
    { parse_mode: "HTML" }
  );
}
__name(startEventDialog, "startEventDialog");
async function handleEventDialogMessage(env, msg) {
  const dialog = await getEventDialog(env);
  if (!dialog) return false;
  const chatId = msg.chat ? msg.chat.id : null;
  if (!chatId || String(chatId) !== String(dialog.chat_id)) return false;
  const text = (msg.text || "").trim();
  if (!text) {
    await sendMessage(env, chatId, "\u041F\u0440\u0438\u0448\u043B\u0438\u0442\u0435 \u0442\u0435\u043A\u0441\u0442 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435\u043C, \u043F\u043E\u0436\u0430\u043B\u0443\u0439\u0441\u0442\u0430.");
    return true;
  }
  if (text.toLowerCase() === "/cancel") {
    await setEventDialog(env, null);
    await sendMessage(env, chatId, "\u041E\u0442\u043C\u0435\u043D\u0435\u043D\u043E.");
    return true;
  }
  if (dialog.step === "text") {
    await setEventDialog(env, { ...dialog, step: "time", text });
    await sendMessage(
      env,
      chatId,
      "\u{1F3AA} \u0428\u0430\u0433 2/2. \u041A\u043E\u0433\u0434\u0430 \u043F\u0443\u0431\u043B\u0438\u043A\u0443\u0435\u043C \u0438\u0432\u0435\u043D\u0442?\n\n\u041F\u0440\u0438\u0448\u043B\u0438\u0442\u0435 \u0432\u0440\u0435\u043C\u044F \u0432 \u0444\u043E\u0440\u043C\u0430\u0442\u0435 <b>\u0427\u0427:\u041C\u041C</b> (\u041C\u0421\u041A).\n\n/cancel \u2014 \u043E\u0442\u043C\u0435\u043D\u0430.",
      { parse_mode: "HTML" }
    );
    return true;
  }
  if (dialog.step === "time") {
    const ts = parseTimeInput(text);
    if (ts === null) {
      await sendMessage(
        env,
        chatId,
        "\u041D\u0435 \u043F\u043E\u043D\u044F\u043B \u0432\u0440\u0435\u043C\u044F. \u041F\u0440\u0438\u0448\u043B\u0438\u0442\u0435 \u0432 \u0444\u043E\u0440\u043C\u0430\u0442\u0435 <b>\u0427\u0427:\u041C\u041C</b> (\u041C\u0421\u041A), \u043D\u0430\u043F\u0440\u0438\u043C\u0435\u0440 18:30.",
        { parse_mode: "HTML" }
      );
      return true;
    }
    const id = `evt${Date.now().toString(36)}${Math.floor(Math.random() * 1e3)}`;
    await addStock(env, {
      id,
      kind: "event",
      title: dialog.text.slice(0, 80),
      caption: dialog.text,
      guid: "",
      link: "",
      scheduled_for: ts,
      created_at: (/* @__PURE__ */ new Date()).toISOString(),
      from_admin: true
    });
    await setEventDialog(env, null);
    const when = fmtTime(new Date(ts).toISOString());
    await sendMessage(
      env,
      chatId,
      `\u2705 <b>\u0418\u0432\u0435\u043D\u0442 \u0437\u0430\u043F\u043B\u0430\u043D\u0438\u0440\u043E\u0432\u0430\u043D</b>

${escHtml(dialog.text)}

\u23F0 \u041F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F: <b>${when}</b> (\u041C\u0421\u041A)`,
      { parse_mode: "HTML" }
    );
    return true;
  }
  return false;
}
__name(handleEventDialogMessage, "handleEventDialogMessage");
async function sendUserMenu(env, chatId) {
  await sendMessage(env, chatId, USER_WELCOME, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: USER_MENU_KB }
  });
}
__name(sendUserMenu, "sendUserMenu");
async function handleUserStart(env, chatId) {
  await setUserMode(env, chatId, null);
  await sendUserMenu(env, chatId);
}
__name(handleUserStart, "handleUserStart");
async function handleUserCallback(env, cq) {
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : null;
  const msgId = cq.message ? cq.message.message_id : null;
  const qid = cq.id;
  const data = cq.data || "";
  const segs = data.split(":");
  const action = segs[1] || "";
  if (action === "suggest") {
    await setUserMode(env, chatId, "suggest");
    await editMessageReplyMarkup(env, chatId, msgId, []);
    await sendMessage(
      env,
      chatId,
      "\u{1F4EE} <b>\u041F\u0440\u0435\u0434\u043B\u043E\u0436\u0438\u0442\u044C \u043F\u043E\u0441\u0442/\u0440\u0435\u043A\u043B\u0430\u043C\u0443</b>\n\n\u041F\u0440\u0438\u0448\u043B\u0438\u0442\u0435 \u0442\u0435\u043A\u0441\u0442 (\u0438\u043B\u0438 \u0444\u043E\u0442\u043E \u0441 \u043F\u043E\u0434\u043F\u0438\u0441\u044C\u044E). \u0410\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440 \u043F\u0440\u043E\u0432\u0435\u0440\u0438\u0442 \u0438 \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u0443\u0435\u0442 \u043F\u043E\u0441\u043B\u0435 \u043E\u0434\u043E\u0431\u0440\u0435\u043D\u0438\u044F.\n\n/cancel \u2014 \u0432\u0435\u0440\u043D\u0443\u0442\u044C\u0441\u044F \u0432 \u043C\u0435\u043D\u044E.",
      { parse_mode: "HTML" }
    );
    try {
      await answerCallbackQuery(env, qid, "\u0420\u0435\u0436\u0438\u043C \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u043A\u0438");
    } catch (e) {
    }
    return;
  }
  if (action === "support") {
    await setUserMode(env, chatId, "support");
    await editMessageReplyMarkup(env, chatId, msgId, []);
    await sendMessage(
      env,
      chatId,
      "\u{1F4AC} <b>\u041F\u043E\u0434\u0434\u0435\u0440\u0436\u043A\u0430</b>\n\n\u041E\u043F\u0438\u0448\u0438\u0442\u0435 \u0432\u0430\u0448 \u0432\u043E\u043F\u0440\u043E\u0441 \u2014 \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440 \u043E\u0442\u0432\u0435\u0442\u0438\u0442 \u0432 \u044D\u0442\u043E\u0442 \u0447\u0430\u0442.\n\n/cancel \u2014 \u0432\u0435\u0440\u043D\u0443\u0442\u044C\u0441\u044F \u0432 \u043C\u0435\u043D\u044E.",
      { parse_mode: "HTML" }
    );
    try {
      await answerCallbackQuery(env, qid, "\u0420\u0435\u0436\u0438\u043C \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u043A\u0438");
    } catch (e) {
    }
    return;
  }
  if (action === "about") {
    await editMessageReplyMarkup(env, chatId, msgId, []);
    await sendMessage(env, chatId, USER_ABOUT, { parse_mode: "HTML" });
    try {
      await answerCallbackQuery(env, qid, "\u041E \u0431\u043E\u0442\u0435");
    } catch (e) {
    }
    return;
  }
  try {
    await answerCallbackQuery(env, qid, "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043A\u043D\u043E\u043F\u043A\u0430");
  } catch (e) {
  }
}
__name(handleUserCallback, "handleUserCallback");
function bytesToBase643(bytes) {
  let bin = "";
  const step = 32768;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}
__name(bytesToBase643, "bytesToBase64");
function suggestionButtons(id) {
  return [
    [
      { text: "\u{1F310} \u041E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C \u0432\u0435\u0437\u0434\u0435", callback_data: `sugg:approve:all:${id}` },
      { text: "\u{1F535} VK", callback_data: `sugg:approve:vk:${id}` },
      { text: "\u{1F7E2} TG", callback_data: `sugg:approve:tg:${id}` }
    ],
    [{ text: "\u274C \u041E\u0442\u043A\u043B\u043E\u043D\u0438\u0442\u044C", callback_data: `sugg:reject:${id}` }]
  ];
}
__name(suggestionButtons, "suggestionButtons");
async function handleSuggestion(env, msg) {
  const chatId = msg.chat ? msg.chat.id : null;
  if (!chatId) return;
  const id = `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e3)}`;
  const username = msg.from && (msg.from.username ? `@${msg.from.username}` : msg.from.first_name || "") || "";
  const text = (msg.caption || msg.text || "").trim();
  let photo = null;
  let bytes = null;
  if (msg.photo && msg.photo.length) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    try {
      bytes = await downloadFile(env, fileId);
      photo = bytesToBase643(bytes);
    } catch (e) {
    }
  }
  const sug = { id, user_chat_id: chatId, username, text, photo, created_at: (/* @__PURE__ */ new Date()).toISOString() };
  await addSuggestion(env, sug);
  let sent = null;
  try {
    if (bytes) {
      sent = await sendPhoto(
        env,
        env.TELEGRAM_ADMIN_CHAT_ID,
        bytes,
        `\u{1F4EE} <b>\u041F\u0440\u0435\u0434\u043B\u043E\u0436\u043A\u0430 \u043E\u0442 ${escHtml(username)}</b>

${escHtml(text) || "\u2014"}`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: suggestionButtons(id) } }
      );
    } else {
      sent = await sendMessage(
        env,
        env.TELEGRAM_ADMIN_CHAT_ID,
        `\u{1F4EE} <b>\u041F\u0440\u0435\u0434\u043B\u043E\u0436\u043A\u0430 \u043E\u0442 ${escHtml(username)}</b>

${escHtml(text) || "(\u0431\u0435\u0437 \u0442\u0435\u043A\u0441\u0442\u0430)"}`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: suggestionButtons(id) } }
      );
    }
    await addSuggestion(env, { ...sug, admin_msg_id: sent && sent.message_id });
  } catch (e) {
    console.log("[support] forward suggestion failed:", e.message);
  }
  await sendMessage(env, chatId, "\u2705 \u0421\u043F\u0430\u0441\u0438\u0431\u043E! \u0412\u0430\u0448\u0430 \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u043A\u0430 \u0443\u0448\u043B\u0430 \u0430\u0434\u043C\u0438\u043D\u0438\u0441\u0442\u0440\u0430\u0442\u043E\u0440\u0443 \u043D\u0430 \u043F\u0440\u043E\u0432\u0435\u0440\u043A\u0443.");
}
__name(handleSuggestion, "handleSuggestion");
async function publishSuggestion(env, sug, target, dry) {
  const caption = (sug.text || "").trim();
  const channel = await resolveTelegramChannel(env);
  let tgOk = false;
  let vkOk = false;
  let tgErr = null;
  let vkErr = null;
  const plain = caption.replace(/<[^>]+>/g, "").trim();
  if (target !== "vk") {
    try {
      if (dry) {
        console.log(`[dry-run] TG suggestion -> ${channel}`);
      } else if (sug.photo) {
        const bytes = decodeBytes(sug.photo);
        await sendPhoto(env, channel, bytes, caption, { parse_mode: "HTML" });
      } else {
        await sendMessage(env, channel, caption, { parse_mode: "HTML" });
      }
      tgOk = true;
    } catch (e) {
      tgErr = e.message;
    }
  }
  if (target !== "tg") {
    try {
      if (dry) {
        console.log(`[dry-run] VK suggestion wall.post (${plain.length} \u0441\u0438\u043C\u0432.)`);
      } else {
        await vkCall(env, "wall.post", { owner_id: -env.VK_GROUP_ID, from_group: 1, message: plain });
      }
      vkOk = true;
    } catch (e) {
      vkErr = e.message;
    }
  }
  if (!tgOk && !vkOk) throw new Error(`suggestion publish failed tg=[${tgErr}] vk=[${vkErr}]`);
  await addLog(env, {
    id: sug.id,
    kind: "suggestion",
    title: caption.slice(0, 80) || "\u041F\u0440\u0435\u0434\u043B\u043E\u0436\u043A\u0430",
    guid: "",
    link: "",
    source: sug.username || "",
    published_at: (/* @__PURE__ */ new Date()).toISOString(),
    caption,
    tg_ok: tgOk,
    vk_ok: vkOk,
    tg_err: tgErr,
    vk_err: vkErr,
    target
  });
}
__name(publishSuggestion, "publishSuggestion");
function decodeBytes(b64) {
  if (!b64) return null;
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
__name(decodeBytes, "decodeBytes");
async function handleSuggestionCallback(env, cq) {
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : null;
  const msgId = cq.message ? cq.message.message_id : null;
  const qid = cq.id;
  const data = cq.data || "";
  const segs = data.split(":");
  const id = segs[3] || "";
  const target = segs[2] || "all";
  if (!id) {
    try {
      await answerCallbackQuery(env, qid, "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u043A\u0430");
    } catch (e) {
    }
    return;
  }
  const list = await getSuggestions(env);
  const sug = list.find((s) => s.id === id);
  if (!sug) {
    try {
      await answerCallbackQuery(env, qid, "\u041F\u0440\u0435\u0434\u043B\u043E\u0436\u043A\u0430 \u0443\u0436\u0435 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0430\u043D\u0430");
    } catch (e) {
    }
    return;
  }
  if (segs[1] === "reject") {
    await removeSuggestion(env, id);
    try {
      await editMessageReplyMarkup(env, chatId, msgId, []);
    } catch (e) {
    }
    try {
      await answerCallbackQuery(env, qid, "\u041F\u0440\u0435\u0434\u043B\u043E\u0436\u043A\u0430 \u043E\u0442\u043A\u043B\u043E\u043D\u0435\u043D\u0430");
    } catch (e) {
    }
    try {
      await sendMessage(env, sug.user_chat_id, "\u274C \u041A \u0441\u043E\u0436\u0430\u043B\u0435\u043D\u0438\u044E, \u0432\u0430\u0448\u0430 \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u043A\u0430 \u043D\u0435 \u043F\u043E\u0434\u043E\u0448\u043B\u0430. \u0421\u043F\u0430\u0441\u0438\u0431\u043E, \u0447\u0442\u043E \u043D\u0430\u043F\u0438\u0441\u0430\u043B\u0438!");
    } catch (e) {
    }
    return;
  }
  if (segs[1] === "approve") {
    const state = await loadState(env);
    const dry = !!state.dry_run;
    try {
      await publishSuggestion(env, sug, target, dry);
      await removeSuggestion(env, id);
      try {
        await editMessageReplyMarkup(env, chatId, msgId, []);
      } catch (e) {
      }
      const label = target === "vk" ? "\u0432 VK" : target === "tg" ? "\u0432 TG" : "\u0432 VK \u0438 TG";
      try {
        await answerCallbackQuery(env, qid, `\u2705 \u041E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u043D\u043E ${label}`);
      } catch (e) {
      }
      try {
        await sendMessage(env, sug.user_chat_id, "\u2705 \u0412\u0430\u0448\u0430 \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u043A\u0430 \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u043D\u0430! \u0421\u043F\u0430\u0441\u0438\u0431\u043E \u0437\u0430 \u0432\u043A\u043B\u0430\u0434.");
      } catch (e) {
      }
    } catch (e) {
      try {
        await answerCallbackQuery(env, qid, `\u041E\u0448\u0438\u0431\u043A\u0430: ${e.message.slice(0, 90)}`);
      } catch (e2) {
      }
      try {
        await sendMessage(
          env,
          env.TELEGRAM_ADMIN_CHAT_ID,
          `\u26A0\uFE0F \u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u043A\u0443 \u043E\u0442 ${escHtml(sug.username || "")}: ${escHtml(e.message)}`
        );
      } catch (e2) {
      }
    }
    return;
  }
  try {
    await answerCallbackQuery(env, qid, "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043A\u043D\u043E\u043F\u043A\u0430");
  } catch (e) {
  }
}
__name(handleSuggestionCallback, "handleSuggestionCallback");
async function handleSupportMessage(env, msg) {
  const chatId = msg.chat ? msg.chat.id : null;
  if (!chatId) return;
  const username = msg.from && (msg.from.username ? `@${msg.from.username}` : msg.from.first_name || "") || "";
  let sent = null;
  try {
    if (msg.photo && msg.photo.length) {
      const bytes = await downloadFile(env, msg.photo[msg.photo.length - 1].file_id);
      sent = await sendPhoto(
        env,
        env.TELEGRAM_ADMIN_CHAT_ID,
        bytes,
        `\u{1F4AC} <b>\u041F\u043E\u0434\u0434\u0435\u0440\u0436\u043A\u0430 \u043E\u0442 ${escHtml(username)}</b>

${escHtml(msg.caption || "(\u0431\u0435\u0437 \u0442\u0435\u043A\u0441\u0442\u0430)")}

\u041E\u0442\u0432\u0435\u0442\u044C\u0442\u0435 \u0440\u0435\u043F\u043B\u0430\u0435\u043C \u2014 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u0443\u0439\u0434\u0451\u0442 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044E.`,
        { parse_mode: "HTML" }
      );
    } else {
      sent = await sendMessage(
        env,
        env.TELEGRAM_ADMIN_CHAT_ID,
        `\u{1F4AC} <b>\u041F\u043E\u0434\u0434\u0435\u0440\u0436\u043A\u0430 \u043E\u0442 ${escHtml(username)}</b>

${escHtml(msg.text || "(\u0431\u0435\u0437 \u0442\u0435\u043A\u0441\u0442\u0430)")}

\u041E\u0442\u0432\u0435\u0442\u044C\u0442\u0435 \u0440\u0435\u043F\u043B\u0430\u0435\u043C \u2014 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u0443\u0439\u0434\u0451\u0442 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044E.`,
        { parse_mode: "HTML" }
      );
    }
    if (sent && sent.message_id) {
      await setSupportFwd(env, sent.message_id, chatId);
    }
  } catch (e) {
    console.log("[support] forward support message failed:", e.message);
  }
  await sendMessage(env, chatId, "\u2705 \u0412\u0430\u0448\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435 \u0443\u0448\u043B\u043E \u0432 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u043A\u0443. \u041E\u0442\u0432\u0435\u0442 \u043F\u0440\u0438\u0434\u0451\u0442 \u0432 \u044D\u0442\u043E\u0442 \u0447\u0430\u0442.");
}
__name(handleSupportMessage, "handleSupportMessage");
async function handleAdminSupportReply(env, msg) {
  const chatId = msg.chat ? msg.chat.id : null;
  if (!chatId) return false;
  const reply = msg.reply_to_message;
  if (!reply) return false;
  const userChatId = await getSupportFwd(env, reply.message_id);
  if (!userChatId) return false;
  const text = (msg.text || msg.caption || "").trim();
  if (!text) return false;
  try {
    await sendMessage(env, userChatId, `\u{1F4AC} <b>\u041E\u0442\u0432\u0435\u0442 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u043A\u0438</b>

${escHtml(text)}`, {
      parse_mode: "HTML"
    });
  } catch (e) {
    console.log("[support] admin reply send failed:", e.message);
  }
  await delSupportFwd(env, reply.message_id);
  return true;
}
__name(handleAdminSupportReply, "handleAdminSupportReply");

// worker.js
var VERSION = "2.3.0";
var WELCOME_TEXT = "\u{1F6E1}\uFE0F <b>TrustNode \u2014 SMM-\u0441\u0442\u0443\u0434\u0438\u044F</b>\n\n\u041F\u0440\u0438\u0432\u0435\u0442! \u042F \u0441\u043E\u0431\u0438\u0440\u0430\u044E \u043D\u043E\u0432\u043E\u0441\u0442\u0438 \u043E \u0446\u0438\u0444\u0440\u043E\u0432\u043E\u0439 \u0431\u0435\u0437\u043E\u043F\u0430\u0441\u043D\u043E\u0441\u0442\u0438, \u0434\u0435\u043B\u0430\u044E \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0438 \u0438 \u043F\u0443\u0431\u043B\u0438\u043A\u0443\u044E \u0438\u0445 \u0432 Telegram \u0438 VK.\n\n\u041A\u0430\u043A \u0440\u0430\u0431\u043E\u0442\u0430\u0442\u044C:\n\u2022 \u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u0442\u0435\u043A\u0441\u0442 \u2014 \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043B\u044E \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0443 \u0438 \u043F\u043E\u043A\u0430\u0436\u0443 \u043F\u0440\u0435\u0432\u044C\u044E \u043D\u0430 \u043E\u0434\u043E\u0431\u0440\u0435\u043D\u0438\u0435\n\u2022 \u041D\u043E\u0432\u043E\u0441\u0442\u0438 \u043D\u0430\u0445\u043E\u0436\u0443 \u0441\u0430\u043C, \u0441 \u0434\u0435\u0434\u0443\u043F\u043B\u0438\u043A\u0430\u0446\u0438\u0435\u0439 \u043E\u0434\u0438\u043D\u0430\u043A\u043E\u0432\u044B\u0445 \u0441\u044E\u0436\u0435\u0442\u043E\u0432\n\u2022 \u041A\u043D\u043E\u043F\u043A\u0438 \u0443 \u043F\u0440\u0435\u0432\u044C\u044E: \u2705 \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C, \u{1F504} \u043F\u0435\u0440\u0435\u0434\u0435\u043B\u0430\u0442\u044C, \u274C \u043E\u0442\u043C\u0435\u043D\u0438\u0442\u044C\n\u2022 \u041F\u043E\u043B\u043D\u044B\u0439 \u0441\u043F\u0438\u0441\u043E\u043A \u2014 /help\n\n\u0420\u0430\u0431\u043E\u0442\u0430\u044E \u0434\u0430\u0436\u0435 \u043F\u0440\u0438 \u0430\u0443\u0442\u044D\u0434\u0436\u0435 GitHub (\u043F\u0443\u0431\u043B\u0438\u043A\u0443\u044E \u0433\u043E\u0442\u043E\u0432\u044B\u0435 \u043F\u043E\u0441\u0442\u044B \u0441\u043E \u0441\u043A\u043B\u0430\u0434\u0430).";
var HELP_TEXT = "\u{1F4D6} <b>\u041A\u043E\u043C\u0430\u043D\u0434\u044B \u0441\u0442\u0443\u0434\u0438\u0438</b>\n\n<b>\u041F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u044F:</b>\n/puball | /pubvk | /pubtg \u2014 \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C \u043F\u043E\u0441\u0442 \u0441\u043E \u0441\u043A\u043B\u0430\u0434\u0430 (\u0432\u0435\u0437\u0434\u0435 / VK / TG)\n/draft &lt;\u0442\u0435\u043A\u0441\u0442&gt; \u2014 \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u0438\u0442\u044C \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0443 (\u043F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440 \u043F\u043E \u0440\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u044E)\n/publish \u2014 \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C \u043F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0439 \u043F\u043E\u0441\u0442 \u0441\u043E \u0441\u043A\u043B\u0430\u0434\u0430 \u0432\u0435\u0437\u0434\u0435\n/skip &lt;guid&gt; \u2014 \u043F\u0440\u043E\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u043A\u0430\u043D\u0434\u0438\u0434\u0430\u0442\u0430\n/event \u2014 \u0441\u043E\u0437\u0434\u0430\u0442\u044C \u0438\u0432\u0435\u043D\u0442 (\u0442\u0435\u043A\u0441\u0442 + \u0432\u0440\u0435\u043C\u044F \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438)\n<b>\u041F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440\u044B \u043A\u0430\u0440\u0442\u043E\u0447\u0435\u043A:</b>\n/gemini &lt;\u0442\u0435\u043A\u0441\u0442&gt; | /gigachat &lt;\u0442\u0435\u043A\u0441\u0442&gt; | /noai &lt;\u0442\u0435\u043A\u0441\u0442&gt;\n<b>\u041E\u0431\u0437\u043E\u0440:</b>\n/status \u2014 \u0441\u0442\u0430\u0442\u0443\u0441, /stats \u2014 \u0441\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0430, /stock \u2014 \u0441\u043A\u043B\u0430\u0434\n/schedule \u2014 \u0440\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u0441\u043B\u043E\u0442\u043E\u0432, /sources \u2014 \u0438\u0441\u0442\u043E\u0447\u043D\u0438\u043A\u0438 \u0438 \u043A\u043B\u044E\u0447\u0435\u0432\u044B\u0435 \u0441\u043B\u043E\u0432\u0430\n/drafts \u2014 \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0438 \u043D\u0430 \u043E\u0434\u043E\u0431\u0440\u0435\u043D\u0438\u0438, /export \u2014 \u0432\u044B\u0433\u0440\u0443\u0437\u043A\u0430 \u0438\u0441\u0442\u043E\u0440\u0438\u0438\n<b>\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438:</b>\n/settings \u2014 \u043D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438, /autopost on|off \u2014 \u0430\u0432\u0442\u043E\u043F\u043E\u0441\u0442\u0438\u043D\u0433\n/cardfmt gif|png|auto \u2014 \u0444\u043E\u0440\u043C\u0430\u0442 \u043A\u0430\u0440\u0442\u043E\u0447\u0435\u043A (GIF-\u0430\u043D\u0438\u043C\u0430\u0446\u0438\u044F \u043D\u0435\u0431\u0430 / PNG / \u0430\u0432\u0442\u043E)\n/dryrun on|off \u2014 \u0441\u0438\u043C\u0443\u043B\u044F\u0446\u0438\u044F \u043F\u0443\u0431\u043B\u0438\u043A\u0430\u0446\u0438\u0438\n/blacklist add|del kw|src|guid &lt;\u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435&gt; \u2014 \u0447\u0451\u0440\u043D\u044B\u0439 \u0441\u043F\u0438\u0441\u043E\u043A\n/keyword add|remove &lt;\u0441\u043B\u043E\u0432\u0430&gt; \u2014 \u043A\u043B\u044E\u0447\u0435\u0432\u044B\u0435 \u0441\u043B\u043E\u0432\u0430\n/rescan \u2014 \u0437\u0430\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u043F\u043E\u043B\u043D\u044B\u0439 \u0442\u0438\u043A, /version \u2014 \u0432\u0435\u0440\u0441\u0438\u044F";
var COMMANDS = [
  { command: "start", description: "\u0413\u043B\u0430\u0432\u043D\u043E\u0435 \u043C\u0435\u043D\u044E" },
  { command: "help", description: "\u0421\u043F\u0440\u0430\u0432\u043A\u0430" },
  { command: "status", description: "\u0421\u0442\u0430\u0442\u0443\u0441 \u0441\u0442\u0443\u0434\u0438\u0438" },
  { command: "sources", description: "\u0418\u0441\u0442\u043E\u0447\u043D\u0438\u043A\u0438 \u0438 \u043A\u043B\u044E\u0447\u0435\u0432\u044B\u0435 \u0441\u043B\u043E\u0432\u0430" },
  { command: "schedule", description: "\u0420\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 \u043F\u043E\u0441\u0442\u043E\u0432" },
  { command: "draft", description: "\u041E\u0442\u043F\u0440\u0430\u0432\u0438\u0442\u044C \u0442\u0435\u043A\u0441\u0442 \u043D\u0430 \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043A\u0443 \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0438" },
  { command: "gemini", description: "\u0421\u043E\u0437\u0434\u0430\u0442\u044C \u043F\u043E\u0441\u0442 \u043E\u0442 Gemini" },
  { command: "gigachat", description: "\u0421\u043E\u0437\u0434\u0430\u0442\u044C \u043F\u043E\u0441\u0442 \u043E\u0442 GigaChat" },
  { command: "noai", description: "\u0421\u043E\u0437\u0434\u0430\u0442\u044C \u043F\u043E\u0441\u0442 \u0431\u0435\u0437 \u0418\u0418" },
  { command: "publish", description: "\u041E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C \u0441\u0435\u0439\u0447\u0430\u0441 (\u0432\u0435\u0437\u0434\u0435)" },
  { command: "puball", description: "\u041E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C \u0441\u043E \u0441\u043A\u043B\u0430\u0434\u0430 \u0432\u0435\u0437\u0434\u0435" },
  { command: "pubvk", description: "\u041E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C \u0441\u043E \u0441\u043A\u043B\u0430\u0434\u0430 \u0432 VK" },
  { command: "pubtg", description: "\u041E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C \u0441\u043E \u0441\u043A\u043B\u0430\u0434\u0430 \u0432 TG" },
  { command: "skip", description: "\u041F\u0440\u043E\u043F\u0443\u0441\u0442\u0438\u0442\u044C \u043A\u0430\u043D\u0434\u0438\u0434\u0430\u0442\u0430" },
  { command: "event", description: "\u0421\u043E\u0437\u0434\u0430\u0442\u044C \u0438\u0432\u0435\u043D\u0442" },
  { command: "stats", description: "\u0421\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0430" },
  { command: "blacklist", description: "\u0427\u0451\u0440\u043D\u044B\u0439 \u0441\u043F\u0438\u0441\u043E\u043A" },
  { command: "keyword", description: "\u041A\u043B\u044E\u0447\u0435\u0432\u044B\u0435 \u0441\u043B\u043E\u0432\u0430" },
  { command: "settings", description: "\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438" },
  { command: "cardfmt", description: "\u0424\u043E\u0440\u043C\u0430\u0442 \u043A\u0430\u0440\u0442\u043E\u0447\u0435\u043A: gif|png|auto" },
  { command: "dryrun", description: "Dry-run \u0432\u043A\u043B/\u0432\u044B\u043A\u043B" },
  { command: "autopost", description: "\u0410\u0432\u0442\u043E\u043F\u043E\u0441\u0442\u0438\u043D\u0433 \u0432\u043A\u043B/\u0432\u044B\u043A\u043B" },
  { command: "stock", description: "\u0421\u043A\u043B\u0430\u0434 \u043F\u043E\u0441\u0442\u043E\u0432" },
  { command: "drafts", description: "\u0427\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0438" },
  { command: "export", description: "\u042D\u043A\u0441\u043F\u043E\u0440\u0442 \u0438\u0441\u0442\u043E\u0440\u0438\u0438" },
  { command: "rescan", description: "\u041F\u043E\u043B\u043D\u044B\u0439 \u0442\u0438\u043A" },
  { command: "version", description: "\u0412\u0435\u0440\u0441\u0438\u044F" }
];
var BTN_STATUS = "\u{1F4CA} \u0421\u0442\u0430\u0442\u0443\u0441";
var BTN_NEW_POST = "\u270D\uFE0F \u0421\u0434\u0435\u043B\u0430\u0442\u044C \u043F\u043E\u0441\u0442";
var BTN_NOAI = "\u{1F4DD} \u041F\u043E\u0441\u0442 \u0431\u0435\u0437 \u0418\u0418";
var BTN_STOCK = "\u{1F5C4} \u0421\u043A\u043B\u0430\u0434";
var BTN_STATS = "\u{1F4DC} \u0421\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0430";
var BTN_SOURCES = "\u{1F4E1} \u0418\u0441\u0442\u043E\u0447\u043D\u0438\u043A\u0438";
var BTN_SETTINGS = "\u2699\uFE0F \u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438";
var BTN_HELP = "\u{1F4D6} \u041F\u043E\u043C\u043E\u0449\u044C";
var BTN_DRYRUN = "\u{1F9EA} Dry-run";
var BTN_EVENT = "\u{1F3AA} \u0418\u0432\u0435\u043D\u0442";
function replyKeyboard(rows) {
  return {
    keyboard: rows.map((r) => r.map((t) => ({ text: t }))),
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "\u0422\u0435\u043A\u0441\u0442 \u043D\u043E\u0432\u043E\u0441\u0442\u0438 \u0438\u043B\u0438 \u043A\u043E\u043C\u0430\u043D\u0434\u0430\u2026"
  };
}
__name(replyKeyboard, "replyKeyboard");
var MAIN_KB = replyKeyboard([
  [BTN_STATUS, BTN_NEW_POST],
  [BTN_NOAI],
  [BTN_STOCK, BTN_STATS],
  [BTN_EVENT, BTN_SETTINGS],
  [BTN_HELP]
]);
var BTN_CMDS = {
  [BTN_STATUS]: "/status",
  [BTN_STOCK]: "/stock",
  [BTN_STATS]: "/stats",
  [BTN_SOURCES]: "/sources",
  [BTN_SETTINGS]: "/settings",
  [BTN_HELP]: "/help",
  [BTN_DRYRUN]: "/dryrun",
  [BTN_NOAI]: "/noai",
  [BTN_EVENT]: "/event"
};
function jsonResponse(value, status = 200) {
  return new Response(value === void 0 || value === null ? "null" : JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
__name(jsonResponse, "jsonResponse");
async function apiAuthorized(env, request) {
  const want = env.BOT_AUTH || env.WEBHOOK_SECRET || "";
  if (!want) return false;
  return request.headers.get("X-Bot-Auth") === want;
}
__name(apiAuthorized, "apiAuthorized");
function bytesToBase644(bytes) {
  let bin = "";
  const step = 32768;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}
__name(bytesToBase644, "bytesToBase64");
function minutesToClock(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}
__name(minutesToClock, "minutesToClock");
function isAdmin(env, chatId) {
  return String(chatId) === String(env.TELEGRAM_ADMIN_CHAT_ID);
}
__name(isAdmin, "isAdmin");
function toggle(list, value, add) {
  const arr = Array.isArray(list) ? list : [];
  if (add) {
    return arr.includes(value) ? arr : [...arr, value];
  }
  return arr.filter((x) => x !== value);
}
__name(toggle, "toggle");
async function sendLong(env, chatId, text, opts = {}) {
  const CHUNK = 4e3;
  const parts = [];
  for (let i = 0; i < text.length; i += CHUNK) parts.push(text.slice(i, i + CHUNK));
  for (const p of parts.length ? parts : [""]) {
    await sendMessage(env, chatId, p, opts);
  }
}
__name(sendLong, "sendLong");
async function ensureCommands(env) {
  if (!env.BOT_KV) return;
  const done = await env.BOT_KV.get("commands_set");
  if (done === VERSION) return;
  await setMyCommands(env, COMMANDS);
  await env.BOT_KV.put("commands_set", VERSION);
}
__name(ensureCommands, "ensureCommands");
async function handleApi(env, request, url) {
  if (url.pathname === "/health") {
    return jsonResponse({ ok: true, ts: Date.now(), version: VERSION });
  }
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
          drop_pending_updates: false
        })
      });
      const data = await res.json();
      return jsonResponse(data);
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  }
  if (url.pathname === "/vk-diag" && request.method === "GET") {
    if (!await apiAuthorized(env, request)) return new Response("Forbidden", { status: 403 });
    try {
      const out = { group_id: env.VK_GROUP_ID || null, album_id: env.VK_ALBUM_ID || null, steps: [] };
      if (!env.VK_TOKEN) return jsonResponse({ ...out, error: "VK_TOKEN \u043D\u0435 \u0437\u0430\u0434\u0430\u043D" });
      const snap = /* @__PURE__ */ __name((n, resp) => `${n}: ${typeof resp === "string" ? resp.slice(0, 220) : JSON.stringify(resp).slice(0, 220)}`, "snap");
      const png1x1 = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 218, 99, 96, 96, 96, 0, 0, 0, 5, 0, 1, 86, 143, 103, 42, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
      try {
        const perms = await vkCall(env, "groups.getTokenPermissions");
        const names = (perms.permissions || []).map((p) => `${p.name}=${p.setting}`);
        const mask = perms.mask != null ? perms.mask : null;
        out.steps.push({ step: -1, ok: true, note: snap("getTokenPermissions", `mask=${mask} perms=${JSON.stringify(names)}`) });
      } catch (e) {
        out.steps.push({ step: -1, ok: false, note: "groups.getTokenPermissions " + e.message });
      }
      try {
        const albums = await vkCall(env, "photos.getAlbums", { owner_id: -env.VK_GROUP_ID, need_system: 1 });
        out.steps.push({ step: 0, ok: true, note: snap("getAlbums", `count=${(albums.items || []).length}`) });
      } catch (e) {
        out.steps.push({ step: 0, ok: false, note: "photos.getAlbums " + e.message });
      }
      try {
        const dws = await vkCall(env, "docs.getWallUploadServer", { group_id: env.VK_GROUP_ID });
        out.steps.push({ step: 0, ok: true, note: snap("docs.getWallUploadServer", `upload_url=${(dws.upload_url || "").slice(0, 70)}...`) });
        if (dws.upload_url) {
          const cardUrl2 = env.OWNER && env.REPO ? `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.png` : null;
          const real2 = cardUrl2 ? await (await fetch(cardUrl2)).arrayBuffer() : null;
          const img = real2 && real2.byteLength > 100 ? new Uint8Array(real2) : png1x1;
          const fd2 = new FormData();
          fd2.append("file", new Blob([img], { type: "image/png" }), "card.png");
          let bodyText = "";
          try {
            const resp = await fetch(dws.upload_url, {
              method: "POST",
              body: fd2,
              headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36", Accept: "*/*" }
            });
            bodyText = await resp.text();
          } catch (e3) {
            bodyText = "fetch ERR " + e3.message;
          }
          let ur = { _html: bodyText.slice(0, 120) };
          try {
            ur = JSON.parse(bodyText);
          } catch (e) {
          }
          out.steps[out.steps.length - 1].note += " | raw=" + JSON.stringify(ur).slice(0, 200);
          if (ur.file) {
            try {
              const saved = await vkCall(env, "docs.save", { file: ur.file });
              const d = saved && saved[0] || saved;
              out.steps[out.steps.length - 1].note += ` | docs.save raw=${JSON.stringify(saved).slice(0, 160)}`;
              if (d && d.id) out.steps[out.steps.length - 1].note += ` | ok => doc${d.owner_id}_${d.id} type=${d.type} ext=${d.ext}`;
            } catch (e2) {
              out.steps[out.steps.length - 1].note += " | docs.save ERR " + e2.message;
            }
          }
        }
      } catch (e) {
        out.steps.push({ step: 0, ok: false, note: "docs.getWallUploadServer " + e.message });
      }
      if (url.searchParams.get("test_post") === "5" && env.VK_GROUP_ID) {
        const docId = url.searchParams.get("doc") || "";
        try {
          const p5 = await vkCall(env, "wall.post", {
            owner_id: -env.VK_GROUP_ID,
            from_group: 1,
            message: `\u0422\u0435\u0441\u0442 doc-\u0444\u043E\u0442\u043E: ${docId}`,
            attachments: `doc-${env.VK_GROUP_ID}_${docId}`
          });
          out.steps.push({ step: 0, ok: true, note: snap("wall.post doc", `post=${p5.post_id} attach=doc-${env.VK_GROUP_ID}_${docId}`) });
        } catch (e) {
          out.steps.push({ step: 0, ok: false, note: "wall.post doc " + e.message });
        }
      }
      if (url.searchParams.get("test_post") === "6" && env.VK_GROUP_ID) {
        const pid = url.searchParams.get("photo") || "";
        try {
          const p6 = await vkCall(env, "wall.post", {
            owner_id: -env.VK_GROUP_ID,
            from_group: 1,
            message: "\u0422\u0435\u0441\u0442 messages-\u0444\u043E\u0442\u043E (\u0440\u0435\u0430\u043B\u044C\u043D\u0430\u044F \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0430)",
            attachments: `photo-${env.VK_GROUP_ID}_${pid}`
          });
          out.steps.push({ step: 0, ok: true, note: snap("wall.post mphoto", `post=${p6.post_id} attach=photo-${env.VK_GROUP_ID}_${pid}`) });
        } catch (e) {
          out.steps.push({ step: 0, ok: false, note: "wall.post mphoto " + e.message });
        }
      }
      try {
        const cp = await vkCall(env, "photos.copy", {
          owner_id: -env.VK_GROUP_ID,
          photo_id: url.searchParams.get("photo") || "",
          access_key: url.searchParams.get("ak") || ""
        });
        out.steps.push({ step: 0, ok: true, note: snap("photos.copy", `copy=${JSON.stringify(cp)}`) });
      } catch (e) {
        out.steps.push({ step: 0, ok: false, note: "photos.copy " + e.message });
      }
      try {
        const dms = await vkCall(env, "docs.getMessagesUploadServer");
        out.steps.push({ step: 0, ok: true, note: snap("docs.getMessagesUploadServer", `upload_url=${(dms.upload_url || "").slice(0, 70)}...`) });
      } catch (e) {
        out.steps.push({ step: 0, ok: false, note: "docs.getMessagesUploadServer " + e.message });
      }
      try {
        const ws = await vkCall(env, "photos.getWallUploadServer", { group_id: env.VK_GROUP_ID });
        out.steps.push({ step: 0, ok: true, note: snap("getWallUploadServer", `upload_url=${(ws.upload_url || "").slice(0, 60)}...`) });
      } catch (e) {
        out.steps.push({ step: 0, ok: false, note: "photos.getWallUploadServer " + e.message });
      }
      try {
        const cardUrl = env.OWNER && env.REPO ? `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.png` : null;
        const real = cardUrl ? await (await fetch(cardUrl)).arrayBuffer() : null;
        const up = await vkCall(env, "photos.getMessagesUploadServer");
        const fd = new FormData();
        const pngBytes = real && real.byteLength > 100 ? new Uint8Array(real) : png1x1;
        fd.append("photo", new Blob([pngBytes], { type: "image/png" }), "photo.png");
        const r = await fetch(up.upload_url, { method: "POST", body: fd });
        const upRes = await r.json();
        const uploadedPhoto = upRes.photo || upRes.files && upRes.files.photo && `${upRes.files.photo.sha}_${upRes.files.photo.secret}` || "";
        out.steps.push({ step: 1, ok: !!uploadedPhoto, bytes: pngBytes.length, note: snap("upload", upRes) });
        if (uploadedPhoto) {
          try {
            const saved = await vkCall(env, "photos.saveMessagesPhoto", { photo: uploadedPhoto, server: upRes.server, hash: upRes.hash });
            const p = saved[0];
            out.steps[out.steps.length - 1].note = snap("saveMessagesPhoto", `photo${p.owner_id}_${p.id} sizes=${(p.sizes || []).length}`);
          } catch (e) {
            out.steps[out.steps.length - 1].note += " | saveMessagesPhoto " + e.message;
          }
        }
      } catch (e) {
        out.steps.push({ step: 1, ok: false, note: "messages-upload " + e.message });
      }
      if (env.OWNER && env.REPO) {
        const cardUrl = `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.png`;
        try {
          out.steps.push({ step: 2, note: "parseAttachedLink probe: " + cardUrl });
          const parsed = await vkCall(env, "wall.parseAttachedLink", { links: cardUrl });
          const l = parsed.links && parsed.links[0];
          out.steps[out.steps.length - 1].ok = !!l;
          out.steps[out.steps.length - 1].has_photo = !!(l && l.photo);
          out.steps[out.steps.length - 1].note = snap("parseAttachedLink", l ? { url: l.url, title: (l.title || "").slice(0, 40), has_photo: !!l.photo } : parsed);
        } catch (e) {
          out.steps.push({ step: 2, ok: false, note: "wall.parseAttachedLink " + e.message });
        }
      }
      out.steps.push({ step: 3, note: `gate test_post=${url.searchParams.get("test_post")} owner=${env.OWNER} repo=${env.REPO} gid=${env.VK_GROUP_ID}` });
      if (url.searchParams.get("test_post") === "1" && env.OWNER && env.REPO && env.VK_GROUP_ID) {
        const githubHtml = `https://${env.OWNER}.github.io/${env.REPO}/data/cards/mmsiscsar155.html`;
        const external = "https://habr.com/ru/articles/";
        for (const [label, link] of [
          ["html-\u0441\u0442\u0440\u0430\u043D\u0438\u0446\u0430 (og:image)", githubHtml],
          ["\u0432\u043D\u0435\u0448\u043D\u044F\u044F \u0441\u0442\u0430\u0442\u044C\u044F (og:image)", external]
        ]) {
          try {
            const p = await vkCall(env, "wall.post", {
              owner_id: -env.VK_GROUP_ID,
              from_group: 1,
              message: `\u0422\u0435\u0441\u0442 \u043F\u0440\u0435\u0432\u044C\u044E: ${label}`,
              attachments: link
            });
            out.steps.push({ step: 3, ok: true, note: snap("wall.post", `${label}: post=${p.post_id} ${link}`) });
          } catch (e) {
            out.steps.push({ step: 3, ok: false, note: `wall.post (${label}): ` + e.message });
          }
        }
      }
      out.steps.push({ step: 4, note: `gate test_post=${url.searchParams.get("test_post")}` });
      if (url.searchParams.get("test_post") === "3" && env.VK_GROUP_ID) {
        const cardUrl = env.OWNER && env.REPO ? `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.png` : null;
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
          out.steps.push({ step: 4, ok: true, note: snap("fresh message-photo", `id=${freshId} sizes=${(ph.sizes || []).length}`) });
          const p = await vkCall(env, "wall.post", {
            owner_id: -env.VK_GROUP_ID,
            from_group: 1,
            message: `\u0421\u0432\u0435\u0436\u0435\u0435 messages-\u0444\u043E\u0442\u043E: ${freshId}`,
            attachments: freshId
          });
          p.post_id && out.steps.push({ step: 4, ok: true, note: snap("wall.post fresh", `post=${p.post_id} attach=${freshId}`) });
        }
      }
      if (url.searchParams.get("test_post") === "7" && env.VK_GROUP_ID) {
        const gid = env.VK_GROUP_ID;
        try {
          const alb = await vkCall(env, "photos.createAlbum", {
            title: "Card-album",
            group_id: gid,
            privacy_view: "all",
            privacy_comment: "all"
          });
          out.steps.push({ step: 7, ok: true, note: snap("createAlbum", `album_id=${alb.id} title=${alb.title}`) });
        } catch (e) {
          out.steps.push({ step: 7, ok: false, note: "photos.createAlbum " + e.message });
        }
        try {
          const cardUrl = env.OWNER && env.REPO ? `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.png` : null;
          const real = cardUrl ? await (await fetch(cardUrl)).arrayBuffer() : new Uint8Array([137, 80, 78, 71]);
          const up = await vkCall(env, "photos.getMessagesUploadServer");
          const fd = new FormData();
          fd.append("photo", new Blob([new Uint8Array(real)], { type: "image/png" }), "card.png");
          const upRes = await (await fetch(up.upload_url, { method: "POST", body: fd })).json();
          const saved = await vkCall(env, "photos.saveMessagesPhoto", { photo: upRes.photo, server: upRes.server, hash: upRes.hash });
          const ph = saved[0];
          const phId = ph.id, phOwner = ph.owner_id;
          out.steps.push({ step: 7, ok: true, note: snap("saveMessagesPhoto#7", `photo${phOwner}_${phId} sizes=${(ph.sizes || []).length}`) });
          try {
            const moved = await vkCall(env, "photos.move", {
              owner_id: phOwner,
              photo_id: phId,
              target_album_id: 0,
              group_id: gid
            });
            out.steps.push({ step: 7, ok: true, note: snap("photos.move", JSON.stringify(moved)) });
            const p = await vkCall(env, "wall.post", {
              owner_id: -gid,
              from_group: 1,
              message: "\u0422\u0435\u0441\u0442 move-\u0444\u043E\u0442\u043E",
              attachments: `photo${phOwner}_${phId}`
            });
            out.steps.push({ step: 7, ok: true, note: snap("wall.post moved", `post=${p.post_id} attach=photo${phOwner}_${phId}`) });
          } catch (e) {
            out.steps.push({ step: 7, ok: false, note: "photos.move " + e.message });
          }
        } catch (e) {
          out.steps.push({ step: 7, ok: false, note: "7-upload " + e.message });
        }
      }
      if (url.searchParams.get("test_post") === "13" && env.OWNER && env.REPO && env.VK_GROUP_ID) {
        const pngUrl = `https://${env.OWNER}.github.io/${env.REPO}/data/cards/mmsiscsar155.png`;
        try {
          const p = await vkCall(env, "wall.post", {
            owner_id: -env.VK_GROUP_ID,
            from_group: 1,
            message: "\u0422\u0435\u0441\u0442 \u043F\u0440\u044F\u043C\u043E\u0439 PNG-\u0441\u0441\u044B\u043B\u043A\u0438",
            attachments: pngUrl
          });
          out.steps.push({ step: 13, ok: true, note: snap("wall.post png-link", `post=${p.post_id} ${pngUrl}`) });
        } catch (e) {
          out.steps.push({ step: 13, ok: false, note: "wall.post png-link " + e.message });
        }
      }
      if (url.searchParams.get("test_post") === "14" && env.OWNER && env.REPO && env.VK_GROUP_ID) {
        const pngUrl = `https://${env.OWNER}.github.io/${env.REPO}/data/cards/mmsiscsar155.png`;
        try {
          const p = await vkCall(env, "wall.post", {
            owner_id: -env.VK_GROUP_ID,
            from_group: 1,
            message: "\u0422\u0435\u0441\u0442 PNG-\u0441\u0441\u044B\u043B\u043A\u0438 \u0432 \u0442\u0435\u043A\u0441\u0442\u0435 " + pngUrl
          });
          out.steps.push({ step: 14, ok: true, note: snap("wall.post text-link", `post=${p.post_id} ${pngUrl}`) });
        } catch (e) {
          out.steps.push({ step: 14, ok: false, note: "wall.post text-link " + e.message });
        }
      }
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
          out.steps.push({ step: 15, ok: true, note: snap("save#15", `photo=${ph.id} owner=${ph.owner_id} album=${aid} ak=${ak} sizes=${(ph.sizes || []).length}`) });
          const forms = [
            `photo${ph.owner_id}_${ph.id}`,
            ak ? `photo${ph.owner_id}_${ph.id}_${ak}` : null
          ].filter(Boolean);
          for (const attach of forms) {
            try {
              const p = await vkCall(env, "wall.post", {
                owner_id: -env.VK_GROUP_ID,
                from_group: 1,
                message: "\u0422\u0435\u0441\u0442 access_key",
                attachments: attach
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
            photo: upRes.photo || "",
            server: upRes.server || "",
            hash: upRes.hash || ""
          });
          const ph = saved.photo || saved;
          out.steps.push({ step: 16, ok: true, note: snap("saveOwnerPhoto", `id=${ph.id} owner=${ph.owner_id} ak=${ph.access_key || ""}`) });
          const attach = `photo${ph.owner_id}_${ph.id}` + (ph.access_key ? `_${ph.access_key}` : "");
          const p = await vkCall(env, "wall.post", {
            owner_id: -env.VK_GROUP_ID,
            from_group: 1,
            message: "\u0422\u0435\u0441\u0442 \u0444\u043E\u0442\u043E-\u0430\u0432\u0430\u0442\u0430\u0440",
            attachments: attach
          });
          out.steps.push({ step: 16, ok: true, note: snap("wall.post#16", `post=${p.post_id} attach=${attach}`) });
        } catch (e) {
          out.steps.push({ step: 16, ok: false, note: "16 " + e.message });
        }
      }
      if (url.searchParams.get("test_post") === "17" && env.OWNER && env.REPO && env.VK_GROUP_ID) {
        const gid = env.VK_GROUP_ID;
        try {
          const cardUrl = `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.png`;
          const real = await (await fetch(cardUrl)).arrayBuffer();
          let catId = "0";
          try {
            const cats = await vkCall(env, "market.getCategories", { count: 1, extended: 1 });
            const c = cats.categories && cats.categories[0];
            catId = String(c && (c.id || c.category && c.category.id) || 0);
            out.steps.push({ step: 17, ok: true, note: snap("market.getCategories", `first=${catId}`) });
          } catch (e) {
            out.steps.push({ step: 17, ok: false, note: "market.getCategories " + e.message });
          }
          const ups = await vkCall(env, "photos.getMarketUploadServer", { group_id: gid, main_photo: 1 });
          const fd = new FormData();
          fd.append("file", new Blob([new Uint8Array(real)], { type: "image/png" }), "card.png");
          const upRes = await (await fetch(ups.upload_url, { method: "POST", body: fd })).json();
          out.steps.push({ step: 17, ok: true, note: snap("market upload", upRes) });
          const saved = await vkCall(env, "photos.saveMarketPhoto", {
            group_id: gid,
            photo: upRes.photo,
            server: upRes.server,
            hash: upRes.hash
          });
          const mp = saved[0];
          out.steps.push({ step: 17, ok: true, note: snap("saveMarketPhoto", `id=${mp.id} owner=${mp.owner_id}`) });
          const item = await vkCall(env, "market.add", {
            owner_id: -gid,
            name: "TrustNode Card",
            description: "\u0422\u0435\u0441\u0442\u043E\u0432\u0430\u044F \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0430",
            category_id: catId,
            price: 100,
            main_photo_id: mp.id
          });
          out.steps.push({ step: 17, ok: true, note: snap("market.add", `item=${item.id}`) });
          const p = await vkCall(env, "wall.post", {
            owner_id: -gid,
            from_group: 1,
            message: "\u0422\u0435\u0441\u0442 market-\u0444\u043E\u0442\u043E",
            attachments: `market-${gid}_${item.id}`
          });
          out.steps.push({ step: 17, ok: true, note: snap("wall.post#17", `post=${p.post_id} attach=market-${gid}_${item.id}`) });
        } catch (e) {
          out.steps.push({ step: 17, ok: false, note: "17 " + e.message });
        }
      }
      if (url.searchParams.get("test_post") === "18" && env.OWNER && env.REPO && env.VK_GROUP_ID) {
        const gifUrl = `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.gif`;
        try {
          const gifBytes = new Uint8Array(await (await fetch(gifUrl)).arrayBuffer());
          const dws = await vkCall(env, "docs.getWallUploadServer", { group_id: env.VK_GROUP_ID });
          const fd = new FormData();
          fd.append("file", new Blob([gifBytes], { type: "image/gif" }), "card.gif");
          let bodyText = "";
          const resp = await fetch(dws.upload_url, {
            method: "POST",
            body: fd,
            headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36", Accept: "*/*" }
          });
          bodyText = await resp.text();
          let ur = { _html: bodyText.slice(0, 120) };
          try {
            ur = JSON.parse(bodyText);
          } catch (e) {
          }
          out.steps.push({ step: 18, ok: !!ur.file, note: snap("gif upload", ur) });
          if (ur.file) {
            const saved = await vkCall(env, "docs.save", { file: ur.file });
            const raw = JSON.stringify(saved);
            let d = null;
            try {
              const arr = Array.isArray(saved) ? saved : [saved];
              const wrap = arr[0];
              d = wrap && (wrap.doc || wrap) || null;
            } catch (e) {
            }
            out.steps.push({ step: 18, ok: !!d, note: snap("docs.save gif", d ? `doc${d.owner_id}_${d.id} type=${d.type} ext=${d.ext}` : "RAW=" + raw.slice(0, 220)) });
            const p = await vkCall(env, "wall.post", {
              owner_id: -env.VK_GROUP_ID,
              from_group: 1,
              message: "\u0422\u0435\u0441\u0442 GIF-\u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u0430",
              attachments: `doc${d.owner_id}_${d.id}`
            });
            out.steps.push({ step: 18, ok: true, note: snap("wall.post#18", `post=${p.post_id} attach=doc${d.owner_id}_${d.id}`) });
          }
        } catch (e) {
          out.steps.push({ step: 18, ok: false, note: "18 " + e.message });
        }
      }
      if (url.searchParams.get("test_post") === "19") {
        const { publishToVk: publishToVk2 } = await Promise.resolve().then(() => (init_telegram(), telegram_exports));
        const cardUrl = env.OWNER && env.REPO ? `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.png` : null;
        try {
          const real = cardUrl ? await (await fetch(cardUrl)).arrayBuffer() : null;
          if (!real) throw new Error("\u043D\u0435\u0442 \u0442\u0435\u0441\u0442\u043E\u0432\u043E\u0439 PNG-\u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0438");
          const pkg = {
            id: "diag19-" + Date.now(),
            guid: "diag19-" + Date.now(),
            title: "TrustNode",
            caption: "\u0422\u0435\u0441\u0442 end-to-end GIF-\u0434\u043E\u043A\u0443\u043C\u0435\u043D\u0442\u0430",
            png: new Uint8Array(real),
            png_key: null,
            link: ""
          };
          const res = await publishToVk2(env, pkg, false);
          out.steps.push({ step: 19, ok: true, note: snap("publishToVk e2e", `post=${res.post_id} attach=${res.vk_attachment}`) });
        } catch (e) {
          out.steps.push({ step: 19, ok: false, note: "19 " + e.message });
        }
      }
      if (url.searchParams.get("test_post") === "20" && env.OWNER && env.REPO && env.VK_GROUP_ID) {
        const { pngToGif: pngToGif2 } = await Promise.resolve().then(() => (init_cardgen(), cardgen_exports));
        const cardUrl = `https://raw.githubusercontent.com/${env.OWNER}/${env.REPO}/main/data/cards/mmsiscsar155.png`;
        try {
          const png = new Uint8Array(await (await fetch(cardUrl)).arrayBuffer());
          const gifBytes = await pngToGif2(png);
          out.steps.push({ step: 20, ok: true, note: `pngToGif: ${png.length} -> ${gifBytes.length} \u0431\u0430\u0439\u0442, magic=${gifBytes[0]}${gifBytes[1]}${gifBytes[2]}${gifBytes[3]}${gifBytes[4]}${gifBytes[5]}` });
          const dws = await vkCall(env, "docs.getWallUploadServer", { group_id: env.VK_GROUP_ID });
          const fd = new FormData();
          fd.append("file", new Blob([gifBytes], { type: "image/gif" }), "card.gif");
          let bodyText = "";
          try {
            const resp = await fetch(dws.upload_url, {
              method: "POST",
              body: fd,
              headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36", Accept: "*/*" }
            });
            bodyText = await resp.text();
          } catch (e) {
            bodyText = "fetch ERR " + e.message;
          }
          let ur = { _html: bodyText.slice(0, 200) };
          try {
            ur = JSON.parse(bodyText);
          } catch (e) {
          }
          out.steps.push({ step: 20, ok: !!ur.file, note: snap("conv gif upload", ur) });
          if (ur.file) {
            const saved = await vkCall(env, "docs.save", { file: ur.file });
            const wrap = Array.isArray(saved) ? saved[0] : saved;
            const d = wrap && (wrap.doc || wrap) || null;
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
  if (url.pathname === "/tick" && request.method === "POST") {
    if (!await apiAuthorized(env, request)) return new Response("Forbidden", { status: 403 });
    try {
      await tick(env);
      return jsonResponse({ ok: true });
    } catch (e) {
      return jsonResponse({ ok: false, error: e.message }, 500);
    }
  }
  if (url.pathname === "/debug") {
    if (!await apiAuthorized(env, request)) return new Response("Forbidden", { status: 403 });
    const state = await loadState(env);
    const stock = await getStock(env);
    const cands = await getCandidates(env);
    const drafts = await listDrafts(env);
    const log = await getLog(env);
    return jsonResponse({
      state: {
        dry_run: !!state.dry_run,
        autopost: await getAutopost(env),
        scan_chunk: state.meta?.scan_chunk ?? 0
      },
      stock: stock.length,
      candidates: cands.length,
      drafts: drafts.length,
      log: log.length,
      seen_guids: state.seen_guids?.length || 0
    });
  }
  if (url.pathname === "/diag-channel" && request.method === "GET") {
    if (!await apiAuthorized(env, request)) return new Response("Forbidden", { status: 403 });
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
  if (url.pathname.startsWith("/files/")) {
    const key = "files/" + url.pathname.slice("/files/".length);
    if (request.method === "PUT") {
      if (!await apiAuthorized(env, request)) return new Response("Forbidden", { status: 403 });
      const ct = request.headers.get("Content-Type") || "application/octet-stream";
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (env.BOT_R2) {
        await env.BOT_R2.put(key, bytes, { httpMetadata: { contentType: ct } });
      } else if (env.BOT_KV) {
        await env.BOT_KV.put(key, bytesToBase644(bytes));
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
        if (key.endsWith(".png")) ct = "image/png";
      } else {
        return new Response("No storage configured", { status: 500 });
      }
      return new Response(body, {
        headers: { "Content-Type": ct, "Cache-Control": "public, max-age=3600" }
      });
    }
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (url.pathname === "/kv") {
    if (!await apiAuthorized(env, request)) return new Response("Forbidden", { status: 403 });
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
__name(handleApi, "handleApi");
function decodePng2(b64) {
  if (!b64) return null;
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
__name(decodePng2, "decodePng");
async function approveDraft(env, draft, dry, target = "all") {
  await publishPackage(
    env,
    {
      id: draft.id,
      kind: draft.kind || "news",
      title: draft.title || "",
      caption: draft.caption || "",
      png_key: draft.png_key || null,
      png: decodePng2(draft.png) || null,
      link: draft.link || "",
      guid: draft.guid || "",
      source: draft.source || "",
      tags: draft.tags || []
    },
    dry,
    target
  );
  await deleteDraft(env, draft.id);
  try {
    await editMessageReplyMarkup(
      env,
      draft.admin_chat_id || env.TELEGRAM_ADMIN_CHAT_ID,
      draft.preview_message_id,
      []
    );
  } catch (e) {
  }
}
__name(approveDraft, "approveDraft");
async function handleCallback(env, cq, state) {
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : null;
  const msgId = cq.message ? cq.message.message_id : null;
  const qid = cq.id;
  const data = cq.data || "";
  const segs = data.split(":");
  const action = segs[0];
  const draftId = segs[1] || "";
  const target = segs[2] || "all";
  if (action === "user") {
    await handleUserCallback(env, cq);
    return;
  }
  if (action === "sugg") {
    if (!isAdmin(env, chatId)) {
      try {
        await answerCallbackQuery(env, qid, "\u041D\u0435\u0442 \u0434\u043E\u0441\u0442\u0443\u043F\u0430");
      } catch (e) {
      }
      return;
    }
    await handleSuggestionCallback(env, cq);
    return;
  }
  if (!isAdmin(env, chatId)) {
    try {
      await answerCallbackQuery(env, qid, "\u041D\u0435\u0442 \u0434\u043E\u0441\u0442\u0443\u043F\u0430");
    } catch (e) {
    }
    return;
  }
  const dry = !!state.dry_run;
  if (action === "approve" && draftId) {
    const draft = await loadDraft(env, draftId);
    if (!draft) {
      try {
        await answerCallbackQuery(env, qid, "\u0427\u0435\u0440\u043D\u043E\u0432\u0438\u043A \u0443\u0436\u0435 \u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0430\u043D");
      } catch (e) {
      }
      return;
    }
    try {
      await approveDraft(env, draft, dry, target);
      const label = target === "vk" ? "\u0432 VK" : target === "tg" ? "\u0432 TG" : "\u0432 VK \u0438 TG";
      await answerCallbackQuery(env, qid, `\u2705 \u041E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u043D\u043E ${label}`);
    } catch (e) {
      try {
        await answerCallbackQuery(env, qid, `\u041E\u0448\u0438\u0431\u043A\u0430: ${e.message.slice(0, 90)}`);
      } catch (e2) {
      }
      try {
        await sendMessage(
          env,
          env.TELEGRAM_ADMIN_CHAT_ID,
          `\u26A0\uFE0F \u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C \xAB${escHtml(draft.title || "")}\xBB: ${escHtml(e.message)}`
        );
      } catch (e2) {
      }
    }
    return;
  }
  if (action === "cancel" && draftId) {
    await deleteDraft(env, draftId);
    try {
      await editMessageReplyMarkup(env, chatId, msgId, []);
    } catch (e) {
    }
    try {
      await answerCallbackQuery(env, qid, "\u0427\u0435\u0440\u043D\u043E\u0432\u0438\u043A \u043E\u0442\u043C\u0435\u043D\u0451\u043D");
    } catch (e) {
    }
    return;
  }
  if (action === "redo" && draftId) {
    const draft = await loadDraft(env, draftId);
    if (!draft) {
      try {
        await answerCallbackQuery(env, qid, "\u0427\u0435\u0440\u043D\u043E\u0432\u0438\u043A \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D");
      } catch (e) {
      }
      return;
    }
    try {
      await answerCallbackQuery(env, qid, "\u{1F528} \u041F\u0435\u0440\u0435\u0434\u0435\u043B\u044B\u0432\u0430\u044E\u2026");
    } catch (e) {
    }
    if (draft.kind === "generated") {
      const text = draft.raw_text || draft.caption || "";
      await deleteDraft(env, draft.id);
      if (!text) {
        try {
          await sendMessage(env, env.TELEGRAM_ADMIN_CHAT_ID, "\u041D\u0435\u0442 \u0438\u0441\u0445\u043E\u0434\u043D\u043E\u0433\u043E \u0442\u0435\u043A\u0441\u0442\u0430 \u0434\u043B\u044F \u043F\u0435\u0440\u0435\u0434\u0435\u043B\u043A\u0438.");
        } catch (e2) {
        }
        return;
      }
      try {
        await sendGeneratedPreview(env, env.TELEGRAM_ADMIN_CHAT_ID, text, {
          link: draft.link || "",
          source: draft.source || "",
          provider: draft.provider || void 0
        });
      } catch (e) {
        try {
          await sendMessage(env, env.TELEGRAM_ADMIN_CHAT_ID, `\u26A0\uFE0F \u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0435\u0440\u0435\u0433\u0435\u043D\u0435\u0440\u0438\u0440\u043E\u0432\u0430\u0442\u044C: ${escHtml(e.message)}`);
        } catch (e2) {
        }
      }
      return;
    }
    if (draft.kind === "digest") {
      const res = await rebuildDigestPreview(env, draft);
      if (!res.ok) {
        try {
          await sendMessage(
            env,
            env.TELEGRAM_ADMIN_CHAT_ID,
            `\u26A0\uFE0F \u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u0435\u0440\u0435\u0441\u043E\u0431\u0440\u0430\u0442\u044C \u0434\u0430\u0439\u0434\u0436\u0435\u0441\u0442: ${escHtml(res.reason || "\u043E\u0448\u0438\u0431\u043A\u0430")}`
          );
        } catch (e2) {
        }
      } else {
        try {
          await editMessageReplyMarkup(
            env,
            draft.admin_chat_id || env.TELEGRAM_ADMIN_CHAT_ID,
            draft.preview_message_id,
            []
          );
        } catch (e2) {
        }
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
      chat_id: env.TELEGRAM_ADMIN_CHAT_ID
    });
    if (!ok) {
      try {
        await sendMessage(
          env,
          env.TELEGRAM_ADMIN_CHAT_ID,
          "\u26A0\uFE0F GitHub \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u0435\u043D \u2014 \u043F\u0435\u0440\u0435\u0441\u043E\u0437\u0434\u0430\u0442\u044C \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0443 \u043D\u0435 \u0441\u043C\u043E\u0433. \u0427\u0435\u0440\u043D\u043E\u0432\u0438\u043A \u043E\u0441\u0442\u0430\u0432\u043B\u0435\u043D \u043D\u0430 \u043E\u0434\u043E\u0431\u0440\u0435\u043D\u0438\u0438."
        );
      } catch (e) {
      }
      return;
    }
    await deleteDraft(env, draft.id);
    try {
      await editMessageReplyMarkup(
        env,
        draft.admin_chat_id || env.TELEGRAM_ADMIN_CHAT_ID,
        draft.preview_message_id,
        []
      );
    } catch (e) {
    }
    return;
  }
  try {
    await answerCallbackQuery(env, qid, "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043A\u043D\u043E\u043F\u043A\u0430");
  } catch (e) {
  }
}
__name(handleCallback, "handleCallback");
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
        reply_markup: MAIN_KB
      });
      break;
    case "/help":
      await sendMessage(env, chatId, HELP_TEXT, {
        parse_mode: "HTML",
        reply_markup: MAIN_KB
      });
      break;
    case "/status": {
      const config = await loadSources(env);
      const stock = await getStock(env);
      const cands = await getCandidates(env);
      const drafts = await listDrafts(env);
      const log = await getLog(env);
      const last = log[0];
      const lastLine = last ? `${escHtml(last.title || "")} \u2014 ${fmtTime(last.published_at)}` : "\u2014";
      const msk = mskNow();
      const today = log.filter((e) => {
        const t = new Date(e.published_at);
        return !Number.isNaN(t.getTime()) && mskNow(t).date === msk.date;
      }).length;
      const next = await nextFreeSlot(env);
      const stockLines = stock.length ? "\n" + stock.slice(0, 5).map((p) => `   \u2022 ${escHtml(p.title || p.id)} \u2192 ${fmtTime(new Date(p.scheduled_for || Date.now()).toISOString())}`).join("\n") + (stock.length > 5 ? `
   \u2026 \u0438 \u0435\u0449\u0451 ${stock.length - 5}` : "") : "";
      const msg = `\u{1F4CA} <b>\u0421\u0442\u0430\u0442\u0443\u0441 \u0441\u0442\u0443\u0434\u0438\u0438</b>

\u0420\u0435\u0436\u0438\u043C: <b>${dry ? "dry-run" : "\u0431\u043E\u0435\u0432\u043E\u0439"}</b>
\u0410\u0432\u0442\u043E\u043F\u043E\u0441\u0442\u0438\u043D\u0433: <b>${await getAutopost(env) ? "\u0432\u043A\u043B" : "\u0432\u044B\u043A\u043B"}</b>
\u0418\u0441\u0442\u043E\u0447\u043D\u0438\u043A\u043E\u0432: <b>${config.feeds?.length || 0}</b>, \u043A\u043B\u044E\u0447\u0435\u0432\u044B\u0445 \u0441\u043B\u043E\u0432: <b>${config.keywords?.length || 0}</b>
\u0421\u043A\u043B\u0430\u0434: <b>${stock.length}</b>, \u043A\u0430\u043D\u0434\u0438\u0434\u0430\u0442\u043E\u0432: <b>${cands.length}</b>, \u0447\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u043E\u0432: <b>${drafts.length}</b>
\u041E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u043D\u043E \u0432\u0441\u0435\u0433\u043E: <b>${log.length}</b>, \u0441\u0435\u0433\u043E\u0434\u043D\u044F: <b>${today}</b>
\u0421\u043B\u0435\u0434\u0443\u044E\u0449\u0438\u0439 \u0441\u043B\u043E\u0442: <b>${fmtTime(new Date(next).toISOString())}</b>
` + (stockLines ? `\u041D\u0430 \u0441\u043A\u043B\u0430\u0434\u0435:${stockLines}` : "") + `\u041F\u043E\u0441\u043B\u0435\u0434\u043D\u0438\u0439 \u043F\u043E\u0441\u0442: ${lastLine}

\u{1F6E1}\uFE0F TrustNode`;
      await sendMessage(env, chatId, msg, { parse_mode: "HTML" });
      break;
    }
    case "/sources": {
      const config = await loadSources(env);
      const feeds = (config.feeds || []).map((f) => `\u2022 ${escHtml(f)}`).join("\n") || "\u2014";
      const kw = escHtml((config.keywords || []).join(", ") || "\u2014");
      const msg = "\u{1F4E1} <b>\u0418\u0441\u0442\u043E\u0447\u043D\u0438\u043A\u0438</b>\n\n" + feeds + "\n\n\u{1F511} <b>\u041A\u043B\u044E\u0447\u0435\u0432\u044B\u0435 \u0441\u043B\u043E\u0432\u0430:</b>\n" + kw;
      await sendLong(env, chatId, msg, { parse_mode: "HTML" });
      break;
    }
    case "/schedule": {
      const wins = NEWS_WINDOWS.map(
        (w) => `\u2022 <b>${w.label}</b> \u2014 ${minutesToClock(w.start)} \u041C\u0421\u041A: \u0441\u0432\u043E\u0434\u043A\u0430 ${DIGEST_MIN_ITEMS}\u2013${DIGEST_MAX_ITEMS} \u0441\u0432\u0435\u0436\u0438\u0445 \u043D\u043E\u0432\u043E\u0441\u0442\u0435\u0439`
      ).join("\n");
      const msg = "\u{1F5D3} <b>\u0420\u0430\u0441\u043F\u0438\u0441\u0430\u043D\u0438\u0435 (\u041C\u0421\u041A)</b>\n\n\u0422\u0440\u0438 \u0434\u0430\u0439\u0434\u0436\u0435\u0441\u0442\u0430 \u0432 \u0434\u0435\u043D\u044C \u2014 \u043F\u043E \u043E\u0434\u043D\u043E\u043C\u0443 \u0432\u044B\u043F\u0443\u0441\u043A\u0443 \u0432 \u043E\u043A\u043D\u0435:\n" + wins + "\n\n\u{1F6A8} \u0410\u0432\u0442\u043E\u043F\u043E\u0441\u0442\u0438\u043D\u0433 \u0432\u043A\u043B \u2014 \u0432\u044B\u043F\u0443\u0441\u043A\u0438 \u0432\u044B\u0445\u043E\u0434\u044F\u0442 \u0441\u0430\u043C\u0438.\n\u{1F6AB} \u0412\u044B\u043A\u043B \u2014 \u0441\u0432\u043E\u0434\u043A\u0430 \u043F\u0440\u0438\u0445\u043E\u0434\u0438\u0442 \u0430\u0434\u043C\u0438\u043D\u0443 \u043D\u0430 \u043E\u0434\u043E\u0431\u0440\u0435\u043D\u0438\u0435.\n\n\u{1F3AA} \u0418\u0432\u0435\u043D\u0442\u044B \u043F\u0443\u0431\u043B\u0438\u043A\u0443\u044E\u0442\u0441\u044F \u0432 \u0437\u0430\u0434\u0430\u043D\u043D\u043E\u0435 \u0432\u0440\u0435\u043C\u044F.";
      await sendMessage(env, chatId, msg, { parse_mode: "HTML" });
      break;
    }
    case "/draft": {
      if (!args) {
        await sendMessage(env, chatId, "\u0424\u043E\u0440\u043C\u0430\u0442: /draft &lt;\u0442\u0435\u043A\u0441\u0442 \u043D\u043E\u0432\u043E\u0441\u0442\u0438&gt;");
        break;
      }
      await handleManualText(env, chatId, args, state);
      break;
    }
    case "/skip": {
      const cands = await getCandidates(env);
      const target = args ? cands.find((c) => c.guid === args) : cands[0];
      if (!target) {
        await sendMessage(env, chatId, "\u041A\u0430\u043D\u0434\u0438\u0434\u0430\u0442\u043E\u0432 \u043D\u0430 \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043A\u0443 \u043D\u0435\u0442.");
        break;
      }
      await setCandidates(env, cands.filter((c) => c.guid !== target.guid));
      await sendMessage(env, chatId, `\u23ED \u041F\u0440\u043E\u043F\u0443\u0449\u0435\u043D: ${escHtml(target.title || target.guid)}`);
      break;
    }
    case "/event": {
      await startEventDialog(env, chatId);
      break;
    }
    case "/stats": {
      const log = await getLog(env);
      const msk = mskNow();
      const today = log.filter((e) => {
        const t = new Date(e.published_at);
        return !Number.isNaN(t.getTime()) && mskNow(t).date === msk.date;
      }).length;
      const byKind = {};
      for (const e of log) byKind[e.kind || "news"] = (byKind[e.kind || "news"] || 0) + 1;
      const lines = Object.entries(byKind).map(([k, v]) => `\u2022 ${k}: ${v}`).join("\n");
      const msg = `\u{1F4C8} <b>\u0421\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043A\u0430</b>

\u0412\u0441\u0435\u0433\u043E: <b>${log.length}</b>
\u0421\u0435\u0433\u043E\u0434\u043D\u044F: <b>${today}</b>

${lines || "\u2014"}`;
      await sendMessage(env, chatId, msg, { parse_mode: "HTML" });
      break;
    }
    case "/blacklist": {
      const bl = state.blacklist || { sources: [], keywords: [], guids: [] };
      const m = args.match(/^(add|del|remove)\s+(source|src|keyword|kw|guid)\s+(.+)$/i);
      if (!m) {
        const src = bl.sources.join(", ") || "\u2014";
        const kwL = bl.keywords.join(", ") || "\u2014";
        const g = bl.guids.join(", ") || "\u2014";
        await sendMessage(
          env,
          chatId,
          `\u{1F6AB} <b>\u0427\u0451\u0440\u043D\u044B\u0439 \u0441\u043F\u0438\u0441\u043E\u043A</b>

\u0418\u0441\u0442\u043E\u0447\u043D\u0438\u043A\u0438: ${escHtml(src)}
\u041A\u043B\u044E\u0447\u0435\u0432\u044B\u0435 \u0441\u043B\u043E\u0432\u0430: ${escHtml(kwL)}
GUID: ${escHtml(g)}

\u0424\u043E\u0440\u043C\u0430\u0442: /blacklist add|del kw|src|guid &lt;\u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435&gt;`,
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
      await saveState(env, state);
      await sendMessage(env, chatId, `\u2705 ${add ? "\u0414\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u043E" : "\u0423\u0434\u0430\u043B\u0435\u043D\u043E"} \u0438\u0437 \u0447\u0451\u0440\u043D\u043E\u0433\u043E \u0441\u043F\u0438\u0441\u043A\u0430: ${escHtml(value)}`);
      break;
    }
    case "/keyword": {
      const config = await loadSources(env);
      const m = args.match(/^(add|remove|del)\s+(.+)$/i);
      if (!m) {
        const kw = (config.keywords || []).join(", ") || "\u2014";
        await sendMessage(env, chatId, `\u{1F511} <b>\u041A\u043B\u044E\u0447\u0435\u0432\u044B\u0435 \u0441\u043B\u043E\u0432\u0430:</b>
${escHtml(kw)}`, {
          parse_mode: "HTML"
        });
        break;
      }
      const add = m[1].toLowerCase() === "add";
      const value = m[2].trim();
      if (add) state.extra_keywords = toggle(state.extra_keywords, value, true);
      else state.removed_keywords = toggle(state.removed_keywords, value, true);
      await saveState(env, state);
      await sendMessage(env, chatId, `\u2705 ${add ? "\u0414\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u043E" : "\u0423\u0434\u0430\u043B\u0435\u043D\u043E"} \u0441\u043B\u043E\u0432\u043E: ${escHtml(value)}`);
      break;
    }
    case "/settings": {
      const extra = state.extra_keywords?.length || 0;
      const removed = state.removed_keywords?.length || 0;
      const fmt = await getCardFormat(env);
      const fmtLabel = fmt === "gif" ? "GIF (\u0430\u043D\u0438\u043C\u0430\u0446\u0438\u044F \u043D\u0435\u0431\u0430)" : fmt === "png" ? "PNG (\u0441\u0442\u0430\u0442\u0438\u043A)" : "auto (GIF \u043F\u0440\u0438 \u043D\u0430\u043B\u0438\u0447\u0438\u0438 \u0440\u0435\u043D\u0434\u0435\u0440\u0430)";
      const msg = `\u2699\uFE0F <b>\u041D\u0430\u0441\u0442\u0440\u043E\u0439\u043A\u0438</b>

\u0420\u0435\u0436\u0438\u043C: <b>${dry ? "dry-run" : "\u0431\u043E\u0435\u0432\u043E\u0439"}</b>
\u0410\u0432\u0442\u043E\u043F\u043E\u0441\u0442\u0438\u043D\u0433: <b>${await getAutopost(env) ? "\u0432\u043A\u043B" : "\u0432\u044B\u043A\u043B"}</b>
\u0424\u043E\u0440\u043C\u0430\u0442 \u043A\u0430\u0440\u0442\u043E\u0447\u0435\u043A: <b>${fmtLabel}</b> (\u0441\u043C\u0435\u043D\u0438\u0442\u044C: /cardfmt gif|png|auto)
\u041A\u043B\u044E\u0447\u0435\u0432\u044B\u0435 \u0441\u043B\u043E\u0432\u0430: +${extra} \u0434\u043E\u0431\u0430\u0432\u043B\u0435\u043D\u043E, \u2212${removed} \u0443\u0431\u0440\u0430\u043D\u043E
\u041E\u043A\u043D\u0430 (\u041C\u0421\u041A): ${NEWS_WINDOWS.map((w) => `${minutesToClock(w.start)}\u2013${minutesToClock(w.end)}`).join(", ")}`;
      await sendMessage(env, chatId, msg, { parse_mode: "HTML" });
      break;
    }
    case "/cardfmt": {
      const next = args && ["gif", "png", "auto"].includes(args.trim().toLowerCase()) ? args.trim().toLowerCase() : null;
      if (!next) {
        await sendMessage(env, chatId, "\u0424\u043E\u0440\u043C\u0430\u0442: /cardfmt gif | png | auto");
        break;
      }
      await setCardFormat(env, next);
      const label = next === "gif" ? "GIF (\u0430\u043D\u0438\u043C\u0430\u0446\u0438\u044F \u043D\u0435\u0431\u0430)" : next === "png" ? "PNG (\u0441\u0442\u0430\u0442\u0438\u043A)" : "auto (GIF \u043F\u0440\u0438 \u043D\u0430\u043B\u0438\u0447\u0438\u0438 \u0440\u0435\u043D\u0434\u0435\u0440\u0430)";
      await sendMessage(env, chatId, `\u2705 \u0424\u043E\u0440\u043C\u0430\u0442 \u043A\u0430\u0440\u0442\u043E\u0447\u0435\u043A: <b>${label}</b>`, { parse_mode: "HTML" });
      break;
    }
    case "/dryrun": {
      state.dry_run = args ? args === "on" : !state.dry_run;
      await saveState(env, state);
      await sendMessage(env, chatId, `\u2705 Dry-run ${state.dry_run ? "\u0432\u043A\u043B\u044E\u0447\u0451\u043D" : "\u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D"}`);
      break;
    }
    case "/autopost": {
      const on = args ? args === "on" : !await getAutopost(env);
      state.autopost = on;
      await saveState(env, state);
      await setAutopost(env, on);
      await sendMessage(env, chatId, `\u2705 \u0410\u0432\u0442\u043E\u043F\u043E\u0441\u0442\u0438\u043D\u0433 ${on ? "\u0432\u043A\u043B\u044E\u0447\u0451\u043D" : "\u0432\u044B\u043A\u043B\u044E\u0447\u0435\u043D"}`);
      break;
    }
    case "/publish":
    case "/puball":
    case "/pubvk":
    case "/pubtg": {
      const stock = await getStock(env);
      let pkg = null;
      if (args) pkg = stock.find((p) => p.id === args || p.guid === args);
      else pkg = stock[0];
      if (!pkg) {
        await sendMessage(env, chatId, args ? "\u041F\u043E\u0441\u0442 \u043D\u0435 \u043D\u0430\u0439\u0434\u0435\u043D \u043D\u0430 \u0441\u043A\u043B\u0430\u0434\u0435." : "\u0421\u043A\u043B\u0430\u0434 \u043F\u0443\u0441\u0442.");
        break;
      }
      const tgt = cmd === "/pubvk" ? "vk" : cmd === "/pubtg" ? "tg" : "all";
      const tgtLabel = tgt === "vk" ? "\u2192 VK" : tgt === "tg" ? "\u2192 TG" : "\u2192 VK+TG";
      await removeStock(env, pkg.id);
      try {
        await publishPackage(env, { ...pkg, scheduled_for: Date.now() }, dry, tgt);
        await sendMessage(env, chatId, `\u2705 \u041E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u043D\u043E${dry ? " (dry-run)" : ""} ${tgtLabel}: ${escHtml(pkg.title || "")}`);
      } catch (e) {
        await addStock(env, pkg);
        await sendMessage(env, chatId, `\u26A0\uFE0F \u041E\u0448\u0438\u0431\u043A\u0430: ${escHtml(e.message)}`);
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
          `\u0424\u043E\u0440\u043C\u0430\u0442: ${cmd} &lt;\u0442\u0435\u043A\u0441\u0442 \u043D\u043E\u0432\u043E\u0441\u0442\u0438&gt;
\u0421\u043E\u0437\u0434\u0430\u043C \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0443 \u0431\u0435\u0437 \u0441\u043E\u0445\u0440\u0430\u043D\u0435\u043D\u0438\u044F \u0442\u0435\u043A\u0441\u0442\u0430 \u0432 \u0438\u0441\u0442\u043E\u0440\u0438\u0438. \u041F\u0440\u043E\u0432\u0430\u0439\u0434\u0435\u0440: <b>${prov}</b>.`,
          { parse_mode: "HTML" }
        );
        break;
      }
      const label = prov === "gemini" ? "\u2728 Gemini" : prov === "gigachat" ? "\u{1F9E0} GigaChat" : "\u{1F4DD} \u043F\u043E \u043F\u0440\u0430\u0432\u0438\u043B\u0430\u043C";
      try {
        await sendGeneratedPreview(env, chatId, args, { provider: prov });
        await sendMessage(
          env,
          chatId,
          `\u{1F528} <b>\u041A\u0430\u0440\u0442\u043E\u0447\u043A\u0430 \u0433\u043E\u0442\u043E\u0432\u0430</b> (${label}). \u041A\u043D\u043E\u043F\u043A\u0438 \u043F\u043E\u0434 \u043F\u0440\u0435\u0432\u044C\u044E: \u{1F310} \u0432\u0435\u0437\u0434\u0435 / \u{1F535} VK / \u{1F7E2} TG, \u{1F504} \u043F\u0435\u0440\u0435\u0434\u0435\u043B\u0430\u0442\u044C, \u274C \u043E\u0442\u043C\u0435\u043D\u0438\u0442\u044C.`,
          { parse_mode: "HTML" }
        );
      } catch (e) {
        await sendMessage(env, chatId, `\u26A0\uFE0F \u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u0438\u0442\u044C: ${escHtml(e.message)}`);
      }
      break;
    }
    case "/stock": {
      const stock = await getStock(env);
      if (!stock.length) {
        await sendMessage(env, chatId, "\u{1F5C4} \u0421\u043A\u043B\u0430\u0434 \u043F\u0443\u0441\u0442.");
        break;
      }
      const lines = stock.map((p) => {
        const when = p.scheduled_for ? fmtTime(new Date(p.scheduled_for).toISOString()) : "\u2014";
        return `\u2022 [${p.kind || "news"}] ${escHtml(p.title || p.id)} \u2192 ${when}`;
      });
      await sendLong(env, chatId, "\u{1F5C4} <b>\u0421\u043A\u043B\u0430\u0434</b>\n\n" + lines.join("\n"), { parse_mode: "HTML" });
      break;
    }
    case "/drafts": {
      const drafts = await listDrafts(env);
      if (!drafts.length) {
        await sendMessage(env, chatId, "\u{1F4DD} \u0427\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u043E\u0432 \u043D\u0435\u0442.");
        break;
      }
      const lines = drafts.map(
        (d) => `\u2022 ${escHtml(d.title || d.id)} [${d.status || "pending"}]`
      );
      await sendLong(env, chatId, "\u{1F4DD} <b>\u0427\u0435\u0440\u043D\u043E\u0432\u0438\u043A\u0438</b>\n\n" + lines.join("\n"), {
        parse_mode: "HTML"
      });
      break;
    }
    case "/export": {
      const log = await getLog(env);
      const msg = "\u{1F4E6} <b>\u042D\u043A\u0441\u043F\u043E\u0440\u0442 publish_log</b>\n\n" + JSON.stringify(log, null, 1);
      await sendLong(env, chatId, msg, { parse_mode: "HTML" });
      break;
    }
    case "/rescan": {
      try {
        await tick(env);
        await sendMessage(env, chatId, "\u2705 \u041F\u043E\u043B\u043D\u044B\u0439 \u0442\u0438\u043A \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D");
      } catch (e) {
        await sendMessage(env, chatId, `\u26A0\uFE0F \u041E\u0448\u0438\u0431\u043A\u0430 \u0442\u0438\u043A\u0430: ${escHtml(e.message)}`);
      }
      break;
    }
    case "/version":
      await sendMessage(env, chatId, `\u{1F9EC} TrustNode SMM v${VERSION} (Worker publish contour)`);
      break;
    default:
      await sendMessage(env, chatId, "\u041D\u0435\u0438\u0437\u0432\u0435\u0441\u0442\u043D\u0430\u044F \u043A\u043E\u043C\u0430\u043D\u0434\u0430. \u0421\u043F\u0438\u0441\u043E\u043A \u2014 /help");
  }
}
__name(handleCommand, "handleCommand");
async function handleManualText(env, chatId, text, state) {
  try {
    await sendGeneratedPreview(env, chatId, text);
    await sendMessage(
      env,
      chatId,
      "\u{1F528} <b>\u041A\u0430\u0440\u0442\u043E\u0447\u043A\u0430 \u0433\u043E\u0442\u043E\u0432\u0430.</b> \u041A\u043D\u043E\u043F\u043A\u0438 \u043F\u043E\u0434 \u043F\u0440\u0435\u0432\u044C\u044E: \u2705 \u043E\u043F\u0443\u0431\u043B\u0438\u043A\u043E\u0432\u0430\u0442\u044C, \u{1F504} \u043F\u0435\u0440\u0435\u0434\u0435\u043B\u0430\u0442\u044C, \u274C \u043E\u0442\u043C\u0435\u043D\u0438\u0442\u044C.",
      { parse_mode: "HTML" }
    );
  } catch (e) {
    await sendMessage(
      env,
      chatId,
      `\u26A0\uFE0F \u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u0438\u0442\u044C \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0443: ${escHtml(e.message)}`
    );
  }
}
__name(handleManualText, "handleManualText");
async function handleMessage(env, msg, state) {
  const chatId = msg.chat ? msg.chat.id : null;
  if (!chatId) return;
  if (!isAdmin(env, chatId)) {
    const text2 = (msg.text || "").trim();
    if (text2 === "/start" || text2 === "/menu") {
      await handleUserStart(env, chatId);
      return;
    }
    if (text2.startsWith("/")) {
      if (text2 === "/cancel") {
        await setUserMode(env, chatId, null);
        await handleUserStart(env, chatId);
        return;
      }
      await sendMessage(
        env,
        chatId,
        "\u042F \u0431\u043E\u0442 TrustNode. \u0427\u0442\u043E\u0431\u044B \u043F\u0440\u0435\u0434\u043B\u043E\u0436\u0438\u0442\u044C \u043F\u043E\u0441\u0442 \u0438\u043B\u0438 \u043D\u0430\u043F\u0438\u0441\u0430\u0442\u044C \u0432 \u043F\u043E\u0434\u0434\u0435\u0440\u0436\u043A\u0443, \u043E\u0442\u043A\u0440\u043E\u0439\u0442\u0435 \u043C\u0435\u043D\u044E: /start"
      );
      return;
    }
    const mode = await getUserMode(env, chatId);
    if (mode === "suggest") {
      await handleSuggestion(env, msg);
    } else if (mode === "support") {
      await handleSupportMessage(env, msg);
    } else {
      await handleUserStart(env, chatId);
    }
    return;
  }
  const dialog = await getEventDialog(env);
  if (dialog && String(dialog.chat_id) === String(chatId)) {
    const handled = await handleEventDialogMessage(env, msg);
    if (handled) return;
  }
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
      "\u270D\uFE0F <b>\u041E\u0442\u043F\u0440\u0430\u0432\u044C\u0442\u0435 \u0442\u0435\u043A\u0441\u0442 \u043D\u043E\u0432\u043E\u0441\u0442\u0438</b> \u2014 \u043F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u043B\u044E \u043A\u0430\u0440\u0442\u043E\u0447\u043A\u0443 \u0438 \u043F\u0440\u0438\u0448\u043B\u044E \u043F\u0440\u0435\u0432\u044C\u044E \u043D\u0430 \u043E\u0434\u043E\u0431\u0440\u0435\u043D\u0438\u0435.",
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
__name(handleMessage, "handleMessage");
async function handleUpdate(env, update) {
  const state = await loadState(env);
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
__name(handleUpdate, "handleUpdate");
var worker_default = {
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
      await tick(env);
    } catch (e) {
      console.log("scheduled error:", e.message);
    }
    try {
      await resolveTelegramChannel(env);
    } catch (e) {
      console.log("resolve channel error:", e.message);
    }
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
