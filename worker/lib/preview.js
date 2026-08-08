// Превью-поток «генерация -> карточка -> кнопки одобрения» без GitHub.
// Используется и при ручном вводе текста админом, и при автогенерации из тика.

import * as kv from "./kv.js";
import { generatePostData } from "./llm.js";
import { renderCard } from "./cardgen.js";
import { sendCard } from "./telegram.js";

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

// Карточку рисуем на Python-сервисе рендера (PIL + Exo2/Jura + небо Москвы).
// Рендеров может быть несколько (основной + резервный на HF Spaces и т.п.) —
// перебираем по очереди до первого успеха. format: "png"|"gif" (анимация неба).
// Если все рендеры недоступны — встроенный JS-рендер (фолбэк, статичный PNG).
export async function renderCardBytes(env, data, meta = {}) {
  // Приоритет формата: явный meta.format (для конкретного поста) > настройка
  // card_format в state (auto|gif|png). "auto" = GIF когда есть рендер-сервис,
  // PNG когда он недоступен (JS-фолбэк не умеет анимацию).
  let format;
  if (meta.format === "gif" || meta.format === "png") {
    format = meta.format;
  } else {
    try {
      format = await kv.getCardFormat(env);
    } catch (e) {
      format = "auto";
    }
  }
  const wantGif = format !== "png"; // "gif" и "auto" запрашивают GIF
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
          frames: meta.frames || 12,
        }),
        signal: AbortSignal.timeout(90000),
      });
      if (res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length > 100) return bytes;
      }
    } catch (e) {
      console.log(`[preview] render-service ${base} недоступен, пробую следующий:`, e.message);
    }
  }
  console.log("[preview] все рендер-сервисы недоступны, JS-фолбэк");
  return renderCard(data);
}

// Генерит текст+карточку (данные, PNG, base64) без отправки — переиспользуется
// и превью-потоком, и автопостингом в воркере (склад по слотам).
export async function buildCardPackage(env, text, meta = {}) {
  const data = await generatePostData(text, env, { ...meta, text });
  const png = await renderCardBytes(env, data, meta);
  const b64 = bytesToBase64(png);
  return { data, png, b64 };
}

// Генерит текст+карточку, шлёт превью с кнопками и сохраняет черновик.
export async function sendGeneratedPreview(env, chatId, text, meta = {}) {
  const { data, png, b64 } = await buildCardPackage(env, text, meta);
  const id = `m${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

  const sent = await sendCard(env, chatId, png, data.caption, {
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
