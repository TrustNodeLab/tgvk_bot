// Сканирование RSS-лент с учётом лимита free-плана Worker (~50 подзапросов/вызов).
// Скан дробится: за каждый крон обрабатывается только часть лент, цикл прокручивается.

import { MAX_AGE_MS, FRESH_MS, parseRSS, parsePubDate } from "./config.js";
import { clusterDuplicates, buildClusterText } from "./dedup.js";
import { getCandidates, addCandidate, loadState } from "./kv.js";

const REQUEST_HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; TrustNodeBot/1.0)" };

// Многие русские RSS-ленты отдают windows-1251 и не указывают charset в заголовке;
// res.text() в Workers всегда считает UTF-8 — из-за этого выходили «кракозябры».
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

// Запасная конфигурация на случай, если sources.json недоступен.
export const DEFAULT_SOURCES = {
  feeds: [
    "https://ria.ru/export/rss2/index.xml",
    "https://lenta.ru/rss/news",
    "https://www.gazeta.ru/export/rss/social_more.xml",
    "https://www.kommersant.ru/RSS/news.xml",
    "https://tass.ru/rss/v2.xml",
    "https://www.interfax.ru/rss.asp",
    "https://rg.ru/xml/index.xml",
    "https://vz.ru/rss.xml",
    "https://rssexport.rbc.ru/rbcnews/news/30/full.rss",
  ],
  keywords: ["мошенник", "мошенничеств", "фишинг", "кибермошенник", "дроппер"],
  exclude_keywords: [],
};

async function fetchJson(env, path) {
  if (!env.GITHUB_TOKEN) return null;
  const res = await fetch(
    `https://api.github.com/repos/${env.OWNER}/${env.REPO}/contents/${path}`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "tgvk-bot-webhook",
      },
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.content) return null;
  // GitHub отдаёт base64 в UTF-8; atob() даёт latin1 и ломает кириллицу,
  // поэтому декодируем явно через TextDecoder.
  const bin = atob(data.content.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder("utf-8").decode(bytes));
}

export async function loadSources(env) {
  const repo = await fetchJson(env, "config/sources.json");
  if (repo && Array.isArray(repo.feeds) && repo.feeds.length) return repo;
  return DEFAULT_SOURCES;
}

// Применяет admin-переопределения (extra/removed keywords, blacklist) из state.
function applyOverrides(config, state) {
  const keywords = [...(config.keywords || [])];
  for (const k of state.extra_keywords || []) if (!keywords.includes(k)) keywords.push(k);
  for (const k of state.removed_keywords || []) {
    const i = keywords.indexOf(k);
    if (i >= 0) keywords.splice(i, 1);
  }
  return {
    ...config,
    keywords,
    exclude_keywords: [...(config.exclude_keywords || []), ...(state.blacklist?.keywords || [])],
  };
}

function hasAny(text, keywords) {
  const low = (text || "").toLowerCase();
  return keywords.some((k) => low.includes((k || "").toLowerCase()));
}

const CODE_HINTS = [
  "function", "window.", "document.", "=>", "var ", "counter", "topmailru",
  "yandex", "liveinternet", "advad", "adblock", "script", "push({",
];

function looksLikeCode(text) {
  if (text.includes("{") && text.includes("}")) return true;
  const low = text.toLowerCase();
  return CODE_HINTS.some((h) => low.includes(h));
}

// Посты студии всегда на русском: если текст в основном не на кириллице —
// это иностранная лента/статья, в кандидаты не берём.
export function isRussianText(text) {
  const t = (text || "").replace(/\s+/g, "");
  if (t.length < 12) return true;
  const cyr = (t.match(/[\u0400-\u04FF]/g) || []).length;
  return cyr / t.length >= 0.35;
}

export async function fetchArticleExcerpt(url, maxChars = 2500) {
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

// Обрабатывает часть лент за один крон. Возвращает новые кластеры кандидатов.
// chunkOffset = номер части цикла (0..n-1), chunkCount = сколько частей всего.
export async function scanFeeds(env, chunkOffset = 0, chunkCount = 2) {
  const config = applyOverrides(await loadSources(env), await loadState(env));
  const feeds = config.feeds || [];
  const keywords = config.keywords || [];
  const exclude = config.exclude_keywords || [];

  if (!feeds.length) return [];

  // дробим ленты на части цикла: каждый крон опрашиваем только свою часть,
  // чтобы число подзапросов на вызов оставалось в пределах лимита.
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
      /* feed error: не роняем весь скан */
    }
  }

  // Дедуп одинаковых новостей из разных лент в один кластер.
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
      found_at: new Date().toISOString(),
    };
    // Текст подкачиваем только для лучшего источника кластера (экономия подзапросов).
    if (cand.fresh || true) {
      cand.excerpt = await fetchArticleExcerpt(cand.link);
      cand.text = buildClusterText(cl, cand.excerpt);
    }
    await addCandidate(env, cand);
    fetched.push(cand);
  }

  return fetched;
}
