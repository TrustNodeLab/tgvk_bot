// Генератор PNG-карточки поста прямо в Worker (чистый JS, без Canvas/PIL).
// Текст рисуется растровым шрифтом Exo2 (worker/lib/font.js); PNG кодируется
// через CompressionStream("deflate") — zlib-поток, ровно то, что ждёт PNG IDAT.

import { FONT, FONT_H } from "./font.js";

const W = 1080;
const H = 1350;
const PAD = 72;
const SCALE = 3; // базовый масштаб шрифта (16px * 3 = 48px высота строки)
const LINE_H = FONT_H * SCALE + 16;

const BG = [11, 18, 32]; // #0B1220
const TEXT = [242, 245, 250]; // #F2F5FA
const ACCENT = [255, 210, 74]; // #FFD24A
const SUB = [138, 147, 166]; // #8A93A6
const CARD_BG = [19, 28, 48]; // #131C30

// ---------- растровый холст ----------

class Canvas {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.px = new Uint8Array(w * h * 4);
    this.fillRect(0, 0, w, h, BG);
  }
  setPx(x, y, [r, g, b]) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.px[i] = r;
    this.px[i + 1] = g;
    this.px[i + 2] = b;
    this.px[i + 3] = 255;
  }
  fillRect(x, y, w, h, color) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.setPx(xx, yy, color);
  }
  blitGlyph(glyph, x, y, scale, color) {
    const [w, ...data] = glyph;
    const rowBytes = Math.ceil(w / 8);
    for (let gy = 0; gy < FONT_H; gy++) {
      for (let gx = 0; gx < w; gx++) {
        const byte = data[gy * rowBytes + (gx >> 3)];
        const bit = byte & (0x80 >> (gx & 7));
        if (bit) this.fillRect(x + gx * scale, y + gy * scale, scale, scale, color);
      }
    }
    return w * scale;
  }
}

// ---------- текст ----------

function glyphWidth(ch, scale) {
  const g = FONT[ch];
  return g ? g[0] * scale + scale : scale * 3;
}

function measureLine(text, scale) {
  let w = 0;
  for (const ch of text) w += glyphWidth(ch, scale);
  return w;
}

// Перенос текста по ширине (в пикселях), аккуратно по словам.
function wrapText(text, maxWidth, scale) {
  const words = text.split(/(\s+)/);
  const lines = [];
  let cur = "";
  for (const part of words) {
    const t = cur + part;
    if (measureLine(t, scale) <= maxWidth) {
      cur = t;
    } else {
      if (cur.trim()) lines.push(cur.replace(/\s+$/, ""));
      cur = part;
    }
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.length ? lines : [""];
}

// ---------- PNG-кодирование ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  out.set(len, 0);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crc = new Uint8Array(4);
  const crcInput = new Uint8Array(4 + data.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(data, 4);
  new DataView(crc.buffer).setUint32(0, crc32(crcInput));
  out.set(crc, 8 + data.length);
  return out;
}

async function encodePng(canvas) {
  const { w, h, px } = canvas;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: None
    raw.set(px.subarray(y * w * 4, y * w * 4 + w * 4), y * (w * 4 + 1) + 1);
  }

  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(raw);
  writer.close();
  const idat = new Uint8Array(await new Response(cs.readable).arrayBuffer());

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

// ---------- карточка ----------

function drawHeadline(canvas, text, x, y, maxWidth) {
  const lines = wrapText(text, maxWidth, SCALE).slice(0, 4);
  let cy = y;
  for (const line of lines) {
    drawText(canvas, line, x, cy, SCALE, TEXT, maxWidth);
    cy += LINE_H;
  }
  return cy;
}

// Рисуем строку по одному глифу.
function drawText(canvas, text, x, y, scale, color, maxWidth) {
  let cx = x;
  for (const ch of text) {
    const g = FONT[ch];
    if (!g) {
      cx += scale * 4;
      continue;
    }
    cx += canvas.blitGlyph(g, cx, y, scale, color);
    cx += scale;
  }
  return cx;
}

// Центрируем строку относительно x по её ширине.
function drawTextCentered(canvas, text, centerX, y, scale, color, maxWidth) {
  const w = measureLine(text, scale);
  return drawText(canvas, text, Math.max(0, centerX - w / 2), y, scale, color, maxWidth);
}

function drawFooter(canvas, tier, y) {
  drawText(canvas, "TRUSTNODE", PAD, y, 2, SUB);
  const right = "t.me / vk.com — кибербезопасность простыми словами";
  drawText(canvas, right, W - PAD - measureLine(right, 2), y, 2, SUB);
  drawTextCentered(canvas, "СТУДИЯ ЦИФРОВОЙ БЕЗОПАСНОСТИ", W / 2, y + 34, 2, SUB);
}

// Основная точка входа. data: {headline, cards:[{type,number,label,desc,items,before,after}], tier}
export async function renderCard(data) {
  const c = new Canvas(W, H);
  // верхняя акцентная полоса
  c.fillRect(0, 0, W, 14, ACCENT);
  // водяной знак
  drawText(c, "TRUSTNODE", W - PAD - measureLine("TRUSTNODE", 2), 36, 2, [41, 52, 78]);

  let y = 130;

  // заголовок
  const headline = (data.headline || "Безопасность в цифровом мире").toUpperCase();
  y = drawHeadline(c, headline, PAD, y, W - PAD * 2);
  y += 20;

  // разделитель
  c.fillRect(PAD, y, W - PAD * 2, 3, ACCENT);
  y += 40;

  const cards = data.cards || [];
  const stat = cards.find((x) => x.type === "stat" && x.number);
  const list = cards.filter((x) => x.type === "list" && x.items?.length).flatMap((x) => x.items);

  if (stat) {
    // карточка-статистика: крупная цифра
    const boxH = 300;
    c.fillRect(PAD, y, W - PAD * 2, boxH, CARD_BG);
    const num = String(stat.number).slice(0, 12);
    drawTextCentered(c, num, W / 2, y + 60, 6, ACCENT, W - PAD * 2 - 40);
    const label = (stat.label || "").toUpperCase();
    drawTextCentered(c, label, W / 2, y + 60 + 6 * FONT_H + 40, 3, TEXT, W - PAD * 2 - 40);
    if (stat.desc) {
      const dl = wrapText(stat.desc, W - PAD * 2 - 60, 2);
      let dy = y + boxH - 30 - dl.length * (FONT_H * 2 + 8);
      for (const l of dl.slice(0, 2)) {
        drawTextCentered(c, l, W / 2, dy, 2, SUB, W - PAD * 2 - 60);
        dy += FONT_H * 2 + 8;
      }
    }
    y += boxH + 40;
  }

  // карточки-списки: тезисы
  const items = (list.length ? list : cards.filter((x) => x.type === "compare").slice(0, 1)).slice(0, 4);
  if (items.length) {
    let boxY = y;
    const boxH = 40 + items.length * 84;
    c.fillRect(PAD, y, W - PAD * 2, boxH, CARD_BG);
    y += 40;
    for (const it of items) {
      const tl = wrapText(String(it), W - PAD * 2 - 70, SCALE);
      drawText(c, "–", PAD + 24, y, SCALE, ACCENT);
      let ty = y;
      for (const line of tl.slice(0, 2)) {
        drawText(c, line, PAD + 60, ty, SCALE, TEXT, W - PAD * 2 - 60);
        ty += LINE_H;
      }
      y += Math.max(84, (tl.length > 1 ? 2 : 1) * LINE_H + 14);
    }
    y = boxY + boxH + 40;
  }

  drawFooter(c, data.tier || "news", H - 130);
  return encodePng(c);
}
