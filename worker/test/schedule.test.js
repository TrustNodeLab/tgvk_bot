// Тесты адаптивного расписания (lib/schedule.js), динамических слотов
// (nextFreeSlot) и данных дашборда статистики (dashboardData).
// Запуск: node --test worker/test/schedule.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

function makeKV() {
  const m = new Map();
  return {
    async get(key, type) {
      if (!m.has(key)) return null;
      const v = m.get(key);
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(key, val) {
      m.set(key, typeof val === "string" ? val : JSON.stringify(val));
    },
    async delete(key) {
      m.delete(key);
    },
    async list({ prefix }) {
      return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ name: k })) };
    },
    _map: m,
  };
}

function makeEnv(kv = makeKV()) {
  return {
    BOT_KV: kv,
    BOT_R2: null,
    GITHUB_TOKEN: "test",
    OWNER: "TrustNodeLab",
    REPO: "tgvk_bot",
    TELEGRAM_BOT_TOKEN: "123:token",
    TELEGRAM_ADMIN_CHAT_ID: "1",
    TELEGRAM_CHANNEL_ID: "-1001",
    VK_TOKEN: "vk",
    VK_GROUP_ID: "1",
    BOT_AUTH: "secret",
    WEBHOOK_SECRET: "secret",
  };
}

const SCHEDULE = "file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/schedule.js";
const KV = "file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js";
const SCHED = "file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js";
const CONFIG = "file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/config.js";
const STATS = "file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/stats.js";
const CARDGEN = "file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/cardgen.js";

function post(id, views, opts = {}) {
  return {
    id,
    kind: opts.kind || "news",
    vk_ok: true,
    published_at: new Date(Date.now() - 3600000).toISOString(),
    stats: { vk: { views } },
    ...opts,
  };
}

test("getSchedule: по умолчанию 3 базовых окна и авто-режим", async () => {
  const { getSchedule } = await import(SCHEDULE);
  const env = makeEnv();
  const st = await getSchedule(env);
  assert.equal(st.mode, "auto");
  assert.equal(st.windows.length, 3);
  assert.equal(st.windows[0].slug, "morning");
  assert.equal(st.windows[2].slug, "evening");
});

test("setSlotsPerDay: добавляет доп. слоты до MAX и убирает до MIN", async () => {
  const { setSlotsPerDay, getWindows, MAX_SLOTS, MIN_SLOTS } = await import(SCHEDULE);
  const env = makeEnv();
  await setSlotsPerDay(env, MAX_SLOTS);
  let wins = await getWindows(env);
  assert.equal(wins.length, MAX_SLOTS, "пять слотов в день");
  assert.ok(wins.some((w) => w.slug === "midday"), "обеденный слот добавлен");

  await setSlotsPerDay(env, MIN_SLOTS);
  wins = await getWindows(env);
  assert.equal(wins.length, MIN_SLOTS, "базовые три слота в день");
  assert.ok(!wins.some((w) => w.slug === "midday"), "доп. слот убран раньше базовых");

  // крайние значения не выходят за границы
  await setSlotsPerDay(env, 99);
  assert.equal((await getWindows(env)).length, MAX_SLOTS);
  await setSlotsPerDay(env, 0);
  assert.equal((await getWindows(env)).length, MIN_SLOTS);
});

test("maybeAdjustSchedule: низкие охваты -> добавляет слот (публикуем чаще)", async () => {
  const { maybeAdjustSchedule, getWindows } = await import(SCHEDULE);
  const stock = await import(KV);
  const env = makeEnv();
  for (let i = 0; i < 3; i++) await stock.addLog(env, post("p" + i, 300));
  const note = await maybeAdjustSchedule(env);
  assert.ok(note, "есть уведомление админу");
  assert.ok(note.includes("публикую чаще"), "причина — низкие охваты");
  assert.equal((await getWindows(env)).length, 4, "появился четвёртый слот");
});

test("maybeAdjustSchedule: высокие охваты -> убирает доп. слот (публикуем реже)", async () => {
  const { maybeAdjustSchedule, getWindows, getSchedule, setSlotsPerDay } = await import(SCHEDULE);
  const stock = await import(KV);
  const kvmod = await import(KV);
  const env = makeEnv();
  await setSlotsPerDay(env, 4); // база + обеденный слот
  // сбросим кулдаун (updated_at), чтобы проверка охватов сработала
  await kvmod.setScheduleState(env, { ...(await getSchedule(env)), updated_at: null });
  for (let i = 0; i < 3; i++) await stock.addLog(env, post("h" + i, 8000));
  const note = await maybeAdjustSchedule(env);
  assert.ok(note, "есть уведомление админу");
  assert.ok(note.includes("публикую реже"), "причина — высокие охваты");
  assert.equal((await getWindows(env)).length, 3, "вернулись к базовым трём слотам");
});

test("maybeAdjustSchedule: кулдаун раз в сутки, ручной режим и мало постов", async () => {
  const { maybeAdjustSchedule, setScheduleMode } = await import(SCHEDULE);
  const stock = await import(KV);
  const env = makeEnv();

  // мало постов — расписание не трогаем
  await stock.addLog(env, post("solo", 300));
  assert.equal(await maybeAdjustSchedule(env), null, "одного поста мало для решения");

  // кулдаун: сразу после первой правки вторая не происходит
  for (let i = 0; i < 3; i++) await stock.addLog(env, post("c" + i, 300));
  assert.ok(await maybeAdjustSchedule(env), "первая правка произошла");
  assert.equal(await maybeAdjustSchedule(env), null, "вторая правка в тот же день отменена");

  // ручной режим: бот не трогает расписание
  const env2 = makeEnv();
  await setScheduleMode(env2, "manual");
  for (let i = 0; i < 3; i++) await stock.addLog(env2, post("m" + i, 300));
  assert.equal(await maybeAdjustSchedule(env2), null, "ручной режим — без авто-правок");
});

test("nextFreeSlot учитывает доп. окна расписания", async () => {
  const { nextFreeSlot } = await import(SCHED);
  const { setSlotsPerDay } = await import(SCHEDULE);
  const { mskNow } = await import(CONFIG);
  const env = makeEnv();
  await setSlotsPerDay(env, 4); // база 3 + обеденное 12:00
  const now = new Date("2026-08-07T07:30:00Z"); // 10:30 МСК — внутри утреннего окна, слот 09:00 уже прошёл
  const slot = await nextFreeSlot(env, now);
  const msk = mskNow(new Date(slot));
  assert.equal(msk.minuteOfDay, 12 * 60, "следующий слот — обеденный 12:00 МСК (доп. окно)");
});

test("dashboardData: считает счётчики, лидеров и топ", async () => {
  const { dashboardData } = await import(STATS);
  const log = [
    post("a", 5000, {
      style_id: "warning", topic_id: "call", scheme_id: "safe_account",
      stats: { vk: { views: 5000, likes: 5 } },
    }),
    post("b", 3000, {
      style_id: "warning", topic_id: "call", scheme_id: "safe_account",
      stats: { vk: { views: 3000 } },
    }),
    post("c", 100, {
      kind: "digest", style_id: "digest", topic_id: "digest",
      stats: { vk: { views: 100 }, reactions_total: 2 },
    }),
  ];
  const d = dashboardData(log);
  assert.equal(d.total_posts, 3);
  assert.equal(d.avg_views, 2700, "средние просмотры по постам с метриками");
  assert.equal(d.total_reactions, 2);
  assert.equal(d.styles[0].key, "warning", "лидер по жанру");
  assert.ok(d.top.length >= 1, "топ постов не пуст");
  assert.equal(d.top[0].views, 5000, "топ начинается с самого залётного");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(d.date), "дата в формате МСК");
});

test("renderDashboard: рисует PNG-дашборд статистики", async () => {
  const { renderDashboard } = await import(CARDGEN);
  const png = await renderDashboard({
    date: "2026-08-07",
    total_posts: 10,
    today_posts: 2,
    avg_views: 1500,
    total_reactions: 40,
    engagement: 50000,
    schedule_text: "расписание: авто · 4 слота в день",
    styles: [{ key: "warning", posts: 4, avg_views: 2000 }],
    topics: [{ key: "call", posts: 3, avg_views: 1800 }],
    top: [{ title: "Звонки из банка", views: 5000 }],
  });
  assert.ok(png && png.length > 1000, "картинка не пустая");
  assert.equal(png[0], 0x89, "PNG-сигнатура");
  assert.equal(png[1], 0x50);
});
