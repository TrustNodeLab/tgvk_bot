// Тесты аналитики студии: дневные метрики (посты/подписчики), отчёты
// (вечерняя сводка, день, неделя, месяц) и автопубликация по времени.
// Вовлечённость вырезана — отчёты считают только посты и подписчиков.
// Запуск: node --test worker/test/analytics.test.js

import { test } from "node:test";
import assert from "node:assert/strict";

const ANALYTICS = "file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/analytics.js";
const KV = "file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js";

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
    TELEGRAM_BOT_TOKEN: "123:token",
    TELEGRAM_ADMIN_CHAT_ID: "42",
    TELEGRAM_CHANNEL_ID: "-1001",
    VK_TOKEN: "vk",
    VK_GROUP_ID: "7",
    LLM_PROXY_URL: "https://render.test",
  };
}

function jsonRes(data) {
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}

// Стаб fetch: Telegram getChat / getChatMemberCount / sendMessage + VK
// groups.getById. Возвращает счётчики вызовов и отправленные сообщения.
function stubFetch({ tgMembers = 120, vkMembers = 890, failSubscribers = false } = {}) {
  const calls = { tgCount: 0, vkCount: 0, sent: [] };
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("api.telegram.org/bot")) {
      if (u.includes("/getChatMemberCount")) {
        calls.tgCount++;
        if (failSubscribers) return jsonRes({ ok: false, description: "method not available" });
        return jsonRes({ ok: true, result: tgMembers });
      }
      if (u.includes("/getChat")) {
        if (failSubscribers) return jsonRes({ ok: false, description: "chat not found" });
        return jsonRes({ ok: true, result: { id: -100100 } });
      }
      if (u.includes("/sendMessage")) {
        calls.sent.push(JSON.parse(opts.body || "{}"));
        return jsonRes({ ok: true, result: { message_id: 1 } });
      }
      return jsonRes({ ok: true, result: {} });
    }
    if (u.includes("api.vk.com")) {
      calls.vkCount++;
      return jsonRes({ response: [{ members_count: vkMembers }] });
    }
    return new Response("not found", { status: 404 });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

function post(id, publishedAt, { views = 0, likes = 0, reposts = 0, reactions = 0 } = {}) {
  return {
    id,
    kind: "news",
    title: `Пост ${id}`,
    published_at: publishedAt,
    vk_ok: true,
    tg_ok: true,
    stats: {
      vk: { views, likes, reposts },
      reactions_total: reactions,
    },
  };
}

test("collectDailyMetrics: считает посты дня и подписчиков в day_metrics", async () => {
  const { collectDailyMetrics } = await import(ANALYTICS);
  const kv = makeKV();
  const env = makeEnv(kv);
  const stock = await import(KV);
  const now = new Date("2026-08-15T12:00:00Z"); // МСК 15:00
  await stock.addLog(env, post("a", "2026-08-15T09:30:00Z"));
  await stock.addLog(env, post("b", "2026-08-15T11:00:00Z"));
  await stock.addLog(env, post("c", "2026-08-14T09:30:00Z")); // вчера — не в счёт

  const s = stubFetch();
  try {
    const rec = await collectDailyMetrics(env, { now });
    assert.equal(rec.date, "2026-08-15");
    assert.equal(rec.posts, 2, "посты только за сегодня");
    assert.equal(rec.tg_members, 120, "подписчики TG");
    assert.equal(rec.vk_members, 890, "подписчики VK");
    assert.ok(s.calls.tgCount >= 1, "запрос getChatMemberCount");
    assert.ok(s.calls.vkCount >= 1, "запрос groups.getById");
    // запись легла в KV
    const saved = await stock.getDayMetrics(env, "2026-08-15");
    assert.equal(saved.posts, 2, "запись в KV");
  } finally {
    s.restore();
  }
});

test("collectDailyMetrics: ошибка подписчиков не роняет сбор (null)", async () => {
  const { collectDailyMetrics } = await import(ANALYTICS);
  const env = makeEnv();
  const s = stubFetch({ failSubscribers: true });
  try {
    const rec = await collectDailyMetrics(env, { now: new Date("2026-08-15T12:00:00Z") });
    assert.equal(rec.tg_members, null, "TG не доступен — null");
    assert.ok(rec.vk_members === 890 || rec.vk_members === null, "VK либо сработал, либо null");
    assert.equal(typeof rec.posts, "number", "метрики постов на месте");
  } finally {
    s.restore();
  }
});

test("eveningSummaryText: сводка дня с дельтами к вчера и подписчиками", async () => {
  const { eveningSummaryText } = await import(ANALYTICS);
  const kv = makeKV();
  const env = makeEnv(kv);
  const stock = await import(KV);
  const now = new Date("2026-08-15T12:00:00Z");
  await stock.setDayMetrics(env, "2026-08-14", { date: "2026-08-14", posts: 1, tg_members: 110, vk_members: 880 });
  await stock.addLog(env, post("a", "2026-08-15T09:30:00Z"));
  await stock.addLog(env, post("b", "2026-08-15T11:00:00Z"));

  const s = stubFetch();
  try {
    const text = await eveningSummaryText(env, { now });
    assert.ok(text.includes("Вечерняя сводка"), "заголовок сводки");
    assert.ok(text.includes("15.08"), "дата в МСК");
    assert.ok(text.includes("<b>2</b>"), "посты дня");
    assert.ok(text.includes("120"), "подписчики TG");
    assert.ok(text.includes("890"), "подписчики VK");
    assert.ok(/вчера \d+/.test(text), "упоминание вчера");
  } finally {
    s.restore();
  }
});

test("dayReportText: отчёт за день с достижениями и дельтой к вчера", async () => {
  const { dayReportText } = await import(ANALYTICS);
  const kv = makeKV();
  const env = makeEnv(kv);
  const stock = await import(KV);
  const now = new Date("2026-08-15T12:00:00Z");
  await stock.setDayMetrics(env, "2026-08-14", { date: "2026-08-14", posts: 1 });
  await stock.addLog(env, post("a", "2026-08-15T09:30:00Z"));

  const s = stubFetch();
  try {
    const text = await dayReportText(env, { now });
    assert.ok(text.includes("Отчёт за день"), "заголовок");
    assert.ok(text.includes("Чего достигли сегодня"), "блок достижений");
    assert.ok(text.includes("По сравнению со вчера"), "дельты к вчера");
  } finally {
    s.restore();
  }
});

test("weekReportText: агрегирует неделю и сравнивает с прошлой", async () => {
  const { weekReportText } = await import(ANALYTICS);
  const kv = makeKV();
  const env = makeEnv(kv);
  const stock = await import(KV);
  const now = new Date("2026-08-16T17:35:00Z"); // вс МСК 20:35
  // текущая неделя: 10-16.08
  for (let d = 10; d <= 16; d++) {
    const date = `2026-08-${String(d).padStart(2, "0")}`;
    await stock.setDayMetrics(env, date, { date, posts: 2, views: 500, likes: 20, reactions: 30, reposts: 1, engagement: 1200, tg_members: 110 + d, vk_members: 880 + d });
  }
  // прошлая неделя: 03-09.08 — меньше
  for (let d = 3; d <= 9; d++) {
    const date = `2026-08-${String(d).padStart(2, "0")}`;
    await stock.setDayMetrics(env, date, { date, posts: 1, views: 300, likes: 10, reactions: 15, reposts: 0, engagement: 700, tg_members: 90 + d, vk_members: 870 + d });
  }

  const s = stubFetch();
  try {
    const text = await weekReportText(env, { now });
    assert.ok(text.includes("Недельная сводка"), "заголовок недели");
    assert.ok(text.includes("10.08"), "начало недели");
    assert.ok(text.includes("16.08"), "конец недели");
    assert.ok(text.includes("<b>14</b>"), "сумма постов недели (7 дней × 2)");
    assert.ok(text.includes("(+44 за неделю)"), "рост подписчиков за неделю");
  } finally {
    s.restore();
  }
});

test("monthReportText: агрегирует месяц", async () => {
  const { monthReportText } = await import(ANALYTICS);
  const kv = makeKV();
  const env = makeEnv(kv);
  const stock = await import(KV);
  const now = new Date("2026-08-16T17:35:00Z");
  for (let d = 1; d <= 15; d++) {
    const date = `2026-08-${String(d).padStart(2, "0")}`;
    await stock.setDayMetrics(env, date, { date, posts: 2, views: 400, likes: 10, reactions: 20, reposts: 0, engagement: 900, tg_members: 100 + d, vk_members: 880 });
  }

  const s = stubFetch();
  try {
    const text = await monthReportText(env, { now });
    assert.ok(text.includes("Месячная сводка"), "заголовок месяца");
    assert.ok(text.includes("август 2026"), "месяц и год");
    assert.ok(text.includes("<b>30</b>"), "сумма постов (15 дней × 2)");
  } finally {
    s.restore();
  }
});

test("maybeSendReports: вечерняя сводка уходит один раз и не повторяется", async () => {
  const { maybeSendReports } = await import(ANALYTICS);
  const kv = makeKV();
  const env = makeEnv(kv);
  const stock = await import(KV);
  const within = new Date("2026-08-15T17:05:00Z"); // МСК 20:05 — окно вечера
  await stock.addLog(env, post("a", "2026-08-15T09:30:00Z", { views: 100, likes: 3 }));

  const s = stubFetch();
  try {
    const first = await maybeSendReports(env, { now: within });
    assert.deepEqual(first, ["evening"], "вечерняя сводка отправлена");
    assert.equal(s.calls.sent.length, 1, "одно сообщение админу");
    const second = await maybeSendReports(env, { now: within });
    assert.deepEqual(second, [], "повторный тик в окне — без дубля");
    assert.equal(s.calls.sent.length, 1, "сообщение не продублировано");
  } finally {
    s.restore();
  }
});

test("maybeSendReports: вне окна и без админа ничего не шлёт", async () => {
  const { maybeSendReports } = await import(ANALYTICS);
  const kv = makeKV();
  const env = makeEnv(kv);
  const stock = await import(KV);
  await stock.addLog(env, post("a", "2026-08-15T09:30:00Z", { views: 100, likes: 3 }));
  const noon = new Date("2026-08-15T07:00:00Z"); // МСК 10:00 — не время отчётов

  const s = stubFetch();
  try {
    assert.deepEqual(await maybeSendReports(env, { now: noon }), [], "днём ничего не шлём");
    assert.equal(s.calls.sent.length, 0, "сообщений нет");
  } finally {
    s.restore();
  }

  const envNoAdmin = makeEnv(makeKV());
  envNoAdmin.TELEGRAM_ADMIN_CHAT_ID = undefined;
  const s2 = stubFetch();
  try {
    const within = new Date("2026-08-15T17:05:00Z");
    assert.deepEqual(await maybeSendReports(envNoAdmin, { now: within }), [], "без админа не шлём");
    assert.equal(s2.calls.sent.length, 0, "сообщений нет");
  } finally {
    s2.restore();
  }
});

test("maybeSendReports: недельная сводка — только в воскресенье в 20:30", async () => {
  const { maybeSendReports } = await import(ANALYTICS);
  const kv = makeKV();
  const env = makeEnv(kv);
  const stock = await import(KV);
  const sunday = new Date("2026-08-16T17:35:00Z"); // вс МСК 20:35
  for (let d = 10; d <= 16; d++) {
    const date = `2026-08-${String(d).padStart(2, "0")}`;
    await stock.setDayMetrics(env, date, { date, posts: 2, views: 500, likes: 20, reactions: 30, reposts: 1, engagement: 1200, tg_members: 100 + d, vk_members: 880 + d });
  }

  const s = stubFetch();
  try {
    const sent = await maybeSendReports(env, { now: sunday });
    assert.ok(sent.includes("week"), "недельная сводка отправлена в вс");
    assert.equal(s.calls.sent.length, 1, "только недельная сводка");
  } finally {
    s.restore();
  }

  const kv2 = makeKV();
  const env2 = makeEnv(kv2);
  const stock2 = await import(KV);
  const saturday = new Date("2026-08-15T17:35:00Z"); // сб МСК 20:35 — не воскресенье
  for (let d = 9; d <= 15; d++) {
    const date = `2026-08-${String(d).padStart(2, "0")}`;
    await stock2.setDayMetrics(env2, date, { date, posts: 2, views: 500, likes: 20, reactions: 30, reposts: 1, engagement: 1200, tg_members: 100 + d, vk_members: 880 + d });
  }
  const s2 = stubFetch();
  try {
    assert.deepEqual(await maybeSendReports(env2, { now: saturday }), [], "в субботу недельную не шлём");
  } finally {
    s2.restore();
  }
});
