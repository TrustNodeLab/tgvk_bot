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

// ---------- PNG → GIF (индексированный) ----------
// VK рендерит GIF-документ (doc, type=3) в посте встроенной картинкой, тогда
// как PNG/JPEG-документ показывается файлом-иконкой. Групповому токену VK
// недоступны photos.save* (error 27), поэтому единственный рабочий путь
// «картинка на стене» — загрузить изображение как .gif через docs.getWallUploadServer.
// Здесь: декодируем PNG (IDAT через DecompressionStream) → RGBA → палитра ≤256 →
// LZW-сжатие в GIF89a.

async function inflateDeflate(compressed) {
  const cs = new DecompressionStream("deflate");
  const writer = cs.writable.getWriter();
  writer.write(compressed);
  writer.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

async function parsePngToRgba(pngBytes) {
  // PNG сигнатура 8 байт, далее чанки: длина(4) type(4) data(n) crc(4)
  let off = 8;
  let w = 0, h = 0, bitDepth = 8, colorType = 6;
  const idatParts = [];
  while (off + 8 <= pngBytes.length) {
    const len = new DataView(pngBytes.buffer, pngBytes.byteOffset + off, 4).getUint32(0);
    const type = String.fromCharCode(pngBytes[off + 4], pngBytes[off + 5], pngBytes[off + 6], pngBytes[off + 7]);
    const dataStart = off + 8;
    if (type === "IHDR") {
      const dv = new DataView(pngBytes.buffer, pngBytes.byteOffset + dataStart, 13);
      w = dv.getUint32(0);
      h = dv.getUint32(4);
      bitDepth = pngBytes[dataStart + 8];
      colorType = pngBytes[dataStart + 9];
    } else if (type === "IDAT") {
      idatParts.push(pngBytes.subarray(dataStart, dataStart + len));
    } else if (type === "IEND") {
      break;
    }
    off = dataStart + len + 4;
  }
  if (!w || !h) throw new Error("PNG: IHDR не найден");
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null;
  if (channels === null) throw new Error(`PNG: неподдерживаемый colorType=${colorType}`);
  const bpp = Math.ceil((channels * bitDepth) / 8);
  const idat = new Uint8Array(idatParts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of idatParts) { idat.set(p, o); o += p.length; }
  const raw = await inflateDeflate(idat);
  const stride = w * channels * (bitDepth === 16 ? 2 : 1);
  const rgba = new Uint8Array(w * h * 4);
  const px = new Uint8Array(w * h * channels);
  let src = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[src++];
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      let v = raw[src + x];
      const left = x >= bpp ? px[i - bpp] : 0;
      const up = y > 0 ? px[i - stride] : 0;
      const ul = x >= bpp && y > 0 ? px[i - stride - bpp] : 0;
      if (filter === 1) v = (v + left) & 0xff;
      else if (filter === 2) v = (v + up) & 0xff;
      else if (filter === 3) v = (v + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = left + up - ul;
        const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul);
        const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
        v = (v + pred) & 0xff;
      }
      px[i] = v;
    }
    src += stride;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pi = (y * w + x) * channels;
      const oi = (y * w + x) * 4;
      for (let c = 0; c < channels; c++) {
        let v = px[pi + c];
        if (bitDepth === 16) v = px[pi + c * 2];
        rgba[oi + c] = v;
      }
      if (channels === 3) rgba[oi + 3] = 255;
    }
  }
  return { w, h, rgba };
}

// Квантование цветов до <=256 медианным срезом (median cut).
function buildPalette(rgba) {
  const freq = new Map();
  for (let i = 0; i < rgba.length; i += 4) {
    const k = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2];
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  const colors = Array.from(freq.entries()).map(([k, count]) => ({
    r: (k >> 16) & 0xff,
    g: (k >> 8) & 0xff,
    b: k & 0xff,
    count,
  }));
  if (colors.length <= 256) return colors.map((c) => [c.r, c.g, c.b]);

  const range = (box, ch) => {
    let lo = 255, hi = 0;
    for (const c of box) { const v = c[ch]; if (v < lo) lo = v; if (v > hi) hi = v; }
    return hi - lo;
  };

  let boxes = [colors];
  while (boxes.length < 256) {
    // выбираем коробку с максимальным разбросом по любому каналу
    let bi = -1, bestR = -1;
    for (let i = 0; i < boxes.length; i++) {
      const r = Math.max(range(boxes[i], "r"), range(boxes[i], "g"), range(boxes[i], "b"));
      if (r > bestR) { bestR = r; bi = i; }
    }
    if (bestR <= 0) break; // всё плоские коробки
    const box = boxes[bi];
    const ch = range(box, "r") >= range(box, "g")
      ? (range(box, "r") >= range(box, "b") ? "r" : "b")
      : (range(box, "g") >= range(box, "b") ? "g" : "b");
    box.sort((a, b) => a[ch] - b[ch]);
    const cut = Math.floor(box.length / 2);
    // избегаем пустых коробок
    let left = box.slice(0, cut), right = box.slice(cut);
    if (!left.length || !right.length) break;
    boxes[bi] = left;
    boxes.push(right);
  }
  return boxes.map((box) => {
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (const c of box) { sr += c.r * c.count; sg += c.g * c.count; sb += c.b * c.count; n += c.count; }
    return [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
  });
}

// Ближайший цвет палитры (квадрат евклидова расстояния в RGB).
function nearestPaletteIdx(lutKeys, palette, r, g, b) {
  let best = 0, bestD = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const dr = r - palette[i][0], dg = g - palette[i][1], db = b - palette[i][2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// LZW-кодирование индексированных данных GIF — схема omggif (эталонная).
// Декодер GIF: после чтения кода добавляет запись в словарь (кроме clear/EOI);
// ширина кода растёт, когда следующий свободный код превышает 2^codeSize.
function lzwEncode(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  const MAX_DICT = 4096;

  // Проход энкодера: строим список кодов (индексы палитры 0..255).
  const dict = new Map();
  let freeCode = eoiCode + 1;
  const outCodes = [];
  outCodes.push(clearCode);
  let prev = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const cur = indices[i];
    const key = prev * 256 + cur;
    if (dict.has(key)) {
      prev = dict.get(key);
      continue;
    }
    outCodes.push(prev);
    if (freeCode < MAX_DICT) {
      dict.set(key, freeCode++);
    } else {
      outCodes.push(clearCode);
      dict.clear();
      freeCode = eoiCode + 1;
    }
    prev = cur;
  }
  outCodes.push(prev);
  outCodes.push(eoiCode);

  // Упаковка LSB-first. Ширину меняем так же, как декодер: после вывода кода
  // декодер добавляет запись; когда nextFree превысит 2^codeSize — ширина растёт.
  const buf = [];
  let bitPos = 0;
  let acc = 0;
  let codeSize = minCodeSize + 1;
  let nextFree = eoiCode + 1;
  const pushBit = (bit) => {
    acc |= (bit & 1) << bitPos;
    bitPos++;
    if (bitPos === 8) { buf.push(acc & 0xff); bitPos = 0; acc = 0; }
  };
  const emitCode = (code) => {
    for (let b = 0; b < codeSize; b++) pushBit((code >> b) & 1);
  };

  let di = 0;
  emitCode(outCodes[di++]); // clear
  codeSize = minCodeSize + 1;
  nextFree = eoiCode + 1;
  while (di < outCodes.length) {
    const code = outCodes[di++];
    emitCode(code);
    if (code === clearCode) {
      codeSize = minCodeSize + 1;
      nextFree = eoiCode + 1;
    } else if (code !== eoiCode) {
      nextFree++;
      if (nextFree > (1 << codeSize) && codeSize < 12) codeSize++;
    }
  }
  if (bitPos) buf.push(acc & 0xff);
  return buf;
}

// Основная точка входа: PNG-байты → GIF-байты (GIF89a, индексированный).
export async function pngToGif(pngBytes) {
  const { w, h, rgba } = await parsePngToRgba(pngBytes);
  const palette = buildPalette(rgba);
  // Точное сопоставление каждого уникального цвета с ближайшим цветом палитры.
  // Кэш по полному RGB, т.к. уникальных цветов обычно не много.
  const cache = new Map();
  const idxFor = (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    let idx = cache.get(key);
    if (idx === undefined) {
      idx = nearestPaletteIdx(null, palette, r, g, b);
      cache.set(key, idx);
    }
    return idx;
  };
  const indices = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    indices[i] = idxFor(r, g, b);
  }

  const nColors = palette.length;
  const colorBits = nColors > 128 ? 8 : nColors > 64 ? 7 : nColors > 32 ? 6 : nColors > 16 ? 5 : nColors > 8 ? 4 : nColors > 4 ? 3 : 2;
  const minCodeSize = Math.max(2, colorBits);
  const tableSize = 1 << colorBits;
  const colorTable = new Uint8Array(tableSize * 3);
  for (let i = 0; i < tableSize; i++) {
    const c = palette[i] || [0, 0, 0];
    colorTable[i * 3] = c[0];
    colorTable[i * 3 + 1] = c[1];
    colorTable[i * 3 + 2] = c[2];
  }

  const packed = new Uint8Array((w * h) + h);
  for (let y = 0; y < h; y++) {
    packed[y * (w + 1)] = 0;
    packed.set(indices.subarray(y * w, y * w + w), y * (w + 1) + 1);
  }

  const encoded = new Uint8Array(lzwEncode(Array.from(indices), minCodeSize));

  // Сборка GIF89a
  const gctSize = colorBits - 1;
  // Logical Screen Descriptor: 6(сигнатура) + 4(размер) + 1(packed) + 1(bg) + 1(aspect) = 13 байт
  const header = new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, // GIF89a
    w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff,
    0x80 | (gctSize & 7), // global color table flag + size
    0x00, // bg color index
    0x00, // pixel aspect ratio
  ]);
  const parts = [header, colorTable];
  // Image Descriptor
  const imgDesc = new Uint8Array([
    0x2c, 0x00, 0x00, 0x00, 0x00, w & 0xff, (w >> 8) & 0xff, h & 0xff, (h >> 8) & 0xff, 0x00,
  ]);
  parts.push(imgDesc);
  parts.push(Uint8Array.of(minCodeSize));
  // Data sub-blocks: максимум 255 байт на блок
  for (let i = 0; i < encoded.length; i += 255) {
    const block = encoded.subarray(i, i + 255);
    const sub = new Uint8Array(block.length + 1);
    sub[0] = block.length;
    sub.set(block, 1);
    parts.push(sub);
  }
  parts.push(Uint8Array.of(0x00)); // terminator
  parts.push(Uint8Array.of(0x3b)); // trailer

  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

