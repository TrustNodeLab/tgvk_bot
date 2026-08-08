// Пользовательский контур: меню обычных пользователей, предложка постов/рекламы
// на одобрение админу, поддержка с reply-механикой и создание ивентов админом
// пошаговым диалогом (текст + время). Работает целиком в Worker.

import * as kv from "./kv.js";
import {
  sendMessage, sendPhoto, editMessageReplyMarkup,
  answerCallbackQuery, downloadFile, vkCall, resolveTelegramChannel,
} from "./telegram.js";
import { mskNow } from "./config.js";
import { mskToUtcMs } from "./scheduler.js";
import { fmtTime, escHtml } from "./text.js";

// ---------- меню пользователя ----------

export const USER_MENU_KB = [
  [
    { text: "📮 Предложить пост/рекламу", callback_data: "user:suggest" },
    { text: "💬 Поддержка", callback_data: "user:support" },
  ],
  [{ text: "📖 О боте", callback_data: "user:about" }],
];

const USER_WELCOME =
  "🛡️ <b>TrustNode — SMM-студия</b>\n\n" +
  "Привет! Здесь можно предложить пост или рекламу для публикации, " +
  "а также написать в поддержку.\n\n" +
  "• 📮 <b>Предложить пост/рекламу</b> — текст уйдёт администратору на одобрение\n" +
  "• 💬 <b>Поддержка</b> — вопрос уйдёт администратору, ответ придёт сюда\n\n" +
  "Отправьте /start, чтобы вернуться в меню.";

const USER_ABOUT =
  "🛡️ <b>TrustNode</b> — студия цифровой безопасности.\n\n" +
  "Публикуем новости, аналитику и разборы мошеннических схем в Telegram и VK.\n\n" +
  "📮 Предложить пост — отправьте текст или фото рекламы/новости, " +
  "администратор опубликует её после проверки.\n" +
  "💬 Поддержка — напишите вопрос, ответ придёт в этот чат.\n\n" +
  "Меню: /start";

// ---------- парсинг времени ивента ----------

function parseTimeInput(input, now = new Date()) {
  const m = String(input || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  const msk = mskNow(now);
  const target = h * 60 + min;
  let ts = mskToUtcMs(msk.dow, target, now);
  if (ts < now.getTime()) {
    const nextDow = (msk.dow + 1) % 7;
    ts = mskToUtcMs(nextDow, target, now);
  }
  return ts;
}

// ---------- ивент-диалог (админ) ----------

export async function startEventDialog(env, chatId) {
  await kv.setEventDialog(env, { step: "text", chat_id: chatId });
  await sendMessage(
    env,
    chatId,
    "🎪 <b>Создание ивента</b>\n\nШаг 1/2. Пришлите текст ивента (например, «Вебинар по цифровой безопасности»).\n\n/cancel — отмена.",
    { parse_mode: "HTML" }
  );
}

export async function handleEventDialogMessage(env, msg) {
  const dialog = await kv.getEventDialog(env);
  if (!dialog) return false;
  const chatId = msg.chat ? msg.chat.id : null;
  if (!chatId || String(chatId) !== String(dialog.chat_id)) return false;

  const text = (msg.text || "").trim();
  if (!text) {
    await sendMessage(env, chatId, "Пришлите текст сообщением, пожалуйста.");
    return true;
  }

  if (text.toLowerCase() === "/cancel") {
    await kv.setEventDialog(env, null);
    await sendMessage(env, chatId, "Отменено.");
    return true;
  }

  if (dialog.step === "text") {
    await kv.setEventDialog(env, { ...dialog, step: "time", text });
    await sendMessage(
      env,
      chatId,
      "🎪 Шаг 2/2. Когда публикуем ивент?\n\nПришлите время в формате <b>ЧЧ:ММ</b> (МСК).\n\n/cancel — отмена.",
      { parse_mode: "HTML" }
    );
    return true;
  }

  if (dialog.step === "time") {
    const ts = parseTimeInput(text);
    if (ts === null) {
      await sendMessage(
        env,
        chatId,
        "Не понял время. Пришлите в формате <b>ЧЧ:ММ</b> (МСК), например 18:30.",
        { parse_mode: "HTML" }
      );
      return true;
    }
    const id = `evt${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
    await kv.addStock(env, {
      id,
      kind: "event",
      title: dialog.text.slice(0, 80),
      caption: dialog.text,
      guid: "",
      link: "",
      scheduled_for: ts,
      created_at: new Date().toISOString(),
      from_admin: true,
    });
    await kv.setEventDialog(env, null);
    const when = fmtTime(new Date(ts).toISOString());
    await sendMessage(
      env,
      chatId,
      `✅ <b>Ивент запланирован</b>\n\n${escHtml(dialog.text)}\n\n⏰ Публикация: <b>${when}</b> (МСК)`,
      { parse_mode: "HTML" }
    );
    return true;
  }

  return false;
}

// ---------- пользовательский поток ----------

async function sendUserMenu(env, chatId) {
  await sendMessage(env, chatId, USER_WELCOME, {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: USER_MENU_KB },
  });
}

export async function handleUserStart(env, chatId) {
  await kv.setUserMode(env, chatId, null);
  await sendUserMenu(env, chatId);
}

export async function handleUserCallback(env, cq) {
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : null;
  const msgId = cq.message ? cq.message.message_id : null;
  const qid = cq.id;
  const data = cq.data || "";
  const segs = data.split(":");
  const action = segs[1] || "";

  if (action === "suggest") {
    await kv.setUserMode(env, chatId, "suggest");
    await editMessageReplyMarkup(env, chatId, msgId, []);
    await sendMessage(
      env,
      chatId,
      "📮 <b>Предложить пост/рекламу</b>\n\nПришлите текст (или фото с подписью). Администратор проверит и опубликует после одобрения.\n\n/cancel — вернуться в меню.",
      { parse_mode: "HTML" }
    );
    try { await answerCallbackQuery(env, qid, "Режим предложки"); } catch (e) { /* ignore */ }
    return;
  }

  if (action === "support") {
    await kv.setUserMode(env, chatId, "support");
    await editMessageReplyMarkup(env, chatId, msgId, []);
    await sendMessage(
      env,
      chatId,
      "💬 <b>Поддержка</b>\n\nОпишите ваш вопрос — администратор ответит в этот чат.\n\n/cancel — вернуться в меню.",
      { parse_mode: "HTML" }
    );
    try { await answerCallbackQuery(env, qid, "Режим поддержки"); } catch (e) { /* ignore */ }
    return;
  }

  if (action === "about") {
    await editMessageReplyMarkup(env, chatId, msgId, []);
    await sendMessage(env, chatId, USER_ABOUT, { parse_mode: "HTML" });
    try { await answerCallbackQuery(env, qid, "О боте"); } catch (e) { /* ignore */ }
    return;
  }

  try { await answerCallbackQuery(env, qid, "Неизвестная кнопка"); } catch (e) { /* ignore */ }
}

function bytesToBase64(bytes) {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

// ---------- предложка ----------

export function suggestionButtons(id) {
  return [
    [
      { text: "🌐 Опубликовать везде", callback_data: `sugg:approve:all:${id}` },
      { text: "🔵 VK", callback_data: `sugg:approve:vk:${id}` },
      { text: "🟢 TG", callback_data: `sugg:approve:tg:${id}` },
    ],
    [{ text: "❌ Отклонить", callback_data: `sugg:reject:${id}` }],
  ];
}

export async function handleSuggestion(env, msg) {
  const chatId = msg.chat ? msg.chat.id : null;
  if (!chatId) return;
  const id = `s${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const username = (msg.from && (msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || ""))) || "";
  const text = (msg.caption || msg.text || "").trim();

  let photo = null;
  let bytes = null;
  if (msg.photo && msg.photo.length) {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    try {
      bytes = await downloadFile(env, fileId);
      photo = bytesToBase64(bytes);
    } catch (e) {
      /* фото не скачалось — предложка уйдёт текстом */
    }
  }

  const sug = { id, user_chat_id: chatId, username, text, photo, created_at: new Date().toISOString() };
  await kv.addSuggestion(env, sug);

  let sent = null;
  try {
    if (bytes) {
      sent = await sendPhoto(
        env,
        env.TELEGRAM_ADMIN_CHAT_ID,
        bytes,
        `📮 <b>Предложка от ${escHtml(username)}</b>\n\n${escHtml(text) || "—"}`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: suggestionButtons(id) } }
      );
    } else {
      sent = await sendMessage(
        env,
        env.TELEGRAM_ADMIN_CHAT_ID,
        `📮 <b>Предложка от ${escHtml(username)}</b>\n\n${escHtml(text) || "(без текста)"}`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: suggestionButtons(id) } }
      );
    }
    await kv.addSuggestion(env, { ...sug, admin_msg_id: sent && sent.message_id });
  } catch (e) {
    console.log("[support] forward suggestion failed:", e.message);
  }

  await sendMessage(env, chatId, "✅ Спасибо! Ваша предложка ушла администратору на проверку.");
}

async function publishSuggestion(env, sug, target, dry) {
  const caption = (sug.text || "").trim();
  const channel = await resolveTelegramChannel(env);
  let tgOk = false;
  let vkOk = false;
  let tgErr = null;
  let vkErr = null;
  const plain = caption.replace(/<[^>]+>/g, "").trim();

  if (target !== "vk") {
    try {
      if (dry) {
        console.log(`[dry-run] TG suggestion -> ${channel}`);
      } else if (sug.photo) {
        const bytes = decodeBytes(sug.photo);
        await sendPhoto(env, channel, bytes, caption, { parse_mode: "HTML" });
      } else {
        await sendMessage(env, channel, caption, { parse_mode: "HTML" });
      }
      tgOk = true;
    } catch (e) { tgErr = e.message; }
  }

  if (target !== "tg") {
    try {
      if (dry) {
        console.log(`[dry-run] VK suggestion wall.post (${plain.length} симв.)`);
      } else {
        await vkCall(env, "wall.post", { owner_id: -env.VK_GROUP_ID, from_group: 1, message: plain });
      }
      vkOk = true;
    } catch (e) { vkErr = e.message; }
  }

  if (!tgOk && !vkOk) throw new Error(`suggestion publish failed tg=[${tgErr}] vk=[${vkErr}]`);
  await kv.addLog(env, {
    id: sug.id,
    kind: "suggestion",
    title: caption.slice(0, 80) || "Предложка",
    guid: "",
    link: "",
    source: sug.username || "",
    published_at: new Date().toISOString(),
    caption,
    tg_ok: tgOk,
    vk_ok: vkOk,
    tg_err: tgErr,
    vk_err: vkErr,
    target,
  });
}

function decodeBytes(b64) {
  if (!b64) return null;
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function handleSuggestionCallback(env, cq) {
  const chatId = cq.message && cq.message.chat ? cq.message.chat.id : null;
  const msgId = cq.message ? cq.message.message_id : null;
  const qid = cq.id;
  const data = cq.data || "";
  const segs = data.split(":");
  const id = segs[3] || "";
  const target = segs[2] || "all";

  if (!id) {
    try { await answerCallbackQuery(env, qid, "Неизвестная предложка"); } catch (e) { /* ignore */ }
    return;
  }

  const list = await kv.getSuggestions(env);
  const sug = list.find((s) => s.id === id);
  if (!sug) {
    try { await answerCallbackQuery(env, qid, "Предложка уже обработана"); } catch (e) { /* ignore */ }
    return;
  }

  if (segs[1] === "reject") {
    await kv.removeSuggestion(env, id);
    try { await editMessageReplyMarkup(env, chatId, msgId, []); } catch (e) { /* ignore */ }
    try { await answerCallbackQuery(env, qid, "Предложка отклонена"); } catch (e) { /* ignore */ }
    try {
      await sendMessage(env, sug.user_chat_id, "❌ К сожалению, ваша предложка не подошла. Спасибо, что написали!");
    } catch (e) { /* ignore */ }
    return;
  }

  if (segs[1] === "approve") {
    const state = await kv.loadState(env);
    const dry = !!state.dry_run;
    try {
      await publishSuggestion(env, sug, target, dry);
      await kv.removeSuggestion(env, id);
      try { await editMessageReplyMarkup(env, chatId, msgId, []); } catch (e) { /* ignore */ }
      const label = target === "vk" ? "в VK" : target === "tg" ? "в TG" : "в VK и TG";
      try { await answerCallbackQuery(env, qid, `✅ Опубликовано ${label}`); } catch (e) { /* ignore */ }
      try {
        await sendMessage(env, sug.user_chat_id, "✅ Ваша предложка опубликована! Спасибо за вклад.");
      } catch (e) { /* ignore */ }
    } catch (e) {
      try { await answerCallbackQuery(env, qid, `Ошибка: ${e.message.slice(0, 90)}`); } catch (e2) { /* ignore */ }
      try {
        await sendMessage(
          env,
          env.TELEGRAM_ADMIN_CHAT_ID,
          `⚠️ Не удалось опубликовать предложку от ${escHtml(sug.username || "")}: ${escHtml(e.message)}`
        );
      } catch (e2) { /* ignore */ }
    }
    return;
  }

  try { await answerCallbackQuery(env, qid, "Неизвестная кнопка"); } catch (e) { /* ignore */ }
}

// ---------- поддержка (reply-механика) ----------

export async function handleSupportMessage(env, msg) {
  const chatId = msg.chat ? msg.chat.id : null;
  if (!chatId) return;
  const username = (msg.from && (msg.from.username ? `@${msg.from.username}` : (msg.from.first_name || ""))) || "";

  let sent = null;
  try {
    if (msg.photo && msg.photo.length) {
      const bytes = await downloadFile(env, msg.photo[msg.photo.length - 1].file_id);
      sent = await sendPhoto(
        env,
        env.TELEGRAM_ADMIN_CHAT_ID,
        bytes,
        `💬 <b>Поддержка от ${escHtml(username)}</b>\n\n${escHtml(msg.caption || "(без текста)")}\n\nОтветьте реплаем — сообщение уйдёт пользователю.`,
        { parse_mode: "HTML" }
      );
    } else {
      sent = await sendMessage(
        env,
        env.TELEGRAM_ADMIN_CHAT_ID,
        `💬 <b>Поддержка от ${escHtml(username)}</b>\n\n${escHtml(msg.text || "(без текста)")}\n\nОтветьте реплаем — сообщение уйдёт пользователю.`,
        { parse_mode: "HTML" }
      );
    }
    if (sent && sent.message_id) {
      await kv.setSupportFwd(env, sent.message_id, chatId);
    }
  } catch (e) {
    console.log("[support] forward support message failed:", e.message);
  }

  await sendMessage(env, chatId, "✅ Ваше сообщение ушло в поддержку. Ответ придёт в этот чат.");
}

// Ответ админа реплаем на пересланное сообщение -> уходит пользователю.
export async function handleAdminSupportReply(env, msg) {
  const chatId = msg.chat ? msg.chat.id : null;
  if (!chatId) return false;
  const reply = msg.reply_to_message;
  if (!reply) return false;
  const userChatId = await kv.getSupportFwd(env, reply.message_id);
  if (!userChatId) return false;

  const text = (msg.text || msg.caption || "").trim();
  if (!text) return false;
  try {
    await sendMessage(env, userChatId, `💬 <b>Ответ поддержки</b>\n\n${escHtml(text)}`, {
      parse_mode: "HTML",
    });
  } catch (e) {
    console.log("[support] admin reply send failed:", e.message);
  }
  await kv.delSupportFwd(env, reply.message_id);
  return true;
}
