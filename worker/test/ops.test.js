// Тесты операционных догонялок (lib/ops.js), poll-статов (lib/kv.js) и
// VK-метрик в аналитике (lib/analytics.js). Всё best-effort: без токенов/прав
// функции возвращают ok:false, но не бросают.
// Запуск: node --test worker/test/ops.test.js

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
    TELEGRAM_ADMIN_CHAT_ID: "42",
    TELEGRAM_CHANNEL_ID: "-1001",
    VK_TOKEN: "vk",
    VK_GROUP_ID: "1",
    BOT_AUTH: "secret",
    WEBHOOK_SECRET: "secret",
    LLM_PROXY_URL: "https://render.test",
  };
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// fetch-мок: VK wall.getById отдаёт просмотры, GitHub Contents — sha при GET.
function installFetchMock() {
  const calls = { tg: [], vk: [], github: [] };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      calls.tg.push({ url: u, body: opts.body });
      return jsonResp({ ok: true, result: { message_id: 1 } });
    }
    if (u.includes("api.vk.com")) {
      calls.vk.push({ url: u, body: opts.body, method: opts.method || "POST" });
      if (u.includes("wall.getById")) {
        const body = new URLSearchParams(opts.body);
        const count = String(body.get("posts") || "").split(",").length;
        return jsonResp({
          response: { items: Array.from({ length: count }, (_, i) => ({ id: 100 + i, views: { count: 500 + i }, likes: { count: 20 }, reposts: { count: 3 } })) },
        });
      }
      // groups.getById и прочее — пустой ответ
      return jsonResp({ response: [] });
    }
    if (u.includes("api.github.com")) {
      calls.github.push({ url: u, opts });
      if (String(opts.method || "").toUpperCase() === "PUT") return jsonResp({ content: { sha: "new" } });
      return jsonResp({ sha: "abc123" }); // файл уже существует
    }
    return jsonResp({});
  };
  return calls;
}

const OPS = "file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/ops.js";
const KV = "file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js";
const ANALYTICS = "file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/analytics.js";

test("recordPollAnswer: суммирует ответы и вопросы по poll_id", async () => {
  const { recordPollAnswer, getPollStats } = await import(KV);
  const env = makeEnv();
  await recordPollAnswer(env, { poll_id: "p1", user: { id: 1 }, option_ids: [0], poll: { question: "Вопрос?" } });
  await recordPollAnswer(env, { poll_id: "p1", user: { id: 2 }, option_ids: [0, 1], poll: { question: "Вопрос?" } });
  const stats = await getPollStats(env);
  assert.equal(stats.p1.total, 2, "два ответа");
  assert.equal(stats.p1.question, "Вопрос?", "вопрос сохранён");
  await recordPollAnswer(env, { poll_id: "p1", user: { id: 1 }, option_ids: [1] });
  assert.equal((await getPollStats(env)).p1.total, 1, "повторный ответ не удваивает");
});

test("fetchVkEngagement: догоняет просмотры по wall.getById и пишет в лог", async () => {
  const kv = await import(KV);
  const { fetchVkEngagement } = await import(ANALYTICS);
  const calls = installFetchMock();
  const env = makeEnv();
  await kv.addLog(env, {
    id: "e1",
    vk_post_id: "100",
    vk_ok: true,
    tg_ok: true,
    published_at: new Date(Date.now() - 3600 * 1000).toISOString(),
    kind: "news",
  });
  const res = await fetchVkEngagement(env);
  assert.equal(res.ok, true, "сбор прошёл");
  assert.equal(res.fetched, 1, "один пост обновлён");
  const log = await kv.getLog(env);
  assert.equal(log[0].vk_views, 500, "просмотры записаны");
  assert.equal(log[0].vk_likes, 20, "лайки записаны");
  assert.ok(calls.vk.some((c) => c.url.includes("wall.getById")), "wall.getById вызван");
});

test("fetchVkEngagement: error 27 (нет прав) → ставит флаг и больше не дёргает", async () => {
  const kv = await import(KV);
  const { fetchVkEngagement } = await import(ANALYTICS);
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("api.vk.com")) {
      return jsonResp({ error: { error_code: 27, error_msg: "Permission denied" } });
    }
    return jsonResp({});
  };
  const env = makeEnv();
  await kv.addLog(env, { id: "e1", vk_post_id: "100", vk_ok: true, published_at: new Date().toISOString() });
  const res = await fetchVkEngagement(env);
  assert.equal(res.ok, false, "сбор отключён");
  assert.match(res.reason, /cannot read wall/, "причина — нет прав");
  assert.equal(await kv.getVkEngageDisabled(env), true, "флаг выставлен");
});

test("collectEngagement: троттлится на 45 минут", async () => {
  const { collectEngagement, ENGAGE_THROTTLE_MS } = await import(OPS);
  const calls = installFetchMock();
  const env = makeEnv();
  const t0 = new Date("2026-08-07T10:00:00Z");
  const r1 = await collectEngagement(env, { now: t0 });
  assert.equal(r1.ok, true, "первый запуск работает");
  const ctx = calls.vk.length;
  const r2 = await collectEngagement(env, { now: new Date(t0.getTime() + 10 * 60 * 1000) });
  assert.equal(r2.ok, false, "второй в течение 45 минут пропущен");
  assert.equal(calls.vk.length, ctx, "VK не дёргался повторно");
  const r3 = await collectEngagement(env, { now: new Date(t0.getTime() + ENGAGE_THROTTLE_MS + 1000) });
  assert.equal(r3.ok, true, "после 45 минут снова работает");
});

test("missedWindowsToday: только окна, чей старт уже наступил и постанов не было", async () => {
  const kv = await import(KV);
  const { missedWindowsToday } = await import(OPS);
  const env = makeEnv();
  await kv.addLog(env, {
    id: "e1",
    vk_ok: true,
    window_slug: "morning",
    published_at: new Date("2026-08-08T05:00:00Z").toISOString(), // 10:00 ЕКБ — утро отработало
  });
  // 2026-08-08 06:00Z = 11:00 ЕКБ: утро (09-12) уже выдало пост, день ещё не начался.
  const missed = await missedWindowsToday(env, { now: new Date("2026-08-08T06:00:00Z") });
  assert.equal(missed.length, 0, "день/вечер ещё не начались — пропусков нет");
  // 2026-08-08 16:00Z = 21:00 ЕКБ: утро отработало, день и вечер — нет.
  const missedLate = await missedWindowsToday(env, { now: new Date("2026-08-08T16:00:00Z") });
  const slugs = missedLate.map((w) => w.slug).sort();
  assert.deepEqual(slugs, ["day", "evening"], "дневное и вечернее окна пропущены");
});

test("maybeHealthAlert: сводка за вчера, один раз в сутки, только в час алерта", async () => {
  const { maybeHealthAlert } = await import(OPS);
  const calls = installFetchMock();
  const env = makeEnv();
  // вчера (2026-08-07) утро выдало пост — сегодня в 01:00 ЕКБ алерт про день/вечер
  const kv = await import(KV);
  await kv.addLog(env, {
    id: "e1",
    vk_ok: true,
    window_slug: "morning",
    published_at: new Date("2026-08-07T05:00:00Z").toISOString(), // 10:00 ЕКБ 07-08
  });
  const night = new Date("2026-08-07T20:00:00Z"); // 01:00 ЕКБ 08-08 → час алерта
  const r1 = await maybeHealthAlert(env, { now: night });
  assert.equal(r1.ok, true, "алерт про вчерашние пропуски отправлен");
  const r2 = await maybeHealthAlert(env, { now: night });
  assert.equal(r2.ok, false, "второй раз в сутки не шлём");
  const r3 = await maybeHealthAlert(env, { now: new Date("2026-08-07T06:00:00Z") });
  assert.equal(r3.ok, false, "в 11:00 ЕКБ алерт не шлётся");
  assert.equal(calls.tg.filter((c) => c.url.includes("sendMessage")).length, 1, "отправлено одно сообщение");
});

test("maybeBackupToGitHub: запускается только в свой час, один раз в сутки", async () => {
  const { maybeBackupToGitHub } = await import(OPS);
  const calls = installFetchMock();
  const env = makeEnv();
  const night = new Date("2026-08-07T22:00:00Z"); // 03:00 ЕКБ 08-08
  const r0 = await maybeBackupToGitHub(env, { now: new Date("2026-08-07T06:00:00Z") });
  assert.equal(r0.ok, false, "не в час бэкапа — пропуск");
  const r1 = await maybeBackupToGitHub(env, { now: night });
  assert.equal(r1.ok, true, "бэкап ушёл в GitHub");
  const r2 = await maybeBackupToGitHub(env, { now: night });
  assert.equal(r2.ok, false, "повторно в сутки не бэкапим");
  const puts = calls.github.filter(
    (c) => c.url.includes("/contents/backups") && String(c.opts.method || "").toUpperCase() === "PUT"
  ).length;
  assert.equal(puts, 1, "один PUT в Contents API");
});

test("buildBackup: снапшот без тяжёлых полей (png/b64/bytes вырезаны)", async () => {
  const kv = await import(KV);
  const { buildBackup } = await import(OPS);
  const env = makeEnv();
  await kv.addLog(env, { id: "e1", kind: "news", vk_ok: true, published_at: new Date().toISOString(), png: "AAAA", b64: "qwerty", bytes: [1, 2] });
  const b = await buildBackup(env, { now: new Date("2026-08-07T06:00:00Z") });
  assert.equal(b.publish_log[0].png, undefined, "png вырезан");
  assert.equal(b.publish_log[0].b64, undefined, "b64 вырезан");
  assert.equal(b.publish_log[0].bytes, undefined, "bytes вырезан");
  assert.equal(b.publish_log[0].kind, "news", "содержимое поста сохранено");
  assert.equal(b.day, "2026-08-07", "ключ дня указан");
});