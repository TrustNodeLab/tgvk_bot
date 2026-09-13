# -*- coding: utf-8 -*-
"""VidRush-аналог (M20): длинные YouTube-ролики 16:9, 6-40 минут.

Пайплайн: ТЕМА -> СЦЕНАРИЙ (LLM/шаблон) -> SHOT LIST -> TTS (голос ведёт
таймлайн, M19) -> СТOKИ 16:9 -> RENDER 1920x1080 -> AUDIO MIX -> MP4 + EDL/SRT.

Форматы: doc (документалка), breakdown (разбор), top10 (топ).
Правки как в монтажке: рядом с MP4 кладётся EDL (JSON со всеми шотами:
старт/конец/реплика/субтитр/визуал) и SRT-субтитры. Поправил текст или
порядок в EDL -> `python bot/video_long.py --edl-in out/video.edl.json`
-> пересборка с новой озвучкой и монтажом.

Переиспользует движок video_cine (художники, камеры, переходы, звук,
голосовой таймлайн M19) — дублирует только оркестрацию длинного формата.
Шортсы (9:16) не тронуты.
"""

import argparse
import json
import math
import os
import random
import re
import subprocess
import sys
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import video_gen as vg  # noqa: E402 (ffmpeg/mux/tts-утилиты)
import video_cine as cine  # noqa: E402 (движок, M19-хелперы)

try:
    import llm  # noqa: E402 (сценарии)
except Exception:
    llm = None

FPS_LONG = 60              # 60 fps: плавный монтаж (эталон TikTok HEVC 60fps; --fps 120 опция)
CHARS_PER_SEC = 13.0  # русская речь Дмитрия, замер M19
CHUNK_MAX = 140
SUB_MAX = 70

FORMATS = ("doc", "breakdown", "top10")

# --- RU → EN stock query translation (для Pexels API) ---
_RU_EN_STOCK = {
    "ダーкнет": "darknet", "даркнет": "darknet", "тёмный": "dark",
    "кибербезопасн": "cybersecurity", "безопасн": "security",
    "крипто": "bitcoin cryptocurrency", "bitcoin": "bitcoin cryptocurrency",
    "биткоин": "bitcoin", "монета": "bitcoin coin close up",
    "взлом": "hacker typing dark", "атака": "cyber attack concept",
    "хакер": "hacker typing dark", "проникновен": "data breach concept",
    "федерал": "federal agents raid", "расследован": "detective investigation",
    "полиц": "police operation", "арест": "police arrest suspect",
    " задержан": "police arrest", "подозрева": "suspect interrogation",
    "офис": "modern office interior", "здание": "building exterior aerial",
    "город": "city skyline", "улица": "street view dashcam",
    "деньги": "money counting machine", "доллар": "us dollar bills close",
    "банкнот": "printing money press", "банк": "bank building night",
    "компьютер": "computer screen dark", "монитор": "monitor screen data",
    "клавиатур": "keyboard typing close", "экран": "screen glowing dark",
    "телефон": "smartphone notification", "смартфон": "smartphone dark",
    "приложен": "mobile app screen", "соцсет": "social media phone",
    "данные": "data stream abstract", "информац": "binary code screen",
    "сервер": "server room racks", "дата-центр": "data center corridor",
    "сетев": "network cables close", "провайд": "internet cable close",
    "вирус": "malware virus concept", "троян": "trojan horse concept",
    "фишинг": "phishing email fake", "мошеннич": "fraud concept abstract",
    "скам": "scam concept dark", "обман": "deception concept",
    "связь": "communication tower", "интернет": "internet cable close",
    "веб": "website screen dark", "сайт": "web browser screen",
    "поиск": "search engine screen", "торговл": "stock trading screen",
    "рынок": "stock market chart", "акци": "stock market screen",
    "технолог": "technology abstract", "инновац": "innovation concept",
    "платформ": "digital platform abstract", "систем": "system abstract",
    "программ": "code screen dark", "код": "programming code screen",
    "разработк": "developer workspace", "команд": "team collaboration office",
    "оператив": "military operation", "спецоперац": "special operation raid",
    "война": "military drone footage", "оружи": "weapon close up",
    "контрол": "security control room", "наблюд": "surveillance camera",
    "камера": "cctv camera close", "мониторинг": "monitoring room screens",
    "угроз": "threat warning screen", "риск": "risk concept abstract",
    "уязвим": "vulnerability concept", "защит": "firewall concept abstract",
    "шифр": "encryption lock concept", "пароль": "password typing keyboard",
    "аутентификац": "biometric scan close", "доступ": "access control gate",
    "перехват": "wiretap concept", "шпион": "spy camera lens",
    "река": "river aerial view", "тропик": "tropical river drone",
    "мост": "bridge aerial view", "деревн": "village aerial view",
    "завод": "factory industrial", "производств": "manufacturing line",
    "склад": "warehouse interior", "лаборатори": "laboratory research",
    "медицин": "medical technology", "лечени": "hospital interior",
    "здоровь": "health technology", "искусственн": "artificial intelligence",
    "нейросет": "neural network abstract", "алгоритм": "algorithm abstract",
    "автоматизац": "automation robot", "робот": "robot arm industrial",
    "механизм": "gear mechanism close", "двигатель": "engine close up",
    "транспорт": "traffic night city", "автомобил": "car traffic night",
    "самолёт": "airplane takeoff", "корабл": "cargo ship aerial",
}


def _ru_to_en_query(text, topic=""):
    """Переводит русский запрос в английский для Pexels."""
    if not text:
        return topic or "technology abstract"
    low = text.lower().strip()
    # Если уже на английском — вернуть как есть
    if all(ord(c) < 128 or c in ".,!? -" for c in low):
        return low[:60]
    # Ищем совпадения в словаре
    for ru_kw, en_q in _RU_EN_STOCK.items():
        if ru_kw in low:
            return en_q
    # Fallback: generic запросы по теме
    generic = [
        "technology abstract", "digital concept dark", "data visualization",
        "cyber security concept", "modern office night", "city skyline night",
        "computer screen dark", "server room dark", "network abstract",
    ]
    return random.choice(generic)


# ---------- сценарий ----------

def _target_chars(minutes):
    return int(minutes * 60 * CHARS_PER_SEC)


def _blueprint(topic, minutes, format):
    """Скелет секций формата: [(роль, доля_хронометража)]."""
    if format == "top10":
        n = max(3, min(10, int(round(minutes))))
        shares = [0.06] + [0.84 / n] * n + [0.10]
        roles = (["hook"] + ["item"] * n + ["outro"])
        return list(zip(roles, shares))
    if format == "breakdown":
        n = max(2, min(6, int(round(minutes / 1.2))))
        shares = [0.05, 0.10] + [(0.75 / n)] * n + [0.10]
        roles = ["hook", "thesis"] + ["argument"] * n + ["verdict"]
        return list(zip(roles, shares))
    # doc
    n = max(2, min(12, int(round(minutes))))
    shares = [0.08] + [(0.80 / n)] * n + [0.12]
    roles = ["hook"] + ["chapter"] * n + ["finale"]
    return list(zip(roles, shares))


def _fallback_script(topic, minutes, format):
    """Шаблон без LLM (честная заглушка: структура формата, текст generic)."""
    total = _target_chars(minutes)
    out = []
    for i, (role, share) in enumerate(_blueprint(topic, minutes, format)):
        budget = max(200, int(total * share))
        if role == "hook":
            head = f"{topic}: с чего всё началось"
            body = (f"Сегодня разберём тему «{topic}» по косточкам. "
                    f"Это {format}-разбор: факты, контекст и выводы. "
                    f"Досмотрите до конца — главное в финале. " * 12)
        elif role in ("outro", "finale", "verdict"):
            head = f"{topic}: итог"
            body = (f"Подводим итог по теме «{topic}». Главное, что стоит "
                    f"запомнить: контекст решает, детали важны, выводы за вами. "
                    f"Подписывайтесь, дальше — больше. " * 12)
        elif role == "thesis":
            head = f"{topic}: главный тезис"
            body = (f"Главный тезис выпуска про «{topic}»: всё не так однозначно, "
                    f"как кажется на первый взгляд. Разберём по пунктам. " * 12)
        elif role in ("item", "argument", "chapter"):
            head = f"{topic}: часть {i}"
            body = (f"Разбираем «{topic}», пункт {i}. Факты, примеры из практики "
                    f"и что это значит на деле. Запоминайте детали — они "
                    f"пригодятся в финале. " * 12)
        else:
            head, body = f"{topic}", f"Про «{topic}». " * 20
        # Гарантируем EN-запрос для Pexels
        query_en = _ru_to_en_query(f"{topic} {head}", topic)
        out.append({"heading": head[:80], "body": body[:budget + 400],
                    "query": query_en, "role": role, "method": "template"})
    return out


def _stock_query_from_body(body, topic=""):
    """Генерирует УНИКАЛЬНЫЙ EN stock query из текста body.

    S38c: Для YouTube-документалки используем ДРАМАТИЧНЫЕ реальные клипы
    (drone footage, police raids, money, news), а НЕ screen-based (login, url bar).
    """
    if not body:
        return _ru_to_en_query(topic, topic)
    low = body.lower()

    # --- DOC-специфичные запросы (для YouTube-документалки) ---
    _DOC_KW = {
        # Драматика / криминал
        "арест": ["police arrest suspect night", "handcuffs close up"],
        "полиц": ["police operation raid", "police car lights night"],
        "расследован": ["detective investigation board", "detective desk files"],
        "федерал": ["federal agents operation", "government building exterior"],
        "суд": ["courtroom trial", "judge gavel close up"],
        "приговор": ["prison bars close up", "jail cell door"],
        "штраф": ["money penalty fine", "court documents"],
        "задержан": ["police arrest suspect", "suspect handcuffed"],
        "подозрева": ["interrogation room", "suspect shadow"],
        "преступлен": ["crime scene tape", "evidence markers"],
        "жертва": ["victim silhouette dark", "crime scene evidence"],
        # Деньги / финансы
        "миллиард": ["money counting machine", "stacks hundred dollar bills"],
        "миллион": ["cash counting machine", "money bundles"],
        "доллар": ["us dollar bills close", "hundred dollar bill macro"],
        "деньги": ["money counting machine", "cash register close up"],
        "банк": ["bank building exterior", "bank vault door"],
        "bitcoin": ["bitcoin coin physical", "cryptocurrency mining rig"],
        "крипт": ["bitcoin coin close up", "cryptocurrency trading chart"],
        "валют": ["currency exchange board", "money counting machine"],
        "счет": ["bank statement document", "financial chart screen"],
        # Технологии / кибер
        "взлом": ["hacker typing dark room", "computer screen code dark"],
        "хакер": ["hacker hands keyboard dark", "hacker silhouette screen"],
        "атак": ["cyber attack concept", "server room dark"],
        "вирус": ["malware virus concept", "computer virus alert"],
        "данные": ["data stream abstract", "binary code scrolling"],
        "сервер": ["server room racks", "data center corridor"],
        "интернет": ["internet cable close up", "fiber optic cable"],
        "телефон": ["smartphone notification dark", "phone call screen"],
        "экран": ["computer screen dark code", "monitor glowing dark"],
        "код": ["programming code screen", "terminal code scrolling"],
        "систем": ["system abstract digital", "network visualization"],
        "сеть": ["network cables server", "router lights blinking"],
        "защит": ["firewall concept", "security lock digital"],
        "безопасн": ["security camera close", "security control room"],
        # География / локации
        "город": ["city skyline aerial", "city night lights drone"],
        "здание": ["building exterior aerial", "office building night"],
        "улица": ["street view dashcam", "city street traffic"],
        "стран": ["country landscape aerial", "map world highlighted"],
        "границ": ["border crossing checkpoint", "passport control"],
        "аэропорт": ["airport terminal", "airplane takeoff runway"],
        "порта": ["cargo ship port aerial", "container port drone"],
        "завод": ["factory industrial aerial", "smokestack industrial"],
        # Люди / общество
        "жител": ["city people walking", "crowd street"],
        "президент": ["government podium speech", "press conference"],
        "директор": ["businessman office", "corporate meeting"],
        "компани": ["corporate office interior", "business meeting"],
        "команд": ["team collaboration office", "teamwork desk"],
        "ناس": ["crowd people city", "people walking street"],
        "жертв": ["sad person window", "lonely person city"],
        # Новости / медиа
        "новост": ["news broadcast studio", "newspaper headline close"],
        "журналист": ["press camera journalist", "microphone interview"],
        "стат": ["newspaper article close", "news article printed"],
        "публикац": ["magazine article printed", "news headline paper"],
        "пресс": ["press conference podium", "camera crew filming"],
        # Время / динамика
        "результат": ["success concept abstract", "victory celebration"],
        "ошибк": ["error warning screen", "red alert warning"],
        "проблем": ["problem concept abstract", "challenge obstacle"],
        "опасн": ["danger warning sign", "hazard tape"],
        "риск": ["risk concept", "warning triangle"],
        "угроз": ["threat warning", "danger alert"],
        "последств": ["consequence concept", "aftermath destruction"],
    }

    # Ищем совпадения в DOC-словаре
    for kw, queries in _DOC_KW.items():
        if kw in low:
            return random.choice(queries)

    # Fallback: generic documentary queries
    doc_fallbacks = [
        "city skyline aerial drone", "police operation night",
        "money counting machine", "server room dark",
        "hacker typing dark room", "federal building exterior",
        "courtroom trial", "prison bars close up",
        "newspaper headline close", "smartphone notification dark",
        "traffic city night", "construction site aerial",
        "data center corridor", "security camera close up",
        "bank building night", "bitcoin coin physical",
        "airplane takeoff runway", "cargo ship port aerial",
        "factory industrial aerial", "crowd people city street",
    ]
    return random.choice(doc_fallbacks)


def write_script(topic, minutes, format, provider=None):
    """Сценарий секциями [{heading, body, query, role}] — по секции через LLM.

    Каждая секция генерируется ОТДЕЛЬНЫМ LLM-вызовом с minimum chars.
    Это решает проблему GigaChat, который при одном вызове даёт мало текста.
    """
    total = _target_chars(minutes)
    plan = _blueprint(topic, minutes, format)
    per_section_min = max(300, int(total / len(plan) * 0.6))
    secs = []

    if llm is not None:
        for i, (role, share) in enumerate(plan):
            budget = max(300, int(total * share))
            role_name = {"hook": "заставка/вступление",
                         "chapter": "основная часть",
                         "argument": "аргумент",
                         "item": "элемент топа",
                         "thesis": "тезис",
                         "verdict": "вердикт",
                         "finale": "финал/выводы",
                         "outro": "завершение"}.get(role, role)
            prompt = (
                f"Ты — сценарист YouTube-канала о кибербезопасности и технологиях. "
                f"Напиши ЧАСТЬ {i+1} из {len(plan)} ({role_name}) сценария "
                f"на тему «{topic}» (формат {format}).\n"
                f"Это {role_name} ролика на {minutes} минут.\n"
                f"Требуется МИНИМУМ {per_section_min} символов дикторского текста "
                f"(цель ~{budget} символов).\n"
                f"Правила:\n"
                f"- body — живой дикторский текст: факты, детали, примеры, цифры, "
                f"имена, даты. Без воды и приветствий.\n"
                f"- heading — короткое название (до 6 слов)\n"
                f"- query — 2-3 слова на АНГЛИЙСКОМ для поиска сток-видео "
                f"(УНИКАЛЬНЫЕ для этой секции, НЕ повторяй query из предыдущих частей)\n"
                f"Уже написаны секции:\n"
                + "\n".join(f"  {j+1}. [{prev['role']}] query: {prev['query']}"
                            for j, prev in enumerate(secs) if prev.get("query"))
                + f"\n\nВерни ТОЛЬКО валидный JSON: "
                f'{{"heading":"...","body":"...","query":"..."}}')
            for attempt in range(2):
                try:
                    raw = llm._complete([{"role": "user", "content": prompt}],
                                        provider)
                    # Парсим JSON — может быть в markdown code block
                    cleaned = re.sub(r"```json\s*|\s*```", "", raw.strip())
                    m = re.search(r"\{.*\}", cleaned, re.S)
                    data = json.loads(m.group(0) if m else cleaned)
                    body = str(data.get("body") or "")[:8000]
                    heading = str(data.get("heading") or f"{topic}: часть {i}")[:80]
                    query_raw = str(data.get("query") or "")[:60]
                    # Гарантируем EN-запрос для Pexels + уникальность
                    query_en = _ru_to_en_query(query_raw, topic)
                    # Проверяем длину
                    if len(body) >= per_section_min:
                        break
                    print(f"[long] секция {i+1}: мало текста "
                          f"({len(body)} < {per_section_min}), повтор...")
                except Exception as e:
                    print(f"[long] секция {i+1}: ошибка LLM "
                          f"({type(e).__name__}), попытка {attempt+1}/2")
                    continue
            else:
                # LLM не справился — используем шаблон для этой секции
                fb = _fallback_script(topic, minutes, format)
                if i < len(fb):
                    body = fb[i].get("body", "")
                    heading = fb[i].get("heading", heading)
                    query_en = fb[i].get("query", query_en)
                    print(f"[long] секция {i+1}: fallback на шаблон")
                else:
                    body = f"Разбираем тему «{topic}», часть {i+1}. " * 20
                    print(f"[long] секция {i+1}: generic fallback")

            secs.append({
                "heading": heading,
                "body": body,
                "query": query_en,
                "role": role,
                "method": "llm" if body and "template" not in str(body) else "template"})

        total_chars = sum(len(s['body']) for s in secs)
        print(f"[long] сценарий LLM: {len(secs)} секций "
              f"({total_chars} симв, цель {total})")
        if total_chars >= total * 0.3:
            return secs
        print(f"[long] LLM дал {total_chars} символов — дополняем fallback")
        # Дополняем короткие секции шаблонным текстом
        fb = _fallback_script(topic, minutes, format)
        for j, s in enumerate(secs):
            if len(s["body"]) < per_section_min and j < len(fb):
                s["body"] = s["body"] + " " + fb[j].get("body", "")
                s["method"] = "llm+template"
        return secs

    return _fallback_script(topic, minutes, format)


# ---------- секции -> чанки -> шоты ----------

def _sentences(body):
    return [p.strip() for p in
            re.split(r"(?<=[.!?…;:])\s+", (body or "").strip()) if p.strip()]


def _hard_split(sent, limit=CHUNK_MAX):
    if len(sent) <= limit:
        return [sent]
    out, cur = [], ""
    for w in sent.split():
        t = (cur + " " + w).strip()
        if len(t) <= limit:
            cur = t
        else:
            if cur:
                out.append(cur)
            cur = w
    if cur:
        out.append(cur)
    return out or [sent[:limit]]


def _smart_sub(chunk, limit=SUB_MAX):
    if len(chunk) <= limit:
        return chunk
    cut = chunk[:limit].rsplit(" ", 1)
    return cut[0] if len(cut) == 2 and len(cut[0]) >= limit // 2 else chunk[:limit]


_ROLE_ACT = {"hook": "hook", "thesis": "problem", "chapter": "problem",
             "argument": "escalation", "item": "escalation",
             "verdict": "peak", "finale": "climax", "outro": "climax"}

_VISUALS = ["phone_message", "login_screen", "keyboard", "qr_scan",
            "token_panel", "server_corridor", "cables", "person",
            "phone_call", "face_glow", "eye", "server_rack",
            "switch_macro", "consequence", "bokeh", "message",
            "bitcoin_closeup", "city_skyline", "police_raid",
            "data_center", "hacker_screen", "money_counting",
            "drone_aerial", "news_article", "federal_building",
            "courtroom", "evidence_table", "interrogation_room",
            "military_convoy", "tropical_river", "port_cargo",
            "printing_press", "atm_machine", "security_fence",
            "lock_mechanism", "code_screen", "cloud_server",
            "firewall", "wiretap_device", "gps_tracker",
            "satellite_dish", "underground_tunnel", "wire_room",
            "control_panel", "emergency_light", "broken_glass",
            "dark_corridor", "flashlight_beam", "badge_closeup",
            "map_pinpoint", "car_chase", "night_vision"]
_PEAK_POOL = ["attack_grid", "face_glow", "server_corridor", "eye",
              "consequence", "police_raid", "federal_building",
              "money_counting", "hacker_screen", "drone_aerial"]
_CAMERAS = ["push_in", "drift", "push_out", "tilt", "whip_pan", "snap"]
_TRANS = ["hard_cut", "whip", "zoom", "match", "hard_cut", "dip"]


def _mkshot(sid, act, dur, visual, camera, texts, trans_out, sfx="none",
            speed=(1.0, 1.0), accent="accent", fx="", typ=None,
            voice="", sub="", sec=0):
    if typ is None:
        typ = "cinematic"
    # S38c: YouTube 16:9 — НЕТ субтитров. Субтитры только для TikTok 9:16.
    # Визуальные шоты должны рассказывать историю сами (как у Мамая).
    subs = []
    return {"id": sid, "sec": sec, "act": act, "dur": dur, "visual": visual,
            "camera": camera, "texts": texts, "subs": subs,
            "sub": "", "voice": voice[:CHUNK_MAX],
            "trans_out": trans_out, "sfx": sfx, "speed": speed,
            "accent": accent, "fx": fx, "type": typ}


def _tx(*lines, mode="pop"):
    return [{"lines": [str(l).upper().strip()[:24] for l in lines],
             "mode": mode}]


def build_long_shots(sections, topic, seed=7, target_sec=None):
    """Секции -> shot list без лимита длины (longform).

    target_sec: поджать середину под целевой хронометраж (оценка 14 симв/с
    + 0.6с на чанк) — жертвуем средними чанками, hook/финал не трогаем.
    """
    rnd = random.Random(seed + abs(hash(topic)) % 10 ** 6)
    peak_pool = list(_PEAK_POOL)
    rnd.shuffle(peak_pool)
    off = abs(hash(topic)) % 997
    shots, vi = [], off % len(_VISUALS)
    for si, sec in enumerate(sections):
        role = sec.get("role", "chapter")
        chunks = []
        for sent in _sentences(sec.get("body", "")):
            chunks.extend(_hard_split(sent))
        if not chunks:
            continue
        for k, chunk in enumerate(chunks):
            act = _ROLE_ACT.get(role, "problem")
            if k == len(chunks) - 1 and role in ("verdict", "finale"):
                act = "peak"
            if act == "peak":
                vis, accent = peak_pool[(k + off) % len(peak_pool)], "accent2"
            else:
                vis, accent = _VISUALS[vi % len(_VISUALS)], "accent"
                vi += 1
            sfx = ("impact" if act == "peak"
                   else ("bass" if act == "hook" else "none"))
            dur = max(1.0, len(chunk) / 12.0 + 0.6)
            shots.append(_mkshot(
                f"L{si:02d}_{k:02d}", act, dur, vis,
                _CAMERAS[(len(shots) + off) % len(_CAMERAS)], [],
                _TRANS[(len(shots) * 3 + off) % len(_TRANS)], sfx,
                (1.2, 1.2), accent, "", None, chunk, _smart_sub(chunk),
                sec=si))
            for fld in ("seed",):
                shots[-1][fld] = rnd.randint(1, 10 ** 6)
        # глава-докард между секциями (документальный ритм)
        head = (sec.get("heading") or "").upper().strip().split()
        if head and si < len(sections) - 1:
            words = [w.strip("«»\"'.,!?—–-") for w in head if w][:3]
            lines = []
            cur = ""
            for w in words:
                t = (cur + " " + w).strip()
                if len(t) <= 24:
                    cur = t
                else:
                    break
            if cur:
                lines.append(cur)
            if lines:
                shots.append(_mkshot(
                    f"L{si:02d}_t", "accel", 1.6,
                    "flash" if si % 2 else "question", "snap",
                    _tx(*lines[:2]), "hard_cut", "click", (1.4, 1.4),
                    "accent", "", "typography", sec=si))
                shots[-1]["seed"] = rnd.randint(1, 10 ** 6)
        # пауза посередине ролика
        if si + 1 == max(1, len(sections) // 2) and len(sections) > 1:
            shots.append(_mkshot(
                f"L{si:02d}_p", "twist", 1.8, "pause_black", "static",
                [], "dip", "silence", (0.4, 0.4), "accent", "",
                "cinematic", sec=si))
            shots[-1]["seed"] = rnd.randint(1, 10 ** 6)
    if target_sec:
        def _est():
            return sum(len(s["voice"]) / 14.0 + 0.6 for s in shots
                       if s["voice"])
        for _ in range(512):
            if _est() <= target_sec or len(shots) <= 6:
                break
            mid = [s for s in shots
                   if s["voice"] and not s["id"].startswith("L00")
                   and not s["id"].startswith("L_fin")]
            if not mid:
                break
            victim = max(mid, key=lambda s: len(s["voice"]))
            shots.remove(victim)
    # финал: шёпот + бренд
    last_head = (sections[-1].get("heading") if sections else topic) or topic
    shots.append(_mkshot("L_fin_q", "climax", 2.4, "final_q", "static",
                         _tx(last_head, mode="whisper"), "dip", "bass",
                         (0.6, 0.8), "accent", "", "typography"))
    shots[-1]["seed"] = rnd.randint(1, 10 ** 6)
    shots.append(_mkshot("L_fin_b", "climax", 3.6, "final_brand", "push_out",
                         [], "hard_cut", "impact", (0.7, 1.0), "accent",
                         "", "graphic"))
    shots[-1]["seed"] = rnd.randint(1, 10 ** 6)
    print(f"[long] shot list: {len(shots)} шотов, "
          f"голоса ~{sum(len(s['voice']) / 12.0 for s in shots if s['voice']):.0f}с")
    return shots


# ---------- стоки 16:9 по секциям ----------

def fetch_section_stock(ffmpeg, tmpdir, sections, max_sec=15):
    """По 2-3 landscape-клипам на секцию -> общие кадры. Возвращает [png...].

    Query генерируется ИЗ BODY текста (content-level matching) для максимального
    разнообразия — каждая секция получает УНИКАЛЬНЫЙ stock-запрос.
    """
    frames_all = []
    used_queries = set()  # избегаем повторов
    for si, sec in enumerate(sections[:max_sec]):
        # Генерируем query из body (content-level) + fallback на sec["query"]
        body = (sec.get("body") or "")
        q = _stock_query_from_body(body, sec.get("heading", ""))
        # Если уже использовали — пробуем другой из body
        if q in used_queries:
            # Ищем второе совпадение в body
            q2 = _stock_query_from_body(body[100:], sec.get("heading", ""))
            if q2 != q:
                q = q2
            else:
                # Fallback на generic с вариацией
                fallbacks = ["technology abstract", "digital concept dark",
                             "data visualization", "cyber security concept",
                             "modern office night", "city skyline night",
                             "computer screen dark", "server room dark",
                             "network abstract", "hacker typing dark",
                             "police operation", "money counting machine"]
                q = random.choice([f for f in fallbacks if f not in used_queries]
                                  or fallbacks)
        used_queries.add(q)
        if not q:
            continue
        sdir = os.path.join(tmpdir, f"stock_s{si}")
        try:
            clips, _ = cine.fetch_stock_clips(sdir, [q], max_clips=3,
                                              orientation="landscape")
            if not clips:
                # fallback: пробуем общий запрос
                clips, _ = cine.fetch_stock_clips(
                    sdir, ["technology abstract"], max_clips=2,
                    orientation="landscape")
            if not clips:
                continue
            fr = cine.extract_stock_frames(
                ffmpeg, clips, os.path.join(sdir, "frames"))
            if fr:
                # НЕ flattening — храним клипы как [[кадры_клипа_0], ...]
                # чтобы render_cinematic мог проигрывать ДВИЖЕНИЕ в каждом шоте
                for grp in fr:
                    if grp:
                        frames_all.append(grp)
                total_frames = sum(len(g) for g in frames_all)
                print(f"[long] секция {si}: сток «{q}» ({len(clips)} клипов, "
                      f"{total_frames} кадров, {len(frames_all)} клипов-всего)")
        except Exception as e:
            print(f"[long] секция {si}: сток недоступен ({type(e).__name__})")
            continue
    return frames_all


def assign_section_stock(shots, frames):
    """Живые фоны — ВСЕМ cinematic шотам с голосом (а не каждому 2-му).

    S38c: каждый шот с голосом должен иметь визуал, чтобы YouTube-зритель
    видел ДВИЖЕНИЕ на экране, а не чёрные экраны/абстракции.
    """
    if not frames:
        return 0
    ci, n = 0, 0
    for s in shots:
        if cine.shot_kind(s) == "cinematic" and not s.get("texts"):
            s["stock"] = ci % len(frames)
            ci += 1
            n += 1
    print(f"[long] живые фоны назначены {ci}/{n} шотам")
    return ci


# ---------- EDL / SRT (монтажный лист) ----------

def dump_edl(path, topic, format, minutes, fps, shots, bounds):
    edl_shots = []
    for i, s in enumerate(shots):
        e = dict(s)
        e["start"] = round(bounds[i] if i < len(bounds) else 0.0, 3)
        e["end"] = round(bounds[i + 1] if i + 1 < len(bounds) else 0.0, 3)
        e.pop("stock", None)
        edl_shots.append(e)
    edl = {"app": "tgvk-longform", "version": 1, "topic": topic,
           "format": format, "minutes": minutes, "fps": fps,
           "aspect": "16:9", "shots": edl_shots}
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(edl, fh, ensure_ascii=False, indent=1)
    return path


def _srt_ts(sec):
    ms = int(sec * 1000)
    return (f"{ms // 3600000:02d}:{(ms // 60000) % 60:02d}:"
            f"{(ms // 1000) % 60:02d},{ms % 1000:03d}")


def dump_srt(path, shots, bounds):
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
    return path, n


def load_edl(path):
    with open(path, encoding="utf-8") as fh:
        edl = json.load(fh)
    shots = []
    for e in edl.get("shots", []):
        s = dict(e)
        s.pop("start", None)
        s.pop("end", None)
        shots.append(s)
    meta = {k: edl.get(k) for k in ("topic", "format", "minutes", "fps")}
    return shots, meta


# ---------- генерация ----------

def generate_long(topic=None, minutes=6, format="doc", out="out/video_long.mp4",
                  fps=FPS_LONG, tmpdir="out/tmp_long", voice=vg.VOICE_DEFAULT,
                  no_audio=False, voice_over=True, edl_out=None,
                  edl_in=None, script_text=None, provider=None, seed=7):
    """Тема -> длинный ролик 16:9 + EDL/SRT."""
    import shutil as _sh
    minutes = max(1, min(40, int(minutes)))
    if format not in FORMATS:
        format = "doc"
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    os.makedirs(tmpdir, exist_ok=True)
    cine.set_aspect("16:9")
    try:
        return _generate_long_inner(
            topic, minutes, format, out, fps, tmpdir, voice, no_audio,
            voice_over, edl_out, edl_in, script_text, provider, seed)
    finally:
        cine.set_aspect("9:16")


def _generate_long_inner(topic, minutes, format, out, fps, tmpdir, voice,
                         no_audio, voice_over, edl_out, edl_in,
                         script_text, provider, seed):
    import shutil as _sh
    topic = (topic or "Как вас взламывают через фишинг").strip()
    st, key = cine.get_style("cybersecurity_cinematic")
    P = st["palette"]
    bpm = st.get("bpm", 100)
    ffmpeg = vg.find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("нет ffmpeg: pip install imageio-ffmpeg")
    if edl_in:
        shots, meta = load_edl(edl_in)
        topic = meta.get("topic") or topic
        print(f"[long] EDL {edl_in}: {len(shots)} шотов на пересборку")
        sections = []
    elif script_text and str(script_text).strip():
        # S38c: НЕ парсим статью в sections — вместо этого генерируем
        # ПОЛНЫЙ сценарий через per-section LLM, используя статью как контекст.
        # parse_script() даёт мало секций и русские query → 22с видео.
        # write_script() делает per-section LLM → 15мин + EN queries → Pexels.
        print(f"[long] from_post: переключаемся на per-section LLM "
              f"(article {len(script_text)} chars → {minutes} мин сценарий)")
        # Передаём topic из статьи + topic из аргумента
        combined_topic = topic
        try:
            parsed_article = vg.parse_script(str(script_text))
            if parsed_article:
                # Берём заголовок из статьи как тему
                article_head = parsed_article[0].get("heading", "")
                if article_head and len(article_head) > 5:
                    combined_topic = f"{topic}: {article_head}"
        except Exception:
            pass
        sections = write_script(combined_topic, minutes, format, provider)
    else:
        sections = write_script(topic, minutes, format, provider)
    if not edl_in:
        shots = build_long_shots(sections, topic, seed,
                                 target_sec=minutes * 60)
    shots = cine.enforce_balance(shots)
    total_est = sum(float(s["dur"]) for s in shots)
    print(f"[long] план: {len(shots)} шотов, ~{total_est:.0f}с, "
          f"кадров ~{int(total_est * fps)}")
    if total_est * fps > 30000:
        print("[long] ВНИМАНИЕ: очень длинный рендер, "
              "для черновика добавь --fps 12")

    # --- M19: голос ведёт таймлайн (статья/длинный формат: все реплики)
    vmp3, voice_spans = None, []
    if voice_over and not no_audio:
        vmap = [(i, s) for i, s in enumerate(shots)
                if (s.get("voice") or "").strip()]
        if vmap:
            tsecs = []
            for _, s in vmap:
                rate, pitch, vol = cine._prosody(s.get("act"))
                tsecs.append({"voice": s["voice"], "caption": s["id"],
                              "rate": rate, "pitch": pitch, "volume": vol})
            _w = None
            try:
                vmp3, _w = vg.make_voiceover_sections(ffmpeg, tsecs, voice,
                                                      tmpdir)
            except Exception as e:
                print(f"[long] TTS не удался ({type(e).__name__}) "
                      f"— оценка по символам")
                vmp3, _w = None, None
            if _w and len(_w) == len(vmap):
                sec_durs = [float(w) - (0.5 if j < len(vmap) - 1 else 0.0)
                            for j, w in enumerate(_w)]
            else:
                sec_durs = [max(1.5, len(s["voice"]) / 14.0)
                            for _, s in vmap]
                vmp3 = None
            voice_spans = cine._layout_voice_spans(shots, vmap, sec_durs)
            voiced_ids = {id(s) for sp in voice_spans for s in sp["refs"]}
            cine._fit_fillers(shots, voiced_ids, total_est, True)
            total_est = sum(float(s["dur"]) for s in shots)
    for s in shots:
        if (s.get("texts") or s.get("subs")) and s["dur"] < cine._min_dur(s):
            s["dur"] = float(cine._min_dur(s))
    # S30: subs sync — compute voice_ratio for fade-out after voice ends
    for s in shots:
        vs = s.get("_voice_sec", 0)
        if vs > 0:
            s["_voice_ratio"] = min(1.0, vs / max(0.1, float(s["dur"])))
        else:
            s["_voice_ratio"] = 1.0
    seconds = total_est

    # --- стоки 16:9 по секциям (микс с графикой; без ключей — painters)
    stock = None
    try:
        frames = (fetch_section_stock(ffmpeg, tmpdir, sections)
                  if sections else [])
        if frames:
            stock = {"frames": frames, "cache": {}}
            assign_section_stock(shots, frames)
    except Exception as e:
        print(f"[long] сток недоступен ({type(e).__name__}) — только painters")
        stock = None

    pause_win = None
    acc = 0.0
    for s in shots:
        if s["act"] == "twist" and pause_win is None:
            pause_win = (acc, acc + s["dur"])
        acc += s["dur"]
    silent = os.path.join(tmpdir, "silent.mp4")
    _, bounds = cine.render_cinematic(shots, seconds, fps, silent, bpm, P,
                                      tmpdir, stock)
    real_dur = bounds[-1]
    if vmp3 and voice_spans and cine.np is not None and not no_audio:
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
            vmix = cine._assemble_voice(ffmpeg, tmpdir, items, total_v,
                                        cine.SR)
            if vmix:
                vmp3 = vmix
                print(f"[long] голос собран на таймлайн: {len(items)} чанков")
        except Exception as e:
            print(f"[long] сборка голоса не удалась ({type(e).__name__}) "
                  f"— монолит с начала")
    if no_audio or cine.np is None:
        _sh.copy(silent, out)
    else:
        duck = None
        vw = None
        vv = None
        if vmp3:
            vw = os.path.join(tmpdir, "voice.wav")
            r = subprocess.run(
                [ffmpeg, "-y", "-i", vmp3, "-ar", str(cine.SR), "-ac", "1",
                 vw], capture_output=True)
            if r.returncode == 0:
                with wave.open(vw, "rb") as wf:
                    raw = wf.readframes(wf.getnframes())
                vv = (cine.np.frombuffer(raw, dtype=cine.np.int16)
                      .astype(cine.np.float64) * 1.1)
                n = int(real_dur * cine.SR)
                a = cine.np.abs(vv[:n])
                wsize = max(1, int(cine.SR * 0.2))
                cs = cine.np.cumsum(cine.np.insert(a, 0, 0.0))
                env = (cs[wsize:] - cs[:-wsize]) / wsize
                env = cine.np.concatenate(
                    [env, cine.np.full(max(0, n - len(env)), 0.0)])[:n]
                mx = env.max()
                duck = (env / mx) if mx > 0 else cine.np.zeros(n)
        mix = cine.build_soundtrack(shots, bounds, real_dur, bpm, pause_win,
                                    bed=float(st.get("bed_level", 1.0)),
                                    sfx_gain=float(st.get("sfx_level", 1.0)),
                                    duck=duck)
        bed_wav = os.path.join(tmpdir, "bed.wav")
        cine.write_wav(bed_wav, mix)
        if vw is not None and vv is not None:
            m = min(len(vv), len(mix))
            mix2 = mix.astype(cine.np.float64)
            mix2[:m] += vv[:m]
            mix2 = cine.np.clip(mix2, -32768, 32767).astype(cine.np.int16)
            cine.write_wav(bed_wav, mix2)
        vg.mux_audio(ffmpeg, silent, bed_wav, out, real_dur)
    # --- EDL рядом с роликом (SRT НЕ генерируем — YouTube без субтитров)
    base, _ = os.path.splitext(out)
    epath = edl_out or (base + ".edl.json")
    dump_edl(epath, topic, format, minutes, fps, shots, bounds)
    size = os.path.getsize(out)
    print(f"[long] ГОТОВО: {out} ({size / 1048576:.1f} MB, {real_dur:.1f} c, "
          f"{format}, 16:9) + EDL ({len(shots)} шотов)")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Длинные YouTube-ролики 16:9")
    ap.add_argument("--topic", default="")
    ap.add_argument("--minutes", type=int, default=6)
    ap.add_argument("--format", default="doc",
                    choices=list(FORMATS) + ["top", "razbor"],
                    help="doc / breakdown / top10 (top/razbor — алиасы)")
    ap.add_argument("--fps", type=int, default=FPS_LONG)
    ap.add_argument("--out", default="out/video_long.mp4")
    ap.add_argument("--tmpdir", default="out/tmp_long")
    ap.add_argument("--voice", default=vg.VOICE_DEFAULT)
    ap.add_argument("--no-audio", action="store_true")
    ap.add_argument("--edl-out", default="")
    ap.add_argument("--edl-in", default="")
    ap.add_argument("--script-file", default="")
    ap.add_argument("--from-post", default="",
                    help="файл с исходным текстом поста: LLM (GigaChat по "
                         "умолчанию) перепишет его в длинный сценарий; при "
                         "сбое используется исходный текст как есть")
    ap.add_argument("--provider", default=None)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args(argv)
    fmt = {"top": "top10", "razbor": "breakdown"}.get(a.format, a.format)
    script_text = ""
    if a.script_file:
        with open(a.script_file, encoding="utf-8") as fh:
            script_text = fh.read()
    if a.from_post:
        # S27: пост -> LLM рерайт в длинный сценарий (GigaChat по умолчанию).
        with open(a.from_post, encoding="utf-8") as fh:
            post_text = fh.read()
        import llm
        rewritten = llm.rewrite_post_to_script(post_text, "long",
                                               a.provider)
        if rewritten:
            print("[long] длинный сценарий сгенерирован LLM из поста "
                  f"({len(rewritten)} симв.)")
            script_text = rewritten
        else:
            print("[long] LLM-рерайт недоступен — исходный пост как сценарий")
            script_text = post_text
    generate_long(topic=a.topic, minutes=a.minutes, format=fmt, out=a.out,
                  fps=a.fps, tmpdir=a.tmpdir, voice=a.voice,
                  no_audio=a.no_audio, edl_out=a.edl_out or None,
                  edl_in=a.edl_in or None, script_text=script_text,
                  provider=a.provider, seed=a.seed)


if __name__ == "__main__":
    main()
