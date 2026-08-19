// Тесты расписания (lib/schedule.js) и динамических слотов (nextFreeSlot).
// Авто-корректировка частоты и дашборд статистики вырезаны вместе с
// вовлечённостью — расписание меняется только вручную.
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

test("nextFreeSlot учитывает доп. окна расписания", async () => {
  const { nextFreeSlot } = await import(SCHED);
  const { setSlotsPerDay } = await import(SCHEDULE);
  const { ekbNow } = await import(CONFIG);
  const env = makeEnv();
  await setSlotsPerDay(env, 4); // база 3 + обеденное 12:00
  const now = new Date("2026-08-07T06:00:00Z"); // 11:00 ЕКБ — внутри утреннего окна, слот 09:00 уже прошёл
  const slot = await nextFreeSlot(env, now);
  const ekb = ekbNow(new Date(slot));
  assert.equal(ekb.minuteOfDay, 12 * 60, "следующий слот — обеденный 12:00 ЕКБ (доп. окно)");
});
