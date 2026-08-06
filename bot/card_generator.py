"""
Рендер карточки TrustNode Lab: реальное небо над Москвой + Exo2/Jura + акцент по уровню угрозы.
Вход — структурированный dict (см. schema в prompts/extract_prompt.md), выход — путь к PNG.
"""
import math
import textwrap
import os
import sys
from datetime import datetime
from PIL import Image, ImageDraw, ImageFont

from astro import stars_moscow, sun_altitude_moscow, CONSTELLATION_LINES

HERE = os.path.dirname(os.path.abspath(__file__))
FONTS_DIR = os.path.join(HERE, "..", "fonts")
EXO2 = os.path.join(FONTS_DIR, "Exo2-Variable.ttf")
JURA = os.path.join(FONTS_DIR, "Jura-Variable.ttf")

ALLOWED_TIERS = {"news", "real_threat", "medium", "safe"}

ACCENT_DARK = {"news": "#3B82F6", "real_threat": "#EF4444", "medium": "#FB923C", "safe": "#2DD4BF"}
ACCENT_LIGHT = {"news": "#1D4ED8", "real_threat": "#B91C1C", "medium": "#B45309", "safe": "#0F766E"}

W = 1080  # ширина канвы фиксирована, высота — динамическая под контент


# ---------- небо ----------

def _lerp(a, b, t):
    return a + (b - a) * t


def _lerp_color(c1, c2, t):
    return tuple(int(_lerp(c1[i], c2[i], t)) for i in range(3))


def _sky_theme(sun_alt):
    NIGHT_TOP, NIGHT_BOT = (6, 8, 18), (10, 12, 28)
    TWI_TOP, TWI_BOT = (18, 22, 52), (60, 45, 90)
    HORIZON_TOP, HORIZON_BOT = (60, 70, 130), (255, 150, 90)
    DAY_TOP, DAY_BOT = (130, 185, 235), (225, 240, 252)
    if sun_alt <= -12:
        return NIGHT_TOP, NIGHT_BOT, (255, 255, 255), 1.0, False
    elif sun_alt <= -4:
        t = (sun_alt + 12) / 8.0
        return (_lerp_color(NIGHT_TOP, TWI_TOP, t), _lerp_color(NIGHT_BOT, TWI_BOT, t),
                (255, 255, 255), 1.0 - 0.35 * t, False)
    elif sun_alt <= 3:
        t = (sun_alt + 4) / 7.0
        return (_lerp_color(TWI_TOP, HORIZON_TOP, t), _lerp_color(TWI_BOT, HORIZON_BOT, t),
                (255, 255, 255), max(0.0, 0.65 - 0.65 * t), False)
    elif sun_alt <= 15:
        t = (sun_alt - 3) / 12.0
        is_light = t > 0.5
        # текст и панели (is_light) должны переключаться в один и тот же момент —
        # раньше text_c уходил в тёмный (17,17,17) сразу с начала диапазона (t>0),
        # а is_light/panel_fill оставались тёмными до t>0.5: в этом окне тёмный
        # текст рисовался поверх тёмной панели и становился нечитаемым.
        return (_lerp_color(HORIZON_TOP, DAY_TOP, t), _lerp_color(HORIZON_BOT, DAY_BOT, t),
                (17, 17, 17) if is_light else (255, 255, 255), 0.0, is_light)
    else:
        return DAY_TOP, DAY_BOT, (17, 17, 17), 0.0, True


def _project(alt, az, w, h):
    r = 90 - alt
    scale = (h * 0.62) / 90.0
    az_r = math.radians(az)
    return w / 2 + r * math.sin(az_r) * scale, h * 0.42 - r * math.cos(az_r) * scale


def _draw_sky(draw, w, h, dt_msk):
    sun_alt = sun_altitude_moscow(dt_msk)
    top_c, bot_c, text_c, star_op, is_light = _sky_theme(sun_alt)
    for y in range(h):
        draw.line([(0, y), (w, y)], fill=_lerp_color(top_c, bot_c, y / h))
    if star_op > 0.01:
        positions = {}
        for name, alt, az, mag, con in stars_moscow(dt_msk):
            if alt <= -2:
                continue
            x, y = _project(alt, az, w, h)
            if -50 < x < w + 50 and -50 < y < h + 50:
                positions[name] = (x, y)
                size = max(1.0, (2.2 - mag) * 1.15)
                b = max(60, min(255, int(255 * star_op)))
                draw.ellipse([x - size, y - size, x + size, y + size], fill=(b, b, min(255, b + 15)))
        line_col = (max(35, int(90 * star_op)) + 30,) * 3
        for pairs in CONSTELLATION_LINES.values():
            for a, b in pairs:
                if a in positions and b in positions:
                    draw.line([positions[a], positions[b]], fill=line_col, width=1)
    return text_c, is_light, sun_alt


# ---------- шрифты / текст ----------

def _font(path, size, weight):
    f = ImageFont.truetype(path, size)
    f.set_variation_by_axes([weight])
    return f


def _ts(draw, text, f):
    b = draw.textbbox((0, 0), text, font=f)
    return b[2] - b[0], b[3] - b[1]


def _wrap_px(draw, text, f, max_width):
    words = text.split()
    lines, cur = [], ""
    for w_ in words:
        trial = (cur + " " + w_).strip()
        if _ts(draw, trial, f)[0] <= max_width or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w_
    if cur:
        lines.append(cur)
    return lines


def _fit_font(draw, text, path, weight, start_size, min_size, max_width):
    """Подбирает размер шрифта, чтобы однострочный текст влез в max_width.
    Если даже min_size не влезает — оборачивает в 2 строки на min_size."""
    size = start_size
    while size > min_size:
        f = _font(path, size, weight)
        if _ts(draw, text, f)[0] <= max_width:
            return f, [text]
        size -= 2
    f = _font(path, min_size, weight)
    if _ts(draw, text, f)[0] <= max_width:
        return f, [text]
    return f, _wrap_px(draw, text, f, max_width)


def _draw_stat_card(d, box, c, accent, text_c, f_num_base, f_label_base, f_desc, W):
    cx0, y0, cx1, y1 = box
    cw = cx1 - cx0
    num_font, num_lines = _fit_font(d, c["number"], EXO2, 900, 42, 26, cw - 48)
    lbl_font, lbl_lines = _fit_font(d, c["label"], JURA, 700, 22, 16, cw - 48)
    desc_lines = _wrap_px(d, c["desc"], f_desc, cw - 48)
    num_lh = int(num_font.size * 1.15)
    lbl_lh = int(lbl_font.size * 1.25)
    content_h = (22 + num_lh * len(num_lines) + 14 + lbl_lh * len(lbl_lines) + 16
                 + int(len(desc_lines) * f_desc.size * 1.5) + 20)
    return content_h, (num_font, num_lines, lbl_font, lbl_lines, desc_lines)


def _paint_stat_card(d, box, payload, accent, text_c, panel_fill, border_c, f_desc):
    cx0, y0, cx1, y1 = box
    num_font, num_lines, lbl_font, lbl_lines, desc_lines = payload
    d.rounded_rectangle(box, radius=10, fill=panel_fill)
    d.rounded_rectangle(box, radius=10, outline=border_c, width=1)
    d.rectangle([cx0, y0, cx1, y0 + 4], fill=accent)
    dy = y0 + 22
    num_lh = int(num_font.size * 1.15)
    for line in num_lines:
        d.text((cx0 + 24, dy), line, font=num_font, fill=accent, anchor="la")
        dy += num_lh
    dy += 14
    lbl_lh = int(lbl_font.size * 1.25)
    for line in lbl_lines:
        d.text((cx0 + 24, dy), line, font=lbl_font, fill=accent, anchor="la")
        dy += lbl_lh
    dy += 16
    for line in desc_lines:
        d.text((cx0 + 24, dy), line, font=f_desc, fill=text_c, anchor="la")
        dy += int(f_desc.size * 1.5)


def _measure_list_card(d, box, c, f_label, f_desc, W):
    """type='list': label + маркированный список пунктов (c['items'])."""
    cx0, y0, cx1, y1 = box
    cw = cx1 - cx0
    lbl_font, lbl_lines = _fit_font(d, c["label"], JURA, 700, 22, 16, cw - 48)
    items = c.get("items", [])
    item_wraps = [_wrap_px(d, it, f_desc, cw - 68) for it in items]
    lbl_lh = int(lbl_font.size * 1.25)
    item_lh = int(f_desc.size * 1.5)
    h = 22 + lbl_lh * len(lbl_lines) + 16
    for w_ in item_wraps:
        h += item_lh * len(w_) + 8
    h += 14
    return h, (lbl_font, lbl_lines, item_wraps)


def _paint_list_card(d, box, payload, accent, text_c, panel_fill, border_c, f_desc):
    cx0, y0, cx1, y1 = box
    lbl_font, lbl_lines, item_wraps = payload
    d.rounded_rectangle(box, radius=10, fill=panel_fill)
    d.rounded_rectangle(box, radius=10, outline=border_c, width=1)
    d.rectangle([cx0, y0, cx1, y0 + 4], fill=accent)
    dy = y0 + 22
    lbl_lh = int(lbl_font.size * 1.25)
    for line in lbl_lines:
        d.text((cx0 + 24, dy), line, font=lbl_font, fill=accent, anchor="la")
        dy += lbl_lh
    dy += 16
    item_lh = int(f_desc.size * 1.5)
    for w_ in item_wraps:
        d.ellipse([cx0 + 24, dy + item_lh // 2 - 3, cx0 + 30, dy + item_lh // 2 + 3], fill=accent)
        for j, line in enumerate(w_):
            d.text((cx0 + 42, dy), line, font=f_desc, fill=text_c, anchor="la")
            dy += item_lh
        dy += 8


def _measure_compare_card(d, box, c, f_num, f_label, f_desc, W):
    """type='compare': было/стало — c['before'], c['after'], опц. c['label']."""
    cx0, y0, cx1, y1 = box
    cw = cx1 - cx0
    half_w = (cw - 48 - 30) // 2
    bf_font, bf_lines = _fit_font(d, c["before"], EXO2, 900, 34, 22, half_w)
    af_font, af_lines = _fit_font(d, c["after"], EXO2, 900, 34, 22, half_w)
    lbl_font, lbl_lines = _fit_font(d, c.get("label", ""), JURA, 700, 20, 14, cw - 48) if c.get("label") else (f_label, [])
    top_lh = int(f_desc.size * 1.25)
    val_lh = int(max(bf_font.size, af_font.size) * 1.2)
    lbl_lh = int(lbl_font.size * 1.25)
    h = 22 + top_lh + 10 + val_lh + 14 + lbl_lh * len(lbl_lines) + 20
    return h, (bf_font, bf_lines, af_font, af_lines, lbl_font, lbl_lines, half_w)


def _paint_compare_card(d, box, payload, accent, text_c, muted, panel_fill, border_c, f_desc):
    cx0, y0, cx1, y1 = box
    bf_font, bf_lines, af_font, af_lines, lbl_font, lbl_lines, half_w = payload
    d.rounded_rectangle(box, radius=10, fill=panel_fill)
    d.rounded_rectangle(box, radius=10, outline=border_c, width=1)
    d.rectangle([cx0, y0, cx1, y0 + 4], fill=accent)
    top_lh = int(f_desc.size * 1.25)
    d.text((cx0 + 24, y0 + 22), "БЫЛО", font=f_desc, fill=muted, anchor="la")
    ax = cx0 + 24 + half_w + 30
    d.text((ax, y0 + 22), "СТАЛО", font=f_desc, fill=accent, anchor="la")
    vy = y0 + 22 + top_lh + 10
    for line in bf_lines:
        d.text((cx0 + 24, vy), line, font=bf_font, fill=muted, anchor="la")
        vy += int(bf_font.size * 1.2)
    vy2 = y0 + 22 + top_lh + 10
    for line in af_lines:
        d.text((ax, vy2), line, font=af_font, fill=accent, anchor="la")
        vy2 += int(af_font.size * 1.2)
    # стрелка между колонками
    mid_x = cx0 + 24 + half_w + 15
    mid_y = y0 + 22 + top_lh + 10 + max(int(bf_font.size * 1.2), int(af_font.size * 1.2)) // 2
    d.line([(mid_x - 6, mid_y), (mid_x + 6, mid_y)], fill=accent, width=2)
    d.polygon([(mid_x + 2, mid_y - 4), (mid_x + 8, mid_y), (mid_x + 2, mid_y + 4)], fill=accent)
    dy = max(vy, vy2) + 14
    lbl_lh = int(lbl_font.size * 1.25)
    for line in lbl_lines:
        d.text((cx0 + 24, dy), line, font=lbl_font, fill=text_c, anchor="la")
        dy += lbl_lh


def _draw_multiline_centered(draw, box, lines, f, fill, line_spacing=1.3, padding_x=30):
    x0, y0, x1, y1 = box
    lh = int(f.size * line_spacing)
    total = lh * len(lines)
    cy = (y0 + y1) // 2
    y = cy - total / 2 + lh / 2
    for line in lines:
        draw.text((x0 + padding_x, y), line, font=f, fill=fill, anchor="lm")
        y += lh


# ---------- раскладка карточек / стрелки-коннекторы ----------

_ARROWS = ("→", "←", "↔", "↗", "↘", "⇒", "➜", "➡", "->", "=>")


def _sanitize_text(text) -> str:
    """Заменяет стрелки на «—»: шрифты Exo2/Jura не содержат глифов стрелок,
    иначе в тексте (headline/cards/quote) рендерились бы квадратики-плейсхолдеры."""
    if not text:
        return text
    for a in _ARROWS:
        text = text.replace(a, "—")
    return text


def _card_layout(cards, layout=None) -> list:
    """Гибкая сетка по числу карточек: возвращает список рядов, каждый ряд — список
    индексов в cards.
    - layout (опц.) — список размеров рядов сверху вниз, сумма должна равняться
      числу карточек: [2,2]=2×2, [4]=4 в ряд, [3,3]=2 ряда по 3, [2,2,2]=3 ряда по 2,
      [5]=5 в ряд и т.п. Если задан и корректен — используем его.
    - Иначе автораскладка по числу карточек (n=4 с длинными desc -> 2×2, иначе ряд)."""
    n = len(cards)
    if layout:
        try:
            sizes = [int(x) for x in layout]
        except Exception:
            sizes = []
        if sizes and sum(sizes) == n and all(1 <= s <= 6 for s in sizes):
            rows, i = [], 0
            for s in sizes:
                rows.append(list(range(i, i + s)))
                i += s
            return rows
    if n <= 1:
        return [[0]]
    if n == 2:
        return [[0, 1]]
    if n == 3:
        return [[0, 1, 2]]
    if n == 4:
        descs = [len(c.get("desc", "")) for c in cards if c.get("desc")]
        avg = (sum(descs) / len(descs)) if descs else 0
        if avg > 70:  # в один ряд из 4 карточкам не хватит ширины на текст
            return [[0, 1], [2, 3]]
        return [[0, 1, 2, 3]]
    if n == 5:
        return [[0, 1, 2], [3, 4]]
    if n == 6:
        return [[0, 1, 2], [3, 4, 5]]
    # n > 6 — пары, последний нечётный — одиночный блок
    rows, i = [], 0
    while i < n:
        rows.append([i, i + 1] if i + 1 < n else [i])
        i += 2
    return rows


def _arrowhead(d, tip, direction, accent, tip_len=7, half=3):
    """Маленький треугольный наконечник стрелки в точке tip, направление — unit-вектор."""
    ux, uy = direction
    px, py = -uy, ux
    bx = tip[0] - ux * tip_len
    by = tip[1] - uy * tip_len
    d.polygon([tip,
               (bx + px * half, by + py * half),
               (bx - px * half, by - py * half)], fill=accent)


def _draw_sequence_connectors(d, row_boxes, row_mid, accent):
    """Тонкие стрелки-коннекторы (sequence=true): между соседними карточками внутри
    ряда — горизонтальная стрелка в зазоре gap по вертикальному центру; между рядами —
    ломаная линия вниз-влево к началу следующего ряда. Толщина 2px, цвет = accent."""
    for boxes, mid in zip(row_boxes, row_mid):
        for i in range(len(boxes) - 1):
            xr = boxes[i][2]
            xl = boxes[i + 1][0]
            d.line([(xr, mid), (xl, mid)], fill=accent, width=2)
            _arrowhead(d, (xl, mid), (1, 0), accent)
    for k in range(len(row_boxes) - 1):
        xr = row_boxes[k][-1][2]
        xl = row_boxes[k + 1][0][0]
        y_prev_bot = row_boxes[k][-1][3]
        y_next_top = row_boxes[k + 1][0][1]
        gap_mid = (y_prev_bot + y_next_top) // 2
        pts = [(xr, row_mid[k]), (xr, gap_mid), (xl, gap_mid), (xl, y_next_top)]
        for a, b in zip(pts, pts[1:]):
            d.line([a, b], fill=accent, width=2)
        _arrowhead(d, pts[-1], (0, 1), accent)


# ---------- основная функция ----------

def render_card(data: dict, out_path: str, dt_msk: datetime = None) -> str:
    """
    data = {
      "tags": ["...", "...", "..."],
      "category": "МОШЕННИЧЕСТВО",
      "headline": ["30 млн ₽", "через чат «поликлиника»"],   # 1-2 строки
      "tier": "news" | "real_threat" | "medium" | "safe",
      "cards": [{"number": "...", "label": "...", "desc": "текст описания"}], # 1-6 шт
      "sequence": true, # опц.: стрелки-коннекторы между карточками (последовательность шагов)
      "quote": "текст блока-вывода снизу (может быть пустым)",
      "source": "РИА Новости · 2026",
      "links": ["t.me/TrustNode_team", "vk.com/trustnode"],
      "site": "trustnodelab.github.io"
    }
    """
    if dt_msk is None:
        dt_msk = datetime.utcnow()  # caller решает, приводить ли к MSK

    tier = data.get("tier", "news")
    if tier not in ALLOWED_TIERS:
        print(f"[warn] неизвестный tier от LLM: {tier!r}, использую 'news'", file=sys.stderr)
        tier = "news"
    tags = data["tags"]
    category = data["category"]
    headline = data["headline"]
    cards = data["cards"]
    quote = data.get("quote", "")
    source = data.get("source", "")
    links = data.get("links", [])
    site = data.get("site", "trustnodelab.github.io")

    # стрелки в любом тексте карточки заменяем на «—»: шрифты Exo2/Jura не содержат
    # глифов стрелок, иначе вместо «→» в заголовке/описаниях рисуются квадратики.
    tags = [_sanitize_text(t) for t in tags]
    category = _sanitize_text(category)
    headline = [_sanitize_text(h) for h in headline]
    quote = _sanitize_text(quote)
    source = _sanitize_text(source)
    for c in cards:
        c["number"] = _sanitize_text(c.get("number", ""))
        c["label"] = _sanitize_text(c.get("label", ""))
        c["desc"] = _sanitize_text(c.get("desc", ""))
        c["before"] = _sanitize_text(c.get("before", ""))
        c["after"] = _sanitize_text(c.get("after", ""))
        if c.get("items"):
            c["items"] = [_sanitize_text(i) for i in c["items"]]

    # Черновая канва с запасом по высоте — обрежем по факту контента
    DRAFT_H = 2000
    img = Image.new("RGB", (W, DRAFT_H), (0, 0, 0))
    d = ImageDraw.Draw(img)
    text_c, is_light, sun_alt = _draw_sky(d, W, DRAFT_H, dt_msk)
    accent = ACCENT_LIGHT[tier] if is_light else ACCENT_DARK[tier]
    muted = tuple(int(c * 0.55) for c in text_c) if not is_light else tuple(min(255, int(c * 1.9) + 60) for c in text_c)
    panel_fill = (18, 20, 26) if not is_light else (255, 255, 255)
    border_c = (60, 64, 74) if not is_light else (210, 214, 222)
    # тонировка панелей акцентным цветом темы вместо нейтрального чёрного/белого слэба —
    # лёгкая примесь (8-10%) акцента в базовый фон панели, чтобы карточки визуально
    # принадлежали конкретному посту, а не были одинаковым UI-кубиком везде
    tint_k = 0.08 if not is_light else 0.05
    accent_rgb = tuple(int(accent[j:j+2], 16) for j in (1, 3, 5))
    panel_fill = tuple(int(_lerp(panel_fill[i], accent_rgb[i], tint_k)) for i in range(3))

    # top stripe
    d.rectangle([0, 0, W, 9], fill=accent)

    f_tag = _font(JURA, 24, 700)
    f_sub = _font(JURA, 24, 700)
    f_hl = _font(EXO2, 60, 900)
    f_num = _font(EXO2, 42, 900)
    f_label = _font(JURA, 22, 700)
    f_desc = _font(EXO2, 20, 500)
    f_quote = _font(EXO2, 32, 500)
    f_foot = _font(JURA, 20, 500)
    f_site = _font(JURA, 20, 500)

    # site url top right
    sw, sh = _ts(d, site, f_site)
    d.text((W - 40 - sw, 30), site, font=f_site, fill=muted)

    # tags — переносим на новую строку, если сумма ширин вылезает за канву
    tx, ty = 40, 30
    tag_row_h = 0
    for tag in tags:
        tw, th = _ts(d, tag, f_tag)
        pw, ph = tw + 30, th + 22
        if tx + pw > W - 40 and tx > 40:
            tx = 40
            ty += tag_row_h + 12
            tag_row_h = 0
        d.rounded_rectangle([tx, ty, tx + pw, ty + ph], radius=6, outline=accent, width=2)
        d.text((tx + 15, ty + ph // 2), tag, font=f_tag, fill=accent, anchor="lm")
        tx += pw + 14
        tag_row_h = max(tag_row_h, ph)

    # subtitle
    sy = ty + tag_row_h + 30
    d.text((40, sy), f"// {category}", font=f_sub, fill=accent)

    # headline — каждую логическую строку из data оборачиваем по ширине канвы:
    # LLM иногда присылает вместо «рубленых» коротких строк целое предложение,
    # и без переноса оно вылезает за правый край канвы.
    hy = sy + 55
    y_cursor = hy
    max_hl_width = W - 80
    for i, line in enumerate(headline):
        col = accent if i == 0 else text_c
        wrapped = _wrap_px(d, line, f_hl, max_hl_width)
        for wline in wrapped:
            d.text((40, y_cursor), wline, font=f_hl, fill=col)
            _, lh_ = _ts(d, wline, f_hl)
            y_cursor += lh_ + 18

    # cards: гибкая сетка 1–6 карточек (см. _card_layout). Одиночная карточка в
    # ряду растягивается на всю ширину канвы, парные/тройные делят её с зазором.
    # layout (опц.) — явная матрица из LLM: [2,2]=2×2, [3,3]=2 ряда по 3 и т.п.
    gap = 24
    rows = _card_layout(cards, data.get("layout"))
    cards_y0 = y_cursor + 30

    # высота каждого ряда меряется отдельно по самому длинному описанию в этом ряду
    y = cards_y0
    row_boxes = []
    row_mid = []
    for row in rows:
        ncols = len(row)
        cw = (W - 80) if ncols == 1 else (W - 80 - gap * (ncols - 1)) // ncols
        max_content_h = 0
        wrapped_row = []
        for i in row:
            c = cards[i]
            ctype = c.get("type", "stat")
            if ctype == "list":
                h, payload = _measure_list_card(d, [0, 0, cw, 0], c, f_label, f_desc, W)
            elif ctype == "compare":
                h, payload = _measure_compare_card(d, [0, 0, cw, 0], c, f_num, f_label, f_desc, W)
            else:
                h, payload = _draw_stat_card(d, [0, 0, cw, 0], c, accent, text_c, f_num, f_label, f_desc, W)
            wrapped_row.append((ctype, payload))
            max_content_h = max(max_content_h, h)
        card_h = max(180, max_content_h)
        row_y1 = y + card_h

        cx = 40
        boxes = []
        for ctype, payload in wrapped_row:
            box = [cx, y, cx + cw, row_y1]
            boxes.append(box)
            if ctype == "list":
                _paint_list_card(d, box, payload, accent, text_c, panel_fill, border_c, f_desc)
            elif ctype == "compare":
                _paint_compare_card(d, box, payload, accent, text_c, muted, panel_fill, border_c, f_desc)
            else:
                _paint_stat_card(d, box, payload, accent, text_c, panel_fill, border_c, f_desc)
            cx += cw + gap
        row_boxes.append(boxes)
        row_mid.append((y + row_y1) // 2)
        y = row_y1 + gap

    cards_y1 = y - gap
    y_cursor = cards_y1 + 30

    if data.get("sequence"):
        _draw_sequence_connectors(d, row_boxes, row_mid, accent)

    # quote block (опционален)
    if quote:
        quote_lines = _wrap_px(d, quote, f_quote, W - 80 - 60)
        lh = int(f_quote.size * 1.3)
        qh = max(120, lh * len(quote_lines) + 60)
        qy0, qy1 = y_cursor, y_cursor + qh
        d.rounded_rectangle([40, qy0, W - 40, qy1], radius=10, fill=panel_fill)
        d.rounded_rectangle([40, qy0, W - 40, qy1], radius=10, outline=border_c, width=1)
        d.rectangle([40, qy0, 46, qy1], fill=accent)
        _draw_multiline_centered(d, [40, qy0, W - 40, qy1], quote_lines, f_quote, text_c)
        y_cursor = qy1 + 30

    # footer
    fy = y_cursor
    d.line([(40, fy), (W - 40, fy)], fill=border_c, width=1)
    d.text((40, fy + 22), source, font=f_foot, fill=muted)
    lx = W - 40
    for link in reversed(links):
        lw, _ = _ts(d, link, f_foot)
        lx -= lw
        d.text((lx, fy + 22), link, font=f_foot, fill=accent)
        lx -= 30

    final_h = fy + 22 + 30 + 30
    img = img.crop((0, 0, W, final_h))
    img.save(out_path)
    return out_path
