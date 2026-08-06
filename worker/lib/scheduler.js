// Планировщик: каждый крон выполняет полный цикл —
// скан+дедуп -> диспатч на подготовку -> авто-отложка черновиков ->
// публикация из «склада» по слотам -> аудиты -> аварийный фолбэк при аутэдже GitHub.

import {
  NEWS_WINDOWS, AUDIT_DAILY, AUDIT_WEEKLY, EVENT_MONDAY,
  MSK_OFFSET_MIN, STOCK_TARGET, MAX_IN_FLIGHT, MAX_CANDIDATES_PER_TICK,
  DRAFT_TIMEOUT_MIN, DISPATCH_STALE_MIN, FALLBACK_COOLDOWN_MS, mskNow, plural,
} from "./config.js";
import * as kv from "./kv.js";
import { scanFeeds } from "./feeds.js";
import { sendGeneratedPreview, sourceDomain } from "./preview.js";
import {
  publishToTelegram, publishToVk, sendMessage, vkCall, tgCall,
} from "./telegram.js";
import { fullPostText, fitCaption, fmtTime } from "./text.js";
import { buildDailyAudit, buildWeeklyAudit, buildEventFallback } from "./audits.js";

const CHUNK_COUNT = 2; // скан делится на 2 части (лимит подзапросов free-плана)

// ---------- время и слоты ----------

function mskToUtcMs(dow, minuteOfDay, now = new Date()) {
  // ближайшее наступление dow (0=пн) в minuteOfDay в МСК -> epoch ms
  const msk = new Date(now.getTime() + MSK_OFFSET_MIN * 60 * 1000);
  const todayDow = (msk.getUTCDay() + 6) % 7;
  let delta = (dow - todayDow + 7) % 7;
  let y = msk.getUTCFullYear();
  let m = msk.getUTCMonth();
  let d = msk.getUTCDate();
  for (let i = 0; i < delta; i++) {
    d += 1;
    if (d > new Date(Date.UTC(y, m + 1, 0)).getUTCDate()) {
      d = 1;
      m += 1;
      if (m > 11) {
        m = 0;
        y += 1;
      }
    }
  }
  const utcMinute = minuteOfDay - MSK_OFFSET_MIN;
  return Date.UTC(y, m, d, Math.floor(utcMinute / 60), utcMinute % 60) - (0);
}

function randBetween(a, b) {
  return a + Math.floor(Math.random() * (b - a + 1));
}

export function currentWindow(minuteOfDay) {
  return NEWS_WINDOWS.find((w) => minuteOfDay >= w.start && minuteOfDay < w.end) || null;
}

function inWindow(msk, win) {
  return msk.minuteOfDay >= win.start && msk.minuteOfDay < win.end;
}

// Сколько новостей уже опубликовано в этом окне сегодня.
async function countInWindow(env, win, now) {
  const log = await kv.getLog(env);
  const msk = mskNow(now);
  return log.filter((e) => {
    if (e.kind && e.kind !== "news") return false;
    if (e.kind === "news" || !e.kind) {
      const t = new Date(e.published_at);
      if (Number.isNaN(t.getTime())) return false;
      const em = mskNow(t);
      if (em.date !== msk.date) return false;
      return em.minuteOfDay >= win.start && em.minuteOfDay < win.end;
    }
    return false;
  }).length;
}

// Следующий свободный слот для новостного поста (epoch ms).
export async function nextFreeSlot(env, now = new Date()) {
  const msk = mskNow(now);
  const cur = currentWindow(msk.minuteOfDay);
  if (cur) {
    const used = await countInWindow(env, cur, now);
    if (used < cur.cap) return now.getTime(); // публикуем сейчас
  }
  // ищем ближайшее будущее окно с местом (сегодня или дальше)
  let dayOffset = 0;
  for (let i = 0; i < 7 * 24; i++) {
    const t = now.getTime() + dayOffset * 86400000;
    const m2 = mskNow(new Date(t));
    for (const w of NEWS_WINDOWS) {
      if (m2.minuteOfDay < w.end) {
        const used = await countInWindow(env, w, new Date(t));
        if (used < w.cap) {
          // Окно ещё открыто сегодня (start может быть в прошлом — тогда
          // randBetween даст «сейчас», нижняя граница — now+60s).
          const start = mskToUtcMs(m2.dow, w.start, new Date(t));
          const end = mskToUtcMs(m2.dow, Math.min(w.end, 23 * 60 + 59), new Date(t));
          const slot = randBetween(start, end);
          return Math.max(slot, now.getTime() + 60 * 1000);
        }
      }
    }
    dayOffset += 1;
  }
  return now.getTime() + 3600 * 1000;
}

function auditSlotMs(cfg, now = new Date()) {
  const msk = mskNow(now);
  if (cfg === AUDIT_DAILY) {
    return mskToUtcMs(msk.dow, AUDIT_DAILY.start, now);
  }
  // ближайшие выходные/понедельник — окно «сегодня или в следующий раз»
  return mskToUtcMs(cfg.dow, cfg.start, now);
}

// ---------- диспатч кандидатов на подготовку (GitHub Actions) ----------

function chunkText(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

export async function dispatchToGitHub(env, cand) {
  const chunks = chunkText(cand.text || "", 600).slice(0, 9);
  const inputs = {
    telegram_update: JSON.stringify({
      auto_found: cand.auto_found !== false,
      guid: cand.guid,
      title: cand.title || "",
      link: cand.link || "",
      kind: cand.kind || "news",
      message: { chat: { id: cand.chat_id ?? null }, text: chunks[0] || "" },
    }),
  };
  for (let i = 1; i < chunks.length; i++) inputs[`telegram_update_${i + 1}`] = chunks[i];

  const res = await fetch(
    `https://api.github.com/repos/${env.OWNER}/${env.REPO}/actions/workflows/poll.yml/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "tgvk-bot-webhook",
      },
      body: JSON.stringify({ ref: "main", inputs }),
    }
  );
  if (!res.ok) return false;
  await kv.markDispatch(env, cand.guid, {
    at: Date.now(),
    title: cand.title,
    link: cand.link,
    kind: cand.kind || "news",
    status: "dispatched",
  });
  return true;
}

// ---------- публикация ----------

export async function publishPackage(env, pkg, dry) {
  let tgOk = false;
  let vkOk = false;
  let tgErr = null;
  let vkErr = null;
  try {
    await publishToTelegram(env, pkg, dry);
    tgOk = true;
  } catch (e) {
    tgErr = e.message;
  }
  try {
    await publishToVk(env, pkg, dry);
    vkOk = true;
  } catch (e) {
    vkErr = e.message;
  }
  if (!tgOk && !vkOk) {
    throw new Error(`publish failed tg=[${tgErr}] vk=[${vkErr}]`);
  }
  await kv.addLog(env, {
    id: pkg.id,
    kind: pkg.kind || "news",
    title: pkg.title || "",
    guid: pkg.guid || "",
    link: pkg.link || "",
    tags: pkg.tags || [],
    source: pkg.source || "",
    published_at: new Date().toISOString(),
    caption: pkg.caption || "",
    tg_ok: tgOk,
    vk_ok: vkOk,
  });
  return { tgOk, vkOk };
}

// Публикация текстового поста (фолбэк/аудит без карточки).
export async function publishText(env, text, dry, kind, extra = {}) {
  let tgOk = false;
  let vkOk = false;
  if (dry) {
    console.log(`[dry-run] TG text -> ${env.TELEGRAM_CHANNEL_ID} (${text.length} симв.)`);
    tgOk = true;
  } else {
    try {
      await sendMessage(env, env.TELEGRAM_CHANNEL_ID, text, { parse_mode: "HTML" });
      tgOk = true;
    } catch (e) { /* vk может пройти */ }
  }
  const plain = text.replace(/<[^>]+>/g, "").trim();
  if (dry) {
    console.log(`[dry-run] VK wall.post text (${plain.length} симв.)`);
    vkOk = true;
  } else {
    try {
      await vkCall(env, "wall.post", {
        owner_id: -env.VK_GROUP_ID,
        from_group: 1,
        message: plain,
      });
      vkOk = true;
    } catch (e) { /* ignore */ }
  }
  if (!tgOk && !vkOk) return false;
  await kv.addLog(env, {
    id: extra.id || `t${Date.now()}`,
    kind,
    title: extra.title || "",
    guid: extra.guid || "",
    link: extra.link || "",
    published_at: new Date().toISOString(),
    caption: text,
    tg_ok: tgOk,
    vk_ok: vkOk,
  });
  return true;
}

// ---------- черновики ----------

async function autoDeferDrafts(env, state, now = new Date()) {
  const drafts = await kv.listDrafts(env);
  const deadline = now.getTime() - DRAFT_TIMEOUT_MIN * 60 * 1000;
  for (const d of drafts) {
    if (d.status && d.status !== "pending") continue;
    // Черновики от GitHub приходят без created_at — таймер 30 минут стартует
    // с момента, когда Worker впервые увидел черновик.
    if (!d.created_at) {
      d.created_at = now.toISOString();
      await kv.saveDraft(env, d);
      continue;
    }
    const created = new Date(d.created_at).getTime();
    if (created > deadline) continue;
    // админ не ответил за 30 минут -> отложенный пост в ближайший свободный слот
    const slot = await nextFreeSlot(env, now);
    await kv.deleteDraft(env, d.id);
    await kv.addStock(env, {
      id: d.id,
      kind: "news",
      title: d.title || "",
      caption: d.caption || "",
      png_key: d.png_key || null,
      png: d.png || null,
      link: d.link || "",
      guid: d.guid || "",
      source: d.source || "",
      tags: d.tags || [],
      scheduled_for: slot,
      created_at: new Date().toISOString(),
      from_admin: false,
    });
    const when = fmtTime(new Date(slot).toISOString());
    try {
      await sendMessage(
        env,
        env.TELEGRAM_ADMIN_CHAT_ID,
        `⏳ <b>Не получил ответ за ${DRAFT_TIMEOUT_MIN} минут</b> — пост «${d.title || ""}» поставлен в отложенные на слот ${when}.`,
        { parse_mode: "HTML" }
      );
    } catch (e) { /* ignore */ }
  }
}

// ---------- аудиты ----------

async function publishAuditIfDue(env, state, now = new Date()) {
  const msk = mskNow(now);
  const log = await kv.getLog(env);

  // ежедневный
  if (inWindow(msk, AUDIT_DAILY) && state.meta.last_daily_audit !== msk.date) {
    await publishAuditKind(env, "daily_audit", state, log, now, msk, AUDIT_DAILY);
  }
  // недельный (воскресенье)
  if (
    msk.dow === AUDIT_WEEKLY.dow && inWindow(msk, AUDIT_WEEKLY) &&
    state.meta.last_weekly_audit !== msk.date
  ) {
    await publishAuditKind(env, "weekly_audit", state, log, now, msk, AUDIT_WEEKLY);
  }
  // понедельничный ивент
  if (
    msk.dow === EVENT_MONDAY.dow && inWindow(msk, EVENT_MONDAY) &&
    state.meta.last_event !== msk.date
  ) {
    await publishAuditKind(env, "event", state, log, now, msk, EVENT_MONDAY);
  }
}

async function publishAuditKind(env, kind, state, log, now, msk, cfg) {
  const dry = !!state.dry_run;
  // если GitHub заранее подготовил пакет аудита — публикуем его (с карточкой)
  const stock = await kv.getStock(env);
  const prepped = stock.find((p) => p.kind === kind && (p.scheduled_for || 0) <= now.getTime());
  let ok = false;
  if (prepped) {
    await kv.removeStock(env, prepped.id);
    try {
      await publishPackage(env, prepped, dry);
      ok = true;
    } catch (e) {
      // карточка не ушла — пробуем текстовую версию
    }
  }
  if (!ok) {
    let text;
    if (kind === "daily_audit") text = buildDailyAudit(log, msk);
    else if (kind === "weekly_audit") text = buildWeeklyAudit(log, msk);
    else text = buildEventFallback(log, msk);
    if (text) ok = await publishText(env, text, dry, kind, { id: `${kind}_${msk.date}` });
  }
  if (ok) {
    if (kind === "daily_audit") state.meta.last_daily_audit = msk.date;
    if (kind === "weekly_audit") state.meta.last_weekly_audit = msk.date;
    if (kind === "event") state.meta.last_event = msk.date;
    await kv.saveState(env, state);
  }
}

// ---------- аварийный фолбэк (GitHub лежит) ----------

async function handleStaleDispatches(env, state, now = new Date()) {
  const dispatches = await kv.listDispatches(env);
  const staleMs = DISPATCH_STALE_MIN * 60 * 1000;
  const cooldownUntil = (state.meta.last_fallback || 0) + FALLBACK_COOLDOWN_MS;
  const dry = !!state.dry_run;
  for (const d of dispatches) {
    if (d.status === "done") continue;
    // ручные черновики не фолбэчат: там превью/одобрение ведёт админ
    if (d.kind === "manual") continue;
    if ((d.guid || "").startsWith("m")) continue; // старые ручные диспатчи (до фикса kind)
    if (now.getTime() - d.at < staleMs) continue;
    if (cooldownUntil > now.getTime()) continue;
    // редкий «аудит-пост» текстом, чтобы что-то вышло при аутэдже GitHub
    const title = d.title || "";
    const link = d.link || "";
    const text =
      "⚠️ <b>Срочная сводка</b>\n\n" +
      `${title}\n\nИсточник: ${link}\n\n` +
      "🛡️ TrustNode";
    const ok = await publishText(env, text, dry, "fallback", { guid: d.guid, title, link });
    if (ok) {
      state.meta.last_fallback = Date.now();
      await kv.saveState(env, state);
      await kv.markDispatch(env, d.guid, { ...d, status: "fallback_posted" });
    }
    break; // один фолбэк за крон
  }
}

// ---------- публикация из склада по слотам ----------

async function publishDueStock(env, now = new Date()) {
  const stock = await kv.getStock(env);
  const due = stock.filter((p) => (p.scheduled_for || 0) <= now.getTime());
  for (const pkg of due) {
    if (pkg.kind === "news") {
      const msk = mskNow(new Date(pkg.scheduled_for || now.getTime()));
      const win = currentWindow(msk.minuteOfDay);
      if (win) {
        const used = await countInWindow(env, win, new Date(pkg.scheduled_for || now.getTime()));
        if (used >= win.cap) {
          // окно переполнено — переносим в следующий свободный слот
          const next = await nextFreeSlot(env, now);
          await kv.removeStock(env, pkg.id);
          await kv.addStock(env, { ...pkg, scheduled_for: next });
          continue;
        }
      }
    }
    // защита от дублей: если этот guid уже публиковался (фолбэк/аудит) — пропускаем
    if (pkg.guid) {
      const log = await kv.getLog(env);
      if (log.some((e) => e.guid && e.guid === pkg.guid)) {
        await kv.removeStock(env, pkg.id);
        continue;
      }
    }
    await kv.removeStock(env, pkg.id);
    try {
      const state = await kv.loadState(env);
      await publishPackage(env, pkg, !!state.dry_run);
    } catch (e) {
      console.log("[scheduler] publish failed:", e.message);
      await kv.addStock(env, { ...pkg, scheduled_for: now.getTime() + 15 * 60 * 1000 });
    }
  }
}

// ---------- главный тик ----------

// Когда GitHub лежит (диспатч не проходит), а autopost включён — генерим
// превью прямо в воркере из первого кандидата и шлём админу на одобрение.
// Не чаще одного: пока есть незакрытый черновик на одобрении, новые не шлём.
async function autoGeneratePreviews(env, state) {
  if (!state.autopost) return;
  if (!env.TELEGRAM_ADMIN_CHAT_ID) return;
  const drafts = await kv.listDrafts(env);
  if (drafts.some((d) => d.kind === "generated" && (!d.status || d.status === "pending"))) return;
  const cands = await kv.getCandidates(env);
  const cand = cands[0];
  if (!cand) return;
  await kv.setCandidates(env, cands.slice(1));
  try {
    const data = await sendGeneratedPreview(
      env,
      env.TELEGRAM_ADMIN_CHAT_ID,
      cand.text || cand.title,
      { link: cand.link || "", source: sourceDomain(cand.link || ""), guid: cand.guid || "" }
    );
    console.log("[scheduler] autogen preview:", data.headline);
  } catch (e) {
    console.log("[scheduler] autogen error:", e.message);
    await kv.addCandidate(env, cand);
  }
}

export async function tick(env) {
  const now = new Date();
  const state = await kv.loadState(env);

  // 1. скан (часть лент) + дедуп + кандидаты в очередь
  const offset = state.meta.scan_chunk || 0;
  try {
    await scanFeeds(env, offset, CHUNK_COUNT);
  } catch (e) {
    console.log("[scheduler] scan error:", e.message);
  }
  state.meta.scan_chunk = (offset + 1) % CHUNK_COUNT;

  // 2. диспатч кандидатов на подготовку (по мере исчерпания склада)
  try {
    const stock = await kv.getStock(env);
    const inFlight = (await kv.listDispatches(env)).filter(
      (d) =>
        d.status !== "done" &&
        d.status !== "fallback_posted" &&
        d.kind !== "manual" &&
        !(d.guid || "").startsWith("m") &&
        Date.now() - d.at < 60 * 60 * 1000
    ).length;
    const need = STOCK_TARGET - stock.length;
    if (need > 0 && inFlight < MAX_IN_FLIGHT) {
      const toSend = Math.min(MAX_CANDIDATES_PER_TICK, need, MAX_IN_FLIGHT - inFlight);
      const cands = await kv.takeCandidates(env, toSend);
      for (const c of cands) {
        try {
          const ok = await dispatchToGitHub(env, c);
          if (!ok) {
            await kv.addCandidate(env, c);
          }
        } catch (e) {
          await kv.addCandidate(env, c);
        }
      }
    }
  } catch (e) {
    console.log("[scheduler] dispatch error:", e.message);
  }

  // 3. аварийная генерация в воркере (GitHub лежит, autopost включён)
  try {
    await autoGeneratePreviews(env, state);
  } catch (e) {
    console.log("[scheduler] autogen step error:", e.message);
  }

  // 4. фолбэк при аутэдже GitHub
  try {
    await handleStaleDispatches(env, state, now);
  } catch (e) {
    console.log("[scheduler] fallback error:", e.message);
  }

  // 5. авто-отложка черновиков (нет ответа админа 30 мин)
  try {
    await autoDeferDrafts(env, state, now);
  } catch (e) {
    console.log("[scheduler] defer error:", e.message);
  }

  // 6. публикация из склада
  try {
    await publishDueStock(env, now);
  } catch (e) {
    console.log("[scheduler] publish error:", e.message);
  }

  // 7. аудиты
  try {
    await publishAuditIfDue(env, state, now);
  } catch (e) {
    console.log("[scheduler] audit error:", e.message);
  }

  await kv.saveState(env, state);
  return "ok";
}
