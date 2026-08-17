// Тесты статистики вовлечённости: реакции (дельта), VK-опрос, агрегация,
// веса жанров для ротации, атрибуты поста в generatePostData.
// Запуск: node --test worker/test/stats.test.js

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
    LLM_PROXY_URL: "https://render.test",
  };
}

const STATS = "file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/stats.js";
const KV = "file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js";
const LLM = "file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/llm.js";
const NLP = "file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/nlp.js";

test("applyReactionDelta: дельты реакций пересчитывают счётчики", async () => {
  const { applyReactionDelta, reactionEmojiList } = await import(STATS);
  assert.deepEqual(
    reactionEmojiList([
      { type: "emoji", emoji: "👍" },
      { type: "emoji", emoji: "❤️" },
    ]),
    ["👍", "❤️"]
  );
  const prev = { "👍": 2 };
  const next = applyReactionDelta(prev, [{ type: "emoji", emoji: "👍" }], [{ type: "emoji", emoji: "❤️" }]);
  assert.equal(next["👍"], 1, "убрали одну лампу");
  assert.equal(next["❤️"], 1, "поставили сердечко");
  const cleared = applyReactionDelta(next, [{ type: "emoji", emoji: "👍" }, { type: "emoji", emoji: "❤️" }], []);
  assert.deepEqual(cleared, {}, "все реакции сняты");
});

test("recordReaction: находит пост по tg_message_id и пишет реакции в log", async () => {
  const { recordReaction } = await import(STATS);
  const env = makeEnv();
  const stock = await import(KV);
  await stock.addLog(env, { id: "p1", tg_message_id: 555, tg_ok: true, vk_ok: true });
  const ok = await recordReaction(env, {
    message_id: 555,
    old_reaction: [],
    new_reaction: [{ type: "emoji", emoji: "👍" }],
  });
  assert.ok(ok, "пост найден по tg_message_id");
  const log = await stock.getLog(env);
  assert.equal(log[0].stats.reactions["👍"], 1, "реакция зафиксирована");
  assert.equal(log[0].stats.reactions_total, 1, "сумма реакций");
});

test("recordReaction: неизвестный message_id не пишет", async () => {
  const { recordReaction } = await import(STATS);
  const env = makeEnv();
  const ok = await recordReaction(env, { message_id: 999, old_reaction: [], new_reaction: [] });
  assert.equal(ok, false, "нет поста — нет записи");
});

test("collectVkMetrics: опрашивает wall.getById и пишет views/likes", async () => {
  const { collectVkMetrics } = await import(STATS);
  const env = makeEnv();
  const stock = await import(KV);
  await stock.addLog(env, { id: "v1", vk_post_id: 42, tg_ok: true, vk_ok: true });
  const calls = {};
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.url = String(url);
    return new Response(
      JSON.stringify({
        response: [
          { id: 42, views: { count: 123 }, likes: { count: 7 }, reposts: { count: 1 }, comments: { count: 2 } },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  };
  try {
    const res = await collectVkMetrics(env);
    assert.ok(calls.url.includes("api.vk.com"), "вызов VK API");
    assert.equal(res.fetched, 1, "один пост обработан");
    const log = await stock.getLog(env);
    assert.equal(log[0].stats.vk.views, 123, "просмотры");
    assert.equal(log[0].stats.vk.likes, 7, "лайки");
  } finally {
    globalThis.fetch = orig;
  }
});

test("aggregateStats: считает метрики по жанру/схеме/теме", async () => {
  const { aggregateStats } = await import(STATS);
  const log = [
    { scheme_id: "safe_account", style_id: "warning", topic_id: "card", llm_provider: "gigachat", stats: { vk: { views: 100, likes: 5 }, reactions_total: 3 } },
    { scheme_id: "safe_account", style_id: "razbor", topic_id: "card", llm_provider: "gigachat", stats: { vk: { views: 200, likes: 8 }, reactions_total: 0 } },
    { scheme_id: "phishing", style_id: "warning", topic_id: "phishing", llm_provider: "gemini", stats: { vk: { views: 50, likes: 2 }, reactions_total: 1 } },
  ];
  const agg = aggregateStats(log);
  assert.equal(agg.style[0].key, "warning", "warning лидирует по вовлечённости");
  assert.equal(agg.style[0].posts, 2, "два поста");
  assert.equal(agg.scheme[0].key, "safe_account", "safe_account лидирует по схемам");
  assert.equal(agg.topic[0].key, "card", "тема card лидирует");
  assert.equal(agg.provider[0].key, "gigachat", "провайдер gigachat лидирует");
});

test("styleWeightsFromLog: даёт веса только при достаточной статистике", async () => {
  const { styleWeightsFromLog } = await import(STATS);
  const little = [
    { style_id: "warning", stats: { vk: { views: 10 } } },
    { style_id: "razbor", stats: { vk: { views: 20 } } },
  ];
  assert.deepEqual(styleWeightsFromLog(little), {}, "мало постов — весов нет");
  const mk = (style, views) => ({ style_id: style, stats: { vk: { views } } });
  const enough = [
    mk("warning", 300), mk("warning", 400), mk("warning", 500),
    mk("razbor", 50), mk("razbor", 60), mk("razbor", 70),
  ];
  const w = styleWeightsFromLog(enough);
  assert.ok(w.warning > w.razbor, "успешный жанр весит больше");
  assert.ok(w.warning >= 1 && w.warning <= 2, "boost в разумных пределах");
});

test("generatePostData: пишет атрибуты scheme/style/topic для статистики", async () => {
  const { generatePostData } = await import(LLM);
  const env = makeEnv();
  const text = "Мошенники звонят пенсионерам, представляясь сотрудниками банка, и убеждают перевести деньги на безопасный счёт. По данным ЦБ, за год было похищено 15,8 млрд рублей.";
  const out = await generatePostData(text, env, { provider: "rules", link: "https://ria.ru/x" });
  assert.ok(out.scheme_id, "схема распознана");
  assert.ok(out.style_id, "жанр записан");
  assert.ok(out.caption.includes("TrustNode"), "пост сгенерирован");
});

test("generatePostData: с весами из статов жанр следует за лидером", async () => {
  const { generatePostData } = await import(LLM);
  const stats = await import(STATS);
  const kv = makeKV();
  const env = makeEnv(kv);
  const stock = await import(KV);
  const mk = (style, views) => ({ style_id: style, stats: { vk: { views } } });
  const enough = [
    mk("warning", 300), mk("warning", 400), mk("warning", 500),
    mk("razbor", 50), mk("razbor", 60), mk("razbor", 70),
  ];
  const weights = stats.styleWeightsFromLog(enough);
  await stock.setStyleWeights(env, weights);
  const text = "Мошенники звонят пенсионерам, представляясь сотрудниками банка, и убеждают перевести деньги на безопасный счёт.";
  const out = await generatePostData(text, env, { provider: "rules" });
  assert.ok(out.style_id, "жанр записан");
  assert.ok(out.caption.includes("TrustNode"), "пост сгенерирован");
});

// ---------- анализ «залётности» и веса тем/схем ----------

test("postFlyScore: свежий пост не штрафуется, старый нормируется на дни", async () => {
  const { postFlyScore } = await import(STATS);
  const fresh = {
    published_at: new Date(Date.now() - 2 * 86400000).toISOString(),
    stats: { vk: { views: 100, likes: 10 } },
  };
  const old = {
    published_at: new Date(Date.now() - 10 * 86400000).toISOString(),
    stats: { vk: { views: 1000, likes: 100 } },
  };
  const fs = postFlyScore(fresh);
  assert.ok(Math.abs(fs - (100 + 10 * 50)) < 1, "свежий пост — сырая активность");
  assert.ok(postFlyScore(old) < fs * 3, "старый пост делится на возраст");
  assert.equal(postFlyScore({}), 0, "без метрик — 0");
});

test("bestPerformingPosts: возвращает топ постов с атрибутами и ссылкой на VK", async () => {
  const { bestPerformingPosts } = await import(STATS);
  const log = [
    { id: "p1", title: "Первый", caption: "Заголовок первый", style_id: "warning", scheme_id: "safe_account", topic_id: "call", vk_ok: true, vk_post_id: 10, published_at: new Date(Date.now() - 1000).toISOString(), stats: { vk: { views: 100, likes: 20 } } },
    { id: "p2", title: "Второй", caption: "Заголовок второй", style_id: "razbor", topic_id: "phishing", vk_ok: true, vk_post_id: 11, published_at: new Date(Date.now() - 2000).toISOString(), stats: { vk: { views: 40, likes: 2 } } },
    { id: "p3", title: "Без метрик", vk_ok: false, published_at: new Date().toISOString() },
  ];
  const top = bestPerformingPosts(log, 2);
  assert.equal(top.length, 2, "только посты с метриками");
  assert.equal(top[0].id, "p1", "лидер — с наибольшей активностью");
  assert.equal(top[0].vk_post_id, 10, "сохранён vk_post_id для ссылки");
});

test("contentWeightsFromLog: веса по жанру/теме/схеме появляются после 3 постов", async () => {
  const { contentWeightsFromLog, topicWeightsFromLog } = await import(STATS);
  const mk = (style, topic, scheme, views) => ({
    style_id: style, topic_id: topic, scheme_id: scheme,
    stats: { vk: { views } },
  });
  const log = [
    mk("warning", "call", "safe_account", 500), mk("warning", "call", "safe_account", 400), mk("warning", "call", "safe_account", 600),
    mk("razbor", "phishing", "phishing", 40), mk("razbor", "phishing", "phishing", 50), mk("razbor", "phishing", "phishing", 60),
  ];
  const cw = contentWeightsFromLog(log);
  assert.ok(cw.style && cw.style.warning > cw.style.razbor, "жанр-лидер весит больше");
  assert.ok(cw.topic && cw.topic.call > cw.topic.phishing, "тема-лидер весит больше");
  assert.ok(cw.scheme && cw.scheme.safe_account > cw.scheme.phishing, "схема-лидер весит больше");
  assert.deepEqual(topicWeightsFromLog([{ topic_id: "call", stats: { vk: { views: 1 } } }]), {}, "мало постов — пусто");
});

test("winningContextText: сводка «что залетает» для промпта LLM", async () => {
  const { winningContextText } = await import(STATS);
  assert.equal(winningContextText([]), "", "без статов — пусто");
  assert.equal(winningContextText([{ id: "x", vk_ok: true, published_at: new Date().toISOString() }]), "", "один пост — не статистика");
  const mk = (style, topic, scheme, views, title) => ({
    id: "id" + Math.random(),
    title,
    caption: title + ": живой заголовок поста",
    style_id: style, topic_id: topic, scheme_id: scheme,
    vk_ok: true,
    published_at: new Date(Date.now() - 3600000).toISOString(),
    stats: { vk: { views, likes: 5 } },
  });
  const log = [
    mk("warning", "call", "safe_account", 5000, "Звонки из банка"),
    mk("warning", "call", "safe_account", 4000, "Безопасный счёт"),
    mk("warning", "call", "safe_account", 3000, "Лжеоператоры"),
  ];
  const txt = winningContextText(log);
  assert.ok(txt.includes("жанр: warning"), "жанр-лидер в сводке");
  assert.ok(txt.includes("тема: call"), "тема-лидер в сводке");
  assert.ok(txt.includes("Примеры лучших"), "примеры лучших постов");
});

test("refreshContentWeights: пишет сводные веса в KV (style + topic + scheme)", async () => {
  const { refreshContentWeights, getContentWeights } = await import(STATS);
  const kv = makeKV();
  const env = makeEnv(kv);
  const stock = await import(KV);
  const mk = (style, topic, scheme, views) => ({ style_id: style, topic_id: topic, scheme_id: scheme, stats: { vk: { views } } });
  await stock.addLog(env, mk("warning", "call", "safe_account", 500));
  await stock.addLog(env, mk("warning", "call", "safe_account", 400));
  await stock.addLog(env, mk("warning", "call", "safe_account", 600));
  const weights = await refreshContentWeights(env);
  assert.ok(weights.style && weights.style.warning, "веса жанра");
  assert.ok(weights.topic && weights.topic.call, "веса темы");
  assert.ok(weights.scheme && weights.scheme.safe_account, "веса схемы");
  const cached = await getContentWeights(env);
  assert.ok(cached.style && cached.style.warning, "сводка прочитана из KV");
  const legacy = await stock.getStyleWeights(env);
  assert.ok(legacy && legacy.warning, "style_weights обновлены (совместимость)");
});

test("getContentWeights: фолбэк на legacy style_weights", async () => {
  const { getContentWeights } = await import(STATS);
  const kv = makeKV();
  const env = makeEnv(kv);
  const stock = await import(KV);
  await stock.setStyleWeights(env, { warning: 1.5 });
  const cw = await getContentWeights(env);
  assert.equal(cw.style.warning, 1.5, "legacy веса отданы как style");
});

test("generatePostData: прокидывает «что залетает» в промпт LLM (best_posts)", async () => {
  const { generatePostData } = await import(LLM);
  const kv = makeKV();
  const env = makeEnv(kv);
  const stock = await import(KV);
  const mk = (id, title, topic, views) => ({
    id,
    kind: "news",
    title,
    caption: title + ": разбор схемы",
    topic_id: topic, style_id: "warning", scheme_id: "safe_account",
    vk_ok: true,
    published_at: new Date(Date.now() - 3600000).toISOString(),
    stats: { vk: { views, likes: 10 } },
  });
  await stock.addLog(env, mk("a1", "Звонок из банка", "call", 5000));
  await stock.addLog(env, mk("a2", "Безопасный счёт", "call", 4000));
  await stock.addLog(env, mk("a3", "Лжеоператоры", "call", 3000));
  let llmBody = null;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("render.test/llm")) {
      llmBody = JSON.parse(opts.body || "{}");
      return new Response(JSON.stringify({ headline: ["Заголовок"], caption: "Текст поста про карты и счета", cards: [], tier: "news" }), { status: 200 });
    }
    return new Response("boom", { status: 502 });
  };
  try {
    const text = "Мошенники звонят пенсионерам, представляясь сотрудниками банка, и убеждают перевести деньги на безопасный счёт.";
    const out = await generatePostData(text, env, {});
    assert.ok(llmBody, "/llm вызван");
    assert.ok(llmBody.best_posts && llmBody.best_posts.includes("тема: call"), "подсказка с темой-лидером");
    assert.ok(out.caption && out.caption.includes("TrustNode"), "пост собран");
  } finally {
    delete globalThis.fetch;
  }
});

// ---------- улучшения контента: заголовки, мост «касается вас», механика ----------

test("generateByRules: выбирает лучший заголовок по правилам (вопрос/цифра/«вас»)", async () => {
  const { generateByRules } = await import(LLM);
  const text = "Мошенники звонят россиянам и предлагают перевести деньги на безопасный счёт. По данным ЦБ, за год похищено 15,8 млрд рублей.";
  const d = generateByRules(text, { link: "https://ria.ru/x" });
  assert.ok(d.headline.length > 10, "заголовок есть");
  assert.ok(d.headline.length <= 90, "заголовок в разумной длине");
  // Схема safe_account распознана — заголовок из её вариантов.
  assert.equal(d.scheme_id, "safe_account", "схема определена");
});

test("generateByRules: мост «касается вас» добавляется когда подача безличная", async () => {
  const { generateByRules } = await import(LLM);
  const text = "По данным ЦБ, за год мошенники похитили 15,8 млрд рублей у россиян. Схема с безопасным счётом работает до сих пор.";
  const d = generateByRules(text, { link: "https://ria.ru/x" });
  // в «myth»-стиле мост появляется: «Я бы не повёлся…»; текст без «вы/вас» — мост должен добавиться
  assert.ok(
    /Я бы не повёлся|могут столкнуться|может быть про вас|теряют не «кто-то»|реальные люди/.test(d.caption),
    "есть мост «касается вас»"
  );
});

test("generateByRules: карточка «почему это работает» из схемы", async () => {
  const { generateByRules } = await import(LLM);
  const text = "Мошенники звонят пенсионерам, представляясь сотрудниками банка, и убеждают перевести деньги на безопасный счёт. По данным ЦБ, за год похищено 15,8 млрд рублей.";
  const d = generateByRules(text, { link: "https://ria.ru/x" });
  const whyCard = d.cards.find((c) => c.label === "Почему это работает");
  assert.ok(whyCard, "карточка механики есть");
  assert.ok(whyCard.items.length >= 1, "в карточке есть объяснение");
});

test("generatePostData: тянет prev_post из истории (сетка карточек)", async () => {
  const { generatePostData } = await import(LLM);
  const kv = makeKV();
  const env = makeEnv(kv);
  const stock = await import(KV);
  await stock.addLog(env, {
    id: "prev1",
    kind: "news",
    title: "Старый пост",
    published_at: new Date().toISOString(),
    caption: "Старый пост",
    card_types: ["stat", "stat", "list"],
    layout: "stat-stat-list",
  });
  // Провайдеров нет — уходит в правила; prev_post должен быть подхвачен из лога
  // и не сломать генерацию (meta.prev_post прокидывается без ошибок).
  const text = "Мошенники звонят россиянам и предлагают перевести деньги на безопасный счёт. По данным ЦБ, за год похищено 15,8 млрд рублей.";
  const out = await generatePostData(text, env, { provider: "rules" });
  assert.ok(out.caption.includes("TrustNode"), "пост сгенерирован");
});

// ---------- чекер клише-открывалок ----------

test("nlp: stripCliche срезает «важно/срочно/эксперты» из заголовка", async () => {
  const nlp = await import(NLP);
  assert.ok(nlp.clicheOpenerLen("Важно! Мошенники активизировались") !== null, "клише распознано");
  assert.equal(nlp.stripCliche("Срочно: новая схема обмана"), "новая схема обмана", "срезано «Срочно:»");
  assert.equal(nlp.stripCliche("Эксперты предупредили о новой схеме"), "о новой схеме", "срезано «Эксперты предупредили»");
  assert.equal(nlp.clicheOpenerLen("Мошенники звонят россиянам"), null, "обычная строка не клише");
});

test("generateByRules: клише в заголовке штрафуется при выборе для факт-подачи", async () => {
  const { generateByRules } = await import(LLM);
  // Лид с клише «по итогам» — правила должны срезать его у заголовка.
  const text = "За год мошенники похитили 15,8 млрд рублей. Схема с безопасным счётом работает до сих пор.";
  const d = generateByRules(text, { link: "https://ria.ru/x" });
  assert.ok(!/^(важно|срочно|внимание|по итогам|эксперты)/i.test(d.headline), "заголовок без клише-открывалки");
  assert.ok(d.headline.length >= 10, "заголовок на месте");
});

// ---------- self-critique и Workers AI как резервный контур ----------

test("generateDigestText: Workers AI собирает дайджест как последний фолбэк", async () => {
  const llm = await import(LLM);
  const items = [
    {
      title: "Мошенники звонят про безопасный счёт",
      text: "По данным ЦБ, за год похищено 15,8 млрд рублей.",
      link: "https://ria.ru/x",
    },
  ];
  const env = {
    AI: {
      run: async (_model, opts) => {
        const user = String(opts.messages[opts.messages.length - 1].content || "");
        if (/булетов\s+ровно/i.test(user)) {
          return { response: '{"headline":"Дайджест недели","bullets":["Безопасный счёт — развод, повесьте трубку"],"advice":["Не верьте звонкам"]}' };
        }
        return { response: JSON.stringify({ headline: "x", caption: "x", cards: [], tier: "news" }) };
      },
    },
  };
  const out = await llm.generateDigestText(items, env, { slug: "day" });
  assert.ok(out, "дайджест собрался через Workers AI");
  assert.ok(out.headline && out.headline.length > 5, "заголовок есть");
  assert.ok(out.digest_text.includes("TrustNode"), "футер в тексте");
});

test("self-critique: LLM_CRITIQUE не влияет на провайдер rules", async () => {
  const { generatePostData } = await import(LLM);
  const kv = makeKV();
  const env = makeEnv(kv);
  env.LLM_CRITIQUE = "1"; // даже включённый флаг не трогает детерминированные правила
  const text = "Мошенники звонят россиянам и предлагают перевести деньги на безопасный счёт. По данным ЦБ, за год похищено 15,8 млрд рублей.";
  const out = await generatePostData(text, env, { provider: "rules" });
  assert.ok(out.caption.includes("TrustNode"), "пост сгенерирован правилами");
  assert.equal(out.llm_provider, undefined, "провайдера-LLM нет у rules-поста");
});