"""Пресеты стилей видеогенерации (VideoStyle).

Архитектура расширяемая: каждый стиль — отдельный пресет-словарь,
а не разбросанные по коду условия. Новый стиль = новая запись в STYLES.

Пресеты:
- default — legacy-режим: «футуристичный сайт» + скролл (старый generate()).
- cybersecurity_cinematic — кинематографичный cybersecurity-трейлер 9:16:
  почти чёрный + тёмный navy + белый + один акцент (электрический синий,
  красный — для тревожных актов). Никаких Matrix/хакеров в капюшонах.
- cinematic — нейтральный киношный монтаж (тот же движок, тёплая палитра).
- documentary — спокойный ритм, длинные кадры, минимум эффектов.
- social_dynamic — быстрый вертикальный ритм для соцсетей, яркий акцент.
"""

STYLES = {
    "default": {
        "label": "Футуристичный сайт (legacy)",
        "engine": "scroll",
        "palette": {
            "bg": (11, 18, 32),
            "bg_deep": (6, 10, 20),
            "panel": (19, 28, 48),
            "accent": (255, 210, 74),
            "accent2": None,
            "text": (242, 245, 250),
            "sub": (138, 147, 166),
            "line": (41, 52, 78),
        },
        "bpm": 96,
        "voice_over": True,
        "sfx": False,
    },
    "cybersecurity_cinematic": {
        "label": "Cybersecurity cinematic trailer",
        "engine": "cine",
        "palette": {
            "bg": (5, 8, 16),
            "bg_deep": (2, 4, 9),
            "panel": (10, 16, 30),
            "accent": (56, 130, 255),      # электрический синий
            "accent2": (255, 64, 72),      # красный — тревожные акты/пик
            "text": (245, 248, 255),
            "sub": (140, 152, 175),
            "line": (28, 44, 76),
        },
        "bpm": 104,                        # сетка бита для монтажа
        "voice_over": True,                # TikTok: спокойная озвучка поверх тихого бита
        "sfx": True,
        "bed_level": 0.12,                 # очень тихий фон: голос доминирует (M16)
        "sfx_level": 0.20,                 # SFX еле слышны на склейках (M16)
        "stock_queries": (                 # Pexels-поиск реальных кадров для микса (M15);
            "smartphone dark close up",    # нужен PEXELS_API_KEY, иначе painters
            "server room dark",
            "hacker laptop night",
            "city night bokeh",
        ),
        "max_text_lines": 2,               # крупные короткие фразы, не субтитры
        "forbidden": (                     # НЕ использовать как стиль
            "matrix", "падающий код", "anonymous", "хакер в капюшоне",
            "зелёный терминал", "neon cyberpunk", "glitch ради glitch",
        ),
    },
    "cinematic": {
        "label": "Нейтральный кинематографичный монтаж",
        "engine": "cine",
        "palette": {
            "bg": (12, 12, 16),
            "bg_deep": (5, 5, 8),
            "panel": (24, 24, 32),
            "accent": (255, 176, 64),
            "accent2": None,
            "text": (246, 244, 238),
            "sub": (150, 146, 136),
            "line": (52, 50, 58),
        },
        "bpm": 92,
        "voice_over": False,
        "sfx": True,
        "max_text_lines": 2,
        "forbidden": (),
    },
    "documentary": {
        "label": "Спокойный документальный ритм",
        "engine": "cine",
        "palette": {
            "bg": (10, 14, 18),
            "bg_deep": (4, 6, 9),
            "panel": (20, 28, 36),
            "accent": (120, 190, 220),
            "accent2": None,
            "text": (240, 243, 246),
            "sub": (140, 150, 160),
            "line": (40, 54, 66),
        },
        "bpm": 72,
        "voice_over": True,
        "sfx": False,
        "max_text_lines": 3,
        "forbidden": (),
    },
    "social_dynamic": {
        "label": "Быстрый вертикальный ритм для соцсетей",
        "engine": "cine",
        "palette": {
            "bg": (8, 10, 20),
            "bg_deep": (3, 4, 10),
            "panel": (18, 26, 48),
            "accent": (0, 220, 190),
            "accent2": (255, 210, 74),
            "text": (244, 248, 252),
            "sub": (140, 152, 175),
            "line": (34, 52, 80),
        },
        "bpm": 120,
        "voice_over": False,
        "sfx": True,
        "max_text_lines": 2,
        "forbidden": (),
    },
}


def get_style(name):
    """Возвращает копию пресета; неизвестное имя -> default."""
    import copy

    key = str(name or "default").strip().lower()
    if key not in STYLES:
        key = "default"
    return copy.deepcopy(STYLES[key]), key


def list_styles():
    """Имена доступных стилей."""
    return sorted(STYLES.keys())
