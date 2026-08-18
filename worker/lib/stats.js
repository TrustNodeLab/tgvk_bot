// Сбор и агрегация метрик вовлечённости по уже опубликованным постам.
// Метрики хранятся прямо в записях publish_log:
//   entry.stats = { vk: { views, likes, reposts, comments, at }, reactions: { emoji: n }, ... }
// Периодический сбор (тик): VK — wall.getById опросом (views/likes/reposts/
// comments), TG — реакции приходят в реальном времени через webhook
// (message_reaction) и накапливаются дельта-обновлениями.
// Агрегация по scheme/style/topic/provider питает ротацию стилей и выдаёт
// данные для админ-команды /stats.

import * as kv from "./kv.js";
import { vkCall } from "./telegram.js";

// Не опрашиваем VK каждый тик: повторный замер не чаще раза в час.
const VK_METRICS_TTL_MS = 60 * 60 * 1000;
// Не больше N постов за тик (бережём rate limit VK и бюджет подзапросов).
const MAX_METRICS_PER_TICK = 20;

export function reactionEmojiList(reactions = []) {
  const out = [];
  for (const r of reactions) {
    if (r && r.type === "emoji" && r.emoji) out.push(r.emoji);
  }
  return out;
}

// Дельта одного message_reaction update: пользователь убрал old и поставил new.
// Возвращает новую карту { emoji: count } на основе предыдущей.
export function applyReactionDelta(prev, oldReaction, newReaction) {
  const counts = { ...(prev || {}) };
  for (const emoji of reactionEmojiList(oldReaction)) {
    counts[emoji] = Math.max(0, (counts[emoji] || 0) - 1);
    if (counts[emoji] === 0) delete counts[emoji];
  }
  for (const emoji of reactionEmojiList(newReaction)) {
    counts[emoji] = (counts[emoji] || 0) + 1;
  }
  return counts;
}

// Запись реакции из webhook (update.message_reaction) в запись publish_log
// по tg_message_id. Возвращает true, если запись найдена.
export async function recordReaction(env, reaction) {
  const messageId = reaction && reaction.message_id;
  if (!messageId) return false;
  const log = await kv.getLog(env);
  const i = log.findIndex((e) => String(e.tg_message_id) === String(messageId));
  if (i === -1) return false;
  const entry = log[i];
  const prev = (entry.stats && entry.stats.reactions) || {};
  const reactions = applyReactionDelta(prev, reaction.old_reaction, reaction.new_reaction);
  const total = Object.values(reactions).reduce((a, b) => a + b, 0);
  const patch = {
    stats: { ...(entry.stats || {}), reactions, reactions_total: total, reactions_at: Date.now() },
  };
  await kv.updateLog(env, entry.id, patch);
  return true;
}

// VK: views/likes/reposts/comments по vk_post_id.
// Групповой токен (VK_TOKEN) не может читать стену: wall.getById, wall.get и
// stats.* недоступны ключу сообщества (error 27). Чтение работает только через
// user-токен владельца группы (VK_USER_TOKEN) с правами wall — по-хорошему
// получать его в настройках VK: Standalone приложение -> Implicit Flow
// (scope=wall,groups,offline). Если VK_USER_TOKEN не задан — метрики VK не
// собираются, вызываемый код логирует причину. Повторный замер — не чаще TTL.
export async function collectVkMetrics(env) {
  const log = await kv.getLog(env);
  const now = Date.now();
  const due = log.filter((e) => {
    if (!e.vk_post_id) return false;
    const at = e.stats && e.stats.vk && e.stats.vk.at;
    return !at || now - at > VK_METRICS_TTL_MS;
  });
  const batch = due.slice(0, MAX_METRICS_PER_TICK);
  if (!batch.length) return { fetched: 0, pending: 0 };

  if (!env.VK_USER_TOKEN) {
    console.log("[stats] VK_USER_TOKEN не задан — для чтения метрик стены нужен user-токен владельца группы (standalone приложение, scope wall,groups,offline)");
    return { fetched: 0, pending: due.length };
  }
  // Для чтения используем user-токен (env), постинг остаётся на групповом.
  const readEnv = { ...env, VK_TOKEN: env.VK_USER_TOKEN };

  let fetched = 0;
  try {
    // wall.getById принимает до 100 постов одной строкой: -<ownerId>_<postId>,…
    const posts = batch
      .map((e) => `-${readEnv.VK_GROUP_ID}_${e.vk_post_id}`)
      .join(",");
    const list = await vkCall(readEnv, "wall.getById", { posts, v: "5.199" });
    const map = new Map();
    for (const p of Array.isArray(list) ? list : []) {
      map.set(String(p.id), p);
    }
    for (const e of batch) {
      const p = map.get(String(e.vk_post_id));
      if (!p) continue;
      const patch = {
        stats: {
          ...(e.stats || {}),
          vk: {
            views: (p.views && p.views.count) || 0,
            likes: (p.likes && p.likes.count) || 0,
            reposts: (p.reposts && p.reposts.count) || 0,
            comments: (p.comments && p.comments.count) || 0,
            at: now,
          },
        },
      };
      await kv.updateLog(env, e.id, patch);
      fetched++;
    }
  } catch (e) {
    console.log("[stats] VK метрики недоступны:", e.message);
  }
  return { fetched, pending: due.length - batch.length };
}

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

// Лучшие посты по «залётности» с их атрибутами (жанр/схема/тема) — основа и для
// отчёта админу (/top), и для контекста «делай похожие» в промпте LLM.
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

// Кэшированные веса стилей в KV (обновляются при сборе метрик в тике).
export async function getStyleWeights(env) {
  return (await kv.getStyleWeights(env)) || {};
}

export async function refreshStyleWeights(env) {
  const log = await kv.getLog(env);
  const weights = styleWeightsFromLog(log);
  await kv.setStyleWeights(env, weights);
  return weights;
}

// Полные веса ротации (жанр/тема/схема) из KV; style всегда есть (обратная
// совместимость с refreshStyleWeights), topic/scheme — по мере накопления статов.
export async function getContentWeights(env) {
  return (await kv.getContentWeights(env)) || {};
}

// Пересчитывает и кэширует все веса ротации по свежим метрикам.
export async function refreshContentWeights(env) {
  const log = await kv.getLog(env);
  const weights = contentWeightsFromLog(log);
  await kv.setStyleWeights(env, weights.style);
  await kv.setContentWeights(env, weights);
  return weights;
}

// ---------- данные для дашборда («скриншот» статистики) ----------

// Собирает всё, что нужно для картинки-дашборда в /stats: счётчики, средние
// охваты, вовлечённость, лидеры по жанру/теме/схеме и топ постов.
export function dashboardData(log, { now = new Date() } = {}) {
  const withMetrics = (log || []).filter((e) => e && (e.vk_ok || e.tg_ok));
  let totalViews = 0, totalLikes = 0, totalReactions = 0;
  for (const e of withMetrics) {
    const s = e.stats || {};
    totalViews += (s.vk && s.vk.views) || 0;
    totalLikes += (s.vk && s.vk.likes) || 0;
    totalReactions += s.reactions_total || 0;
  }
  const withViews = withMetrics.filter((e) => e && e.stats && e.stats.vk && e.stats.vk.views > 0);
  const avgViews = withViews.length
    ? Math.round(withViews.reduce((a, e) => a + e.stats.vk.views, 0) / withViews.length)
    : 0;
  const mskNowLocal = new Date(now.getTime() + 3 * 3600 * 1000);
  const date = mskNowLocal.toISOString().slice(0, 10);
  const today = (log || []).filter((e) => {
    const t = new Date(e.published_at);
    if (Number.isNaN(t.getTime())) return false;
    const em = new Date(t.getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
    return em === date;
  }).length;
  const dim = (list) => (list || []).slice(0, 4).map((b) => ({ key: b.key, posts: b.posts, avg_views: b.avg_views }));
  const agg = aggregateStats(log || []);
  return {
    date,
    total_posts: (log || []).length,
    today_posts: today,
    avg_views: avgViews,
    total_views: totalViews,
    total_likes: totalLikes,
    total_reactions: totalReactions,
    engagement: totalViews + totalLikes * 50 + totalReactions * 30,
    styles: dim(agg.style),
    topics: dim(agg.topic),
    schemes: dim(agg.scheme),
    top: bestPerformingPosts(log, 3),
  };
}