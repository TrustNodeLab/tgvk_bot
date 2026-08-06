// Генерация текста поста прямо в Worker: без GitHub.
// 1) Если заданы секреты LLM_API_KEY + LLM_API_BASE — зовём любой
//    OpenAI-совместимый API (Gemini/DeepSeek и т.п.).
// 2) Иначе — детерминированный генератор по правилам (работает всегда).
// Возвращает { headline, caption, cards, tier, source }.

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
  /\d[\d\s]*[.,]?\d*\s*(?:%|млн|млрд|тыс\.?|₽|руб(?:лей)?|миллион|тысяч|млрд\s*руб)/gi;

function findStat(s) {
  const m = String(s).match(NUM_RE);
  if (!m) return null;
  const raw = m[0].replace(/\s+/g, "");
  if (!/\d/.test(raw)) return null;
  return raw.slice(0, 12);
}

// ---------- генератор по правилам ----------

export function generateByRules(text, meta = {}) {
  const src = String(meta.text || text || "");
  const cleaned = stripLink(src).trim();
  const sents = sentences(cleaned || String(meta.title || ""));

  const headline =
    truncateAt(stripLink(sents[0] || meta.title || "Кибербезопасность: главное"), 90);

  // тезисы: содержательные предложения, не первое
  const body = sents
    .slice(1)
    .filter((s) => s.length >= 20 && s.length <= 170)
    .map((s) => truncateAt(stripLink(s).replace(/[.;,]+$/, ""), 150))
    .slice(0, 3);

  const cards = [];
  const statNum = findStat(cleaned || src);
  if (statNum) {
    cards.push({
      type: "stat",
      number: statNum,
      label: "ключевая цифра новости",
      desc: headline,
    });
  }
  if (body.length) {
    cards.push({ type: "list", label: "Суть", items: body });
  }

  const lines = [`<b>${sanitizeHtml(headline)}</b>`];
  if (body.length) lines.push("");
  for (const b of body) lines.push(sanitizeHtml(b));
  if (meta.link) lines.push(`Источник: <a href="${sanitizeHtml(meta.link)}">ссылка</a>`);
  lines.push("", FOOTER_HTML);
  const caption = lines.join("\n");

  return { headline, caption, cards, tier: "news", source: meta.source || "" };
}

// ---------- вызов LLM ----------

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
  const headline = String(data.headline || "").trim().slice(0, 120) || "Кибербезопасность: главное";
  let caption = String(data.caption || "").trim().slice(0, 1100);
  if (!caption) {
    const body = [data.headline, ...((data.cards || []).map((c) => c.label || "")).filter(Boolean)];
    caption = body.join("\n\n");
  }
  const cards = Array.isArray(data.cards)
    ? data.cards
        .filter((c) => c && typeof c === "object")
        .slice(0, 4)
        .map((c) => ({
          type: ["stat", "list", "compare"].includes(c.type) ? c.type : "stat",
          number: String(c.number || "").slice(0, 12),
          label: String(c.label || "").slice(0, 80),
          desc: String(c.desc || "").slice(0, 160),
          items: Array.isArray(c.items) ? c.items.map((i) => String(i).slice(0, 140)).slice(0, 4) : [],
        }))
    : [];
  const tier = ["news", "real_threat", "medium", "safe"].includes(data.tier) ? data.tier : "news";
  return { headline, caption, cards, tier, source: "" };
}

export async function generatePostData(text, env, meta = {}) {
  if (env.LLM_API_KEY && env.LLM_API_BASE) {
    try {
      const data = await callLlm(env, meta.text || text);
      return validateLlm(data, text);
    } catch (e) {
      console.log("[llm] LLM недоступен, использую правила:", e.message);
    }
  }
  return generateByRules(text, meta);
}
