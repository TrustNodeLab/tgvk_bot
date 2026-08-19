// Операционные догонялки поверх основного тика (низкий приоритет, всё через
// bounded-бюджет — не могут уронить крон):
//   • collectEngagement   — VK-просмотры/лайки + дневные метрики (троттл 45 мин);
//   • maybeHealthAlert    — раз в день (03:00 ЕКБ) сводка по пропущенным окнам;
//   • maybeBackupToGitHub — раз в день (03:00 ЕКБ) снапшот KV в репозиторий.
// Всё best-effort: нет токенов/прав — тихо пропускаем, никогда не бросаем.

import * as kv from "./kv.js";
import { ekbNow, plural } from "./config.js";
import { getSchedule } from "./schedule.js";
import { fetchVkEngagement, collectDailyMetrics, minutesToClock } from "./analytics.js";
import { sendMessage } from "./telegram.js";

export const ENGAGE_THROTTLE_MS = 45 * 60 * 1000;
export const HEALTH_ALERT_HOUR = 1; // 01:00 ЕКБ — сводка за вчерашний день
export const BACKUP_HOUR = 3; // 03:00 ЕКБ — ночной снапшот KV

// ---------- метрики охвата ----------

// Догоняем просмотры/лайки VK для свежих постов (fetchVkEngagement внутри
// сам решает, сколько и когда — не чаще раза в 45 минут по маркеру ops:engagement_at).
export async function collectEngagement(env, { now = new Date() } = {}) {
  try {
    if (!env.BOT_KV) return { ok: false, reason: "no kv" };
    const raw = await env.BOT_KV.get("ops:engagement_at");
    let last = null;
    try { last = raw ? new Date(JSON.parse(raw).at) : null; } catch (e) { last = null; }
    if (last && now.getTime() - last.getTime() < ENGAGE_THROTTLE_MS) {
      return { ok: false, reason: "throttled" };
    }
    await env.BOT_KV.put("ops:engagement_at", JSON.stringify({ at: now.toISOString() }));
    const vk = await fetchVkEngagement(env, { now });
    let metrics = null;
    try { metrics = await collectDailyMetrics(env, { now }); } catch (e) { metrics = null; }
    return { ok: true, vk, metrics };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ---------- мониторинг здоровья ----------

// Окна дня, старт которых уже наступил (по ЕКБ), но не дали ни одного поста.
// «Пропуск» считаем по старту: окно открылось, а поста в нём не вышло.
export async function missedWindowsToday(env, { now = new Date(), date = null } = {}) {
  const wins = await getSchedule(env).then((s) => s.windows);
  if (!wins || !wins.length) return [];
  const day = date || ekbNow(now).date;
  const log = await kv.getLog(env);
  const delivered = new Set();
  for (const e of log || []) {
    if (!e || !(e.vk_ok || e.tg_ok) || !e.published_at) continue;
    const d = ekbNow(new Date(e.published_at)).date;
    if (d !== day) continue;
    if (e.window_slug) delivered.add(e.window_slug);
  }
  const nowMin = ekbNow(now).minuteOfDay;
  return wins.filter((w) => (w.start || 0) <= nowMin && !delivered.has(w.slug));
}

// Текст ночной сводки здоровья. Пустая строка = всё чисто, алерт не шлём.
// По умолчанию смотрит ЗА ВЧЕРА (день уже закрыт) — поэтому окно алерта 01:00.
export async function dayHealthText(env, { now = new Date(), date = null } = {}) {
  const day = date || dateKeyOffset(ekbNow(now).date, -1);
  const missed = await missedWindowsToday(env, { now, date: day });
  const health = await kv.getHealthDay(env, day);
  const log = await kv.getLog(env);
  const dayPosts = (log || []).filter(
    (e) => e && (e.vk_ok || e.tg_ok) && e.published_at &&
      ekbNow(new Date(e.published_at)).date === day
  );

  const lines = [];
  if (missed.length) {
    lines.push(`🕓 Пропущенные окна: <b>${missed.map((w) => `«${w.label}»`).join(", ")}</b>`);
    lines.push(`   Перенесите их в /schedule кнопками «⬅»/«➡» или пересоберите AI-планом.`);
  }
  if (health.publish_fails) {
    lines.push(`❌ Срывов публикации за день: <b>${health.publish_fails}</b>`);
  }
  const last = dayPosts[dayPosts.length - 1];
  if (last) {
    const t = ekbNow(new Date(last.published_at));
    lines.push(`✅ Последний пост: <b>${minutesToClock(t.minuteOfDay)}</b> · всего <b>${dayPosts.length}</b> ${plural(dayPosts.length, "пост", "поста", "постов")}`);
  } else if (!missed.length && !health.publish_fails) {
    return "";
  }
  if (!lines.length) return "";

  return `🏥 <b>Здоровье студии · ${day}</b>\n\n` + lines.join("\n");
}

// Один алерт в сутки (маркер health_sent:<day>): шлём в час HEALTH_ALERT_HOUR
// сводку по ВЧЕРАШНЕМУ дню, только если есть что сообщить.
export async function maybeHealthAlert(env, { now = new Date() } = {}) {
  try {
    const ekb = ekbNow(now);
    if (ekb.hour !== HEALTH_ALERT_HOUR) return { ok: false, reason: "not hour" };
    const day = dateKeyOffset(ekb.date, -1);
    if (await kv.getHealthMarker(env, day)) return { ok: false, reason: "already" };
    const text = await dayHealthText(env, { now, date: day });
    if (!text || !env.TELEGRAM_ADMIN_CHAT_ID) return { ok: false, reason: "clean" };
    await kv.setHealthMarker(env, day);
    await sendMessage(env, env.TELEGRAM_ADMIN_CHAT_ID, text, { parse_mode: "HTML" });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// ---------- ночной бэкап KV в GitHub ----------

function toB64Utf8(s) {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Снапшот без тяжёлых полей: без PNG-картинок и полных seen_guids/candidates.
export async function buildBackup(env, { now = new Date() } = {}) {
  const date = ekbNow(now).date;
  const state = await kv.loadState(env);
  const schedule = await getSchedule(env);
  const log = await kv.getLog(env);
  const dayMetrics = [];
  for (let i = 29; i >= 0; i--) {
    const d = dateKeyOffset(date, -i);
    const r = await kv.getDayMetrics(env, d);
    if (r) dayMetrics.push(r);
  }
  return {
    at: new Date().toISOString(),
    day: date,
    schedule,
    state: {
      ...state,
      seen_guids: (state.seen_guids || []).slice(-200),
      candidates: undefined,
    },
    publish_log: (log || []).slice(-120).map((e) => {
      const { png, b64, bytes, ...rest } = e || {};
      return rest;
    }),
    day_metrics: dayMetrics,
    content_weights: await kv.getContentWeights(env),
    poll_stats: await kv.getPollStats(env),
  };
}

// Обновляет backups/tgvk_kv.json через GitHub Contents API (история — коммиты).
// Возвращает { ok } — без токена/репозитория тихо пропускает.
export async function maybeBackupToGitHub(env, { now = new Date() } = {}) {
  try {
    const ekb = ekbNow(now);
    const day = ekb.date;
    if (ekb.hour !== BACKUP_HOUR) return { ok: false, reason: "not hour" };
    if (await kv.getBackupMarker(env, day)) return { ok: false, reason: "already" };
    const { GITHUB_TOKEN, OWNER, REPO } = env;
    if (!GITHUB_TOKEN || !OWNER || !REPO) return { ok: false, reason: "no github" };

    const backup = await buildBackup(env, { now });
    const path = "backups/tgvk_kv.json";
    const api = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${path}`;
    const headers = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "tgvk-bot-webhook",
    };
    let sha = null;
    try {
      const ex = await fetch(api, { headers });
      if (ex.ok) {
        const j = await ex.json();
        if (j && j.sha) sha = j.sha;
      }
    } catch (e) { /* файла ещё нет — создаём */ }

    const res = await fetch(api, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        message: `backup ${day}`,
        content: toB64Utf8(JSON.stringify(backup, null, 1)),
        ...(sha ? { sha } : {}),
      }),
    });
    if (!res.ok) return { ok: false, reason: `http ${res.status}` };
    await kv.setBackupMarker(env, day);
    return { ok: true, path };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function dateKeyOffset(date, offsetDays) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + offsetDays));
  return t.toISOString().slice(0, 10);
}