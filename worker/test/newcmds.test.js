// Модульные тесты новых команд Worker: /ping, /history, /dev, /video.
// Запуск: node --test worker/test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeKV, makeEnv, installFetchMock } from "./scheduler.test.js";

function jsonResp(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function tgText(c) {
  return typeof c.body === "string" ? c.body : JSON.stringify(c.body || {});
}

// Webhook-запрос к воркеру.
async function webhook(worker, env, text, messageId = 100) {
  const req = new Request("https://example.workers.dev/", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": "secret" },
    body: JSON.stringify({
      update_id: messageId,
      message: { message_id: messageId, chat: { id: 1 }, from: { id: 1 }, text },
    }),
  });
  await worker.fetch(req, env, { waitUntil() {} });
  await new Promise((r) => setTimeout(r, 50));
}

// ---------- /ping ----------

test("/ping отвечает pong", async () => {
  const { default: worker } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/worker.js");
  const calls = installFetchMock();
  const env = makeEnv();
  await webhook(worker, env, "/ping");
  assert.ok(
    calls.tg.some((c) => c.url.includes("/sendMessage") && tgText(c).includes("pong")),
    "админу ушёл pong"
  );
});

// ---------- /history ----------

test("/history показывает последние публикации из KV", async () => {
  const { default: worker } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/worker.js");
  const calls = installFetchMock();
  const env = makeEnv();
  const kv = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/kv.js");
  await kv.addLog(env, { id: "a1", kind: "news", title: "Первый пост", published_at: "2026-09-14T08:00:00Z", tg_ok: true, vk_ok: true });
  await kv.addLog(env, { id: "a2", kind: "digest", title: "Второй пост", published_at: "2026-09-15T08:00:00Z", tg_ok: true, vk_ok: false });
  await webhook(worker, env, "/history");
  const send = calls.tg.find((c) => c.url.includes("/sendMessage") && tgText(c).includes("История публикаций"));
  assert.ok(send, "админу ушла история");
  const text = tgText(send);
  assert.ok(text.includes("Второй пост"), "последний пост наверху");
  assert.ok(text.includes("Первый пост"), "оба поста видны");
});

// ---------- /dev ----------

test("/dev без текста — подсказка по формату", async () => {
  const { default: worker } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/worker.js");
  const calls = installFetchMock();
  const env = makeEnv();
  await webhook(worker, env, "/dev");
  assert.ok(
    calls.tg.some((c) => c.url.includes("/sendMessage") && tgText(c).includes("/dev &lt;текст&gt;")),
    "админу ушла подсказка по формату"
  );
  assert.equal(
    calls.github.filter((c) => c.url.includes("/contents/bot/inbox.json")).length, 0,
    "без текста GitHub не трогаем"
  );
});

test("/dev с текстом дописывает в bot/inbox.json (from_user)", async () => {
  const { default: worker } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/worker.js");
  const calls = installFetchMock();
  const env = makeEnv();
  // Мок contents/inbox.json: GET возвращает существующий файл, PUT — успех.
  const inbox = { from_user: [{ ts: "2026-09-01T00:00:00Z", chat_id: "1", text: "старое" }] };
  const existing = Buffer.from(JSON.stringify(inbox)).toString("base64");
  calls.github.push({ url: "mock", opts: {} }); // маркер, чтобы фильтр ниже не путался
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      calls.tg.push({ url: u, body: opts.body });
      return jsonResp({ ok: true, result: { message_id: 1 } });
    }
    if (u.includes("api.github.com") && u.includes("/contents/bot/inbox.json")) {
      if ((opts.method || "GET") === "PUT") {
        calls.github.push({ url: u, opts });
        return new Response(null, { status: 200 });
      }
      calls.github.push({ url: u, opts });
      return jsonResp({ content: existing, sha: "abc123" });
    }
    calls.feeds && calls.feeds.push(u);
    return new Response("<rss><channel></channel></rss>", { status: 200, headers: { "Content-Type": "application/xml" } });
  };
  await webhook(worker, env, "/dev добавь кнопку «Архив»");
  globalThis.fetch = origFetch;
  const put = calls.github.find((c) => c.url.includes("/contents/bot/inbox.json") && c.opts.method === "PUT");
  assert.ok(put, "PUT в inbox.json выполнен");
  const body = JSON.parse(put.opts.body || "{}");
  assert.equal(body.sha, "abc123", "sha проброшен в PUT");
  const updated = JSON.parse(Buffer.from(body.content, "base64").toString("utf-8"));
  assert.equal(updated.from_user.length, 2, "сообщение добавлено в from_user");
  assert.ok(updated.from_user[1].text.includes("Архив"), "текст сообщения сохранён");
  assert.ok(
    calls.tg.some((c) => c.url.includes("/sendMessage") && tgText(c).includes("Передано разработчику")),
    "админу подтверждение"
  );
});

// ---------- /video ----------

// Фиды с реальными новостями -> дайджест -> dispatch video-long.yml.
function feedRss(items) {
  const xml = items.map((it) =>
    `<item><title>${it.title}</title><link>${it.link}</link><description>${it.desc || ""}</description><pubDate>${it.pub}</pubDate><guid>${it.guid}</guid></item>`
  ).join("");
  return `<rss version="2.0"><channel>${xml}</channel></rss>`;
}

test("/video собирает новости из лент и запускает Video Factory (video-render.yml)", async () => {
  const { default: worker } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/worker.js");
  const calls = { tg: [], github: [], feeds: [] };
  const now = new Date().toUTCString();
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      calls.tg.push({ url: u, body: opts.body });
      return jsonResp({ ok: true, result: { message_id: 1 } });
    }
    if (u.includes("api.github.com")) {
      calls.github.push({ url: u, opts });
      if (u.includes("/actions/workflows/video-render.yml/dispatches")) {
        return new Response(null, { status: 204 });
      }
      return jsonResp({});
    }
    // RSS-фиды -> две новости
    calls.feeds.push(u);
    if (u.includes("playground.ru")) {
      return new Response(feedRss([
        { title: "Хакеры атакуют банки через фишинг", link: "https://playground.ru/news/1", desc: "Детали атаки на банки через фишинговые письма и SMS.", pub: now, guid: "p1" },
        { title: "Новая уязвимость в мессенджерах", link: "https://playground.ru/news/2", desc: "Исследователи нашли дыру в популярных мессенджерах.", pub: now, guid: "p2" },
      ]), { status: 200, headers: { "Content-Type": "application/xml" } });
    }
    return new Response("<rss><channel></channel></rss>", { status: 200, headers: { "Content-Type": "application/xml" } });
  };
  const env = makeEnv();
  await webhook(worker, env, "/video");
  const disp = calls.github.filter((c) => c.url.includes("/actions/workflows/video-render.yml/dispatches"));
  assert.equal(disp.length, 1, "video-render.yml диспатчен");
  const payload = JSON.parse(disp[0].opts.body || "{}");
  assert.equal(payload.inputs.job_id, payload.inputs.job_id, "передаётся job_id");
  assert.ok(payload.inputs.job_id.startsWith("vj_"), "job_id в формате vj_*");
  assert.ok(
    calls.tg.some((c) => c.url.includes("/sendMessage") && tgText(c).includes("Видео-дайджест запущен")),
    "админу подтверждение запуска"
  );
});

test("/video без свежих новостей — вежливое сообщение, без dispatch", async () => {
  const { default: worker } = await import("file:///C:/Users/user/Desktop/tgvk_bot/worker/worker.js");
  const calls = { tg: [], github: [], feeds: [] };
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("api.telegram.org")) {
      calls.tg.push({ url: u, body: opts.body });
      return jsonResp({ ok: true, result: { message_id: 1 } });
    }
    if (u.includes("api.github.com")) {
      calls.github.push({ url: u, opts });
      return jsonResp({});
    }
    calls.feeds.push(u);
    return new Response("<rss><channel></channel></rss>", { status: 200, headers: { "Content-Type": "application/xml" } });
  };
  const env = makeEnv();
  await webhook(worker, env, "/video");
  assert.equal(
    calls.github.filter((c) => c.url.includes("/dispatches")).length, 0,
    "без новостей dispatch не вызывается"
  );
  assert.ok(
    calls.tg.some((c) => c.url.includes("/sendMessage") && tgText(c).includes("не нашёл")),
    "админу сообщение про отсутствие новостей"
  );
});