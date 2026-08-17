// Обработка текста поста: нормализация блоков, подгонка под лимит caption TG,
// футер с логотипом. Портировано из bot/main.py.

import { POST_FOOTER, TG_CAPTION_LIMIT, MSK_OFFSET_MIN } from "./config.js";

const BLOCK_HEADS = ["🔍", "📌", "⚠", "🛡", "💡"];

// VK не рендерит HTML: caption для него конвертируется в плоский текст.
// Ключевое — ссылка источника `<a href="URL">ссылка</a>` должна остаться URL,
// а не превратиться в слово «ссылка».
export function htmlToPlain(html) {
  return String(html || "")
    .replace(/<a\s+[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, url, label) => {
      const text = String(label || "").replace(/<[^>]+>/g, "").trim();
      return text && text !== "ссылка" && text !== "источник" ? `${text}: ${url}` : url;
    })
    .replace(/<[^>]+>/g, "")
    .trim();
}

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
  // Отделяем футер (и POST_FOOTER, и FOOTER_HTML из llm.js) по маркеру TrustNode.
  let body = caption;
  let footer = "";
  const fIdx = body.lastIndexOf("TrustNode");
  if (fIdx >= 0) {
    const blockStart = body.lastIndexOf("\n\n", fIdx);
    if (blockStart >= 0) {
      footer = body.slice(blockStart + 2);
      body = body.slice(0, blockStart).trimEnd();
    }
  }
  // Строку «Источник: <a…>» тоже бережём: она завершает пост и терять её нельзя.
  // Отделяем её от тела и прикрепляем к футеру — при нехватке места режется
  // середина (абзацы), а не подпись источника.
  let source = "";
  const srcMatch = body.match(/\n\s*\n(Источник:\s*<a[^>]*>.*)$/s);
  if (srcMatch) {
    source = srcMatch[1];
    body = body.slice(0, srcMatch.index).trimEnd();
  }
  const budget = limit - footer.length - source.length - 2; // -2 разделитель "\n\n"
  if (budget <= 30) return footer ? "\n\n" + (source ? source + "\n\n" + footer : footer) : caption.slice(0, limit - 1) + "…";
  // Режем по абзацам (двойной перенос), а не по символу — HTML-теги (<a href>, <b>)
  // целиком сохраняются, ссылки не рвутся. Неуместившиеся абзацы отбрасываются;
  // многоточие НЕ ставим — перед футером оно выглядит как обрыв по вине бота.
  const paras = body.split(/\n\s*\n/).filter((p) => p.trim());
  let out = "";
  for (const p of paras) {
    const candidate = out ? out + "\n\n" + p : p;
    if (candidate.length > budget) {
      if (!out) {
        // Даже первый абзац не влез — режем по слову, но без «…» перед футером.
        out = body.slice(0, budget - 1).trimEnd();
      }
      break;
    }
    out = candidate;
  }
  if (!out.trim()) out = body.slice(0, budget - 1).trimEnd();
  const tail = source ? "\n\n" + source + "\n\n" + footer : "\n\n" + footer;
  return (out + tail).trimEnd().slice(0, limit);
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

// Форматирование timestamp для сводок. Все метки в боте — UTC (ISO),
// но админу показываем всегда в МСК: на воркере (UTC) локальные геттеры
// сдвигали время на −3 часа и «следующий слот 18:00» выглядел как «15:00».
export function fmtTime(iso, withYear = false) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const msk = new Date(d.getTime() + MSK_OFFSET_MIN * 60 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  const date = `${p(msk.getUTCDate())}.${p(msk.getUTCMonth() + 1)}${withYear ? "." + msk.getUTCFullYear() : ""}`;
  return `${date} ${p(msk.getUTCHours())}:${p(msk.getUTCMinutes())}`;
}
