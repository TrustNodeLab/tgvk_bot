// Агрегация метрик вовлечённости по уже опубликованным постам. Метрики
// хранятся прямо в записях publish_log:
//   entry.stats = { vk: { views, likes, reposts, comments, at }, reactions: { emoji: n }, ... }
// Сбор метрик (VK-опрос, TG-реакции) вырезан — групповой токен VK не читает
// стену (error 27), реакции не подтверждены. Оставлены чистые агрегации:
// они питают ротацию стилей, «что залетает» для промпта LLM и веса тем.

import * as kv from "./kv.js";

// ---------- агрегация ----------

function engagementOf(entry) {
  const s = entry.stats || {};
  const vk = s.vk || {};
  const views = vk.views || 0;
  const reactions = s.reactions_total || 0;
  return { views, likes: vk.likes || 0, reposts: vk.reposts || 0, reactions };
}

// Собирает метрики по одному измерению (scheme_id/style_id/topic_id/…).
function bucketize(log, dimKey) {
  const buckets = new Map();
  for (const e of log) {
    const key = String(e[dimKey] || "?").trim() || "?";
    const b = buckets.get(key) || { key, posts: 0, views: 0, likes: 0, reactions: 0, engagement: 0 };
    const m = engagementOf(e);
    b.posts++;
    b.views += m.views;
    b.likes += m.likes;
    b.reactions += m.reactions;
    b.engagement += m.views + m.likes * 50 + m.reactions * 30;
    buckets.set(key, b);
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, avg_views: b.posts ? Math.round(b.views / b.posts) : 0 }))
    .sort((a, b) => b.engagement - a.engagement);
}

// Складывает агрегаты по всем измерениям.
export function aggregateStats(log) {
  return {
    scheme: bucketize(log, "scheme_id"),
    style: bucketize(log, "style_id"),
    topic: bucketize(log, "topic_id"),
    provider: bucketize(log, "llm_provider"),
  };
}

// ---------- «залётность» поста и анализ лучших ----------

// Возраст поста в часах (по published_at); null — если даты нет.
function hoursSince(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.max(0.1, (Date.now() - t) / 3600000);
}

// «Залётность» поста: активность (views + лайки*50 + репосты*80 + реакции*30)
// с честной поправкой на возраст. Свежие посты (до 3 суток) ещё набирают
// охват — их не штрафуем; старые нормируем на число дней, чтобы сравнивать
// вчерашний и месячной давности пост было корректно.
export function postFlyScore(entry) {
  const m = engagementOf(entry);
  const raw = m.views + m.likes * 50 + m.reposts * 80 + m.reactions * 30;
  const hrs = hoursSince(entry && entry.published_at);
  if (hrs === null || hrs <= 72) return raw;
  return raw / (hrs / 24);
}

// Лучшие посты по «залётности» с их атрибутами (жанр/схема/тема) — основа для
// контекста «делай похожие» в промпте LLM.
export function bestPerformingPosts(log, n = 5) {
  const scored = (log || [])
    .filter((e) => e && (e.vk_ok || e.tg_ok))
    .map((e) => ({ e, score: postFlyScore(e) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
  return scored.map((x) => {
    const m = engagementOf(x.e);
    const head =
      String(x.e.caption || x.e.title || "").replace(/<[^>]+>/g, "").split("\n").filter(Boolean)[0] || "";
    return {
      id: x.e.id,
      title: String(x.e.title || head || "").slice(0, 80),
      headline: head.slice(0, 90),
      style_id: x.e.style_id || null,
      scheme_id: x.e.scheme_id || null,
      topic_id: x.e.topic_id || null,
      views: m.views,
      likes: m.likes,
      reposts: m.reposts,
      reactions: m.reactions,
      score: Math.round(x.score),
      vk_post_id: x.e.vk_post_id || null,
      published_at: x.e.published_at,
    };
  });
}

// Краткая сводка «что сейчас лучше всего залетает» для промпта LLM: лидирующие
// жанр/тема/схема со средними просмотрами + примеры лучших постов. Пустая
// строка, когда статистики ещё нет (пары постов мало — это не статистика).
export function winningContextText(log, { max = 3 } = {}) {
  const agg = aggregateStats(log);
  const dims = [];
  const addDim = (list, name) => {
    const top = (list || []).filter((b) => b.posts >= 2).slice(0, max);
    if (!top.length) return;
    dims.push(name + ": " + top.map((b) => `${b.key} (~${b.avg_views} просм./пост)`).join(", "));
  };
  addDim(agg.style, "жанр");
  addDim(agg.topic, "тема");
  addDim(agg.scheme, "схема");
  const examples = bestPerformingPosts(log, 3)
    .map((p) => `«${p.headline || p.title}» (~${p.views} просм.)`)
    .filter(Boolean);
  if (!dims.length && !examples.length) return "";
  return (
    "Что сейчас лучше всего залетает у аудитории: " +
    (dims.length ? dims.join("; ") : "") +
    (examples.length ? (dims.length ? ". " : "") + "Примеры лучших постов: " + examples.join(", ") : "") +
    ". Сделай новый пост в этом же ключе — но не повторяй дословно."
  );
}

// ---------- ротация стилей/тем/схем по вовлечённости ----------

// Обобщённые веса по любому измерению publish_log: измерения со стабильной и
// высокой вовлечённостью получают boost, чтобы ротация чаще выбирала их.
// Порог постов обязателен: 1-3 поста — ещё не статистика, веса не трогаем.
export function weightsFromLog(log, dimKey, { minPosts = 3 } = {}) {
  const byDim = bucketize(log, dimKey);
  const weights = {};
  for (const b of byDim) {
    if (b.posts < minPosts) continue;
    const reward = Math.min(2, 1 + b.engagement / Math.max(1, b.posts) / 100);
    weights[b.key] = reward;
  }
  return weights;
}

// Веса жанров для pickPostStyle: жанры со стабильной и высокой вовлечённостью
// получают boost, чтобы ротация чаще выбирала их.
export function styleWeightsFromLog(log, opts) {
  return weightsFromLog(log, "style_id", opts);
}

// Веса тем — для приоритета тем-лидеров в отборе кандидатов на выпуск.
export function topicWeightsFromLog(log, opts) {
  return weightsFromLog(log, "topic_id", opts);
}

// Веса схем мошенничества — для подачи «делай похожие» и приоритета в выпуске.
export function schemeWeightsFromLog(log, opts) {
  return weightsFromLog(log, "scheme_id", opts);
}

// Сводные веса по всем измерениям: { style, topic, scheme }.
export function contentWeightsFromLog(log, opts = {}) {
  return {
    style: styleWeightsFromLog(log, opts),
    topic: topicWeightsFromLog(log, opts),
    scheme: schemeWeightsFromLog(log, opts),
  };
}

// Полные веса ротации (жанр/тема/схема) из KV; style всегда есть (обратная
// совместимость с refreshStyleWeights), topic/scheme — по мере накопления статов.
export async function getContentWeights(env) {
  return (await kv.getContentWeights(env)) || {};
}