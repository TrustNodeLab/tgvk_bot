// Минималистичный JPEG-декодер (baseline, 8-бит, YCbCr) на чистом JS для free-плана
// Cloudflare Workers (нет DOM/canvas). Нужен только для артов из Telegram: арт —
// почти всегда JPEG, а публикуем картинку как GIF-док (механизм TrustNode), т.е.
// JPEG должен быть преобразован в RGBA, а потом в GIF (encodeGif в cardgen.js).
//
// Поддерживает: SOF0 (baseline), Huffman DC/AC, DQT, один или три компонента,
// subsampling 2x2 / 2x1 / 1x1 (4:2:0, 4:2:2, 4:4:4), progressive (SOF2) — НЕ
// поддерживается (такой арт пропускается как неподходящий).

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
];

// Стандартный идентификатор множественной выборки — порядок компонентов Cb,Cr.
const SCAN_LUM = [
  [0, 0], [0, 1], [0, 2], [0, 3],
  [1, 0], [1, 1], [1, 2], [1, 3],
  [2, 0], [2, 1], [2, 2], [2, 3],
  [3, 0], [3, 1], [3, 2], [3, 3],
];

// Расширяет знак: дополняет число по битовой глубине (разделы JPEG DC diff/AC run).
function extend(val, bits) {
  if (val < (1 << (bits - 1))) return val + ((-1) << bits) + 1;
  return val;
}

// Строит справочник канонических кодов Хаффмана из таблицы DHT: counts[16] длин
// кодов и symbols (значения в порядке возрастания длины). Метод как в libjpeg:
// первый код длины l = (первый код длины l-1 + число символов длины l-1) << 1.
// Символы каждой длины идут подряд, начальный индекс длины l = сумме символов
// более коротких длин. Возвращает { key: (len<<16|code) -> sym, maxLen }.
// len<<16|code уникален: len занимает биты 16..20, code (до 16 бит) 0..15.
function buildHuffmanTree(counts, symbols) {
  const m = {};
  let code = 0;
  let symIdx = 0;
  for (let len = 1; len <= 16; len++) {
    code <<= 1; // каноническое смещение
    for (let i = 0; i < counts[len - 1]; i++) {
      m[(len << 16) | (code + i)] = symbols[symIdx + i];
    }
    code += counts[len - 1];
    symIdx += counts[len - 1];
  }
  return m;
}

// Прямой листинг по коду (для быстрого seek). key = (len<<16)|code
function hashHuffman(tree) {
  return { m: tree, maxLen: 16 };
}

// Одноразовый битовый ридер по байтам JPEG (с учётом байт-стаффинга маркеров
// и restart-интервалов DRI/RSTn, которые встречаются в крупных изображениях).
class BitReader {
  constructor(data, start, end, onRestart) {
    this.d = data;
    this.pos = start;
    this.end = end;
    this.bitBuf = 0;
    this.bitCnt = 0;
    this.onRestart = onRestart || null;
  }
  readBits(n) {
    while (this.bitCnt < n) {
      if (this.pos >= this.end) return null; // конец скана
      let b = this.d[this.pos++];
      if (b === 0xff) {
        const next = this.d[this.pos];
        if (next === 0x00) { // байт-стаффинг
          this.pos++;
        } else if (next >= 0xd0 && next <= 0xd7) { // restart-маркер
          this.pos++;
          this.bitBuf = 0;
          this.bitCnt = 0;
          if (this.onRestart) this.onRestart();
          continue;
        } else {
          // конец сканируемых данных (EOI или другой маркер) — дальнейших битов нет
          this.bitCnt = -1;
          return null;
        }
      }
      this.bitBuf = (this.bitBuf << 8) | b;
      this.bitCnt += 8;
    }
    if (this.bitCnt < n) return 0;
    this.bitCnt -= n;
    return (this.bitBuf >>> this.bitCnt) & ((1 << n) - 1);
  }
}

// Обратный дискретный косинусный преобразование 8x8 — попеременно по строкам и
// столбцам. Используем классический ортогональный (Chen) float-вариант.
const IDCT_MAT = (() => {
  const c = [];
  for (let i = 0; i < 8; i++) {
    c.push([]);
    for (let j = 0; j < 8; j++) {
      c[i][j] = (i === 0 ? 1 / Math.SQRT2 : 1) * Math.cos(((2 * j + 1) * i * Math.PI) / 16) * 0.5;
    }
  }
  return c;
})();

function idct8x8(block) {
  // 1D DCT по строкам
  const rows = [];
  for (let yy = 0; yy < 8; yy++) {
    const r = [];
    for (let xx = 0; xx < 8; xx++) {
      let s = 0;
      for (let k = 0; k < 8; k++) s += IDCT_MAT[k][xx] * block[yy * 8 + k];
      r[xx] = s;
    }
    rows[yy] = r;
  }
  // 1D DCT по столбцам
  const out = new Float64Array(64);
  for (let yy = 0; yy < 8; yy++) {
    for (let xx = 0; xx < 8; xx++) {
      let s = 0;
      for (let k = 0; k < 8; k++) s += IDCT_MAT[k][yy] * rows[k][xx];
      out[yy * 8 + xx] = s;
    }
  }
  return out;
}

const QUANT_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];
const QUANT_CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
];

// Парсинг JPEG и возврат { width, height, px (Uint8ClampedArray RGBA) }.
export function decodeJpeg(data) {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (u8.length < 4 || u8[0] !== 0xff || u8[1] !== 0xd8) {
    throw new Error("JPEG: нет SOI (не JPEG)");
  }
  let pos = 2;
  let components = null; // [{id, h, v, qtable, blocks}]
  let tables = {}; // quant tables по id: Float64Array[64]
  let huffDC = {}; // по (class=0/1, id)
  let huffAC = {};
  let width = 0;
  let height = 0;
  let precision = 8;
  let sofSeen = false;

  const getU16 = (p) => (u8[p] << 8) | u8[p + 1];

  while (pos < u8.length) {
    if (u8[pos] !== 0xff) {
      // данные — должны быть только после SOS; здесь маркер обязан быть FF
      pos++;
      continue;
    }
    const marker = u8[pos + 1];
    if (marker === 0xd9) break; // EOI
    // length поля: для маркеров без length (RST, TEM, SOI, EOI) — пропуск
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2;
      continue;
    }
    const segLen = getU16(pos + 2);
    const segStart = pos + 2;
    const segData = segStart + 2;
    const segEnd = segStart + segLen;

    if (marker === 0xc0 || marker === 0xc1) { // SOF0/SOF1 (baseline/extended)
      precision = u8[segData];
      height = getU16(segData + 1);
      width = getU16(segData + 3);
      const nComp = u8[segData + 5];
      if (nComp !== 1 && nComp !== 3) throw new Error(`JPEG: неожиданное число компонентов ${nComp}`);
      components = [];
      let p = segData + 6;
      for (let i = 0; i < nComp; i++) {
        const id = u8[p];
        const hv = u8[p + 1];
        const tq = u8[p + 2];
        components.push({ id, h: hv >> 4, v: hv & 0x0f, qtable: null, tq });
        p += 3;
      }
      sofSeen = true;
    } else if (marker === 0xc2) {
      throw new Error("JPEG: progressive (SOF2) не поддерживается");
    } else if (marker === 0xdb) { // DQT
      let p = segData;
      while (p < segEnd) {
        const pq = u8[p] >> 4;
        const tq = u8[p] & 0x0f;
        const q = new Float64Array(64);
        if (pq === 0) {
          for (let i = 0; i < 64; i++) q[ZIGZAG[i]] = u8[p + 1 + i];
          p += 1 + 64;
        } else {
          for (let i = 0; i < 64; i++) q[ZIGZAG[i]] = getU16(p + 1 + i * 2);
          p += 1 + 128;
        }
        tables[tq] = q;
      }
    } else if (marker === 0xc4) { // DHT
      let p = segData;
      while (p < segEnd) {
        const cls = u8[p] >> 4; // 0=DC, 1=AC
        const id = u8[p] & 0x0f;
        const counts = [];
        let total = 0;
        for (let i = 0; i < 16; i++) {
          counts.push(u8[p + 1 + i]);
          total += u8[p + 1 + i];
        }
        const symbols = u8.subarray(p + 17, p + 17 + total);
        const tree = buildHuffmanTree(counts, symbols);
        if (cls === 0) huffDC[id] = tree;
        else huffAC[id] = tree;
        p += 17 + total;
      }
    } else if (marker === 0xda) { // SOS
      if (!sofSeen || !components) throw new Error("JPEG: SOS до SOF");
      const nComp = u8[segData];
      const compMap = {};
      for (let i = 0; i < nComp; i++) {
        const id = u8[segData + 1 + i * 2];
        const tbl = u8[segData + 2 + i * 2];
        compMap[id] = { dc: tbl >> 4, ac: tbl & 0x0f };
      }
      // Данные скана начинаются с segEnd (после Ss Se AhAl) — до EOI
      const scanStart = segEnd;
      let scanEnd = scanStart;
      let eoiIdx = -1;
      for (let i = scanStart; i < u8.length - 1; i++) {
        if (u8[i] === 0xff && u8[i + 1] === 0xd9) {
          eoiIdx = i;
          break;
        }
        scanEnd = i + 2;
      }
      if (eoiIdx > 0) scanEnd = eoiIdx;

      const result = decodeScan(u8, scanStart, scanEnd, components, compMap, tables, huffDC, huffAC, width, height, precision);
      return { width, height, px: result };
    } else {
      // APPn / COM / DRI / прочие — пропускаем
      // (в baseline других значимых маркеров нет)
    }

    pos = segEnd;
  }
  throw new Error("JPEG: не найден сканирующий сегмент SOS");
}

function decodeScan(
  data, scanStart, scanEnd, components, compMap, tables, huffDC, huffAC, width, height, precision
) {
  // Собираем плоскость каждого компонента из блоков 8x8 (не расширяя до кратности 8).
  const maxH = Math.max(...components.map((c) => c.h));
  const maxV = Math.max(...components.map((c) => c.v));
  const hBlocks = Math.ceil(width / (8 * maxH));
  const vBlocks = Math.ceil(height / (8 * maxV));
  for (const c of components) {
    c.q = tables[c.tq] || (c.id === 1 ? QUANT_LUMA : QUANT_CHROMA);
    if (!c.q) c.q = new Float64Array(QUANT_LUMA);
    c.blocksW = Math.ceil((width * c.h) / (8 * maxH));
    c.blocksH = Math.ceil((height * c.v) / (8 * maxV));
    c.grid = new Float64Array(c.blocksW * c.blocksH * 64);
    c.pxW = c.blocksW * 8;
    c.pxH = c.blocksH * 8;
  }

  const reader = new BitReader(data, scanStart, scanEnd, () => {
    // сброс DC-предсказателей на каждом restart-интервале
    for (const c of components) preds[c.id] = 0;
  });

  // Для каждого MCU (порядок компонентов в скане) декодируем блоки.
  const totalMcuX = hBlocks;
  const totalMcuY = vBlocks;
  const preds = {};
  for (const c of components) preds[c.id] = 0;

  // Huffman-поиск выполняем один раз на компонент (вне горячего цикла MCU).
  const lookups = {};
  for (const c of components) {
    const map = compMap[c.id];
    const dcTree = huffDC[map.dc] || [];
    const acTree = huffAC[map.ac] || [];
    lookups[c.id] = { dc: hashHuffman(dcTree), ac: hashHuffman(acTree) };
  }

  for (let my = 0; my < totalMcuY; my++) {
    for (let mx = 0; mx < totalMcuX; mx++) {
      for (const c of components) {
        const lu = lookups[c.id];
        const q = c.q;
        const cw = c.blocksW;
        const ch = c.blocksH;
        // количество блоков по горизонтали/вертикали у этого компонента
        const bx0 = mx * c.h; // уже в координатах компонента
        const by0 = my * c.v;
        for (let bgy = 0; bgy < c.v; bgy++) {
          for (let bgx = 0; bgx < c.h; bgx++) {
            const blockX = bx0 + bgx;
            const blockY = by0 + bgy;
            if (blockY >= ch || blockX >= cw) continue;
            const block = decodeBlock(reader, lu, q, preds[c.id]);
            preds[c.id] = block.pred;
            c.grid.set(block.b, (blockY * cw + blockX) * 64);
          }
        }
      }
    }
  }

  // YCbCr -> RGB с upsampling хроминансных плоскостей и обрезкой по краям.
  const luma = components.find((c) => supportLuma(c, components));
  return composeRgba(width, height, components, maxH, maxV);
}

function supportLuma(c, all) {
  // luma — первая компонента с max sampling; в baseline обычно id=1 или первый
  if (all.length === 1) return true;
  const maxH = Math.max(...all.map((x) => x.h));
  const maxV = Math.max(...all.map((x) => x.v));
  return c.h === maxH && c.v === maxV;
}

function composeRgba(width, height, components, maxH, maxV) {
  let luma = components[0];
  if (components.length > 1) {
    luma = components.find((c) => c.h === maxH && c.v === maxV) || components[0];
  }
  const chroma = components.filter((c) => c !== luma);
  const cb = chroma[0] || null;
  const cr = chroma[1] || null;

  const out = new Uint8ClampedArray(width * height * 4);
  const yBlocksW = luma.blocksW;
  const lumaGrid = luma.grid;

  // Выборка пикселя из блочной сетки компонента с учётом субсэмплинга.
  // Блок (bx,by) покрывает (8*maxH x 8*maxV) luma-пикселей; внутри блока
  // выборка — ближайший сосед: координата внутри блока делится на (maxH/V).
  const sample = (comp, x, y) => {
    const bx = Math.min(comp.blocksW - 1, Math.floor(x / (8 * maxH)));
    const by = Math.min(comp.blocksH - 1, Math.floor(y / (8 * maxV)));
    const inx = Math.floor((x % (8 * maxH)) / maxH);
    const iny = Math.floor((y % (8 * maxV)) / maxV);
    const idx = ((by * comp.blocksW + bx) * 64) + (iny * 8 + inx);
    return comp.grid[idx];
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bx = Math.min(yBlocksW - 1, x >> 3);
      const by = Math.min(luma.blocksH - 1, y >> 3);
      // JPEG хранит выборки со сдвигом уровня: уровни 0..255 кодируются со
      // знаком −128 (DC-коэффициент), поэтому IDCT-выход возвращаем в 0..255.
      const Y = lumaGrid[(by * yBlocksW + bx) * 64 + (y & 7) * 8 + (x & 7)] + 128;
      const Cb = (cb ? sample(cb, x, y) : 0) + 128;
      const Cr = (cr ? sample(cr, x, y) : 0) + 128;
      const r = Y + 1.402 * (Cr - 128);
      const g = Y - 0.344136 * (Cb - 128) - 0.714136 * (Cr - 128);
      const b = Y + 1.772 * (Cb - 128);
      const o = (y * width + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
  return out;
}

// Декодирует один 8x8 блок: DC diff + AC rle -> де-квантование -> IDCT.
// Возвращает { b: Float64Array(64), pred }.
function decodeBlock(reader, lookup, quant, pred) {
  const out = new Float64Array(64); // natural-порядок (как требует IDCT)
  // DC
  const dcSymbol = readHuffSym(reader, lookup.dc);
  const bitsDc = dcSymbol !== null && dcSymbol > 0 ? reader.readBits(dcSymbol) : 0;
  const dc = dcSymbol !== null ? extend(bitsDc, dcSymbol) : 0;
  out[0] = (pred + dc) * quant[0];
  // AC — коэффициенты идут в спектре по zigzag; перекладываем в natural-порядок.
  let idx = 1;
  while (idx < 64) {
    const rs = readHuffSym(reader, lookup.ac);
    if (rs === null) break; // обрыв — трактуем как EOB
    const r = rs >> 4; // нулей до ненулевого
    const s = rs & 0x0f;
    if (rs === 0) break; // EOB
    idx += r;
    if (idx >= 64) break;
    const bits = s > 0 ? reader.readBits(s) : 0;
    const val = s > 0 ? extend(bits, s) : 0;
    const natural = ZIGZAG[idx];
    out[natural] = val * quant[natural];
    idx++;
  }
  let b;
  try {
    b = idct8x8(out);
  } catch (e) {
    b = out; // на ошибках IDCT — отдаём сырые коэффициенты (визуально неверно, не падаем)
  }
  return { b, pred: pred + dc };
}

function readHuffSym(reader, lookup) {
  let code = 0;
  let len = 1;
  while (len <= 16) {
    const bit = reader.readBits(1);
    if (bit === null) return null;
    code = (code << 1) | bit;
    const sym = lookup.m[(len << 16) | code];
    if (sym !== undefined) return sym;
    len++;
  }
  return null;
}