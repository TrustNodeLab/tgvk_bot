// Адаптивное расписание: число публикаций в день меняется по статистике.
// База — классические окна дайджестов (утро/день/вечер). Если охваты низкие —
// студия добавляет слот (публикует чаще), если высокие — сокращает, чтобы не
// заваливать канал. Админ может переключить режим «авто»/«ручной» командой
// /schedule и сам менять число слотов («полная гибкость студии»).
//
// Хранится в KV: schedule_state = { mode, windows, updated_at, reason }.

import { NEWS_WINDOWS, ekbNow, plural } from "./config.js";
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

// Расписание постов задаётся вручную: режим «авто»/«ручной» и число слотов.
// Авто-корректировка по вовлечённости убрана — метрики не собираются.

// Ручное управление: режим авто/ручной и принудительное число слотов в день.

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

// Окно, в котором сейчас время (минуты от полуночи ЕКБ), либо null.
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

// ---------- визуальный редактор расписания: перенос окна на ±N минут ----------
// Границы дня: 07:00–22:00 EKB. Окно не пересекается с соседями (зазор ≥30 мин)
// и сохраняет длительность. Итог пишется в schedule_state.reason.
export async function moveWindow(env, slug, deltaMin, { now = new Date() } = {}) {
  const dayStart = 7 * 60;
  const dayEnd = 22 * 60;
  const gap = 30;
  const windows = (await getWindows(env)).slice();
  const idx = windows.findIndex((w) => w.slug === slug);
  if (idx === -1) return { ok: false, reason: "window not found" };

  const w = windows[idx];
  const dur = Math.max(30, Math.min(720, (w.end || w.start + 60) - (w.start || 0)));
  const others = windows.filter((x) => x.slug !== slug);
  const lower = others.filter((x) => x.start < w.start).sort((a, b) => b.start - a.start)[0] || null;
  const upper = others.filter((x) => x.start > w.start).sort((a, b) => a.start - b.start)[0] || null;

  // Безопасные границы: не врезаемся в соседей (зазор ≥30 мин), не выходим за день.
  const minStart = lower ? lower.end + gap : dayStart;
  const maxEnd = upper ? upper.start - gap : dayEnd;
  const desired = (w.start || 0) + deltaMin;
  let start = Math.max(minStart, Math.min(desired, dayEnd - dur));
  let end = Math.min(start + dur, maxEnd);

  // Окно не влезло с полной длительностью — ужимаем, но не меньше 30 минут.
  if (end - start < 30) {
    start = Math.max(minStart, maxEnd - 30);
    end = start + 30;
  }
  if (end > dayEnd) {
    start = Math.max(minStart, dayEnd - 30);
    end = start + 30;
  }
  windows[idx] = { ...w, start, end };

  return setSchedule(env, {
    windows,
    reason: `перенос окна «${w.label}» на ${start - w.start >= 0 ? "+" : ""}${Math.round((start - (w.start || 0)) / 60)}ч (${minutesToClock(start)}–${minutesToClock(end)})`,
  }).then(() => ({ ok: true, start, end }));
}

// ---------- AI-расписание: здоровье окон и перенос по просадкам ----------
// Вовлечённость (просмотры) не читается платформами, поэтому «просадка» окна =
// сколько дней из последних N окно не выдало ни одного поста (пополнение до
// слотов ныряло или новость протухала до своего времени). Окна с просадкой
// переставляются «наружу» — в самые большие свободные промежутки дня.

function dateKeyOffset(date, offsetDays) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + offsetDays));
  return t.toISOString().slice(0, 10);
}

// Относит запись publish_log к окну: по сохранённому window_slug (факт), иначе
// по EKB-времени публикации против текущего расписания (старые записи).
function slugForEntry(wins, e) {
  if (e && e.window_slug) return e.window_slug;
  if (!e || !e.published_at) return null;
  const t = new Date(e.published_at);
  if (Number.isNaN(t.getTime())) return null;
  const ekb = ekbNow(t);
  const w = (wins || []).find((x) => ekb.minuteOfDay >= x.start && ekb.minuteOfDay < x.end);
  return w ? w.slug : null;
}

export async function slotHealth(env, { now = new Date(), days = 7 } = {}) {
  const log = await kv.getLog(env);
  const wins = await getWindows(env);
  if (!wins.length) return [];
  const today = ekbNow(now).date;
  const daysList = [];
  for (let i = days - 1; i >= 0; i--) daysList.push(dateKeyOffset(today, -i));

  const deliveredDays = {};
  for (const w of wins) deliveredDays[w.slug] = new Set();

  for (const e of log || []) {
    if (!e || !(e.vk_ok || e.tg_ok) || !e.published_at) continue;
    const d = ekbNow(new Date(e.published_at)).date;
    if (!d || !daysList.includes(d)) continue;
    const slug = slugForEntry(wins, e);
    if (slug && deliveredDays[slug]) deliveredDays[slug].add(d);
  }

  return wins.map((w) => {
    const set = deliveredDays[w.slug];
    const miss = daysList.filter((d) => !set.has(d)).length;
    return {
      slug: w.slug,
      label: w.label,
      start: w.start,
      end: w.end,
      days,
      delivered: daysList.length - miss,
      miss,
      pct: Math.round(((daysList.length - miss) / daysList.length) * 100),
    };
  });
}

// Правила «переноса наружу»: здоровые окна остаются на своих временах, а окна
// с просадкой (miss > days/3) ставятся в середину самых больших свободных
// промежутков дня (7:00–23:00), минимум 3 часа от соседей. Возвращает null,
// если менять нечего (всё здорово / предложение совпадает с текущим).
export function proposeSchedule(windows, health, { days = 7, missThreshold = 0 } = {}) {
  const threshold = missThreshold || Math.ceil(days / 3);
  const weak = health.filter((h) => h.miss > threshold).map((h) => h.slug);
  if (!weak.length) return null;

  const MIN_GAP = 180; // 3 часа между стартами окон
  const DAY_START = 7 * 60;
  const DAY_END = 23 * 60;

  const keep = windows
    .filter((w) => !weak.includes(w.slug))
    .slice()
    .sort((a, b) => a.start - b.start);

  const anchors = [{ start: DAY_START }].concat(
    keep.map((w) => ({ start: w.start })),
    [{ start: DAY_END }]
  );
  const gaps = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const a = anchors[i].start;
    const b = anchors[i + 1].start;
    const size = b - a;
    if (size >= MIN_GAP * 2 + 60) {
      gaps.push({ from: a + MIN_GAP, to: b - MIN_GAP - 60, size });
    }
  }
  gaps.sort((x, y) => y.size - x.size);

  const moved = [];
  for (const slug of weak) {
    const orig = windows.find((w) => w.slug === slug);
    if (!orig) continue;
    const g = gaps.shift();
    if (!g) break;
    const mid = Math.round((g.from + g.to) / 2 / 60) * 60;
    let start = mid;
    if (start === orig.start) {
      // середина совпала с текущим временем — сдвигаем на час, если влезает,
      // чтобы «перенос» был честным переездом, а не тем же слотом
      if (mid + 60 <= g.to) start = mid + 60;
      else if (mid - 60 >= g.from) start = mid - 60;
    }
    moved.push({ ...orig, start, end: start + 60, reason: "перенос по просадке" });
  }

  const result = keep.concat(moved, windows.filter((w) => weak.includes(w.slug) && !moved.some((m) => m.slug === w.slug)));
  result.sort((a, b) => a.start - b.start);

  const same =
    result.length === windows.length &&
    result.every((w, i) => w.start === windows[i].start && w.slug === windows[i].slug);
  return same ? null : result;
}

// Полный AI-план: здоровье текущих окон + предложение перестановки (или null).
export async function aiSchedulePlan(env, { now = new Date(), days = 7 } = {}) {
  const health = await slotHealth(env, { now, days });
  const windows = await getWindows(env);
  const proposed = proposeSchedule(windows, health, { days });
  return { health, windows, proposed };
}

// Помним предложение в schedule_state — кнопка «Применить» применяет именно его.
export async function storeProposedSchedule(env, proposed, reason) {
  const st = await kv.getScheduleState(env);
  await kv.setScheduleState(env, { ...(st || {}), proposed: { windows: proposed, reason } });
}

export async function applyProposedSchedule(env) {
  const st = await kv.getScheduleState(env);
  if (!st || !st.proposed || !st.proposed.windows) return null;
  const res = await setSchedule(env, {
    windows: st.proposed.windows,
    reason: st.proposed.reason || "AI-перенос по просадкам",
  });
  const clean = await kv.getScheduleState(env);
  if (clean && clean.proposed) {
    delete clean.proposed;
    await kv.setScheduleState(env, clean);
  }
  return res;
}

export function healthLine(h) {
  const icon = h.miss === 0 ? "✅" : h.pct >= 60 ? "🟡" : "🔴";
  return `${icon} <b>${h.label}</b> (${minutesToClock(h.start)}–${minutesToClock(h.end)}): доставлено ${plural(h.delivered, "день", "дня", "дней")} из ${h.days} · пропуск ${h.miss}`;
}

export function minutesToClock(min) {
  if (min === null || min === undefined || Number.isNaN(min)) return "—";
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
