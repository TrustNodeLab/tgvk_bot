"""Тестовая функция: генерация 30-секундного видео «футуристичный сайт».

Концепция: бот рисует вымышленный футуристичный сайт (PIL, стиль TrustNode),
затем «листает» его сверху вниз на видео, накладывая русскую озвучку,
синхронизированную со скроллом по секциям.

Использование:
    python bot/video_gen.py                  # 30 сек, out/video_test.mp4
    python bot/video_gen.py --seconds 10     # короткая версия
    python bot/video_gen.py --smoke          # быстрая проверка (6 сек, 10 fps)
    python bot/video_gen.py --no-audio       # без озвучки (без сети)

Зависимости (не входят в requirements.txt прод-контура):
    pip install imageio-ffmpeg edge-tts numpy
ffmpeg-бинарник берётся из imageio-ffmpeg, иначе системный ffmpeg
(GitHub ubuntu-latest имеет системный ffmpeg из коробки).
Озвучка — edge-tts (нужна сеть до Microsoft). Без сети — видео без звука.
"""

import argparse
import asyncio
import os
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

# ---------- константы ----------

W, H = 1080, 1920          # вертикальное видео (формат клипов/шортсов)
FPS_DEFAULT = 15
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


# ---------- озвучка ----------

async def _tts_save(text, voice, out_mp3):
    from edge_tts import Communicate

    await Communicate(text, voice).save(out_mp3)


def make_voiceover(out_mp3, voice):
    """Склеивает voice-тексты секций в один mp3. Возвращает True/False."""
    try:
        import edge_tts  # noqa: F401
    except ImportError:
        print("[video] edge-tts не установлен — видео будет без звука")
        return False
    full = " ".join(s["voice"] for s in SECTIONS)
    print(f"[video] озвучка ({len(full)} символов, {voice})...")
    try:
        asyncio.run(_tts_save(full, voice, out_mp3))
        print(f"[video] озвучка готова: {out_mp3}")
        return True
    except Exception as e:
        print(f"[video] TTS не удался ({e}) — видео будет без звука")
        return False


# ---------- скролл и кадры ----------

def smoothstep(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def scroll_plan(site_h, seconds, anchors):
    """Позиция верхнего края вьюпорта для каждого момента времени.

    1с — стоим на начале, 1.5с — стоим на конце, между — плавный скролл
    через якоря секций (веса по длине озвучки).
    """
    max_off = max(0, site_h - H)
    weights = [max(1, len(s["voice"])) for s in SECTIONS]
    total_w = sum(weights)
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
        for i in range(len(weights)):
            if t <= bounds[i + 1]:
                frac = smoothstep((t - bounds[i]) / max(1e-6, bounds[i + 1] - bounds[i]))
                return offs[i] + (offs[i + 1] - offs[i]) * frac if i + 1 < len(offs) else offs[i]
        return max_off

    return pos, bounds


def section_at(t, bounds):
    idx = 0
    for i in range(len(SECTIONS)):
        if t >= bounds[i]:
            idx = i
    return SECTIONS[idx]["caption"]


def find_ffmpeg():
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if os.path.exists(exe):
            return exe
    except ImportError:
        pass
    return shutil.which("ffmpeg")


def render_video(site, anchors, seconds, fps, out_silent, caption_on=True):
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("нет ffmpeg: pip install imageio-ffmpeg")
    pos, bounds = scroll_plan(site.height, seconds, anchors)
    n = int(seconds * fps)
    f_cap = _font(JURA, 30, 700)
    f_url = _font(JURA, 28, 700)
    cmd = [
        ffmpeg, "-y",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}",
        "-framerate", str(fps), "-i", "-",
        "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
        "-preset", "medium", "-crf", "20",
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
        # подпись текущей секции
        if caption_on:
            cap = section_at(t, bounds)
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
             voice=VOICE_DEFAULT, no_audio=False, tmpdir="out/tmp_video"):
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    os.makedirs(tmpdir, exist_ok=True)
    site, anchors = build_site()
    print(f"[video] сайт {site.width}x{site.height}, секций: {len(anchors)}")
    silent = os.path.join(tmpdir, "silent.mp4")
    render_video(site, anchors, seconds, fps, silent)
    voice_mp3 = os.path.join(tmpdir, "voice.mp3")
    has_audio = False
    if not no_audio:
        has_audio = make_voiceover(voice_mp3, voice)
    if has_audio:
        mux_audio(find_ffmpeg(), silent, voice_mp3, out, seconds)
    else:
        shutil.copy(silent, out)
    size = os.path.getsize(out)
    print(f"[video] ГОТОВО: {out} ({size / 1048576:.1f} MB, {seconds} c)")
    return out


def main():
    ap = argparse.ArgumentParser(description="Тест: видео «футуристичный сайт» 30 сек")
    ap.add_argument("--seconds", type=int, default=30)
    ap.add_argument("--fps", type=int, default=FPS_DEFAULT)
    ap.add_argument("--out", default="out/video_test.mp4")
    ap.add_argument("--voice", default=VOICE_DEFAULT)
    ap.add_argument("--no-audio", action="store_true")
    ap.add_argument("--smoke", action="store_true",
                    help="быстрая проверка: 6 сек, 10 fps")
    a = ap.parse_args()
    if a.smoke:
        a.seconds, a.fps = 6, 10
        a.out = "out/video_smoke.mp4"
    generate(seconds=a.seconds, out=a.out, fps=a.fps,
             voice=a.voice, no_audio=a.no_audio)


if __name__ == "__main__":
    main()
