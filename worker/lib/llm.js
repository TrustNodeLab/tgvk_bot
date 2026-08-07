// Генерация текста поста прямо в Worker: без GitHub.
// Провайдеры выбираются ротацией по времени суток МСК:
//   утро (06-12) — GigaChat, день (12-17) — совместный пост (оба LLM),
//   вечер (17-22) — Gemini, ночь (22-06) — любой доступный.
// Если LLM_PROXY_URL не задан — детерминированный генератор по правилам.
// Возвращает { headline, headline_lines, caption, cards, tier, source }.

import { mskNow } from "./config.js";
import { markdownToHtml, stripMarkdown, fitCaption } from "./text.js";

const RUSTORE = "https://www.rustore.ru/catalog/app/com.frauddetector.app";
const SITE = "https://trustnodelab.github.io";

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

function sentences(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  return t.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter(Boolean);
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

const NUM_RE =
  /(\d[\d\s]*[.,]?\d*)\s*(%|млн|млрд|тыс\.?|₽|руб(?:лей)?|миллион|тысяч|млрд\s*руб|процент|из\s+\d+)/gi;

function findStat(s) {
  const m = String(s).match(NUM_RE);
  if (!m) return null;
  const raw = m[0].replace(/\s+/g, " ");
  if (!/\d/.test(raw)) return null;
  return raw.slice(0, 14);
}

// ---------- детекторы схем мошенничества (для советов без LLM) ----------

const SCHEME_DETECTORS = [
  {
    key: "call",
    re: /звон(?:ят|ит|ают)|позвонил|телефонный|телефону|по телефону|оператор|из банка|безопасн[а-я]* счёт|представился|колл-центр/i,
    hint: "Голосовой разговор",
    tips: [
      "Положите трубку и перезвоните в банк по номеру с обратной стороны карты",
      "Сотрудники банка никогда не просят код из SMS или перевод «на безопасный счёт»",
    ],
  },
  {
    key: "sms",
    re: /код (?:из|в )?[сs]мс?|смс|телефонную подтвержден|подтверждени|код подтверждени|вход в аккаунт/i,
    hint: "Код из SMS",
    tips: [
      "Код из SMS — это ключ к вашему аккаунту. Никому его не называйте.",
      "Банк, госорган и «служба безопасности» никогда не запрашивают код по телефону",
    ],
  },
  {
    key: "link",
    re: /ссылк|фишинг|фейк|поддельн|скопирова|сообщени[а-я]*\s+закрыт|перейти по/i,
    hint: "Фишинг-ссылки",
    tips: [
      "Проверяйте адрес сайта перед вводом данных — подделка может отличаться одной буквой",
      "Не переходите по ссылкам и QR-кодам от незнакомцев и в сомнительных сообщениях",
    ],
  },
  {
    key: "investment",
    re: /инвест|крипто|доход|вложени|пассивн|обман.*вклад|реклама.*заработ/i,
    hint: "Инвестиции/крипто",
    tips: [
      "Гарантированный доход «прямо сейчас» — признак мошенничества",
      "Не выводите средства на «безопасный счёт» и не передавайте доступ к кошельку",
    ],
  },
  {
    key: "identity",
    re: /представил|пoлюцейск|следовател|фсб|прокурор|служб[а-я]* безопасност|госуслуг/i,
    hint: "Фейковый сотрудник",
    tips: [
      "Незнакомец «из органов» не имеет права требовать деньги или доступ по телефону",
      "Перепроверяйте личность звонящего, позвонив по официальному номеру ведомства",
    ],
  },
  {
    key: "gosuslugi",
    re: /госуслуг|аккаунт\s+взлома|восстанови* доступ/i,
    hint: "Аккаунт на Госуслугах",
    tips: [
      "Настоящие сотрудники не просят код из SMS или «подтверждение входа» по телефону",
      "Смените пароль только через официальный портал, не по ссылке из сообщения",
    ],
  },
];

function detectScheme(text) {
  for (const d of SCHEME_DETECTORS) {
    const m = d.re.exec(String(text || "").toLowerCase());
    if (m) return d;
  }
  return null;
}

// Вычленяем «факты» из описания: содержательные предложения-тезисы (кроме первого).
function extractFacts(sents) {
  const skipLead = /^((москва|риа|tass|интерфакс|прайм)[, -]*\d+\s*(авг|сент|окт|ноя|дек|янв|фев|мар|апр|мая|июн|июл)\s*,?)?/i;
  return sents
    .slice(1)
    .filter((s) => {
      const t = s.replace(/^[\s\d.,\-–:]+/, "").trim();
      return t.length >= 25 && t.length <= 180;
    })
    .map((s) => truncateAt(stripLink(s).replace(/^[\s\d.,:–-]+/, "").replace(/[.;,]+$/, ""), 150))
    .slice(0, 4);
}

// ---------- генератор по правилам ----------

export function generateByRules(text, meta = {}) {
  const src = String(meta.text || text || "");
  const cleaned = stripLink(src).trim();

  // Работаем и с заголовком (meta.title / отдельным), и с полным текстом.
  const titleText = stripLink(String(meta.title || "").trim());
  const sents = sentences(cleaned || titleText);

  const headline =
    truncateAt(titleText || stripLink(sents[0]) || "Кибербезопасность: главное", 85);

  // Крючок-подзаголовок: первое содержательное предложение (после заголовка).
  const lead = sents[1] && sents[1].length > 20 ? truncateAt(stripLink(sents[1]), 150) : null;

  const facts = extractFacts(sents);
  const scheme = detectScheme(cleaned || titleText);

  // Карточки собраны так, чтобы их хватало для визуала без текста.
  const cards = [];
  const statNum = findStat(cleaned || src);
  if (statNum) {
    cards.push({
      type: "stat",
      number: statNum,
      label: "ключевая цифра",
      desc: stripLink(sents[0] || headline),
    });
  }
  if (facts.length >= 1) {
    cards.push({ type: "list", label: scheme ? "Как это происходит" : "Суть", items: facts });
  }
  if (scheme) {
    cards.push({ type: "list", label: "Как защититься", items: buildAdvice(scheme) });
  }
  // последний запасной — если ничего не набрали
  if (!cards.length) {
    cards.push({
      type: "list",
      label: "Суть",
      items: sents.slice(0, 3).map((s) => truncateAt(stripLink(s), 150)),
    });
  }

  const lines = [`<b>${sanitizeHtml(headline)}</b>`];
  if (lead) lines.push(`\n${sanitizeHtml(lead)}`);
  if (facts.length) {
    lines.push("");
    lines.push("🔍 " + (scheme ? "Как работает схема" : "Суть"));
    for (const f of facts) lines.push("• " + sanitizeHtml(f));
  }
  if (scheme) {
    lines.push("");
    lines.push("🛡️ Что делать");
    for (const t of buildAdvice(scheme)) lines.push("• " + sanitizeHtml(t));
  }
  if (meta.link) lines.push("", `Источник: <a href="${sanitizeHtml(meta.link)}">ссылка</a>`);
  lines.push("", FOOTER_HTML);
  const caption = lines.join("\n");

  return { headline, headline_lines: [headline], caption, cards, tier: "news", source: meta.source || "" };
}

// Советы по защите: из детектора + базовое правило. Без LLM.
function buildAdvice(scheme) {
  const tips = scheme ? scheme.tips.slice(0, 2) : [];
  tips.push("При малейшем сомнении перезвоните сами — официальный номер с обратной стороны карты или сайта");
  tips.push("Расскажите о схеме близким: мошенники часто давят на доверие и страх");
  return tips.slice(0, 3);
}

// ---------- вызов LLM ----------

// Прокси через Render-сервис: GigaChat из Worker напрямую нельзя (CA Сбера).
// Render-сервис держит ключи GigaChat/Gemini и ходит в них сам. provider:
// "gigachat" | "gemini".
async function callProxyLlm(env, text, prevPost = null, provider = "gigachat") {
  const base = (env.LLM_PROXY_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("LLM_PROXY_URL не задан");
  const res = await fetch(`${base}/llm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, prev_post: prevPost, provider }),
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

async function callLlm(env, text) {
  const base = (env.LLM_API_BASE || "").replace(/\/+$/, "");
  const url = `${base}/chat/completions`;
  const model = env.LLM_MODEL || "gemini-flash-lite-latest";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: LLM_SYSTEM },
        { role: "user", content: String(text).slice(0, 6000) },
      ],
      temperature: 0.4,
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
  const errors = [];

  if (joint) {
    // Совместный пост: пробуем оба LLM, объединяем успешные ответы.
    const attempts = await Promise.allSettled(
      order.map((p) => callProxyLlm(env, src, prev, p).then((d) => normalizeProxyData(d, src)))
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
      const data = await callProxyLlm(env, src, prev, p);
      return normalizeProxyData(data, src);
    } catch (e) {
      lastErr = e;
      errors.push(`${p}: ${e.message}`);
    }
  }
  throw new Error(errors.join(" | ") || (lastErr && lastErr.message));
}

export async function generatePostData(text, env, meta = {}) {
  const plan = providerPlan(env, mskNow());
  if (plan.order.length) {
    try {
      const data = await generateWithProviders(env, meta.text || text, meta, plan.order, plan.joint);
      return { ...data, llm_provider: plan.joint ? "gigachat+gemini" : plan.order[0] };
    } catch (e) {
      console.log("[llm] LLM-прокси недоступен, использую правила:", e.message);
    }
  }
  if (env.LLM_API_KEY && env.LLM_API_BASE) {
    try {
      const data = await callLlm(env, meta.text || text);
      return { ...validateLlm(data, text), llm_provider: "gemini-direct" };
    } catch (e) {
      console.log("[llm] LLM недоступен, использую правила:", e.message);
    }
  }
  return generateByRules(text, meta);
}
