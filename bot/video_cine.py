"""Cinematic montage engine: вертикальные ролики 9:16 в стиле киношного трейлера.

Принцип: сначала ДРАМАТУРГИЯ И МОНТАЖ, потом кадры. Пайплайн:
    TOPIC -> SCRIPT -> SHOT LIST -> TIMELINE -> RENDER -> AUDIO MIX -> MP4

- plan_shots(): TOPIC -> SHOT LIST. Пробует LLM (bot/llm._complete, строгий
  JSON); при любой ошибке — встроенный шаблон template_shots(), который
  параметризуется ТЕМОЙ (не захардкоженный сценарий: тексты и визуальный
  ряд собираются под topic).
- Каждый shot: {id, act, dur, visual, camera, texts, trans_out, sfx, speed,
  accent, fx}. Рендер — покадровый PIL (никакого внешнего video API
  в проекте нет: весь видеоряд рисуется кодом, как и раньше).
- Переходы: hard_cut / whip / zoom / glitch (только цифровой сбой) /
  dip_to_black / speed_ramp. Подбираются по контексту акта, а не один
  на весь ролик.
- Типографика — часть монтажа: pop / tracking / reveal / rise.
  Крупные короткие фразы, не субтитры.
- Звук: beat-сетка (BPM из пресета), синтезированные SFX (numpy):
  impact / whoosh / riser / click / notify / bass / тишина. Плюс тихий
  битовый bed. Опционально голос поверх (voice_over).

Обратная совместимость: старый generate() из video_gen.py не тронут.
Новый режим включается через --style/--topic (см. video_gen.main).
"""

import math
import os
import random
import re
import struct
import subprocess
import sys
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

import video_gen as vg  # noqa: E402  (переиспользуем шрифты/ffmpeg/mux)
from video_styles import get_style  # noqa: E402

try:
    import numpy as np  # noqa: E402
except Exception:
    np = None

W, H = 1080, 1920
FPS_CINE = 24
SR = 24000  # частота дискретизации синтезированного звука

EXO2 = vg.EXO2
JURA = vg.JURA

_font = vg._font
_wrap = vg._wrap
_ts = vg._ts


# ---------- beat-сетка ----------

def beat_times(bpm, seconds):
    """Времена ударов сетки (сек), начиная с 0."""
    step = 60.0 / max(40, bpm)
    out, t = [], 0.0
    while t <= seconds + 1e-6:
        out.append(round(t, 3))
        t += step
    return out


def snap_cuts(durations, bpm, tol=0.30):
    """Подтягивает монтажные склейки к ближайшему биту (если сдвиг <= tol).

    Монотонность строго сохраняется (склейка не уезжает раньше предыдущей),
    сумма точно равна исходной (финальная перенормировка).
    """
    total = sum(durations)
    if total <= 0:
        return list(durations)
    cuts = []
    acc = 0.0
    for d in durations:
        acc += d
        cuts.append(acc)
    beats = beat_times(bpm, total)
    new_cuts = []
    prev = 0.0
    for c in cuts[:-1]:
        best = min(beats, key=lambda b: abs(b - c))
        if abs(best - c) > tol:
            best = c
        best = max(best, prev + 0.15)  # монотонность: только вперёд
        new_cuts.append(best)
        prev = best
    new_cuts.append(total)
    out = [new_cuts[0]]
    for i in range(1, len(new_cuts)):
        out.append(max(0.15, new_cuts[i] - new_cuts[i - 1]))
    s = sum(out) or 1.0
    return [d * total / s for d in out]


def warp_progress(p, speed):
    """Speed ramp: speed=(start,end). Возвращает искажённый прогресс 0..1.

    end>start — замедление в начале и ускорение в конце (и наоборот).
    """
    p = max(0.0, min(1.0, p))
    s0, s1 = speed or (1.0, 1.0)
    if s0 <= 0 or s1 <= 0:
        return p
    r = s1 / s0
    if abs(r - 1.0) < 1e-6:
        return p
    return 1.0 - (1.0 - p) ** r


# ---------- сценарный план: LLM -> fallback-шаблон ----------

SHOT_SCHEMA_HINT = (
    'Верни ТОЛЬКО валидный JSON без пояснений: {"shots":[{'
    '"act":"hook|problem|escalation|peak|twist|accel|climax",'
    '"dur":2.5,"visual":"phone_dark|phone_message|phone_call|login_screen|'
    'qr_panel|token_panel|chain|attack_grid|server_rack|cables|bokeh|eye|'
    'person|consequence|pause_black|question|final_brand",'
    '"camera":"push_in|push_out|drift|shake|static",'
    '"texts":[{"lines":["СТРОКА 1","СТРОКА 2"],"mode":"pop|tracking|reveal|rise"}],'
    '"trans_out":"hard_cut|whip|zoom|glitch|dip",'
    '"sfx":"impact|whoosh|riser|click|notify|bass|silence|none",'
    '"speed":[1.0,1.0],"accent":"accent|accent2"}]}'
)

_VALID = {
    "act": {"hook", "problem", "escalation", "peak", "twist", "accel", "climax"},
    "visual": {"phone_dark", "phone_message", "phone_call", "login_screen",
               "qr_panel", "token_panel", "chain", "attack_grid", "server_rack",
               "cables", "bokeh", "eye", "person", "consequence",
               "pause_black", "question", "final_brand"},
    "camera": {"push_in", "push_out", "drift", "shake", "static"},
    "trans_out": {"hard_cut", "whip", "zoom", "glitch", "dip"},
    "sfx": {"impact", "whoosh", "riser", "click", "notify", "bass",
            "silence", "none"},
}


def _coerce_shots(raw, seconds):
    """Проверяет и нормализует список шотов от LLM. Бросает ValueError."""
    if not isinstance(raw, list) or not raw:
        raise ValueError("пустой shot list")
    shots = []
    for i, s in enumerate(raw[:40]):
        if not isinstance(s, dict):
            continue
        vis = s.get("visual") if s.get("visual") in _VALID["visual"] else "bokeh"
        texts = []
        for t in (s.get("texts") or [])[:2]:
            if not isinstance(t, dict):
                continue
            lines = [str(x).upper()[:42] for x in (t.get("lines") or [])][:2]
            if not lines:
                continue
            mode = t.get("mode") if t.get("mode") in ("pop", "tracking", "reveal", "rise") else "pop"
            texts.append({"lines": lines, "mode": mode})
        try:
            dur = float(s.get("dur", 1.5))
        except (TypeError, ValueError):
            dur = 1.5
        dur = max(0.3, min(8.0, dur))
        sp = s.get("speed") or [1.0, 1.0]
        try:
            speed = (max(0.2, min(3.0, float(sp[0]))), max(0.2, min(3.0, float(sp[1]))))
        except (TypeError, ValueError, IndexError):
            speed = (1.0, 1.0)
        shots.append({
            "id": f"S{i + 1:02d}",
            "act": s.get("act") if s.get("act") in _VALID["act"] else "problem",
            "dur": dur,
            "visual": vis,
            "camera": s.get("camera") if s.get("camera") in _VALID["camera"] else "push_in",
            "texts": texts,
            "trans_out": s.get("trans_out") if s.get("trans_out") in _VALID["trans_out"] else "hard_cut",
            "sfx": s.get("sfx") if s.get("sfx") in _VALID["sfx"] else "none",
            "speed": speed,
            "accent": "accent2" if s.get("accent") == "accent2" else "accent",
            "fx": "glitch" if s.get("trans_out") == "glitch" else "",
            "seed": 1000 + i * 77,
        })
    if len(shots) < 4:
        raise ValueError("слишком мало шотов")
    # масштабируем длительности под целевую длину
    total = sum(s["dur"] for s in shots)
    k = seconds / max(0.1, total)
    for s in shots:
        s["dur"] = max(0.3, s["dur"] * k)
    return shots


def template_shots(topic, seconds=55, style_name="cybersecurity_cinematic"):
    """Fallback-план: драматургия hook->problem->escalation->peak->twist->
    accel->climax, тексты и визуальный ряд собираются ПОД ТЕМУ topic.

    Это не захардкоженный сценарий: topic подставляется в hook/проблему/
    вопрос, архетипы кадров чередуются детерминированно от хэша темы.
    """
    topic = (topic or "Как вас взламывают").strip()
    short = topic[:48]
    rnd = random.Random(abs(hash(topic)) % (2 ** 32))
    # окна актов масштабируются под реальную длину (база — 55 сек)
    k = max(0.4, seconds / 55.0)

    def sc(act, dur, visual, camera, texts, trans_out, sfx="none",
           speed=(1.0, 1.0), accent="accent", fx=""):
        return {"act": act, "dur": dur, "visual": visual, "camera": camera,
                "texts": texts, "trans_out": trans_out, "sfx": sfx,
                "speed": speed, "accent": accent, "fx": fx}

    def tx(*lines, mode="pop"):
        return [{"lines": [l.upper()[:42] for l in lines], "mode": mode}]

    hook_line = short.upper()[:42]
    prob = ["phone_message", "phone_call", "login_screen", "person"]
    rnd.shuffle(prob)
    chain_labels = ["MESSAGE", "CLICK", "LOGIN", "TOKEN", "ACCESS"]
    peak_pool = ["attack_grid", "qr_panel", "token_panel", "server_rack",
                 "phone_call", "cables", "eye", "login_screen"]
    rnd.shuffle(peak_pool)

    shots = [
        # 0-3с: HOOK — максимально сильный удар, без логотипа
        sc("hook", 2.8 * k, "phone_dark", "push_in",
           tx("ВАС УЖЕ МОГУТ", "ВЗЛОМАТЬ", mode="tracking"), "hard_cut",
           "impact", (0.7, 1.3)),
        # 3-10с: проблема
        sc("problem", 1.8 * k, prob[0], "push_in",
           tx(hook_line, mode="reveal"), "whip", "whoosh"),
        sc("problem", 1.6 * k, prob[1], "drift",
           tx("И НАЖИМАТЬ НИЧЕГО", "НЕ ПРИДЁТСЯ", mode="pop"), "hard_cut", "click"),
        sc("problem", 1.7 * k, prob[2], "push_out",
           tx("ДОСТАТОЧНО ОДНОГО", "СООБЩЕНИЯ", mode="rise"), "whip", "notify"),
        sc("problem", 1.6 * k, prob[3], "push_in", [], "zoom", "bass", (1.2, 0.8)),
        # 10-20с: ускорение, цепочка атаки
        sc("escalation", 1.7 * k, "chain", "static",
           tx(chain_labels[0], mode="pop"), "hard_cut", "click"),
        sc("escalation", 1.5 * k, "chain", "static",
           tx(chain_labels[1], chain_labels[2], mode="pop"), "hard_cut", "click"),
        sc("escalation", 1.8 * k, "chain", "push_in",
           tx(chain_labels[3], chain_labels[4], mode="pop"), "whip", "impact", (1.0, 1.5)),
        sc("escalation", 2.0 * k, "qr_panel", "push_in",
           tx("ОДИН QR —", "И ДОСТУП У НИХ", mode="reveal"), "zoom", "whoosh"),
        # 20-30с: ПИК ДИНАМИКИ, очень короткие кадры
        sc("peak", 1.0 * k, peak_pool[0], "shake", [], "hard_cut", "impact", (1.4, 1.4), "accent2"),
        sc("peak", 0.8 * k, peak_pool[1], "shake", [], "hard_cut", "click", (1.5, 1.5)),
        sc("peak", 0.9 * k, peak_pool[2], "push_in", [], "whip", "notify", (1.4, 1.4), "accent2"),
        sc("peak", 0.7 * k, peak_pool[3], "shake", [], "hard_cut", "bass", (1.6, 1.6)),
        sc("peak", 1.0 * k, peak_pool[4], "drift",
           tx("СЕССИЯ УКРАДЕНА", mode="tracking"), "glitch", "impact", (1.3, 1.3),
           "accent2", fx="glitch"),
        sc("peak", 0.9 * k, peak_pool[5], "push_in", [], "hard_cut", "whoosh", (1.5, 1.5)),
        sc("peak", 1.1 * k, "attack_grid", "static",
           tx("ДОСТУП РАЗРЕШЁН", mode="pop"), "dip", "bass", (1.2, 0.6), "accent2"),
        # 30-35с: РЕЗКАЯ ПАУЗА
        sc("twist", 4.2 * k, "pause_black", "static",
           tx("НО САМОЕ СТРАШНОЕ...", mode="reveal"), "dip", "silence", (0.4, 0.4)),
        sc("twist", 2.2 * k, "eye", "push_in",
           tx("ДВЕРЬ ИМ ОТКРОЕТЕ", "ВЫ САМИ", mode="tracking"), "zoom",
           "impact", (0.5, 1.8)),
        # 35-50с: ФИНАЛЬНОЕ УСКОРЕНИЕ, масштаб растёт
        sc("accel", 2.4 * k, "consequence", "push_in",
           tx("1 ОШИБКА", mode="pop"), "hard_cut", "bass", (1.0, 1.4)),
        sc("accel", 2.4 * k, "consequence", "push_in",
           tx("1 АККАУНТ", mode="pop"), "whip", "impact", (1.0, 1.4)),
        sc("accel", 2.6 * k, "consequence", "push_in",
           tx("1 УСТРОЙСТВО", mode="pop"), "whip", "impact", (1.0, 1.5), "accent2"),
        sc("accel", 3.0 * k, "consequence", "push_out",
           tx("ВСЯ СИСТЕМА", mode="tracking"), "zoom", "riser", (0.8, 1.6), "accent2"),
        # 50-60с: КУЛЬМИНАЦИЯ + ПАНЧ
        sc("climax", 2.6 * k, "question", "push_in",
           tx("ТАК КТО КОГО", "ЗАЩИЩАЕТ?", mode="tracking"), "dip",
           "bass", (0.6, 1.0)),
        sc("climax", 3.0 * k, "question", "static",
           tx("ВЫ — СИСТЕМУ.", "ИЛИ ОНА — ВАС?", mode="reveal"), "dip",
           "silence", (0.5, 0.7)),
        sc("climax", 3.2 * k, "final_brand", "push_out", [], "hard_cut", "impact", (0.7, 1.0)),
    ]
    total = sum(s["dur"] for s in shots)
    out = []
    for i, s in enumerate(shots):
        s = dict(s)
        s["id"] = f"S{i + 1:02d}"
        # подгон под seconds делает generate_cinematic; тут только id/seed
        s["seed"] = (abs(hash(topic)) + i * 131) % (2 ** 32)
        out.append(s)
    return out


def plan_shots(topic, seconds=55, style_name="cybersecurity_cinematic",
               use_llm=True, provider=None):
    """TOPIC -> SHOT LIST: сначала LLM, при любой ошибке — шаблон по теме."""
    if use_llm:
        try:
            from llm import _complete  # noqa: PLC0415 (опционально, только в проде)
            prompt = (
                f"Ты — режиссёр монтажа cybersecurity-трейлера 9:16 на {seconds} сек. "
                f"Тема ролика: «{topic}». Разбей на акты hook/problem/escalation/"
                f"peak/twist/accel/climax: сильный hook 0-3с, пик динамики 20-30с "
                f"(кадры 0.3-1.2с), резкая пауза 30-35с, кульминация в конце. "
                f"Тексты оверлея — крупно, по-русски, ЗАГЛАВНЫМИ, максимум 2 короткие "
                f"строки на шот (это НЕ субтитры). Никаких Matrix/хакеров в капюшонах/"
                f"зелёных терминалов. {SHOT_SCHEMA_HINT}"
            )
            raw = _complete([{"role": "user", "content": prompt}], provider)
            m = re.search(r"\{.*\}", raw, re.S)
            data = __import__("json").loads(m.group(0) if m else raw)
            shots = _coerce_shots(data.get("shots"), seconds)
            print(f"[cine] LLM-план: {len(shots)} шотов по теме «{topic}»")
            for i, s in enumerate(shots):
                s["id"] = f"S{i + 1:02d}"
                s.setdefault("seed", 2000 + i * 91)
            return shots
        except Exception as e:
            print(f"[cine] LLM-план недоступен ({type(e).__name__}: {e}) — шаблон по теме")
    return template_shots(topic, seconds, style_name)


# ---------- художники сцен (всё рисуется кодом, без внешних ассетов) ----------

def _vignette(img, strength=0.55):
    import math as _m
    w, h = img.size
    ov = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(ov)
    cx, cy = w / 2, h / 2
    maxd = _m.hypot(cx, cy)
    for r in range(0, int(maxd), 24):
        a = int(255 * strength * (r / maxd) ** 2)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=a)
    black = Image.new("RGB", (w, h), (0, 0, 0))
    return Image.composite(black, img, ov)


def _grain(img, seed, n=420, alpha=26):
    rnd = random.Random(seed)
    w, h = img.size
    ov = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for _ in range(n):
        x, y = rnd.randrange(w), rnd.randrange(h)
        v = rnd.randrange(150, 255)
        d.point((x, y), fill=(v, v, v, alpha))
    return Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")


def _glow_spot(base, x, y, r, color, alpha=90):
    ov = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for i in range(6, 0, -1):
        rr = r * i // 6
        d.ellipse([x - rr, y - rr, x + rr, y + rr],
                  fill=color + (alpha * (7 - i) // 36 + 8,))
    return Image.alpha_composite(base, ov)


def _bg(P, seed, deep=False):
    """Тёмный кинематографичный фон: вертикальный градиент + свечение."""
    c0 = P["bg_deep"] if deep else P["bg"]
    c1 = P["bg"]
    img = Image.new("RGB", (W, H))
    d = ImageDraw.Draw(img)
    for y in range(0, H, 4):
        t = y / H
        d.line([(0, y), (W, y + 4)],
               fill=tuple(int(c0[i] + (c1[i] - c0[i]) * t) for i in range(3)))
    rnd = random.Random(seed)
    gx, gy = rnd.randrange(W), rnd.randrange(H // 3, 2 * H // 3)
    img = _glow_spot(img.convert("RGBA"), gx, gy, 480, P["accent"], 46).convert("RGB")
    return img


def _bokeh_layer(d, seed, P, n=26, y_band=None):
    rnd = random.Random(seed)
    for _ in range(n):
        x = rnd.randrange(0, W)
        y = rnd.randrange(*y_band) if y_band else rnd.randrange(0, H)
        r = rnd.randrange(8, 60)
        col = P["accent"] if rnd.random() < 0.3 else (90, 110, 150)
        d.ellipse([x - r, y - r, x + r, y + r], outline=col + (70,), width=2)


def _phone_frame(d, P, cx, cy, pw=420, ph=840, glow=None):
    """Корпус смартфона + тёмный экран. Возвращает (x0, y0, pw, ph) экрана."""
    x0, y0 = cx - pw // 2, cy - ph // 2
    d.rounded_rectangle([x0 - 26, y0 - 26, x0 + pw + 26, y0 + ph + 26],
                        radius=64, fill=(16, 22, 38), outline=P["line"], width=3)
    d.rounded_rectangle([x0, y0, x0 + pw, y0 + ph], radius=44, fill=(4, 7, 14))
    if glow:
        d.rounded_rectangle([x0, y0, x0 + pw, y0 + ph], radius=44, outline=glow, width=4)
    d.rounded_rectangle([cx - 90, y0 + 14, cx + 90, y0 + 44], radius=15, fill=(4, 7, 14),
                        outline=P["line"], width=2)
    return x0, y0, pw, ph


def _paint_phone_screen(d, kind, box, P, f_s, f_xs, p, rnd, accent):
    x0, y0, pw, ph = box
    pad = 44
    if kind == "message":
        # всплывающее сообщение
        slide = int((1 - min(1.0, p * 2.2)) * 120)
        by = y0 + 220 + slide
        d.rounded_rectangle([x0 + pad, by, x0 + pw - pad, by + 250], radius=28, fill=(22, 32, 56))
        d.ellipse([x0 + pad + 24, by + 30, x0 + pad + 104, by + 110], fill=accent)
        d.text((x0 + pad + 130, by + 34), "БАНК", font=f_s, fill=(240, 244, 252))
        d.rectangle([x0 + pad + 24, by + 140, x0 + pw - pad - 60, by + 158], fill=(120, 135, 165))
        d.rectangle([x0 + pad + 24, by + 176, x0 + pw - pad - 140, by + 194], fill=(90, 105, 135))
        if p > 0.45:  # красная точка уведомления
            rr = 16 + int(6 * math.sin(p * 20))
            d.ellipse([x0 + pw - pad - 40, by + 20, x0 + pw - pad - 40 + 2 * rr, by + 20 + 2 * rr],
                      fill=P.get("accent2") or (255, 80, 80))
    elif kind == "call":
        d.ellipse([x0 + pw // 2 - 90, y0 + 220, x0 + pw // 2 + 90, y0 + 400], outline=accent, width=5)
        _center_text(d, y0 + 450, "ВХОДЯЩИЙ ВЫЗОВ", f_xs, P["sub"], x0 + pw // 2)
        _center_text(d, y0 + 510, "+7 ••• •• 90", f_s, (240, 244, 252), x0 + pw // 2)
        d.rounded_rectangle([x0 + 60, y0 + 620, x0 + pw - 60, y0 + 700], radius=40, fill=accent)
        _center_text(d, y0 + 642, "ОТВЕТИТЬ", f_s, (6, 8, 14), x0 + pw // 2)
    elif kind == "login":
        _center_text(d, y0 + 180, "МОЙ БАНК", f_s, (240, 244, 252), x0 + pw // 2)
        for j, Stars in enumerate(("•••• 4821", "••••••••")):
            fy = y0 + 300 + j * 130
            d.rounded_rectangle([x0 + pad, fy, x0 + pw - pad, fy + 96], radius=20,
                                outline=P["line"] if j else accent, width=3)
            d.text((x0 + pad + 28, fy + 24), Stars, font=f_s, fill=(200, 210, 230))
        d.rounded_rectangle([x0 + pad, y0 + 580, x0 + pw - pad, y0 + 676], radius=24, fill=accent)
        _center_text(d, y0 + 606, "ВОЙТИ", f_s, (6, 8, 14), x0 + pw // 2)
    elif kind == "qr":
        qs, qn = 300, 21
        qx, qy = x0 + (pw - qs) // 2, y0 + 250
        d.rectangle([qx - 24, qy - 24, qx + qs + 24, qy + qs + 24], fill=(235, 240, 250))
        cell = qs / qn
        for r_ in range(qn):
            for c_ in range(qn):
                in_finder = (r_ < 7 and c_ < 7) or (r_ < 7 and c_ >= qn - 7) or (r_ >= qn - 7 and c_ < 7)
                on = in_finder or rnd.random() < 0.42
                if on:
                    d.rectangle([qx + c_ * cell, qy + r_ * cell,
                                 qx + (c_ + 1) * cell, qy + (r_ + 1) * cell], fill=(8, 10, 16))
        _center_text(d, qy + qs + 50, "СКАНИРУЙТЕ ДЛЯ ВХОДА", f_xs, P["sub"], x0 + pw // 2)
    elif kind == "token":
        _center_text(d, y0 + 220, "КОД ИЗ SMS", f_xs, P["sub"], x0 + pw // 2)
        code = "482 910"
        _center_text(d, y0 + 300, code, _font(EXO2, 84, 900), accent, x0 + pw // 2)
        bw = int((pw - 2 * pad) * (1 - p))
        d.rectangle([x0 + pad, y0 + 470, x0 + pad + bw, y0 + 484], fill=accent)
        _center_text(d, y0 + 540, "никому не сообщайте", f_xs, P["sub"], x0 + pw // 2)


def _center_text(d, y, text, f, fill, cx):
    w_, _ = _ts(d, text, f)
    d.text((cx - w_ // 2, y), text, font=f, fill=fill)


def paint_scene(visual, p, seed, P, fonts, accent_key="accent"):
    """Рисует один кадр сцены. p — локальный прогресс 0..1 (уже с warp)."""
    accent = P["accent2"] if accent_key == "accent2" and P.get("accent2") else P["accent"]
    f_h = fonts["hero"]
    f_s = fonts["sub"]
    f_xs = fonts["xs"]
    rnd = random.Random(seed)
    img = _bg(P, seed, deep=visual in ("pause_black", "final_brand", "question"))
    d = ImageDraw.Draw(img, "RGBA")

    if visual == "phone_dark":
        _bokeh_layer(d, seed + 1, P, 18)
        box = _phone_frame(d, P, W // 2, H // 2 + 120, glow=accent)
        _paint_phone_screen(d, "message", box, P, f_s, f_xs, 0.0, rnd, accent)
        # красное свечение-тревога нарастает
        img = _glow_spot(img.convert("RGBA"), W // 2, H // 2 + 120, int(300 + 200 * p),
                         P.get("accent2") or accent, int(30 + 50 * p)).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
    elif visual in ("phone_message", "phone_call", "login_screen", "qr_panel", "token_panel"):
        kind = {"phone_message": "message", "phone_call": "call",
                "login_screen": "login", "qr_panel": "qr",
                "token_panel": "token"}[visual]
        _bokeh_layer(d, seed + 2, P, 14)
        box = _phone_frame(d, P, W // 2, H // 2 + 60, glow=accent)
        _paint_phone_screen(d, kind, box, P, f_s, f_xs, p, random.Random(seed + 9), accent)
    elif visual == "chain":
        labels = ["MESSAGE", "CLICK", "LOGIN", "TOKEN", "ACCESS"]
        _bokeh_layer(d, seed + 3, P, 12)
        y = H // 2
        d.line([(80, y), (W - 80, y)], fill=P["line"], width=6)
        n = len(labels)
        active = min(n - 1, int(p * n))
        for i, lab in enumerate(labels):
            x = 80 + i * (W - 160) // (n - 1)
            on = i <= active
            col = accent if on else P["line"]
            r_ = 34 if on else 24
            d.ellipse([x - r_, y - r_, x + r_, y + r_], fill=(10, 16, 30), outline=col, width=5)
            lw, _ = _ts(d, lab, f_xs)
            d.text((x - lw // 2, y + 70), lab, font=f_xs, fill=(240, 244, 252) if on else P["sub"])
        # бегущий импульс
        ix = 80 + p * (W - 160)
        img = _glow_spot(img.convert("RGBA"), int(ix), y, 90, accent, 80).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
    elif visual == "attack_grid":
        kinds = ["message", "login", "qr", "call"]
        cells = [(40, 220, 480, 700), (560, 220, 480, 700), (40, 980, 480, 700), (560, 980, 480, 700)]
        act_idx = min(3, int(p * 4.2))
        for j, ((cx, cy, cw, chh), kd) in enumerate(zip(cells, kinds)):
            on = j == act_idx
            d.rounded_rectangle([cx, cy, cx + cw, cy + chh], radius=24,
                                fill=(8, 13, 25), outline=accent if on else P["line"],
                                width=5 if on else 2)
            mini = (cx + 40, cy + 60, cw - 80, chh - 160)
            _paint_phone_screen(d, kd, mini, P, f_xs, f_xs, (p * 3 + j * 0.3) % 1.0,
                                random.Random(seed + j), accent if on else P["sub"])
        _center_text(d, 90, "АТАКА // 4 ВЕКТОРА", f_s, accent, W // 2)
    elif visual == "server_rack":
        _bokeh_layer(d, seed + 4, P, 10)
        for r_ in range(8):
            y = 300 + r_ * 170
            d.rounded_rectangle([140, y, W - 140, y + 130], radius=14, fill=(10, 16, 30),
                                outline=P["line"], width=2)
            for u in range(6):
                x = 200 + u * 120
                led = accent if ((r_ * 7 + u * 3 + int(p * 12)) % 5 == 0) else (40, 60, 95)
                d.ellipse([x, y + 50, x + 30, y + 80], fill=led)
                d.rectangle([x + 44, y + 58, x + 100, y + 72], fill=(30, 42, 68))
    elif visual == "cables":
        for j in range(7):
            y0 = 300 + j * 200
            pts = [(0, y0 + rnd.randrange(-60, 60))]
            for x in range(120, W + 120, 120):
                pts.append((x, y0 + rnd.randrange(-90, 90)))
            d.line(pts, fill=P["line"] if j % 2 else accent, width=5 if j % 2 == 0 else 3)
        # бегущий свет по кабелям
        px = int(p * W)
        d.line([(px, 200), (px, H - 200)], fill=accent, width=6)
    elif visual == "bokeh":
        _bokeh_layer(d, seed + 5, P, 40)
        img = _glow_spot(img.convert("RGBA"), W // 2, H // 2, 420, accent, 60).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
    elif visual == "eye":
        cx, cy = W // 2, H // 2 - 100
        for i, rr in enumerate((300, 230, 160, 100)):
            col = accent if i % 2 == 0 else P["line"]
            d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=col, width=4)
        pr = int(60 + 20 * p)
        d.ellipse([cx - pr, cy - pr, cx + pr, cy + pr], fill=accent)
        d.line([(cx - 300, cy - 120), (cx - 60, cy - 40)], fill=(220, 235, 255), width=8)
        _center_text(d, cy + 400, "ВЫ САМИ", f_s, P["sub"], cx)
    elif visual == "person":
        # абстрактный силуэт с контровым светом + светящийся телефон в руке
        cx = W // 2
        d.ellipse([cx - 130, 480, cx + 130, 740], fill=(8, 11, 20), outline=accent, width=4)
        d.rounded_rectangle([cx - 220, 780, cx + 220, 1420], radius=120, fill=(8, 11, 20),
                            outline=accent, width=4)
        d.rounded_rectangle([cx + 90, 1050, cx + 250, 1330], radius=30, fill=(30, 60, 120),
                            outline=accent, width=3)
        img = _glow_spot(img.convert("RGBA"), cx + 170, 1190, 220, accent, 70).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
    elif visual == "consequence":
        cx, cy = W // 2, H // 2 - 60
        for i in range(4):
            rr = int((200 + i * 130) * (0.6 + 0.4 * p))
            d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=accent, width=3)
        img = _glow_spot(img.convert("RGBA"), cx, cy, int(200 + 260 * p), accent, 90).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
    elif visual == "pause_black":
        d.rectangle([0, 0, W, H], fill=(1, 2, 4))
        pulse = 0.5 + 0.5 * math.sin(p * math.pi * 2)
        d.line([(W // 2 - 120, H // 2 + 420), (W // 2 + 120, H // 2 + 420)],
               fill=accent, width=int(2 + 4 * pulse))
    elif visual == "question":
        _bokeh_layer(d, seed + 6, P, 16)
        d.ellipse([W // 2 - 260, H // 2 - 500, W // 2 + 260, H // 2 + 20],
                  outline=accent, width=6)
        _center_text(d, H // 2 - 330, "?", _font(EXO2, 300, 900), accent, W // 2)
    elif visual == "final_brand":
        _bokeh_layer(d, seed + 7, P, 20)
        _center_text(d, H // 2 - 140, "TRUSTNODE", _font(EXO2, 120, 900), (245, 248, 255), W // 2)
        d.rectangle([W // 2 - 200, H // 2 + 40, W // 2 + 200, H // 2 + 52], fill=accent)
        _center_text(d, H // 2 + 120, "КИБЕРБЕЗОПАСНОСТЬ", f_s, accent, W // 2)
        _center_text(d, H // 2 + 190, "ПРОСТЫМИ СЛОВАМИ", f_s, P["sub"], W // 2)

    img = _vignette(img)
    img = _grain(img, seed)
    return img


# ---------- kinetic typography ----------

def draw_texts(img, texts, p, fonts, P):
    """Крупная типографика поверх кадра. p — прогресс шота 0..1."""
    if not texts:
        return
    d = ImageDraw.Draw(img, "RGBA")
    f_big = fonts["big"]
    n = len(texts)
    for k, t in enumerate(texts):
        lines, mode = t["lines"], t.get("mode", "pop")
        zone_h = 320
        y_base = H // 2 - (n * zone_h) // 2 + k * zone_h
        q = min(1.0, p / 0.3) if p < 0.3 else 1.0
        alpha = int(255 * min(1.0, p / 0.12))
        for j, line in enumerate(lines):
            f = f_big
            lw, lh = _ts(d, line, f)
            if lw > W - 120:
                f = fonts["big2"]
                lw, lh = _ts(d, line, f)
            y = y_base + j * (lh + 26)
            x = (W - lw) // 2
            # тёмная подложка — текст читается на любом фоне
            d.rounded_rectangle([x - 34, y - 18, x + lw + 34, y + lh + 18],
                                radius=22, fill=(3, 5, 10, 190))
            if mode == "pop":
                sc = 0.6 + 0.4 * (1 - (1 - q) ** 3)
                tmp = Image.new("RGBA", (lw + 80, lh + 60), (0, 0, 0, 0))
                td = ImageDraw.Draw(tmp)
                td.text((40, 30), line, font=f, fill=(245, 248, 255, alpha))
                nw, nh = max(1, int(tmp.width * sc)), max(1, int(tmp.height * sc))
                tmp = tmp.resize((nw, nh), Image.BICUBIC)
                img.paste(tmp, ((W - nw) // 2, int(y + (lh - nh) // 2)), tmp)
            elif mode == "tracking":
                gap = int(46 * (1 - q))
                draw_tracked(d, line, f, y, gap, alpha)
            elif mode == "reveal":
                if q < 1.0:
                    # сначала шторка: текст виден частично
                    tmp = Image.new("RGBA", (lw + 40, lh + 40), (0, 0, 0, 0))
                    td = ImageDraw.Draw(tmp)
                    td.text((20, 20), line, font=f, fill=(245, 248, 255, alpha))
                    vis = int(tmp.width * q)
                    if vis > 0:
                        img.paste(tmp.crop((0, 0, vis, tmp.height)),
                                  (x - 20, y - 20), tmp.crop((0, 0, vis, tmp.height)))
                else:
                    d.text((x, y), line, font=f, fill=(245, 248, 255, alpha))
            else:  # rise
                yy = int(y + 90 * (1 - q))
                d.text((x, yy), line, font=f, fill=(245, 248, 255, alpha))


def draw_tracked(d, line, f, y, gap, alpha):
    widths = [_ts(d, ch, f)[0] for ch in line]
    total = sum(widths) + gap * max(0, len(line) - 1)
    x = (W - total) // 2
    for ch, cw in zip(line, widths):
        d.text((x, y), ch, font=f, fill=(245, 248, 255, alpha))
        x += cw + gap


# ---------- камера и переходы ----------

def apply_camera(img, camera, p, seed, frame_i):
    """Движение камеры как пост-трансформация кадра."""
    if camera == "static":
        return img
    if camera == "shake":
        rnd = random.Random(seed + frame_i)
        dx, dy = rnd.randrange(-9, 10), rnd.randrange(-9, 10)
        out = Image.new("RGB", (W, H), (0, 0, 0))
        out.paste(img, (dx, dy))
        return out
    if camera == "drift":
        dx = int(-40 * p)
        big = img.resize((W + 80, H), Image.BICUBIC)
        return big.crop((80 + dx, 0, 80 + dx + W, H))
    # push_in / push_out
    s = (1.0 + 0.14 * p) if camera == "push_in" else (1.14 - 0.14 * p)
    bw, bh = int(W * s), int(H * s)
    big = img.resize((bw, bh), Image.BICUBIC)
    return big.crop(((bw - W) // 2, (bh - H) // 2, (bw - W) // 2 + W, (bh - H) // 2 + H))


def _rgb_split(img, dx):
    r, g, b = img.split()
    r = r.transform((W, H), Image.AFFINE, (1, 0, -dx, 0, 1, 0))
    b = b.transform((W, H), Image.AFFINE, (1, 0, dx, 0, 1, 0))
    return Image.merge("RGB", (r, g, b))


def transition_frame(img_a, img_b, kind, q, seed):
    """Один кадр перехода A->B. q — прогресс 0..1."""
    q = max(0.0, min(1.0, q))
    if kind == "hard_cut":
        return img_b if q >= 0.5 else img_a
    if kind == "dip":
        black = Image.new("RGB", (W, H), (0, 0, 0))
        if q < 0.5:
            return Image.blend(img_a, black, q * 2)
        return Image.blend(black, img_b, (q - 0.5) * 2)
    if kind == "whip":
        # B влетает справа, A уходит влево + motion-streaks
        ax = -int(W * 0.35 * q)
        bx = int(W * (1 - q))
        out = Image.new("RGB", (W, H), (0, 0, 0))
        out.paste(img_a, (ax, 0))
        out.paste(img_b, (bx, 0))
        d = ImageDraw.Draw(out, "RGBA")
        rnd = random.Random(seed)
        for _ in range(26):
            y = rnd.randrange(H)
            d.line([(0, y), (W, y)], fill=(150, 180, 230, int(60 * q * (1 - q) * 4)))
        return out
    if kind == "zoom":
        # наезд сквозь A в B
        sa = 1.0 + 0.55 * q
        ba = img_a.resize((int(W * sa), int(H * sa)), Image.BICUBIC)
        ba = ba.crop(((ba.width - W) // 2, (ba.height - H) // 2,
                      (ba.width - W) // 2 + W, (ba.height - H) // 2 + H))
        sb = 0.82 + 0.18 * q
        bb = img_b.resize((max(1, int(W * sb)), max(1, int(H * sb))), Image.BICUBIC)
        canvas = Image.new("RGB", (W, H), (0, 0, 0))
        canvas.paste(bb, ((W - bb.width) // 2, (H - bb.height) // 2))
        return Image.blend(ba, canvas, min(1.0, q * 1.4))
    if kind == "glitch":
        # короткий цифровой сбой: RGB-split + сдвиг полос (только тут!)
        base = img_b if q >= 0.4 else img_a
        out = _rgb_split(base, int(14 * (1 - abs(q - 0.5) * 2)))
        d = ImageDraw.Draw(out)
        rnd = random.Random(seed + int(q * 10))
        for _ in range(5):
            y = rnd.randrange(H)
            hh = rnd.randrange(8, 60)
            dx = rnd.randrange(-70, 70)
            strip = out.crop((0, y, W, min(H, y + hh)))
            out.paste(strip, (dx, y))
        return out
    return img_b


# ---------- звук: beat-bed + синтезированные SFX ----------

def _sine(f0, f1, n, sr):
    if np is None:
        return None
    t = np.arange(n) / sr
    if f1 is None or f1 == f0:
        return np.sin(2 * np.pi * f0 * t)
    sweep = f0 + (f1 - f0) * t / max(1, len(t) / sr)
    phase = np.cumsum(2 * np.pi * sweep / sr)
    return np.sin(phase)


def _env(n, attack=0.005, decay=None):
    if np is None:
        return None
    a = max(1, int(n * attack))
    e = np.ones(n)
    e[:a] = np.linspace(0, 1, a)
    d = n if decay is None else min(n, int(n * decay))
    e[-d:] *= np.linspace(1, 0, d) ** 2
    return e


def synth_sfx(kind, sr=SR):
    """Возвращает numpy int16 mono сэмплы эффекта (или None)."""
    if np is None:
        return None
    if kind == "impact":
        n = int(sr * 0.7)
        kick = _sine(58, 34, n, sr) * _env(n, 0.002)
        noise = np.random.default_rng(7).standard_normal(n) * _env(n, 0.001, 0.25) * 0.5
        return ((kick * 0.9 + noise * 0.5) * 30000).astype(np.int16)
    if kind == "whoosh":
        n = int(sr * 0.35)
        noise = np.random.default_rng(11).standard_normal(n)
        hp = np.diff(noise, prepend=0)
        e = np.sin(np.pi * np.arange(n) / n) ** 2
        return ((hp * e * 0.8) * 22000).astype(np.int16)
    if kind == "riser":
        n = int(sr * 1.0)
        s = _sine(180, 1400, n, sr)
        e = (np.arange(n) / n) ** 2
        return ((s * e * 0.55) * 24000).astype(np.int16)
    if kind == "click":
        n = int(sr * 0.07)
        blip = _sine(2100, 1400, n, sr) * _env(n, 0.01, 0.9)
        return ((blip * 0.5) * 22000).astype(np.int16)
    if kind == "notify":
        n = int(sr * 0.4)
        s = np.zeros(n)
        n1 = int(sr * 0.16)
        s[:n1] = _sine(880, 880, n1, sr) * _env(n1, 0.01, 0.7)
        s[n1:n1 * 2] = _sine(1318, 1318, n1, sr) * _env(n1, 0.01, 0.7)
        return ((s * 0.5) * 22000).astype(np.int16)
    if kind == "bass":
        n = int(sr * 0.9)
        s = _sine(48, 40, n, sr) * _env(n, 0.004, 0.8)
        return ((s * 0.95) * 30000).astype(np.int16)
    return None


def build_soundtrack(shots, bounds, seconds, bpm, pause_win=None, sr=SR):
    """Микс: тёмный beat-bed по сетке + SFX на склейках. Возвращает int16 mono."""
    if np is None:
        return None
    n = int(seconds * sr)
    mix = np.zeros(n, dtype=np.float64)
    beats = beat_times(bpm, seconds)
    # bed: кик на каждый бит + саб-дрон
    for b in beats:
        i = int(b * sr)
        k = synth_sfx("bass", sr)
        if b and pause_win and pause_win[0] <= b <= pause_win[1]:
            continue  # в паузе — тишина (бит выпадает)
        m = min(len(k), n - i)
        if m > 0 and i < n:
            mix[i:i + m] += k[:m].astype(np.float64) * 0.35
    t = np.arange(n) / sr
    drone = (np.sin(2 * np.pi * 55 * t) * 0.5 + np.sin(2 * np.pi * 82.5 * t) * 0.3)
    drone *= (0.7 + 0.3 * np.sin(2 * np.pi * 0.15 * t))
    if pause_win:
        i0, i1 = int(pause_win[0] * sr), min(n, int(pause_win[1] * sr))
        drone[i0:i1] *= 0.15
    mix += drone * 2600
    # SFX на склейках (время конца каждого шота, кроме последнего)
    for s, end in zip(shots, bounds[1:]):
        if s["sfx"] in ("none", "silence") or end >= seconds - 0.2:
            continue
        sfx = synth_sfx(s["sfx"], sr)
        if sfx is None:
            continue
        i = int(end * sr)
        m = min(len(sfx), n - i)
        if m > 0 and i < n:
            mix[i:i + m] += sfx[:m].astype(np.float64) * 0.8
    mix = np.clip(mix, -32768, 32767)
    return mix.astype(np.int16)


def write_wav(path, samples, sr=SR):
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes(samples.tobytes())


# ---------- сборка таймлайна и рендер ----------

def build_fonts():
    return {
        "hero": _font(EXO2, 150, 900),
        "big": _font(EXO2, 118, 900),
        "big2": _font(EXO2, 88, 900),
        "sub": _font(JURA, 40, 700),
        "xs": _font(JURA, 32, 500),
    }


TRANS_DUR = {"hard_cut": 0.08, "whip": 0.35, "zoom": 0.4, "glitch": 0.3, "dip": 0.5}


def render_frame(shot, p, fonts, P):
    """Один кадр тела шота: сцена + камера + типографика."""
    pw = warp_progress(p, shot.get("speed", (1.0, 1.0)))
    img = paint_scene(shot["visual"], pw, shot.get("seed", 1), P, fonts,
                      shot.get("accent", "accent"))
    img = apply_camera(img, shot.get("camera", "push_in"), pw,
                       shot.get("seed", 1), int(p * 1000))
    if shot.get("texts"):
        draw_texts(img, shot["texts"], p, fonts, P)
    return img


def build_timeline(shots, seconds, fps, bpm):
    """Раскладка: тела шотов + переходы. Возвращает (segments, bounds, total).

    segments: [{kind:'body', shot, n}, {kind:'trans', a, b, trans, n}...]
    bounds: времена концов шотов (для SFX).
    """
    durs = snap_cuts([s["dur"] for s in shots], bpm)
    for s, d in zip(shots, durs):
        s["dur"] = d
    # времена склеек
    bounds, acc = [0.0], 0.0
    for d in durs:
        acc += d
        bounds.append(round(acc, 3))
    segments = []
    for i, s in enumerate(shots):
        want = max(3, int(round(s["dur"] * fps)))
        td = TRANS_DUR.get(s.get("trans_out", "hard_cut"), 0.1) if i < len(shots) - 1 else 0.0
        n_trans = max(1, int(round(td * fps))) if td > 0 else 0
        # переход не должен раздувать хронометраж: тело+переход = want кадров
        n_trans = min(n_trans, max(1, want - 2))
        n_body = max(2, want - n_trans)
        segments.append({"kind": "body", "shot": s, "n": n_body})
        if n_trans and i < len(shots) - 1:
            segments.append({"kind": "trans", "a": s, "b": shots[i + 1],
                             "trans": s.get("trans_out", "hard_cut"), "n": n_trans})
    # финальный холд: добиваем ровно до целевой длины, чтобы видео
    # совпадало с аудио (иначе -shortest в mux обрежет финал)
    have = sum(sg["n"] for sg in segments)
    hold_n = max(0, int(round(seconds * fps)) - have)
    segments.append({"kind": "hold", "shot": shots[-1], "n": hold_n})
    total = sum(sg["n"] for sg in segments)
    return segments, bounds, total


def render_cinematic(shots, seconds, fps, out_silent, bpm, P, tmpdir="out/tmp_cine"):
    ffmpeg = vg.find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("нет ffmpeg: pip install imageio-ffmpeg")
    fonts = build_fonts()
    segments, bounds, total = build_timeline(shots, seconds, fps, bpm)
    print(f"[cine] рендер {total} кадров ({W}x{H}, {fps} fps, ~{total / fps:.1f} c), "
          f"шотов: {len(shots)}...")
    cmd = [ffmpeg, "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{W}x{H}", "-framerate", str(fps), "-i", "-",
           "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
           "-preset", "medium", "-crf", "20", out_silent]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    done = 0
    for sg in segments:
        if sg["kind"] == "body":
            s = sg["shot"]
            for j in range(sg["n"]):
                p = j / max(1, sg["n"] - 1)
                proc.stdin.write(render_frame(s, p, fonts, P).tobytes())
                done += 1
        elif sg["kind"] == "trans":
            a, b = sg["a"], sg["b"]
            img_a = render_frame(a, 1.0, fonts, P)
            img_b = render_frame(b, 0.0, fonts, P)
            for j in range(sg["n"]):
                q = (j + 1) / sg["n"]
                proc.stdin.write(
                    transition_frame(img_a, img_b, sg["trans"], q, b.get("seed", 1)).tobytes())
                done += 1
        else:  # hold
            img = render_frame(sg["shot"], 1.0, fonts, P)
            raw = img.tobytes()
            for _ in range(sg["n"]):
                proc.stdin.write(raw)
                done += 1
        if done % 120 == 0:
            print(f"[cine] ...{done}/{total}")
    proc.stdin.close()
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg вернул ошибку при кодировании видео")
    print(f"[cine] видео готово: {out_silent}")
    return out_silent, bounds


def generate_cinematic(topic=None, seconds=55, style="cybersecurity_cinematic",
                       out="out/video_cine.mp4", fps=FPS_CINE,
                       voice=vg.VOICE_DEFAULT, no_audio=False, voice_over=None,
                       tmpdir="out/tmp_cine", script_shots=None, provider=None):
    """Главная точка входа: тема -> cinematic-ролик MP4."""
    import shutil as _sh
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    os.makedirs(tmpdir, exist_ok=True)
    st, key = get_style(style)
    P = st["palette"]
    bpm = st.get("bpm", 100)
    topic = (topic or "Как вас взламывают через фишинг").strip()
    shots = list(script_shots) if script_shots else plan_shots(topic, seconds, key, True, provider)
    # подгон длительностей под целевую длину: масштаб -> минимум 0.3с ->
    # повторный масштаб вниз при перелёте (clamp не должен раздувать хронометраж)
    total_plan = sum(s["dur"] for s in shots)
    k = seconds / max(0.1, total_plan)
    for s in shots:
        s["dur"] = max(0.3, s["dur"] * k)
    total_plan = sum(s["dur"] for s in shots)
    if total_plan > seconds:
        k2 = seconds / total_plan
        for s in shots:
            s["dur"] = max(0.2, s["dur"] * k2)
    # окно паузы (twist) — для просадки бита
    pause_win = None
    acc = 0.0
    for s in shots:
        if s["act"] == "twist" and pause_win is None:
            pause_win = (acc, acc + s["dur"])
        acc += s["dur"]
    ffmpeg = vg.find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("нет ffmpeg: pip install imageio-ffmpeg")
    silent = os.path.join(tmpdir, "silent.mp4")
    _, bounds = render_cinematic(shots, seconds, fps, silent, bpm, P, tmpdir)
    real_dur = bounds[-1]
    if no_audio or np is None:
        if np is None:
            print("[cine] numpy нет — видео без звука")
        _sh.copy(silent, out)
    else:
        mix = build_soundtrack(shots, bounds, real_dur, bpm, pause_win)
        bed_wav = os.path.join(tmpdir, "bed.wav")
        write_wav(bed_wav, mix)
        if voice_over is None:
            voice_over = bool(st.get("voice_over"))
        if voice_over:
            # голос поверх бита (переиспользуем посекционный TTS из video_gen)
            secs = [{"voice": " ".join(sum([t["lines"] for t in s.get("texts", [])], [])) or s["act"],
                     "caption": s["id"]} for s in shots]
            secs = [x for x in secs if x["voice"].strip()] or None
            if secs:
                vmp3, _w = vg.make_voiceover_sections(ffmpeg, secs, voice, tmpdir)
                if vmp3:
                    # микшируем голос поверх bed
                    vw = os.path.join(tmpdir, "voice.wav")
                    r = subprocess.run(
                        [ffmpeg, "-y", "-i", vmp3, "-ar", str(SR), "-ac", "1", vw],
                        capture_output=True)
                    if r.returncode == 0:
                        with wave.open(vw, "rb") as wf:
                            raw = wf.readframes(wf.getnframes())
                        vv = np.frombuffer(raw, dtype=np.int16).astype(np.float64) * 1.1
                        m = min(len(vv), len(mix))
                        mix2 = mix.astype(np.float64)
                        mix2[:m] += vv[:m]
                        mix2 = np.clip(mix2, -32768, 32767).astype(np.int16)
                        write_wav(bed_wav, mix2)
        vg.mux_audio(ffmpeg, silent, bed_wav, out, real_dur)
    size = os.path.getsize(out)
    print(f"[cine] ГОТОВО: {out} ({size / 1048576:.1f} MB, {real_dur:.1f} c, стиль {key})")
    return out


def generate_video(topic, duration=55, style="cybersecurity_cinematic", **kw):
    """Алиас в духе generateVideo({topic, duration, style})."""
    return generate_cinematic(topic=topic, seconds=duration, style=style, **kw)
