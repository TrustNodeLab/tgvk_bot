// Telegram и VK API из Worker + публикация готовых пакетов (с dry-run).
// Всё — чистый HTTP; тяжёлого CPU нет, поэтому влезает в лимиты free-плана.

const TG_API = "https://api.telegram.org/bot";
const VK_API = "https://api.vk.com/method/";
const VK_VERSION = "5.199";

// ---------- низкоуровневые вызовы ----------

export async function tgCall(env, method, params = {}, files = null) {
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
      body: JSON.stringify(params),
    });
  }
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    /* не JSON */
  }
  if (!res.ok || !data.ok) {
    throw new Error(`TG ${method}: ${(data && data.description) || res.status}`);
  }
  return data.result;
}

export async function vkCall(env, method, params = {}) {
  const body = new URLSearchParams({
    access_token: env.VK_TOKEN,
    v: VK_VERSION,
    ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
  });
  const res = await fetch(VK_API + method, { method: "POST", body });
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    /* ignore */
  }
  if (data.error) {
    throw new Error(`VK ${method}: ${data.error.error_code} ${data.error.error_msg}`);
  }
  return data.response;
}

// ---------- Telegram-хелперы (обёртки) ----------

export function sendMessage(env, chatId, text, opts = {}) {
  const params = { chat_id: chatId, text };
  if (opts.parse_mode) params.parse_mode = opts.parse_mode;
  if (opts.reply_markup) params.reply_markup = JSON.stringify(opts.reply_markup);
  if (opts.disable_web_page_preview) params.disable_web_page_preview = true;
  return tgCall(env, "sendMessage", params);
}

export function sendPhoto(env, chatId, bytes, caption, opts = {}) {
  const files = { photo: new Blob([bytes], { type: "image/png" }) };
  const params = { chat_id: chatId };
  if (caption) params.caption = caption;
  if (opts.parse_mode) params.parse_mode = opts.parse_mode;
  if (opts.reply_markup) params.reply_markup = JSON.stringify(opts.reply_markup);
  return tgCall(env, "sendPhoto", params, files);
}

export function editMessageReplyMarkup(env, chatId, messageId, markup = []) {
  return tgCall(env, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: JSON.stringify({ inline_keyboard: markup }),
  });
}

export function answerCallbackQuery(env, id, text) {
  return tgCall(env, "answerCallbackQuery", { callback_query_id: id, text });
}

export function setMyCommands(env, commands) {
  return tgCall(env, "setMyCommands", { commands: JSON.stringify(commands) });
}

export function deleteMessage(env, chatId, messageId) {
  return tgCall(env, "deleteMessage", { chat_id: chatId, message_id: messageId });
}

// ---------- VK: загрузка фото на стену (для групповых токенов) ----------

export async function vkUploadWallPhoto(env, bytes) {
  // Путь «сообщение сообщества» (photos.getMessagesUploadServer + saveMessagesPhoto)
  // доступен групповым токенам, в отличие от getWallUploadServer (error 27).
  const upload = await vkCall(env, "photos.getMessagesUploadServer");
  const fd = new FormData();
  fd.append("photo", new Blob([bytes], { type: "image/png" }), "photo.png");
  let up;
  try {
    const r = await fetch(upload.upload_url, { method: "POST", body: fd });
    up = await r.json();
  } catch (e) {
    up = {};
  }
  if (!up.photo) throw new Error("VK: upload-сервер вернул пустой photo");
  const saved = await vkCall(env, "photos.saveMessagesPhoto", {
    photo: up.photo,
    server: up.server,
    hash: up.hash,
  });
  const p = saved[0];
  return `photo${p.owner_id}_${p.id}`;
}

export async function vkPostWall(env, message, attachment) {
  return vkCall(env, "wall.post", {
    owner_id: -env.VK_GROUP_ID,
    from_group: 1,
    message,
    attachments: attachment,
  });
}

// ---------- публикация готового пакета ----------

// Возвращает Uint8Array/ArrayBuffer PNG-карточки пакета. png в черновиках/складе
// может быть base64-строкой (KV умеет только строки) ИЛИ уже байтами — приводим
// к байтам; если байтов нигде нет — читаем из R2/KV по png_key.
async function pkgBytes(env, pkg) {
  const png = pkg && pkg.png;
  if (png) {
    if (typeof png === "string") {
      const bin = atob(png);
      return Uint8Array.from(bin, (c) => c.charCodeAt(0));
    }
    return png;
  }
  return readPng(env, pkg && pkg.png_key);
}

// Резолвит chat_id канала: просим Telegram подтвердить чат по текущему
// TELEGRAM_CHANNEL_ID, а при фейле пробуем публичный канал TrustNode_team.
// Кэшируем подтверждённый chat_id в KV. Так «chat not found» не роняет посты.
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
      const info = await tgCall(env, "getChat", { chat_id: c });
      const resolved = String(info && (info.id !== undefined ? info.id : c));
      if (env.BOT_KV) await env.BOT_KV.put("telegram_channel_id", resolved);
      return resolved;
    } catch (e) {
      /* пробуем следующий кандидат */
    }
  }
  // fallback: оставляем настройку как есть
  return candidates[0] || String(env.TELEGRAM_CHANNEL_ID || "");
}

// Возвращает { ok:true, channel:"tg"|"vk", note } либо бросает ошибку.
export async function publishToTelegram(env, pkg, dry) {
  const caption = pkg.caption || "";
  const bytes = await pkgBytes(env, pkg);
  const chatId = await resolveTelegramChannel(env);
  if (dry) {
    console.log(`[dry-run] TG sendPhoto -> ${chatId}, len=${bytes?.length || 0}, caption=${caption.length} симв.`);
    return { ok: true, dry: true, target: "tg" };
  }
  const res = await sendPhoto(env, chatId, bytes, caption, { parse_mode: "HTML" });
  return { ok: true, target: "tg", message_id: res && res.message_id };
}

export async function publishToVk(env, pkg, dry) {
  const message =
    (pkg.caption || "").replace(/<[^>]+>/g, "").trim() || pkg.title || "🛡️ TrustNode";
  if (dry) {
    console.log(`[dry-run] VK wall.post message=${message.length} симв.`);
    return { ok: true, dry: true, target: "vk" };
  }
  const bytes = await pkgBytes(env, pkg);
  let attachment = null;
  if (bytes && bytes.length) {
    attachment = await vkUploadWallPhoto(env, bytes);
  } else {
    console.log(`[vk] wall.post без фото: нет PNG (png/png_key пуст) для «${pkg.title || pkg.id}»`);
  }
  const res = await vkPostWall(env, message, attachment);
  return { ok: true, target: "vk", post_id: res && res.post_id };
}

// Читает PNG пакета из R2 (или KV base64), если в пакете только ключ.
async function readPng(env, pngKey) {
  if (!pngKey) return null;
  if (env.BOT_R2) {
    const obj = await env.BOT_R2.get(pngKey);
    if (!obj) return null;
    return new Uint8Array(await obj.arrayBuffer());
  }
  if (env.BOT_KV) {
    const b64 = await env.BOT_KV.get(pngKey);
    if (b64 === null) return null;
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  }
  return null;
}

export async function readFileBytes(env, key) {
  return readPng(env, key);
}
