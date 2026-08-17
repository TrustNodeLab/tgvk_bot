// Аналитика студии: ежедневные метрики (посты, охваты, реакции, подписчики
// TG/VK) копятся в KV day_metrics:<date>. По ним строятся отчёты:
//   • вечерняя сводка (20:00 МСК)  — «сколько чего получили за день»;
//   • отчёт за день (23:30 МСК)    — достижения и дельты к вчера;
//   • недельная сводка (вс 20:30)  — неделя к неделе;
//   • месячная сводка (1-го 20:30) — месяц к месяцу.
// Отчёты уходят админу автоматически (maybeSendReports) или вручную /report.
// Маркеры report_sent:<тип>:<период> гарантируют один отчёт за период.

import * as kv from "./kv.js";
import { mskNow, plural } from "./config.js";
import { vkCall, sendMessage, resolveTelegramChannel, getChatMemberCount } from "./telegram.js";
import { bestPerformingPosts, aggregateStats } from "./stats.js";

// Время отправки (минуты от полуночи МСК) + окно ожидания (крон раз в 5 мин).
export const EVENING_TIME = 20 * 60;      // 20:00 — вечерняя сводка
export const DAY_REPORT_TIME = 23 * 60 + 30; // 23:30 — отчёт за день
export const WEEK_REPORT_TIME = 20 * 60 + 30; // 20:30 вс — неделя
export const MONTH_REPORT_TIME = 20 * 60 + 30; // 20:30 1-го — месяц
const SEND_WINDOW_MIN = 10;

const MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

// ---------- форматирование ----------

function fmtInt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function signed(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n > 0 ? `+${fmtInt(n)}` : fmtInt(n);
}

// Процент изменения cur к prev; null, если база нулевая/нет данных.
function pct(cur, prev) {
  if (!prev || !Number.isFinite(prev) || prev <= 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

function pctLine(cur, prev) {
  const p = pct(cur, prev);
  return p === null ? "" : ` · ${p > 0 ? "+" : ""}${p}% к прошлому`;
}

function russianPlural(n, one, few, many) {
  return `${fmtInt(n)} ${plural(n, one, few, many)}`;
}

// Дата сдвинутая на offset дней от "YYYY-MM-DD" (в МСК).
function dateKeyOffset(date, offsetDays) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + offsetDays));
  return t.toISOString().slice(0, 10);
}

// Список N дат, заканчивающийся сегодня (включительно).
function lastNDates(now, n) {
  const today = mskNow(now).date;
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(dateKeyOffset(today, -i));
  return out;
}

function fmtDayRu(date) {
  const [y, m, d] = date.split("-").map(Number);
  return `${d}.${String(m).padStart(2, "0")}`;
}

// ---------- посты дня ----------

function postsForDate(log, date) {
  return (log || []).filter((e) => {
    if (!e || !(e.vk_ok || e.tg_ok)) return false;
    const t = new Date(e.published_at);
    return !Number.isNaN(t.getTime()) && mskNow(t).date === date;
  });
}

// ---------- подписчики ----------

// Текущее число подписчиков TG-канала и VK-группы. Ошибка API одной платформы
// не роняет сбор (null в поле), чтобы сводка пришла даже без одной метрики.
async function fetchSubscribers(env) {
  const out = { tg_members: null, vk_members: null };
  if (env.TELEGRAM_BOT_TOKEN) {
    try {
      const chatId = await resolveTelegramChannel(env);
      const n = await getChatMemberCount(env, chatId);
      out.tg_members = Number(n) > 0 ? Number(n) : null;
    } catch (e) {
      console.log("[analytics] TG подписчики недоступны:", e.message);
    }
  }
  if (env.VK_TOKEN && env.VK_GROUP_ID) {
    try {
      const res = await vkCall(env, "groups.getById", { group_id: env.VK_GROUP_ID, fields: "members_count" });
      const g = Array.isArray(res) ? res[0] : res;
      out.vk_members = g && Number(g.members_count) > 0 ? Number(g.members_count) : null;
    } catch (e) {
      console.log("[analytics] VK подписчики недоступны:", e.message);
    }
  }
  return out;
}

// ---------- сбор дневных метрик ----------

// Собирает метрики текущего дня (МСК) и кладёт в KV day_metrics:<date>.
// Повторный вызов в тот же день перезаписывает запись свежими цифрами.
export async function collectDailyMetrics(env, { now = new Date() } = {}) {
  const date = mskNow(now).date;
  const log = await kv.getLog(env);
  const today = postsForDate(log, date);
  let views = 0, likes = 0, reactions = 0, reposts = 0, engagement = 0;
  for (const e of today) {
    const s = e.stats || {};
    const v = (s.vk && s.vk.views) || 0;
    const l = (s.vk && s.vk.likes) || 0;
    const rp = (s.vk && s.vk.reposts) || 0;
    const rc = s.reactions_total || 0;
    views += v;
    likes += l;
    reactions += rc;
    reposts += rp;
    engagement += v + l * 50 + rp * 80 + rc * 30;
  }
  const subs = await fetchSubscribers(env);
  const rec = {
    date,
    posts: today.length,
    views,
    likes,
    reactions,
    reposts,
    engagement,
    tg_members: subs.tg_members,
    vk_members: subs.vk_members,
    collected_at: new Date().toISOString(),
  };
  await kv.setDayMetrics(env, date, rec);
  return rec;
}

// ---------- агрегация записей day_metrics ----------

function aggregateRecords(records) {
  const agg = { posts: 0, views: 0, likes: 0, reactions: 0, reposts: 0, engagement: 0, days: 0 };
  for (const r of records) {
    if (!r) continue;
    agg.posts += r.posts || 0;
    agg.views += r.views || 0;
    agg.likes += r.likes || 0;
    agg.reactions += r.reactions || 0;
    agg.reposts += r.reposts || 0;
    agg.engagement += r.engagement || 0;
    agg.days++;
  }
  return agg;
}

// Рост подписчиков внутри периода (первая запись -> последняя), всего — по
// последней записи. null, если данных о подписчиках в периоде нет.
function subscriberRange(records) {
  const withSubs = records.filter((r) => (r && (r.tg_members != null || r.vk_members != null)));
  if (!withSubs.length) return { total: null, tg_delta: null, vk_delta: null, tg_total: null, vk_total: null };
  const first = withSubs[0];
  const last = withSubs[withSubs.length - 1];
  const total = (r) => (r.tg_members || 0) + (r.vk_members || 0);
  const tg_delta =
    last.tg_members != null && first.tg_members != null ? last.tg_members - first.tg_members : null;
  const vk_delta =
    last.vk_members != null && first.vk_members != null ? last.vk_members - first.vk_members : null;
  return {
    total: total(last),
    tg_delta,
    vk_delta,
    tg_total: last.tg_members,
    vk_total: last.vk_members,
  };
}

async function loadRecords(env, dates) {
  const out = [];
  for (const d of dates) {
    const r = await kv.getDayMetrics(env, d);
    if (r) out.push(r);
  }
  return out;
}

// ---------- лучший пост и рекомендация ----------

function bestToday(log, date) {
  const top = bestPerformingPosts(postsForDate(log, date), 1);
  return top[0] || null;
}

function recommendationText(log, date) {
  const agg = aggregateStats(postsForDate(log, date));
  const topic = agg.topic[0];
  if (!topic || !topic.posts || !topic.avg_views) return "";
  return `\n\n💡 <b>Совет студии</b>: тема «${topic.key}» сегодня дала ${fmtInt(topic.avg_views)} просм./пост — завтра делаем в этом же ключе.`;
}

// ---------- тексты отчётов ----------

// 🌆 Вечерняя сводка: свежие метрики дня + дельты к вчера + подписчики.
export async function eveningSummaryText(env, { now = new Date() } = {}) {
  try {
    const rec = await collectDailyMetrics(env, { now });
    const prev = await kv.getDayMetrics(env, dateKeyOffset(rec.date, -1));
    const msk = mskNow(now);
    const log = await kv.getLog(env);
    const best = bestToday(log, rec.date);

    const subsLines = [];
    if (rec.tg_members != null || rec.vk_members != null) {
      const pTg = prev && prev.tg_members != null ? prev.tg_members : null;
      const pVk = prev && prev.vk_members != null ? prev.vk_members : null;
      const dTg = pTg != null && rec.tg_members != null ? rec.tg_members - pTg : null;
      const dVk = pVk != null && rec.vk_members != null ? rec.vk_members - pVk : null;
      if (rec.tg_members != null) subsLines.push(`• Telegram: <b>${fmtInt(rec.tg_members)}</b>${dTg != null ? ` (${signed(dTg)} за день)` : ""}`);
      if (rec.vk_members != null) subsLines.push(`• VK: <b>${fmtInt(rec.vk_members)}</b>${dVk != null ? ` (${signed(dVk)} за день)` : ""}`);
      if (subsLines.length) subsLines.unshift("\n👥 <b>Аудитория</b>");
    }

    let bestLine = "";
    if (best) {
      const url = best.vk_post_id && env.VK_GROUP_ID
        ? ` · <a href="https://vk.com/wall-${env.VK_GROUP_ID}_${best.vk_post_id}">VK</a>`
        : "";
      bestLine = `\n\n🏆 <b>Лучший пост</b>: «${escHtml(best.title || best.headline || "")}» — ${fmtInt(best.views)} просмотров${url}`;
    }

    return (
      "🌆 <b>Вечерняя сводка · " + fmtDayRu(rec.date) + "</b>\n\n" +
      "Сегодня за день:\n" +
      `• Постов: <b>${fmtInt(rec.posts)}</b>${prev && prev.posts ? ` (вчера ${prev.posts})` : ""}\n` +
      `• Просмотров: <b>${fmtInt(rec.views)}</b>${pctLine(rec.views, prev && prev.views)}\n` +
      `• Лайков: <b>${fmtInt(rec.likes)}</b>${pctLine(rec.likes, prev && prev.likes)}\n` +
      `• Реакций: <b>${fmtInt(rec.reactions)}</b>${pctLine(rec.reactions, prev && prev.reactions)}\n` +
      `• Вовлечённость: <b>${fmtInt(rec.engagement)}</b>${pctLine(rec.engagement, prev && prev.engagement)}` +
      subsLines.join("\n") +
      bestLine +
      (msk.hour < 21 ? "\n\nПродолжаем расти — каждый день студия становится сильнее. 💪" : "")
    );
  } catch (e) {
    console.log("[analytics] вечерняя сводка не собралась:", e.message);
    return "";
  }
}

// 📋 Отчёт за день: достижения, дельты, лучшее, совет студии.
export async function dayReportText(env, { now = new Date() } = {}) {
  try {
    const rec = await collectDailyMetrics(env, { now });
    const prev = await kv.getDayMetrics(env, dateKeyOffset(rec.date, -1));
    const log = await kv.getLog(env);
    const best = bestToday(log, rec.date);

    const subsPart = [];
    const pr = prev ? subscriberRange([prev]) : { total: null };
    const cr = subscriberRange([rec]);
    if (cr.total != null) {
      const growth = pr.total != null ? cr.total - pr.total : null;
      subsPart.push(`• Подписчиков: <b>${fmtInt(cr.total)}</b>${growth != null ? ` (${signed(growth)} за день)` : ""}`);
    }

    let topLines = [];
    if (best) {
      const url = best.vk_post_id && env.VK_GROUP_ID
        ? ` · <a href="https://vk.com/wall-${env.VK_GROUP_ID}_${best.vk_post_id}">VK</a>`
        : "";
      topLines.push(`• Лучший пост: «${escHtml(best.title || best.headline || "")}» — ${fmtInt(best.views)} просм.${url}`);
    }
    const agg = aggregateStats(postsForDate(log, rec.date));
    if (agg.style[0] && agg.style[0].posts) {
      topLines.push(`• Лучший жанр: ${agg.style[0].key} — ${fmtInt(agg.style[0].avg_views)} просм./пост`);
    }
    if (agg.topic[0] && agg.topic[0].posts) {
      topLines.push(`• Лучшая тема: ${agg.topic[0].key} — ${fmtInt(agg.topic[0].avg_views)} просм./пост`);
    }

    const deltaLine = prev && (rec.posts > 0 || prev.posts > 0)
      ? `\n\nПо сравнению со вчера (${fmtDayRu(prev.date)}):\n` +
        `• Постов: ${rec.posts} → <b>${signed(rec.posts - prev.posts)}</b>\n` +
        `• Просмотров: ${fmtInt(prev.views)} → <b>${signed(rec.views - prev.views)}</b>\n` +
        `• Лайков: ${prev.likes} → <b>${signed(rec.likes - prev.likes)}</b>\n` +
        `• Реакций: ${prev.reactions} → <b>${signed(rec.reactions - prev.reactions)}</b>`
      : "";

    return (
      "📋 <b>Отчёт за день · " + fmtDayRu(rec.date) + "</b>\n\n" +
      "<b>Чего достигли сегодня</b>\n" +
      `• Опубликовано: ${russianPlural(rec.posts, "пост", "поста", "постов")}\n` +
      `• Просмотры: <b>${fmtInt(rec.views)}</b>\n` +
      `• Лайки: <b>${fmtInt(rec.likes)}</b> · Реакции: <b>${fmtInt(rec.reactions)}</b> · Репосты: <b>${fmtInt(rec.reposts)}</b>\n` +
      `• Вовлечённость: <b>${fmtInt(rec.engagement)}</b>` +
      (subsPart.length ? "\n" + subsPart.join("\n") : "") +
      deltaLine +
      (topLines.length ? "\n\n<b>Что залетало</b>\n" + topLines.join("\n") : "") +
      recommendationText(log, rec.date) +
      "\n\nКаждый день — шаг вперёд. Завтра сделаем больше! 🚀"
    );
  } catch (e) {
    console.log("[analytics] отчёт за день не собрался:", e.message);
    return "";
  }
}

// 🗓 Недельная сводка: 7 дней против предыдущих 7.
export async function weekReportText(env, { now = new Date() } = {}) {
  try {
    const curDates = lastNDates(now, 7);
    const prevDates = lastNDates(now, 14).slice(0, 7);
    const cur = await loadRecords(env, curDates);
    const prev = await loadRecords(env, prevDates);
    if (!cur.length) return ""; // данных о неделе ещё нет — отчёт не шлём
    const ca = aggregateRecords(cur);
    const pa = aggregateRecords(prev);
    const cs = subscriberRange(cur);
    const ps = subscriberRange(prev);

    const growth =
      ps.total != null && cs.total != null ? signed(cs.total - ps.total) : null;
    const subsLines = [];
    if (cs.total != null) subsLines.push(`• Подписчиков: <b>${fmtInt(cs.total)}</b>${growth != null ? ` (${growth} за неделю)` : ""}`);
    if (cs.tg_total != null) subsLines.push(`• Telegram: <b>${fmtInt(cs.tg_total)}</b>${cs.tg_delta != null ? ` (${signed(cs.tg_delta)})` : ""}`);
    if (cs.vk_total != null) subsLines.push(`• VK: <b>${fmtInt(cs.vk_total)}</b>${cs.vk_delta != null ? ` (${signed(cs.vk_delta)})` : ""}`);

    const perDay = ca.days ? Math.round(ca.posts / ca.days) : 0;
    return (
      "🗓 <b>Недельная сводка · " + fmtDayRu(curDates[0]) + " — " + fmtDayRu(curDates[6]) + "</b>\n\n" +
      "За неделю:\n" +
      `• Постов: <b>${fmtInt(ca.posts)}</b>${pa.posts ? ` (за прошлую: ${pa.posts})` : ""} · в среднем ${perDay} в день\n` +
      `• Просмотров: <b>${fmtInt(ca.views)}</b>${pa.views ? pctLine(ca.views, pa.views) : ""}\n` +
      `• Лайков: <b>${fmtInt(ca.likes)}</b>${pa.likes ? pctLine(ca.likes, pa.likes) : ""}\n` +
      `• Реакций: <b>${fmtInt(ca.reactions)}</b>${pa.reactions ? pctLine(ca.reactions, pa.reactions) : ""}\n` +
      `• Вовлечённость: <b>${fmtInt(ca.engagement)}</b>${pa.engagement ? pctLine(ca.engagement, pa.engagement) : ""}` +
      (subsLines.length ? "\n\n👥 <b>Аудитория</b>\n" + subsLines.join("\n") : "") +
      "\n\nНеделя за неделей — рост к цели. Лучшая студия строится так. 💪"
    );
  } catch (e) {
    console.log("[analytics] недельная сводка не собралась:", e.message);
    return "";
  }
}

// 📅 Месячная сводка: 30 дней против предыдущих 30.
export async function monthReportText(env, { now = new Date() } = {}) {
  try {
    const curDates = lastNDates(now, 30);
    const prevDates = lastNDates(now, 60).slice(0, 30);
    const cur = await loadRecords(env, curDates);
    const prev = await loadRecords(env, prevDates);
    if (!cur.length) return "";
    const ca = aggregateRecords(cur);
    const pa = aggregateRecords(prev);
    const cs = subscriberRange(cur);
    const ps = subscriberRange(prev);

    const growth =
      ps.total != null && cs.total != null ? signed(cs.total - ps.total) : null;
    const subsLines = [];
    if (cs.total != null) subsLines.push(`• Подписчиков: <b>${fmtInt(cs.total)}</b>${growth != null ? ` (${growth} за месяц)` : ""}`);

    const [y, m] = mskNow(now).date.split("-").map(Number);
    return (
      "📅 <b>Месячная сводка · " + MONTHS[m - 1] + " " + y + "</b>\n\n" +
      "За месяц:\n" +
      `• Постов: <b>${fmtInt(ca.posts)}</b>${pa.posts ? ` (за прошлый: ${pa.posts})` : ""}\n` +
      `• Просмотров: <b>${fmtInt(ca.views)}</b>${pa.views ? pctLine(ca.views, pa.views) : ""}\n` +
      `• Лайков: <b>${fmtInt(ca.likes)}</b>${pa.likes ? pctLine(ca.likes, pa.likes) : ""}\n` +
      `• Реакций: <b>${fmtInt(ca.reactions)}</b>${pa.reactions ? pctLine(ca.reactions, pa.reactions) : ""}\n` +
      `• Вовлечённость: <b>${fmtInt(ca.engagement)}</b>${pa.engagement ? pctLine(ca.engagement, pa.engagement) : ""}` +
      (subsLines.length ? "\n\n👥 <b>Аудитория</b>\n" + subsLines.join("\n") : "") +
      "\n\nМесяц к месяцу — студия растёт. Впереди лучшие охваты! 🚀"
    );
  } catch (e) {
    console.log("[analytics] месячная сводка не собралась:", e.message);
    return "";
  }
}

// ---------- автопубликация отчётов по расписанию ----------

// Проверяет, наступило ли время очередного отчёта, и шлёт его админу. Маркеры
// report_sent не дают отправить один отчёт дважды. Возвращает массив типов,
// которые реально ушли (для тестов/логов).
export async function maybeSendReports(env, { now = new Date() } = {}) {
  const admin = env.TELEGRAM_ADMIN_CHAT_ID;
  if (!admin) return [];
  const msk = mskNow(now);
  const minute = msk.minuteOfDay;
  const sent = [];
  const within = (start) => minute >= start && minute < start + SEND_WINDOW_MIN;

  if (within(EVENING_TIME)) {
    const key = `evening:${msk.date}`;
    if (!(await kv.getReportMarker(env, key))) {
      const text = await eveningSummaryText(env, { now });
      if (text) {
        await sendMessage(env, admin, text, { parse_mode: "HTML" });
        await kv.setReportMarker(env, key);
        sent.push("evening");
      }
    }
  }

  if (within(DAY_REPORT_TIME)) {
    const key = `day:${msk.date}`;
    if (!(await kv.getReportMarker(env, key))) {
      const text = await dayReportText(env, { now });
      if (text) {
        await sendMessage(env, admin, text, { parse_mode: "HTML" });
        await kv.setReportMarker(env, key);
        sent.push("day");
      }
    }
  }

  if (within(WEEK_REPORT_TIME) && msk.dow === 6) {
    const key = `week:${msk.date}`;
    if (!(await kv.getReportMarker(env, key))) {
      const text = await weekReportText(env, { now });
      if (text) {
        await sendMessage(env, admin, text, { parse_mode: "HTML" });
        await kv.setReportMarker(env, key);
        sent.push("week");
      }
    }
  }

  if (within(MONTH_REPORT_TIME) && msk.date.endsWith("-01")) {
    const key = `month:${msk.date.slice(0, 7)}`;
    if (!(await kv.getReportMarker(env, key))) {
      const text = await monthReportText(env, { now });
      if (text) {
        await sendMessage(env, admin, text, { parse_mode: "HTML" });
        await kv.setReportMarker(env, key);
        sent.push("month");
      }
    }
  }

  return sent;
}

// Экранирование HTML для безопасной вставки текста поста в отчёт.
function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
