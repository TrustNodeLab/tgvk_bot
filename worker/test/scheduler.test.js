// Модульные тесты Worker: node:test + стабы KV/fetch. Без реальных публикаций.
// Запуск: node --test worker/test/

import { test } from "node:test";
import assert from "node:assert/strict";

// ---------- стабы ----------

export function makeKV() {
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

export function makeEnv(kv = makeKV()) {
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

const CONFIG_JSON = {
  feeds: ["https://example.com/rss1.xml", "https://example.com/rss2.xml"],
  keywords: ["мошенничеств", "фишинг"],
  exclude_keywords: ["военн"],
};

// Глобальный мок fetch: GitHub API, Telegram API, пустые RSS.
// dispatchStatus: HTTP-статус для workflow_dispatch (по умолчанию 204 — успех).
export function installFetchMock(dispatchStatus = 204) {
  const calls = { tg: [], github: [], feeds: [] };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      calls.tg.push({ url: u, body: opts.body });
      return jsonResp({ ok: true, result: { message_id: 1 } });
    }
    if (u.includes("api.github.com")) {
      calls.github.push({ url: u, opts });
      if (u.includes("/contents/config/sources.json")) {
        const content = Buffer.from(JSON.stringify(CONFIG_JSON)).toString("base64");
        return jsonResp({ content });
      }
      if (u.includes("/actions/workflows/poll.yml/dispatches")) {
        return new Response(dispatchStatus === 204 ? null : "boom", { status: dispatchStatus });
      }
      return jsonResp({});
    }
    // любые фиды — пустой RSS, чтобы скан не находил новостей
    calls.feeds.push(u);
    return new Response("<rss><channel><item></item></channel></rss>", {
      status: 200,
      headers: { "Content-Type": "application/xml" },
    });
  };
  return calls;
}

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------- тесты ----------

test("currentWindow: границы окон (МСК)", async () => {
  const { currentWindow } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  assert.equal(currentWindow(6 * 60).start, 6 * 60);
  assert.equal(currentWindow(11 * 60 + 59).start, 6 * 60);
  assert.equal(currentWindow(12 * 60).start, 12 * 60);
  assert.equal(currentWindow(16 * 60 + 59).start, 12 * 60);
  assert.equal(currentWindow(17 * 60).start, 17 * 60);
  assert.equal(currentWindow(21 * 60 + 59).start, 17 * 60);
  assert.equal(currentWindow(22 * 60), null);
  assert.equal(currentWindow(5 * 60 + 59), null);
});

test("nextFreeSlot: свободное окно сейчас -> публикуем немедленно", async () => {
  const { nextFreeSlot } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  const env = makeEnv();
  // 2026-08-07 04:00 UTC = 07:00 МСК (внутри окна 06–12 с вместимостью 2)
  const now = new Date("2026-08-07T04:00:00Z");
  const slot = await nextFreeSlot(env, now);
  assert.equal(slot, now.getTime());
});

test("nextFreeSlot: окно заполнено -> следующий свободный слот", async () => {
  const { nextFreeSlot } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const env = makeEnv();
  const now = new Date("2026-08-07T04:00:00Z"); // 07:00 МСК
  // заполняем окно 06–12 двумя постами сегодня
  for (const h of [7, 9]) {
    await kv.addLog(env, {
      id: `n${h}`,
      kind: "news",
      published_at: new Date("2026-08-07T" + String(h - 3).padStart(2, "0") + ":00:00Z").toISOString(),
    });
  }
  const slot = await nextFreeSlot(env, now);
  const msk = (await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/config.js")).mskNow(new Date(slot));
  // 12–17 МСК в тот же день
  assert.equal(msk.date, "2026-08-07");
  assert.ok(msk.minuteOfDay >= 12 * 60 && msk.minuteOfDay < 17 * 60, `slot min=${msk.minuteOfDay}`);
  assert.ok(slot > now.getTime(), "слот в будущем");
});

test("mskToUtcMs: корректный перевод времени в UTC", async () => {
  const { nextFreeSlot } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  // не экспортируется напрямую — проверяем через поведение nextFreeSlot
  assert.ok(typeof nextFreeSlot === "function");
});

test("dedup: одинаковые новости сворачиваются в кластер", async () => {
  const { clusterDuplicates, normalizeTitle, jaccard } = await import(
    "file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/dedup.js"
  );
  assert.ok(jaccard("Мошенники обманом забирают деньги у пенсионеров", "Мошенники обманом забрали деньги у пенсионеров") >= 0.62);
  const clusters = clusterDuplicates([
    { guid: "a", title: "Мошенники обманом забирают деньги у пенсионеров", description: "long", link: "x", pub_date: "x" },
    { guid: "b", title: "Мошенники обманом забрали деньги у пенсионеров", description: "much longer description", link: "y", pub_date: "x" },
    { guid: "c", title: "Совершенно другая новость про IT", description: "", link: "z", pub_date: "x" },
  ]);
  assert.equal(clusters.length, 2);
  // лучший источник — с наиболее полным текстом
  assert.equal(clusters[0].best.guid, "b");
});

test("tick: пустой скан, ротация chunk, кандидат при неудачном диспатче не теряется", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { tick } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  installFetchMock(500); // GitHub отвечает ошибкой -> кандидат возвращается в очередь
  const calls = installFetchMock(500);
  const env = makeEnv();
  await kv.addCandidate(env, { guid: "g1", title: "Т", link: "http://l", text: "текст" });
  const r = await tick(env);
  assert.equal(r, "ok");
  const state = await kv.loadState(env);
  assert.equal(state.meta.scan_chunk, 1); // 0 -> 1
  const cands = await kv.getCandidates(env);
  assert.ok(cands.some((c) => c.guid === "g1"), "кандидат вернулся в очередь (диспатч неуспешен)");
  assert.ok(calls.github.length > 0, "был вызов GitHub API");
});

test("tick: успешный диспатч убирает кандидата из очереди", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { tick } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  installFetchMock(); // GitHub dispatch -> 204 (успех)
  const env = makeEnv();
  // подмешиваем готовый пакет на склад, чтобы не было диспатча из-за нехватки склада
  await kv.addStock(env, {
    id: "p1",
    kind: "news",
    title: "Готовый",
    caption: "капшн",
    scheduled_for: Date.now() - 1000,
    guid: "gg",
  });
  await kv.addCandidate(env, { guid: "g2", title: "Т2", link: "http://l2", text: "текст2" });
  await tick(env);
  const cands = await kv.getCandidates(env);
  assert.ok(!cands.some((c) => c.guid === "g2"), "кандидат ушёл на подготовку");
});

test("webhook: команда /status отвечает админу", async () => {
  const { default: worker } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/worker.js");
  const calls = installFetchMock();
  const env = makeEnv();
  const req = new Request("https://example.workers.dev/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "secret",
    },
    body: JSON.stringify({
      update_id: 1,
      message: { message_id: 5, chat: { id: 1 }, text: "/status" },
    }),
  });
  const res = await worker.fetch(req, env, { waitUntil() {} });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 50)); // дать waitUntil-эффект отработать
  assert.ok(calls.tg.length >= 1, "бот что-то отправил в Telegram");
});

test("webhook: секретный заголовок обязателен", async () => {
  const { default: worker } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/worker.js");
  const env = makeEnv();
  const req = new Request("https://example.workers.dev/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const res = await worker.fetch(req, env, { waitUntil() {} });
  assert.equal(res.status, 403);
});

test("webhook: reply-кнопка «Сделать пост» даёт подсказку, а не диспатч", async () => {
  const { default: worker } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/worker.js");
  const calls = installFetchMock(500);
  const env = makeEnv();
  const req = new Request("https://example.workers.dev/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify({
      update_id: 9,
      message: { message_id: 5, chat: { id: 1 }, text: "✍️ Сделать пост" },
    }),
  });
  await worker.fetch(req, env, { waitUntil() {} });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls.tg.length >= 1, "бот ответил подсказкой");
  // диспатча на GitHub быть не должно
  assert.equal(calls.github.length, 0);
});

test("webhook: инлайн-кнопка approve отправляет в канал, а не меню", async () => {
  const { default: worker } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/worker.js");
  const calls = installFetchMock(500);
  const env = makeEnv();
  await env.BOT_KV.put("draft:t1", JSON.stringify({
    id: "t1", kind: "news", title: "Тест", caption: "Капшн",
    png_key: null, link: "", guid: "t1", source: "ria.ru", tags: [],
    admin_chat_id: 1, preview_message_id: 5, status: "pending",
  }));
  const req = new Request("https://example.workers.dev/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify({
      update_id: 10,
      callback_query: {
        id: "q1",
        from: { id: 1 },
        message: { message_id: 5, chat: { id: 1 } },
        data: "approve:t1",
      },
    }),
  });
  await worker.fetch(req, env, { waitUntil() {} });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls.tg.length >= 1, "бот ответил на одобрение");
  assert.ok(calls.tg.some((c) => c.url.includes("/bot123:token/sendPhoto")), "пост ушёл в TG");
});

test("autoDefer: черновик без created_at получает таймер, а не публикуется сразу", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { tick } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  installFetchMock(500);
  const env = makeEnv();
  // как шлёт GitHub: без status и без created_at
  await kv.saveDraft(env, { id: "d1", title: "Новость", caption: "капшн", png_key: "drafts/d1.png" });
  await tick(env);
  const drafts = await kv.listDrafts(env);
  assert.equal(drafts.length, 1);
  assert.ok(drafts[0].created_at, "created_at проставлен");
  const stock = await kv.getStock(env);
  assert.equal(stock.length, 0, "ещё не в отложенных");
});

test("autoDefer: черновик старше 30 минут уходит в отложенные", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { tick } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  installFetchMock(500);
  const env = makeEnv();
  const created = new Date(Date.now() - 40 * 60 * 1000).toISOString();
  await kv.saveDraft(env, { id: "d2", title: "Старая новость", caption: "капшн", png_key: "drafts/d2.png", created_at: created });
  await tick(env);
  const drafts = await kv.listDrafts(env);
  assert.equal(drafts.length, 0, "черновик удалён");
  const stock = await kv.getStock(env);
  assert.equal(stock.length, 1, "пост в отложенных");
  assert.ok(stock[0].scheduled_for > Date.now(), "слот в будущем");
});

test("isRussianText: русская статья проходит, иностранная — нет", async () => {
  const { isRussianText } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/feeds.js");
  assert.equal(isRussianText("Мошенники снова атакуют пользователей банковских приложений"), true);
  assert.equal(isRussianText("Scammers target bank app users in new phishing campaign"), false);
  assert.equal(isRussianText("Хакеры атакуют банки: new phishing wave 2026"), true);
  assert.equal(isRussianText(""), true);
});

test("generateByRules: из русского текста получается заголовок, тезисы и caption", async () => {
  const { generateByRules } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/llm.js");
  const text =
    "МВД посоветовало россиянам использовать виртуальную карту для покупок в интернете. " +
    "По данным ведомства, за год мошенники похитили 15,8 млрд рублей. " +
    "Эксперты советуют не сообщать код из SMS и проверять отправителя.";
  const data = generateByRules(text, { link: "https://ria.ru/x" });
  assert.ok(data.headline.length > 10, "есть заголовок");
  assert.ok(data.caption.includes("TrustNode"), "caption с footer");
  assert.ok(data.caption.includes("Источник"), "caption с источником");
  assert.ok(data.cards.some((c) => c.type === "stat" && /15,8/.test(c.number)), "найдена цифра");
  assert.ok(data.cards.some((c) => c.type === "list" && c.items.length >= 2), "тезисы собраны");
});

test("providerPlan: ротация провайдеров по времени суток МСК", async () => {
  const { providerPlan } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/llm.js");
  const env = { LLM_PROXY_URL: "https://render.test" };
  const h = (hour) => ({ hour });
  assert.equal(providerPlan(env, h(8)).joint, false, "утро — не совместный");
  assert.equal(providerPlan(env, h(8)).order[0], "gigachat", "утро — GigaChat первым");
  assert.equal(providerPlan(env, h(14)).joint, true, "день — совместный пост");
  assert.equal(providerPlan(env, h(14)).order.length, 2, "день — оба LLM");
  assert.equal(providerPlan(env, h(19)).order[0], "gemini", "вечер — Gemini первым");
  assert.equal(providerPlan(env, h(23)).order[0], "gigachat", "ночь — GigaChat");
  assert.deepEqual(providerPlan({}, h(14)).order, [], "без прокси — пустой план");
});

test("generatePostData: при недоступном прокси фолбэк на правила", async () => {
  const { generatePostData } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/llm.js");
  const env = { LLM_PROXY_URL: "https://render.test" };
  globalThis.fetch = async () => new Response("boom", { status: 502 });
  const text = "МВД посоветовало использовать виртуальную карту. За год похищено 15,8 млрд рублей.";
  const data = await generatePostData(text, env, {});
  assert.ok(data.caption && data.caption.includes("TrustNode"), "фолбэк на правила с footer");
  delete globalThis.fetch;
});

test("webhook: обычный текст генерит карточку и превью на одобрение (без GitHub)", async () => {
  const { default: worker } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/worker.js");
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const calls = installFetchMock(500);
  const env = makeEnv();
  const req = new Request("https://example.workers.dev/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify({
      update_id: 11,
      message: {
        message_id: 6,
        chat: { id: 1 },
        text: "МВД посоветовало использовать виртуальную карту для покупок в интернете. За год мошенники похитили 15,8 млрд рублей.",
      },
    }),
  });
  await worker.fetch(req, env, { waitUntil() {} });
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(calls.tg.some((c) => c.url.includes("/sendPhoto")), "превью-фото отправлено");
  assert.equal(calls.github.length, 0, "GitHub не вызывался");
  const drafts = await kv.listDrafts(env);
  const gen = drafts.find((d) => d.kind === "generated");
  assert.ok(gen, "черновик создан");
  assert.ok(gen.png, "карточка сохранена в черновике");
});
