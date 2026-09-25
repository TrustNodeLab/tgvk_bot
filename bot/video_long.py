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
import long_profiles as profiles  # noqa: E402 (profile contract)

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


def _profile_is_explicit(profile):
    """Return whether a caller supplied a profile override.

    ``None`` and blank strings intentionally mean "use the compatibility
    default".  This distinction matters for ``--edl-in``: an omitted CLI/API
    profile follows the profile stored in the EDL, while an explicit
    ``--profile classic`` is an intentional override.
    """
    if profile is None:
        return False
    if isinstance(profile, str):
        return bool(profile.strip())
    return True


def _canonical_profile(profile=None):
    """Validate and return a canonical profile key.

    Kept as a small adapter so all long-path entry points use the same
    registry policy and unknown explicit values fail before side effects.
    """
    return profiles.get_profile(profile)[1]


def _blueprint(topic, minutes, format, profile=None):
    """Return the structural section skeleton for a format/profile pair.

    The profile module owns the deterministic shares.  The returned tuples
    preserve the historical private-helper shape used by older callers.
    """
    plan = profiles.blueprint(profile, minutes, format)
    return [(item["role"], item["share"]) for item in plan]


def _fallback_script(topic, minutes, format, profile=None):
    """Шаблон без LLM (честная заглушка: структура формата, текст generic)."""
    profile_key = _canonical_profile(profile)
    plan = profiles.blueprint(profile_key, minutes, format)
    total = _target_chars(minutes)
    out = []
    for i, contract in enumerate(plan):
        role = contract["role"]
        share = contract["share"]
        profile_role = contract.get("profile_role", role)
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
        out.append({
            "heading": head[:80],
            "body": body[:budget + 400],
            "query": query_en,
            "role": role,
            "profile": profile_key,
            "profile_role": profile_role,
            "visual_mode": contract.get("visual_mode"),
            "protected": bool(contract.get("protected")),
            "anchor": contract.get("anchor"),
            "method": "template",
        })
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


def write_script(topic, minutes, format, provider=None, profile=None,
                 source_context=None):
    """Сценарий секциями [{heading, body, query, role}] — по секции через LLM.

    ``profile`` is orthogonal to the structural ``format``.  ``source_context``
    is the bounded source/article body supplied by the caller; it is included
    in every final section prompt so a heading-only parse cannot discard the
    factual material used by the video.
    """
    profile_key = _canonical_profile(profile)
    fmt = profiles.normalize_format(format)
    total = _target_chars(minutes)
    plan = profiles.blueprint(profile_key, minutes, fmt)
    per_section_min = max(300, int(total / len(plan) * 0.6))
    secs = []
    source_context = "" if source_context is None else str(source_context)

    if llm is not None:
        for i, contract in enumerate(plan):
            role = contract["role"]
            share = contract["share"]
            profile_role = contract.get("profile_role", role)
            visual_mode = contract.get("visual_mode")
            protected = bool(contract.get("protected"))
            anchor = contract.get("anchor")
            budget = max(300, int(total * share))
            # Инициализируем переменные ДО цикла retry (на случай HTTPError)
            body = ""
            heading = f"{topic}: часть {i + 1}"
            query_en = _ru_to_en_query(topic, topic)
            role_name = {"hook": "заставка/вступление",
                         "chapter": "основная часть",
                         "argument": "аргумент",
                         "item": "элемент топа",
                         "thesis": "тезис",
                         "verdict": "вердикт",
                         "finale": "финал/выводы",
                         "outro": "завершение"}.get(role, role)
            rules = profiles.script_rules(
                profile_key,
                role=profile_role,
                index=i,
                total=len(plan),
                source_context=source_context,
            )
            prompt = (
                f"Ты — сценарист YouTube-канала о кибербезопасности и технологиях. "
                f"Напиши ЧАСТЬ {i+1} из {len(plan)} ({role_name}) сценария "
                f"на тему «{topic}» (формат {fmt}).\n"
                f"Это {role_name} ролика на {minutes} минут.\n"
                f"Требуется МИНИМУМ {per_section_min} символов дикторского текста "
                f"(цель ~{budget} символов).\n"
                f"Правила:\n"
                f"- body — живой дикторский текст: только факты и детали из "
                f"контекста источника, без воды и приветствий.\n"
                f"- heading — короткое название (до 6 слов)\n"
                f"- query — 2-3 слова на АНГЛИЙСКОМ для поиска сток-видео "
                f"(УНИКАЛЬНЫЕ для этой секции, НЕ повторяй query из предыдущих частей)\n"
                f"Профильный контракт и контекст источника:\n{rules}\n"
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
                fb = _fallback_script(topic, minutes, fmt, profile_key)
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
                "profile": profile_key,
                "profile_role": profile_role,
                "visual_mode": visual_mode,
                "protected": protected,
                "anchor": anchor,
                "method": "llm" if body and "template" not in str(body) else "template"})

        total_chars = sum(len(s['body']) for s in secs)
        print(f"[long] сценарий LLM: {len(secs)} секций "
              f"({total_chars} симв, цель {total})")
        if total_chars >= total * 0.3:
            return secs
        print(f"[long] LLM дал {total_chars} символов — дополняем fallback")
        # Дополняем короткие секции шаблонным текстом
        fb = _fallback_script(topic, minutes, fmt, profile_key)
        for j, section in enumerate(secs):
            if len(section["body"]) < per_section_min and j < len(fb):
                section["body"] = section["body"] + " " + fb[j].get("body", "")
                section["method"] = "llm+template"
        return secs

    return _fallback_script(topic, minutes, fmt, profile_key)


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
_CASEBOOK_VISUALS = ["news_article", "data_center", "keyboard",
                     "server_rack", "phone_message", "courtroom",
                     "evidence_table", "city_skyline", "drone_aerial",
                     "federal_building", "bokeh"]
_CAMERAS = ["push_in", "drift", "push_out", "tilt", "whip_pan", "snap"]
_TRANS = ["hard_cut", "whip", "zoom", "match", "hard_cut", "dip"]


def _mkshot(sid, act, dur, visual, camera, texts, trans_out, sfx="none",
            speed=(1.0, 1.0), accent="accent", fx="", typ=None,
            voice="", sub="", sec=0, profile=None, profile_role=None,
            visual_mode=None, protected=False, anchor=None):
    if typ is None:
        typ = "cinematic"
    # YouTube 16:9 uses a separate voice/SRT artifact; these shots do not
    # inject decorative subtitles into the renderer timeline.
    subs = []
    shot = {"id": sid, "sec": sec, "act": act, "dur": dur, "visual": visual,
            "camera": camera, "texts": texts, "subs": subs,
            "sub": "", "voice": voice[:CHUNK_MAX],
            "trans_out": trans_out, "sfx": sfx, "speed": speed,
            "accent": accent, "fx": fx, "type": typ}
    if profile is not None:
        shot.update({
            "profile": profile,
            "profile_role": profile_role,
            "visual_mode": visual_mode,
            "protected": bool(protected),
            "anchor": anchor,
        })
    return shot


def _tx(*lines, mode="pop"):
    return [{"lines": [str(l).upper().strip()[:24] for l in lines],
             "mode": mode}]


# S40: категории спрайтов + эвристика выбора по тексту секции
_PIXEL_CATS = ["emotions", "people", "soldiers", "photographers",
               "red-ties", "funny1", "funny2"]


def _pixel_cats_for(text, heading=""):
    """Подбирает категории спрайтов под тему секции (по ключевым словам)."""
    t = f"{heading} {text}".lower()
    if any(w in t for w in ("полиц", "арест", "задерж", "рейд", "спецназ",
                            "фсб", "ордер", "наручник")):
        return ["soldiers", "red-ties", "people"]
    if any(w in t for w in ("хакер", "даркнет", "сеть", "сервер", "код",
                            "биткоин", "крипто", "взлом", "шифр")):
        return ["people", "emotions", "photographers"]
    if any(w in t for w in ("журнал", "репорт", "пресс", "камер", "съёмк")):
        return ["photographers", "people", "emotions"]
    return ["emotions", "funny1", "funny2"]


def _pixel_interstitial(rnd, si, sec, n, profile=None, profile_role=None,
                        visual_mode=None, protected=False, anchor=None):
    """Optional pixel-art transition for the classic compatibility profile."""
    text = sec.get("body", "")
    heading = sec.get("heading", "")
    cats = _pixel_cats_for(text, heading)
    sprite_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                              "sprites")
    paths = []
    for cat in cats[:2]:
        cdir = os.path.join(sprite_dir, cat)
        if not os.path.isdir(cdir):
            continue
        files = sorted(f for f in os.listdir(cdir) if f.lower().endswith(".png"))
        if not files:
            continue
        pick = rnd.sample(files, min(rnd.randint(1, 2), len(files)))
        for f in pick:
            paths.append(f"{cat}/{f}")
    if not paths:
        return None
    shot = _mkshot(
        f"L{si:02d}_px", "accel", 2.5,
        {"type": "pixel_scene", "sprites": paths[:3]}, "push_in",
        [], "hard_cut", "click", (1.2, 1.2), "accent", "", "graphic",
        sec=si, profile=profile, profile_role=profile_role,
        visual_mode=visual_mode, protected=protected, anchor=anchor)
    shot["seed"] = rnd.randint(1, 10 ** 6)
    return shot


def build_long_shots(sections, topic, seed=7, target_sec=None, profile=None):
    """Секции -> shot list без лимита длины (longform).

    ``profile`` controls editorial metadata and shot policy while ``format``
    remains represented by the section's structural ``role``.  Trimming may
    remove ordinary middle voice shots, but never a protected profile anchor;
    existing shot dictionaries (and therefore voice identity) are retained.
    """
    profile_key = _canonical_profile(profile)
    policy = profiles.shot_policy(profile_key)
    protected_roles = set(policy.get("protected_roles") or ())
    visual_modes = dict(policy.get("visual_modes") or {})
    allow_interstitial = bool(policy.get("allow_interstitial", True))
    max_interstitials = policy.get("max_interstitials")
    if max_interstitials is not None:
        max_interstitials = max(0, int(max_interstitials))
    interstitial_count = 0
    visual_pool = list(_CASEBOOK_VISUALS if profile_key == "trustnode_casebook"
                       else _VISUALS)
    transition_pool = (["hard_cut", "match", "dip"]
                       if profile_key == "trustnode_casebook" else list(_TRANS))
    peak_pool = list(_PEAK_POOL)
    rnd = random.Random(seed + abs(hash(topic)) % 10 ** 6)
    rnd.shuffle(peak_pool)
    off = abs(hash(topic)) % 997
    shots, vi = [], off % len(visual_pool)

    def metadata(sec):
        role = sec.get("role", "chapter")
        profile_role = sec.get("profile_role") or role
        protected = bool(sec.get("protected",
                                 profile_role in protected_roles))
        anchor = sec.get("anchor") or (profile_role if protected else None)
        visual_mode = sec.get("visual_mode") or visual_modes.get(
            profile_role, "cinematic_evidence")
        return role, profile_role, visual_mode, protected, anchor

    for si, sec in enumerate(sections):
        role, profile_role, visual_mode, protected, anchor = metadata(sec)
        chunks = []
        for sent in _sentences(sec.get("body", "")):
            chunks.extend(_hard_split(sent))
        if not chunks:
            continue
        for k, chunk in enumerate(chunks):
            act = _ROLE_ACT.get(role, "problem")
            if k == len(chunks) - 1 and role in ("verdict", "finale"):
                act = "peak"
            if profile_role == "cold_open":
                act = "hook"
            elif profile_role in ("evidence", "mechanism"):
                act = "problem" if k == 0 else "escalation"
            elif profile_role == "action":
                act = "peak" if k == len(chunks) - 1 else "problem"
            elif profile_role in ("counterpoint", "close"):
                act = "climax"
            if act == "peak":
                vis, accent = peak_pool[(k + off) % len(peak_pool)], "accent2"
            else:
                vis, accent = visual_pool[vi % len(visual_pool)], "accent"
                vi += 1
            if not policy.get("sfx", True):
                sfx = "none"
            else:
                sfx = ("impact" if act == "peak"
                       else ("bass" if act == "hook" else "none"))
            dur = max(1.0, len(chunk) / 12.0 + 0.6)
            shots.append(_mkshot(
                f"L{si:02d}_{k:02d}", act, dur, vis,
                _CAMERAS[(len(shots) + off) % len(_CAMERAS)], [],
                transition_pool[(len(shots) * 3 + off) % len(transition_pool)],
                sfx,
                (1.2, 1.2), accent, "", None, chunk, _smart_sub(chunk),
                sec=si, profile=profile_key, profile_role=profile_role,
                visual_mode=visual_mode, protected=protected, anchor=anchor))
            shots[-1]["seed"] = rnd.randint(1, 10 ** 6)

        # A restrained profile uses fewer chapter cards, while classic keeps
        # its established cadence.
        head = (sec.get("heading") or "").upper().strip().split()
        sparse_cards = policy.get("chapter_card") == "sparse"
        show_card = not sparse_cards or profile_role in {
            "evidence", "action", "counterpoint"
        } or si % 2 == 0
        if head and si < len(sections) - 1 and show_card:
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
                    "accent", "", "typography", sec=si, profile=profile_key,
                    profile_role=profile_role, visual_mode=visual_mode,
                    protected=protected, anchor=anchor))
                shots[-1]["seed"] = rnd.randint(1, 10 ** 6)

        if (allow_interstitial
                and (max_interstitials is None
                     or interstitial_count < max_interstitials)):
            px = _pixel_interstitial(
                rnd, si, sec, len(shots), profile=profile_key,
                profile_role=profile_role, visual_mode=visual_mode,
                protected=protected, anchor=anchor)
            if px:
                shots.append(px)
                interstitial_count += 1

        if si + 1 == max(1, len(sections) // 2) and len(sections) > 1:
            shots.append(_mkshot(
                f"L{si:02d}_p", "twist", 1.8, "pause_black", "static",
                [], "dip", "silence", (0.4, 0.4), "accent", "",
                "cinematic", sec=si, profile=profile_key,
                profile_role=profile_role, visual_mode=visual_mode,
                protected=False, anchor=None))
            shots[-1]["seed"] = rnd.randint(1, 10 ** 6)

    if target_sec:
        def _est():
            return sum(len(s["voice"]) / 14.0 + 0.6 for s in shots
                       if s["voice"])

        def _protected(shot):
            return bool(shot.get("protected") or shot.get("anchor"))

        for _ in range(512):
            if _est() <= target_sec or len(shots) <= 6:
                break
            mid = [s for s in shots
                   if s["voice"] and not _protected(s)
                   and not s["id"].startswith("L00")
                   and not s["id"].startswith("L_fin")]
            if not mid:
                break
            victim = max(mid, key=lambda s: len(s["voice"]))
            shots.remove(victim)

    # The final cards are protected anchors for casebook and compatibility
    # callers alike; the profile decides their metadata and sound treatment.
    last_head = (sections[-1].get("heading") if sections else topic) or topic
    final_profile_role = "close" if profile_key == "trustnode_casebook" else "finale"
    final_visual_mode = visual_modes.get(final_profile_role, "cinematic_close")
    final_sfx_q = "bass" if policy.get("sfx", True) else "none"
    final_sfx_b = "impact" if policy.get("sfx", True) else "none"
    final_anchor = final_profile_role if final_profile_role in protected_roles else None
    shots.append(_mkshot(
        "L_fin_q", "climax", 2.4, "final_q", "static",
        _tx(last_head, mode="whisper"), "dip", final_sfx_q,
        (0.6, 0.8), "accent", "", "typography", sec=max(0, len(sections) - 1),
        profile=profile_key, profile_role=final_profile_role,
        visual_mode=final_visual_mode, protected=bool(final_anchor),
        anchor=final_anchor))
    shots[-1]["seed"] = rnd.randint(1, 10 ** 6)
    shots.append(_mkshot(
        "L_fin_b", "climax", 3.6, "final_brand", "push_out",
        [], "hard_cut", final_sfx_b, (0.7, 1.0), "accent",
        "", "graphic", sec=max(0, len(sections) - 1), profile=profile_key,
        profile_role=final_profile_role, visual_mode=final_visual_mode,
        protected=bool(final_anchor), anchor=final_anchor))

    shots[-1]["seed"] = rnd.randint(1, 10 ** 6)
    print(f"[long] shot list: {len(shots)} шотов, профиль {profile_key}, "
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


# ---------- EDL (монтажный лист) ----------

def dump_edl(path, topic, format, minutes, fps, shots, bounds, profile=None):
    profile_key = _canonical_profile(profile)
    edl_shots = []
    for i, s in enumerate(shots):
        e = dict(s)
        e["start"] = round(bounds[i] if i < len(bounds) else 0.0, 3)
        e["end"] = round(bounds[i + 1] if i + 1 < len(bounds) else 0.0, 3)
        e.pop("stock", None)
        edl_shots.append(e)
    edl = {"app": "tgvk-longform", "version": 1, "topic": topic,
           "format": format, "minutes": minutes, "fps": fps,
           "profile": profile_key, "aspect": "16:9", "shots": edl_shots}
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(edl, fh, ensure_ascii=False, indent=1)
    return path


def load_edl(path):
    with open(path, encoding="utf-8") as fh:
        edl = json.load(fh)
    shots = []
    for e in edl.get("shots", []):
        s = dict(e)
        s.pop("start", None)
        s.pop("end", None)
        shots.append(s)
    meta = {k: edl.get(k) for k in (
        "topic", "format", "minutes", "fps", "profile"
    )}
    return shots, meta


# ---------- генерация ----------

def _write_long_srt(path, cues, required=False):
    """Write a long SRT and enforce the requested-artifact contract.

    A normal no-audio/optional export may have no cues.  Once a caller asks
    for a specific SRT path, however, an absent or empty file is an error that
    must reach the workflow instead of being reported as a successful render.
    """
    path = os.fspath(path) if path else ""
    cue_list = list(cues or [])
    if not path or not cue_list:
        if required:
            target = path or "<empty path>"
            raise RuntimeError(f"[long] запрошенный SRT не создан: {target}")
        return False
    try:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        vg.write_srt(cue_list, path)
        if not os.path.isfile(path) or os.path.getsize(path) <= 0:
            raise OSError("SRT файл пуст")
    except Exception as exc:  # noqa: BLE001 - contract is explicit for required output
        if required:
            raise RuntimeError(f"[long] SRT не записан: {path} ({exc})") from exc
        print(f"[long] SRT не построен ({type(exc).__name__}: {exc})")
        return False
    return True


def _map_long_voice_cues(voice_cues, voice_spans, sec_durs, shots, bounds,
                         real_dur, chunk_bounds=None):
    """Map assembled TTS word cues onto the rendered long timeline.

    ``chunk_bounds`` is the identity-preserving contract returned by
    :func:`video_gen.make_voiceover_sections`.  It is preferred over positional
    ``sec_durs``: a skipped section 0 must not make section 1 inherit section
    0's shot boundary.  The positional fallback keeps compatibility with older
    callers that only provide ``voice_spans``/``sec_durs``.
    """
    source_cues = list(voice_cues or [])
    if not source_cues:
        return []
    if not voice_spans or not shots or not bounds:
        raise ValueError("voice cue timeline is missing span metadata")
    try:
        video_duration = max(0.0, float(real_dur))
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("voice cue timeline has invalid video duration") from exc
    if not math.isfinite(video_duration) or video_duration <= 0.0:
        raise ValueError("voice cue timeline has no positive video duration")

    idx_of = {id(shot): i for i, shot in enumerate(shots)}
    span_by_sec = {}
    for span in voice_spans:
        if not isinstance(span, dict) or not span.get("refs"):
            continue
        try:
            sec = int(span.get("sec", -1))
        except (TypeError, ValueError):
            continue
        if sec >= 0:
            span_by_sec[sec] = span
    if not span_by_sec:
        raise ValueError("voice cue timeline has no usable spans")

    ranges = []
    if chunk_bounds:
        for chunk in chunk_bounds:
            if not isinstance(chunk, dict):
                raise ValueError("voice chunk metadata is malformed")
            try:
                sec = int(chunk.get("sec", chunk.get("section", -1)))
                start = float(chunk["start"])
                end = float(chunk.get("end", start + float(chunk.get("duration", 0.0))))
            except (KeyError, TypeError, ValueError, OverflowError) as exc:
                raise ValueError("voice chunk metadata is malformed") from exc
            if not (math.isfinite(start) and math.isfinite(end) and end > start):
                raise ValueError("voice chunk has invalid audio bounds")
            span = span_by_sec.get(sec)
            if span is None:
                raise ValueError(f"voice section {sec} has no rendered span")
            ranges.append((start, end, sec, span))
    else:
        sec_durs = list(sec_durs or [])
        cursor = 0.0
        for sec in sorted(span_by_sec):
            if sec < len(sec_durs):
                raw_duration = max(0.0, float(sec_durs[sec]))
            else:
                raw_duration = max(0.0, float(span_by_sec[sec].get(
                    "voice_duration", 0.0)))
            if not math.isfinite(raw_duration) or raw_duration <= 0.0:
                raise ValueError("voice section has invalid audio duration")
            ranges.append((cursor, cursor + raw_duration, sec,
                           span_by_sec[sec]))
            cursor += raw_duration + vg.CHUNK_GAP
    if not ranges:
        raise ValueError("voice cue timeline has no usable audio ranges")

    mapped = []
    for cue in source_cues:
        try:
            cue_start = float(cue["start"])
            cue_end = float(cue["end"])
        except (KeyError, TypeError, ValueError, OverflowError) as exc:
            raise ValueError("voice cue has invalid bounds") from exc
        if not (math.isfinite(cue_start) and math.isfinite(cue_end)
                and cue_end > cue_start):
            raise ValueError("voice cue has no positive finite duration")

        cue_sec = cue.get("section")
        if cue_sec is None:
            match = next(
                (item for item in ranges
                 if cue_start < item[1] - 1e-9
                 and cue_end > item[0] + 1e-9),
                None,
            )
        else:
            try:
                cue_sec = int(cue_sec)
            except (TypeError, ValueError) as exc:
                raise ValueError("voice cue has invalid section identity") from exc
            match = next((item for item in ranges if item[2] == cue_sec), None)
        if match is None:
            raise ValueError(
                f"voice cue {cue_start:.3f}..{cue_end:.3f} has no chunk span"
            )
        local_start, local_end, sec, span = match
        if cue_start < local_start - 1e-6 or cue_end > local_end + 1e-6:
            raise ValueError(
                f"voice cue {cue_start:.3f}..{cue_end:.3f} lies outside "
                f"section {sec} audio chunk"
            )
        refs = span.get("refs") or []
        first_index = idx_of.get(id(refs[0]))
        if first_index is None or first_index >= len(bounds):
            raise ValueError("voice span has no rendered shot boundary")
        video_start = float(bounds[first_index]) + cue_start - local_start
        video_end = float(bounds[first_index]) + cue_end - local_start
        video_start = max(0.0, min(video_duration, video_start))
        video_end = max(0.0, min(video_duration, video_end))
        if video_end <= video_start:
            raise ValueError("mapped voice cue has no positive duration")
        mapped.append({"start": video_start, "end": video_end,
                       "text": cue.get("text", ""), "section": sec})
    return mapped


def generate_long(topic=None, minutes=6, format="doc", out="out/video_long.mp4",
                  fps=FPS_LONG, tmpdir="out/tmp_long", voice=vg.VOICE_DEFAULT,
                  no_audio=False, voice_over=True, edl_out=None,
                  edl_in=None, script_text=None, provider=None, seed=7,
                  srt_out=None, profile=None, source_context=None):
    """Тема -> длинный ролик 16:9 + EDL/SRT.

    ``profile`` and ``source_context`` are appended so all historical
    positional callers retain their meaning.  An omitted profile follows the
    profile stored in ``edl_in`` when present and otherwise uses ``classic``.
    Explicit profile values are validated before output directories or TTS.
    """
    profile_override = _profile_is_explicit(profile)
    if profile_override:
        profile_key = _canonical_profile(profile)
    elif edl_in:
        # Read only the small metadata contract before creating directories so
        # an invalid stored profile cannot start an expensive render.
        _, edl_meta = load_edl(edl_in)
        profile_key = _canonical_profile(edl_meta.get("profile"))
    else:
        profile_key = _canonical_profile(None)

    minutes = max(1, min(40, int(minutes)))
    if format not in FORMATS:
        format = "doc"
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    os.makedirs(tmpdir, exist_ok=True)
    cine.set_aspect("16:9")
    try:
        inner_args = (
            topic, minutes, format, out, fps, tmpdir, voice, no_audio,
            voice_over, edl_out, edl_in, script_text, provider, seed, srt_out,
        )
        # Keep the historical positional call shape for untouched classic
        # callers; pass the appended contract only when a caller selected it.
        if profile_override or profile_key != "classic" or source_context is not None:
            return _generate_long_inner(
                *inner_args, profile=profile_key, source_context=source_context
            )
        return _generate_long_inner(*inner_args)
    finally:
        cine.set_aspect("9:16")


def _generate_long_inner(topic, minutes, format, out, fps, tmpdir, voice,
                         no_audio, voice_over, edl_out, edl_in,
                         script_text, provider, seed, srt_out=None,
                         profile=None, source_context=None):
    # The silent render is copied directly when audio/TTS is disabled.  Keep
    # the import local to this legacy path so the short-video modules do not
    # acquire an unnecessary global dependency.
    import shutil as _sh

    if srt_out and no_audio:
        raise RuntimeError(
            "[long] запрошенный SRT невозможен без аудио; "
            "используйте отдельный no-SRT режим")

    profile_override = _profile_is_explicit(profile)
    profile_key = _canonical_profile(profile) if profile_override else None
    if edl_in:
        shots, meta = load_edl(edl_in)
        if not profile_override:
            profile_key = _canonical_profile(meta.get("profile"))
        # Old EDLs have no per-shot profile; annotate them for the selected
        # contract without changing their voice, timing, or visual fields.
        for shot in shots:
            shot["profile"] = profile_key
        topic = (topic or "Как вас взламывают через фишинг").strip()
        topic = meta.get("topic") or topic
        print(f"[long] EDL {edl_in}: {len(shots)} шотов на пересборку")
        sections = []
    else:
        meta = {}
        shots = None
        topic = (topic or "Как вас взламывают через фишинг").strip()

    if profile_key is None:
        profile_key = _canonical_profile(None)
    profile_definition, profile_key = profiles.get_profile(profile_key)
    st, _style_key = cine.get_style(profile_definition["style"])
    P = st["palette"]
    bpm = st.get("bpm", 100)
    ffmpeg = vg.find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("нет ffmpeg: pip install imageio-ffmpeg")

    source_text = ("" if source_context is None else str(source_context))
    if source_context is None and script_text is not None:
        source_text = str(script_text)
    script_for_heading = str(script_text or source_text)
    if not edl_in and script_for_heading.strip():
        # S38c: keep the complete source as prompt context; parsing is only
        # used to improve the topic label and never to replace the source.
        print(f"[long] from_post: переключаемся на per-section LLM "
              f"(article {len(source_text)} chars → {minutes} мин сценарий)")
        combined_topic = topic
        try:
            parsed_article = vg.parse_script(script_for_heading)
            if parsed_article:
                article_head = parsed_article[0].get("heading", "")
                if article_head and len(article_head) > 5:
                    combined_topic = f"{topic}: {article_head}"
        except Exception:
            pass
        sections = write_script(
            combined_topic, minutes, format, provider, profile=profile_key,
            source_context=source_text,
        )
    elif not edl_in:
        sections = write_script(
            topic, minutes, format, provider, profile=profile_key,
            source_context=source_text,
        )
    if not edl_in:
        shots = build_long_shots(
            sections, topic, seed, target_sec=minutes * 60, profile=profile_key
        )
    shots = cine.enforce_balance(shots)
    total_est = sum(float(s["dur"]) for s in shots)
    print(f"[long] план: {len(shots)} шотов, ~{total_est:.0f}с, "
          f"кадров ~{int(total_est * fps)}")
    if total_est * fps > 30000:
        print("[long] ВНИМАНИЕ: очень длинный рендер, "
              "для черновика добавь --fps 12")

    # --- M19: голос ведёт таймлайн (статья/длинный формат: все реплики)
    vmp3, voice_spans, tsecs = None, [], []
    sec_durs, voice_cues = [], []
    voice_meta, chunk_bounds = {}, []
    voice_aligned = False
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
            _meta = {}
            try:
                vmp3, _w, _meta = vg.make_voiceover_sections(
                    ffmpeg, tsecs, voice, tmpdir, lead_in=0.0)
                voice_meta = dict(_meta or {})
                voice_cues = list(voice_meta.get("cues") or [])
                chunk_bounds = list(voice_meta.get("chunk_bounds") or [])
            except Exception as e:
                print(f"[long] TTS не удался ({type(e).__name__}) "
                      f"— оценка по символам")
                vmp3, _w, voice_cues, chunk_bounds = None, None, [], []
                voice_meta = {}

            active_by_sec = {}
            for chunk in chunk_bounds:
                try:
                    sec = int(chunk.get("sec", chunk.get("section", -1)))
                    duration = float(chunk.get(
                        "duration", float(chunk["end"]) - float(chunk["start"])))
                except (KeyError, TypeError, ValueError, OverflowError):
                    continue
                if sec >= 0 and math.isfinite(duration) and duration > 0.0:
                    active_by_sec[sec] = duration
            if active_by_sec:
                sec_durs = [
                    active_by_sec.get(j, max(1.5, len(s["voice"]) / 14.0))
                    for j, (_, s) in enumerate(vmap)
                ]
            elif _w and len(_w) == len(vmap):
                sec_durs = [
                    float(w) - (vg.CHUNK_GAP if j < len(vmap) - 1 else 0.0)
                    for j, w in enumerate(_w)
                ]
            else:
                sec_durs = [max(1.5, len(s["voice"]) / 14.0)
                            for _, s in vmap]
                vmp3, voice_cues, chunk_bounds = None, [], []
            voice_spans = cine._layout_voice_spans(shots, vmap, sec_durs)
            if active_by_sec:
                voice_spans = [
                    span for span in voice_spans
                    if int(span.get("sec", -1)) in active_by_sec
                ]
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
                if not sp.get("refs"):
                    continue
                i0 = idx_of.get(id(sp["refs"][0]))
                if i0 is None or i0 >= len(bounds):
                    continue
                sec = int(sp.get("sec", -1))
                path = os.path.join(tmpdir, f"sec_{sec}.mp3")
                if not os.path.isfile(path) or os.path.getsize(path) <= 0:
                    continue
                items.append((path, float(bounds[i0])))
            if items:
                total_v = max(0.0, float(real_dur))
                vmix = cine._assemble_voice(ffmpeg, tmpdir, items, total_v,
                                            cine.SR)
                if vmix and os.path.isfile(vmix) and os.path.getsize(vmix) > 0:
                    vmp3 = vmix
                    voice_aligned = True
                    print(f"[long] голос собран на таймлайн: {len(items)} чанков")
                else:
                    print("[long] сборка голоса не дала непустой файл")
            else:
                print("[long] нет подтверждённых TTS-чанков для сборки")
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
    # --- EDL рядом с роликом
    base, _ = os.path.splitext(out)
    epath = edl_out or (base + ".edl.json")
    dump_edl(epath, topic, format, minutes, fps, shots, bounds,
             profile=profile_key)
    # --- SRT: таймкоды = реальные спаны голоса на таймлайне ролика
    spath = srt_out or (base + ".srt")
    srt_required = bool(srt_out)
    if no_audio:
        # ``--no-audio`` is a supported render mode only when no SRT was
        # requested; the incompatible explicit request was rejected above.
        print("[long] SRT: пропущен (no_audio)")
    else:
        cues = []
        try:
            if srt_required and not voice_aligned:
                raise ValueError("voice track was not assembled to shot boundaries")
            if voice_aligned and voice_cues and cine.np is not None:
                cues = _map_long_voice_cues(
                    voice_cues, voice_spans, sec_durs, shots, bounds, real_dur,
                    chunk_bounds=chunk_bounds or None)
            elif srt_required and voice_cues:
                raise ValueError("voice cues exist without a rendered voice track")
        except Exception as exc:  # noqa: BLE001 - required output must fail loudly
            if srt_required:
                raise RuntimeError(f"[long] SRT не построен: {spath} ({exc})") from exc
            print(f"[long] SRT не построен ({type(exc).__name__}: {exc})")
        else:
            if _write_long_srt(spath, cues, required=srt_required):
                print(f"[long] SRT: {spath} ({len(cues)} слов)")
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
    ap.add_argument("--profile", default=None,
                    help="редакционный профиль: classic / trustnode_casebook")
    ap.add_argument("--srt-out", default="",
                    help="путь для SRT субтитров (по спанам голоса)")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args(argv)
    if a.script_file and a.from_post:
        ap.error(
            "--script-file and --from-post are mutually exclusive; "
            "provide only one source"
        )
    fmt = {"top": "top10", "razbor": "breakdown"}.get(a.format, a.format)
    profile = (_canonical_profile(a.profile)
               if _profile_is_explicit(a.profile)
               else (None if a.edl_in else "classic"))
    script_text = ""
    source_context = None
    if a.script_file:
        with open(a.script_file, encoding="utf-8") as fh:
            script_text = fh.read()
        source_context = script_text
    if a.from_post:
        # S27: пост -> LLM рерайт в длинный сценарий (GigaChat по умолчанию).
        with open(a.from_post, encoding="utf-8") as fh:
            post_text = fh.read()
        import llm
        rewritten = llm.rewrite_post_to_script(
            post_text,
            "long",
            a.provider,
            profile=profile,
            minutes=a.minutes,
            source_context=post_text,
        )
        if rewritten:
            print("[long] длинный сценарий сгенерирован LLM из поста "
                  f"({len(rewritten)} симв.)")
            script_text = rewritten
        else:
            print("[long] LLM-рерайт недоступен — исходный пост как сценарий")
            script_text = post_text
        # Keep the original post as source context even when the rewrite wins.
        source_context = post_text
    generate_long(topic=a.topic, minutes=a.minutes, format=fmt, out=a.out,
                  fps=a.fps, tmpdir=a.tmpdir, voice=a.voice,
                  no_audio=a.no_audio, edl_out=a.edl_out or None,
                  edl_in=a.edl_in or None, script_text=script_text,
                  provider=a.provider, seed=a.seed,
                  srt_out=a.srt_out or None, profile=profile,
                  source_context=source_context)


if __name__ == "__main__":
    main()
