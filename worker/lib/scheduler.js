// Планировщик: каждый крон выполняет полный цикл —
// скан+дедуп -> диспатч на подготовку -> авто-отложка черновиков ->
// публикация из «склада» строго по слотам -> догонка недостающей платформы.

import {
  NEWS_WINDOWS,
  MSK_OFFSET_MIN, STOCK_TARGET, MAX_IN_FLIGHT, MAX_CANDIDATES_PER_TICK,
  DRAFT_TIMEOUT_MIN, mskNow, isStaleItem,
} from "./config.js";
import * as kv from "./kv.js";
import { scanFeeds } from "./feeds.js";
import { buildCardPackage, renderCardBytes, sourceDomain } from "./preview.js";
import {
  publishToTelegram, publishToVk, sendMessage, vkCall,
} from "./telegram.js";
import { fmtTime, escHtml } from "./text.js";

const CHUNK_COUNT = 2; // скан делится на 2 части (лимит подзапросов free-плана)
const TICK_LOCK_TTL_MS = 10 * 60 * 1000; // анти-перекрытие крон: не чаще 1 тика

// png в черновике хранится base64 (KV умеет только строки) — превращаем в байты.
function decodePng(b64) {
  if (!b64) return null;
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// Уведомление админу в Telegram о результате публикации. Ошибка отправки не
// роняет публикацию — уведомление некритично.
async function notifyAdmin(env, text) {
  if (!env.TELEGRAM_ADMIN_CHAT_ID) return;
  try {
    await sendMessage(env, env.TELEGRAM_ADMIN_CHAT_ID, text, { parse_mode: "HTML" });
  } catch (e) { /* ignore */ }
}

function vkPostUrl(env, postId) {
  return postId && env.VK_GROUP_ID ? `https://vk.com/wall-${env.VK_GROUP_ID}_${postId}` : null;
}

// Статусная строка по результатам публикации в обе платформы.
function pubStatus(res) {
  const parts = [];
  parts.push(res.tgOk ? "🟢 TG ✓" : "TG ✗");
  parts.push(res.vkOk ? "🔵 VK ✓" : "VK ✗");
  return parts.join(" · ");
}

// ---------- время и слоты ----------

export function mskToUtcMs(dow, minuteOfDay, now = new Date()) {
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

export function currentWindow(minuteOfDay) {
  return NEWS_WINDOWS.find((w) => minuteOfDay >= w.start && minuteOfDay < w.end) || null;
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
// Строгое расписание: каждые 4 часа ровно один пост в начале окна
// (00:00, 04:00, 08:00, 12:00, 16:00, 20:00 МСК). Без рандома внутри окна.
export async function nextFreeSlot(env, now = new Date()) {
  const nowMs = now.getTime();
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    const t = new Date(nowMs + dayOffset * 86400000);
    const m2 = mskNow(t);
    for (const w of NEWS_WINDOWS) {
      const slot = mskToUtcMs(m2.dow, w.start, new Date(t));
      if (slot < nowMs) continue; // слот уже прошёл
      const used = await countInWindow(env, w, new Date(slot));
      if (used < w.cap) return slot;
    }
  }
  return nowMs + 3600 * 1000;
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
    pub_ts: cand.pub_ts || null,
    status: "dispatched",
  });
  return true;
}

// ---------- публикация ----------

export async function publishPackage(env, pkg, dry, target = "all") {
  if (target === "vk") return publishOne("vk");
  if (target === "tg") return publishOne("tg");
  return publishOne("all");

  async function publishOne(mode) {
    let tgOk = false;
    let vkOk = false;
    let tgErr = null;
    let vkErr = null;
    let vkPost = null;
    let vkAttach = null;
    if (mode !== "vk") {
      try {
        await publishToTelegram(env, pkg, dry);
        tgOk = true;
      } catch (e) {
        tgErr = e.message;
      }
    }
    if (mode !== "tg") {
      try {
        const vkr = await publishToVk(env, pkg, dry);
        vkOk = true;
        vkPost = (vkr && vkr.post_id) || null;
        vkAttach = (vkr && vkr.vk_attachment) || null;
      } catch (e) {
        vkErr = e.message;
      }
    }
    // Строгий пул VK/TG: авто-пост должен уйти в обе платформы. Если ушла
    // только одна — недостающую догоняем ретраями на следующих тиках, а в лог
    // пишем частичный статус (он же — источник правды по количеству постов).
    if (mode === "all" && tgOk !== vkOk && !dry) {
      await kv.addVkRetry(env, { ...pkg, attempts: 0 }, { missing: [tgOk ? "vk" : "tg"] });
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
      vk_post_id: vkPost,
      vk_attachment: vkAttach,
      tg_err: tgErr || null,
      vk_err: vkErr || null,
      target: mode,
    });
    return { tgOk, vkOk, vkPost };
  }
}

// Публикация текстового поста (ивенты без карточки).
export async function publishText(env, text, dry, kind, extra = {}) {
  let tgOk = false;
  let vkOk = false;
  let tgErr = null;
  let vkErr = null;
  if (dry) {
    console.log(`[dry-run] TG text -> ${env.TELEGRAM_CHANNEL_ID} (${text.length} симв.)`);
    tgOk = true;
  } else {
    try {
      await sendMessage(env, env.TELEGRAM_CHANNEL_ID, text, { parse_mode: "HTML" });
      tgOk = true;
    } catch (e) { tgErr = e.message; }
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
    } catch (e) { vkErr = e.message; }
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
    tg_err: tgErr,
    vk_err: vkErr,
  });
  return true;
}

// ---------- ретраи: догонка недостающей платформы (строгий пул VK/TG) ----------

// На каждом тике пробуем догрузить в недостающую платформу посты, которые не
// ушли с первой попытки (missing = ["vk"] | ["tg"]). Когда обе платформы
// опубликованы — обновляем существующую запись publish_log (одна запись на пост,
// со статусом обеих). Неудача -> возврат в очередь с ростом счётчика; превышение
// лимита или выход из окна свежести -> оставляем частичный статус в логе.
export async function processVkRetries(env) {
  const { MAX_VK_RETRY_ATTEMPTS } = await import("./limits.js");
  const retries = await kv.getVkRetry(env);
  if (!retries.length) return { processed: 0 };
  const state = await kv.loadState(env);
  const dry = !!state.dry_run;
  let processed = 0;
  const nowMs = Date.now();
  for (const item of retries) {
    if (item.attempts >= MAX_VK_RETRY_ATTEMPTS) {
      console.log(`[vk-retry] отказ после ${item.attempts} попыток: ${item.title || item.id}`);
      await kv.removeVkRetry(env, item.id);
      processed++;
      continue;
    }
    // новость протухла, пока ждала догонки — не публикуем
    if (isStaleItem(item, nowMs)) {
      console.log(`[vk-retry] протухла, удаляю: ${item.title || item.id}`);
      await kv.removeVkRetry(env, item.id);
      processed++;
      continue;
    }
    const missing = item.missing && item.missing.length ? item.missing : ["vk"];
    let allDone = true;
    let tgErr = null;
    let vkErr = null;
    let vkPost = null;
    let vkAttach = null;
    for (const plat of missing) {
      try {
        if (plat === "tg") {
          await publishToTelegram(env, item, dry);
        } else {
          const vkr = await publishToVk(env, item, dry);
          if (!vkr || !vkr.post_id) throw new Error("нет post_id после успешного upload");
          vkPost = vkr.post_id;
          vkAttach = vkr.vk_attachment || null;
        }
      } catch (e) {
        allDone = false;
        if (plat === "tg") tgErr = e.message; else vkErr = e.message;
        break;
      }
    }
    if (allDone) {
      await kv.removeVkRetry(env, item.id);
      await kv.updateLog(env, item.id, {
        tg_ok: true,
        vk_ok: true,
        tg_err: null,
        vk_err: null,
        vk_post_id: vkPost,
        vk_attachment: vkAttach,
      });
      processed++;
      console.log(`[vk-retry] опубликовано в обе платформы (попытка ${item.attempts}): ${item.title || item.id}`);
      const url = vkPostUrl(env, vkPost);
      if (!dry) {
        await notifyAdmin(
          env,
          `✅ <b>Догнано</b>: ${item.title || item.id}\n${pubStatus({ tgOk: true, vkOk: true })}${url ? ` · ${url}` : ""}`
        );
      }
    } else {
      console.log(`[vk-retry] попытка ${item.attempts} не удалась для «${item.title || item.id}»: ${tgErr || vkErr}`);
      await kv.removeVkRetry(env, item.id);
      await kv.addVkRetry(env, { ...item, attempts: item.attempts, missing });
      processed++;
    }
  }
  return { processed };
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
    // новость протухла, пока ждала ответа админа — черновик тихо удаляем
    if (isStaleItem(d, now.getTime())) {
      await kv.deleteDraft(env, d.id);
      continue;
    }
    // админ не ответил за 30 минут -> отложенный пост в ближайший свободный слот
    const slot = await nextFreeSlot(env, now);
    await kv.deleteDraft(env, d.id);
    await kv.addStock(env, {
      id: d.id,
      kind: "news",
      title: d.title || "",
      caption: d.caption || "",
      png_key: d.png_key || null,
      png: d.png ? (typeof d.png === "string" ? decodePng(d.png) : d.png) : null,
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

// ---------- публикация из склада по слотам ----------

async function publishDueStock(env, now = new Date()) {
  const stock = await kv.getStock(env);
  const nowMs = now.getTime();
  const state = await kv.loadState(env);
  const dry = !!state.dry_run;
  const due = stock.filter((p) => (p.scheduled_for || 0) <= nowMs);
  for (const pkg of due) {
    // новость протухла, пока ждала своего слота — выкидываем тихо
    if (pkg.kind === "news" && isStaleItem(pkg, nowMs)) {
      await kv.removeStock(env, pkg.id);
      continue;
    }
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
    // защита от дублей: если этот guid уже публиковался — пропускаем
    if (pkg.guid) {
      const log = await kv.getLog(env);
      if (log.some((e) => e.guid && e.guid === pkg.guid)) {
        await kv.removeStock(env, pkg.id);
        continue;
      }
    }
    // Свежая карточка в момент публикации: небо рисуется под реальное время
    // выхода поста (рендер-сервис считает МСК сам), а не под время генерации.
    if (!dry && pkg.kind === "news" && pkg.data) {
      try {
        const fresh = await renderCardBytes(env, pkg.data, {
          link: pkg.link || "",
          source: pkg.source || "",
        });
        if (fresh && fresh.length > 100) pkg.png = fresh;
      } catch (e) {
        console.log("[scheduler] re-render card failed, keep old:", e.message);
      }
    }
    await kv.removeStock(env, pkg.id);
    try {
      if (pkg.kind === "event") {
        // ивенты — текстовый пост без карточки (создаются админом в диалоге)
        const text = (pkg.caption || pkg.title || "").trim();
        if (!text) continue;
        const ok = await publishText(env, text, dry, "event", {
          id: pkg.id,
          title: pkg.title || "",
          guid: pkg.guid || "",
          link: pkg.link || "",
        });
        if (ok) {
          await notifyAdmin(env, `🎪 <b>Ивент опубликован</b>: ${pkg.title || ""}`);
        } else {
          await kv.addStock(env, { ...pkg, scheduled_for: now.getTime() + 15 * 60 * 1000 });
        }
        continue;
      }
      const res = await publishPackage(env, pkg, dry);
      if (!dry) {
        // Строгий пул: если ушла только одна платформа — недостающая догоняется
        // ретраями, пишем об этом админу.
        const url = vkPostUrl(env, res.vkPost);
        const line = url ? `${pubStatus(res)} · ${url}` : pubStatus(res);
        if (res.tgOk && res.vkOk) {
          await notifyAdmin(env, `✅ <b>Опубликовано</b>: ${pkg.title || ""}\n${line}`);
        } else if (res.tgOk || res.vkOk) {
          const missing = res.tgOk ? "VK" : "TG";
          await notifyAdmin(env, `⏳ <b>Частично опубликовано</b>: ${pkg.title || ""}\n${line}\n🔜 Догоняю ${missing} в ближайшие тики.`);
        }
      }
    } catch (e) {
      console.log("[scheduler] publish failed:", e.message);
      await notifyAdmin(env, `❌ <b>Не удалось опубликовать</b>: ${pkg.title || ""}\n${escHtml(e.message)}`);
      await kv.addStock(env, { ...pkg, scheduled_for: now.getTime() + 15 * 60 * 1000 });
    }
  }
}

// ---------- главный тик ----------

// Автопостинг целиком в воркере: генерим карточку из кандидата (LLM/правила)
// прямо здесь и кладём на склад в следующий свободный слот. Публикация идёт
// строго по расписанию из publishDueStock. GitHub для автопостинга не нужен.
async function autoGenerateStock(env, cands) {
  for (const c of cands) {
    // Новость успела протухнуть, пока ждала в очереди — не готовим.
    if (isStaleItem(c, Date.now())) continue;
    try {
      const slot = await nextFreeSlot(env);
      const { data, b64 } = await buildCardPackage(env, c.text || c.title, {
        link: c.link || "",
        source: sourceDomain(c.link || ""),
        guid: c.guid || "",
      });
      await kv.addStock(env, {
        id: `a${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
        kind: "news",
        title: data.headline,
        caption: data.caption,
        png: b64,
        data: {
          headline: data.headline,
          headline_lines: data.headline_lines || [data.headline],
          caption: data.caption,
          cards: data.cards || [],
          tier: data.tier || "news",
          source: data.source || sourceDomain(c.link || ""),
        },
        link: c.link || "",
        guid: c.guid || "",
        source: sourceDomain(c.link || ""),
        tags: [],
        scheduled_for: slot,
        created_at: new Date().toISOString(),
        from_admin: false,
      });
      console.log("[scheduler] autogen stock:", data.headline, "slot", new Date(slot).toISOString());
    } catch (e) {
      console.log("[scheduler] autogen stock error:", e.message);
      await kv.addCandidate(env, c);
    }
  }
}

export async function tick(env) {
  const now = new Date();

  // Анти-перекрытие крон: Cloudflare не ждёт завершения предыдущего запуска,
  // если крон раз в 5 минут «не успевает». Два параллельных тика читают одну и
  // ту же очередь и могут опубликовать один пост дважды — KV-лок не даёт им
  // бежать одновременно (TTL страхует от зависшего тика).
  try {
    if (env.BOT_KV) {
      const raw = await env.BOT_KV.get("scheduler_lock");
      let lock = null;
      try { lock = raw ? JSON.parse(raw) : null; } catch (e) { lock = null; }
      if (lock && Date.now() - lock.at < TICK_LOCK_TTL_MS) {
        return "busy";
      }
      await env.BOT_KV.put("scheduler_lock", JSON.stringify({ at: Date.now() }), {
        expirationTtl: Math.floor(TICK_LOCK_TTL_MS / 1000),
      });
    }
  } catch (e) {
    console.log("[scheduler] lock error:", e.message);
  }

  const state = await kv.loadState(env);

  // 1. скан (часть лент) + дедуп + кандидаты в очередь
  const offset = state.meta.scan_chunk || 0;
  try {
    await scanFeeds(env, offset, CHUNK_COUNT);
  } catch (e) {
    console.log("[scheduler] scan error:", e.message);
  }
  state.meta.scan_chunk = (offset + 1) % CHUNK_COUNT;

  // 2. пополнение склада: автопостинг в воркере или диспатч на GitHub
  try {
    const nowMs = Date.now();
    // выкидываем протухшие кандидаты, чтобы они не публиковались позже
    const candList = await kv.getCandidates(env);
    const freshCands = candList.filter((c) => !isStaleItem(c, nowMs));
    if (freshCands.length !== candList.length) await kv.setCandidates(env, freshCands);
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
      if (await kv.getAutopost(env)) {
        // автопостинг целиком в воркере: карточка -> склад в строгий слот
        await autoGenerateStock(env, cands);
      } else {
        for (const c of cands) {
          // Новость успела протухнуть, пока ждала в очереди — не отдаём на подготовку.
          if (isStaleItem(c, Date.now())) continue;
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
    }
  } catch (e) {
    console.log("[scheduler] dispatch error:", e.message);
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

  // 6b. догонка недостающей платформы (строгий пул VK/TG)

  await kv.saveState(env, state);
  return "ok";
}
