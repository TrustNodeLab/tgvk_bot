import test from "node:test";
import assert from "node:assert/strict";
import { parseRSS } from "../lib/config.js";

const XML = `<?xml version="1.0" encoding="utf-8"?>
<rss><channel>
<item>
  <title>В МВД рассказали, как мошенники чаще всего устанавливают связь с жертвами</title>
  <link><![CDATA[https://tass.ru/obschestvo/28034275]]></link>
  <guid><![CDATA[https://tass.ru/obschestvo/28034275]]></guid>
  <description>Речь идет об СМС и звонках по телефону Источник: &lt;![CDATA[https://tass.ru/obschestvo/28034275]]&gt;</description>
  <pubDate>Sat, 22 Aug 2026 08:00:00 +0300</pubDate>
</item>
<item>
  <title>Родителей предупредили о схеме с фальшивыми школьными наборами</title>
  <link><![CDATA[https://russian.rt.com/russia/news/abc]]></link>
  <description><![CDATA[<img alt="Preview" align="left" style="margin-right: 10px;" src="https://mf.b37mrtl.ru/img.jpg" /> Мошенники перед 1 сентября начали предлагать родителям поддельные «школьные наборы».]]></description>
  <pubDate>Sat, 22 Aug 2026 07:00:00 +0300</pubDate>
</item>
</channel></rss>`;

test("parseRSS: CDATA в link/guid не протекает в поля", () => {
  const items = parseRSS(XML);
  assert.equal(items[0].link, "https://tass.ru/obschestvo/28034275");
  assert.equal(items[0].guid, "https://tass.ru/obschestvo/28034275");
  assert.ok(!items[0].link.includes("CDATA"));
});

test("parseRSS: хвост «Источник: …» вырезается из описания", () => {
  const items = parseRSS(XML);
  assert.equal(items[0].description, "Речь идет об СМС и звонках по телефону");
  assert.ok(!/источник/i.test(items[0].description));
});

test("parseRSS: HTML-теги (<img>) вырезаются из описания", () => {
  const items = parseRSS(XML);
  assert.ok(!items[1].description.includes("<img"));
  // картинка при этом извлекается из описания
  assert.equal(items[1].image, "https://mf.b37mrtl.ru/img.jpg");
  assert.ok(items[1].description.startsWith("Мошенники перед 1 сентября"));
});
