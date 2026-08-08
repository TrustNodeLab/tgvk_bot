// Telegram и VK API из Worker + публикация готовых пакетов (с dry-run).
// Всё — чистый HTTP; тяжёлого CPU нет, поэтому влезает в лимиты free-плана.

const TG_API = "https://api.telegram.org/bot";
const VK_API = "https://api.vk.com/method/";
const VK_VERSION = "5.199";

import { pngToGif } from "./cardgen.js";
import { fitCaption } from "./text.js";

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
    const code = data.error.error_code;
    const msg = data.error.error_msg || "";
    // Человекочитаемые сообщения для типичных проблем с правами/токеном.
    if (code === 5) {
      throw new Error("VK access token недействителен или истёк (error 5)");
    }
    if (code === 27) {
      throw new Error("VK access token не имеет необходимых прав для загрузки фото/публикации (error 27)");
    }
    if (code === 9 || code === 6) {
      throw new Error(`VK rate limit (error ${code}): ${msg}`);
    }
    throw new Error(`VK ${method}: ${code} ${msg}`);
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

export function forwardMessage(env, chatId, fromChatId, messageId) {
  return tgCall(env, "forwardMessage", {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId,
  });
}

export async function downloadFile(env, fileId) {
  const f = await tgCall(env, "getFile", { file_id: fileId });
  const path = f && f.file_path;
  if (!path) throw new Error("file_path пуст");
  const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${path}`);
  if (!res.ok) throw new Error(`download file failed: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ---------- VK: загрузка фото на стену (для групповых токенов) ----------

export async function vkUploadWallPhoto(env, bytes) {
  // Путь «сообщение сообщества» (photos.getMessagesUploadServer + saveMessagesPhoto)
  // доступен групповым токенам, в отличие от getWallUploadServer (error 27).
  // VK upload-сервер транзиентно отклоняет картинку («пустой photo») — ретраим
  // с экспоненциальным бэкоффом и пере-запросом upload_url, как в GH-контуре.
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
        hash: up.hash,
      });
      const p = saved[0];
      return `photo${p.owner_id}_${p.id}`;
    }
    lastErr = `VK: upload-сервер вернул пустой photo (${JSON.stringify(up).slice(0, 200)})`;
    if (attempt < MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw new Error(lastErr);
}

export async function vkPostWall(env, message, attachment) {
  return vkCall(env, "wall.post", {
    owner_id: -env.VK_GROUP_ID,
    from_group: 1,
    message,
    attachments: attachment,
  });
}

// Загрузка изображения как GIF-документа на стену сообщества и возврат attachment
// `doc{owner_id}_{id}`. VK рендерит GIF-документ (doc, type=3) в посте встроенной
// картинкой, тогда как PNG/JPEG-документ показывает файлом-иконкой. Групповому
// токену недоступны photos.save* (error 27), поэтому docs-путь — единственный
// рабочий способ показать картинку в посте токеном сообщества.
export async function vkUploadWallGif(env, gifBytes) {
  const MAX_ATTEMPTS = 4;
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const dws = await vkCall(env, "docs.getWallUploadServer", { group_id: env.VK_GROUP_ID });
    if (!dws || !dws.upload_url) {
      lastErr = "VK: docs.getWallUploadServer не вернул upload_url";
      if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
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
          Accept: "*/*",
        },
      });
      bodyText = await resp.text();
    } catch (e) {
      bodyText = "";
      lastErr = `VK: gif upload fetch error: ${e.message}`;
      if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    let ur = null;
    try { ur = JSON.parse(bodyText); } catch (e) { ur = null; }
    if (!ur || !ur.file) {
      lastErr = `VK: gif upload вернул без file (${bodyText.slice(0, 120)})`;
      if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    const saved = await vkCall(env, "docs.save", { file: ur.file });
    const wrap = Array.isArray(saved) ? saved[0] : saved;
    const doc = (wrap && (wrap.doc || wrap)) || null;
    if (!doc || !doc.id) {
      lastErr = `VK: docs.save вернул без doc (${JSON.stringify(saved).slice(0, 200)})`;
      if (attempt < MAX_ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    return `doc${doc.owner_id}_${doc.id}`;
  }
  throw new Error(lastErr || "VK: gif upload не удался");
}

// Загрузка фото в альбом сообщества (photos.getUploadServer+photos.save) и
// возврат attachment `photo{owner_id}_{id}`. Это VK-нативное фото: VK сам
// хранит его в публичном альбоме сообщества, поэтому wall.post его покажет.
// Требует album_id и прав photos; для группового токена возможно error 27.
export async function vkUploadAlbumPhoto(env, bytes, albumId) {
  const upload = await vkCall(env, "photos.getUploadServer", {
    album_id: albumId,
    group_id: env.VK_GROUP_ID,
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
    throw new Error(`VK: album upload-сервер вернул пустой photos_list (${JSON.stringify(up).slice(0, 200)})`);
  }
  const saved = await vkCall(env, "photos.save", {
    album_id: albumId,
    group_id: env.VK_GROUP_ID,
    server: up.server,
    photos_list: up.photos_list,
    hash: up.hash,
  });
  const p = saved[0];
  return `photo${p.owner_id}_${p.id}`;
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
    if (png instanceof Uint8Array || png instanceof ArrayBuffer) return png;
    if (Array.isArray(png) || typeof png === "object") {
      // KV хранит только строки: байты карточки сериализуются в JSON-массив
      // {"0":137,"1":80,...}. Превращаем обратно в байты.
      const vals = Array.isArray(png) ? png : Object.values(png);
      return Uint8Array.from(vals, (b) => Number(b) & 0xff);
    }
    return png;
  }
  return readPng(env, pkg && pkg.png_key);
}

// Резолвит chat_id канала: просим Telegram подтвердить чат по текущему
// TELEGRAM_CHANNEL_ID, а при фейле пробуем публичный канал TrustNode_team.
// Кэшируем подтверждённый chat_id в KV. Так «chat not found» не роняет посты.
export async function resolveTelegramChannel(env) {
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

// Загружает PNG-карточку на GitHub (data/cards/<key>.png) и возвращает публичный
// URL raw.githubusercontent.com. Приоритет GitHub: VK-краулер достукивается до
// него, тогда как *.workers.dev закрыт Cloudflare WAF (error 1010) для
// не-браузерных клиентов — именно поэтому ссылки на worker падают с
// link_photo_sizing_rule («No photo given»).
async function storeCardPublic(env, key, bytes) {
  const ghUrl = await uploadCardToGithub(env, key, bytes);
  if (ghUrl) return ghUrl;

  // Фолбэк: R2 (или base64 в KV) + BOT_PUBLIC_URL. Работает только если
  // Cloudflare WAF пропускает бота (отключён Bot Fight Mode / свой домен).
  const fullKey = `files/${key}`;
  if (env.BOT_R2) {
    await env.BOT_R2.put(fullKey, bytes, { httpMetadata: { contentType: "image/png" } });
  } else if (env.BOT_KV) {
    await env.BOT_KV.put(fullKey, bytesToBase64(bytes));
  } else {
    throw new Error("VK: нет хранилища для публичной карточки (BOT_R2/BOT_KV/GitHub)");
  }
  const base = (env.BOT_PUBLIC_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("VK: BOT_PUBLIC_URL не задан — карточку не постим ссылкой");
  return `${base}/${fullKey}`;
}

// PUT файла на GitHub через Contents API (ветка main), возвращает raw-URL.
async function uploadCardToGithub(env, key, bytes) {
  const { GITHUB_TOKEN, OWNER, REPO } = env;
  if (!GITHUB_TOKEN || !OWNER || !REPO) return null;
  const path = `data/${key}`; // data/cards/<id>.png — как в GH-контуре
  const api = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "tgvk-bot-webhook",
  };
  let sha = null;
  try {
    const ex = await fetch(api, { headers });
    if (ex.ok) {
      const j = await ex.json();
      if (j && j.sha) sha = j.sha;
    }
  } catch (e) { /* карточки ещё нет — создаём */ }
  try {
    const res = await fetch(api, {
      method: "PUT",
      headers,
      body: JSON.stringify({ message: `card ${key}`, content: bytesToBase64(bytes), ...(sha ? { sha } : {}) }),
    });
    if (!res.ok) {
      console.log(`[vk] GitHub upload ${path} failed: ${res.status}`);
      return null;
    }
  } catch (e) {
    console.log(`[vk] GitHub upload ${path} exception: ${e.message}`);
    return null;
  }
  return `https://raw.githubusercontent.com/${OWNER}/${REPO}/main/${path}`;
}

// ---------- HTML-страницa превью для VK (meta og:image) ----------

// HTML с og:image: VK строит превью по ссылке из meta-тегов страницы, а не из
// сырого PNG-файла (сырой PNG даёт link_photo_sizing_rule). Экранируем атрибуты.
function buildCardHtml({ ogImage, title, description }) {
  const esc = (s) =>
    (s || "").replace(/[<>&"]/g, (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[m]));
  const safeTitle = esc(title).slice(0, 120) || "TrustNode";
  const safeDesc = esc(description).slice(0, 160);
  const safeImg = esc(ogImage);
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<meta property="og:title" content="${safeTitle}">
<meta property="og:description" content="${safeDesc || "TrustNode — сигналы и аналитика."}">
<meta property="og:type" content="article">
<meta property="og:image" content="${safeImg}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
</head>
<body>
<img src="${safeImg}" alt="${safeTitle}" style="max-width:100%;height:auto;">
</body>
</html>`;
}

// Загружает HTML-страницу data/cards/<name>.html на GitHub (ветка main) через
// Contents API и возвращает публичный Pages-URL вида
// https://<owner>.github.io/<repo>/data/cards/<name>.html. NULL при неудаче.
async function uploadCardHtmlToGithub(env, name, html) {
  const { GITHUB_TOKEN, OWNER, REPO } = env;
  if (!GITHUB_TOKEN || !OWNER || !REPO) return null;
  const path = `data/cards/${name}.html`;
  const api = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "tgvk-bot-webhook",
  };
  let sha = null;
  try {
    const ex = await fetch(api, { headers });
    if (ex.ok) {
      const j = await ex.json();
      if (j && j.sha) sha = j.sha;
    }
  } catch (e) { /* нет файла — создаём */ }
try {
    const res = await fetch(api, {
      method: "PUT",
      headers,
body: JSON.stringify({ message: `card ${name}.html`, content: bytesToBase64(html), ...(sha ? { sha } : {}) }),
    });
    if (!res.ok) {
      console.log(`[vk] GitHub html upload ${path} failed: ${res.status}`);
      return null;
    }
  } catch (e) {
    console.log(`[vk] GitHub html upload ${path} exception: ${e.message}`);
    return null;
  }
  return `https://${OWNER}.github.io/${REPO}/${path}`;
}

// Хелпер: кладёт HTML карточки рядом с PNG (страница превью для VK).
async function ensureCardHtml(env, name, pngUrl, description, title) {
  const html = buildCardHtml({ ogImage: pngUrl, title, description });
  const htmlUrl = await uploadCardHtmlToGithub(env, name, html);
  return htmlUrl || null;
}

function bytesToBase64(bytes) {
  let bin = "";
  const arr = Array.isArray(bytes) ? bytes : Array.from(bytes || []);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

// Возвращает { ok:true, channel:"tg"|"vk", note } либо бросает ошибку.
export async function publishToTelegram(env, pkg, dry) {
  const caption = fitCaption(pkg.caption || "");
  const bytes = await pkgBytes(env, pkg);
  if (!bytes || !bytes.length) {
    throw new Error("нет PNG-карточки для TG (png/png_key пуст)");
  }
  assertValidImage(bytes);
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

  // Idempotency: если этот пост (по id/guid) уже успешно ушёл в VK, не постим
  // повторно. Защита от дублей при timeout/ретрае (см. процессVkRetries).
  const dedupKey = String(pkg.guid || pkg.id || "");
  if (dedupKey) {
    try {
      const prev = await env.BOT_KV.get(`vk_posted:${dedupKey}`, "json");
      if (prev && prev.post_id) {
        console.log(`[vk] уже опубликован post=${prev.post_id}, повторная публикация пропущена: ${pkg.title || pkg.id}`);
        return { ok: true, target: "vk", post_id: prev.post_id, vk_attachment: prev.vk_attachment, deduped: true };
      }
    } catch (e) { /* если KV недоступен — публикуем */ }
  }

  // Фото в пост VK для community-токена напрямую не загрузить (error 27 на
  // photos.getWallUploadServer / saveWallPhoto / альбом; saveMessagesPhoto кладёт
  // фото в приватный messages-альбом → на стене не рендерится). Рабочий путь,
  // доказанный тестами на этой группе: конвертируем PNG-карточку в индексированный
  // GIF и загружаем его как ДОКУМЕНТ (docs.getWallUploadServer → docs.save).
  // VK рендерит GIF-документ (doc, type=3) в посте ВСТРОЕННОЙ картинкой.
  const bytes = await pkgBytes(env, pkg);
  if (!bytes || !bytes.length) {
    throw new Error("нет PNG-карточки для VK (png/png_key пуст)");
  }
  assertValidImage(bytes);

  console.log("[vk] PNG → GIF…");
  const gifBytes = await pngToGif(bytes);
  console.log(`[vk] GIF готов: ${gifBytes.length} байт`);

  console.log("[vk] docs.getWallUploadServer + upload + docs.save…");
  const attachment = await vkUploadWallGif(env, gifBytes);
  console.log(`[vk] doc прикреплён: ${attachment}`);

  console.log("[vk] wall.post…");
  const res = await vkPostWall(env, message, attachment);
  const postId = res && res.post_id;
  console.log(`[vk] wall.post успешен: post=${postId}`);
  if (dedupKey && postId) {
    try {
      await env.BOT_KV.put(`vk_posted:${dedupKey}`, JSON.stringify({ post_id: postId, vk_attachment: attachment, at: new Date().toISOString() }));
    } catch (e) { /* ignore */ }
  }
  return { ok: true, target: "vk", post_id: postId, vk_attachment: attachment };
}

// Проверка, что карточка — валидное изображение (PNG или JPEG), по magic-байтам.
// Путь «нет карточки» и «битая карточка» = отказ публикации, без постов-пустышек.
export function assertValidImage(bytes) {
  if (!bytes || bytes.length < 8) {
    throw new Error("VK: карточка пустая или слишком маленькая, чтобы быть изображением");
  }
  const b = bytes;
  const isPng =
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && // .PNG
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;
  const isJpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (!isPng && !isJpeg) {
    throw new Error("VK: файл не является изображением (ожидался PNG или JPEG)");
  }
}

// Читает PNG пакета из R2 (или KV base64), если в пакете только ключ.
// Ключи от Python-бота приходят как "drafts/<id>.png", а загрузчик /files/*
// хранит их под "files/drafts/<id>.png" — пробуем оба варианта.
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

export async function readFileBytes(env, key) {
  return readPng(env, key);
}
