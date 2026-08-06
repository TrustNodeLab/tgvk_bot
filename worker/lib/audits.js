// Текстовые аудиты (фолбэки), когда GitHub не успел подготовить карточку:
// Worker публикует сводку из publish_log. Ежедневный, недельный и понедельничный
// ивент собираются прямо здесь — без LLM и тяжёлого CPU.

import { fmtTime, escHtml } from "./text.js";
import { mskNow, plural } from "./config.js";

const DAY_MS = 24 * 3600 * 1000;

function inDate(entry, isoDate) {
  const t = new Date(entry.published_at);
  if (Number.isNaN(t.getTime())) return false;
  return mskNow(t).date === isoDate;
}

function isNews(e) {
  return e.kind === "news" || !e.kind;
}

function entryTitle(e) {
  return escHtml(e.title || (e.caption || "").split("\n")[0] || "Без заголовка");
}

function entryTime(e) {
  const t = new Date(e.published_at);
  return Number.isNaN(t.getTime()) ? "" : ` ${fmtTime(e.published_at)}`;
}

// «Интересность» поста — глубина текста (длиннее caption / больше тегов-карточек).
function depthOf(e) {
  return (e.caption || "").length + ((e.tags || []).length) * 40;
}

function buildTop(log, fromMs, max = 6) {
  return log
    .filter(isNews)
    .filter((e) => {
      const t = new Date(e.published_at);
      return !Number.isNaN(t.getTime()) && t.getTime() >= fromMs;
    })
    .sort((a, b) => depthOf(b) - depthOf(a))
    .slice(0, max);
}

export function buildDailyAudit(log, msk) {
  const today = log.filter((e) => inDate(e, msk.date));
  if (!today.length) return "";
  const news = today.filter(isNews).length;
  const lines = today.map((e) => `•${entryTime(e)} ${entryTitle(e)}`);
  return (
    "📊 <b>Аудит дня</b>\n\n" +
    `Сегодня опубликовано <b>${today.length}</b> ${plural(today.length, "пост", "поста", "постов")}` +
    `${news ? `, из них новостных — <b>${news}</b>` : ""}:\n\n` +
    lines.join("\n") +
    "\n\n🛡️ TrustNode"
  );
}

export function buildWeeklyAudit(log, msk) {
  const from = Date.now() - 7 * DAY_MS;
  const week = log.filter((e) => {
    const t = new Date(e.published_at);
    return !Number.isNaN(t.getTime()) && t.getTime() >= from;
  });
  if (!week.length) return "";
  const news = week.filter(isNews).length;
  const events = week.filter((e) => e.kind === "event").length;
  const audits = week.filter((e) => e.kind && e.kind.includes("audit")).length;
  const top = buildTop(log, from, 5);
  const lines = top.map((e) => `• ${entryTitle(e)} — ${fmtTime(e.published_at)}`);
  return (
    "🏆 <b>Недельный аудит</b>\n\n" +
    `За неделю: <b>${week.length}</b> ${plural(week.length, "пост", "поста", "постов")}` +
    ` (новостей ${news}, аудитов ${audits}, ивентов ${events}).\n\n` +
    "Самые интересные:\n" +
    lines.join("\n") +
    "\n\n🛡️ TrustNode"
  );
}

const EVENT_TEMPLATES = [
  (top) =>
    "🎉 <b>Ивент TrustNode</b>\n\n" +
    `Главное за прошедшую неделю: <b>${top}</b>.\n\n` +
    "Впереди ещё больше разборов, карточек и свежих новостей о цифровой безопасности.\n\n" +
    "🛡️ TrustNode",
  (top) =>
    "💡 <b>Интересное за неделю</b>\n\n" +
    `Мы разобрали: ${top}.\n\n` +
    "Следите за каналом — каждый день новости о мошенниках и киберугрозах с карточками.\n\n" +
    "🛡️ TrustNode",
  (top) =>
    "🔬 <b>Итоги недели TrustNode</b>\n\n" +
    `Самый заметный сюжет: <b>${top}</b>.\n\n` +
    "Оставайтесь с нами — завтра новые карточки и разборы схем.\n\n" +
    "🛡️ TrustNode",
  (top) =>
    "🚀 <b>Тема недели</b>\n\n" +
    `Больше всего обсуждали: ${top}.\n\n` +
    "Расскажем, что это значит для вашей безопасности, и что делать.\n\n" +
    "🛡️ TrustNode",
];

export function buildEventFallback(log, msk) {
  const from = Date.now() - 7 * DAY_MS;
  const top = buildTop(log, from, 3);
  const headline = top.length
    ? top.map(entryTitle).join("; ")
    : "новости о мошенничестве и защите от киберугроз";
  const tpl = EVENT_TEMPLATES[Math.floor(Math.random() * EVENT_TEMPLATES.length)];
  return tpl(headline);
}
