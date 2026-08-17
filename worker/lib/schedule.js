// Адаптивное расписание: число публикаций в день меняется по статистике.
// База — классические окна дайджестов (утро/день/вечер). Если охваты низкие —
// студия добавляет слот (публикует чаще), если высокие — сокращает, чтобы не
// заваливать канал. Админ может переключить режим «авто»/«ручной» командой
// /schedule и сам менять число слотов («полная гибкость студии»).
//
// Хранится в KV: schedule_state = { mode, windows, updated_at, reason }.

import { NEWS_WINDOWS } from "./config.js";
import * as kv from "./kv.js";

// Дополнительные окна для «публикувать чаще» — заполняют паузы между базовыми,
// чтобы не пересекаться с ними (иначе выпуск мог бы собраться дважды в одном
// времени). Добавляются по одному.
export const EXTRA_WINDOWS = [
  { start: 12 * 60, end: 13 * 60, cap: 1, slug: "midday", label: "обеденное" },
  { start: 17 * 60, end: 18 * 60, cap: 1, slug: "pre_evening", label: "предвечернее" },
];

// Нижняя и верхняя границы слотов в день. Базовые окна (утро/день/вечер) всегда
// на месте — «гибкость» это дополнительные слоты сверху (обед/предвечерье).
// Ниже базы студия не опускается, выше лимита не разгоняется (не спамим).
export const MIN_SLOTS = 3;
export const MAX_SLOTS = 5;

// Пороги средних просмотров на пост (7 дней) для авто-корректировки частоты.
export const LOW_VIEWS = 1200;   // ниже -> публикуем чаще
export const HIGH_VIEWS = 6000;  // выше -> публикуем реже

// Решаем по статистике не чаще раза в сутки, чтобы расписание не дёргалось.
const ADJUST_COOLDOWN_MS = 24 * 3600 * 1000;

export function defaultScheduleState() {
  return {
    mode: "auto",
    windows: NEWS_WINDOWS.map((w) => ({ ...w })),
    updated_at: null,
    reason: null,
  };
}

export async function getSchedule(env) {
  const st = (await kv.getScheduleState(env)) || defaultScheduleState();
  return {
    ...st,
    windows: Array.isArray(st.windows) && st.windows.length ? st.windows : NEWS_WINDOWS.map((w) => ({ ...w })),
  };
}

export async function setSchedule(env, patch) {
  const st = await getSchedule(env);
  const next = { ...st, ...patch, updated_at: new Date().toISOString() };
  // окна всегда сортируем по времени и чистим дубли старта
  next.windows = next.windows
    .slice()
    .sort((a, b) => a.start - b.start)
    .filter((w, i, arr) => arr.findIndex((x) => x.start === w.start) === i);
  await kv.setScheduleState(env, next);
  return next;
}

// Текущий набор окон (для сборки дайджестов и слотов).
export async function getWindows(env) {
  const st = await getSchedule(env);
  return st.windows;
}

// Окно, в котором сейчас время (минуты от полуночи МСК), либо null.
export async function currentWindow(env, minuteOfDay) {
  const wins = await getWindows(env);
  return wins.find((w) => minuteOfDay >= w.start && minuteOfDay < w.end) || null;
}

// Очередное свободное окно для добавления (ещё не в расписании), либо null.
export function nextExtraWindow(windows) {
  return EXTRA_WINDOWS.find((x) => !windows.some((w) => w.start === x.start)) || null;
}

// Убирает один слот: только доп. окна (обеденное/предвечернее), базовые всегда
// остаются (MIN_SLOTS=3). Если доп. окон нет — ничего не меняется.
function removeOneWindow(windows) {
  const extras = windows.filter((w) => EXTRA_WINDOWS.some((e) => e.start === w.start));
  if (extras.length) {
    const last = extras[extras.length - 1];
    return windows.filter((w) => w.start !== last.start);
  }
  return windows;
}

// Окно по slug — из базовых или дополнительных (для пересборки превью выпуска).
export function windowBySlug(slug) {
  return NEWS_WINDOWS.find((w) => w.slug === slug) ||
    EXTRA_WINDOWS.find((w) => w.slug === slug) ||
    null;
}

// Адаптивная корректировка частоты по средним охватам за последние 7 дней.
// Возвращает текст для уведомления админу или null (ничего не менялось).
// Работает только в режиме «авто» и не чаще раза в сутки.
export async function maybeAdjustSchedule(env, now = new Date()) {
  const st = await getSchedule(env);
  if (st.mode !== "auto") return null;
  if (st.updated_at && now.getTime() - new Date(st.updated_at).getTime() < ADJUST_COOLDOWN_MS) {
    return null;
  }
  const log = await kv.getLog(env);
  const since = now.getTime() - 7 * 86400000;
  const posts = log.filter((e) => {
    const t = new Date(e.published_at).getTime();
    if (Number.isNaN(t) || t < since) return false;
    return e && (e.vk_ok || e.tg_ok) && (e.kind === "news" || e.kind === "digest");
  });
  if (posts.length < 3) return null; // мало данных — расписание не трогаем

  let views = 0, likes = 0, reactions = 0;
  for (const e of posts) {
    const s = e.stats || {};
    views += (s.vk && s.vk.views) || 0;
    likes += (s.vk && s.vk.likes) || 0;
    reactions += s.reactions_total || 0;
  }
  const avgViews = Math.round(views / posts.length);
  const avgEng = Math.round((views + likes * 50 + reactions * 30) / posts.length);
  const wins = st.windows;

  if (avgViews < LOW_VIEWS && wins.length < MAX_SLOTS) {
    const extra = nextExtraWindow(wins);
    if (!extra) return null;
    const next = await setSchedule(env, {
      windows: [...wins, extra],
      reason: `охваты низкие (~${avgViews} просм./пост) — публикуем чаще`,
    });
    return `📈 <b>Расписание обновлено автоматически</b>\nСредние охваты низкие (~${avgViews} просм./пост) — публикую чаще, добавил слот «${extra.label}».\nТеперь ${next.windows.length} ${pluralSlots(next.windows.length)} в день.`;
  }

  if (avgViews > HIGH_VIEWS && wins.length > MIN_SLOTS) {
    const nextWindows = removeOneWindow(wins);
    if (nextWindows.length === wins.length) return null;
    const removed = wins.find((w) => !nextWindows.some((n) => n.start === w.start));
    const next = await setSchedule(env, {
      windows: nextWindows,
      reason: `охваты высокие (~${avgViews} просм./пост) — публикуем реже`,
    });
    return `📉 <b>Расписание обновлено автоматически</b>\nСредние охваты высокие (~${avgViews} просм./пост) — публикую реже, убрал слот «${removed && removed.label}».\nТеперь ${next.windows.length} ${pluralSlots(next.windows.length)} в день.`;
  }

  return null;
}

// Ручное управление: режим авто/ручной и принудительное число слотов в день.
export async function setScheduleMode(env, mode) {
  return setSchedule(env, { mode });
}

// Сброс к базовым окнам (утро/день/вечер) и авто-режиму.
export async function resetSchedule(env) {
  return setSchedule(env, {
    mode: "auto",
    windows: NEWS_WINDOWS.map((w) => ({ ...w })),
    reason: null,
  });
}

export async function setSlotsPerDay(env, count) {
  const target = Math.max(MIN_SLOTS, Math.min(MAX_SLOTS, count));
  let windows = (await getWindows(env)).slice();
  while (windows.length > target) windows = removeOneWindow(windows);
  while (windows.length < target) {
    const extra = nextExtraWindow(windows);
    if (!extra) break;
    windows.push(extra);
  }
  return setSchedule(env, {
    windows,
    reason: `ручная настройка: ${target} ${pluralSlots(target)} в день`,
  });
}

function pluralSlots(n) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return "слот";
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return "слота";
  return "слотов";
}
