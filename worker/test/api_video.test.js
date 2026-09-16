// Модульные тесты Video Factory API: /api/video {create,status,cancel,retry,callback(HMAC)}.
// Запуск: node --test worker/test/api_video.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeKV, makeEnv, installFetchMock } from "./scheduler.test.js";
import * as crypto from "node:crypto";

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withVfEnv(extra = {}) {
  const env = makeEnv();
  env.JOB_CALLBACK_SECRET = "cbsecret";
  env.WEBHOOK_SECRET = "secret";
  env.BOT_AUTH = "secret";
  return { ...env, ...extra };
}

async function importApi() {
  return import("file:///C:/Users/user/Desktop/tgvk_bot/worker/api_video.js");
}

// ------------------- POST /api/video -------------------

test("POST /api/video создаёт job и диспатчит video-render.yml", async () => {
  const api = await importApi();
  const calls = installFetchMock();
  const env = withVfEnv();
  const req = new Request("https://example.workers.dev/api/video", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: "Хакеры атакуют банки", preset: "trustnode_news" }),
  });
  const res = await api.handleVideoApi(env, req, new URL(req.url));
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.jobId.startsWith("vj_"), `jobId=${body.jobId}`);
  assert.equal(body.status, "queued");
  // был диспатч video-render.yml
  const dispatch = calls.github.find((c) => c.url.includes("/actions/workflows/video-render.yml/dispatches"));
  assert.ok(dispatch, "диспатч video-render.yml был сделан");
  const dispatchBody = JSON.parse(dispatch.opts.body);
  assert.equal(dispatchBody.ref, "main");
  assert.equal(dispatchBody.inputs.job_id, body.jobId);
  // job сохранён в KV
  const job = await env.BOT_KV.get("vf:job:" + body.jobId, "json");
  assert.ok(job, "job в KV");
  assert.equal(job.status, "queued");
  assert.equal(job.topic, "Хакеры атакуют банки");
});

test("POST /api/video без topic — 400", async () => {
  const api = await importApi();
  const env = withVfEnv();
  const req = new Request("https://example.workers.dev/api/video", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preset: "trustnode_news" }),
  });
  const res = await api.handleVideoApi(env, req, new URL(req.url));
  assert.equal(res.status, 400);
});

test("POST /api/video: сбой диспатча → job failed + 502", async () => {
  const api = await importApi();
  const calls = installFetchMock(500); // GitHub вернёт 500
  const env = withVfEnv();
  const req = new Request("https://example.workers.dev/api/video", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic: "Тест" }),
  });
  const res = await api.handleVideoApi(env, req, new URL(req.url));
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.includes("dispatch failed"), true);
  const job = await env.BOT_KV.get("vf:job:" + body.jobId, "json");
  assert.equal(job.status, "failed");
  assert.equal(job.error.code, "DISPATCH_FAILED");
  assert.equal(job.error.retryable, true);
});

// ------------------- GET /api/video/:id -------------------

test("GET /api/video/:id требует X-Bot-Auth, отдаёт job", async () => {
  const api = await importApi();
  const env = withVfEnv();
  // создадим job напрямую в KV
  await env.BOT_KV.put(
    "vf:job:vj_test1",
    JSON.stringify({ jobId: "vj_test1", topic: "T", status: "queued", progress: 0, stage: "init", payload: { topic: "T" }, createdAt: 1, updatedAt: 1 })
  );
  // без авторизации — 403
  const noAuth = new Request("https://example.workers.dev/api/video/vj_test1");
  const r1 = await api.handleVideoApi(env, noAuth, new URL(noAuth.url));
  assert.equal(r1.status, 403);
  // с авторизацией — job
  const auth = new Request("https://example.workers.dev/api/video/vj_test1", {
    headers: { "X-Bot-Auth": "secret" },
  });
  const r2 = await api.handleVideoApi(env, auth, new URL(auth.url));
  assert.equal(r2.status, 200);
  const job = await r2.json();
  assert.equal(job.jobId, "vj_test1");
});

test("GET /api/video/:id/status отдаёт прогресс (без авторизации)", async () => {
  const api = await importApi();
  const env = withVfEnv();
  await env.BOT_KV.put(
    "vf:job:vj_test2",
    JSON.stringify({ jobId: "vj_test2", topic: "T2", status: "running", progress: 42, stage: "tts", error: null, output: null, createdAt: 1, updatedAt: 1 })
  );
  const req = new Request("https://example.workers.dev/api/video/vj_test2/status");
  const res = await api.handleVideoApi(env, req, new URL(req.url));
  assert.equal(res.status, 200);
  const s = await res.json();
  assert.equal(s.status, "running");
  assert.equal(s.progress, 42);
  assert.equal(s.stage, "tts");
});

test("GET /api/video/:id — job не найден → 404", async () => {
  const api = await importApi();
  const env = withVfEnv();
  const req = new Request("https://example.workers.dev/api/video/vj_missing");
  const res = await api.handleVideoApi(env, req, new URL(req.url));
  assert.equal(res.status, 404);
});

// ------------------- POST /api/video/:id/cancel -------------------

test("POST /cancel: running → cancelled", async () => {
  const api = await importApi();
  const env = withVfEnv();
  await env.BOT_KV.put(
    "vf:job:vj_c1",
    JSON.stringify({ jobId: "vj_c1", topic: "T", status: "running", progress: 50, stage: "render", createdAt: 1, updatedAt: 1 })
  );
  const req = new Request("https://example.workers.dev/api/video/vj_c1/cancel", { method: "POST" });
  const res = await api.handleVideoApi(env, req, new URL(req.url));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "cancelled");
  const job = await env.BOT_KV.get("vf:job:vj_c1", "json");
  assert.equal(job.status, "cancelled");
});

test("POST /cancel completed → 409", async () => {
  const api = await importApi();
  const env = withVfEnv();
  await env.BOT_KV.put(
    "vf:job:vj_c2",
    JSON.stringify({ jobId: "vj_c2", topic: "T", status: "completed", progress: 100, createdAt: 1, updatedAt: 1 })
  );
  const req = new Request("https://example.workers.dev/api/video/vj_c2/cancel", { method: "POST" });
  const res = await api.handleVideoApi(env, req, new URL(req.url));
  assert.equal(res.status, 409);
});

// ------------------- POST /api/video/:id/retry -------------------

test("POST /retry failed → queued + повторный диспатч", async () => {
  const api = await importApi();
  const calls = installFetchMock();
  const env = withVfEnv();
  await env.BOT_KV.put(
    "vf:job:vj_r1",
    JSON.stringify({ jobId: "vj_r1", topic: "T", status: "failed", progress: 30, stage: "render", error: { code: "X", message: "boom" }, retries: 1, createdAt: 1, updatedAt: 1 })
  );
  const req = new Request("https://example.workers.dev/api/video/vj_r1/retry", {
    method: "POST",
    headers: { "X-Bot-Auth": "secret" },
  });
  const res = await api.handleVideoApi(env, req, new URL(req.url));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "queued");
  const job = await env.BOT_KV.get("vf:job:vj_r1", "json");
  assert.equal(job.status, "queued");
  assert.equal(job.retries, 2);
  assert.equal(job.error, null);
  const dispatch = calls.github.find((c) => c.url.includes("/video-render.yml/dispatches"));
  assert.ok(dispatch, "повторный диспатч");
});

test("POST /retry running → 409", async () => {
  const api = await importApi();
  const env = withVfEnv();
  await env.BOT_KV.put(
    "vf:job:vj_r2",
    JSON.stringify({ jobId: "vj_r2", topic: "T", status: "running", progress: 10, createdAt: 1, updatedAt: 1 })
  );
  const req = new Request("https://example.workers.dev/api/video/vj_r2/retry", {
    method: "POST",
    headers: { "X-Bot-Auth": "secret" },
  });
  const res = await api.handleVideoApi(env, req, new URL(req.url));
  assert.equal(res.status, 409);
});

// ------------------- POST /api/video/callback (HMAC) -------------------

function hmac(secret, ts, body) {
  return crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
}

async function cbRequest(secret, payload, { ts = Math.floor(Date.now() / 1000), sign = true } = {}) {
  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  if (sign) {
    headers["X-VF-Timestamp"] = String(ts);
    headers["X-VF-Signature"] = hmac(secret, ts, body);
  }
  return new Request("https://example.workers.dev/api/video/callback", { method: "POST", headers, body });
}

test("callback completed: HMAC валиден, job обновляется, progress=100, output сохранён", async () => {
  const api = await importApi();
  const env = withVfEnv();
  await env.BOT_KV.put(
    "vf:job:vj_cb1",
    JSON.stringify({ jobId: "vj_cb1", topic: "T", status: "running", progress: 60, stage: "upload", createdAt: 1, updatedAt: 1 })
  );
  const ts = Math.floor(Date.now() / 1000);
  const payload = { job_id: "vj_cb1", status: "completed", stage: "done", progress: 100, output: { url: "file:///tmp/v.mp4", provider: "local", key: "vj_cb1.mp4" } };
  const req = await cbRequest("cbsecret", payload, { ts });
  const res = await api.handleVideoApi(env, req, new URL(req.url));
  assert.equal(res.status, 200);
  const job = await env.BOT_KV.get("vf:job:vj_cb1", "json");
  assert.equal(job.status, "completed");
  assert.equal(job.progress, 100);
  assert.equal(job.output.url, "file:///tmp/v.mp4");
});

test("callback: плохая подпись → 401", async () => {
  const api = await importApi();
  const env = withVfEnv();
  await env.BOT_KV.put(
    "vf:job:vj_cb2",
    JSON.stringify({ jobId: "vj_cb2", topic: "T", status: "running", createdAt: 1, updatedAt: 1 })
  );
  const ts = Math.floor(Date.now() / 1000);
  const payload = { job_id: "vj_cb2", status: "failed", error: "boom" };
  const req = await cbRequest("WRONG_SECRET", payload, { ts });
  const res = await api.handleVideoApi(env, req, new URL(req.url));
  assert.equal(res.status, 401);
  const job = await env.BOT_KV.get("vf:job:vj_cb2", "json");
  assert.equal(job.status, "running", "job не тронут");
});

test("callback: устаревший timestamp (replay) → 401", async () => {
  const api = await importApi();
  const env = withVfEnv();
  await env.BOT_KV.put(
    "vf:job:vj_cb3",
    JSON.stringify({ jobId: "vj_cb3", topic: "T", status: "running", createdAt: 1, updatedAt: 1 })
  );
  const oldTs = Math.floor(Date.now() / 1000) - 600; // 10 минут назад > 300s window
  const payload = { job_id: "vj_cb3", status: "completed" };
  const req = await cbRequest("cbsecret", payload, { ts: oldTs });
  const res = await api.handleVideoApi(env, req, new URL(req.url));
  assert.equal(res.status, 401);
});

test("callback: повторный completed (replay) → 409", async () => {
  const api = await importApi();
  const env = withVfEnv();
  await env.BOT_KV.put(
    "vf:job:vj_cb4",
    JSON.stringify({ jobId: "vj_cb4", topic: "T", status: "completed", progress: 100, createdAt: 1, updatedAt: 1 })
  );
  const ts = Math.floor(Date.now() / 1000);
  const payload = { job_id: "vj_cb4", status: "completed" };
  const req = await cbRequest("cbsecret", payload, { ts });
  const res = await api.handleVideoApi(env, req, new URL(req.url));
  assert.equal(res.status, 409);
});

test("callback failed: error нормализуется в объект", async () => {
  const api = await importApi();
  const env = withVfEnv();
  await env.BOT_KV.put(
    "vf:job:vj_cb5",
    JSON.stringify({ jobId: "vj_cb5", topic: "T", status: "running", progress: 70, stage: "render", createdAt: 1, updatedAt: 1 })
  );
  const ts = Math.floor(Date.now() / 1000);
  const payload = { job_id: "vj_cb5", status: "failed", stage: "render", error: "ffmpeg crashed" };
  const req = await cbRequest("cbsecret", payload, { ts });
  const res = await api.handleVideoApi(env, req, new URL(req.url));
  assert.equal(res.status, 200);
  const job = await env.BOT_KV.get("vf:job:vj_cb5", "json");
  assert.equal(job.status, "failed");
  assert.equal(job.error.message, "ffmpeg crashed");
  assert.equal(job.error.stage, "render");
});

test("callback с прогресс-апдейтом (running) обновляет stage/progress", async () => {
  const api = await importApi();
  const env = withVfEnv();
  await env.BOT_KV.put(
    "vf:job:vj_cb6",
    JSON.stringify({ jobId: "vj_cb6", topic: "T", status: "queued", progress: 0, stage: "init", createdAt: 1, updatedAt: 1 })
  );
  const ts = Math.floor(Date.now() / 1000);
  const payload = { job_id: "vj_cb6", status: "running", stage: "assets", progress: 45 };
  const req = await cbRequest("cbsecret", payload, { ts });
  const res = await api.handleVideoApi(env, req, new URL(req.url));
  assert.equal(res.status, 200);
  const job = await env.BOT_KV.get("vf:job:vj_cb6", "json");
  assert.equal(job.status, "running");
  assert.equal(job.stage, "assets");
  assert.equal(job.progress, 45);
});

// ------------------- вспомогательные ответы -------------------

test("/api/video неизвестный action на существующем job → 405", async () => {
  const api = await importApi();
  const env = withVfEnv();
  await env.BOT_KV.put(
    "vf:job:vj_x",
    JSON.stringify({ jobId: "vj_x", topic: "T", status: "queued", createdAt: 1, updatedAt: 1 })
  );
  const req = new Request("https://example.workers.dev/api/video/vj_x/bogus");
  const res = await api.handleVideoApi(env, req, new URL(req.url));
  assert.equal(res.status, 405);
});