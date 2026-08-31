// Модульные тесты мультигруппового контура (DGC / LostLink / LostArt).
// Запуск: node --test worker/test/multigroup.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MULTI_GROUPS,
  MULTI_WINDOWS,
  activeMultiWindow,
  parseTgArtBlocks,
  artCaption,
  publishMultiGroup,
  multiStatus,
  titleFingerprint,
  titleSimilarity,
  loadMgConfig,
  saveMgConfig,
  mgDailyReport,
  mgDeadManCheck,
} from "file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/multigroup.js";
import { ekbNow } from "file:///C:/Users/user/Desktop/tgvk_bot/worker/lib/config.js";

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
      const all = [...m.keys()].map((k) => ({ name: k }));
      return { keys: typeof prefix === "string" ? all.filter((k) => k.name.startsWith(prefix)) : all };
    },
    _map: m,
  };
}

function makeEnv(kv) {
  return {
    BOT_KV: kv,
    VK_TOKEN_DGC: "dgc-token",
    VK_TOKEN_LOSTLINK: "ll-token",
    VK_TOKEN_LOSTART: "la-token",
  };
}

test("multigroup: окна слотов активны в ЕКБ (UTC+5)", () => {
  // DGC окно 05:00 -> UTC 00:05
  const dgc = activeMultiWindow(MULTI_GROUPS[0], new Date("2026-08-20T00:05:00Z"));
  assert.equal(dgc, 5 * 60);
  // LostLink 20:00-20:30 -> UTC 15:25
  const ll = activeMultiWindow(MULTI_GROUPS[1], new Date("2026-08-20T15:25:00Z"));
  assert.equal(ll, 20 * 60);
  // LostArt окна 9:00/12:00/15:00/18:00 ЕКБ -> UTC 4/7/10/13 (+5).
  // 11:40 UTC = 16:40 ЕКБ — вне всех окон.
  const off = activeMultiWindow(MULTI_GROUPS[2], new Date("2026-08-20T11:40:00Z"));
  assert.equal(off, null);
});

test("multigroup: группы сконфигурированы и окна по расписанию", () => {
  assert.equal(MULTI_GROUPS.length, 3);
  const kinds = MULTI_GROUPS.map((g) => g.kind);
  assert.deepEqual(kinds, ["news", "news", "art"]);
  assert.deepEqual(MULTI_WINDOWS.dgc, [5 * 60, 10 * 60, 15 * 60, 20 * 60]);
  assert.deepEqual(MULTI_WINDOWS.lostlink, [8 * 60, 11 * 60, 14 * 60, 17 * 60, 20 * 60]);
  assert.deepEqual(MULTI_WINDOWS.lostart, [9 * 60, 12 * 60, 15 * 60, 18 * 60]);
});

test("multigroup: парсер блоков t.me/s тянет https-картинки и data-post", () => {
  // Эмпирика t.me/s: `<i class=…user_photo>` несёт https, а в подписи встречаются
  // protocol-relative //telegram.org (аватарки/эмодзи). Блок без https-картинки
  // отбрасывается целиком, блок с https-фото проходит с data-post.
  const html =
    '<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="aiart/123">' +
    '<img src="//telegram.org/img/emoji/x.png" class="tgme_widget_message_photo">' +
    '<div class="tgme_widget_message_text">только эмодзи</div>' +
    "</div></div>" +
    '<div class="tgme_widget_message_wrap"><div class="tgme_widget_message" data-post="aiart/124">' +
    '<img src="https://cdn.com/b.jpg" class="tgme_widget_message_photo">' +
    '<div class="tgme_widget_message_date" datetime="2026-08-20T09:00:00+00:00"></div>' +
    "</div></div>" +
    "<!-- конец -->";
  const blocks = parseTgArtBlocks(html, "aiart");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].post, "aiart/124");
  assert.equal(blocks[0].image, "https://cdn.com/b.jpg");
  assert.ok(!blocks[0].image.startsWith("//"),
    "должна отбрасываться protocol-relative ссылка (эмпирика t.me/s)");
});

test("multigroup: подпись арта содержит канал и дату", () => {
  const cap = artCaption({ channel: "aiart", time: "2026-08-20T09:00:00+00:00" });
  assert.match(cap, /@aiart/);
  assert.match(cap, /2026-08-20/);
  assert.match(cap, /ИИ-арт/);
});

test("multigroup: публикация вне активного окна ничего не делает", async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  const group = MULTI_GROUPS[0]; // DGC
  // ЕКБ 19:10 (UTC 14:10) — вне окна DGC
  const res = await publishMultiGroup(env, group, new Date("2026-08-20T14:10:00Z"));
  assert.equal(res.posted, false);
  assert.match(res.detail, /не активный слот/);
  assert.equal(kv._map.size, 0, "ничего не должно писаться в KV");
});

test("multigroup: без токена группы публикация отменяется", async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  delete env.VK_TOKEN_DGC;
  const group = MULTI_GROUPS[0];
  const res = await publishMultiGroup(env, group, new Date("2026-08-20T00:05:00Z"));
  assert.equal(res.posted, false);
  assert.match(res.detail, /нет токена/);
});

test("multigroup: повтор публикации в занятый слот блокируется KV", async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  const group = MULTI_GROUPS[0];
  // Занятый слот: ключ vk_posted:mg:dgc:2026-08-20:300
  await kv.put("vk_posted:mg:dgc:2026-08-20:300", "42");
  const res = await publishMultiGroup(env, group, new Date("2026-08-20T00:05:00Z"));
  assert.equal(res.posted, false);
  assert.match(res.detail, /слот уже занят/);
});

test("multigroup: status показывает токены и число постов", async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  const today = ekbNow().date;
  await kv.put(`vk_posted:mg:dgc:${today}:300`, "1");
  await kv.put(`vk_posted:mg:lostart:${today}:540`, "2");
  const rows = await multiStatus(env);
  assert.equal(rows.length, 3);
  const dgc = rows.find((r) => r.slug === "dgc");
  assert.equal(dgc.token, "✓");
  assert.ok(dgc.postedToday >= 1);
  const lostart = rows.find((r) => r.slug === "lostart");
  assert.equal(lostart.token, "✓");
});

test("multigroup: семантический дедуп ловит похожие заголовки", () => {
  const a = titleFingerprint("CD Projekt показала геймплей Witcher 4 на конференции");
  const b = titleFingerprint("CD Projekt RED показала геймплей Witcher 4");
  const c = titleFingerprint("Куртка Кобейна ушла с молотка за миллион долларов");
  assert.ok(titleSimilarity(a, b) >= 0.55, "похожие заголовки должны ловиться");
  assert.ok(titleSimilarity(a, c) < 0.3, "разные новости не должны быть дублями");
});

test("multigroup: конфиг из KV переопределяет окна и режим согласования", async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  await saveMgConfig(env, { windows: { dgc: [600, 1200] }, approval: true });
  const cfg = await loadMgConfig(env);
  assert.deepEqual(cfg.windows.dgc, [600, 1200]);
  assert.equal(cfg.approval, true);
  // дефолтные окна других групп не затёрты
  assert.deepEqual(cfg.windows.lostart, MULTI_WINDOWS.lostart);
  // активное окно учитывает оверрайд: 10:05 ЕКБ -> слот 600
  const slot = activeMultiWindow(MULTI_GROUPS[0], new Date("2026-08-21T05:05:00Z"), cfg.windows);
  assert.equal(slot, 600);
});

test("multigroup: ежедневный отчёт формируется в 21:00 ЕКБ один раз", async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  const at21 = new Date("2026-08-21T16:03:00Z"); // 21:03 ЕКБ
  const report = await mgDailyReport(env, at21);
  assert.ok(report && report.includes("Отчёт мультигрупп"), "отчёт должен собраться в 21:00-21:10");
  const again = await mgDailyReport(env, at21);
  assert.equal(again, null, "повторно за день отчёт не отправляется");
  const early = await mgDailyReport(env, new Date("2026-08-21T10:00:00Z"));
  assert.equal(early, null, "днём отчёта быть не должно");
});

test("multigroup: мёртвый выключатель бьёт тревогу при пропущенном окне", async () => {
  const kv = makeKV();
  const env = makeEnv(kv);
  // 12:40 ЕКБ: первое окно DGC (05:00) давно прошло, постов нет
  const now = new Date("2026-08-21T07:40:00Z");
  const alert = await mgDeadManCheck(env, now);
  assert.ok(alert && alert.includes("DGC"), "алерт по DGC должен прийти");
  const again = await mgDeadManCheck(env, now);
  assert.equal(again, null, "повторный алерт в тот же день не шлётся");
});