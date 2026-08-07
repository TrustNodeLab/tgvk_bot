// Обработка текста поста: нормализация блоков, подгонка под лимит caption TG,
// футер с логотипом. Портировано из bot/main.py.

import { POST_FOOTER, TG_CAPTION_LIMIT } from "./config.js";

const BLOCK_HEADS = ["🔍", "📌", "⚠", "🛡", "💡"];

export function normalizeCaption(caption) {
  const lines = (caption || "").split("\n").map((ln) => (ln || "").trimEnd());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i].trim();
    if (stripped && BLOCK_HEADS.includes(stripped[0])) {
      if (out.length && out[out.length - 1].trim()) out.push("");
    }
    out.push(lines[i]);
  }
  let joined = out.join("\n").trim();
  if (!joined) return "";
  if (joined.includes("•")) {
    const lines2 = [];
    for (const ln of joined.split("\n")) {
      if (!ln.includes("•")) {
        lines2.push(ln);
        continue;
      }
      const parts = ln.split(/(?=•\s)/);
      for (const p of parts) {
        const pp = p.trim();
        if (pp) lines2.push(pp);
      }
    }
    joined = lines2.join("\n");
  }
  return joined;
}

export function fullPostText(caption) {
  const c = normalizeCaption(caption);
  return c ? c + "\n\n" + POST_FOOTER : POST_FOOTER;
}

export function fitCaption(caption, limit = TG_CAPTION_LIMIT) {
  if (caption.length <= limit) return caption;
  let body = caption;
  let footer = "";
  if (caption.endsWith(POST_FOOTER)) {
    body = caption.slice(0, -POST_FOOTER.length).trimEnd();
    footer = "\n\n" + POST_FOOTER;
  }
  const budget = limit - footer.length - 1;
  if (budget <= 0) return caption.slice(0, Math.max(0, limit - 1)) + "…";
  let cut = body.slice(0, budget).trimEnd();
  for (const sep of [". ", "! ", "? ", "…", " ", "— "]) {
    const idx = cut.lastIndexOf(sep);
    if (idx > budget / 2) {
      cut = cut.slice(0, idx).trimEnd() + "…";
      break;
    }
  }
  if (!cut.endsWith("…")) cut = body.slice(0, budget - 1).trimEnd() + "…";
  return cut + footer;
}

// Простое экранирование HTML для Telegram parse_mode=HTML.
export function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Преобразует markdown-разметку моделей в безопасный HTML для Telegram:
//   **жирный** -> <b>, *курсив* -> <i>, [текст](url) -> <a href>,
//   `код` -> <code>. Сначала экранирует спецсимволы HTML, чтобы TG не падал,
//   затем одиночные «сиротские» звёздочки убирает.
export function markdownToHtml(src) {
  if (!src) return "";
  let s = String(src)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, u) => `<a href="${u}">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*/g, "");
  return s;
}

// Убирает markdown-символы без преобразования (для заголовков/тезисов карточки).
export function stripMarkdown(src) {
  return String(src ?? "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Форматирование timestamp для сводок.
export function fmtTime(iso, withYear = false) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = (n) => String(n).padStart(2, "0");
  const date = `${p(d.getDate())}.${p(d.getMonth() + 1)}${withYear ? "." + d.getFullYear() : ""}`;
  return `${date} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
