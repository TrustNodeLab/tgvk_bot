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
    '"type":"cinematic|typography|graphic",'
    '"dur":1.5,"visual":"phone_dark|phone_message|phone_call|login_screen|'
    'qr_panel|qr_scan|token_panel|chain|attack_grid|server_rack|server_corridor|'
    'cables|switch_macro|keyboard|bokeh|eye|face_glow|person|consequence|'
    'flash|pause_black|question|final_q|final_brand",'
    '"camera":"push_in|push_out|drift|shake|static|snap|tilt|whip_pan",'
    '"texts":[{"lines":["КОРОТКО"],"mode":"pop|tracking|reveal|rise|whisper"}],'
    '"trans_out":"hard_cut|whip|zoom|glitch|dip|match|speed_ramp",'
    '"sfx":"impact|whoosh|riser|click|notify|bass|silence|none",'
    '"speed":[1.0,1.0],"accent":"accent|accent2"}]} '
    'Правила монтажа: чередуй type cinematic->typography->cinematic '
    '(текст ПОДЧЁРКИВАЕТ видео, а не заменяет); НИКАКИХ двух typography подряд; '
    'тексты — 1-3 КОРОТКИХ слова (не фразы на весь экран); '
    'длительности varied 0.3-2.8с (в climax 0.3-0.7с); '
    'match — только между визуально похожими кадрами; '
    'accent2 (красный) — ТОЛЬКО threat/compromised/warning/attack.'
)

# Чисто текстовые фоны: шот с texts на таком visual = ударная
# типографическая вставка (допустимая доля — не более ~30%).
PURE_TYPO_VISUALS = {"flash", "pause_black", "question", "final_q"}

_VALID = {
    "act": {"hook", "problem", "escalation", "peak", "twist", "accel", "climax"},
    "type": {"cinematic", "typography", "graphic"},
    "visual": {"phone_dark", "phone_message", "phone_call", "login_screen",
               "qr_panel", "qr_scan", "token_panel", "chain", "attack_grid",
               "server_rack", "server_corridor", "cables", "switch_macro",
               "keyboard", "bokeh", "eye", "face_glow", "person", "consequence",
               "flash", "pause_black", "question", "final_q", "final_brand"},
    "camera": {"push_in", "push_out", "drift", "shake", "static",
               "snap", "tilt", "whip_pan"},
    "trans_out": {"hard_cut", "whip", "zoom", "glitch", "dip", "match",
                  "speed_ramp"},
    "sfx": {"impact", "whoosh", "riser", "click", "notify", "bass",
             "silence", "none"},
    "mode": {"pop", "tracking", "reveal", "rise", "whisper", "sub"},
}

# Safe area: текст НИКОГДА не выходит за эти границы (доля кадра 1080x1920).
SAFE_L = int(W * 0.09)          # 97 px слева/справа
SAFE_R = W - SAFE_L
SAFE_T = int(H * 0.08)          # 154 px сверху/снизу
SAFE_B = H - SAFE_T
SAFE_W = SAFE_R - SAFE_L        # 886 px под текст


def set_aspect(mode="9:16"):
    """M20 (longform/YouTube): переключает холст 1080x1920 <-> 1920x1080.

    Художники читают W/H/SAFE_* как globals при каждом кадре, поэтому
    переключение живое. Шрифты в px не меняются (на 1080p высоте текст
    относительно крупнее — для сабов/карточек это ок).
    """
    global W, H, SAFE_L, SAFE_R, SAFE_T, SAFE_B, SAFE_W
    if mode == "16:9":
        W, H = 1920, 1080
    else:
        W, H = 1080, 1920
    SAFE_L = int(W * 0.09)
    SAFE_R = W - SAFE_L
    SAFE_T = int(H * 0.08)
    SAFE_B = H - SAFE_T
    SAFE_W = SAFE_R - SAFE_L
    return W, H


def _text_chars(s):
    """Все символы экранного текста шота (ударные + субтитр)."""
    n = 0
    for t in (s.get("texts") or []):
        for ln in (t.get("lines") or []):
            n += len(str(ln))
    if s.get("sub"):
        n += len(str(s["sub"]))
    return n


def _min_dur(s):
    """Минимум длительности шота (M15, TikTok-читаемость): текст на экране
    должен успеть прочитаться (~14 символов/сек + запас)."""
    typ = s.get("type", "cinematic")
    chars = _text_chars(s)
    read = chars / 14.0 + 0.5 if chars else 0.0
    if typ == "typography":
        return max(0.9, read)
    if typ == "graphic":
        return max(0.4, read)
    return max(0.6, read)


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
            # короткие строки: типографика — 1-3 слова, не фразы на весь экран
            lines = [str(x).upper().strip()[:24] for x in (t.get("lines") or [])][:3]
            lines = [l for l in lines if l]
            if not lines:
                continue
            mode = t.get("mode") if t.get("mode") in _VALID["mode"] else "pop"
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
        cam = s.get("camera") if s.get("camera") in _VALID["camera"] else "push_in"
        tr = s.get("trans_out") if s.get("trans_out") in _VALID["trans_out"] else "hard_cut"
        typ = s.get("type") if s.get("type") in _VALID["type"] else None
        if typ is None:
            # автотип: чисто текстовый фон + текст = typography,
            # текст поверх кинокадра = cinematic (текст подчёркивает видео)
            typ = "typography" if (texts and vis in PURE_TYPO_VISUALS) else "cinematic"
        voice = str(s.get("voice") or "").strip()[:140]
        sub = str(s.get("sub") or "").strip()[:70]
        # субтитр — только поверх кинокадра (TikTok: по центру, спокойный);
        # на ударных текстовых вставках субтитр не нужен (там уже текст)
        subs = ([{"lines": [sub], "mode": "sub"}]
                if (sub and typ == "cinematic") else [])
        shots.append({
            "id": f"S{i + 1:02d}",
            "act": s.get("act") if s.get("act") in _VALID["act"] else "problem",
            "type": typ,
            "dur": dur,
            "visual": vis,
            "camera": cam,
            "texts": texts,
            "subs": subs,
            "sub": sub,
            "voice": voice,
            "trans_out": tr,
            "sfx": s.get("sfx") if s.get("sfx") in _VALID["sfx"] else "none",
            "speed": speed,
            "accent": "accent2" if s.get("accent") == "accent2" else "accent",
            "fx": "glitch" if s.get("trans_out") == "glitch" else "",
            "seed": 1000 + i * 77,
        })
    if len(shots) < 4:
        raise ValueError("слишком мало шотов")
    # масштабируем длительности под целевую длину, но не ниже минимума
    # читаемости (M15): текст должен успеть прочитаться
    total = sum(s["dur"] for s in shots)
    k = seconds / max(0.1, total)
    for s in shots:
        s["dur"] = max(_min_dur(s), s["dur"] * k)
    total = sum(s["dur"] for s in shots)
    if total > seconds:
        k2 = seconds / total
        for s in shots:
            s["dur"] = max(0.4, s["dur"] * k2)
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
    # окна актов масштабируются под реальную длину (база — ~42 сек плана)
    k = max(0.4, seconds / 42.0)

    def sc(act, dur, visual, camera, texts, trans_out, sfx="none",
           speed=(1.0, 1.0), accent="accent", fx="", typ=None,
           voice="", sub=""):
        if typ is None:
            typ = ("typography"
                   if (texts and visual in PURE_TYPO_VISUALS) else "cinematic")
        subs = ([{"lines": [sub[:70]], "mode": "sub"}]
                if (sub and typ == "cinematic") else [])
        return {"act": act, "dur": dur, "visual": visual, "camera": camera,
                "texts": texts, "subs": subs, "sub": sub[:70], "voice": voice[:140],
                "trans_out": trans_out, "sfx": sfx,
                "speed": speed, "accent": accent, "fx": fx, "type": typ}

    def tx(*lines, mode="pop"):
        # короткие строки: максимум 24 символа (safe area следит за остальным)
        return [{"lines": [l.upper().strip()[:24] for l in lines], "mode": mode}]

    hook_line = short.upper().strip()[:24]
    peak_pool = ["attack_grid", "qr_scan", "token_panel", "server_corridor",
                 "phone_call", "switch_macro", "face_glow", "login_screen"]
    rnd.shuffle(peak_pool)

    # Озвучка TikTok-стиля (M16): 10+ фраз на акт, без повторов в одном видео.
    # Пары (voice — что говорит диктор, sub — субтитр по центру кадра).
    # topic вплетён в hook/вопрос; реплики разнообразные, не шаблонные.
    NARR = {
        "hook": [
            (f"Вас уже могут взламывать. {short}. Прямо сейчас.",
             "ВЗЛОМ УЖЕ ИДЁТ"),
            (f"Пока вы это читаете, {short} под угрозой.",
             "УГРОЗА УЖЕ ЗДЕСЬ"),
            (f"Каждый день {short} теряет тысячи пользователей.",
             "ТЫСЯЧИ ПОТЕРЬ"),
            (f"Кибератаки стали нормой. {short} — цель.",
             "НОРМАЛЬНАЯ ЦЕЛЬ"),
            (f"Ничего не заметили? {short} уже под контролем.",
             "УЖЕ ПОД КОНТРОЛЕМ"),
            (f"Среднее время взлома — четыре минуты. {short}.",
             "4 МИНУТЫ ДО ВЗЛОМА"),
        ],
        "problem": [
            ("Вам приходит самое обычное сообщение.", "Обычное сообщение"),
            ("Звонок с незнакомого номера.", "Незнакомый номер"),
            ("Знакомая страница входа. Почти.", "Почти знакомый вход"),
            ("Одно нажатие — и вы внутри ловушки.", "Одно нажатие"),
            ("Письмо от банка. Почти настоящее.", "Почти настоящее"),
            ("Ссылка в мессенджере от друга.", "Ссылка от друга"),
            ("Обновление системы. Срочное. Настоящее?", "Срочное обновление"),
            ("QR-код на парковке. Бесплатный Wi-Fi.", "Бесплатный Wi-Fi"),
            ("Файл в письме. Important.docx.exe.", "Поддельный файл"),
            ("Сообщение в Telegram: «Это ты?»", "Это ты?"),
            ("Реклама в соцсети. Слишком выгодное предложение.", "Выгодное предложение"),
            ("Знакомый логотип. Почти правильный URL.", "Почти правильный URL"),
        ],
        "escalation": [
            ("Ссылка. Клик. Вход. Токен.", "Цепочка атаки"),
            ("Так угоняют доступ за пару минут.", "Доступ за минуты"),
            ("Серверы уже видят чужого.", "Чужой в сети"),
            ("Пароль утек. Сессия скомпрометирована.", "Пароль утек"),
            ("Двухфакторка? Обходим. Через тебя же.", "Обходим 2FA"),
            ("Токен сессии — и админ доступ ваш.", "Токен = доступ"),
            ("Cookies подменены. Браузер доверяет.", "Браузер доверяет"),
            ("DNS-спуфинг. Вы на чужом сервере.", "Чужой сервер"),
            ("Сертификат поддельный. Замок не спасает.", "Поддельный замок"),
            ("Через SMS-пароль. Прямиком к аккаунту.", "Через SMS"),
        ],
        "peak": [
            ("Фишинг. Подмена. Украденная сессия.", "Сессия украдена"),
            ("Звонки, коды, поддельные экраны.", "Атака со всех сторон"),
            ("Устройство уже скомпрометировано.", "Устройство скомпрометировано"),
            ("Вся сеть видит ваш пароль.", "Пароль на виду"),
            ("Данные утекают. Терабайтами.", "Терабайты утечек"),
            ("Крипто-майнер в фоне. Сервер горит.", "Сервер горит"),
            ("Бэкдор открыт. И закрыть его нечем.", "Бэкдор открыт"),
            ("Рейнсомшифр. Ваши файлы — заложники.", "Файлы — заложники"),
            ("Компания молчит. Утечка — миллионы.", "Молчание = миллионы"),
            ("Права root у злоумышленника.", "Root доступ"),
        ],
        "twist": [
            ("Но самое страшное — дальше.", "Самое страшное"),
            ("Тихо. Слушайте.", "Пауза"),
            ("Дверь злоумышленникам открываете вы сами.", "Вы сами"),
            ("Замок есть. Но ключ — у них.", "Ключ у них"),
            ("Вы думаете, это не про вас?", "Не про вас?"),
            ("Спойлер: это про всех.", "Про всех"),
            ("Каждый считает, что его не тронут.", "Не тронут?"),
            ("Пока не тронут. Пока.", "Пока не тронут"),
        ],
        "accel": [
            ("Одна ошибка превращается в один аккаунт.", "Одна ошибка"),
            ("Одно устройство — и вся система.", "Вся система"),
            ("Секунда — и пароль ваш.", "Секунда"),
            ("Один клик — и доступ потерян.", "Один клик"),
            ("Три секунды. Всё. Конец.", "Три секунды"),
            ("Ноль уведомлений. Ноль шансов.", "Ноль шансов"),
            ("Тихо. Без следов. Без возможности.", "Без следов"),
            ("Файлы. Деньги. Репутация. Всё сразу.", "Всё сразу"),
        ],
        "climax": [
            ("Темп растёт. Система тает на глазах.", "Система тает"),
            (f"Так кто кого защищает в истории: {short}?", "Кто кого защищает"),
            ("Вы систему. Или система — вас?", "Вы или вас"),
            ("ТрастНод. Кибербезопасность простыми словами.", "ТрастНод"),
            ("Защита начинается с вас.", "Начните сейчас"),
            ("Не ждите взлома. Действуйте.", "Действуйте"),
            ("Кибербезопасность — это привычка.", "Привычка безопасности"),
            ("Один шаг назад — и вы впереди.", "Один шаг"),
            ("Ваша безопасность — ваш выбор.", "Ваш выбор"),
            ("ТрастНод. Мы объясняем просто.", "ТрастНод"),
        ],
    }
    _narr_i = {a: 0 for a in NARR}
    _narr_used = {a: set() for a in NARR}  # M16: не повторять в одном видео

    # Принцип: CINEMATIC -> TEXT -> CINEMATIC -> TEXT ... Текст ПОДЧЁРКИВАЕТ
    # видео (короткие ударные вставки 1-3 слова), а не заменяет его.
    # Чисто текстовые фоны (flash/pause_black/final_q) — не более ~30%.
    # M16: логичная группировка — каждый акт = своя визуальная логика.
    shots = [
        # 0-3с: HOOK — максимально сильный удар, без логотипа
        sc("hook", 2.8 * k, "phone_dark", "push_in",
           tx("ВАС УЖЕ МОГУТ", "ВЗЛОМАТЬ", mode="tracking"), "hard_cut",
           "impact", (0.7, 1.3), "accent2", typ="typography"),
        # 3-10с: ПРОБЛЕМА — бытовые ситуации: сообщение, звонок, ссылка.
        # Чередование: живой кадр → текст-вспышка → живой кадр → текст.
        # Камера drift/push_in (вовлечение), текст pop (быстрый удар).
        sc("problem", 2.0 * k, "phone_message", "drift", [], "whip",
           "notify", (1.0, 1.2)),
        sc("problem", 0.9 * k, "flash", "static",
           tx("ОДНА ССЫЛКА", mode="pop"), "hard_cut", "click",
           typ="typography"),
        sc("problem", 1.6 * k, "phone_call", "push_in", [], "match",
           "notify", (1.0, 1.1)),
        sc("problem", 0.7 * k, "flash", "static",
           tx("ОДИН ЗВОНОК", mode="pop"), "hard_cut", "click",
           typ="typography"),
        sc("problem", 1.5 * k, "login_screen", "push_in", [], "zoom",
           "whoosh", (1.1, 1.3)),
        sc("problem", 0.7 * k, "flash", "static",
           tx("ОДИН КЛИК", mode="pop"), "hard_cut", "impact",
           typ="typography"),
        sc("problem", 1.3 * k, "person", "drift", [], "whip", "notify",
           (0.9, 1.1)),
        # 10-20с: ЭСКАЛАЦИЯ — технические средства атаки по цепочке.
        # keyboard → qr → token → server: нарастание масштаба.
        # Камера push_in/snap (напряжение), текст — редкие вспышки.
        sc("escalation", 1.4 * k, "keyboard", "push_in", [], "hard_cut",
           "click", (1.2, 1.6)),
        sc("escalation", 0.8 * k, "qr_scan", "snap", [], "hard_cut",
           "whoosh", (1.5, 2.0)),
        sc("escalation", 1.1 * k, "token_panel", "drift", [], "whip",
           "notify"),
        sc("escalation", 0.7 * k, "flash", "static",
           tx("ДОСТУП", mode="pop"), "hard_cut", "bass", typ="typography"),
        sc("escalation", 1.6 * k, "server_corridor", "push_in", [],
           "match", "riser", (0.9, 1.5)),
        sc("escalation", 0.9 * k, "cables", "snap", [], "hard_cut",
           "click", (1.3, 1.7)),
        # 20-30с: ПИК ДИНАМИКИ — быстрые кадры 0.5-0.9с, красный accent2.
        # Визуал: лицо,.GridView, замки, серверы — хаос атаки.
        # Камера shake/snap (паника), glitch на ключевых моментах.
        sc("peak", 0.8 * k, peak_pool[0], "shake", [], "hard_cut",
           "impact", (1.4, 1.4), "accent2", typ="graphic"),
        sc("peak", 0.5 * k, peak_pool[1], "shake", [], "hard_cut",
           "click", (1.6, 1.6)),
        sc("peak", 0.7 * k, peak_pool[2], "push_in", [], "whip",
           "bass", (1.5, 1.5)),
        sc("peak", 0.5 * k, peak_pool[3], "snap", [], "hard_cut",
           "whoosh", (1.8, 1.8)),
        sc("peak", 0.8 * k, peak_pool[4], "shake",
           tx("СЕССИЯ УКРАДЕНА", mode="tracking"), "glitch", "impact",
           (1.3, 1.3), "accent2", fx="glitch"),
        sc("peak", 0.6 * k, peak_pool[5], "drift", [], "hard_cut",
           "click", (1.6, 1.6)),
        sc("peak", 0.9 * k, peak_pool[6], "push_in",
           tx("ДОСТУП РАЗРЕШЁН", mode="pop"), "dip", "bass", (1.2, 0.6),
           "accent2"),
        # 30-35с: РЕЗКАЯ ПАУЗА — темп и звук падают. Только чёрный + eye.
        # Камера static (стоп-кадр), текст reveal (медленно появляется).
        sc("twist", 1.6 * k, "pause_black", "static",
           tx("НО САМОЕ", "СТРАШНОЕ...", mode="reveal"), "dip", "silence",
           (0.4, 0.4), typ="typography"),
        sc("twist", 1.2 * k, "pause_black", "static", [], "dip",
           "silence", (0.3, 0.3)),
        sc("twist", 2.0 * k, "eye", "push_in",
           tx("ОТКРОЕТЕ ДВЕРЬ", "ВЫ САМИ", mode="tracking"), "zoom",
           "impact", (0.5, 1.8)),
        # 35-50с: ФИНАЛЬНОЕ УСКОРЕНИЕ — масштаб растёт: ошибка→аккаунт→система.
        # Визуал: consequence (нарастание), камера push_in→push_out (расширение).
        # Один кадр keyboards как « корень ошибки».
        sc("accel", 1.6 * k, "keyboard", "push_in",
           tx("1 ОШИБКА", mode="pop"), "hard_cut", "bass", (1.0, 1.4)),
        sc("accel", 1.3 * k, "consequence", "push_in",
           tx("1 АККАУНТ", mode="pop"), "match", "impact", (1.0, 1.4)),
        sc("accel", 1.2 * k, "consequence", "push_in",
           tx("1 УСТРОЙСТВО", mode="pop"), "whip", "impact", (1.0, 1.6)),
        sc("accel", 1.8 * k, "consequence", "push_out",
           tx("ВСЯ СИСТЕМА", mode="tracking"), "zoom", "riser", (0.8, 1.6),
           "accent2"),
        # 50-60с: КУЛЬМИНАЦИЯ — быстрые кадры, затем резкое замедление.
        # Визуал: attack_grid → face_glow → server → пауза → бренд.
        # Камера shake→snap→push_in→static: от хаоса к тишине.
        sc("climax", 0.7 * k, "attack_grid", "shake", [], "hard_cut",
           "impact", (1.5, 1.5), "accent2", typ="graphic"),
        sc("climax", 0.5 * k, "face_glow", "snap", [], "hard_cut",
           "bass", (1.4, 1.4)),
        sc("climax", 0.8 * k, "server_corridor", "push_in", [], "whip",
           "whoosh", (1.0, 2.2)),
        sc("climax", 1.2 * k, "pause_black", "static", [], "dip",
           "silence", (0.4, 0.4)),
        # финал — кинематографично: маленький текст, пауза, бренд
        sc("climax", 2.0 * k, "final_q", "static",
           tx("КТО КОГО", mode="whisper"), "dip", "bass", (0.6, 0.8),
           typ="typography"),
        sc("climax", 2.4 * k, "final_q", "static",
           tx("ЗАЩИЩАЕТ?", mode="whisper"), "dip", "silence", (0.5, 0.6),
           typ="typography"),
        sc("climax", 3.4 * k, "final_brand", "push_out", [], "hard_cut",
           "impact", (0.7, 1.0), typ="graphic"),
    ]
    total = sum(s["dur"] for s in shots)
    out = []
    for i, s in enumerate(shots):
        s = dict(s)
        s["id"] = f"S{i + 1:02d}"
        # озвучка/субтитр из пула акта (M16: без повторов в одном видео)
        act = s.get("act", "problem")
        pool = NARR.get(act) or NARR["problem"]
        used = _narr_used.get(act, set())
        # ищем первый неиспользованный индекс
        idx = _narr_i.get(act, 0)
        start = idx
        while idx % len(pool) in used and (idx - start) < len(pool):
            idx += 1
        if (idx - start) >= len(pool):
            # все использованы — сбрасываем used и берём первый
            _narr_used[act] = set()
            used = set()
            idx = start
        chosen = idx % len(pool)
        v, b = pool[chosen]
        _narr_i[act] = idx + 1
        _narr_used[act] = used | {chosen}
        if not s.get("voice"):
            s["voice"] = v[:140]
        if not s.get("sub"):
            s["sub"] = b[:70]
            if s.get("type") == "cinematic":
                s["subs"] = [{"lines": [s["sub"]], "mode": "sub"}]
        # читаемость уже в шаблоне (M15): текст должен успеть прочитаться
        s["dur"] = max(s["dur"], _min_dur(s))
        # подгон под seconds делает generate_cinematic; тут только id/seed
        s["seed"] = (abs(hash(topic)) + i * 131) % (2 ** 32)
        out.append(s)
    return out


def script_to_shots(script_text, topic=None, seconds=55,
                    style_name="cybersecurity_cinematic"):
    """СТАТЬЯ -> SHOT LIST (M17): озвучка и субтитры — из текста статьи.

    Каждая секция parse_script -> кинокадры (voice-чанки ≤140 символов,
    sub = тот же чанк ≤70, синхрон TikTok) + одна ударная типографика
    из заголовка. Акты: hook -> problem -> escalation/peak/twist/accel ->
    climax + финал (whisper + бренд). Generic-пулы NARR НЕ используются —
    ни одной чужой фразы в видео по статье.
    Возвращает (shots, target_seconds): длина подгоняется под озвучку
    статьи (как /videotest script-режим), но не более 120с.
    """
    import re as _re
    sections = vg.parse_script(script_text)
    topic = ((topic or "").strip()
             or sections[0]["heading"] or "Разбор").strip()
    short = topic[:48]
    k = max(0.4, seconds / 42.0)

    def sc(act, dur, visual, camera, texts, trans_out, sfx="none",
           speed=(1.0, 1.0), accent="accent", fx="", typ=None,
           voice="", sub=""):
        if typ is None:
            typ = ("typography"
                   if (texts and visual in PURE_TYPO_VISUALS) else "cinematic")
        subs = ([{"lines": [sub[:70]], "mode": "sub"}]
                if (sub and typ == "cinematic") else [])
        return {"act": act, "dur": dur, "visual": visual, "camera": camera,
                "texts": texts, "subs": subs, "sub": sub[:70], "voice": voice[:140],
                "trans_out": trans_out, "sfx": sfx,
                "speed": speed, "accent": accent, "fx": fx, "type": typ}

    def tx(*lines, mode="pop"):
        return [{"lines": [l.upper().strip()[:24] for l in lines], "mode": mode}]

    def _hard_split(text, limit):
        # жёсткая нарезка по словам (длинные слова — по символам)
        words, cur, out = str(text).split(), "", []
        for w in words:
            t = (cur + " " + w).strip()
            if len(t) <= limit:
                cur = t
            else:
                if cur:
                    out.append(cur)
                while len(w) > limit:
                    out.append(w[:limit])
                    w = w[limit:]
                cur = w
        if cur:
            out.append(cur)
        return out or [str(text)[:limit]]

    def _sentences(body):
        parts = _re.split(r"(?<=[.!?…;:])\s+", body.strip())
        return [p.strip() for p in parts if p.strip()]

    def _smart_sub(chunk, limit=70):
        # субтитр по границе слов, синхронен чанку озвучки
        if len(chunk) <= limit:
            return chunk
        cut = chunk[:limit].rsplit(" ", 1)
        return cut[0] if len(cut) == 2 and len(cut[0]) >= limit // 2 else chunk[:limit]

    def _typo_lines(heading):
        # ударная вставка из заголовка: до 3 слов, до 2 строк ≤24.
        # Авточасти parse_script («Часть N») вставок не получают.
        if (heading or "").upper().startswith("ЧАСТЬ"):
            return None
        words = [w.strip("«»\"'.,!?—–-").upper()
                 for w in (heading or "").split()]
        words = [w for w in words if w][:3]
        if not words:
            return None
        lines, cur = [], ""
        for w in words:
            t = (cur + " " + w).strip()
            if len(t) <= 24:
                cur = t
            elif not lines:
                lines.append(cur or w[:24])
                cur = "" if cur else ""
            else:
                break
        if cur:
            lines.append(cur)
        return lines[:2] or None

    # Все предложения секции (бюджет ~100с ниже сам подрежет длинные
    # статьи); короткие статьи озвучиваются целиком
    sec_chunks = []
    for sec in sections:
        sents = _sentences(sec["body"])
        chunks = []
        for sent in sents:
            chunks.extend(_hard_split(sent, 140))
        sec_chunks.append({"heading": sec["heading"],
                           "chunks": chunks[:8] or [sec["body"][:140]]})

    def _voice_est():
        return sum(len(c) / 12.0 + 0.5
                   for s in sec_chunks for c in s["chunks"] if c)

    # бюджет озвучки ~100с: сначала режем лишние чанки, потом — средние секции
    for _ in range(64):
        if _voice_est() <= 100:
            break
        cand = [s for s in sec_chunks if len(s["chunks"]) > 1]
        if not cand:
            break
        longest = max(cand, key=lambda s: sum(map(len, s["chunks"])))
        longest["chunks"].pop()
    for _ in range(64):
        if _voice_est() <= 100 or len(sec_chunks) <= 2:
            break
        sec_chunks.pop(len(sec_chunks) // 2)

    pairs = [(si, c) for si, s in enumerate(sec_chunks)
             for c in s["chunks"] if c]
    if len(pairs) == 1 and len(pairs[0][1]) > 70:
        # вырожденный вход (одно предложение): делим на hook + climax,
        # иначе QC voice_covers_all не закроется
        txt = pairs[0][1]
        cut = txt[:len(txt) // 2].rsplit(" ", 1)
        mid = len(cut[0]) if len(cut) == 2 and len(cut[0]) >= 20 else len(txt) // 2
        pairs = [(pairs[0][0], txt[:mid].strip()),
                 (pairs[0][0], txt[mid:].strip())]
    n = len(pairs)

    # Акты по длине чанков (best-effort под QC climax_faster: финал короче
    # пика). Порядок контента не трогаем — только метки актов.
    acts = [None] * n
    acts[0] = "hook"
    if n >= 2:
        # climax — самый короткий из хвоста, сосед — accel
        tail = [n - 1] if n < 4 else [n - 2, n - 1]
        cl = min(tail, key=lambda i: len(pairs[i][1]))
        acts[cl] = "climax"
        for i in tail:
            if acts[i] is None:
                acts[i] = "accel"
    if n >= 3 and acts[1] is None:
        acts[1] = "problem"
    free_mid = [i for i in range(2, n - 1) if acts[i] is None]
    if free_mid and "peak" not in acts:
        # peak — самому длинному среднему чанку
        acts[max(free_mid, key=lambda i: len(pairs[i][1]))] = "peak"
    cyc = ["escalation", "peak", "twist", "accel"]
    ci = 0
    for i in range(n):
        if acts[i] is None:
            acts[i] = cyc[ci % len(cyc)]
            ci += 1

    visuals = ["phone_message", "login_screen", "keyboard", "qr_scan",
               "token_panel", "server_corridor", "cables", "person",
               "phone_call", "face_glow", "eye", "server_rack",
               "switch_macro", "consequence", "bokeh"]
    peak_pool = ["attack_grid", "face_glow", "server_corridor",
                 "eye", "consequence"]
    cameras = ["push_in", "drift", "push_out", "tilt", "whip_pan", "push_in"]
    trans = ["hard_cut", "whip", "zoom", "match", "hard_cut", "dip"]

    # M18: стартовая позиция видеоряда от хэша статьи — разные статьи
    # дают разный порядок художников/камер, а не один и тот же цикл
    off = abs(hash(script_text))
    shots, vi = [], off % len(visuals)
    for i, (si, chunk) in enumerate(pairs):
        act = acts[i]
        if act == "peak":
            vis, accent = peak_pool[(i + off) % len(peak_pool)], "accent2"
        else:
            vis, accent = visuals[vi % len(visuals)], "accent"
            vi += 1
        sfx = "impact" if act == "peak" else ("bass" if act == "hook" else "none")
        dur = max(1.0, len(chunk) / 12.0 + 0.6)
        shots.append(
            {"sec": si,
             "shot": sc(act, dur, vis, cameras[(i + off) % len(cameras)], [],
                        trans[(i * 3 + off) % len(trans)], sfx, (1.2, 1.2),
                        accent, "", None, chunk, _smart_sub(chunk))})

    # сборка по секциям: кадры + ударная типографика из заголовка;
    # посередине — резкая пауза (QC pause_before_climax)
    out = []
    half = max(1, len(sec_chunks) // 2)
    out_pause = False
    for si, sec in enumerate(sec_chunks):
        for item in shots:
            if item["sec"] == si:
                out.append(item["shot"])
        tl = _typo_lines(sec["heading"])
        if tl:
            out.append(sc("accel" if si else "problem", 1.2 * k,
                          "flash" if si % 2 else "question", "snap",
                          tx(*tl), "hard_cut", "click", (1.4, 1.4),
                          typ="typography"))
        if si + 1 == half and len(sec_chunks) > 1:
            out.append(sc("twist", 1.6 * k, "pause_black", "static",
                          [], "dip", "silence", (0.4, 0.4)))
            out_pause = True  # noqa: F841 (флаг читается после цикла)
    if not out_pause and len(out) >= 6:
        # одна секция без разбивки: пауза посередине всё равно нужна
        # (финал добавляется позже, тут кадров ещё меньше итога)
        out.insert(len(out) // 2,
                   sc("twist", 1.6 * k, "pause_black", "static",
                      [], "dip", "silence", (0.4, 0.4)))
    # финал: заголовок последней секции шёпотом + бренд
    last_head = sec_chunks[-1]["heading"] if sec_chunks else short
    fl = _typo_lines(last_head) or [short.upper().strip()[:24]]
    out.append(sc("climax", 2.0 * k, "final_q", "static",
                  tx(*fl, mode="whisper"), "dip", "bass", (0.6, 0.8),
                  typ="typography"))
    out.append(sc("climax", 3.4 * k, "final_brand", "push_out", [],
                  "hard_cut", "impact", (0.7, 1.0), typ="graphic"))
    # лимит coerce (40): сначала жертвуем средними типографиками
    for _ in range(64):
        if len(out) <= 40:
            break
        for j in range(len(out) - 3, 2, -1):
            s = out[j]
            if (s.get("type") == "typography"
                    and not {t.get("mode") for t in s.get("texts", [])}
                    <= {"whisper"}):
                del out[j]
                break
        else:
            break
    out = out[:40]

    total = sum(s["dur"] for s in out)
    res = []
    for i, s in enumerate(out):
        s = dict(s)
        s["id"] = f"S{i + 1:02d}"
        s["dur"] = max(s["dur"], _min_dur(s))
        s["seed"] = (abs(hash(script_text)) + i * 131) % (2 ** 32)
        res.append(s)
    est_voice = sum(len(s["voice"]) / 12.0 + 0.5
                    for s in res if s.get("voice"))
    n_static = sum(1 for s in res if not s.get("voice"))
    target = min(120.0, max(float(seconds), est_voice + n_static * 1.0 + 4))
    print(f"[cine] план по статье: {len(res)} шотов, "
          f"озвучка ~{est_voice:.0f}с, цель {target:.0f}с")
    return res, target


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
                f"Каждому шоту задай type: cinematic (кинокадр БЕЗ текста) / "
                f"typography (короткая ударная вставка 1-3 СЛОВА) / graphic. "
                f"Чередуй cinematic->typography->cinematic, НИКАКИХ двух "
                f"typography подряд (доля typography ~25%). Тексты — по-русски, "
                f"ЗАГЛАВНЫМИ, максимум 3 слова на строку, до 3 строк (это НЕ "
                f"субтитры; длинные фразы разбивай на последовательные шоты). "
                f"match — только между похожими кадрами; accent2 — только "
                f"threat/compromised/warning. Никаких Matrix/хакеров в капюшонах/"
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
        # тревожное свечение нарастает — в цвете акцента шота
        # (красный accent2 — только если шот помечен как threat/warning)
        img = _glow_spot(img.convert("RGBA"), W // 2, H // 2 + 120, int(300 + 200 * p),
                         accent, int(30 + 50 * p)).convert("RGB")
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
        # тёмный глаз: концентрические дуги + зрачок (текст идёт оверлеем, не тут)
        cx, cy = W // 2, H // 2 - 100
        for i, rr in enumerate((300, 230, 160, 100)):
            col = accent if i % 2 == 0 else P["line"]
            d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], outline=col, width=4)
        pr = int(60 + 20 * p)
        d.ellipse([cx - pr, cy - pr, cx + pr, cy + pr], fill=accent)
        d.line([(cx - 300, cy - 120), (cx - 60, cy - 40)], fill=(220, 235, 255), width=8)
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
        # эскалация масштаба БЕЗ кругов: вложенные панели растут с прогрессом,
        # угловые метки + микротекст. Текст тезиса идёт оверлеем поверх.
        cx, cy = W // 2, H // 2 - 60
        grow = 0.55 + 0.45 * p
        for i in range(4):
            hw = int((300 + i * 130) * grow)
            hh = int((200 + i * 95) * grow)
            col = accent if i == 3 else P["line"]
            d.rounded_rectangle([cx - hw, cy - hh, cx + hw, cy + hh],
                                radius=26, outline=col, width=4 if i == 3 else 2)
        # угловые скобки внешней панели
        L = 54
        x0, y0 = cx - hw, cy - hh
        x1, y1 = cx + hw, cy + hh
        for (sx, sy) in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
            dx = 1 if sx == x0 else -1
            dy = 1 if sy == y0 else -1
            d.line([(sx, sy), (sx + dx * L, sy)], fill=accent, width=5)
            d.line([(sx, sy), (sx, sy + dy * L)], fill=accent, width=5)
        img = _glow_spot(img.convert("RGBA"), cx, cy, int(160 + 200 * p), accent, 70).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
        _center_text(d, y1 + 44, "// МАСШТАБ РАСТЁТ", f_xs, P["sub"], cx)
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
    elif visual == "flash":
        # ударная типографическая вставка: почти чёрный + сканлайны +
        # микро-метаданные по углам (без кругов и тяжёлой графики)
        d.rectangle([0, 0, W, H], fill=(2, 3, 6))
        for y in range(0, H, 9):
            d.line([(0, y), (W, y)], fill=(16, 24, 42, 110))
        d.rectangle([SAFE_L - 30, SAFE_T - 30, SAFE_R + 30, SAFE_B + 30],
                    outline=P["line"], width=2)
        _center_text(d, SAFE_T - 6, "// TRUSTNODE // 09:16", f_xs, P["sub"], W // 2)
        slide = int(160 * (1 - min(1.0, p * 3)))
        d.rectangle([SAFE_L - 30 + slide, SAFE_B - 60, SAFE_L + 220 + slide, SAFE_B - 52],
                    fill=accent)
    elif visual == "final_q":
        # финал: почти чёрный кадр, faint-глоу снизу, текст — оверлеем whisper
        d.rectangle([0, 0, W, H], fill=(1, 2, 4))
        img = _glow_spot(img.convert("RGBA"), W // 2, H + 120, 620, accent, 40).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
        pulse = 0.5 + 0.5 * math.sin(p * math.pi * 2)
        d.line([(W // 2 - 90, H // 2 + 330), (W // 2 + 90, H // 2 + 330)],
               fill=accent, width=int(2 + 3 * pulse))
    elif visual == "keyboard":
        # macro: клавиши ноутбука ночью + свет экрана на руках
        _bokeh_layer(d, seed + 8, P, 10)
        base_y = H // 2 - 120
        for r_ in range(4):
            y = base_y + r_ * 150
            for c_ in range(6):
                x = 90 + c_ * 155
                lit = ((r_ * 5 + c_ * 2 + int(p * 8)) % 9 == 0)
                d.rounded_rectangle([x, y, x + 120, y + 110], radius=16,
                                    fill=(26, 38, 64) if lit else (10, 15, 28),
                                    outline=accent if lit else P["line"],
                                    width=3 if lit else 2)
        # свет экрана сверху
        for i in range(5):
            yy = 120 + i * 26
            d.rectangle([120, yy, W - 120, yy + 10], fill=accent)
        img = _glow_spot(img.convert("RGBA"), W // 2, 200, 380, accent, 55).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
    elif visual == "face_glow":
        # лицо, освещённое смартфоном в темноте: тёмный овал + светящийся прямоугольник
        # (M20: координаты от H — работает и в 16:9)
        cx = W // 2
        d.ellipse([cx - 200, int(H * 0.29), cx + 200, int(H * 0.5625)],
                  fill=(10, 13, 22), outline=P["line"], width=3)
        d.rounded_rectangle([cx - 130, int(H * 0.60), cx + 130, int(H * 0.755)],
                            radius=24, fill=(24, 44, 92),
                            outline=accent, width=3)
        img = _glow_spot(img.convert("RGBA"), cx, int(H * 0.68),
                         int(200 + 120 * p), accent, 80).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
        _center_text(d, int(H * 0.79), "// ЭКРАН ОСВЕЩАЕТ ЛИЦО", f_xs, P["sub"], cx)
    elif visual == "switch_macro":
        # macro сетевого оборудования: ряды портов + мигающие LED
        _bokeh_layer(d, seed + 9, P, 8)
        for r_ in range(5):
            y = 420 + r_ * 220
            d.rounded_rectangle([80, y, W - 80, y + 160], radius=12, fill=(9, 14, 27),
                                outline=P["line"], width=2)
            for u in range(8):
                x = 140 + u * 105
                led = accent if ((r_ * 3 + u * 5 + int(p * 14)) % 6 == 0) else (36, 56, 90)
                d.ellipse([x, y + 66, x + 26, y + 92], fill=led)
                d.rectangle([x + 34, y + 70, x + 66, y + 88], fill=(24, 34, 56))
    elif visual == "server_corridor":
        # коридор серверных стоек с перспективой к центру
        cx = W // 2
        for i in range(6):
            t = i / 5
            hw = int(420 * (1 - t * 0.72))
            y0 = int(240 + t * 620)
            y1 = int(y0 + 900 * (1 - t * 0.72))
            col = accent if i == 5 else P["line"]
            d.rounded_rectangle([cx - hw, y0, cx + hw, y1], radius=10,
                                fill=(8, 12, 24), outline=col, width=4 if i == 5 else 2)
            for u in range(4):
                lx = cx - hw + 60 + u * ((2 * hw - 120) // 3)
                led = accent if ((i + u + int(p * 10)) % 4 == 0) else (36, 56, 90)
                d.ellipse([lx, y0 + 40, lx + 18, y0 + 58], fill=led)
        img = _glow_spot(img.convert("RGBA"), cx, H // 2, 300, accent, 50).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
    elif visual == "qr_scan":
        # сканирование QR смартфоном: крупный QR + рамка видоискателя
        qs, qn = 560, 25
        qx, qy = (W - qs) // 2, H // 2 - 260
        sc_q = 0.8 + 0.35 * p
        qs2 = int(qs * sc_q)
        qx2 = (W - qs2) // 2
        qy2 = qy - (qs2 - qs) // 2
        d.rectangle([qx2 - 20, qy2 - 20, qx2 + qs2 + 20, qy2 + qs2 + 20],
                    fill=(235, 240, 250))
        cell = qs2 / qn
        for r_ in range(qn):
            for c_ in range(qn):
                in_f = (r_ < 7 and c_ < 7) or (r_ < 7 and c_ >= qn - 7) or (r_ >= qn - 7 and c_ < 7)
                if in_f or rnd.random() < 0.42:
                    d.rectangle([qx2 + c_ * cell, qy2 + r_ * cell,
                                 qx2 + (c_ + 1) * cell, qy2 + (r_ + 1) * cell],
                                fill=(8, 10, 16))
        L = 90
        for (sx, sy, dx, dy) in ((qx2 - 46, qy2 - 46, 1, 1), (qx2 + qs2 + 46, qy2 - 46, -1, 1),
                                 (qx2 - 46, qy2 + qs2 + 46, 1, -1),
                                 (qx2 + qs2 + 46, qy2 + qs2 + 46, -1, -1)):
            d.line([(sx, sy), (sx + dx * L, sy)], fill=accent, width=7)
            d.line([(sx, sy), (sx, sy + dy * L)], fill=accent, width=7)

    img = _vignette(img)
    img = _grain(img, seed)
    return img


# ---------- kinetic typography (safe area: текст НИКОГДА не обрезается) ----------

def _wrap_to_width(d, line, f, max_w):
    """Жадный перенос строки по словам под max_w. Возвращает <=3 строк."""
    words, out, cur = str(line).split(), [], ""
    for w_ in words:
        trial = (cur + " " + w_).strip()
        if _ts(d, trial, f)[0] <= max_w or not cur:
            cur = trial
        else:
            out.append(cur)
            cur = w_
    if cur:
        out.append(cur)
    return out[:3]


def _tracked_width(d, line, f, gap):
    widths = [_ts(d, ch, f)[0] for ch in line]
    return sum(widths) + gap * max(0, len(line) - 1), widths


def fit_text_block(d, lines, mode, fonts):
    """Подбирает шрифт/переносы/трекинг так, чтобы блок влез в SAFE_W.

    Возвращает (font, fitted_lines, gap). Гарантия: ни одна строка не шире
    SAFE_W — обрезка краями кадра невозможна по построению.
    """
    if mode == "whisper":
        sizes = [54, 44, 36]
        getf = lambda sz: _font(JURA, sz, 500)
        gap0 = 8
    elif mode == "sub":
        # TikTok-субтитр: читаемый, спокойный, максимум 2 строки по центру
        sizes = [64, 54, 44]
        getf = lambda sz: _font(JURA, sz, 500)
        gap0 = 0
    else:
        sizes = [118, 88, 64, 48]
        getf = lambda sz: _font(EXO2, sz, 900)
        gap0 = 0
    for sz in sizes:
        f = getf(sz)
        fitted = []
        for ln in lines:
            fitted.extend(_wrap_to_width(d, ln, f, SAFE_W))
        fitted = fitted[:2] if mode == "sub" else fitted[:3]
        if not fitted:
            continue
        if mode == "tracking":
            gap = gap0 or min(46, max(0, (SAFE_W - max(
                _tracked_width(d, ln, f, 0)[0] for ln in fitted)) // max(1, max(
                    len(ln) for ln in fitted) - 1)))
            ok = all(_tracked_width(d, ln, f, gap)[0] <= SAFE_W for ln in fitted)
        else:
            gap = 0
            ok = all(_ts(d, ln, f)[0] <= SAFE_W for ln in fitted)
        if ok:
            return f, fitted, gap
    # последний рубеж: самый мелкий шрифт + жёсткая нарезка по символам
    f = getf(sizes[-1])
    hard = []
    for ln in lines:
        s = ln
        while s:
            hard.append(s[:18])
            s = s[18:]
    return f, hard[:3], 0


def draw_texts(img, texts, p, fonts, P):
    """Типографика поверх кадра строго внутри safe area.

    Возвращает список bbox нарисованных блоков (для QC-проверки).
    """
    if not texts:
        return []
    d = ImageDraw.Draw(img, "RGBA")
    bboxes = []
    n = len(texts)
    for k, t in enumerate(texts):
        lines, mode = t["lines"], t.get("mode", "pop")
        f, fitted, gap = fit_text_block(d, lines, mode, fonts)
        lh = _ts(d, "АЙ", f)[1]
        step = lh + (18 if mode == "whisper" else 26)
        block_h = len(fitted) * step
        if mode == "whisper":
            y_base = H // 2 - 120 - block_h // 2
        elif mode == "sub":
            # TikTok-субтитр строго по центру кадра
            y_base = int(H * 0.58) - block_h // 2
        else:
            zone_h = 340
            y_base = H // 2 - (n * zone_h) // 2 + k * zone_h
        # кламп по вертикали в safe area
        y_base = max(SAFE_T, min(SAFE_B - block_h, y_base))
        q = min(1.0, p / 0.3) if p < 0.3 else 1.0
        alpha = int(255 * min(1.0, p / 0.12))
        for j, line in enumerate(fitted):
            if mode == "tracking":
                tw, _ = _tracked_width(d, line, f, gap)
            else:
                tw, _ = _ts(d, line, f)
            y = y_base + j * step
            x = (W - tw) // 2
            # кламп по горизонтали в safe area (оборона в глубину)
            x = max(SAFE_L, min(SAFE_R - tw, x))
            d.rounded_rectangle([x - 30, y - 14, x + tw + 30, y + lh + 14],
                                radius=20, fill=(3, 5, 10, 190))
            bboxes.append((x, y, x + tw, y + lh))
            if mode == "pop":
                sc = 0.6 + 0.4 * (1 - (1 - q) ** 3)
                tmp = Image.new("RGBA", (int(tw) + 80, lh + 60), (0, 0, 0, 0))
                td = ImageDraw.Draw(tmp)
                td.text((40, 30), line, font=f, fill=(245, 248, 255, alpha))
                nw, nh = max(1, int(tmp.width * sc)), max(1, int(tmp.height * sc))
                tmp = tmp.resize((nw, nh), Image.BICUBIC)
                img.paste(tmp, ((W - nw) // 2, int(y + (lh - nh) // 2)), tmp)
            elif mode == "tracking":
                _, widths = _tracked_width(d, line, f, gap)
                xx = x
                for ch, cw in zip(line, widths):
                    d.text((xx, y), ch, font=f, fill=(245, 248, 255, alpha))
                    xx += cw + gap
            elif mode == "whisper" or mode == "sub":
                # маленький текст, медленное проявление, лёгкий трекинг
                a2 = int(255 * min(1.0, p / 0.35))
                _, widths = _tracked_width(d, line, f, gap)
                xx = x
                for ch, cw in zip(line, widths):
                    d.text((xx, y), ch, font=f, fill=(235, 240, 252, a2))
                    xx += cw + gap
            elif mode == "reveal":
                if q < 1.0:
                    tmp = Image.new("RGBA", (int(tw) + 40, lh + 40), (0, 0, 0, 0))
                    td = ImageDraw.Draw(tmp)
                    td.text((20, 20), line, font=f, fill=(245, 248, 255, alpha))
                    vis = int(tmp.width * q)
                    if vis > 0:
                        img.paste(tmp.crop((0, 0, vis, tmp.height)),
                                  (int(x) - 20, int(y) - 20),
                                  tmp.crop((0, 0, vis, tmp.height)))
                else:
                    d.text((x, y), line, font=f, fill=(245, 248, 255, alpha))
            else:  # rise
                yy = int(y + 90 * (1 - q))
                d.text((x, yy), line, font=f, fill=(245, 248, 255, alpha))
    return bboxes


def draw_tracked(d, line, f, y, gap, alpha):
    _, widths = _tracked_width(d, line, f, gap)
    x = (W - (sum(widths) + gap * max(0, len(line) - 1))) // 2
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
    if camera == "snap":
        # резкий наезд: snap-zoom к концу шота
        s = 1.0 + 0.30 * (p ** 2)
        bw, bh = int(W * s), int(H * s)
        big = img.resize((bw, bh), Image.BICUBIC)
        return big.crop(((bw - W) // 2, (bh - H) // 2, (bw - W) // 2 + W, (bh - H) // 2 + H))
    if camera == "tilt":
        # лёгкий наклон + дрейф (псевдо-тилт в посте)
        ang = -2.0 + 4.0 * p
        big = img.resize((int(W * 1.12), int(H * 1.12)), Image.BICUBIC)
        big = big.rotate(ang, resample=Image.BICUBIC, center=(big.width // 2, big.height // 2))
        bw, bh = big.size
        return big.crop(((bw - W) // 2, (bh - H) // 2, (bw - W) // 2 + W, (bh - H) // 2 + H))
    if camera == "whip_pan":
        # хлыст-камера внутри шота: быстрый горизонтальный пролёт со streaks
        dx = int(W * 0.55 * p)
        big = img.resize((W + int(W * 0.55) + 40, H), Image.BICUBIC)
        out = big.crop((dx, 0, dx + W, H))
        d = ImageDraw.Draw(out, "RGBA")
        rnd = random.Random(seed + frame_i // 3)
        for _ in range(14):
            y = rnd.randrange(H)
            d.line([(0, y), (W, y)], fill=(150, 180, 230, 46))
        return out
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
    if kind == "match":
        # match cut: A и B связаны масштабом — лёгкий общий наезд + кроссфейд.
        # Работает между визуально похожими кадрами (экраны, серверы).
        s = 1.0 + 0.10 * q
        def _sc(im):
            bw, bh = int(W * s), int(H * s)
            big = im.resize((bw, bh), Image.BICUBIC)
            return big.crop(((bw - W) // 2, (bh - H) // 2, (bw - W) // 2 + W, (bh - H) // 2 + H))
        return Image.blend(_sc(img_a), _sc(img_b), q)
    if kind == "speed_ramp":
        # резкое ускорение сквозь кадр: сильный zoom-blur переход
        sa = 1.0 + 0.9 * q
        ba = img_a.resize((int(W * sa), int(H * sa)), Image.BICUBIC)
        ba = ba.crop(((ba.width - W) // 2, (ba.height - H) // 2,
                      (ba.width - W) // 2 + W, (ba.height - H) // 2 + H))
        sb = 0.7 + 0.3 * q
        bb = img_b.resize((max(1, int(W * sb)), max(1, int(H * sb))), Image.BICUBIC)
        canvas = Image.new("RGB", (W, H), (0, 0, 0))
        canvas.paste(bb, ((W - bb.width) // 2, (H - bb.height) // 2))
        return Image.blend(ba, canvas, min(1.0, q * 1.5))
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


def build_soundtrack(shots, bounds, seconds, bpm, pause_win=None, sr=SR,
                     bed=1.0, sfx_gain=1.0, duck=None):
    """Микс: тёмный beat-bed по сетке + SFX на склейках. Возвращает int16 mono.

    bed/sfx_gain — уровни из пресета стиля (M15: фон тихий, не мешает голосу).
    duck — массив 0..1 (огибающая голоса): бит проседает под речью.
    """
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
            mix[i:i + m] += k[:m].astype(np.float64) * 0.15 * bed
    t = np.arange(n) / sr
    drone = (np.sin(2 * np.pi * 55 * t) * 0.5 + np.sin(2 * np.pi * 82.5 * t) * 0.3)
    drone *= (0.7 + 0.3 * np.sin(2 * np.pi * 0.15 * t))
    if pause_win:
        i0, i1 = int(pause_win[0] * sr), min(n, int(pause_win[1] * sr))
        drone[i0:i1] *= 0.15
    mix += drone * 1200 * bed
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
            mix[i:i + m] += sfx[:m].astype(np.float64) * 0.5 * sfx_gain
    if duck is not None and len(duck) == n:
        mix *= (1.0 - 0.65 * np.clip(duck, 0.0, 1.0))
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


# ---------- реальные сток-кадры (M15): микс живого видео с графикой ----------

def fetch_stock_clips(tmpdir, queries, max_clips=4, orientation="portrait"):
    """Скачивает сток-клипы с Pexels или Pixabay. Возвращает [mp4,...] или [].

    M16: добавлен Pixabay как альтернатива (бесплатный ключ pixabay.com/docs/api).
    M20: orientation portrait|landscape (longform/YouTube качает landscape).
    Без ключей / при любой ошибке — [] (движок рисует painters, ничего не падает).
    """
    import urllib.request as _rq
    import urllib.parse as _up
    import json as _json
    # M18: Pexels/Pixabay режут дефолтный Python-urllib UA (WAF 403) —
    # ходим с браузерным на поиск И скачивание
    _UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

    def _dl(link, dst):
        req = _rq.Request(link, headers={"User-Agent": _UA})
        with _rq.urlopen(req, timeout=60) as fh, open(dst, "wb") as out:
            out.write(fh.read())
        return os.path.getsize(dst)

    pexels_key = os.environ.get("PEXELS_API_KEY", "").strip()
    pixabay_key = os.environ.get("PIXABAY_API_KEY", "").strip()
    if not pexels_key and not pixabay_key:
        print("[cine] нет ключей стока (PEXELS/PIXABAY) — только рисованные кадры")
        return []
    sdir = os.path.join(tmpdir, "stock")
    os.makedirs(sdir, exist_ok=True)
    clips = []
    # --- Pexels ---
    if pexels_key:
        for qi, q in enumerate(list(queries or [])[:max_clips]):
            try:
                url = ("https://api.pexels.com/videos/search?" + _up.urlencode(
                    {"query": q, "per_page": 3, "orientation": orientation,
                     "size": "medium"}))
                req = _rq.Request(url, headers={"Authorization": pexels_key,
                                                "User-Agent": _UA})
                data = _json.load(_rq.urlopen(req, timeout=20))
                vids = data.get("videos") or []
                if not vids:
                    continue
                files = vids[0].get("video_files") or []
                if not files:
                    continue
                files = sorted(files, key=lambda f: (
                    0 if (f.get("width") or 0) < (f.get("height") or 1) else 1,
                    f.get("width") or 9999))
                link = files[0].get("link")
                if not link:
                    continue
                dst = os.path.join(sdir, f"clip_{qi}.mp4")
                _dl(link, dst)
                if os.path.getsize(dst) > 50000:
                    clips.append(dst)
                    print(f"[cine] pexels {qi}: {q} ({os.path.getsize(dst)//1024} KB)")
            except Exception as e:
                code = getattr(e, "code", "")
                hint = (" — ключ невалиден, проверь PEXELS_API_KEY"
                        if code in (401, 403) else "")
                print(f"[cine] pexels пропущен ({q}): "
                      f"{type(e).__name__} {code}{hint}")
                continue
    # --- Pixabay (fallback если Pexels не дал результатов) ---
    if not clips and pixabay_key:
        for qi, q in enumerate(list(queries or [])[:max_clips]):
            try:
                orient = ("landscape" if orientation == "landscape"
                          else "portrait")
                url = ("https://pixabay.com/api/videos/?" + _up.urlencode({
                    "key": pixabay_key, "q": q, "per_page": 3,
                    "video_type": "film", "orientation": orient,
                    "min_width": 360, "min_height": 360}))
                data = _json.load(_rq.urlopen(
                    _rq.Request(url, headers={"User-Agent": _UA}),
                    timeout=20))
                hits = data.get("hits") or []
                if not hits:
                    continue
                vids = hits[0].get("videos") or {}
                # предпочитаем medium (960px) или small (480px) — вертикаль
                vid = vids.get("medium") or vids.get("small") or vids.get("large")
                link = vid.get("url") if vid else None
                if not link:
                    continue
                dst = os.path.join(sdir, f"clip_px{qi}.mp4")
                _dl(link, dst)
                if os.path.getsize(dst) > 50000:
                    clips.append(dst)
                    print(f"[cine] pixabay {qi}: {q} ({os.path.getsize(dst)//1024} KB)")
            except Exception as e:
                code = getattr(e, "code", "")
                hint = (" — ключ невалиден, проверь PIXABAY_API_KEY"
                        if code in (401, 403) else "")
                print(f"[cine] pixabay пропущен ({q}): "
                      f"{type(e).__name__} {code}{hint}")
                continue
    return clips


def extract_stock_frames(ffmpeg, clips, outdir, each=12):
    """Режет из клипов кадры 540x960 для фона. Возвращает [png,...]."""
    os.makedirs(outdir, exist_ok=True)
    frames = []
    for c in clips:
        for i in range(each):
            out = os.path.join(outdir, f"st{len(frames):03d}.png")
            r = subprocess.run(
                [ffmpeg, "-y", "-ss", str(float(i)), "-i", c,
                 "-frames:v", "1", "-vf", "scale=540:960", out],
                capture_output=True)
            if r.returncode == 0 and os.path.exists(out):
                frames.append(out)
            else:
                break
    print(f"[cine] сток-кадров: {len(frames)}")
    return frames


def paint_stock_bg(frame_path, seed, P, cache):
    """Живой кадр как фон: cover-fit + тёмная грейдинг + виньетка + зерно."""
    if frame_path not in cache:
        bg = Image.open(frame_path).convert("RGB").resize((W, H), Image.BICUBIC)
        bg = bg.point(lambda v: int(v * 0.5))  # гасим под текст/грейд
        cache[frame_path] = bg
    img = cache[frame_path].copy()
    img = _vignette(img, 0.6)
    img = _grain(img, seed % (2 ** 31), 380, 22)
    return img


TRANS_DUR = {"hard_cut": 0.08, "whip": 0.35, "zoom": 0.4, "glitch": 0.3,
             "dip": 0.5, "match": 0.25, "speed_ramp": 0.3}


# ---------- M19: голос ведёт таймлайн ----------

# Интонация диктора по актам: (темп, тон, громкость) для edge-tts.
# hook — энергично, twist — медленно и зловеще, peak — громко и весомо.
# База чуть замедлена (-4%): Dmitry тараторит, речь должна успевать
# за картинку. Сырой SSML edge-tts 7.x экранирует — только параметры.
_PROSODY = {
    "hook": ("+2%", "+8Hz", "+0%"),
    "problem": ("-4%", "+2Hz", "+0%"),
    "escalation": ("-1%", "+4Hz", "+0%"),
    "peak": ("-8%", "+0Hz", "+10%"),
    "twist": ("-12%", "+6Hz", "+0%"),
    "accel": ("+0%", "+5Hz", "+0%"),
    "climax": ("-6%", "+3Hz", "+0%"),
}

# Один визуал — не дольше 3с (динамика TikTok): длинные реплики режутся
# на несколько кадров.
_MAX_VISUAL_SEC = 3.0


def _prosody(act):
    """Интонация акта -> (rate, pitch, volume) для edge-tts."""
    return _PROSODY.get(act or "problem", ("-4%", "+2Hz", "+0%"))


def _split_words(text, n):
    """Делит текст на n частей по границам слов (субтитры подсерий)."""
    words = (text or "").split()
    if n <= 1 or not words:
        return [text or ""]
    base, rem = divmod(len(words), n)
    out, k = [], 0
    for i in range(n):
        cnt = base + (1 if i < rem else 0)
        out.append(" ".join(words[k:k + cnt]))
        k += cnt
    return out


def _layout_voice_spans(shots, vmap, sec_durs):
    """M19: spans озвученных шотов + нарезка длинных реплик на кадры ≤3с.

    Мутирует shots (расширение на месте, первый подкадр — исходный dict).
    Возвращает [{"sec": j, "refs": [shot, ...]}] — refs[0] звучит с sec-файла.
    """
    import math as _m
    vpool = []
    for s in shots:
        if s.get("visual") not in vpool:
            vpool.append(s.get("visual"))
    cpool = []
    for s in shots:
        if s.get("camera") not in cpool:
            cpool.append(s.get("camera"))
    # проход 1: соседние одинаковые визуалы/камеры разводим (до нарезки)
    for i in range(1, len(shots)):
        if (shot_kind(shots[i]) == "cinematic"
                and shots[i].get("visual") == shots[i - 1].get("visual")):
            for cand in vpool:
                if cand != shots[i - 1].get("visual"):
                    shots[i]["visual"] = cand
                    break
        if shots[i].get("camera") == shots[i - 1].get("camera"):
            for cand in cpool:
                if cand != shots[i - 1].get("camera"):
                    shots[i]["camera"] = cand
                    break
    # проход 2: нарезка (с конца, чтобы индексы vmap не плыли)
    spans = []
    order = sorted(range(len(vmap)), key=lambda j: vmap[j][0], reverse=True)
    for j in order:
        idx, s = vmap[j]
        d = sec_durs[j]
        span = max(0.9, float(d) + 0.35)
        if shot_kind(s) == "cinematic":
            n = max(1, int(_m.ceil(span / _MAX_VISUAL_SEC)))
        else:
            n = 1  # текстовые карточки читаются целиком
        sub = span / n
        parts = _split_words(s.get("sub", ""), n)
        refs = [s]
        s["dur"] = max(sub, 0.8)
        if s.get("subs"):
            s["subs"] = [{"lines": [parts[0][:70]], "mode": "sub"}] \
                if parts[0] else []
            s["sub"] = parts[0][:70]
        prev_vis, prev_cam = s.get("visual"), s.get("camera")
        for k in range(1, n):
            vis = next((c for c in vpool if c != prev_vis), prev_vis)
            cam = next((c for c in cpool
                        if c != prev_cam and c != "static"), prev_cam)
            c2 = dict(s)
            c2["dur"] = max(sub, 0.8)
            c2["visual"] = vis
            c2["camera"] = cam
            c2["texts"] = []
            c2["voice"] = ""
            c2["trans_out"] = "hard_cut"
            c2["sfx"] = "none"
            c2["seed"] = s.get("seed", 1) + k
            c2["subs"] = [{"lines": [parts[k][:70]], "mode": "sub"}] \
                if parts[k] else []
            c2["sub"] = parts[k][:70]
            refs.append(c2)
            prev_vis, prev_cam = vis, cam
        shots[idx:idx + 1] = refs
        spans.append({"sec": j, "refs": refs})
    spans.sort(key=lambda sp: sp["sec"])
    # проход 3: границы спанов — соседние одинаковые визуалы разводим
    for i in range(1, len(shots)):
        if (shot_kind(shots[i]) == "cinematic"
                and shots[i].get("visual") == shots[i - 1].get("visual")):
            for cand in vpool:
                if cand != shots[i - 1].get("visual"):
                    shots[i]["visual"] = cand
                    break
    return spans


def _fit_fillers(shots, voiced_ids, seconds, full_voice):
    """Неозвученные кадры добивают остаток хронометража (голос не трогаем)."""
    fills = [s for s in shots if id(s) not in voiced_ids]
    if not fills:
        return
    if full_voice:
        # статья: паузы короткие, без тянучки
        for s in fills:
            s["dur"] = min(max(float(s["dur"]), 0.6), 2.5)
    else:
        vtot = sum(float(s["dur"]) for s in shots if id(s) in voiced_ids)
        budget = max(8.0, float(seconds) - vtot)
        ftot = sum(float(s["dur"]) for s in fills) or 1.0
        k = budget / ftot
        for s in fills:
            s["dur"] = max(0.6, float(s["dur"]) * k)


def _assemble_voice(ffmpeg, tmpdir, items, total, sr=SR):
    """M19: точная сборка голосового трека — чанк j стартует на своём шоте.

    items: [(sec_mp3, start_sec)]. Возвращает wav-путь или None.
    """
    import wave as _wv
    if np is None:
        return None
    n = int(total * sr)
    if n <= 0:
        return None
    track = np.zeros(n, dtype=np.float64)
    ok = False
    for f, start in items:
        w = os.path.join(tmpdir, "mix_" + os.path.basename(f) + ".wav")
        r = subprocess.run(
            [ffmpeg, "-y", "-i", f, "-ar", str(sr), "-ac", "1", w],
            capture_output=True)
        if r.returncode != 0:
            continue
        try:
            with _wv.open(w, "rb") as wf:
                raw = wf.readframes(wf.getnframes())
            a = np.frombuffer(raw, dtype=np.int16).astype(np.float64)
        except Exception:
            continue
        o = max(0, int(start * sr))
        m = min(len(a), n - o)
        if m > 0:
            track[o:o + m] += a[:m]
            ok = True
    if not ok:
        return None
    out = os.path.join(tmpdir, "voice_mix.wav")
    write_wav(out, np.clip(track, -32768, 32767).astype(np.int16))
    return out


def render_frame(shot, p, fonts, P, stock=None):
    """Один кадр тела шота: сцена + камера + типографика.

    stock: {"frames": [png...], "cache": {}} — если шоту назначен живой фон
    (shot["stock"] = индекс), рисуем сток + субтитр вместо painter'а.
    """
    pw = warp_progress(p, shot.get("speed", (1.0, 1.0)))
    si = shot.get("stock")
    if stock and si is not None and 0 <= si < len(stock["frames"]):
        img = paint_stock_bg(stock["frames"][si], shot.get("seed", 1), P,
                             stock["cache"])
    else:
        img = paint_scene(shot["visual"], pw, shot.get("seed", 1), P, fonts,
                          shot.get("accent", "accent"))
    img = apply_camera(img, shot.get("camera", "push_in"), pw,
                       shot.get("seed", 1), int(p * 1000))
    if shot.get("texts"):
        draw_texts(img, shot["texts"], p, fonts, P)
    if shot.get("subs"):
        draw_texts(img, shot["subs"], p, fonts, P)
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


def render_cinematic(shots, seconds, fps, out_silent, bpm, P, tmpdir="out/tmp_cine",
                     stock=None):
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
                proc.stdin.write(render_frame(s, p, fonts, P, stock).tobytes())
                done += 1
        elif sg["kind"] == "trans":
            a, b = sg["a"], sg["b"]
            img_a = render_frame(a, 1.0, fonts, P, stock)
            img_b = render_frame(b, 0.0, fonts, P, stock)
            for j in range(sg["n"]):
                q = (j + 1) / sg["n"]
                proc.stdin.write(
                    transition_frame(img_a, img_b, sg["trans"], q, b.get("seed", 1)).tobytes())
                done += 1
        else:  # hold
            img = render_frame(sg["shot"], 1.0, fonts, P, stock)
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


# ---------- баланс монтажа и QC перед export ----------

def shot_kind(s):
    """cinematic | typography | graphic для шота."""
    t = s.get("type")
    if t in ("cinematic", "typography", "graphic"):
        return t
    if s.get("texts") and s.get("visual") in PURE_TYPO_VISUALS:
        return "typography"
    return "cinematic"


def enforce_balance(shots):
    """Гарантия принципа CINEMATIC->TEXT->CINEMATIC: двух ударных
    текстовых вставок подряд быть не должно (whisper-финал — исключение:
    «КТО КОГО» / пауза / «ЗАЩИЩАЕТ?» задуманы парой)."""
    out = [dict(s) for s in shots]
    prev_typo = False
    for s in out:
        texts = s.get("texts") or []
        is_typo = shot_kind(s) == "typography" and bool(texts)
        modes = {t.get("mode") for t in texts}
        if is_typo and prev_typo and not modes <= {"whisper"}:
            s["texts"] = []
            s["type"] = "cinematic"
            is_typo = False
        prev_typo = bool(is_typo)
    return out


def qc_shots(shots, seconds):
    """Чеклист качества ПЕРЕД рендером (п.15 ТЗ). Возвращает dict проверок,
    печатает отчёт. Текстовый fit — по построению в safe area, но проверяем."""
    from PIL import Image as _I, ImageDraw as _D
    scratch = _D.Draw(_I.new("RGB", (W, H)))
    rep = {}
    # 1-3: тексты в safe area, без обрезки и выхода за 1080x1920
    bad = []
    for s in shots:
        for t in s.get("texts") or []:
            f, fitted, gap = fit_text_block(scratch, t["lines"], t.get("mode", "pop"), None)
            for ln in fitted:
                w_ = (_tracked_width(scratch, ln, f, gap)[0]
                      if t.get("mode") == "tracking" else _ts(scratch, ln, f)[0])
                if w_ > SAFE_W:
                    bad.append((s.get("id"), ln))
    rep["texts_in_safe_area"] = not bad
    rep["no_clipped_words"] = not bad
    rep["no_text_outside_frame"] = not bad
    # 4: нет двух огромных текстовых блоков подряд
    dbl = False
    prev = False
    for s in shots:
        texts = s.get("texts") or []
        cur = shot_kind(s) == "typography" and bool(texts) and not (
            {t.get("mode") for t in texts} <= {"whisper"})
        if cur and prev:
            dbl = True
        prev = cur
    rep["no_double_text_blocks"] = not dbl
    # 5: есть cinematic shots (>=50%)
    kinds = [shot_kind(s) for s in shots]
    rep["has_cinematic_shots"] = (sum(1 for k_ in kinds if k_ == "cinematic")
                                  >= max(1, len(shots) // 2))
    # 6: variation длительностей (M15: минимум поднят ради читаемости,
    # поэтому проверяем разброс, а не наличие субсекундных кадров)
    durs = [round(s["dur"], 2) for s in shots]
    rep["dur_variation"] = (len(set(durs)) >= 5
                            and (max(durs) - min(durs)) >= 1.5)
    # 7: camera movement у каждого cinematic (чёрная пауза — исключение:
    # неподвижный чёрный кадр задуман, движение там невидимо)
    static_cine = [s.get("id") for s in shots
                   if shot_kind(s) == "cinematic" and s.get("camera") == "static"
                   and s.get("visual") != "pause_black"]
    rep["camera_movement"] = not static_cine
    # 8: transitions разнообразны
    rep["transitions"] = len({s.get("trans_out") for s in shots}) >= 3
    # 9: пауза перед кульминацией
    rep["pause_before_climax"] = any(
        s.get("act") == "twist" and (s.get("sfx") == "silence" or not s.get("texts"))
        for s in shots)
    # 10: rapid-часть climax быстрее пика (медленный финал whisper+brand
    # в сравнение не входит — замедление там задумано)
    SLOW_FINALE = {"pause_black", "final_q", "final_brand"}
    pre = [s["dur"] for s in shots if s.get("act") == "peak"]
    cli = [s["dur"] for s in shots if s.get("act") == "climax"
           and s.get("visual") not in SLOW_FINALE]
    rep["climax_faster"] = bool(pre and cli) and (
        sum(cli) / len(cli) < sum(pre) / len(pre))
    # 11: финал визуально отличается от начала
    rep["final_differs"] = shots[-1].get("visual") != shots[0].get("visual")
    # 12: красный только на threat (hook=warning, peak, accel-система;
    # attack_grid в climax — тоже threat-кадр)
    ok_acts = {"hook", "peak", "accel"}
    threat_vis = {"attack_grid", "phone_dark"}
    rep["red_discipline"] = all(
        s.get("accent") != "accent2"
        or s.get("act") in ok_acts or s.get("visual") in threat_vis
        for s in shots)
    # 13 (M15): субтитры тоже в safe area
    bad_sub = []
    for s in shots:
        for t in s.get("subs") or []:
            f, fitted, gap = fit_text_block(scratch, t["lines"], "sub", None)
            for ln in fitted:
                if _ts(scratch, ln, f)[0] > SAFE_W:
                    bad_sub.append((s.get("id"), ln))
    rep["subs_in_safe_area"] = not bad_sub
    # 14 (M15): озвучка покрывает все акты (якорные шоты; непрерывный трек)
    acts_voiced = {s.get("act") for s in shots if (s.get("voice") or "").strip()}
    rep["voice_covers_all"] = {"hook", "problem", "climax"} <= acts_voiced
    # 15 (M15): читаемость — длительность покрывает время чтения текста
    slow = [s.get("id") for s in shots if s["dur"] < _min_dur(s) - 1e-6]
    rep["reading_time_ok"] = not slow
    print("[cine][QC] " + " ".join(
        f"{k}={'OK' if v else 'FAIL'}" for k, v in rep.items()))
    if bad:
        print(f"[cine][QC] вне safe area: {bad[:4]}")
    if static_cine:
        print(f"[cine][QC] cinematic без движения камеры: {static_cine}")
    return rep


# ---------- EDL / SRT (M22: монтажный лист для 9:16 шортсов) ----------

def _dump_edl_cine(path, topic, style, seconds, fps, shots, bounds):
    """EDL JSON: все шоты с таймкодами, визуалом, текстом."""
    edl_shots = []
    for i, s in enumerate(shots):
        e = dict(s)
        e["start"] = round(bounds[i] if i < len(bounds) else 0.0, 3)
        e["end"] = round(bounds[i + 1] if i + 1 < len(bounds) else 0.0, 3)
        e.pop("stock", None)
        e.pop("seed", None)
        edl_shots.append(e)
    edl = {"app": "tgvk-cine", "version": 1, "topic": topic,
           "style": style, "seconds": seconds, "fps": fps,
           "aspect": "9:16", "shots": edl_shots}
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(edl, fh, ensure_ascii=False, indent=1)


def _srt_ts(sec):
    ms = int(sec * 1000)
    return (f"{ms // 3600000:02d}:{(ms // 60000) % 60:02d}:"
            f"{(ms // 1000) % 60:02d},{ms % 1000:03d}")


def _dump_srt_cine(path, shots, bounds):
    """SRT-субтитры: все шоты с текстом."""
    out = []
    n = 0
    for i, s in enumerate(shots):
        text = (s.get("sub") or s.get("voice") or "").strip()
        if not text:
            continue
        st = bounds[i] if i < len(bounds) else 0.0
        en = bounds[i + 1] if i + 1 < len(bounds) else st + 1.0
        n += 1
        out.append(f"{n}\n{_srt_ts(st)} --> {_srt_ts(en)}\n{text}\n")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out))


def generate_cinematic(topic=None, seconds=55, style="cybersecurity_cinematic",
                        out="out/video_cine.mp4", fps=FPS_CINE,
                        voice=vg.VOICE_DEFAULT, no_audio=False, voice_over=None,
                        tmpdir="out/tmp_cine", script_shots=None, provider=None,
                        script_text=None, edl_out=None, srt_out=None):
    """Главная точка входа: тема -> cinematic-ролик MP4.

    script_text (M17): текст статьи -> план script_to_shots (диктор читает
    статью, субтитры синхронны, длина = длина озвучки). Без статьи —
    как раньше: LLM-план по теме, иначе generic-шаблон.
    """
    import shutil as _sh
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    os.makedirs(tmpdir, exist_ok=True)
    st, key = get_style(style)
    P = st["palette"]
    bpm = st.get("bpm", 100)
    topic = (topic or "Как вас взламывают через фишинг").strip()
    full_voice = False
    if script_text and str(script_text).strip():
        shots, seconds = script_to_shots(str(script_text), topic,
                                         seconds, key)
        full_voice = True
    else:
        shots = (list(script_shots) if script_shots
                 else plan_shots(topic, seconds, key, True, provider))
    # монтажная гигиена: баланс cinematic/text
    shots = enforce_balance(shots)
    if voice_over is None:
        voice_over = bool(st.get("voice_over"))
    ffmpeg = vg.find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("нет ffmpeg: pip install imageio-ffmpeg")
    # --- M19: голос ведёт таймлайн. Реплики озвучиваются SSML (интонация
    # по актам, паузы между фразами), шоты встают под РЕАЛЬНУЮ длину голоса,
    # длинные реплики режутся на кадры ≤3с. Глобального ресайза больше нет —
    # именно он разъединял голос и картинку (монолит с t=0 поверх тянутых
    # шотов: диктор заканчивал раньше, хвост шёл в тишине).
    vmp3 = None
    voice_spans = []
    if voice_over and not no_audio:
        # якорные шоты (каждый 3-й + hook/twist/бренд) или ВСЕ в статье
        if full_voice:
            vmap = [(i, s) for i, s in enumerate(shots)
                    if (s.get("voice") or "").strip()]
        else:
            vmap = [(i, s) for i, s in enumerate(shots)
                    if ((s.get("voice") or "").strip()
                        and (i % 3 == 0 or s.get("act") in ("hook", "twist")
                             or s.get("visual") == "final_brand"))]
        if vmap:
            tsecs = []
            for _, s in vmap:
                rate, pitch, vol = _prosody(s.get("act"))
                tsecs.append({"voice": s["voice"], "caption": s["id"],
                              "rate": rate, "pitch": pitch, "volume": vol})
            _w = None
            try:
                vmp3, _w = vg.make_voiceover_sections(ffmpeg, tsecs, voice,
                                                      tmpdir)
            except Exception as e:
                print(f"[cine] TTS не удался ({type(e).__name__}) "
                      f"— оценка по символам")
                vmp3, _w = None, None
            if _w and len(_w) == len(vmap):
                # w = голос + вшитая пауза 0.5 (у последнего чанка паузы нет)
                sec_durs = [float(w) - (0.5 if j < len(vmap) - 1 else 0.0)
                            for j, w in enumerate(_w)]
            else:
                sec_durs = [max(1.5, len(s["voice"]) / 14.0)
                            for _, s in vmap]
                vmp3 = None
            voice_spans = _layout_voice_spans(shots, vmap, sec_durs)
            voiced_ids = {id(s) for sp in voice_spans for s in sp["refs"]}
            _fit_fillers(shots, voiced_ids, seconds, full_voice)
            seconds = sum(float(s["dur"]) for s in shots)
    # минимум читаемости — только вверх (синхрон голоса не ломаем)
    for s in shots:
        if (s.get("texts") or s.get("subs")) and s["dur"] < _min_dur(s):
            s["dur"] = float(_min_dur(s))
    # QC-чеклист — по финальным длительностям, до рендера
    rep = qc_shots(shots, seconds)
    # --- живые сток-фоны (M15): микс реального видео с графикой.
    # Без PEXELS_API_KEY / при ошибке — только painters, ничего не падает.
    stock = None
    try:
        queries = st.get("stock_queries") or ()
        clips = fetch_stock_clips(tmpdir, queries) if queries else []
        if clips:
            frames = extract_stock_frames(
                ffmpeg, clips, os.path.join(tmpdir, "stock_frames"))
            if frames:
                stock = {"frames": frames, "cache": {}}
                ci = 0
                for idx, s in enumerate(shots):
                    if (shot_kind(s) == "cinematic" and not s.get("texts")
                            and idx % 3 == 1):
                        s["stock"] = ci % len(frames)
                        ci += 1
                print(f"[cine] живые фоны назначены {ci} шотам")
    except Exception as e:
        print(f"[cine] сток недоступен ({type(e).__name__}) — только painters")
        stock = None
    # окно паузы (twist) — для просадки бита
    pause_win = None
    acc = 0.0
    for s in shots:
        if s["act"] == "twist" and pause_win is None:
            pause_win = (acc, acc + s["dur"])
        acc += s["dur"]
    silent = os.path.join(tmpdir, "silent.mp4")
    _, bounds = render_cinematic(shots, seconds, fps, silent, bpm, P, tmpdir,
                                 stock)
    real_dur = bounds[-1]
    # M19: голос собирается точно на шоты — чанк j стартует на своём кадре
    # (bounds = концы шотов после beat-снапа, bounds[i] = старт шота i)
    if vmp3 and voice_spans and np is not None and not no_audio:
        try:
            idx_of = {id(s): i for i, s in enumerate(shots)}
            items = []
            for sp in voice_spans:
                i0 = idx_of.get(id(sp["refs"][0]))
                if i0 is None or i0 >= len(bounds):
                    continue
                items.append((os.path.join(tmpdir, f"sec_{sp['sec']}.mp3"),
                              float(bounds[i0])))
            total_v = sum(float(s["dur"]) for s in shots)
            vmix = _assemble_voice(ffmpeg, tmpdir, items, total_v, SR)
            if vmix:
                vmp3 = vmix
                print(f"[cine] голос собран на таймлайн: {len(items)} чанков")
        except Exception as e:
            print(f"[cine] сборка голоса не удалась ({type(e).__name__}) "
                  f"— монолит с начала")
    if no_audio or np is None:
        if np is None:
            print("[cine] numpy нет — видео без звука")
        _sh.copy(silent, out)
    else:
        # голос -> wav + огибающая для дакинга бита под речью
        duck = None
        vw = None
        vv = None
        if vmp3:
            vw = os.path.join(tmpdir, "voice.wav")
            r = subprocess.run(
                [ffmpeg, "-y", "-i", vmp3, "-ar", str(SR), "-ac", "1", vw],
                capture_output=True)
            if r.returncode == 0:
                with wave.open(vw, "rb") as wf:
                    raw = wf.readframes(wf.getnframes())
                vv = np.frombuffer(raw, dtype=np.int16).astype(np.float64) * 1.1
                # RMS-огибающая окном 0.2с -> 0..1
                n = int(real_dur * SR)
                a = np.abs(vv[:n])
                wsize = max(1, int(SR * 0.2))
                cs = np.cumsum(np.insert(a, 0, 0.0))
                env = (cs[wsize:] - cs[:-wsize]) / wsize
                env = np.concatenate([env, np.full(max(0, n - len(env)), 0.0)])[:n]
                mx = env.max()
                duck = (env / mx) if mx > 0 else np.zeros(n)
        mix = build_soundtrack(shots, bounds, real_dur, bpm, pause_win,
                               bed=float(st.get("bed_level", 1.0)),
                               sfx_gain=float(st.get("sfx_level", 1.0)),
                               duck=duck)
        bed_wav = os.path.join(tmpdir, "bed.wav")
        write_wav(bed_wav, mix)
        if vw is not None and vv is not None:
            # голос поверх приглушённого бита
            m = min(len(vv), len(mix))
            mix2 = mix.astype(np.float64)
            mix2[:m] += vv[:m]
            mix2 = np.clip(mix2, -32768, 32767).astype(np.int16)
            write_wav(bed_wav, mix2)
        vg.mux_audio(ffmpeg, silent, bed_wav, out, real_dur)
    size = os.path.getsize(out)
    print(f"[cine] ГОТОВО: {out} ({size / 1048576:.1f} MB, {real_dur:.1f} c, стиль {key})")
    # --- EDL/SRT экспорт (M22: монтажный лист + субтитры для 9:16) ---
    if edl_out:
        try:
            _dump_edl_cine(edl_out, topic, key, seconds, fps, shots, bounds)
            print(f"[cine] EDL: {edl_out}")
        except Exception as e:
            print(f"[cine] EDL не удался ({type(e).__name__})")
    if srt_out:
        try:
            _dump_srt_cine(srt_out, shots, bounds)
            print(f"[cine] SRT: {srt_out}")
        except Exception as e:
            print(f"[cine] SRT не удался ({type(e).__name__})")
    return out


def generate_video(topic, duration=55, style="cybersecurity_cinematic", **kw):
    """Алиас в духе generateVideo({topic, duration, style})."""
    return generate_cinematic(topic=topic, seconds=duration, style=style, **kw)
