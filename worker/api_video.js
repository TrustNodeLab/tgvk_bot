// Video Factory — job orchestration API for Cloudflare Worker.
//
// The Worker is the API/orchestrator ONLY: it stores jobs in KV, dispatches
// GitHub Actions workflows (which do the heavy rendering), and receives
// protected callbacks. It NEVER renders video itself.
//
// KV layout:
//   vf:job:<id>          — job JSON (single source of truth)
//   vf:jobs              — JSON array of job ids (index, capped)
//   vf:idx:<id>:<field>  — optional small lookups (not used yet)
//
// Endpoints:
//   POST /api/video                {topic, preset?}            -> {jobId}
//   GET  /api/video/<id>           authorized (X-Bot-Auth)     -> job
//   GET  /api/video/<id>/status                               -> {id,status,progress,stage,error,output}
//   POST /api/video/<id>/cancel                               -> {ok}
//   POST /api/video/<id>/retry                                -> {ok}
//   POST /api/video/callback      HMAC-protected              -> {ok}
//
// Job statuses: queued -> running -> completed | failed | cancelled
// Progress: 0-100 (mapped to stages by the renderer)

const JOB_PREFIX = "vf:job:";
const JOB_INDEX = "vf:jobs";
const JOB_INDEX_MAX = 200;
const MAX_TOPIC_LEN = 200;

// ---------------------------------------------------------------------------
// KV helpers

async function kvGet(env, key) {
  try {
    return await env.BOT_KV.get(key, "json");
  } catch {
    return null;
  }
}

async function kvSet(env, key, value) {
  await env.BOT_KV.put(key, JSON.stringify(value), { expirationTtl: 60 * 60 * 24 * 7 });
}

async function kvDelete(env, key) {
  await env.BOT_KV.delete(key);
}

async function indexPush(env, id) {
  let list = (await kvGet(env, JOB_INDEX)) || [];
  if (!Array.isArray(list)) list = [];
  list = list.filter((x) => x !== id);
  list.push(id);
  if (list.length > JOB_INDEX_MAX) list = list.slice(list.length - JOB_INDEX_MAX);
  await kvSet(env, JOB_INDEX, list);
}

// ---------------------------------------------------------------------------
// GitHub dispatch (same pattern as scheduler.js dispatchVideoLong)

async function dispatchRender(env, jobId) {
  const token = env.GITHUB_TOKEN;
  const owner = env.OWNER || "TrustNodeLab";
  const repo = env.REPO || "tgvk_bot";
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/video-render.yml/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "tgvk-bot-webhook",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs: { job_id: jobId } }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`dispatch failed: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// HMAC callback verification (replay protection)

async function verifyCallback(env, request) {
  const secret = env.JOB_CALLBACK_SECRET;
  if (!secret) return { ok: false, reason: "callback secret not configured" };
  const ts = Number(request.headers.get("X-VF-Timestamp") || "0");
  const sig = request.headers.get("X-VF-Signature") || "";
  const body = await request.clone().text();
  if (!ts || Number.isNaN(ts)) return { ok: false, reason: "bad timestamp" };
  const maxAge = Number(env.JOB_CALLBACK_MAX_AGE || env.CALLBACK_MAX_AGE || 300);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > maxAge) return { ok: false, reason: "timestamp expired (replay?)" };
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${body}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== sig) return { ok: false, reason: "bad signature" };
  return { ok: true, body };
}

// ---------------------------------------------------------------------------
// Router

export async function handleVideoApi(env, request, url) {
  const path = url.pathname;
  if (!path.startsWith("/api/video")) return null;

  const method = request.method;

  // POST /api/video — create job
  if (method === "POST" && path === "/api/video") {
    return createJob(env, request);
  }

  // POST /api/video/callback — renderer reports progress/finish
  if (method === "POST" && path === "/api/video/callback") {
    return handleCallback(env, request);
  }

  // /api/video/<id>[/status|/cancel|/retry]
  const m = path.match(/^\/api\/video\/([^/]+)(\/[^/]+)?$/);
  if (!m) return jsonResponse({ error: "not found" }, 404);
  const jobId = decodeURIComponent(m[1]);
  const action = m[2] || "";
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(jobId)) return jsonResponse({ error: "bad job id" }, 400);

  const job = await kvGet(env, JOB_PREFIX + jobId);
  if (!job) return jsonResponse({ error: "job not found" }, 404);

  if (method === "GET" && action === "") {
    // Payload fetch by GitHub Actions (authorized) — full job incl. payload
    if (!apiAuthorized(env, request)) return jsonResponse({ error: "unauthorized" }, 403);
    return jsonResponse(job);
  }

  if (method === "GET" && action === "/status") {
    return jsonResponse({
      id: job.jobId,
      topic: job.topic,
      status: job.status,
      progress: job.progress ?? 0,
      stage: job.stage || null,
      error: job.error || null,
      output: job.output || null,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
    });
  }

  if (method === "POST" && action === "/cancel") {
    if (job.status === "completed" || job.status === "cancelled") {
      return jsonResponse({ ok: false, error: `cannot cancel ${job.status}` }, 409);
    }
    job.status = "cancelled";
    job.cancelledAt = Date.now();
    job.updatedAt = Date.now();
    await kvSet(env, JOB_PREFIX + jobId, job);
    return jsonResponse({ ok: true, id: jobId, status: "cancelled" });
  }

  if (method === "POST" && action === "/retry") {
    if (!apiAuthorized(env, request)) return jsonResponse({ error: "unauthorized" }, 403);
    if (job.status !== "failed" && job.status !== "cancelled") {
      return jsonResponse({ ok: false, error: `cannot retry ${job.status}` }, 409);
    }
    job.status = "queued";
    job.progress = 0;
    job.stage = "init";
    job.error = null;
    job.retries = (job.retries || 0) + 1;
    job.updatedAt = Date.now();
    job.createdAt = Date.now();
    await kvSet(env, JOB_PREFIX + jobId, job);
    try {
      await dispatchRender(env, jobId);
    } catch (e) {
      job.status = "failed";
      job.error = { code: "DISPATCH_FAILED", stage: "init", message: e.message, retryable: true };
      await kvSet(env, JOB_PREFIX + jobId, job);
      return jsonResponse({ ok: false, error: e.message }, 502);
    }
    return jsonResponse({ ok: true, id: jobId, status: "queued" });
  }

  return jsonResponse({ error: "method not allowed" }, 405);
}

// ---------------------------------------------------------------------------
// Create job

export async function createJob(env, requestOrPayload, isRequest = true) {
  let payload;
  if (isRequest) {
    try {
      payload = await requestOrPayload.json();
    } catch {
      return jsonResponse({ error: "bad JSON body" }, 400);
    }
  } else {
    payload = requestOrPayload;
  }
  const topic = String(payload.topic || "").trim().slice(0, MAX_TOPIC_LEN);
  if (!topic) return jsonResponse({ error: "topic is required" }, 400);
  const chatId = String(payload.chat_id || "").slice(0, 40);

  const jobId = `vj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    jobId,
    topic,
    preset: String(payload.preset || "trustnode_news").slice(0, 60),
    status: "queued",
    progress: 0,
    stage: "init",
    chat_id: chatId,
    payload: {
      topic,
      preset: String(payload.preset || "trustnode_news").slice(0, 60),
      chat_id: chatId,
    },
    error: null,
    output: null,
    retries: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await kvSet(env, JOB_PREFIX + jobId, job);
  await indexPush(env, jobId);

  try {
    await dispatchRender(env, jobId);
  } catch (e) {
    job.status = "failed";
    job.error = { code: "DISPATCH_FAILED", stage: "init", message: e.message, retryable: true };
    await kvSet(env, JOB_PREFIX + jobId, job);
    if (isRequest) return jsonResponse({ ok: false, jobId, error: e.message }, 502);
    throw e;
  }
  if (isRequest) return jsonResponse({ ok: true, jobId, status: "queued" }, 201);
  return job;
}

// ---------------------------------------------------------------------------
// Callback handler

async function handleCallback(env, request) {
  const check = await verifyCallback(env, request);
  if (!check.ok) return jsonResponse({ error: check.reason }, 401);

  let body;
  try {
    body = JSON.parse(check.body);
  } catch {
    return jsonResponse({ error: "bad JSON" }, 400);
  }
  const jobId = String(body.job_id || "").trim();
  if (!jobId || !/^[A-Za-z0-9_-]{1,80}$/.test(jobId)) return jsonResponse({ error: "bad job id" }, 400);

  const job = await kvGet(env, JOB_PREFIX + jobId);
  if (!job) return jsonResponse({ error: "job not found" }, 404);

  // Replay protection: reject updates for terminal jobs or older-than-current
  const now = Date.now();
  if (job.status === "completed" || job.status === "cancelled") {
    return jsonResponse({ ok: false, error: `job already ${job.status}` }, 409);
  }
  if (body.ts && job.updatedAt > body.ts) {
    return jsonResponse({ ok: false, error: "stale update" }, 409);
  }

  const status = String(body.status || "running");
  job.status = status;
  job.stage = String(body.stage || job.stage || "running");
  if (typeof body.progress === "number") job.progress = Math.max(0, Math.min(100, body.progress));
  if (status === "failed" && body.error) {
    job.error = typeof body.error === "string" ? { code: "RENDER_FAILED", stage: job.stage, message: body.error, retryable: true } : body.error;
  }
  if (status === "completed" && body.output) {
    job.output = body.output;
    job.progress = 100;
  }
  job.updatedAt = now;
  await kvSet(env, JOB_PREFIX + jobId, job);

  // Notify admin when finished/failed (best effort)
  if (status === "completed" || status === "failed") {
    try {
      await notifyAdmin(env, job);
    } catch (e) {
      console.log("[vf] admin notify failed:", e.message);
    }
  }

  // Deliver finished video to the requesting user chat (best effort)
  if (status === "completed") {
    try {
      await deliverVideoToUser(env, job);
    } catch (e) {
      console.log("[vf] user delivery failed:", e.message);
    }
  }
  return jsonResponse({ ok: true, id: jobId, status });
}

// ---------------------------------------------------------------------------
// Deliver finished video to the user who requested it (via /files endpoint)

async function deliverVideoToUser(env, job) {
  const chatId = job.chat_id || (job.payload && job.payload.chat_id) || "";
  if (!chatId) return;
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const out = job.output || {};
  if (!out.url && !out.key) return;
  if (job.delivered) return;

  // Fetch the MP4 from our own /files endpoint (R2 or KV fallback).
  const rawKey = out.key ? String(out.key) : String(out.url || "").split("/files/")[1] || "";
  const fileKey = rawKey.replace(/^files\//, "");
  if (!fileKey) return;
  const base = env.BOT_PUBLIC_URL || "";
  const auth = env.BOT_AUTH || env.WEBHOOK_SECRET || "";
  const res = await fetch(`${base}/files/${fileKey}`, {
    headers: { "X-Bot-Auth": auth },
  });
  if (!res.ok) throw new Error(`files fetch ${res.status}`);
  const buf = await res.arrayBuffer();

  // Telegram multipart upload via sendVideo
  const boundary = `vf${Date.now().toString(36)}`;
  const parts = [];
  const captionLines = [
    `🎬 <b>${escapeHtml(String(job.topic || "").slice(0, 200))}</b>`,
  ];
  if (out.edl_url || out.edl_key) {
    captionLines.push(`Монтажный лист: ${out.edl_url || (base + "/files/" + out.edl_key)}`);
  }
  captionLines.push(`<code>${job.jobId}</code>`);
  const caption = captionLines.join("\n").slice(0, 1000);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML`);
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}`);
  const videoName = `video_${job.jobId}.mp4`;
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="video"; filename="${videoName}"\r\nContent-Type: video/mp4\r\n\r\n`);
  const bodyParts = parts.map((p) => p + "\r\n");
  const head = bodyParts.join("");
  const tail = `--${boundary}--\r\n`;
  const body = new Uint8Array(head.length * 2 + buf.byteLength + tail.length * 2);
  const te = new TextEncoder();
  let off = 0;
  const write = (s) => {
    const enc = te.encode(s);
    body.set(enc, off);
    off += enc.length;
  };
  write(head);
  body.set(new Uint8Array(buf), off);
  off += buf.byteLength;
  write(tail);

  const tg = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
    body: body.slice(0, off),
  });
  if (!tg.ok) {
    const t = await tg.text().catch(() => "");
    throw new Error(`telegram sendVideo ${tg.status}: ${t.slice(0, 200)}`);
  }
  job.delivered = true;
  job.updatedAt = Date.now();
  await kvSet(env, JOB_PREFIX + job.jobId, job);
}

// ---------------------------------------------------------------------------
// Admin Telegram notification

async function notifyAdmin(env, job) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chatId) return;
  const emoji = job.status === "completed" ? "✅" : "❌";
  let text = `${emoji} <b>Video Factory: ${job.status === "completed" ? "готово" : "сбой"}</b>\n`;
  text += `<b>Тема:</b> ${escapeHtml(String(job.topic || "").slice(0, 150))}\n`;
  text += `<b>Job:</b> <code>${job.jobId}</code>\n`;
  text += `<b>Прогресс:</b> ${job.progress}%\n`;
  if (job.output && job.output.url) text += `<b>Файл:</b> ${job.output.url}\n`;
  if (job.error) text += `<b>Ошибка:</b> ${escapeHtml(String(job.error.message || job.error.code || "").slice(0, 200))}\n`;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------

function apiAuthorized(env, request) {
  const header = request.headers.get("X-Bot-Auth") || "";
  return header === (env.BOT_AUTH || env.WEBHOOK_SECRET || "");
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// Export helpers for tests
export const _internal = { kvGet, kvSet, kvDelete, indexPush, dispatchRender, verifyCallback, jsonResponse, apiAuthorized };