"""Тестовая функция: генерация 30-секундного видео «футуристичный сайт».

Концепция: бот рисует вымышленный футуристичный сайт (PIL, стиль TrustNode),
затем «листает» его сверху вниз на видео, накладывая русскую озвучку,
синхронизированную со скроллом по секциям.

Использование:
    python bot/video_gen.py                  # 30 сек, out/video_test.mp4
    python bot/video_gen.py --seconds 10     # короткая версия
    python bot/video_gen.py --smoke          # быстрая проверка (6 сек, 10 fps)
    python bot/video_gen.py --no-audio       # без озвучки (без сети)
    python bot/video_gen.py --script-file article.txt   # видео из своего текста:
                               # длина = длина озвучки, скролл синхронен ей

Свой сценарий: обычный текст или статья. `# Заголовок` начинает раздел,
без заголовков текст режется на части ~600 символов. Каждая часть —
блок на «сайте» + кусок озвучки; скролл идёт ровно под озвучку
(время показа части = длительность её аудио), поэтому ничего не лагает:
кадр в секунду всегда соответствует произносимому тексту.

Плавность: 24 fps по умолчанию (было 15 — отсюда рывки скролла).

Зависимости (не входят в requirements.txt прод-контура):
    pip install imageio-ffmpeg edge-tts numpy
ffmpeg-бинарник берётся из imageio-ffmpeg, иначе системный ffmpeg
(GitHub ubuntu-latest имеет системный ffmpeg из коробки).
Озвучка — edge-tts (нужна сеть до Microsoft). Без сети — видео без звука.
"""

import argparse
import asyncio
import math
import os
import re
import shutil
import subprocess
import sys
import traceback
from fractions import Fraction

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

# ---------- константы ----------

W, H = 1080, 1920          # вертикальное видео (формат клипов/шортсов)
FPS_DEFAULT = 60           # 60 fps: плавный монтаж (эталон TikTok HEVC 60fps; --fps 120 опция)
BG = (11, 18, 32)
PANEL = (19, 28, 48)
ACCENT = (255, 210, 74)
TEXT = (242, 245, 250)
SUB = (138, 147, 166)
LINE = (41, 52, 78)

FONTS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "fonts")
EXO2 = os.path.join(FONTS_DIR, "Exo2-Variable.ttf")
JURA = os.path.join(FONTS_DIR, "Jura-Variable.ttf")

VOICE_DEFAULT = "ru-RU-DmitryNeural"
# M26-C: суперреалистичный голос через ElevenLabs (опция).
# Активируется env ELEVENLABS_API_KEY (иначе edge-tts бесплатный).
# Русский поддерживается моделью multilingual_v2 на любом голосе.
ELEVENLABS_URL = "https://api.elevenlabs.io/v1/text-to-speech"
ELEVENLABS_MODEL = "eleven_multilingual_v2"
# Голос по умолчанию: Daniel — Steady Broadcaster (диктор-документалист).
# Список: api.elevenlabs.io/v1/voices (без ключа отдаёт premade).
ELEVENLABS_VOICE = os.environ.get("ELEVENLABS_VOICE_ID",
                                  "onwK4e9ZLuTAKqWW03F9")

# S34: VoiceStudio (OmniVoice) — локальный Docker-сервер TTS (порт 3900),
# бесплатная альтернатива ElevenLabs: клонирование голоса, 600+ языков.
# OpenAI-совместимый API: POST /v1/audio/speech. Активируется
# TTS_PROVIDER=voicestudio. VOICESTUDIO_URL — адрес сервера
# (дефолт 127.0.0.1:3900/v1), VOICESTUDIO_VOICE — имя голоса или путь
# к референс-wav (3-10 сек) для клонирования.
VOICESTUDIO_URL = os.environ.get("VOICESTUDIO_URL", "http://127.0.0.1:3900/v1")
VOICESTUDIO_VOICE = os.environ.get("VOICESTUDIO_VOICE", "alloy")
VOICESTUDIO_TIMEOUT = int(os.environ.get("VOICESTUDIO_TIMEOUT", "640"))


def _font(path, size, weight):
    f = ImageFont.truetype(path, size)
    try:
        f.set_variation_by_axes([weight])
    except Exception:
        pass
    return f


def _ts(d, text, f):
    b = d.textbbox((0, 0), text, font=f)
    return b[2] - b[0], b[3] - b[1]


def _wrap(d, text, f, max_width):
    words = text.split()
    lines, cur = [], ""
    for w_ in words:
        trial = (cur + " " + w_).strip()
        if _ts(d, trial, f)[0] <= max_width or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w_
    if cur:
        lines.append(cur)
    return lines


def _center(d, y, text, f, fill, cx=W // 2):
    w_, _ = _ts(d, text, f)
    d.text((cx - w_ // 2, y), text, font=f, fill=fill)
    return y


# ---------- контент: секции сайта + озвучка ----------

SECTIONS = [
    {
        "id": "hero",
        "caption": "Главная",
        "voice": (
            "Траст Нод. Студия цифровой безопасности. "
            "Это сайт будущего: тёмная тема, неон и ничего лишнего."
        ),
    },
    {
        "id": "stats",
        "caption": "Цифры",
        "voice": (
            "Цифры говорят сами. Круглосуточный мониторинг угроз, "
            "больше сотни разборов и ноль сложных слов."
        ),
    },
    {
        "id": "features",
        "caption": "Возможности",
        "voice": (
            "Листаем вниз. Дайджесты, разборы атак и гайды. "
            "Каждый блок — коротко и по делу."
        ),
    },
    {
        "id": "showcase",
        "caption": "Свежий разбор",
        "voice": (
            "Свежий разбор недели. Как устроена фишинговая атака "
            "и как не попасться. Читается за три минуты."
        ),
    },
    {
        "id": "steps",
        "caption": "Как это работает",
        "voice": (
            "Всё просто. Читай, понимай, защищайся. "
            "Три шага до спокойствия за свои данные."
        ),
    },
    {
        "id": "cta",
        "caption": "Финал",
        "voice": (
            "Подписывайся на Траст Нод. Кибербезопасность простыми словами."
        ),
    },
]


def build_site():
    """Рисует высокий «сайт» (1080 x ~4600), возвращает (img, anchors).

    anchors: список {caption, y_top} — верх секции в координатах сайта,
    используется для синхронизации скролла и озвучки.
    """
    site = Image.new("RGB", (W, 4600), BG)
    d = ImageDraw.Draw(site)

    f_nav = _font(JURA, 30, 700)
    f_hero = _font(EXO2, 92, 900)
    f_sub = _font(JURA, 36, 500)
    f_h2 = _font(EXO2, 64, 900)
    f_num = _font(EXO2, 120, 900)
    f_card_t = _font(EXO2, 44, 900)
    f_card_d = _font(JURA, 32, 500)
    f_btn = _font(JURA, 34, 700)
    f_step = _font(EXO2, 40, 900)

    anchors = []
    y = 0

    def grid(yy, step=120):
        for gx in range(0, W + 1, step):
            d.line([(gx, yy), (gx, yy + 1)], fill=(16, 26, 46))
        return yy

    # --- HERO ---
    anchors.append({"caption": "Главная", "y_top": 0})
    for i in range(0, W, 4):
        c = 11 + int(8 * (1 - abs(i - W / 2) / (W / 2)))
        d.line([(i, 0), (i, 1050)], fill=(c, c + 7, c + 20))
    d.rectangle([0, 0, W, 110], fill=(8, 13, 25))
    d.text((48, 34), "TRUSTNODE", font=f_nav, fill=ACCENT)
    for j, dot in enumerate(["•", "•", "•"]):
        d.text((W - 200 + j * 55, 34), dot, font=f_nav, fill=SUB)
    d.rectangle([48, 1050 - 8, W - 48, 1050], fill=ACCENT)
    _center(d, 220, "КИБЕР-", f_hero, TEXT)
    _center(d, 330, "БЕЗОПАСНОСТЬ", f_hero, ACCENT)
    _center(d, 440, "ПРОСТЫМИ СЛОВАМИ", f_hero, TEXT)
    _center(d, 600, "Сайт будущего: тёмная тема, неон,", f_sub, SUB)
    _center(d, 650, "короткие разборы и ноль воды", f_sub, SUB)
    d.rounded_rectangle([W // 2 - 260, 770, W // 2 + 260, 770 + 110], radius=24, fill=ACCENT)
    _center(d, 800, "СМОТРЕТЬ РАЗБОРЫ", f_btn, (17, 17, 17), W // 2)
    y = 1050

    # --- STATS ---
    anchors.append({"caption": "Цифры", "y_top": y})
    _center(d, y + 70, "// ЦИФРЫ", f_sub, ACCENT)
    stats = [("24/7", "мониторинг угроз"), ("120+", "разборов атак"), ("0", "сложных слов")]
    bw = (W - 96 - 2 * 32) // 3
    for i, (num, lbl) in enumerate(stats):
        x0 = 48 + i * (bw + 32)
        d.rounded_rectangle([x0, y + 170, x0 + bw, y + 500], radius=20, fill=PANEL, outline=LINE, width=2)
        nw, _ = _ts(d, num, f_num)
        fs = f_num
        if nw > bw - 40:
            fs = _font(EXO2, 84, 900)
            nw, _ = _ts(d, num, fs)
        d.text((x0 + (bw - nw) // 2, y + 215), num, font=fs, fill=ACCENT)
        for ln in _wrap(d, lbl, f_card_d, bw - 48):
            lw, _ = _ts(d, ln, f_card_d)
            d.text((x0 + (bw - lw) // 2, y + 380), ln, font=f_card_d, fill=SUB)
            y_tmp = y + 380 + 44
            break
    y += 590

    # --- FEATURES ---
    anchors.append({"caption": "Возможности", "y_top": y})
    _center(d, y + 40, "// ВОЗМОЖНОСТИ", f_sub, ACCENT)
    feats = [
        ("ДАЙДЖЕСТЫ", "Главное за день одним постом"),
        ("РАЗБОРЫ АТАК", "Как работают мошенники"),
        ("ГАЙДЫ", "Настрой защиту за 5 минут"),
    ]
    for i, (t, desc) in enumerate(feats):
        yy = y + 130 + i * 300
        d.rounded_rectangle([48, yy, W - 48, yy + 260], radius=20, fill=PANEL, outline=LINE, width=2)
        d.rectangle([48, yy + 24, 48 + 12, yy + 236], fill=ACCENT)
        d.text((110, yy + 40), t, font=f_card_t, fill=TEXT)
        d.text((110, yy + 120), desc, font=f_card_d, fill=SUB)
    y += 130 + 3 * 300 + 60

    # --- SHOWCASE ---
    anchors.append({"caption": "Свежий разбор", "y_top": y})
    _center(d, y + 30, "// СВЕЖИЙ РАЗБОР", f_sub, ACCENT)
    d.rounded_rectangle([48, y + 120, W - 48, y + 640], radius=24, fill=PANEL, outline=ACCENT, width=3)
    for ln in _wrap(d, "Фишинг: письмо от «банка»", f_card_t, W - 260):
        d.text((110, y + 180), ln, font=f_card_t, fill=ACCENT)
        break
    d.text((110, y + 260), "Проверяй адрес отправителя", font=f_card_d, fill=TEXT)
    d.text((110, y + 320), "Не переходи по ссылкам из письма", font=f_card_d, fill=TEXT)
    d.text((110, y + 380), "Звони в банк сам, а не им", font=f_card_d, fill=TEXT)
    d.rounded_rectangle([110, y + 470, 560, y + 560], radius=16, outline=ACCENT, width=2)
    d.text((150, y + 493), "ЧИТАТЬ 3 МИН", font=f_btn, fill=ACCENT)
    y += 700

    # --- STEPS ---
    anchors.append({"caption": "Как это работает", "y_top": y})
    _center(d, y + 30, "// КАК ЭТО РАБОТАЕТ", f_sub, ACCENT)
    steps = [("01", "ЧИТАЙ"), ("02", "ПОЙМИ"), ("03", "ЗАЩИТИСЬ")]
    for i, (num, t) in enumerate(steps):
        yy = y + 120 + i * 230
        d.ellipse([90, yy + 20, 90 + 130, yy + 150], outline=ACCENT, width=4)
        nw, nh = _ts(d, num, f_step)
        d.text((90 + (130 - nw) // 2, yy + 20 + (130 - nh) // 2), num, font=f_step, fill=ACCENT)
        d.text((270, yy + 55), t, font=f_h2, fill=TEXT)
        if i < 2:
            d.line([(155, yy + 170), (155, yy + 230)], fill=LINE, width=4)
    y += 120 + 3 * 230 + 40

    # --- CTA / FOOTER ---
    anchors.append({"caption": "Финал", "y_top": y})
    d.rounded_rectangle([48, y + 40, W - 48, y + 380], radius=24, fill=(30, 34, 14), outline=ACCENT, width=3)
    _center(d, y + 100, "ПОДПИШИСЬ НА TRUSTNODE", f_card_t, ACCENT)
    _center(d, y + 180, "Кибербезопасность простыми словами.", f_card_d, TEXT)
    d.rounded_rectangle([W // 2 - 220, y + 250, W // 2 + 220, y + 340], radius=20, fill=ACCENT)
    _center(d, y + 275, "ПОДПИСАТЬСЯ", f_btn, (17, 17, 17), W // 2)
    _center(d, y + 430, "СТУДИЯ ЦИФРОВОЙ БЕЗОПАСНОСТИ", f_nav, SUB)
    y += 560

    site = site.crop((0, 0, W, y))
    for yy in range(0, y, 120):
        pass
    return site, anchors


# ---------- свой сценарий: текст/статья пользователя ----------

SCRIPT_SECTION_MAX = 600  # макс. символов тела секции (дальше — новая «Часть»)


def parse_script(text):
    """Режет произвольный текст на секции [{heading, body, voice, caption}].

    Строка `# Заголовок` начинает новую секцию; без заголовков текст
    чанкуется по ~600 символов, а если это короткий сценарий без # —
    режется на ≤4 предложения-секции (short 4-sentence). voice — то, что
    произносит диктор.
    """
    text = (text or "").replace("\r\n", "\n").strip()
    if not text:
        raise ValueError("пустой сценарий")
    # Short без #: 4 (или меньше) коротких предложения → ровно по одному
    # предложению на секцию, максимум 4 секции.
    if "#" not in text:
        sents = [p.strip() for p in
                 re.split(r"(?<=[.!?…])\s+", text) if p.strip()]
        if 1 < len(sents) <= 4:
            out = []
            for i, sent in enumerate(sents, 1):
                out.append({"heading": f"Часть {i}", "body": sent,
                            "voice": sent, "caption": sent[:40]})
            return out
        if len(sents) > 4:
            # больше 4 — берём первые 4 предложения (вся суть в 4)
            out = []
            for i, sent in enumerate(sents[:4], 1):
                out.append({"heading": f"Часть {i}", "body": sent,
                            "voice": sent, "caption": sent[:40]})
            return out
    raw = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    paras = []
    for p in raw:
        if p.startswith("#"):
            # M17: допускаем "# Заголовок\nтекст" без пустой строки
            # (так обычно вставляют статьи) — остаток идёт в тело
            head, _, rest = p.partition("\n")
            paras.append({"head": head.lstrip("#").strip() or "Раздел"})
            rest = re.sub(r"\s+", " ", rest).strip()
            if rest:
                paras.append({"body": rest})
        elif p:
            paras.append({"body": re.sub(r"\s+", " ", p)})
    sections, cur = [], {"heading": None, "body": []}

    def body_len():
        return sum(len(b) + 1 for b in cur["body"])

    def flush():
        if cur["body"] or cur["heading"]:
            cur["body"] and sections.append(
                {"heading": cur["heading"], "body": " ".join(cur["body"]).strip()})

    for p in paras:
        if "head" in p:
            flush()
            cur = {"heading": p["head"], "body": []}
        else:
            if cur["body"] and body_len() + len(p["body"]) > SCRIPT_SECTION_MAX:
                flush()
                cur = {"heading": None, "body": []}
            cur["body"].append(p["body"])
    flush()
    out = []
    n = 0
    for s in sections:
        if not s["body"]:
            continue
        # M18: длинное тело без абзацев (инлайн-статья из /cine: воркер
        # схлопывает переводы строк) — режем на части ≤600 по предложениям
        bodies = [s["body"]]
        if len(s["body"]) > SCRIPT_SECTION_MAX:
            sents = [p.strip() for p in
                     re.split(r"(?<=[.!?…;:])\s+", s["body"]) if p.strip()]
            units = []
            for sent in sents:
                if len(sent) <= SCRIPT_SECTION_MAX:
                    units.append(sent)
                else:
                    wcur = ""
                    for w in sent.split():
                        t = (wcur + " " + w).strip()
                        if len(t) <= SCRIPT_SECTION_MAX:
                            wcur = t
                        else:
                            units.append(wcur)
                            wcur = w
                    if wcur:
                        units.append(wcur)
            bodies, cur = [], ""
            for u in units:
                t = (cur + " " + u).strip()
                if len(t) <= SCRIPT_SECTION_MAX:
                    cur = t
                else:
                    if cur:
                        bodies.append(cur)
                    cur = u
            if cur:
                bodies.append(cur)
            bodies = bodies or [s["body"][:SCRIPT_SECTION_MAX]]
        for bi, body in enumerate(bodies):
            n += 1
            first = s["heading"] and bi == 0
            head = s["heading"] if first else f"Часть {n}"
            voice = f"{head}. {body}" if first else body
            out.append({"heading": head, "body": body, "voice": voice,
                        "caption": head[:40]})
    if not out:
        raise ValueError("в сценарии нет текста")
    return out


def build_site_custom(sections, title="Видеоразбор"):
    """Строит высокий «сайт» из секций сценария. Возвращает (img, anchors)."""
    site = Image.new("RGB", (W, 16000), BG)
    d = ImageDraw.Draw(site)

    f_nav = _font(JURA, 30, 700)
    f_hero = _font(EXO2, 84, 900)
    f_sub = _font(JURA, 36, 500)
    f_h2 = _font(EXO2, 56, 900)
    f_body = _font(JURA, 34, 500)

    anchors = [{"caption": "Начало", "y_top": 0}]
    for i in range(0, W, 4):
        c = 11 + int(8 * (1 - abs(i - W / 2) / (W / 2)))
        d.line([(i, 0), (i, 1050)], fill=(c, c + 7, c + 20))
    d.rectangle([0, 0, W, 110], fill=(8, 13, 25))
    d.text((48, 34), "TRUSTNODE", font=f_nav, fill=ACCENT)
    for j, dot in enumerate(["•", "•", "•"]):
        d.text((W - 200 + j * 55, 34), dot, font=f_nav, fill=SUB)
    d.rectangle([48, 1050 - 8, W - 48, 1050], fill=ACCENT)
    for ln in _wrap(d, title.upper(), f_hero, W - 160):
        tw, th = _ts(d, ln, f_hero)
        d.text(((W - tw) // 2, 260), ln, font=f_hero, fill=TEXT)
        break
    _center(d, 560, "видеоразбор статьи", f_sub, SUB)
    d.rounded_rectangle([W // 2 - 260, 700, W // 2 + 260, 810], radius=24, fill=ACCENT)
    _center(d, 730, "СМОТРЕТЬ", f_nav, (17, 17, 17), W // 2)
    y = 1050

    for s in sections:
        anchors.append({"caption": s["caption"], "y_top": y})
        _center(d, y + 50, f"// {s['heading'][:34].upper()}", f_sub, ACCENT)
        yy = y + 140
        for para in s["body"].split(". "):
            for ln in _wrap(d, para.strip(), f_body, W - 160):
                d.text((80, yy), ln, font=f_body, fill=TEXT)
                yy += 52
            yy += 26
        yy += 60
        d.rectangle([80, yy, W - 80, yy + 6], fill=LINE)
        y = yy + 120

    _center(d, y + 40, "СТУДИЯ ЦИФРОВОЙ БЕЗОПАСНОСТИ", f_nav, SUB)
    y += 200
    return site.crop((0, 0, W, y)), anchors


# ---------- озвучка (посекционная, с замером длительностей) ----------

async def _tts_many(items, voice, tmpdir):
    from edge_tts import Communicate

    async def one(i, s):
        out = os.path.join(tmpdir, f"sec_{i}.mp3")
        # M19: интонация по чанкам (rate/pitch/volume), по умолчанию ровно
        await Communicate(
            s["voice"], voice,
            rate=s.get("rate", "+20%"), pitch=s.get("pitch", "+0Hz"),
            volume=s.get("volume", "+0%")).save(out)
        return out

    # S28: последовательный вызов + retry при NoAudioReceived
    # asyncio.gather шлёт всё одновременно → edge-tts блокирует при >5-8
    import asyncio as _aio
    results = []
    for i, s in enumerate(items):
        for attempt in range(3):
            try:
                r = await one(i, s)
                results.append(r)
                break
            except Exception as e:
                if attempt < 2:
                    print(f"[video] TTS retry {attempt+1} sec_{i}: {e}")
                    await _aio.sleep(1.5 * (attempt + 1))
                else:
                    print(f"[video] TTS FAILED sec_{i}: {e}")
                    results.append(None)
    return results


def _tts_elevenlabs(items, voice, tmpdir):
    """ElevenLabs-озвучка (реалистичный голос, multilingual_v2, русский).

    Возвращает список mp3-файлов как _tts_many. Параметры чанков
    (rate/pitch/volume) у ElevenLabs нет — реализм берётся самой моделью;
    voice = voice_id (если не передан/дефолтный — ELEVENLABS_VOICE).
    """
    import requests
    key = os.environ.get("ELEVENLABS_API_KEY", "")
    if not key:
        raise RuntimeError("нет ELEVENLABS_API_KEY")
    vid = voice if (voice and voice != VOICE_DEFAULT) else ELEVENLABS_VOICE
    outs = []
    for i, s in enumerate(items):
        path = os.path.join(tmpdir, f"sec_{i}.mp3")
        r = requests.post(
            f"{ELEVENLABS_URL}/{vid}",
            headers={"xi-api-key": key, "Content-Type": "application/json"},
            json={"text": s["voice"],
                  "model_id": ELEVENLABS_MODEL,
                  "voice_settings": {"stability": 0.45,
                                     "similarity_boost": 0.8}},
            timeout=90)
        r.raise_for_status()
        with open(path, "wb") as fh:
            fh.write(r.content)
        outs.append(path)
        print(f"[video] elevenlabs {i + 1}/{len(items)} ok ({len(r.content)} B)")
    return outs


def _tts_voicestudio(items, voice, tmpdir):
    """VoiceStudio (OmniVoice) — локальный Docker-сервер, OpenAI-совместимый API.

    Возвращает список mp3-файлов как _tts_elevenlabs. voice = имя голоса
    (пресет) или путь к референс-wav (3-10 сек) для клонирования.
    Таймауты щедрые: на CPU генерация медленная (по умолчанию 640 сек).
    """
    import time as _time
    import requests
    base = VOICESTUDIO_URL.rstrip("/")
    vid = voice if (voice and voice != VOICE_DEFAULT) else VOICESTUDIO_VOICE
    # Список доступных голосов — для отладки (в GH Actions этот вызов дешёвый)
    try:
        rv = requests.get(f"{base}/audio/voices", timeout=15)
        if rv.status_code == 200:
            voices = rv.json()
            if isinstance(voices, list):
                print(f"[video] voicestudio голоса ({len(voices)}): "
                      f"{', '.join(str(v.get('id', v)) if isinstance(v, dict) else str(v) for v in voices[:12])}")
            else:
                print(f"[video] voicestudio голоса: {str(voices)[:200]}")
    except Exception as e:
        print(f"[video] voicestudio /voices недоступен: {e}")
    outs = []
    ffmpeg = find_ffmpeg()
    for i, s in enumerate(items):
        path = os.path.join(tmpdir, f"sec_{i}.mp3")
        wav_path = os.path.join(tmpdir, f"sec_{i}.wav")
        last_err = None
        for attempt in range(3):
            try:
                r = requests.post(
                    f"{base}/audio/speech",
                    headers={"Content-Type": "application/json"},
                    json={"model": "tts-1", "voice": vid,
                          "input": s["voice"], "response_format": "wav",
                          "speed": 1.08},
                    timeout=VOICESTUDIO_TIMEOUT)
                r.raise_for_status()
                with open(wav_path, "wb") as fh:
                    fh.write(r.content)
                if not r.content:
                    raise RuntimeError("пустой ответ сервера")
                # wav -> mp3 (единый формат для склейки в make_voiceover_sections).
                # -ar/-ac обязательны: сервер отдаёт wav с произвольной частотой,
                # а sil/lead/tail и concat-склейка считают 24 кГц моно.  Без
                # нормализации чанки несопоставимы по параметрам и склейка падает.
                r2 = subprocess.run(
                    [ffmpeg, "-y", "-i", wav_path, "-c:a", "libmp3lame",
                     "-ar", "24000", "-ac", "1", path],
                    capture_output=True)
                if r2.returncode != 0 or not os.path.exists(path) or os.path.getsize(path) < 100:
                    err_tail = (r2.stderr or b"").decode("utf-8", "replace")[-400:]
                    raise RuntimeError(
                        f"конвертация wav->mp3 не удалась (rc={r2.returncode}, "
                        f"wav={os.path.getsize(wav_path)}B): {err_tail}")
                last_err = None
                break
            except Exception as e:
                last_err = e
                print(f"[video] voicestudio retry {attempt + 1}/3 sec_{i}: {e}")
                if attempt < 2:
                    _time.sleep(3 * (attempt + 1))
        if last_err is not None and not os.path.exists(path):
            print(f"[video] voicestudio FAILED sec_{i}: {last_err}")
            outs.append(None)
        else:
            outs.append(path)
            print(f"[video] voicestudio {i + 1}/{len(items)} ok ({vid})")
        if os.path.exists(wav_path):
            os.remove(wav_path)
    return outs


# S31: Silero TTS — бесплатный нейросетевой голос, без API-ключей.
# Speakers: eugene (муж. диктор), aidar, baya, kseniya, xenia.
# pip install silero (или torch.hub.load) — модель ~200MB, работает на CPU.
SILERO_VOICE = os.environ.get("SILERO_VOICE", "eugene")
SILERO_MODEL = None  # lazy-loaded singleton


def _tts_silero(items, voice, tmpdir):
    """Silero TTS — офлайн-озвучка (русский, v5_5_ru, auto-stress).

    Возвращает список mp3-файлов. voice = speaker name (aidar/baya/kseniya/xenia/eugene).
    """
    global SILERO_MODEL
    try:
        if SILERO_MODEL is None:
            # Try pip package first, then torch.hub
            try:
                from silero import silero_tts
                SILERO_MODEL, _ = silero_tts(language='ru', speaker='v5_5_ru')
            except ImportError:
                import torch
                SILERO_MODEL = torch.hub.load(
                    repo_or_dir='snakers4/silero-models',
                    model='silero_tts',
                    language='ru',
                    speaker='v5_5_ru')
        spk = voice if (voice and voice != VOICE_DEFAULT) else SILERO_VOICE
        ffmpeg = find_ffmpeg()
        outs = []
        for i, s in enumerate(items):
            path = os.path.join(tmpdir, f"sec_{i}.mp3")
            wav_path = os.path.join(tmpdir, f"sec_{i}.wav")
            audio = SILERO_MODEL.apply_tts(text=s["voice"], speaker=spk)
            # Save as WAV (24kHz mono float32) → convert to MP3
            import numpy as np
            import wave
            samples = (audio.numpy() * 32767).astype(np.int16)
            with wave.open(wav_path, 'w') as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(24000)
                wf.writeframes(samples.tobytes())
            # WAV → MP3 via ffmpeg
            subprocess.run([ffmpeg, "-y", "-i", wav_path,
                            "-ar", "24000", "-ac", "1",
                            "-codec:a", "libmp3lame", "-q:a", "2", path],
                           capture_output=True)
            if os.path.exists(path) and os.path.getsize(path) > 100:
                outs.append(path)
                print(f"[video] silero {i + 1}/{len(items)} ok ({spk})")
            else:
                print(f"[video] silero sec_{i}: пустой файл, пропуск")
                outs.append(None)
            # cleanup wav
            if os.path.exists(wav_path):
                os.remove(wav_path)
        return outs
    except Exception as e:
        raise RuntimeError(f"Silero TTS error: {e}")


def mp3_duration(ffmpeg, path):
    """Длительность mp3 в секундах через `ffmpeg -i` (без ffprobe)."""
    r = subprocess.run([ffmpeg, "-i", path], capture_output=True, text=True)
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", r.stderr or "")
    if not m:
        return 0.0
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


LEAD_IN = 1.0    # пауза перед первым словом диктора
TAIL_OUT = 1.5   # пауза после последнего слова
CHUNK_GAP = 0.5  # пауза между репликами-чанками
WORD_CUE_MIN_DUR = 0.04  # минимальное видимое окно одного слова
# MP3 probe headers can include one or more encoder frames beyond the decoded
# stream.  Keep the correction bounded so a genuine short tail is not removed.
MP3_EOF_TOLERANCE = 0.12


def _finite_float(value):
    """Return a finite float, or ``None`` for malformed detector values."""
    try:
        value = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return value if math.isfinite(value) else None


def _duration_from_ffmpeg_log(text):
    """Read a positive ``Duration: HH:MM:SS.ss`` value from ffmpeg output."""
    match = re.search(
        r"Duration:\s*(\d+):([0-9]{2}):([0-9]+(?:\.[0-9]+)?)",
        str(text or ""),
    )
    if not match:
        return None
    value = _finite_float(
        int(match.group(1)) * 3600
        + int(match.group(2)) * 60
        + float(match.group(3))
    )
    return value if value is not None and value > 0.0 else None


def _stream_time_from_ffmpeg_log(text):
    """Return the last finite decoded-stream timestamp reported by ffmpeg.

    The ``Duration:`` header describes the container (and can include MP3
    encoder padding), while the final ``time=`` value describes decoded output.
    Keeping both lets callers prefer the latter when it is available.
    """
    value = None
    for match in re.finditer(
            r"(?<![\w])time=\s*(\d+):([0-9]{2}):([0-9]+(?:\.[0-9]+)?)",
            str(text or ""), re.I):
        candidate = _finite_float(
            int(match.group(1)) * 3600
            + int(match.group(2)) * 60
            + float(match.group(3)))
        if candidate is not None and candidate >= 0.0:
            value = candidate
    return value


def _silence_events(text):
    """Parse a strict, chronological subset of ffmpeg silence markers.

    The return value is ``(events, marker_present, malformed)``.  Each event
    is ``("start"|"end", timestamp)``; a negative EOF sentinel is represented by
    positive infinity.  A marker line with a non-numeric value is not partially
    matched against its numeric prefix, because doing so can manufacture a
    speech range from detector corruption.
    """
    text = str(text or "")
    marker = bool(re.search(r"silence_(?:start|end)\b", text, re.I))
    events = []
    malformed = False
    line_pattern = re.compile(r"silence_(start|end)\s*:\s*(.*)$", re.I)
    number_pattern = re.compile(
        r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\Z")
    for line in text.splitlines():
        match = line_pattern.search(line)
        if not match:
            if re.search(r"silence_(?:start|end)\b", line, re.I):
                malformed = True
            continue
        kind = match.group(1).lower()
        raw = match.group(2).split("|", 1)[0].strip()
        if not number_pattern.fullmatch(raw):
            malformed = True
            continue
        value = _finite_float(raw)
        if value is None:
            malformed = True
            continue
        if kind == "end" and value < 0.0:
            if value != -1.0:
                malformed = True
                continue
            value = math.inf
        elif kind == "start" and value < 0.0:
            malformed = True
            continue
        events.append((kind, value))
    return events, marker, malformed


def _validated_silence_intervals(events):
    """Return silence intervals, or ``None`` for an invalid event grammar."""
    intervals = []
    open_start = None
    previous = -math.inf
    for kind, timestamp in events:
        if math.isinf(timestamp):
            if kind != "end" or open_start is None:
                return None
            intervals.append((open_start, math.inf))
            open_start = None
            previous = math.inf
            continue
        if timestamp < previous - 1e-9:
            return None
        if kind == "start":
            # A second start without an end is not a recoverable interval.
            if open_start is not None:
                return None
            open_start = timestamp
        else:
            if open_start is None or timestamp <= open_start + 1e-9:
                return None
            intervals.append((open_start, timestamp))
            open_start = None
        previous = timestamp
    # A final unmatched start is the valid ffmpeg representation of silence
    # continuing to EOF.  It is completed after the decoded duration is known.
    if open_start is not None:
        intervals.append((open_start, math.inf))
    return intervals


def _looks_like_successful_detector_log(text):
    """Whether stderr contains ffmpeg metadata proving a successful run."""
    return bool(re.search(
        r"(?:Input\s*#|Output\s*#|Stream\s*#|ffmpeg version|Duration:)",
        str(text or ""), re.I,
    ))


def speech_bounds(ffmpeg, path, noise_db=-35.0, min_sil=0.12):
    """Return the detected speech range as ``(onset, speech_duration)``.

    ``silencedetect`` reports a silence start at its beginning and a silence end
    at its end.  Leading silence therefore ends the onset boundary, while an
    unmatched final start marks the trailing boundary.  Internal pauses are
    ignored.  A failed detector, malformed/empty output, or unknown duration
    returns no speech range instead of fabricating one.  A successful detector
    with metadata and no silence events means continuous speech for the whole
    known decoded stream.

    ``mp3_duration``/the ffmpeg ``Duration:`` header may include an MP3 frame
    or container padding value.  The decoded ``time=`` value and a trailing
    silence event are used to identify the actual EOF, with a deliberately
    bounded tolerance (:data:`MP3_EOF_TOLERANCE`) for probe/decoder rounding.
    """
    try:
        probed_duration = _finite_float(mp3_duration(ffmpeg, path))
    except Exception:  # noqa: BLE001 - detector failure is a no-speech result
        probed_duration = None
    if probed_duration is None or probed_duration <= 0.0:
        probed_duration = None

    try:
        result = subprocess.run(
            [ffmpeg, "-hide_banner", "-i", path,
             "-af", f"silencedetect=noise={noise_db}dB:d={min_sil}",
             "-f", "null", "-"],
            capture_output=True, text=True,
        )
    except Exception as exc:  # noqa: BLE001 - do not invent a speech span
        print(f"[video] silencedetect не удался ({exc}) — речь не определена")
        return 0.0, 0.0

    if getattr(result, "returncode", 0) not in (0, None):
        print("[video] silencedetect завершился с ошибкой — речь не определена")
        return 0.0, 0.0

    err = getattr(result, "stderr", "") or ""
    if isinstance(err, bytes):
        err = err.decode("utf-8", errors="replace")
    err = str(err)
    log_duration = _duration_from_ffmpeg_log(err)
    stream_duration = _stream_time_from_ffmpeg_log(err)
    # A duration-looking line in detector text is not enough to turn an
    # unknown/zero-duration input into a speech span.
    if probed_duration is None or not math.isfinite(probed_duration) or probed_duration <= 0.0:
        return 0.0, 0.0
    duration_candidates = [probed_duration]
    if log_duration is not None:
        duration_candidates.append(log_duration)
    if stream_duration is not None and stream_duration > 0.0:
        duration_candidates.append(stream_duration)
    duration = min(duration_candidates)
    if not math.isfinite(duration) or duration <= 0.0:
        return 0.0, 0.0

    events, marker_present, malformed = _silence_events(err)
    if malformed:
        return 0.0, 0.0
    if not events:
        # No events plus a valid ffmpeg metadata header is the only positive
        # evidence of continuous speech.  Empty/malformed detector output is
        # deliberately not treated as speech.
        if marker_present or not _looks_like_successful_detector_log(err):
            return 0.0, 0.0
        return 0.0, float(duration)

    intervals = _validated_silence_intervals(events)
    if intervals is None:
        return 0.0, 0.0

    # Prefer the decoded EOF when ffmpeg reports one.  If a final silence end is
    # within the bounded padding tolerance of the probe duration, it is the
    # same boundary; this is what prevents a 0.5s MP3 tail from extending the
    # last subtitle word into encoder padding.
    decoded_eof = duration
    if stream_duration is not None and stream_duration > 0.0:
        decoded_eof = min(decoded_eof, stream_duration)
    last_kind, last_timestamp = events[-1]
    if (last_kind == "end" and math.isfinite(last_timestamp)
            and probed_duration - last_timestamp <= MP3_EOF_TOLERANCE):
        decoded_eof = min(decoded_eof, max(0.0, last_timestamp))
    decoded_eof = max(0.0, min(decoded_eof, duration))
    if decoded_eof <= 0.0:
        return 0.0, 0.0

    intervals = [
        (max(0.0, min(decoded_eof, start)),
         max(0.0, min(decoded_eof, end)))
        for start, end in intervals
    ]
    intervals = [(start, end) for start, end in intervals
                 if end > start and end > 0.0]
    if not intervals:
        return 0.0, 0.0

    # A leading interval consumes the initial silence.  If it reaches EOF, the
    # file is positively all-silent and no speech may be returned.
    onset = 0.0
    if intervals[0][0] <= 1e-3:
        leading_end = intervals[0][1]
        if leading_end <= 1e-3 or leading_end >= decoded_eof - 1e-3:
            return 0.0, 0.0
        onset = min(decoded_eof, max(0.0, leading_end))

    # Only the final interval can be trailing silence.  Internal pauses do not
    # move the speech boundary.
    trailing_start = None
    start, end = intervals[-1]
    if start > onset + 1e-3 and end >= decoded_eof - 1e-3:
        trailing_start = start
    offset = min(decoded_eof, max(0.0, trailing_start)) \
        if trailing_start is not None else decoded_eof
    if offset <= onset:
        return 0.0, 0.0
    return float(onset), float(offset - onset)


def _srt_ts(sec):
    ms = int(round((sec - int(sec)) * 1000))
    s = int(sec)
    if ms >= 1000:
        s += 1
        ms -= 1000
    return f"{s // 3600:02d}:{(s % 3600) // 60:02d}:{s % 60:02d},{ms:03d}"


def split_cues(text, start, end, max_chars=42, max_lines=2, min_dur=1.0):
    """Нарезает прозвучавший текст на субтитры по времени речи.

    Текст делится по словам на куски ≤ max_chars*max_lines символов, время
    делится пропорционально длине куска. Гарантии: без перекрытий, каждый
    кусок ≥ min_dur (если позволяет окно), последний кусок заканчивается
    ровно в `end`.
    """
    text = re.sub(r"\s+", " ", (text or "").strip())
    if not text or end <= start:
        return []
    words = text.split()
    groups, cur, n = [], [], 0
    for w in words:
        add = len(w) + (1 if cur else 0)
        if cur and n + add > max_chars * max_lines:
            groups.append(" ".join(cur))
            cur, n = [w], len(w)
        else:
            cur.append(w)
            n += add
    if cur:
        groups.append(" ".join(cur))
    if not groups:
        return []
    total = sum(len(g) for g in groups) or 1
    span = end - start
    cues, t = [], start
    for i, g in enumerate(groups):
        dur = span * len(g) / total
        if i == len(groups) - 1:
            dur = end - t
        elif dur < min_dur and span >= min_dur:
            dur = min(min_dur, end - t)
        cues.append({"start": round(t, 3), "end": round(t + dur, 3), "text": g})
        t += dur
    return cues


def word_cues(text, start, end, min_dur=WORD_CUE_MIN_DUR):
    """Строит один SRT-таймкод на каждое слово внутри речевого спана.

    Полноценный ASR здесь намеренно не нужен: TTS уже даёт нам реальный
    диапазон речи через :func:`speech_bounds`, а внутри этого диапазона
    длительности распределяются пропорционально длине слов.  Такой
    fallback не требует тяжёлой модели, детерминирован и не теряет
    пунктуацию — исходный токен возвращается в ``text`` без очистки.

    ``min_dur`` — желаемая нижняя граница одного cue.  Если слов больше, чем
    помещается в интервал при этой границе, она пропорционально уменьшается,
    но остаётся положительной.  Границы вычисляются точной дробной
    арифметикой и лишь затем приводятся к float, поэтому округление не
    создаёт нулевых или перекрывающихся cues.
    """
    normalized = re.sub(r"\s+", " ", str(text or "").strip())
    if not normalized:
        return []
    try:
        start = float(start)
        end = float(end)
    except (TypeError, ValueError):
        return []
    if not (math.isfinite(start) and math.isfinite(end) and end > start):
        return []

    # Обычный TTS не оставляет отдельные токены для знаков препинания.
    # Если вход всё же содержит ``слово ,``, присоединяем знак к слову,
    # чтобы не создавать «голос» из символа, но не потерять punctuation.
    words, pending = [], ""
    for token in normalized.split(" "):
        if any(ch.isalnum() for ch in token):
            words.append(pending + token)
            pending = ""
        elif words:
            words[-1] += token
        else:
            pending += token
    if pending:
        if words:
            words[-1] += pending
        else:
            return []
    if not words:
        return []

    try:
        min_dur = float(min_dur)
    except (TypeError, ValueError):
        min_dur = 0.0
    if not math.isfinite(min_dur) or min_dur < 0.0:
        min_dur = 0.0

    # Fraction не теряет короткий интервал при округлении до миллисекунд.
    # from_float() также сохраняет именно те границы, которые видит вызывающий
    # код, поэтому итоговые cue всегда заканчиваются его точным ``end``.
    start_exact = Fraction.from_float(start)
    end_exact = Fraction.from_float(end)
    span = end_exact - start_exact
    count = len(words)
    minimum = min(Fraction.from_float(min_dur), span / count)
    remaining = span - minimum * count
    weights = [max(1, len(word)) for word in words]
    total_weight = sum(weights)
    durations = [
        minimum + remaining * weight / total_weight
        for weight in weights
    ]

    exact_boundaries = [start_exact]
    cursor_exact = start_exact
    for duration in durations[:-1]:
        cursor_exact += duration
        exact_boundaries.append(cursor_exact)
    exact_boundaries.append(end_exact)

    # Сначала пробуем обычный float API.  Если границы слишком близки для
    # float (например, искусственный span в 1 ULP), возвращаем точные
    # Fraction-границы вместо нулевых или перекрывающихся cues.
    float_boundaries = []
    for i, boundary in enumerate(exact_boundaries):
        if i == 0:
            float_boundaries.append(start)
            continue
        if i == len(exact_boundaries) - 1:
            float_boundaries.append(end)
            continue
        try:
            candidate = float(boundary)
        except (OverflowError, ValueError):
            candidate = math.inf
        float_boundaries.append(candidate)
    boundaries_are_float = (
        all(math.isfinite(value) for value in float_boundaries)
        and float_boundaries[0] == start
        and float_boundaries[-1] == end
        and all(left < right
                for left, right in zip(float_boundaries, float_boundaries[1:]))
    )
    boundaries = float_boundaries if boundaries_are_float else exact_boundaries

    cues = []
    for i, (word, cue_end) in enumerate(zip(words, boundaries[1:])):
        cue_start = boundaries[i]
        if i == 0:
            cue_start = start
        if i == count - 1:
            cue_end = end
        cues.append({"start": cue_start, "end": cue_end, "text": word})
    return cues


def split_word_cues(text, start, end, min_dur=0.08):
    """Совместимое имя для callers, которые предпочитают ``split_*``."""
    return word_cues(text, start, end, min_dur=min_dur)


def speech_word_cues(ffmpeg, path, text, start, max_end=None):
    """Пословные cues из фактического речевого диапазона TTS-файла.

    ``start`` — начало размещения чанка на общей видеодорожке.  Функция
    сначала снимает внешнюю тишину через :func:`speech_bounds`, затем
    ограничивает результат длиной файла/концом ролика.  Если ffmpeg или
    файл недоступны, остаётся безопасный пустой результат — рендер не
    ломается из-за отсутствующего аудио.
    """
    try:
        start = float(start)
    except (TypeError, ValueError):
        return []
    try:
        file_dur = max(0.0, float(mp3_duration(ffmpeg, path)))
    except Exception:  # noqa: BLE001 — optional timing source
        file_dur = 0.0
    try:
        onset, speech_dur = speech_bounds(ffmpeg, path)
    except Exception:  # noqa: BLE001 — detector failure is not speech evidence
        return []
    onset = _finite_float(onset)
    speech_dur = _finite_float(speech_dur)
    if onset is None or speech_dur is None:
        return []
    onset = max(0.0, onset)
    speech_dur = max(0.0, speech_dur)
    speech_start = max(0.0, start + max(0.0, float(onset)))
    if file_dur > 0.0:
        speech_end = min(start + file_dur,
                         speech_start + max(0.0, float(speech_dur)))
    else:
        speech_end = speech_start + max(0.0, float(speech_dur))
    if max_end is not None:
        try:
            speech_end = min(speech_end, float(max_end))
        except (TypeError, ValueError):
            pass
    if speech_end <= speech_start:
        return []
    return word_cues(text, speech_start, speech_end)


def wrap_cue(text, max_chars=42, max_lines=2):
    """Wrap cue text within a hard width and line-count contract.

    A token longer than one line is split at a character boundary without
    inserting a space, so URLs, hashes, and other long spoken tokens retain
    their exact text.  If the complete text cannot fit in ``max_lines`` lines
    without truncation, :class:`ValueError` is raised explicitly; returning a
    third overlong line or dropping the tail would violate the renderer contract.
    """
    try:
        max_chars = int(max_chars)
        max_lines = int(max_lines)
    except (OverflowError, TypeError, ValueError):
        return []
    if max_chars < 1 or max_lines < 1:
        return []

    normalized = re.sub(r"\s+", " ", str(text or "").strip())
    if not normalized:
        return []

    lines, current = [], ""
    for word in normalized.split(" "):
        # A chunk after the first is a continuation and must not gain a space.
        chunks = [word[i:i + max_chars]
                  for i in range(0, len(word), max_chars)] or [word]
        for index, chunk in enumerate(chunks):
            continuation = index > 0
            separator = "" if continuation or not current else " "
            candidate = current + separator + chunk
            if current and len(candidate) > max_chars:
                lines.append(current)
                current = chunk
            else:
                current = candidate
            if len(current) == max_chars:
                lines.append(current)
                current = ""
    if current:
        lines.append(current)
    lines = [line for line in lines if line]
    if len(lines) > max_lines:
        raise ValueError(
            f"cue needs {len(lines)} lines at {max_chars} characters; "
            f"max_lines={max_lines} (text preserved, cannot truncate)"
        )
    return lines


def write_srt(cues, path):
    """Субтитры в .srt (совместимо с Telegram/VK/TikTok)."""
    with open(path, "w", encoding="utf-8") as fh:
        for i, c in enumerate(cues, 1):
            fh.write(f"{i}\n")
            fh.write(f"{_srt_ts(c['start'])} --> {_srt_ts(c['end'])}\n")
            fh.write(f"{c['text']}\n\n")
    return path


def _write_requested_srt(path, cues, required=False):
    """Write an optional SRT, failing visibly when an explicit path is empty."""
    path = os.fspath(path) if path else ""
    cue_list = list(cues or [])
    if not path or not cue_list:
        if required:
            target = path or "<empty path>"
            raise RuntimeError(f"[video] запрошенный SRT не создан: {target}")
        return False
    try:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        write_srt(cue_list, path)
        if not os.path.isfile(path) or os.path.getsize(path) <= 0:
            raise OSError("SRT файл пуст")
    except Exception as exc:  # noqa: BLE001 - required output is a hard contract
        if required:
            raise RuntimeError(f"[video] SRT не записан: {path} ({exc})") from exc
        print(f"[video] SRT не построен ({type(exc).__name__}: {exc})")
        return False
    return True


def _estimate_weights(sections):
    """Грубая оценка длительностей (русская речь ~12 симв/с), без сети."""
    return [max(1.5, len(s["voice"]) / 12.0) for s in sections]


def make_voiceover_sections(ffmpeg, sections, voice, tmpdir, lead_in=None):
    """Озвучивает секции, склеивает их и строит пословный timeline.

    Возвращает ``(voice_mp3 | None, weights, meta)``.  ``meta`` всегда имеет
    явное состояние ``audio_state``: ``no_audio`` (TTS/склейка не дали файл),
    ``no_speech`` (файл есть, но подтверждённой речи нет) или ``speech``.
    ``cues`` строятся только из подтверждённого :func:`speech_bounds` диапазона;
    ``chunk_bounds`` сохраняет фактические границы каждого валидного TTS-чанка
    для long-рендера, включая случаи пропущенных чанков.
    """
    section_list = list(sections or [])
    if not section_list:
        return None, [], {"cues": [], "section_bounds": [], "chunk_bounds": [],
                          "audio_bounds": [], "section_weights": [],
                          "audio_state": "no_audio"}
    try:
        lead_s = LEAD_IN if lead_in is None else float(lead_in)
    except (TypeError, ValueError, OverflowError):
        lead_s = LEAD_IN
    lead_s = max(0.0, lead_s if math.isfinite(lead_s) else 0.0)

    def no_audio(weights=None, state="no_audio"):
        return None, list(weights or []), {
            "cues": [], "section_bounds": [], "chunk_bounds": [],
            "audio_bounds": [], "section_weights": list(weights or []),
            "audio_state": state,
        }

    try:
        tts_provider = os.environ.get("TTS_PROVIDER", "").lower()
        if tts_provider == "silero":
            print(f"[video] озвучка {len(section_list)} секций "
                  f"(silero, speaker={voice or SILERO_VOICE})...")
            files = _tts_silero(section_list, voice, tmpdir)
        elif tts_provider == "voicestudio":
            print(f"[video] озвучка {len(section_list)} секций "
                  f"(voicestudio {voice or VOICESTUDIO_VOICE}, {VOICESTUDIO_URL})...")
            files = _tts_voicestudio(section_list, voice, tmpdir)
        elif os.environ.get("ELEVENLABS_API_KEY"):
            print(f"[video] озвучка {len(section_list)} секций "
                  f"(elevenlabs {voice or ELEVENLABS_VOICE})...")
            files = _tts_elevenlabs(section_list, voice, tmpdir)
        else:
            import edge_tts  # noqa: F401
            print(f"[video] озвучка {len(section_list)} секций ({voice})...")
            files = asyncio.run(_tts_many(section_list, voice, tmpdir))
    except ImportError:
        print("[video] edge-tts не установлен — видео будет без звука")
        return no_audio(_estimate_weights(section_list))
    except Exception as exc:  # noqa: BLE001 - optional TTS has explicit state
        print(f"[video] TTS не удался ({type(exc).__name__}: {exc}) — "
              "видео будет без звука")
        traceback.print_exc()
        return no_audio(_estimate_weights(section_list))

    files = list(files or [])
    section_durs = []
    valid_entries = []
    for idx, section in enumerate(section_list):
        text = str(section.get("voice") or section.get("body") or "")
        estimate = max(1.5, len(text) / 12.0)
        file_path = files[idx] if idx < len(files) else None
        if not file_path or not os.path.isfile(file_path):
            print(f"[video] sec_{idx}: нет аудио, пропуск")
            section_durs.append(estimate)
            continue
        try:
            file_dur = _finite_float(mp3_duration(ffmpeg, file_path))
        except Exception:  # noqa: BLE001 - bad probe means no usable chunk
            file_dur = None
        if file_dur is None or file_dur <= 0.3:
            print(f"[video] sec_{idx}: пустое/невалидное аудио, пропуск")
            section_durs.append(estimate)
            continue
        section_durs.append(file_dur)
        valid_entries.append((idx, file_path, section, file_dur))

    if not valid_entries:
        print("[video] ни один чанк не озвучен — видео без звука")
        return no_audio(section_durs)

    # The returned weights describe the audio that was actually assembled:
    # skipped TTS files are absent, and gaps exist only between adjacent valid
    # chunks.  The separate ``section_weights`` metadata below remains useful
    # to visual renderers that need an estimate for a skipped section.
    weights = [
        duration + (CHUNK_GAP if i < len(valid_entries) - 1 else 0.0)
        for i, (_idx, _file_path, _section, duration) in enumerate(valid_entries)
    ]
    section_weights = [
        duration + (CHUNK_GAP if i < len(section_durs) - 1 else 0.0)
        for i, duration in enumerate(section_durs)
    ]

    def run_ffmpeg(args):
        try:
            result = subprocess.run(args, capture_output=True)
        except Exception as exc:  # noqa: BLE001 - report no-audio state
            print(f"[video] ffmpeg не создал silence ({type(exc).__name__}: {exc})")
            return False
        return getattr(result, "returncode", 0) in (0, None)

    silence_paths = []
    if len(valid_entries) > 1:
        sil = os.path.join(tmpdir, "sil.mp3")
        if not run_ffmpeg([
                ffmpeg, "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
                "-t", str(CHUNK_GAP), "-c:a", "libmp3lame", sil]):
            return no_audio(weights)
        silence_paths.append(sil)
    lead_path = None
    if lead_s > 0.0:
        lead_path = os.path.join(tmpdir, "lead.mp3")
        if not run_ffmpeg([
                ffmpeg, "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
                "-t", str(lead_s), "-c:a", "libmp3lame", lead_path]):
            return no_audio(weights)
    tail_path = os.path.join(tmpdir, "tail.mp3")
    if not run_ffmpeg([
            ffmpeg, "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono",
            "-t", str(TAIL_OUT), "-c:a", "libmp3lame", tail_path]):
        return no_audio(weights)

    def ffmpeg_error_tail(result):
        """Хвост stderr ffmpeg: без него причина сбоя склейки в CI не видна."""
        err = getattr(result, "stderr", b"") or b""
        if isinstance(err, bytes):
            err = err.decode("utf-8", errors="replace")
        return str(err).strip()[-400:]

    def pcm_fallback(ordered, out_path):
        """Склейка без concat-demuxer: raw PCM 24 кГц моно -> один encode.

        ``ordered`` — абсолютные пути в порядке воспроизведения.  Каждый кусок
        декодируется отдельно, куски склеиваются побайтно, результат кодируется
        один раз.  Ресемплинг сохраняет длительность исходников, поэтому
        последующая арифметика по ``section_bounds`` остаётся верной.
        """
        raw_paths = []
        skipped = 0
        for abs_path in ordered:
            raw_path = abs_path + ".raw"
            try:
                raw_result = subprocess.run(
                    [ffmpeg, "-y", "-i", abs_path, "-f", "s16le", "-ac", "1",
                     "-ar", "24000", "-c:a", "pcm_s16le", raw_path],
                    capture_output=True)
            except Exception as exc:  # noqa: BLE001 - один кусок не роняет склейку
                print(f"[video] pcm fallback пропустил кусок ({type(exc).__name__}: {exc})")
                skipped += 1
                continue
            if (getattr(raw_result, "returncode", 0) in (0, None)
                    and os.path.exists(raw_path)
                    and os.path.getsize(raw_path) > 0):
                raw_paths.append(raw_path)
            else:
                skipped += 1
        voice_raw = os.path.join(tmpdir, "voice.raw")
        try:
            with open(voice_raw, "wb") as out_raw:
                for raw_path in raw_paths:
                    with open(raw_path, "rb") as src_raw:
                        while True:
                            block = src_raw.read(65536)
                            if not block:
                                break
                            out_raw.write(block)
            if os.path.getsize(voice_raw) <= 0:
                raise RuntimeError("пустой raw")
        except Exception as exc:  # noqa: BLE001 - нет raw, фолбэк не сработал
            print(f"[video] pcm fallback не склеил raw ({type(exc).__name__}: {exc})")
            return False
        try:
            encode = subprocess.run(
                [ffmpeg, "-y", "-f", "s16le", "-ar", "24000", "-ac", "1",
                 "-i", voice_raw, "-c:a", "libmp3lame", out_path],
                capture_output=True)
        except Exception as exc:  # noqa: BLE001 - фолбэк не сработал
            print(f"[video] pcm fallback encode не запустился ({type(exc).__name__}: {exc})")
            return False
        if (getattr(encode, "returncode", 0) not in (0, None)
                or not os.path.exists(out_path)
                or os.path.getsize(out_path) <= 0):
            print("[video] pcm fallback encode failed: " + ffmpeg_error_tail(encode))
            return False
        print(f"[video] pcm fallback: склейка без demuxer удалась"
              + (f" (пропущено кусков: {skipped})" if skipped else ""))
        return True

    lst = os.path.join(tmpdir, "join.txt")
    # Один порядок для demuxer-списка и для PCM-фолбэка: lead, чанки с паузой
    # между соседними, tail.  Пути абсолютные — этого требует concat.
    ordered_paths = []
    if lead_path:
        ordered_paths.append(os.path.abspath(lead_path).replace("\\", "/"))
    for index, (_idx, file_path, _section, _duration) in enumerate(valid_entries):
        ordered_paths.append(os.path.abspath(file_path).replace("\\", "/"))
        if index < len(valid_entries) - 1 and silence_paths:
            ordered_paths.append(os.path.abspath(silence_paths[0]).replace("\\", "/"))
    ordered_paths.append(os.path.abspath(tail_path).replace("\\", "/"))

    with open(lst, "w", encoding="utf-8") as fh:
        for abs_path in ordered_paths:
            fh.write("file '%s'\n" % abs_path)

    out = os.path.join(tmpdir, "voice.mp3")
    result = subprocess.run(
        [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", lst,
         "-c", "copy", out], capture_output=True)
    if getattr(result, "returncode", 0) not in (0, None):
        print("[video] concat copy failed: " + ffmpeg_error_tail(result))
        result = subprocess.run(
            [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", lst,
             "-c:a", "libmp3lame", out], capture_output=True)
    if getattr(result, "returncode", 0) not in (0, None):
        print("[video] concat transcode failed: " + ffmpeg_error_tail(result))
        if not pcm_fallback(ordered_paths, out):
            print("[video] склейка аудио не удалась — видео будет без звука")
            return no_audio(weights)

    # Visual section bounds include every requested section, while the audio
    # cursor advances only over valid TTS files.  Thus skipped chunks do not
    # shift word timestamps in the concatenated voice track.
    section_bounds = [lead_s]
    section_cursor = lead_s
    for index, duration in enumerate(section_durs):
        section_cursor += duration
        section_bounds.append(section_cursor)
        if index < len(section_durs) - 1:
            section_cursor += CHUNK_GAP

    cues = []
    chunk_bounds = []
    audio_cursor = lead_s
    for entry_index, (idx, file_path, section, file_dur) in enumerate(valid_entries):
        try:
            onset, speech_dur = speech_bounds(ffmpeg, file_path)
            onset = _finite_float(onset)
            speech_dur = _finite_float(speech_dur)
        except Exception:  # noqa: BLE001 - no speech evidence
            onset, speech_dur = None, None
        onset = 0.0 if onset is None else max(0.0, onset)
        speech_dur = 0.0 if speech_dur is None else max(0.0, speech_dur)
        onset = min(onset, file_dur)
        speech_dur = min(speech_dur, max(0.0, file_dur - onset))
        speech_start = audio_cursor + onset
        speech_end = speech_start + speech_dur
        text = str(section.get("voice") or section.get("body") or "")
        if speech_end > speech_start and text.strip():
            section_cues = word_cues(text, speech_start, speech_end)
            for cue in section_cues:
                # Preserve the source section on every word cue.  The field is
                # ignored by SRT serialization but is the identity bridge for
                # long-form mapping when an earlier TTS chunk is skipped.
                cue["section"] = int(idx)
            cues.extend(section_cues)
        chunk_end = audio_cursor + file_dur
        chunk_bounds.append({
            "sec": int(idx),
            "section": int(idx),
            "start": float(audio_cursor),
            "end": float(chunk_end),
            "duration": float(file_dur),
            "weight": float(file_dur + (
                CHUNK_GAP if entry_index < len(valid_entries) - 1 else 0.0)),
            "speech_start": float(speech_start),
            "speech_end": float(speech_end),
        })
        if entry_index < len(valid_entries) - 1:
            audio_cursor = chunk_end + CHUNK_GAP

    audio_bounds = [float(lead_s)]
    for chunk in chunk_bounds:
        audio_bounds.append(float(chunk["end"]))
    print(f"[video] озвучка готова: {out} ({sum(weights):.1f} c голоса), "
          f"субтитров: {len(cues)} слов")
    state = "speech" if cues else "no_speech"
    return out, weights, {
        "cues": cues,
        "section_bounds": section_bounds,
        "chunk_bounds": chunk_bounds,
        "audio_bounds": audio_bounds,
        "section_weights": section_weights,
        "audio_state": state,
    }


# ---------- скролл и кадры ----------

def smoothstep(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def cue_at(cues, t):
    """Активный субтитр на момент t (границы по фактической речи)."""
    if not cues:
        return None
    lo, hi = 0, len(cues) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        c = cues[mid]
        if t < c["start"]:
            hi = mid - 1
        elif t > c["end"]:
            lo = mid + 1
        else:
            return c
    return None


def _draw_cue(ov, cue, W, H, f_sub, f_sub_small=None):
    """Отрисовка субтитра: до 2 строк, тёмная подложка + белый текст с обводкой."""
    try:
        lines = wrap_cue(cue["text"], 42, 2)
    except ValueError as exc:
        # Не терять текст и не рисовать третью строку: render path сообщает
        # о нарушении явного capacity-контракта вызывающему коду.
        raise RuntimeError(f"[video] cue не помещается в 2x42: {exc}") from exc
    if not lines:
        return
    font = f_sub
    sizes, widths, heights = [], [], []
    for ln in lines:
        w, h = _ts(ov, ln, font)
        widths.append(w)
        heights.append(h)
        sizes.append(h)
    pad_x, pad_y, line_gap = 26, 16, 10
    box_w = max(widths) + pad_x * 2
    box_h = sum(sizes) + line_gap * (len(lines) - 1) + pad_y * 2
    x0 = (W - box_w) // 2
    y0 = H - box_h - 56
    ov.rounded_rectangle([x0, y0, x0 + box_w, y0 + box_h], radius=16,
                         fill=(6, 10, 20))
    ov.rounded_rectangle([x0, y0, x0 + box_w, y0 + box_h], radius=16,
                         outline=(40, 58, 92), width=2)
    y = y0 + pad_y
    for ln, w, h in zip(lines, widths, heights):
        ov.text((x0 + (box_w - w) // 2, y), ln, font=font, fill=(255, 255, 255),
                stroke_width=3, stroke_fill=(0, 0, 0))
        y += h + line_gap


def scroll_plan(site_h, seconds, anchors, weights=None, bounds=None):
    """Позиция верхнего края вьюпорта для каждого момента времени.

    1с — стоим на начале, 1.5с — стоим в конце, между — плавный скролл
    через якоря секций. Если передан точный `bounds` (таймлайн озвучки) —
    используется он: секция меняется ровно тогда, когда диктор её договорил.
    Иначе weights[i] распределяются пропорционально (legacy-режим).
    """
    max_off = max(0, site_h - H)
    if bounds:
        bounds = [float(b) for b in bounds]
    else:
        weights = list(weights) if weights else [max(1, len(s["voice"])) for s in SECTIONS]
        total_w = sum(weights) or 1.0
        bounds = [1.0]  # время конца стояния на старте и конца каждого сегмента
        span = seconds - 1.0 - 1.5
        acc = 1.0
        for w_ in weights:
            acc += span * w_ / total_w
            bounds.append(acc)
    # якорь секции -> смещение: секция видна целиком сверху, clamp к max_off
    offs = [min(a["y_top"], max_off) for a in anchors]

    def pos(t):
        if t <= bounds[0]:
            return 0
        for i in range(len(bounds) - 1):
            if t <= bounds[i + 1]:
                frac = smoothstep((t - bounds[i]) / max(1e-6, bounds[i + 1] - bounds[i]))
                return offs[i] + (offs[i + 1] - offs[i]) * frac if i + 1 < len(offs) else offs[i]
        return max_off

    return pos, bounds


def section_at(t, bounds, sections=None):
    sections = sections if sections is not None else SECTIONS
    idx = 0
    for i in range(len(sections)):
        if t >= bounds[i]:
            idx = i
    return sections[idx]["caption"]


def find_ffmpeg():
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.exists(exe):
            return exe
    except Exception:
        # imageio-ffmpeg может быть без бинарника (RuntimeError) —
        # тогда пробуем системный ffmpeg
        pass
    return shutil.which("ffmpeg")


def render_video(site, anchors, seconds, fps, out_silent, caption_on=True,
                 weights=None, sections=None, cues=None, bounds=None):
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("нет ffmpeg: pip install imageio-ffmpeg")
    pos, _bounds = scroll_plan(site.height, seconds, anchors, weights, bounds=bounds)
    sections = sections if sections is not None else SECTIONS
    cues = list(cues or [])
    # Validate the hard capacity contract before starting ffmpeg.  This keeps
    # the over-capacity policy explicit and avoids producing a partial file
    # before a later frame happens to reach the pathological cue.
    for cue in cues:
        try:
            wrap_cue(cue.get("text", ""), 42, 2)
        except ValueError as exc:
            raise RuntimeError(
                f"[video] cue не помещается в 2x42 ({exc})"
            ) from exc
    n = int(seconds * fps)
    f_cap = _font(JURA, 30, 700)
    f_url = _font(JURA, 28, 700)
    f_sub = _font(JURA, 30, 700) if cues else None
    cmd = [
        ffmpeg, "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
        "-framerate", str(fps), "-i", "-",
        "-vf", "eq=contrast=1.02:saturation=1.05",
        "-an", "-c:v", "libx265", "-pix_fmt", "yuv420p",
        "-preset", "medium", "-crf", "28",
        out_silent,
    ]
    print(f"[video] рендер {n} кадров ({W}x{H}, {fps} fps, {seconds} c)...")
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    frame = Image.new("RGB", (W, H))
    for i in range(n):
        t = i / fps
        off = int(pos(t))
        frame.paste(site.crop((0, off, W, off + H)), (0, 0))
        ov = ImageDraw.Draw(frame)
        # браузерная шапка
        ov.rectangle([0, 0, W, 96], fill=(8, 13, 25))
        ov.rounded_rectangle([280, 22, W - 48, 74], radius=22, fill=(19, 28, 48))
        uw, _ = _ts(ov, "trustnode • будущее", f_url)
        ov.text(((280 + W - 48 - uw) // 2, 34), "trustnode • будущее", font=f_url, fill=SUB)
        ow, _ = _ts(ov, "TRUSTNODE", f_cap)
        ov.text((48, 30), "TRUSTNODE", font=f_cap, fill=ACCENT)
        # прогресс скролла
        frac = off / max(1, site.height - H)
        ov.rectangle([0, 96, W * frac, 104], fill=ACCENT)
        # субтитры: рисуем по точному таймлайну речи (Lead_Out снимаем,
        # иначе картинка «висит» лишние 1.5с)
        if cues:
            cue = cue_at(cues, t)
            if cue:
                _draw_cue(ov, cue, W, H, f_sub)
        elif caption_on:
            # legacy-режим без таймлайна: подпись текущей секции
            cap = section_at(t, _bounds, sections)
            cw, ch = _ts(ov, cap, f_cap)
            px0 = (W - cw) // 2 - 28
            ov.rounded_rectangle([px0, H - 120, px0 + cw + 56, H - 120 + ch + 36],
                                 radius=20, fill=(8, 13, 25))
            ov.text((px0 + 28, H - 112), cap, font=f_cap, fill=TEXT)
        proc.stdin.write(frame.tobytes())
        if (i + 1) % 90 == 0:
            print(f"[video] ...{(i + 1)}/{n}")
    proc.stdin.close()
    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg вернул ошибку при кодировании видео")
    print(f"[video] видео готово: {out_silent}")
    return out_silent


def mux_audio(ffmpeg, silent_mp4, voice_mp3, out_mp4, seconds):
    """Склеивает видео и озвучку; видео ровно `seconds` (аудио — pad/cut)."""
    cmd = [
        ffmpeg, "-y",
        "-i", silent_mp4, "-i", voice_mp3,
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "128k",
        "-af", "apad",
        "-t", str(seconds),
        "-shortest",
        out_mp4,
    ]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        print(f"[video] mux звука не удался: {r.stderr[-500:]} — отдаю видео без звука")
        shutil.copy(silent_mp4, out_mp4)
    else:
        print(f"[video] звук наложен: {out_mp4}")


def generate(seconds=30, out="out/video_test.mp4", fps=FPS_DEFAULT,
              voice=VOICE_DEFAULT, no_audio=False, tmpdir="out/tmp_video",
              script_text=None, srt_out=None):
    if srt_out and no_audio:
        raise RuntimeError(
            "[video] запрошенный SRT невозможен без аудио; "
            "используйте отдельный no-SRT режим")
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    os.makedirs(tmpdir, exist_ok=True)
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("нет ffmpeg: pip install imageio-ffmpeg")
    if script_text:
        # --- режим своего сценария: длина видео = длина озвучки ---
        parsed = parse_script(script_text)
        first = parsed[0]["heading"]
        title = first if not first.startswith("Часть") else "Видеоразбор"
        site, anchors = build_site_custom(parsed, title)
        print(f"[video] свой сценарий: секций {len(parsed)}, сайт "
              f"{site.width}x{site.height}")
        sections = parsed
    else:
        site, anchors = build_site()
        print(f"[video] сайт {site.width}x{site.height}, секций: {len(anchors)}")
        sections = SECTIONS
    cues, section_bounds = [], []
    if no_audio:
        voice_mp3, weights = None, _estimate_weights(sections)
    else:
        voice_mp3, weights, meta = make_voiceover_sections(
            ffmpeg, sections, voice, tmpdir)
        cues = (meta or {}).get("cues") or []
        section_bounds = (meta or {}).get("section_bounds") or []
    if script_text or voice_mp3:
        # длина по реальной озвучке: голос + lead-in 1с + tail 1.5с
        seconds = round(sum(weights) + LEAD_IN + TAIL_OUT, 1)
        print(f"[video] длина видео по озвучке: {seconds} c")
    silent = os.path.join(tmpdir, "silent.mp4")
    render_video(site, anchors, seconds, fps, silent, weights=weights,
                 sections=sections, cues=cues, bounds=section_bounds or None)
    if srt_out:
        if no_audio:
            print("[video] SRT: пропущен (no_audio)")
        elif _write_requested_srt(srt_out, cues, required=True):
            print(f"[video] SRT: {srt_out} ({len(cues)} слов)")
    if voice_mp3:
        mux_audio(ffmpeg, silent, voice_mp3, out, seconds)
    else:
        shutil.copy(silent, out)
    size = os.path.getsize(out)
    print(f"[video] ГОТОВО: {out} ({size / 1048576:.1f} MB, {seconds} c)")
    return out


def main():
    ap = argparse.ArgumentParser(description="Видео «футуристичный сайт»")
    ap.add_argument("--seconds", type=int, default=30)
    ap.add_argument("--fps", type=int, default=FPS_DEFAULT)
    ap.add_argument("--out", default="out/video_test.mp4")
    ap.add_argument("--voice", default=VOICE_DEFAULT)
    ap.add_argument("--no-audio", action="store_true")
    ap.add_argument("--smoke", action="store_true",
                    help="быстрая проверка: 6 сек, 10 fps")
    ap.add_argument("--script-text", default="",
                    help="свой сценарий текстом (длина видео = длина озвучки)")
    ap.add_argument("--script-file", default="",
                    help="файл со сценарием (текст статьи)")
    ap.add_argument("--from-post", default="",
                    help="файл с исходным текстом поста: LLM (GigaChat по "
                         "умолчанию) перепишет его в сценарий видео; при сбое "
                         "используется исходный текст как есть")
    ap.add_argument("--style", default="default",
                    help="стиль: default (скролл сайта, как раньше) или "
                         "cybersecurity_cinematic / cinematic / documentary / "
                         "social_dynamic (см. bot/video_styles.py)")
    ap.add_argument("--topic", default="",
                    help="тема cinematic-ролика (только для engine=cine)")
    ap.add_argument("--edl-out", default="",
                    help="путь для EDL JSON (монтажный лист, только cine)")
    ap.add_argument("--srt-out", default="",
                    help="путь для SRT субтитров (только cine)")
    a = ap.parse_args()
    script = a.script_text
    if a.script_file:
        with open(a.script_file, encoding="utf-8") as fh:
            script = fh.read()
    if a.from_post:
        # S27: пост -> LLM рерайт в сценарий (GigaChat по умолчанию).
        with open(a.from_post, encoding="utf-8") as fh:
            post_text = fh.read()
        import llm
        rewritten = llm.rewrite_post_to_script(post_text, "short")
        if rewritten:
            print("[video] сценарий сгенерирован LLM из поста "
                  f"({len(rewritten)} симв.)")
            script = rewritten
        else:
            print("[video] LLM-рерайт недоступен — исходный пост как сценарий")
            script = post_text
    if a.style != "default":
        # --- cinematic-режим: тема -> shot list -> монтаж -> MP4.
        # M17: со сценарием — видео ПО СТАТЬЕ (диктор читает статью).
        import video_cine as cine
        if a.smoke:
            a.seconds, a.fps = 8, 10
            a.out = "out/video_cine_smoke.mp4"
        cine.generate_cinematic(topic=a.topic or None, seconds=a.seconds,
                                style=a.style, out=a.out, fps=a.fps,
                                voice=a.voice, no_audio=a.no_audio,
                                script_text=script or None,
                                edl_out=a.edl_out or None,
                                srt_out=a.srt_out or None)
        return
    if a.smoke:
        a.seconds, a.fps = 6, 10
        a.out = "out/video_smoke.mp4"
    generate(seconds=a.seconds, out=a.out, fps=a.fps,
             voice=a.voice, no_audio=a.no_audio, script_text=script or None,
             srt_out=a.srt_out or None)


if __name__ == "__main__":
    main()
