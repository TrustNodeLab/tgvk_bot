// Превью-поток «генерация -> карточка -> кнопки одобрения» без GitHub.
// Используется и при ручном вводе текста админом, и при автогенерации из тика.

import * as kv from "./kv.js";
import { generatePostData } from "./llm.js";
import { renderCard } from "./cardgen.js";
import { sendPhoto } from "./telegram.js";

// Инлайн-кнопки есть ТОЛЬКО на превью постов на одобрение.
// Публикация: везде / только VK / только TG.
export function approveButtons(id) {
  return [
    [
      { text: "🌐 Опубликовать везде", callback_data: `approve:${id}:all` },
      { text: "🔵 В VK", callback_data: `approve:${id}:vk` },
      { text: "🟢 В TG", callback_data: `approve:${id}:tg` },
    ],
    [
      { text: "🔄 Переделать", callback_data: `redo:${id}` },
      { text: "❌ Отменить", callback_data: `cancel:${id}` },
    ],
  ];
}

function bytesToBase64(bytes) {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

export function sourceDomain(link) {
  try {
    return String(new URL(link).hostname).replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}

// Карточку рисуем на Python-сервисе рендера (PIL + Exo2/Jura + небо Москвы),
// если задан CARD_RENDER_URL. Иначе — встроенный JS-рендер (фолбэк).
async function renderCardBytes(env, data, meta = {}) {
  if (env.CARD_RENDER_URL) {
    try {
      const res = await fetch(`${String(env.CARD_RENDER_URL).replace(/\/+$/, "")}/render`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          headline: data.headline_lines && data.headline_lines.length ? data.headline_lines : data.headline,
          caption: data.caption,
          cards: data.cards || [],
          tier: data.tier || "news",
          source: data.source || meta.source || sourceDomain(meta.link || ""),
          link: meta.link || "",
        }),
        signal: AbortSignal.timeout(90000),
      });
      if (res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > 100) return bytes;
      }
    } catch (e) {
      console.log("[preview] render-service недоступен, JS-фолбэк:", e.message);
    }
  }
  return renderCard(data);
}

// Генерит текст+карточку, шлёт превью с кнопками и сохраняет черновик.
export async function sendGeneratedPreview(env, chatId, text, meta = {}) {
  const data = await generatePostData(text, env, { ...meta, text });
  const png = await renderCardBytes(env, data, meta);
  const id = `m${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const b64 = bytesToBase64(png);

  const sent = await sendPhoto(env, chatId, png, data.caption, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: approveButtons(id) },
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
    created_at: new Date().toISOString(),
  };
  if (meta.provider) draft.provider = meta.provider;
  await kv.saveDraft(env, draft);
  return data;
}
