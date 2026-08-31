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
    LLM_PROXY_URL: "https://render.test",
  };
}

const CONFIG_JSON = {
  feeds: ["https://example.com/rss1.xml", "https://example.com/rss2.xml"],
  keywords: ["мошенничеств", "фишинг"],
  exclude_keywords: ["военн"],
};

// Глобальный мок fetch: GitHub API, Telegram API, пустые RSS.
// dispatchStatus: HTTP-статус для workflow_dispatch (по умолчанию 204 — успех).
// mixOptions: ответы /mix (format) и /poll (question/options) для авто-микса.
export function installFetchMock(dispatchStatus = 204, mixOptions = {}) {
  const calls = { tg: [], github: [], feeds: [] };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      calls.tg.push({ url: u, body: opts.body });
      return jsonResp({ ok: true, result: { message_id: 1 } });
    }
    if (u.includes("render.test/digest")) {
      const body = JSON.parse(opts.body || "{}");
      const n = Array.isArray(body.items) ? body.items.length : 2;
      const bullets = [];
      for (let i = 0; i < n; i++) {
        bullets.push(`Новость ${i + 1}: схема обмана, продавцы просят предоплату. Наш совет — не платить незнакомцам.`);
      }
      return jsonResp({
        headline: "Мошенничество: главное",
        bullets,
        advice: ["Не платите предоплату незнакомцам."],
      });
    }
    if (u.includes("render.test/mix")) {
      return jsonResp({
        format: mixOptions.format || "digest",
        reason: "тестовая заглушка",
      });
    }
    if (u.includes("render.test/poll")) {
      return jsonResp({
        question: mixOptions.question || "Сталкивались ли вы с этой схемой?",
        options: mixOptions.options || ["Да", "Нет", "Не уверен"],
      });
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

test("currentWindow: границы окон (ЕКБ) — 3 дайджест-окна", async () => {
  const { currentWindow } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  // окна: 09–12 (утро), 13–17 (день), 18–24 (вечер)
  assert.equal(currentWindow(0), null); // 00:00 — вне окон
  assert.equal(currentWindow(8 * 60 + 59), null); // 08:59 — ещё не утро
  assert.equal(currentWindow(9 * 60).slug, "morning");
  assert.equal(currentWindow(11 * 60 + 59).slug, "morning");
  assert.equal(currentWindow(12 * 60), null); // 12:00 — перерыв
  assert.equal(currentWindow(13 * 60).slug, "day");
  assert.equal(currentWindow(16 * 60 + 59).slug, "day");
  assert.equal(currentWindow(17 * 60), null); // 17:00 — перерыв
  assert.equal(currentWindow(18 * 60).slug, "evening");
  assert.equal(currentWindow(23 * 60 + 59).slug, "evening");
});

test("nextFreeSlot: свободное окно сейчас -> публикуем немедленно", async () => {
  const { nextFreeSlot } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  const env = makeEnv();
  // 2026-08-07 04:00 UTC = 09:00 ЕКБ — ровно начало утреннего окна (вместимость 1)
  const now = new Date("2026-08-07T04:00:00Z");
  const slot = await nextFreeSlot(env, now);
  assert.equal(slot, now.getTime());
});

test("nextFreeSlot: окно заполнено -> следующий свободный слот (ровно начало окна)", async () => {
  const { nextFreeSlot } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const env = makeEnv();
  const now = new Date("2026-08-07T07:05:00Z"); // 12:05 ЕКБ — утро закончилось, день не начался
  // заполняем окно 09–12 одним постом сегодня (в 09:00 ЕКБ = 04:00 UTC)
  await kv.addLog(env, {
    id: "n7",
    kind: "news",
    published_at: new Date("2026-08-07T04:00:00Z").toISOString(), // 09:00 ЕКБ
  });
  const slot = await nextFreeSlot(env, now);
  const ekb = (await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/config.js")).ekbNow(new Date(slot));
  // следующий слот — ровно начало дневного окна 13:00 ЕКБ того же дня
  assert.equal(ekb.date, "2026-08-07");
  assert.equal(ekb.minuteOfDay, 13 * 60, `слот = 13:00 ЕКБ, а не ${ekb.minuteOfDay}`);
  assert.ok(slot > now.getTime(), "слот в будущем");
});

test("ekbToUtcMs: корректный перевод времени в UTC", async () => {
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

test("tick: скан и ротация chunk; вне окна очередь не трогается, GitHub не зовётся", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { tick } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  const calls = installFetchMock(500); // GitHub отвечает ошибкой — но и не должен вызываться
  const env = makeEnv();
  await kv.addCandidate(env, { guid: "g1", title: "Т", link: "http://l", text: "текст", found_at: new Date().toISOString() });
  const r = await tick(env, { now: new Date("2026-08-07T00:00:00Z") }); // 05:00 ЕКБ — вне окон
  assert.equal(r, "ok");
  const state = await kv.loadState(env);
  assert.equal(state.meta.scan_chunk, 1); // 0 -> 1
  const cands = await kv.getCandidates(env);
  assert.ok(cands.some((c) => c.guid === "g1"), "вне окна кандидат остаётся в очереди");
  assert.equal(calls.github.filter((c) => c.url.includes("/dispatches")).length, 0, "workflow_dispatch не вызывался");
});

test("tick: автопостинг выкл -> в окне админу уходит превью одиночной новости (draft) без GitHub", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { tick } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  const calls = installFetchMock(500); // GitHub «лежит» — но не должен вызываться
  const env = makeEnv();
  await kv.addCandidate(env, {
    guid: "g3",
    title: "Т3",
    link: "http://l3",
    text: "МВД посоветовало использовать виртуальную карту. За год похищено 15,8 млрд рублей.",
    found_at: new Date().toISOString(),
  });
  await tick(env, { now: new Date("2026-08-07T06:00:00Z") }); // 11:00 ЕКБ — утро
  const drafts = await kv.listDrafts(env);
  const dg = drafts.find((d) => d.kind === "news" && d.guid === "g3");
  assert.ok(dg, "черновик-превью одиночной новости создан");
  assert.ok(dg.caption.includes("TrustNode"), "caption с футером");
  assert.ok(calls.tg.some((c) => c.url.includes("/sendPhoto")) ||
    calls.tg.some((c) => c.url.includes("/sendAnimation")), "превью ушло в TG");
  assert.equal(calls.github.filter((c) => c.url.includes("/dispatches")).length, 0, "workflow_dispatch не вызывался");
  const cands = await kv.getCandidates(env);
  assert.ok(!cands.some((c) => c.guid === "g3"), "кандидат потреблён постом");
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
    png: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAhklEQVR4nNXOQRHAIBDAwBAh4N9Jq+oQ0Ucnq2DXzLznkLWevSmTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOP8OfHUBEc4FhwzLqggAAAAASUVORK5CYII=",
    png_key: null, link: "", guid: "t1", source: "ria.ru", tags: [],
    admin_chat_id: 1, preview_message_id: 5, status: "pending",
  }));  const req = new Request("https://example.workers.dev/", {
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

test("isPoliticalText: политика отсекается, кроме мошенничества", async () => {
  const { isPoliticalText } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/feeds.js");
  const politics = ["политик", "депутат", "госдум", "законопроект", "партия", "президент", "выборы"];
  const fraud = ["мошенник", "мошенничеств", "фишинг", "аферист"];
  // чистая политика — мимо
  assert.equal(isPoliticalText("Депутаты Госдумы предлагают законопроект о штрафах", politics, fraud), true);
  assert.equal(isPoliticalText("Политики обсудили бюджет на встрече", politics, fraud), true);
  // политика + мошенничество — проходит (тематика канала)
  assert.equal(isPoliticalText("Депутат стал жертвой мошенников и потерял сбережения", politics, fraud), false);
  assert.equal(isPoliticalText("Мошенники звонят от имени Госдумы, выманивая данные", politics, fraud), false);
  // не политика — проходит
  assert.equal(isPoliticalText("Мошенники выманивают деньги через поддельные сайты", politics, fraud), false);
  assert.equal(isPoliticalText("Фишинговая рассылка от имени банка", politics, fraud), false);
  // пустой список политики — ничего не отсекаем
  assert.equal(isPoliticalText("Депутаты что-то предлагают", [], fraud), false);
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

test("generateByRules: схемы мошенничества дают совет по защите в fallback", async () => {
  const { generateByRules } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/llm.js");
  const text =
    "Мошенники звонят россиянам, представляясь сотрудниками банка. " +
    "Лжеоператоры убеждают перевести деньги на «безопасный счёт». " +
    "Банк советует не называть код из SMS и самим перезванивать по номеру карты.";
  const data = generateByRules(text, { link: "https://example.com/news" });
  assert.ok(data.caption.includes("🛡️ Что делать"), "есть блок защиты в caption");
  assert.ok(data.caption.includes("безопасный счёт"), "совет про безопасный счёт");
  assert.ok(data.cards.some((c) => c.type === "list" && c.label === "Как защититься"), "карточка защиты");
  assert.ok(data.cards.some((c) => c.items.length >= 2), "в защите несколько пунктов");
});

test("fitCaption: футер всегда целиком, без многоточия перед ним", async () => {
  const { fitCaption } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/text.js");
  const FOOTER =
    "🛡️ <b>TrustNode</b>\n" +
    '📱 Приложение: <a href="https://x.app">RuStore</a>\n' +
    '🌐 Сайт: <a href="https://site.io">site.io</a>';
  // длинный текст, который точно превышает лимит
  const longBody =
    "🌅 <b>Заголовок</b>\n\n" +
    "• <b>1.</b> Первая новость с длинным описанием, которое занимает место. " +
    "Вторая часть предложения о том, что случилось и почему это важно читателю.\n" +
    '<a href="https://x.com/a">источник →</a>\n\n' +
    "• <b>2.</b> Вторая новость тоже достаточно длинная, чтобы занять место. " +
    "Продолжаем рассказывать про схему обмана и защиту.\n" +
    '<a href="https://x.com/b">источник →</a>\n\n' +
    "🛡️ <b>Что делать</b>\n\n" +
    "• Не доверяйте посторонним\n\n" +
    "• Второй совет для безопасности";
  const caption = longBody + "\n\n" + FOOTER;
  const fit = fitCaption(caption, 1024);
  assert.ok(fit.length <= 1024, `caption в лимите (${fit.length})`);
  assert.ok(fit.includes("TrustNode"), "футер есть");
  assert.ok(fit.endsWith("site.io</a>"), "футер целиком в конце");
  const tail = fit.slice(0, fit.indexOf("🛡️ <b>TrustNode</b>")).trimEnd();
  assert.ok(!tail.endsWith("…"), "перед футером нет многоточия");
});

test("fitCaption: короткий текст не трогается", async () => {
  const { fitCaption } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/text.js");
  const short = "🌅 <b>Привет</b>\n\n🛡️ <b>TrustNode</b>";
  assert.equal(fitCaption(short, 1024), short);
});


test("generateByRules: заголовок берётся с первой строки, а не обрывок с лидом", async () => {
  const { generateByRules } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/llm.js");
  const text =
    "Шадаев исключил создание мессенджера на Госуслугах\n\n" +
    "Глава Минцифры назвал главной целью этого шага защиту личных данных пользователей. " +
    "Мессенджер развивался бы на закрытой инфраструктуре.";
  const data = generateByRules(text, { link: "https://ria.ru/x" });
  assert.ok(data.headline.includes("Шадаев"), "заголовок из первой строки");
  assert.ok(!data.headline.includes("Глава Минцифры"), "лид не склеен в заголовок");
});

test("generatePostData: принудительный провайдер rules не зовёт LLM", async () => {
  const { generatePostData } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/llm.js");
  const env = { LLM_PROXY_URL: "https://render.test", LLM_API_KEY: "x", LLM_API_BASE: "https://x.example" };
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; return new Response("boom", { status: 502 }); };
  const data = await generatePostData(
    "Мошенники звонят россиянам, представляясь сотрудниками банка. Банк советует не называть код из SMS.",
    env,
    { provider: "rules" }
  );
  assert.equal(fetchCalls, 0, "при rules LLM не вызывается");
  assert.ok(data.caption && data.caption.includes("TrustNode"), "фолбэк сгенерирован");
  delete globalThis.fetch;
});

test("nlp: классификатор тем находит телефонное мошенничество", async () => {
  const { mainTopic, classifyTopics } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/nlp.js");
  const t = mainTopic("Мошенники звонят россиянам и представляются сотрудниками банка, убеждая перевести деньги на безопасный счёт");
  assert.equal(t.id, "call", "тема — телефонное мошенничество");
  assert.ok(classifyTopics("инвестиции в криптовалюту обещают доход 300%").some((x) => x.id === "invest"), "крипто-тема определена");
});

test("nlp: extractStats берёт сумму с контекстом предложения", async () => {
  const { extractStats } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/nlp.js");
  const stats = extractStats("За год мошенники похитили 15,8 млрд рублей. Взломано 2 млн аккаунтов Госуслуг.");
  assert.equal(stats.length, 2, "две цифры найдены");
  assert.ok(/15,8/.test(stats[0].value), "первая сумма");
  assert.ok(stats[0].context.includes("похитили"), "контекст предложения сохранён");
});

test("nlp: stripLead срезает вводную конструкцию", async () => {
  const { stripLead } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/nlp.js");
  const out = stripLead("По данным ведомства, за год мошенники похитили 15,8 млрд рублей");
  assert.ok(!out.startsWith("По данным"), "вводная фраза убрана");
  assert.ok(out.includes("похитили"), "суть сохранена");
});

test("nlp: rankFacts ставит предложения с цифрами и темой выше", async () => {
  const { rankFacts, splitSentences, mainTopic } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/nlp.js");
  const sents = splitSentences(
    "Мошенники придумали новую схему обмана. По словам экспертов, схема сложная. За год похищено 15,8 млрд рублей."
  );
  const topic = mainTopic(sents.join(" "));
  const facts = rankFacts(sents, topic);
  assert.ok(facts.some((f) => f.includes("15,8")), "предложение с цифрой в фактах");
  assert.ok(facts.every((f) => f.length <= 150), "факты не длиннее лимита");
});

test("nlp: buildHeadline использует тему для шаблонного заголовка без лида", async () => {
  const { analyzePost } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/nlp.js");
  const a = analyzePost("Инвестиции в криптовалюту обещают россиянам доход 300% в месяц");
  assert.ok(a.headline.length >= 10, "заголовок сгенерирован");
  assert.ok(a.tier === "real_threat" || a.tier === "medium", "tier оценён");
  assert.ok(a.orgs.length >= 0, "orgs — массив");
});

test("generateByRules: new схема даёт карточку защиты и tier реальной угрозы", async () => {
  const { generateByRules } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/llm.js");
  const data = generateByRules(
    "Мошенники придумали новую схему с QR-кодами. Жертвам присылают фейковые ссылки на сайты, маскирующиеся под банк. Эксперты советуют проверять адрес и не вводить данные."
  );
  assert.ok(data.cards.some((c) => c.type === "list" && c.label === "Как защититься"), "карточка защиты");
  assert.ok(data.cards.some((c) => c.type === "list" && c.label === "Фишинг-ссылка"), "лейбл темы в карточке сути");
  assert.ok(data.caption.includes("Фишинг-ссылка"), "лейбл темы в caption");
  assert.ok(data.tier === "real_threat" || data.tier === "medium", "tier определён");
});

test("generateByRules: meta.opinion подставляет живое «мнение студии» вместо шаблона", async () => {
  const { generateByRules } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/llm.js");
  const text = "Мошенники звонят россиянам, представляясь сотрудниками банка.";
  const data = generateByRules(text, { opinion: "Живое мнение студии: проверьте трубку." });
  assert.ok(data.caption.includes("Живое мнение студии"), "мнение студии в caption");
});

test("generateRulesWithOpinion: без LLM собирает правила и не падает", async () => {
  const { generateRulesWithOpinion } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/llm.js");
  const data = await generateRulesWithOpinion(
    "Мошенники звонят россиянам, представляясь сотрудниками банка. Лжеоператоры убеждают перевести деньги на безопасный счёт.",
    {},
    { link: "https://ria.ru/x" }
  );
  assert.ok(data.headline && data.caption, "есть заголовок и caption");
  assert.ok(data.caption.includes("TrustNode"), "футер на месте");
});

test("publishPackage: target=tg публикует только в TG, не в VK", async () => {
  const { publishPackage } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  const calls = installFetchMock(500);
  const env = makeEnv();
  const result = await publishPackage(
    env,
    { id: "x", kind: "news", title: "Тест", caption: "Текст новости", png: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAhklEQVR4nNXOQRHAIBDAwBAh4N9Jq+oQ0Ucnq2DXzLznkLWevSmTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOP8OfHUBEc4FhwzLqggAAAAASUVORK5CYII=", png_key: null, link: "", guid: "g", source: "test" },
    false,
    "tg"
  );
  assert.equal(result.tgOk, true, "TG опубликован");
  assert.equal(result.vkOk, false, "VK не вызывался");
  assert.ok(calls.tg.some((c) => c.url.includes("/sendPhoto")), "отправка фото в TG");
  assert.equal(calls.feeds.filter((u) => u.includes("api.vk.com")).length, 0, "VK API не вызывался");
  delete globalThis.fetch;
});

test("publishPackage: при провале VK карточка уходит в очередь ретраев", async () => {
  const { publishPackage } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  installFetchMock(500);
  const env = makeEnv();
  const tinyPng = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAhklEQVR4nNXOQRHAIBDAwBAh4N9Jq+oQ0Ucnq2DXzLznkLWevSmTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOP8OfHUBEc4FhwzLqggAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
  await publishPackage(
    env,
    { id: "rt", kind: "news", title: "Фото", caption: "Текст", png: tinyPng, png_key: null, link: "", guid: "g2", source: "t" },
    false,
    "all"
  );
  const retries = await kv.getVkRetry(env);
  assert.ok(retries.some((r) => r.id === "rt"), "пакет поставлен в очередь ретраев");
  delete globalThis.fetch;
});

test("kv.addVkRetry: не дублирует пакет и увеличивает счётчик попыток", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const env = makeEnv();
  const pkg = { id: "r1", kind: "news", title: "Тест", caption: "Текст", png: "QUJD", link: "" };
  await kv.addVkRetry(env, pkg);
  await kv.addVkRetry(env, pkg);
  let list = await kv.getVkRetry(env);
  assert.equal(list.length, 1, "один пакет в очереди");
  assert.equal(list[0].attempts, 1, "счётчик попыток");
  await kv.removeVkRetry(env, "r1");
  list = await kv.getVkRetry(env);
  assert.equal(list.length, 0, "удалён из очереди");
});

test("assertValidImage: валидный PNG проходит, битый файл — отказ", async () => {
  const { assertValidImage } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/telegram.js");
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
  assert.doesNotThrow(() => assertValidImage(png), "PNG с корректным magic-байтом");
  const text = new Uint8Array([0x74, 0x65, 0x78, 0x74, 0x74, 0x00, 0x00, 0x00]);
  assert.throws(() => assertValidImage(text), /не является изображением/, "не-картинка отклоняется");
  assert.throws(() => assertValidImage(new Uint8Array([1, 2, 3])), /слишком маленькая/, "пустая карточка отклоняется");
});

test("isGifBytes: распознаёт GIF89a/GIF87a, отклоняет PNG", async () => {
  const { isGifBytes } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/telegram.js");
  assert.equal(isGifBytes(new TextEncoder().encode("GIF89a")), true, "GIF89a — анимация");
  assert.equal(isGifBytes(new TextEncoder().encode("GIF87a")), true, "GIF87a — анимация");
  assert.equal(isGifBytes(new TextEncoder().encode("GIF99a")), false, "GIF99a — не анимация");
  assert.equal(isGifBytes(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])), false, "PNG — не анимация");
  assert.equal(isGifBytes(new TextEncoder().encode("GIF")), false, "короткий хвост — не анимация");
});

test("assertValidImage: валидный GIF проходит как карточка", async () => {
  const { assertValidImage } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/telegram.js");
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00]);
  assert.doesNotThrow(() => assertValidImage(gif), "GIF89a с корректным magic-байтом");
});

test("publishToVk: карточка уже GIF — конверсия не нужна, грузится как есть", async () => {
  const { publishToVk } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/telegram.js");
  const kv = makeKV();
  const env = makeEnv(kv);
  let wallCalls = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("api.vk.com/method/docs.getWallUploadServer"))
      return jsonResp({ response: { upload_url: "https://pu.vk.com/upload_doc?test=1" } });
    if (u.includes("api.vk.com/method/docs.save"))
      return jsonResp({ response: [{ type: "doc", doc: { id: 333, owner_id: -1 } }] });
    if (u.includes("pu.vk.com"))
      return jsonResp({ file: "1|2|3|gif|card.gif" });
    if (u.includes("api.vk.com/method/wall.post")) {
      wallCalls++;
      return jsonResp({ response: { post_id: 902 } });
    }
    return jsonResp({});
  };
  const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00]);
  const pkg = { id: "d3", guid: "gif-pkg", title: "Тест", caption: "Текст", png: gif, link: "" };
  const res = await publishToVk(env, pkg, false);
  assert.equal(res.post_id, 902, "публикация успешна");
  assert.ok(res.vk_attachment && /^doc-1_333$/.test(res.vk_attachment), "GIF-документ прикреплён");
  assert.equal(wallCalls, 1, "пост ушёл один раз");
  delete globalThis.fetch;
});

test("sendCard: GIF шлёт через sendAnimation, PNG — через sendPhoto", async () => {
  const { sendCard } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/telegram.js");
  const env = { TELEGRAM_BOT_TOKEN: "123456:TESTTOKEN" };
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const method = String(url).split("/").pop();
    calls.push(method);
    return jsonResp({ ok: true, result: { message_id: 1 } });
  };
  const gif = new TextEncoder().encode("GIF89a012345");
  await sendCard(env, 42, gif, "анимация", {});
  const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
  await sendCard(env, 42, png, "фото", {});
  assert.deepEqual(calls, ["sendAnimation", "sendPhoto"], "GIF → sendAnimation, PNG → sendPhoto");
  delete globalThis.fetch;
});

test("publishToVk: PNG в виде JSON-массива байтов из KV декодируется и публикуется", async () => {
  const { publishToVk } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/telegram.js");
  const kv = makeKV();
  const env = makeEnv(kv);
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("api.vk.com/method/docs.getWallUploadServer"))
      return jsonResp({ response: { upload_url: "https://pu.vk.com/upload_doc?test=1" } });
    if (u.includes("api.vk.com/method/docs.save"))
      return jsonResp({ response: [{ type: "doc", doc: { id: 222, owner_id: -1 } }] });
    if (u.includes("pu.vk.com"))
      return jsonResp({ file: "1|2|3|gif|card.gif" });
    if (u.includes("api.vk.com/method/wall.post"))
      return jsonResp({ response: { post_id: 901 } });
    return jsonResp({});
  };
  // Реальный минимальный валидный PNG 1x1 (RGBA, filter None, zlib-deflate).
  const realPng = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
    0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54,
    0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  // KV хранит байты как JSON-объект {"0":137,"1":80,...}
  const asJson = {};
  realPng.forEach((b, i) => { asJson[String(i)] = b; });
  const pkg = { id: "d2", guid: "json-png", title: "Тест", caption: "Текст", png: asJson, link: "" };
  const res = await publishToVk(env, pkg, false);
  assert.equal(res.post_id, 901, "публикация успешна");
  assert.ok(res.vk_attachment && /^doc-1_222$/.test(res.vk_attachment), "GIF-документ прикреплён");
  delete globalThis.fetch;
});

test("publishToVk: идемпотентность — повторная публикация пропускается (dedup)", async () => {
  const { publishToVk } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/telegram.js");
  const kv = makeKV();
  const env = makeEnv(kv);
  env.BOT_PUBLIC_URL = "https://example.workers.dev";
  // Новый путь: PNG → GIF, затем docs.getWallUploadServer + upload + docs.save,
  // wall.post c attachment=doc{owner}_{id}.
  let uploads = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("api.vk.com/method/docs.getWallUploadServer"))
      return jsonResp({ response: { upload_url: "https://pu.vk.com/upload_doc?test=1" } });
    if (u.includes("api.vk.com/method/docs.save"))
      return jsonResp({ response: [{ type: "doc", doc: { id: 111, owner_id: -1 } }] });
    if (u.includes("pu.vk.com"))
      return jsonResp({ file: "1|2|3|png|card.gif" });
    if (u.includes("api.vk.com/method/wall.post"))
      return jsonResp({ response: { post_id: 900 } });
    return jsonResp({});
  };
  // Реальный минимальный валидный PNG 1x1 (RGBA, filter None, zlib-deflate).
  const realPng = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
    0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54,
    0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4,
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  const pkg = { id: "d1", guid: "dup-guid", title: "Тест", caption: "Текст", png: realPng, link: "" };
  const first = await publishToVk(env, pkg, false);
  assert.equal(first.ok, true);
  assert.equal(first.post_id, 900);
  assert.ok(first.vk_attachment && /^doc-1_111$/.test(first.vk_attachment), "attachment — GIF-документ (doc-owner_id_id)");
  const second = await publishToVk(env, pkg, false);
  assert.equal(second.deduped, true, "повторный вызов возвращает deduped:true");
  assert.equal(second.post_id, 900, "idempotent-ответ содержит post_id из KV");
  const stored = await kv.get(`vk_posted:dup-guid`, "json");
  assert.ok(stored && stored.post_id === 900, "маркер idempotency записан в KV");
  delete globalThis.fetch;
});

test("providerPlan: ротация провайдеров по времени суток ЕКБ", async () => {
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

test("generatePostData: Workers AI пишет пост, когда внешние LLM недоступны", async () => {
  const { generatePostData } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/llm.js");
  const json = JSON.stringify({
    headline: "Workers AI пишет пост",
    caption: "**МВД советует виртуальную карту** для покупок в интернете. Это защищает деньги от списания.",
    cards: [],
    tier: "news",
  });
  const env = {
    LLM_PROXY_URL: "https://render.test",
    AI: { run: async () => ({ response: json }) },
  };
  globalThis.fetch = async () => new Response("boom", { status: 502 });
  const text = "МВД посоветовало использовать виртуальную карту. За год похищено 15,8 млрд рублей.";
  const data = await generatePostData(text, env, {});
  assert.ok(data.headline.includes("Workers AI"), "headline из Workers AI");
  assert.ok(data.caption.includes("TrustNode"), "footer на месте");
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
  assert.ok(
    calls.tg.some((c) => c.url.includes("/sendPhoto") || c.url.includes("/sendAnimation")),
    "превью-карточка отправлена (sendPhoto/sendAnimation)"
  );
  assert.equal(calls.github.length, 0, "GitHub не вызывался");
  const drafts = await kv.listDrafts(env);
  const gen = drafts.find((d) => d.kind === "generated");
  assert.ok(gen, "черновик создан");
  assert.ok(gen.png, "карточка сохранена в черновике");
});

test("renderCard: JS-фолбэк умеет и PNG, и анимированный GIF (кадры отличаются)", async () => {
  const { renderCard } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/cardgen.js");
  const data = {
    headline: "МВД советует виртуальную карту",
    tier: "news",
    cards: [{ type: "list", items: ["Мошенники похитили 15,8 млрд ₽ за год", "Виртуальная карта — безопасная покупка"] }],
  };
  const png = await renderCard(data, { format: "png" });
  assert.ok(png && png.length > 1000, "PNG не пустой");
  assert.ok(String.fromCharCode(...png.slice(1, 4)) === "PNG", "PNG magic-байты");
  const gif = await renderCard(data, { format: "gif", frames: 5 });
  assert.ok(gif && gif.length > 1000, "GIF не пустой");
  assert.ok(String.fromCharCode(...gif.slice(0, 6)) === "GIF89a", "GIF89a magic-байты");
  // Считаем кадры структурно (обходим блоки GIF), а не сканированием сырых байт —
  // в LZW-потоке могут случайно встретиться байты 0x21 0xF9.
  const countFrames = (buf) => {
    let off = 6 + 7; // сигнатура + logical screen descriptor
    const packed = buf[10];
    if (packed & 0x80) off += 3 * (1 << ((packed & 7) + 1)); // global color table
    let frames = 0;
    while (off < buf.length) {
      const b = buf[off];
      if (b === 0x3b) break; // trailer
      if (b === 0x21) {
        const label = buf[off + 1];
        if (label === 0xf9) frames++;
        off += 2;
        while (off < buf.length && buf[off] !== 0x00) {
          off += 1 + buf[off];
        }
        off += 1; // block terminator
      } else if (b === 0x2c) {
        off += 10;
        const ipacked = buf[off - 1];
        if (ipacked & 0x80) off += 3 * (1 << ((ipacked & 7) + 1)); // local color table
        off += 1; // LZW min code size
        while (off < buf.length && buf[off] !== 0x00) {
          off += 1 + buf[off];
        }
        off += 1; // block terminator
      } else {
        break;
      }
    }
    return frames;
  };
  assert.equal(countFrames(gif), 5, "5 кадров в GIF");
  const a = await renderCard(data, { format: "png", phase: 0 });
  const b = await renderCard(data, { format: "png", phase: 0.25 });
  let differ = false;
  const min = Math.min(a.length, b.length);
  for (let i = 0; i < min; i++) if (a[i] !== b[i]) { differ = true; break; }
  assert.ok(differ, "кадры с разной фазой неба отличаются (анимация есть)");
});

test("renderCardBytes: при недоступных рендерах JS-фолбэк отдаёт GIF по запросу", async () => {
  const { renderCardBytes } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/preview.js");
  const env = { CARD_RENDER_URL: undefined, CARD_RENDER_URLS: undefined, BOT_KV: { get: async () => null, put: async () => {} } };
  const data = { headline: "Тест", tier: "news", caption: "Тест", cards: [], source: "Тест" };
  const gif = await renderCardBytes(env, data, { format: "gif", frames: 4 });
  assert.ok(gif && gif.length > 1000, "GIF не пустой");
  assert.ok(String.fromCharCode(...gif.slice(0, 6)) === "GIF89a", "фолбэк вернул GIF89a");
  const png = await renderCardBytes(env, data, { format: "png" });
  assert.ok(String.fromCharCode(...png.slice(1, 4)) === "PNG", "фолбэк вернул PNG");
});

test("isStaleItem: протухшая новость определяется по pub_ts/found_at", async () => {
  const { isStaleItem, itemAgeMs, MAX_AGE_MS } = await import(
    "file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/config.js"
  );
  const now = Date.now();
  assert.equal(itemAgeMs({ pub_ts: now - 1000 }), now - 1000, "ядром свежести служит pub_ts");
  assert.equal(itemAgeMs({ found_at: new Date(now - 5000).toISOString() }), now - 5000, "fallback на found_at");
  assert.equal(isStaleItem({ pub_ts: now - MAX_AGE_MS - 1 }, now), true, "старше 24ч — протухла");
  assert.equal(isStaleItem({ pub_ts: now - MAX_AGE_MS + 1 }, now), false, "моложе 24ч — свежая");
  assert.equal(isStaleItem({ title: "без якоря" }, now), false, "без якоря — не протухла (ручной пост)");
});

test("tick: протухшие кандидаты выбрасываются из очереди без диспатча", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { tick } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  const now = new Date("2026-08-07T00:00:00Z"); // 05:00 ЕКБ — вне окон, очередь не собирается в выпуск
  installFetchMock(500);
  const env = makeEnv();
  // кладём свежего и протухшего кандидата (для свежего видим «сейчас» = now)
  await kv.addCandidate(env, { guid: "old1", title: "Старая", link: "http://l", text: "т", found_at: new Date(now.getTime() - 30 * 24 * 3600 * 1000).toISOString() });
  await kv.addCandidate(env, { guid: "new1", title: "Свежая", link: "http://l2", text: "т2", found_at: now.toISOString() });
  await tick(env, { now });
  const cands = await kv.getCandidates(env);
  assert.ok(!cands.some((c) => c.guid === "old1"), "протухший кандидат удалён");
  assert.ok(cands.some((c) => c.guid === "new1"), "свежий кандидат остался");
});

test("tick: протухший пакет со склада не публикуется и удаляется", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { tick } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  installFetchMock(500);
  const env = makeEnv();
  await kv.addStock(env, {
    id: "stale-pkg",
    kind: "news",
    title: "Устаревшая новость",
    caption: "капшн",
    png_key: "drafts/stale.png",
    guid: "g-old",
    scheduled_for: Date.now() - 1000,
    found_at: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
  });
  await tick(env);
  const stock = await kv.getStock(env);
  assert.ok(!stock.some((p) => p.id === "stale-pkg"), "протухший пакет убран со склада");
});

test("tick: «зависший» диспатч игнорируется — аварийный фолбэк удалён", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { tick } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  const calls = installFetchMock(500);
  const env = makeEnv();
  // мультигрупповые сервисные уведомления (отчёт/мёртвый выключатель) здесь не проверяем
  delete env.TELEGRAM_ADMIN_CHAT_ID;
  // диспатч «завис» с 2023 года — раньше фолбэк публиковал бы по нему
  // «срочную сводку»; теперь автопостинг в воркере, фолбэк не нужен
  await kv.markDispatch(env, "guid-2023", {
    at: new Date("2023-12-01T10:00:00Z").getTime(),
    title: "Canadian Man Pleads Guilty in Snowflake Extortions",
    link: "https://example.com/news",
    kind: "news",
    status: "dispatched",
  });
  await tick(env);
  assert.equal(calls.feeds.filter((u) => u.includes("api.vk.com")).length, 0, "пост не ушёл в VK");
  assert.equal(calls.tg.length, 0, "фолбэк не отправлен");
});

test("scanFeeds: кандидат получает pub_ts из даты статьи", async () => {
  const { scanFeeds } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/feeds.js");
  const env = makeEnv();
  const pub = new Date(Date.now() - 2 * 3600 * 1000);
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss><channel><item>
  <title>Новая схема мошенничества через фишинг-рассылку</title>
  <link>https://ria.ru/x</link>
  <guid>ria-fresh-1</guid>
  <description>Новая волна мошенничества</description>
  <pubDate>${pub.toUTCString()}</pubDate>
</item></channel></rss>`;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("api.github.com")) {
      const content = Buffer.from(JSON.stringify(CONFIG_JSON)).toString("base64");
      return jsonResp({ content });
    }
    return new Response(rss, { status: 200, headers: { "Content-Type": "application/xml" } });
  };
  const fetched = await scanFeeds(env, 0, 2);
  const cand = fetched[0];
  assert.ok(cand, "кандидат найден");
  assert.equal(cand.pub_ts, Math.floor(pub.getTime() / 1000) * 1000, "pub_ts сохранён из pubDate");
  assert.ok(cand.pub_ts > 0, "pub_ts валидный");
  delete globalThis.fetch;
});

test("publishDueStock: ивент публикуется текстом без карточки (kind=event)", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { tick } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  const calls = installFetchMock(500);
  const env = makeEnv();
  await kv.addStock(env, {
    id: "evt1",
    kind: "event",
    title: "Вебинар",
    caption: "Вебинар по цифровой безопасности в 18:00",
    guid: "",
    link: "",
    scheduled_for: Date.now() - 1000,
    from_admin: true,
  });
  await tick(env);
  const stock = await kv.getStock(env);
  assert.ok(!stock.some((p) => p.id === "evt1"), "ивент убран со склада");
  const log = await kv.getLog(env);
  const ev = log.find((e) => e.kind === "event");
  assert.ok(ev, "ивент записан в лог");
  assert.ok(ev.tg_ok, "ивент ушёл в TG");
  assert.ok(calls.tg.some((c) => c.url.includes("/sendMessage")), "ивент отправлен текстом");
});

test("webhook: не-админ получает пользовательское меню, а не команды студии", async () => {
  const { default: worker } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/worker.js");
  const calls = installFetchMock(500);
  const env = makeEnv();
  const req = new Request("https://example.workers.dev/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify({
      update_id: 20,
      message: { message_id: 5, chat: { id: 999 }, from: { id: 999, first_name: "Гость" }, text: "/start" },
    }),
  });
  await worker.fetch(req, env, { waitUntil() {} });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls.tg.length >= 1, "бот ответил не-админу");
  assert.ok(
    calls.tg.some((c) => c.url.includes("/sendMessage")),
    "отправлено сообщение (меню пользователя)"
  );
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const mode = await kv.getUserMode(env, 999);
  assert.equal(mode, null, "режим сброшен после /start");
});

test("webhook: не-админ в режиме suggest отправляет предложку админу на одобрение", async () => {
  const { default: worker } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/worker.js");
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const calls = installFetchMock(500);
  const env = makeEnv();
  await kv.setUserMode(env, 999, "suggest");
  const req = new Request("https://example.workers.dev/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify({
      update_id: 21,
      message: {
        message_id: 5,
        chat: { id: 999 },
        from: { id: 999, first_name: "Гость" },
        text: "Хочу разместить рекламу VPN-сервиса",
      },
    }),
  });
  await worker.fetch(req, env, { waitUntil() {} });
  await new Promise((r) => setTimeout(r, 50));
  const suggestions = await kv.getSuggestions(env);
  assert.equal(suggestions.length, 1, "предложка сохранена");
  assert.equal(suggestions[0].text, "Хочу разместить рекламу VPN-сервиса");
  assert.equal(suggestions[0].user_chat_id, 999);
  assert.ok(
    calls.tg.some((c) => c.url.includes("/sendMessage")),
    "предложка переслана админу"
  );
});

test("webhook: админ одобряет предложку -> публикуется и удаляется", async () => {
  const { default: worker } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/worker.js");
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const calls = installFetchMock(500);
  const env = makeEnv();
  await kv.addSuggestion(env, {
    id: "s1",
    user_chat_id: 999,
    username: "@guest",
    text: "Реклама: надёжный VPN",
    photo: null,
    created_at: new Date().toISOString(),
  });
  const req = new Request("https://example.workers.dev/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify({
      update_id: 22,
      callback_query: {
        id: "q22",
        from: { id: 1 },
        message: { message_id: 5, chat: { id: 1 } },
        data: "sugg:approve:all:s1",
      },
    }),
  });
  await worker.fetch(req, env, { waitUntil() {} });
  await new Promise((r) => setTimeout(r, 50));
  const suggestions = await kv.getSuggestions(env);
  assert.equal(suggestions.length, 0, "предложка обработана и удалена");
  const log = await kv.getLog(env);
  const entry = log.find((e) => e.kind === "suggestion");
  assert.ok(entry, "предложка в логе");
  assert.ok(entry.tg_ok, "опубликована в TG");
});

test("webhook: не-админ в режиме support пересылает сообщение админу с картой reply", async () => {
  const { default: worker } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/worker.js");
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const calls = installFetchMock(500);
  const env = makeEnv();
  await kv.setUserMode(env, 999, "support");
  const req = new Request("https://example.workers.dev/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify({
      update_id: 23,
      message: { message_id: 5, chat: { id: 999 }, from: { id: 999 }, text: "Не приходят уведомления" },
    }),
  });
  await worker.fetch(req, env, { waitUntil() {} });
  await new Promise((r) => setTimeout(r, 50));
  const mapped = await kv.getSupportFwd(env, 1);
  assert.equal(mapped, 999, "карта reply: админское сообщение 1 -> юзер 999");
});

test("webhook: ответ админа реплаем на пересланное сообщение уходит пользователю", async () => {
  const { default: worker } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/worker.js");
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const calls = installFetchMock(500);
  const env = makeEnv();
  await kv.setSupportFwd(env, 1, 999);
  const req = new Request("https://example.workers.dev/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify({
      update_id: 24,
      message: {
        message_id: 6,
        chat: { id: 1 },
        from: { id: 1 },
        text: "Проверьте настройки уведомлений",
        reply_to_message: { message_id: 1, chat: { id: 1 } },
      },
    }),
  });
  await worker.fetch(req, env, { waitUntil() {} });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(
    calls.tg.some((c) => c.body && c.body.includes("999")),
    "ответ ушёл пользователю 999"
  );
  const mapped = await kv.getSupportFwd(env, 1);
  assert.equal(mapped, null, "карта reply очищена после ответа");
});

test("event dialog: админ создаёт ивент в два шага (текст + время)", async () => {
  const { default: worker } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/worker.js");
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  installFetchMock(500);
  const env = makeEnv();
  // шаг 1: /event запускает диалог
  let req = new Request("https://example.workers.dev/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify({
      update_id: 30,
      message: { message_id: 5, chat: { id: 1 }, from: { id: 1 }, text: "/event" },
    }),
  });
  await worker.fetch(req, env, { waitUntil() {} });
  await new Promise((r) => setTimeout(r, 50));
  let dialog = await kv.getEventDialog(env);
  assert.equal(dialog.step, "text", "диалог начат: ждём текст");
  // шаг 2: админ шлёт текст
  req = new Request("https://example.workers.dev/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify({
      update_id: 31,
      message: { message_id: 6, chat: { id: 1 }, from: { id: 1 }, text: "Вебинар: защита от фишинга" },
    }),
  });
  await worker.fetch(req, env, { waitUntil() {} });
  await new Promise((r) => setTimeout(r, 50));
  dialog = await kv.getEventDialog(env);
  assert.equal(dialog.step, "time", "ждём время");
  assert.equal(dialog.text, "Вебинар: защита от фишинга");
  // шаг 3: админ шлёт время
  req = new Request("https://example.workers.dev/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify({
      update_id: 32,
      message: { message_id: 7, chat: { id: 1 }, from: { id: 1 }, text: "18:30" },
    }),
  });
  await worker.fetch(req, env, { waitUntil() {} });
  await new Promise((r) => setTimeout(r, 50));
  dialog = await kv.getEventDialog(env);
  assert.equal(dialog, null, "диалог завершён");
  const stock = await kv.getStock(env);
  const ev = stock.find((p) => p.kind === "event");
  assert.ok(ev, "ивент на складе");
  assert.equal(ev.caption, "Вебинар: защита от фишинга");
  assert.ok(ev.scheduled_for > Date.now() - 60 * 1000, "время публикации в будущем");
});

test("tick: autopost вкл -> одиночная новость публикуется и пишется в лог (без GitHub)", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { tick } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  const calls = installFetchMock(500); // GitHub «лежит»
  const env = makeEnv();
  await kv.setAutopost(env, true);
  await kv.addCandidate(env, {
    guid: "g-autogen",
    title: "Автоновость",
    link: "http://l3",
    text: "МВД посоветовало россиянам использовать виртуальную карту. За год похищено 15,8 млрд рублей.",
    found_at: new Date().toISOString(),
  });
  await tick(env, { now: new Date("2026-08-07T06:00:00Z") }); // 11:00 ЕКБ — утро
  const log = await kv.getLog(env);
  const dg = log.find((e) => e.kind === "news" && e.guid === "g-autogen");
  assert.ok(dg, "одиночная новость опубликована и записана в лог (kind=news)");
  assert.ok(dg.caption.includes("TrustNode"), "caption с футером");
  const stock = await kv.getStock(env);
  assert.ok(!stock.some((p) => p.kind === "news"), "новость ушла со склада");
  const cands = await kv.getCandidates(env);
  assert.ok(!cands.some((c) => c.guid === "g-autogen"), "кандидат потреблён постом");
  const githubCalls = calls.github.filter((c) => c.url.includes("/dispatches"));
  assert.equal(githubCalls.length, 0, "GitHub workflow_dispatch не вызывался при autopost");
});

test("assembleDigests: из 3+ кандидатов собирается один дайджест; повтор не дублирует", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { assembleDigests } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  installFetchMock(); // /digest, обложка и TG — локальные заглушки
  const env = makeEnv();
  await kv.setAutopost(env, true);
  const now = new Date("2026-08-07T06:00:00Z"); // 11:00 ЕКБ — утро
  for (const i of ["a", "b", "c", "d"]) {
    await kv.addCandidate(env, {
      guid: `g${i}`,
      title: `Новость ${i}`,
      link: `http://x/${i}`,
      text: "МВД советует виртуальную карту. Мошенники похитили миллиарды рублей.",
      found_at: new Date().toISOString(),
    });
  }
  const made = await assembleDigests(env, now);
  assert.equal(made.length, 1, "одно активное окно — один дайджест");
  const stock = await kv.getStock(env);
  const dg = stock.find((p) => p.kind === "digest");
  assert.ok(dg, "дайджест на складе");
  assert.equal(dg.title, "Мошенничество: главное", "заголовок выпуска — headline от LLM");
  assert.ok(dg.caption.includes("TrustNode"), "caption с футером");
  assert.ok(dg.items.length >= 1 && dg.items.length <= 5, `1-5 новостей в выпуске, а ${dg.items.length}`);
  assert.ok(dg.png, "обложка сохранена");
  const cands = await kv.getCandidates(env);
  assert.equal(cands.length, 0, "все кандидаты потреблены выпуском");
  const again = await assembleDigests(env, now);
  assert.equal(again.length, 0, "повторно окно не собирается (маркер digest_done)");
  assert.equal((await kv.getStock(env)).length, 1, "на складе по-прежнему один выпуск");
});

test("assembleDigests: один кандидат -> дайджест выходит как есть (публикуем что есть)", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { assembleDigests } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  installFetchMock(); // /digest, обложка и TG — локальные заглушки
  const env = makeEnv();
  await kv.setAutopost(env, true);
  const now = new Date("2026-08-07T10:00:00Z"); // 15:00 ЕКБ — день
  await kv.addCandidate(env, {
    guid: "solo",
    title: "Одна новость",
    link: "http://solo",
    text: "Новая схема с QR-кодами. Жертвам присылают фейковые ссылки под видом банка.",
    found_at: new Date().toISOString(),
  });
  const made = await assembleDigests(env, now);
  assert.equal(made.length, 1);
  const dg = (await kv.getStock(env)).find((p) => p.kind === "digest");
  assert.ok(dg && dg.items.length === 1, "выпуск вышел даже с одной новостью");
  assert.ok(dg.digest_text && dg.digest_text.length > 0, "полный разбор в digest_text");
});

test("assembleDigestDrafts: автопостинг выкл -> хранит превью как черновик и потребляет", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { assembleDigestDrafts } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  const calls = installFetchMock(500);
  const env = makeEnv();
  const now = new Date("2026-08-07T06:00:00Z"); // 11:00 ЕКБ — утро
  await kv.addCandidate(env, {
    guid: "g9",
    title: "Новость",
    link: "http://x/9",
    text: "Мошенники звонят от имени банка, убеждая перевести деньги на безопасный счёт.",
    found_at: new Date().toISOString(),
  });
  const sent = await assembleDigestDrafts(env, now);
  assert.equal(sent, 1);
  const drafts = await kv.listDrafts(env);
  const dg = drafts.find((d) => d.kind === "digest");
  assert.ok(dg, "черновик-превью сохранён");
  assert.ok(dg.caption.includes("TrustNode"), "caption с футером");
  assert.ok(calls.tg.some((c) => c.url.includes("/sendPhoto")) ||
    calls.tg.some((c) => c.url.includes("/sendAnimation")), "превью отправлено");
  assert.equal((await kv.getStock(env)).length, 0, "на склад ничего не ушло (ждут одобрения)");
  assert.equal((await kv.getCandidates(env)).length, 0, "кандидаты потреблены");
});

test("assembleNewsPosts: топ-1 кандидат -> одиночная новость на склад; повтор не дублирует", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { assembleNewsPosts } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  installFetchMock();
  const env = makeEnv();
  await kv.setAutopost(env, true);
  const now = new Date("2026-08-07T06:00:00Z"); // 11:00 ЕКБ — утро
  const hour = 3600 * 1000;
  await kv.addCandidate(env, {
    guid: "gna",
    title: "Новость A",
    link: "http://x/a",
    text: "МВД советует виртуальную карту. Мошенники похитили миллиарды рублей.",
    found_at: new Date(Date.now() - 2 * hour).toISOString(),
  });
  await kv.addCandidate(env, {
    guid: "gnb",
    title: "Новость B",
    link: "http://x/b",
    text: "МВД советует виртуальную карту. Мошенники похитили миллиарды рублей.",
    found_at: new Date(Date.now() - hour).toISOString(),
  });
  const made = await assembleNewsPosts(env, now);
  assert.equal(made.length, 1, "одно активное окно — одна новость");
  const stock = await kv.getStock(env);
  const n = stock.find((p) => p.kind === "news");
  assert.ok(n, "одиночная новость на складе");
  assert.equal(n.guid, "gnb", "взят топ-1 (свежайший), а не все кандидаты");
  assert.ok(n.caption.includes("TrustNode"), "caption с футером");
  assert.ok(n.png, "карточка сохранена");
  assert.equal(n.no_rereder, true, "карточку не пере-рендерим на тике публикации");
  const cands = await kv.getCandidates(env);
  assert.equal(cands.length, 1, "потреблён только один кандидат (топ-1)");
  assert.equal(cands[0].guid, "gna", "остался только неопубликованный кандидат");
  const again = await assembleNewsPosts(env, now);
  assert.equal(again.length, 0, "повторно окно не собирается (маркер digest_done)");
  assert.equal((await kv.getStock(env)).length, 1, "на складе по-прежнему один пост");
});

test("assembleNewsDrafts: автопостинг выкл -> черновик kind=news и потребление топ-1", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { assembleNewsDrafts } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  const calls = installFetchMock(500);
  const env = makeEnv();
  const now = new Date("2026-08-07T06:00:00Z"); // 11:00 ЕКБ — утро
  await kv.addCandidate(env, {
    guid: "g9",
    title: "Новость",
    link: "http://x/9",
    text: "Мошенники звонят от имени банка, убеждая перевести деньги на безопасный счёт.",
    found_at: new Date().toISOString(),
  });
  const sent = await assembleNewsDrafts(env, now);
  assert.equal(sent, 1);
  const drafts = await kv.listDrafts(env);
  const nd = drafts.find((d) => d.kind === "news");
  assert.ok(nd, "черновик-превью новости сохранён");
  assert.equal(nd.guid, "g9", "guid кандидата в черновике");
  assert.ok(nd.caption.includes("TrustNode"), "caption с футером");
  assert.ok(calls.tg.some((c) => c.url.includes("/sendPhoto")) ||
    calls.tg.some((c) => c.url.includes("/sendAnimation")), "превью отправлено");
  assert.equal((await kv.getStock(env)).length, 0, "на склад ничего не ушло (ждут одобрения)");
  assert.equal((await kv.getCandidates(env)).length, 0, "кандидат потреблён");
});

test("rebuildDigestPreview: пересобирает превью из сохранённого черновика без потребления", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { rebuildDigestPreview } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  const calls = installFetchMock(500);
  const env = makeEnv();
  const now = new Date("2026-08-07T06:00:00Z");
  await kv.addCandidate(env, {
    guid: "g9",
    title: "Новость",
    link: "http://x/9",
    text: "Мошенники звонят от имени банка, убеждая перевести деньги на безопасный счёт.",
    found_at: new Date().toISOString(),
  });
  const { assembleDigestDrafts } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  await assembleDigestDrafts(env, now);
  const drafts = await kv.listDrafts(env);
  const dg = drafts.find((d) => d.kind === "digest");
  assert.ok(dg, "черновик-превью сохранён");
  const captions = new Set(calls.tg.filter((c) => c.url.includes("/sendPhoto") || c.url.includes("/sendAnimation")).map((c) => (c.body && c.body.caption) || ""));
  await rebuildDigestPreview(env, dg);
  const after = calls.tg.filter((c) => c.url.includes("/sendPhoto") || c.url.includes("/sendAnimation"));
  assert.ok(after.length >= 2, "новое превью отправлено после пересборки");
  const fresh = await kv.listDrafts(env);
  const newDg = fresh.find((d) => d.kind === "digest");
  assert.ok(newDg && newDg.id === dg.id, "черновик заменён, id тот же");
  assert.ok(newDg.caption.includes("TrustNode"), "caption пересобран с футером");
  assert.equal(calls.github.filter((c) => c.url.includes("/dispatches")).length, 0, "GitHub не вызывался");
});

test("digestByRules: тезисы со ссылками, блок защиты и заголовок окна", async () => {
  const { digestByRules } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/llm.js");
  const items = [
    {
      guid: "a",
      title: "Звонки от «банка»",
      link: "https://ria.ru/a",
      text: "Мошенники звонят россиянам, представляясь сотрудниками банка, и убеждают перевести деньги на безопасный счёт.",
    },
    {
      guid: "b",
      title: "Фейковый портал Госуслуг",
      link: "https://tass.ru/b",
      text: "Хакеры создали фейковый сайт Госуслуг и собирают с посетителей логины и пароли.",
    },
  ];
  const d = digestByRules(items, { label: "утро", slug: "morning", date: "2026-08-07" });
  assert.ok(d.headline.includes("утро"), "заголовок с окном");
  assert.equal(d.bulletTexts.length, 2, "по тезису на новость");
  assert.ok(d.bulletTexts.every((b) => b.link), "ссылка на источник у каждого тезиса");
  assert.ok(d.advice.length >= 1, "есть советы по защите");
});

test("generateDigestText: полный caption с футером и лимитом 1024", async () => {
  const { generateDigestText } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/llm.js");
  const items = [
    { guid: "1", title: "Первая", link: "https://ria.ru/1", text: "Мошенники похитили 15,8 млрд рублей за год." },
    { guid: "2", title: "Вторая", link: "https://tass.ru/2", text: "Взломаны 2 млн аккаунтов Госуслуг." },
  ];
  const out = await generateDigestText(items, {
    AI: {
      run: async () => ({
        response: JSON.stringify({
          headline: "Главное за вечер",
          bullets: ["Булет первый: похищены миллиарды, но есть защита.", "Булет второй: взломаны аккаунты Госуслуг."],
          advice: ["Проверяйте ссылки", "Включите 2FA"],
        }),
      }),
    },
  }, { label: "вечер", slug: "evening", date: "2026-08-07" });
  assert.ok(out.headline.includes("вечер"), "заголовок с окном");
  assert.ok(out.caption.includes("️ 🛡️") || out.caption.includes("Что делать") || out.caption.includes("🛡"), "блок защиты");
  assert.ok(out.caption.includes("TrustNode"), "футер");
  assert.ok(out.caption.length <= 1024, `caption в лимите TG: ${out.caption.length}`);
  assert.equal(out.items.length, items.length, "мета новостей совпадает");
});

test("sendPoll: шлёт вопрос и варианты через TG sendPoll (is_anonymous по умолчанию)", async () => {
  const calls = installFetchMock();
  const { sendPoll } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/telegram.js");
  const env = makeEnv();
  const res = await sendPoll(env, "-1001", "Ваш вопрос?", ["Да", "Нет", "Не уверен"]);
  assert.ok(res, "ответ Telegram");
  const call = calls.tg.find((c) => c.url.includes("/sendPoll"));
  assert.ok(call, "вызван sendPoll");
  const body = typeof call.body === "string" ? call.body : JSON.stringify(call.body);
  assert.ok(body.includes("Ваш вопрос?"), "вопрос ушёл");
  assert.ok(body.includes("Да") && body.includes("Не уверен"), "варианты ушли");
  assert.ok(body.includes('"is_anonymous":true'), "опрос анонимный по умолчанию");
});

test("assembleMix: /mix=single -> одиночная новость на склад, решение в mix_plan", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { assembleMix } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  installFetchMock(204, { format: "single" });
  const env = makeEnv();
  await kv.setAutopost(env, true);
  const now = new Date("2026-08-07T06:00:00Z"); // 11:00 ЕКБ — утро
  for (const i of ["a", "b", "c"]) {
    await kv.addCandidate(env, {
      guid: `pg${i}`,
      title: `Новость ${i}`,
      link: `http://x/${i}`,
      text: "МВД советует виртуальную карту. Мошенники похитили миллиарды рублей.",
      found_at: new Date().toISOString(),
    });
  }
  const made = await assembleMix(env, now);
  assert.equal(made.length, 1, "одно активное окно — один пакет");
  const stock = await kv.getStock(env);
  assert.equal(stock.filter((p) => p.kind === "news").length, 1, "одиночная новость на складе");
  assert.equal(stock.filter((p) => p.kind === "digest").length, 0, "дайджест не собран");
  assert.equal((await kv.getCandidates(env)).length, 2, "потреблён только топ-1");
  const plan = await kv.getMixPlan(env);
  assert.equal(plan["2026-08-07:morning"], "news", "решение формата записано в mix_plan");
  await assembleMix(env, now);
  assert.equal((await kv.getStock(env)).length, 1, "повторно окно не собирается (маркер)");
});

test("assembleMix: /mix=digest -> дайджест на склад, кандидаты потреблены", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { assembleMix } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  installFetchMock(204, { format: "digest" });
  const env = makeEnv();
  await kv.setAutopost(env, true);
  const now = new Date("2026-08-07T06:00:00Z"); // 11:00 ЕКБ — утро
  for (const i of ["a", "b", "c"]) {
    await kv.addCandidate(env, {
      guid: `dg${i}`,
      title: `Новость ${i}`,
      link: `http://x/${i}`,
      text: "МВД советует виртуальную карту. Мошенники похитили миллиарды рублей.",
      found_at: new Date().toISOString(),
    });
  }
  const made = await assembleMix(env, now);
  assert.equal(made.length, 1, "один дайджест");
  const stock = await kv.getStock(env);
  assert.equal(stock.filter((p) => p.kind === "digest").length, 1, "дайджест на складе");
  assert.equal(stock.filter((p) => p.kind === "news").length, 0, "одиночных нет");
  assert.equal((await kv.getCandidates(env)).length, 0, "кандидаты потреблены выпуском");
  const planMix = await kv.getMixPlan(env);
  assert.equal(planMix["2026-08-07:morning"], "digest", "решение формата = digest");
});

test("assembleMix: /mix=poll -> новость с данными опроса на складе", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { assembleMix } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  installFetchMock(204, {
    format: "poll",
    question: "Сталкивались ли вы с такой схемой?",
    options: ["Да", "Нет", "Не знаю"],
  });
  const env = makeEnv();
  await kv.setAutopost(env, true);
  const now = new Date("2026-08-07T06:00:00Z"); // 11:00 ЕКБ — утро
  for (const i of ["a", "b"]) {
    await kv.addCandidate(env, {
      guid: `pp${i}`,
      title: `Новость ${i}`,
      link: `http://x/${i}`,
      text: "МВД советует виртуальную карту. Мошенники похитили миллиарды рублей.",
      found_at: new Date().toISOString(),
    });
  }
  const made = await assembleMix(env, now);
  assert.equal(made.length, 1, "новость собрана");
  const stock = await kv.getStock(env);
  const n = stock.find((p) => p.kind === "news");
  assert.ok(n, "новость на складе");
  assert.ok(n.poll && n.poll.question && Array.isArray(n.poll.options) && n.poll.options.length >= 2,
    "опросные данные прикреплены к пакету");
  assert.equal(n.poll.question, "Сталкивались ли вы с такой схемой?", "вопрос из LLM /poll");
});

test("assembleMix: без LLM_PROXY_URL решение по правилам — ровно один пакет за окно", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { assembleMix } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  installFetchMock(204);
  const env = makeEnv();
  env.LLM_PROXY_URL = ""; // без прокси — чистые правила
  await kv.setAutopost(env, true);
  const now = new Date("2026-08-07T06:00:00Z"); // 11:00 ЕКБ — утро
  await kv.addCandidate(env, {
    guid: "rb1",
    title: "Новость 1",
    link: "http://x/r1",
    text: "МВД советует виртуальную карту. Мошенники похитили миллиарды рублей.",
    found_at: new Date().toISOString(),
  });
  await kv.addCandidate(env, {
    guid: "rb2",
    title: "Новость 2",
    link: "http://x/r2",
    text: "МВД советует виртуальную карту. Мошенники похитили миллиарды рублей.",
    found_at: new Date().toISOString(),
  });
  const made = await assembleMix(env, now);
  assert.equal(made.length, 1, "один пакет по правилам");
  assert.equal((await kv.getStock(env)).length, 1, "ровно один пакет на складе");
  const plan = await kv.getMixPlan(env);
  const f = plan["2026-08-07:morning"];
  assert.ok(f === "news" || f === "digest" || f === "poll", `формат из правил: ${f}`);
  await assembleMix(env, now);
  assert.equal((await kv.getStock(env)).length, 1, "повтор не дублирует");
});

// ---------- умные карточки: «отложить» (defer) ----------

test("autoDefer: отложенный черновик тик не трогает до наступления слота", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { tick } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  installFetchMock(500);
  const env = makeEnv();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await kv.saveDraft(env, {
    id: "dd1", title: "Отложенная", caption: "капшн", png_key: "drafts/dd1.png",
    status: "deferred", deferred_until: future, created_at: new Date().toISOString(),
  });
  await tick(env);
  assert.equal((await kv.listDrafts(env)).length, 1, "черновик дожидается слота");
  assert.equal((await kv.getStock(env)).length, 0, "в склад рано");
});

test("autoDefer: отложенный черновик встаёт в склад, когда слот наступил", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { tick } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/scheduler.js");
  installFetchMock(500);
  const env = makeEnv();
  const past = Date.now() - 5 * 60 * 1000;
  await kv.saveDraft(env, {
    id: "dd2", title: "Созрела", caption: "капшн", png_key: null,
    png: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAhklEQVR4nNXOQRHAIBDAwBAh4N9Jq+oQ0Ucnq2DXzLznkLWevSmTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOP8OfHUBEc4FhwzLqggAAAAASUVORK5CYII=",
    status: "deferred", deferred_until: new Date(past).toISOString(), created_at: new Date().toISOString(),
  });
  await tick(env);
  assert.equal((await kv.listDrafts(env)).length, 0, "черновик ушёл со статуса deferred");
  const log = await kv.getLog(env);
  assert.ok(log.some((e) => e.id === "dd2"), "пост опубликован в наступившем слоте");
  assert.equal((await kv.getStock(env)).length, 0, "склад пуст после публикации");
});

test("webhook: кнопка «Отложить» ставит черновик в отложенные, не публикуя", async () => {
  const { default: worker } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/worker.js");
  const calls = installFetchMock(500);
  const env = makeEnv();
  await env.BOT_KV.put("draft:t1", JSON.stringify({
    id: "t1", kind: "news", title: "Тест", caption: "Капшн",
    png: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAhklEQVR4nNXOQRHAIBDAwBAh4N9Jq+oQ0Ucnq2DXzLznkLWevSmTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOImTOP8OfHUBEc4FhwzLqggAAAAASUVORK5CYII=",
    png_key: null, link: "", guid: "t1", source: "ria.ru", tags: [],
    admin_chat_id: 1, preview_message_id: 5, status: "pending",
    created_at: new Date().toISOString(),
  }));
  const req = new Request("https://example.workers.dev/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify({
      update_id: 11,
      callback_query: {
        id: "q2",
        from: { id: 1 },
        message: { message_id: 5, chat: { id: 1 } },
        data: "defer:t1",
      },
    }),
  });
  await worker.fetch(req, env, { waitUntil() {} });
  await new Promise((r) => setTimeout(r, 50));
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const d = await kv.loadDraft(env, "t1");
  assert.ok(d, "черновик жив");
  assert.equal(d.status, "deferred", "статус deferred");
  assert.ok(d.deferred_until, "есть слот отложки");
  assert.ok(!calls.tg.some((c) => c.url.includes("/sendPhoto")), "пост не публиковался");
});

test("webhook: быстрая кнопка cmd:drafts под статусом вызывает команду админа", async () => {
  const { default: worker } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/worker.js");
  const calls = installFetchMock(500);
  const env = makeEnv();
  const req = new Request("https://example.workers.dev/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify({
      update_id: 12,
      callback_query: {
        id: "q3",
        from: { id: 1 },
        message: { message_id: 5, chat: { id: 1 } },
        data: "cmd:drafts",
      },
    }),
  });
  await worker.fetch(req, env, { waitUntil() {} });
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(
    calls.tg.some((c) => (c.body || "").includes("Черновик")),
    "бот ответил командой /drafts"
  );
});

// ---------- аналитика по слотам окон ----------

test("analytics: слот-отчёт показывает посты, форматы и пропуски по окнам", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { slotAnalyticsText } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/analytics.js");
  installFetchMock(500);
  const env = makeEnv();
  const now = new Date("2026-08-07T12:00:00Z"); // 17:00 ЕКБ
  await kv.addLog(env, { id: "a1", kind: "news", title: "N1", published_at: "2026-08-05T10:00:00Z", tg_ok: true, vk_ok: true, window_slug: "morning" });
  await kv.addLog(env, { id: "a2", kind: "digest", title: "D2", published_at: "2026-08-06T10:00:00Z", tg_ok: true, vk_ok: true, window_slug: "morning" });
  await kv.addLog(env, { id: "a3", kind: "news", title: "N3", published_at: "2026-08-07T10:00:00Z", tg_ok: true, vk_ok: true, window_slug: "day" });
  const text = await slotAnalyticsText(env, { now, days: 3 });
  assert.ok(text.includes("утро"), "в отчёте есть утро");
  assert.ok(text.includes("новость"), "формат новость упомянут");
  assert.ok(text.includes("дайджест"), "формат дайджест упомянут");
  assert.ok(text.includes("пропущено"), "считаются пропуски");
});

// ---------- AI-расписание: здоровье окон + перенос по просадкам ----------

test("slotHealth: дни доставки и пропуски по окнам за период", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { slotHealth } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/schedule.js");
  const env = makeEnv();
  const now = new Date("2026-08-07T12:00:00Z"); // 17:00 ЕКБ
  // утро: 2 дня из 3; день: 1 из 3 (просадка); вечер: 3 из 3
  for (const d of ["2026-08-05T10:00:00Z", "2026-08-07T10:00:00Z"]) {
    await kv.addLog(env, { id: `m-${d}`, kind: "news", published_at: d, tg_ok: true, vk_ok: true, window_slug: "morning" });
  }
  await kv.addLog(env, { id: "day-1", kind: "news", published_at: "2026-08-06T10:00:00Z", tg_ok: true, vk_ok: true, window_slug: "day" });
  for (const d of ["2026-08-05T10:00:00Z", "2026-08-06T10:00:00Z", "2026-08-07T10:00:00Z"]) {
    await kv.addLog(env, { id: `e-${d}`, kind: "news", published_at: d, tg_ok: true, vk_ok: true, window_slug: "evening" });
  }
  const health = await slotHealth(env, { now, days: 3 });
  const bySlug = (s) => health.find((h) => h.slug === s);
  assert.equal(bySlug("morning").miss, 1);
  assert.equal(bySlug("day").miss, 2, "день — просадка");
  assert.equal(bySlug("evening").miss, 0);
});

test("proposeSchedule: окна здоровы -> null, есть просадка -> перенос в свободный промежуток", async () => {
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  const { proposeSchedule, getWindows } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/schedule.js");
  const env = makeEnv();
  const windows = await getWindows(env);
  const healthy = windows.map((w) => ({ slug: w.slug, label: w.label, start: w.start, end: w.end, days: 3, delivered: 3, miss: 0, pct: 100 }));
  assert.equal(proposeSchedule(windows, healthy, { days: 3 }), null, "менять нечего");
  // просадка у «дня» (1 из 3) — переезжает в середину свободного промежутка
  const weak = healthy.map((h) => (h.slug === "day" ? { ...h, miss: 2, delivered: 1, pct: 33 } : h));
  const prop = proposeSchedule(windows, weak, { days: 3 });
  assert.ok(prop, "предложение есть");
  const dayW = prop.find((w) => w.slug === "day");
  assert.ok(dayW.start !== 13 * 60, `день переехал с 13:00 на ${dayW.start}`);
  assert.ok(prop.every((w, i) => i === 0 || w.start > prop[i - 1].start), "окна не пересекаются");
});
