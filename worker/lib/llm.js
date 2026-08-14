// Генерация текста поста прямо в Worker: без GitHub.
// Провайдеры выбираются ротацией по времени суток МСК:
//   утро (06-12) — GigaChat, день (12-17) — совместный пост (оба LLM),
//   вечер (17-22) — Gemini, ночь (22-06) — любой доступный.
// Если LLM_PROXY_URL не задан — детерминированный генератор по правилам.
// Возвращает { headline, headline_lines, caption, cards, tier, source }.

import { mskNow } from "./config.js";
import { markdownToHtml, stripMarkdown, fitCaption } from "./text.js";
import { analyzePost, buildCards, buildAdvice, sanitizeLink } from "./nlp.js";

const RUSTORE = "https://www.rustore.ru/catalog/app/com.frauddetector.app";
const SITE = "https://trustnodelab.github.io";

// Жанры поста — ротация «как в живой редакции», чтобы соседние посты не
// выглядели одинаково (шаблон-«бот» = убийца охватов). Жанр выбирается
// детерминированно от guid/текста: стабилен для той же новости, но разный
// между соседними постами. Инструкция дописывается в системный промпт LLM.
const POST_STYLES = [
  {
    id: "razbor",
    name: "Разбор схемы",
    instruction:
      "Формат поста — «Разбор схемы»: сначала коротко о чём новость, затем " +
      "по шагам — как именно работает схема обмана (что говорит мошенник, как " +
      "давит на страхи, где точка отказа), и в конце — конкретная защита. " +
      "Пиши как аналитик безопасности, объясняющий механику, а не как новостная лента.",
  },
  {
    id: "warning",
    name: "Предупреждение",
    instruction:
      "Формат поста — «Предупреждение»: поставь читателя в ситуацию («вы " +
      "можете столкнуться с этим сегодня»), объясни риск человеческим языком, " +
      "дай 2—3 действия, которые прямо сейчас снижают угрозу. Тон — заботливый, " +
      "без паники и кликбейта.",
  },
  {
    id: "fact",
    name: "Факт-карточка",
    instruction:
      "Формат поста — «Факт-карточка»: сухо и по делу. Собери главные факты " +
      "новости короткими абзацами, цифры — точно из источника, вывод — одним " +
      "предложением. Без лишних слов и общих советов; стиль — информационный.",
  },
  {
    id: "myth",
    name: "Разбор заблуждения",
    instruction:
      "Формат поста — «Разбор заблуждения»: найди распространённый миф или " +
      "наивную ошибку, связанную с новостью («я думал, меня это не касается»), " +
      "разбери, почему она работает на людях, и покажи, как правильно поступать. " +
      "Пиши спокойно, с примерами «хорошо/плохо».",
  },
  {
    id: "case",
    name: "Кейс-история",
    instruction:
      "Формат поста — «Кейс-история»: перескажи ситуацию из новости как " +
      "историю конкретного человека ( кто, где, что случилось, что потерял ), " +
      "выдели момент, где его можно было остановить, и сделай вывод-совет. " +
      "Рассказывай живо и по-человечески, без канцелярита.",
  },
];

function pickPostStyle(meta = {}) {
  const seed = String(meta.guid || meta.link || meta.title || meta.text || "").trim();
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return POST_STYLES[h % POST_STYLES.length];
}

export const FOOTER_HTML =
  `🛡️ <b>TrustNode</b>\n` +
  `📱 Приложение: <a href="${RUSTORE}">RuStore</a>\n` +
  `🌐 Сайт: <a href="${SITE}">trustnodelab.github.io</a>`;

// ---------- санитайзинг HTML (оставляем только свои теги) ----------

export function sanitizeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------- утилиты ----------

// Финальный caption: markdown -> HTML, лимит TG 1024, футер всегда целиком.
function finalizeCaption(body) {
  const b = markdownToHtml(String(body || "")).trim();
  if (!b) return FOOTER_HTML;
  const budget = 1024 - FOOTER_HTML.length - 2;
  const bodyFit = b.length <= budget ? b : truncateAt(b, budget);
  return bodyFit + "\n\n" + FOOTER_HTML;
}

function truncateAt(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[.,;:]+$/, "") + "…";
}

function stripLink(s) {
  return s.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
}

// Срезает хвосты «— Источник: https://…» / «Источник: URL», которые LLM иногда
// копирует из сырого текста новости в bullets. Сама ссылка добавляется отдельно.
export function stripSourceTail(s) {
  return String(s || "")
    .replace(/\s*[—–-]\s*источник\s*:\s*(?:https?:\/\/)?\S+\s*$/i, "")
    .replace(/\s*источник\s*:\s*(?:https?:\/\/)?\S+\s*$/i, "")
    .trim();
}

// ---------- генератор по правилам ----------

export function generateByRules(text, meta = {}) {
  const src = String(meta.text || text || "");
  const analysis = analyzePost(src, meta);

  const cards = buildCards(analysis, meta);
  const headline = analysis.headline;
  const norm = (s) => String(s || "").toLowerCase().replace(/[.,!?…]+$/g, "").trim();
  const lead = analysis.lead && norm(analysis.lead) !== norm(headline) ? analysis.lead : null;
  const scheme = analysis.topic;
  const style = pickPostStyle(meta);

  const HOOKS = {
    razbor: ["Разбираем, как работает схема — по шагам."],
    warning: ["С этим можно столкнуться уже сегодня."],
    fact: ["Коротко о главном."],
    myth: ["Что на самом деле происходит — и где подвох."],
    case: ["Случай из новости — как это выглядело на деле."],
  };
  const hook = (HOOKS[style.id] || []).find(Boolean);

  const captionLines = [];
  if (hook) captionLines.push(`${sanitizeHtml(hook)}\n`);
  captionLines.push(`<b>${sanitizeHtml(headline)}</b>`);
  if (lead) captionLines.push(`\n${sanitizeHtml(lead)}`);
  if (analysis.facts.length) {
    captionLines.push("");
    captionLines.push("🔍 " + (scheme ? scheme.hint : "Суть"));
    for (const f of analysis.facts) captionLines.push("• " + sanitizeHtml(f));
  }
  if (scheme) {
    captionLines.push("");
    captionLines.push("🛡️ Что делать");
    for (const t of buildAdvice(scheme)) captionLines.push("• " + sanitizeHtml(t));
  }
  if (meta.link) captionLines.push("", `Источник: <a href="${sanitizeLink(meta.link)}">ссылка</a>`);
  captionLines.push("", FOOTER_HTML);
  const caption = captionLines.join("\n");

  return {
    headline,
    headline_lines: [headline],
    caption,
    cards,
    tier: analysis.tier,
    source: meta.source || "",
  };
}

// ---------- дайджест (сводка нескольких новостей одним постом) ----------

const DIGEST_EMOJI = { morning: "🌅", day: "☀️", evening: "🌆" };

// Якорь свежести новости для сортировки внутри сводки (свежайшие первыми).
function itemFreshMs(c) {
  for (const f of ["pub_ts", "found_at", "created_at"]) {
    const v = c[f];
    if (v === null || v === undefined || v === "") continue;
    const t = typeof v === "number" ? v : Date.parse(String(v));
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

function domainOf(link) {
  try {
    return String(new URL(link).hostname).replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}

function humanDate(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}` : iso || "";
}

// Правила-фолбэк: по каждой новости — заголовок + факт + ссылка, в конце —
// общий блок защиты (советы по темам, без дублей), до 3 советов.
export function digestByRules(items, meta = {}) {
  const label = String(meta.label || "");
  const head =
    `Дайджест TrustNode · ${label}` + (meta.date ? ` — ${humanDate(meta.date)}` : "");
  const bulletTexts = [];
  const advice = [];
  const seenTips = new Set();
  for (const it of items) {
    let a = null;
    try {
      a = analyzePost(it.text || it.title || "", { title: it.title || "" });
    } catch (e) { /* пустой текст */ }
    const title =
      (a && a.headline) ||
      String(it.title || "").replace(/\s+/g, " ").trim().slice(0, 90) ||
      "Новость";
    const fact = a && a.facts && a.facts[0] ? a.facts[0].slice(0, 140) : null;
    let text = sanitizeHtml(title);
    if (fact) text += ` — ${sanitizeHtml(fact)}`;
    bulletTexts.push({ text, link: it.link || "" });
    if (a && a.topic) {
      for (const t of buildAdvice(a.topic)) {
        if (advice.length >= 2) break;
        const key = String(t).toLowerCase();
        if (seenTips.has(key)) continue;
        seenTips.add(key);
        advice.push(sanitizeHtml(t));
      }
    }
  }
  return { headline: head, bulletTexts, advice };
}

// Попытка живого дайджеста от LLM (прямой API): headline + bullets (по одной
// на новость: что произошло и почему касается читателя) + советы.
async function callLlmDigest(env, items) {
  const base = String(env.LLM_API_BASE || "").replace(/\/+$/, "");
  const model = env.LLM_MODEL || "gemini-flash-lite-latest";
  const list = items
    .map(
      (it, i) =>
        `${i + 1}. ${String(it.title || "").replace(/\s+/g, " ").trim().slice(0, 200)}\n` +
        `${String(it.text || "").replace(/\s+/g, " ").trim().slice(0, 800)}\n` +
        `Ссылка: ${it.link || ""}`
    )
    .join("\n\n");
  const prompt =
    "Ты — эксперт и автор канала TrustNode о кибербезопасности. По списку новостей собери дайджест с авторской позицией редакции:\n" +
    "верни ТОЛЬКО валидный JSON без пояснений:\n" +
    '{"headline":"короткий заголовок выпуска (1 фраза с позицией)", "bullets":["ровно по 1 булету на каждую новость (до ~150 символов): что произошло И краткий вывод-мнение TrustNode — вердикт, оценка или предостережение, а не пересказ заголовка"], "advice":["не более 2 советов, каждый до ~50 символов"]}.\n' +
    "Булетов должно быть РОВНО столько же, сколько новостей в списке. Пиши как живой автор канала — с позицией, живым языком, без канцелярита; факты бери только из текста новостей; не вставляй URL и слово «источник» в булет. Весь выпуск должен поместиться в 1024 символа.\n\n" +
    list;
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "Ты редактор телеграм-канала о кибербезопасности. Отвечай только JSON." },
        { role: "user", content: prompt },
      ],
      temperature: 0.75,
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`LLM digest ${res.status}`);
  const m = String(await res.text()).match(/\{[\s\S]*\}/);
  if (!m) throw new Error("LLM digest: не JSON");
  const data = JSON.parse(m[0]);
  const bullets = Array.isArray(data.bullets)
    ? data.bullets.map((b) => String(b).trim()).filter(Boolean).slice(0, items.length)
    : [];
  const advice = Array.isArray(data.advice)
    ? data.advice.map((a) => String(a).trim()).filter(Boolean).slice(0, 2)
    : [];
  if (bullets.length !== items.length) {
    throw new Error(`LLM digest: булетов ${bullets.length} из ${items.length} новостей`);
  }
  if (!bullets.length) throw new Error("LLM digest: пустые bullets");
  return { headline: String(data.headline || "").trim() || undefined, bullets, advice };
}

// Дайджест через Render-прокси (/digest): GigaChat/Gemini со стороны Python.
// Первый запрос к спящему free-tier инстансу может упасть на cold start
// (timeout/5xx) — повторяем один раз, обычно хватает разбудить.
async function callProxyDigest(env, items) {
  const base = (env.LLM_PROXY_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("LLM_PROXY_URL не задан");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await proxyDigestOnce(base, items);
    } catch (e) {
      if (attempt === 0) {
        console.log(`[llm] /digest попытка ${attempt + 1} не удалась, повторяю:`, e.message);
        continue;
      }
      throw e;
    }
  }
  throw new Error("LLM /digest: не удалось");
}

async function proxyDigestOnce(base, items) {
  const slimItems = (items || []).slice(0, 3).map((it) => ({
    title: String(it.title || "").replace(/\s+/g, " ").trim().slice(0, 140),
    text: String(it.text || "").replace(/\s+/g, " ").trim().slice(0, 500),
    link: it.link || "",
  }));
  const res = await fetch(`${base}/digest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items: slimItems, provider: "gigachat" }),
    signal: AbortSignal.timeout(115000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`LLM proxy /digest ${res.status}: ${raw.slice(0, 160)}`);
  const data = JSON.parse(raw);
  if (data && data.error) throw new Error(`LLM /digest: ${data.error}`);
  const bullets = Array.isArray(data.bullets)
    ? data.bullets.map((b) => String(b).trim()).filter(Boolean).slice(0, slimItems.length)
    : [];
  const advice = Array.isArray(data.advice)
    ? data.advice.map((a) => String(a).trim()).filter(Boolean).slice(0, 2)
    : [];
  if (bullets.length !== slimItems.length) {
    throw new Error(`LLM /digest: булетов ${bullets.length} из ${slimItems.length} новостей`);
  }
  if (!bullets.length) throw new Error("LLM /digest: пустые bullets");
  return { headline: String(data.headline || "").trim() || undefined, bullets, advice };
}

// Текст дайджеста: headline + caption (набор заголовка, bullets с ссылками на
// источники, блок «Что делать», футер). Собирается ТОЛЬКО живым LLM: без него
// возвращает null, чтобы не постить сырые заголовки (лучше пропустить окно).
export async function generateDigestText(items, env = {}, meta = {}) {
  let llm = null;
  if ((env.LLM_PROXY_URL || "").trim()) {
    try {
      llm = await callProxyDigest(env, items);
    } catch (e) {
      console.log("[llm] LLM /digest недоступен:", e.message);
    }
  }
  if (!llm && env.LLM_API_BASE && env.LLM_API_KEY) {
    try {
      llm = await callLlmDigest(env, items);
    } catch (e) {
      console.log("[llm] LLM-дайджест недоступен:", e.message);
    }
  }
  if (!llm || !llm.bullets.length) {
    console.log("[llm] дайджест без живого LLM не собираю (фолбэк-правила не используются)");
    return null;
  }
  const headline = llm.headline ? stripSourceTail(llm.headline) : "";
  const bulletTexts = llm.bullets.map((t, i) => ({
    text: markdownToHtml(stripSourceTail(t)),
    link: items[i] && items[i].link,
  }));
  const advice = llm.advice.map((t) => markdownToHtml(stripSourceTail(t)));

  const emoji = DIGEST_EMOJI[meta.slug] || "📰";
  const headlinePart = `${emoji} <b>${sanitizeHtml(headline)}</b>`;
  const bulletParts = bulletTexts.map((b, i) => {
    let txt = `• <b>${i + 1}.</b> ${b.text}`;
    if (b.link) txt += `\n<a href="${sanitizeLink(b.link)}">источник →</a>`;
    return txt;
  });
  const adviceHeader = "🛡️ <b>Что делать</b>";
  const adviceParts = advice.map((t) => "• " + t);
  // Бюджет caption: футер всегда целиком; заголовок и булеты обязательны,
  // при переполнении ужимаются по словам (не по символу), советы — наименьший
  // приоритет, отбрасываются целиком. Многоточия перед футером быть не должно.
  const footerLen = FOOTER_HTML.length;
  const budget = 1024 - footerLen - 2; // разделитель "\n\n"
  const join = (arr) => arr.join("\n\n");
  let parts = [headlinePart, ...bulletParts];
  // режем последний булет по словам, пока всё тело не влезает в бюджет
  while (join(parts).length > budget && parts.length > 1) {
    const last = parts[parts.length - 1];
    const over = join(parts).length - budget;
    const keep = Math.max(12, last.length - over - 4);
    const trimmed = last.slice(0, keep).trimEnd();
    const sp = trimmed.lastIndexOf(" ");
    const cut = (sp > 8 ? trimmed.slice(0, sp) : trimmed).replace(/[.,;:—–-]+$/, "");
    const next = cut + ".";
    parts = parts.slice(0, -1).concat(next.length >= 8 ? [next] : []);
    if (next.length < 8) parts = parts.slice(0, -1);
  }
  const bodyText = join(parts);
  let adv = "";
  if (bodyText.length <= budget) {
    let advArr = [adviceHeader, ...adviceParts];
    while (advArr.length > 1 && (bodyText + "\n\n" + advArr.join("\n\n")).length > budget) {
      advArr = advArr.slice(0, -1);
      if (advArr.length === 1) advArr = []; // и сам заголовок «Что делать» не влез
    }
    if (advArr.length) adv = "\n\n" + advArr.join("\n\n");
  }
  const caption = fitCaption(bodyText + adv + "\n\n" + FOOTER_HTML, 1024);

  return {
    headline,
    headline_lines: [headline],
    caption,
    items: items.map((it, i) => ({
      guid: it.guid || "",
      title: String(it.title || "").replace(/\s+/g, " ").trim().slice(0, 120),
      link: it.link || "",
      source: domainOf(it.link || "") || it.source || "",
    })),
  };
}

// Свежайшие первыми — для отбора новостей в выпуск.
export function digestFreshScore(c) {
  return itemFreshMs(c);
}

// ---------- вызов LLM ----------

// Прокси через Render-сервис: GigaChat из Worker напрямую нельзя (CA Сбера).
// Render-сервис держит ключи GigaChat/Gemini и ходит в них сам. provider:
// "gigachat" | "gemini".
async function callProxyLlm(env, text, prevPost = null, provider = "gigachat", style = null) {
  const base = (env.LLM_PROXY_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("LLM_PROXY_URL не задан");
  const res = await fetch(`${base}/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, prev_post: prevPost, provider, style: style ? style.id : "" }),
    signal: AbortSignal.timeout(115000),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`LLM proxy ${res.status}: ${raw.slice(0, 160)}`);
  const data = JSON.parse(raw);
  if (data && data.error) throw new Error(`LLM вернул error: ${data.error}`);
  return data;
}

// Нормализует «богатый» формат LLM (extract_prompt.md) под схему воркера:
// { headline, headline_lines, caption, cards, tier, source }.
function normalizeProxyData(data, text) {
  const rawHeadline = Array.isArray(data.headline) ? data.headline : [data.headline];
  const headlineLines = rawHeadline
    .map((h) => stripMarkdown(h))
    .filter(Boolean)
    .slice(0, 2);
  const headline =
    headlineLines.join(" ") || truncateAt(stripLink(String(text || "").replace(/\s+/g, " ")), 90) || "Кибербезопасность: главное";
  let caption = markdownToHtml(String(data.caption || "")).trim();
  if (caption) caption += "\n\n" + FOOTER_HTML;
  caption = fitCaption(caption, 1024);
  const cards = Array.isArray(data.cards)
    ? data.cards
        .filter((c) => c && typeof c === "object")
        .slice(0, 4)
        .map((c) => ({
          type: ["stat", "list", "compare"].includes(c.type) ? c.type : "stat",
          number: String(c.number || "").slice(0, 12),
          label: stripMarkdown(c.label).slice(0, 80),
          desc: markdownToHtml(String(c.desc || "")).slice(0, 160),
          before: markdownToHtml(String(c.before || "")).slice(0, 160),
          after: markdownToHtml(String(c.after || "")).slice(0, 160),
          items: Array.isArray(c.items) ? c.items.map((i) => stripMarkdown(i).slice(0, 140)).slice(0, 4) : [],
        }))
    : [];
  const tier = ["news", "real_threat", "medium", "safe"].includes(data.tier) ? data.tier : "news";
  return { headline, headline_lines: headlineLines, caption, cards, tier, source: "" };
}

const LLM_SYSTEM =
  "Ты — редактор канала TrustNode о кибербезопасности. По тексту новости верни " +
  "ТОЛЬКО валидный JSON без пояснений, с полями: " +
  '"headline" (заголовок, 1 фраза), "caption" (текст поста 500-800 символов на русском, ' +
  'может содержать теги <b> и <a href>), "cards" (массив: {"type":"stat","number":"...",' +
  '"label":"..."} для цифр или {"type":"list","label":"...","items":["..."]} для тезисов, ' +
  "1-3 карточки), \"tier\" (news|real_threat|medium|safe). Не выдумывай цифры сверх текста.";

async function callLlm(env, text, style = null) {
  const base = (env.LLM_API_BASE || "").replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const model = env.LLM_MODEL || "gemini-flash-lite-latest";
  const system = style
    ? `${LLM_SYSTEM}\n\n${style.instruction}`
    : LLM_SYSTEM;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: String(text).slice(0, 6000) },
      ],
      temperature: 0.75,
    }),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || "";
  const m = content.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("LLM вернул не JSON");
  return JSON.parse(m[0]);
}

function validateLlm(data, text) {
  const headline = stripMarkdown(String(data.headline || "")).slice(0, 120) || "Кибербезопасность: главное";
  let caption = markdownToHtml(String(data.caption || "")).trim();
  if (!caption) {
    const body = [data.headline, ...((data.cards || []).map((c) => c.label || "")).filter(Boolean)];
    caption = markdownToHtml(body.join("\n\n")).trim();
  }
  if (caption) caption += "\n\n" + FOOTER_HTML;
  caption = fitCaption(caption, 1024);
  const cards = Array.isArray(data.cards)
    ? data.cards
        .filter((c) => c && typeof c === "object")
        .slice(0, 4)
        .map((c) => ({
          type: ["stat", "list", "compare"].includes(c.type) ? c.type : "stat",
          number: String(c.number || "").slice(0, 12),
          label: stripMarkdown(c.label).slice(0, 80),
          desc: markdownToHtml(String(c.desc || "")).slice(0, 160),
          items: Array.isArray(c.items) ? c.items.map((i) => stripMarkdown(i).slice(0, 140)).slice(0, 4) : [],
        }))
    : [];
  const tier = ["news", "real_threat", "medium", "safe"].includes(data.tier) ? data.tier : "news";
  return { headline, caption, cards, tier, source: "" };
}

// Объединяет результаты двух LLM в «совместный пост»: карточки берём из обоих
// (без дублей по ключу), headline и caption — из более насыщенного ответа.
function mergeDualPost(a, b) {
  const score = (d) => (d.caption ? d.caption.length : 0) + (d.cards || []).length * 60;
  const primary = score(a) >= score(b) ? a : b;
  const secondary = primary === a ? b : a;

  const seen = new Set();
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
    source: primary.source || secondary.source,
  };
}

// Утро: GigaChat. День: совместный (оба). Вечер: Gemini. Ночь: любой доступный.
export function providerPlan(env, msk) {
  const hasProxy = !!(env.LLM_PROXY_URL || "").trim();
  if (!hasProxy) return { joint: false, order: [] };
  const h = msk.hour;
  if (h >= 6 && h < 12) return { joint: false, order: ["gigachat", "gemini"] };
  if (h >= 12 && h < 17) return { joint: true, order: ["gigachat", "gemini"] };
  if (h >= 17 && h < 22) return { joint: false, order: ["gemini", "gigachat"] };
  return { joint: false, order: ["gigachat", "gemini"] };
}

async function generateWithProviders(env, text, meta, order, joint) {
  const src = meta.text || text;
  const prev = meta.prev_post || null;
  const style = pickPostStyle(meta);
  const errors = [];

  if (joint) {
    // Совместный пост: пробуем оба LLM, объединяем успешные ответы.
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
  throw new Error(errors.join(" | ") || (lastErr && lastErr.message));
}

export async function generatePostData(text, env, meta = {}) {
  // meta.provider: "gigachat" | "gemini" | "rules" — принудительный провайдер
  // (кнопки/команды админа). "rules" — без LLM вообще.
  const forced = meta.provider || "";

  if (forced === "rules") {
    return generateByRules(text, meta);
  }

  const plan = providerPlan(env, mskNow());
  let order = plan.order;
  let joint = plan.joint;
  if (forced === "gemini" || forced === "gigachat") {
    // Принудительно: пробуем только запрошенный провайдер.
    order = [forced];
    joint = false;
  }
  if (order.length) {
    try {
      const data = await generateWithProviders(env, meta.text || text, meta, order, joint);
      return { ...data, llm_provider: joint ? "gigachat+gemini" : order[0] };
    } catch (e) {
      console.log("[llm] LLM-прокси недоступен, использую правила:", e.message);
    }
  }
  if (!forced && env.LLM_API_KEY && env.LLM_API_BASE) {
    try {
      const data = await callLlm(env, meta.text || text, pickPostStyle(meta));
      return { ...validateLlm(data, text), llm_provider: "gemini-direct" };
    } catch (e) {
      console.log("[llm] LLM недоступен, использую правила:", e.message);
    }
  }
  return generateByRules(text, meta);
}
