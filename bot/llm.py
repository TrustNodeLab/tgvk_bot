"""
Вызов LLM для превращения сырого текста в структурированный JSON.
Провайдер выбирается переменной окружения LLM_PROVIDER:

- gigachat (по умолчанию для РФ): GigaChat от Сбера, работает из России без VPN.
  LLM_API_KEY = base64(client_id:client_secret) из кабинета developers.sber.ru
  (формат "<client_id>:<client_secret>", закодированный в base64).
  LLM_MODEL — опционально, по умолчанию GigaChat-Max.
- пусто / openai / что угодно другое: любой OpenAI-совместимый эндпоинт
  (Gemini, DeepSeek, ...). LLM_API_KEY, LLM_API_BASE, LLM_MODEL.

GigaChat не совместим с OpenAI-эндпоинтом «из коробки»: сначала по client credentials
получаем короткоживущий access_token (OAuth 2.0), потом зовём chat/completions.
"""
import json
import os
import re
import sys
import time
import uuid
import requests

try:
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
PROMPT_PATH = os.path.join(HERE, "..", "prompts", "extract_prompt.md")

DEFAULT_API_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"
DEFAULT_MODEL = "gemini-flash-lite-latest"

# Жанры поста: ротация «как в живой редакции», чтобы соседние посты не выглядели
# одинаково. Ключ совпадает с POST_STYLES в worker/lib/llm.js.
_STYLE_HINTS = {
    "razbor": (
        "«Разбор схемы»: коротко о чём новость, затем ПО ШАГАМ — как работает "
        "схема обмана (что говорит мошенник, как давит на страхи, где точка "
        "остановиться), в конце — конкретная защита. Тон — аналитик безопасности, "
        "объясняющий механику, а не новостная лента."
    ),
    "warning": (
        "«Предупреждение»: поставь читателя в ситуацию («вы можете столкнуться "
        "с этим сегодня»), объясни риск человеческим языком, дай 2–3 действия, "
        "которые прямо сейчас снижают угрозу. Заботливо, без паники и кликбейта."
    ),
    "fact": (
        "«Факт-карточка»: сухо и по делу. Главные факты новости короткими "
        "абзацами, цифры точно из источника, вывод одним предложением. Без "
        "лишних слов и общих советов, информационный стиль."
    ),
    "myth": (
        "«Разбор заблуждения»: найди миф или наивную ошибку, связанную с "
        "новостью («я думал, меня это не касается»), разбери, почему это "
        "работает на людях, и покажи, как правильно. Спокойно, с примерами "
        "«хорошо/плохо»."
    ),
    "case": (
        "«Кейс-история»: перескажи ситуацию из новости как историю конкретного "
        "человека (кто, где, что случилось, что потерял), выдели момент, где "
        "можно было остановиться, и сделай вывод-совет. Живо, без канцелярита."
    ),
}

DEFAULT_GIGACHAT_MODEL = "GigaChat-Max"
GIGACHAT_OAUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth"
GIGACHAT_CHAT_URL = "https://gigachat.devices.sberbank.ru/api/v1/chat/completions"
# Семейство моделей от дорогой к дешёвой: если у дорогой кончилась бесплатная квота
# (HTTP 402), автоматически пробуем следующую. Lite ("GigaChat") — последняя в цепочке.
GIGACHAT_MODEL_FALLBACK = ["GigaChat-Max", "GigaChat-Pro", "GigaChat"]
# Корневой сертификат НУЦ Минцифры (Russian Trusted Root CA), выданный на
# gigachat.devices.sberbank.ru. Скачан с портала Госуслуг https://www.gosuslugi.ru/crt
# (официальный источник Минцифры), подробнее — README, раздел «Сертификат GigaChat».
GIGACHAT_CA_DEFAULT = os.path.join(HERE, "certs", "russian_trusted_root_ca.pem")

# Токен GigaChat живёт ~30 минут; кэшируем в рамках одного запуска, чтобы не
# дёргать OAuth на каждый запрос (запуски короткие — перезапрашивать не больно).
_gigachat_token = {"value": None, "expires_at": 0}


def _load_system_prompt() -> str:
    with open(PROMPT_PATH, "r", encoding="utf-8") as f:
        return f.read()


def _strip_code_fence(text: str) -> str:
    text = text.strip()
    m = re.search(r"```[a-zA-Z]*\s*(.*?)```", text, re.DOTALL)
    if m:
        return m.group(1).strip()
    return text


def _gigachat_verify():
    """Параметр verify для запросов к GigaChat.

    Приоритет: переменная окружения GIGACHAT_CA_BUNDLE -> встроенный бандл
    bot/certs/russian_trusted_root_ca.pem. Если сертификата нет ни там, ни там —
    отключаем проверку TLS только как явный резервный режим, с warning в stderr
    (не тихо)."""
    env = os.environ.get("GIGACHAT_CA_BUNDLE", "").strip()
    if env:
        if os.path.exists(env):
            return env
        print(f"[warn] GIGACHAT_CA_BUNDLE указан, но файл не найден: {env}", file=sys.stderr)
    if os.path.exists(GIGACHAT_CA_DEFAULT):
        return GIGACHAT_CA_DEFAULT
    print(
        "[warn] Корневой сертификат НУЦ Минцифры не найден: "
        + GIGACHAT_CA_DEFAULT
        + ". Проверка TLS-сертификата отключена (verify=False). Скачай "
          "russian_trusted_root_ca.pem с https://www.gosuslugi.ru/crt или задай "
          "GIGACHAT_CA_BUNDLE.",
        file=sys.stderr,
    )
    return False


def _get_gigachat_token(credentials_b64: str) -> str:
    now = time.time()
    if _gigachat_token["value"] and _gigachat_token["expires_at"] - 60 > now:
        return _gigachat_token["value"]

    resp = requests.post(
        GIGACHAT_OAUTH_URL,
        headers={
            "Authorization": f"Basic {credentials_b64}",
            "RqUID": str(uuid.uuid4()),
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data={"scope": "GIGACHAT_API_PERS"},
        timeout=60,
        verify=_gigachat_verify(),
    )
    resp.raise_for_status()
    body = resp.json()
    _gigachat_token["value"] = body["access_token"]
    # GigaChat отдаёт expires_at в миллисекундах unix-времени — приводим к секундам,
    # чтобы сравнивать с time.time().
    _gigachat_token["expires_at"] = body.get("expires_at", 0) / 1000
    return _gigachat_token["value"]


def _gigachat_chat_request(token: str, model: str, messages: list) -> requests.Response:
    return requests.post(
        GIGACHAT_CHAT_URL,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json={
            "model": model,
            "messages": messages,
            "temperature": 0.7,
            # Без явного max_tokens GigaChat по умолчанию ограничивает ответ
            # ~512 токенами и при переполнении отвечает «Не укладываюсь в
            # ограничения» вместо ответа. Дайджест на 3 новости легко превышает
            # этот лимит, поэтому закладываем с запасом.
            "max_tokens": 1024,
        },
        timeout=120,
        verify=_gigachat_verify(),
    )


class GigaChatQuotaExhausted(RuntimeError):
    """Квоты токенов текущей модели GigaChat исчерпаны (HTTP 402) — нужно
    переключиться на более дешёвую модель семейства."""


GIGACHAT_RATE_LIMIT_RETRIES = 5


def _call_gigachat(api_key: str, model: str, messages: list) -> str:
    # GigaChat при параллельных запросах (несколько ранов Actions сразу) отвечает
    # HTTP 429. Ретраим с паузой, чтобы не терять кандидатов в rate limit.
    retries = GIGACHAT_RATE_LIMIT_RETRIES
    delay = 3
    while True:
        token = _get_gigachat_token(api_key)
        resp = _gigachat_chat_request(token, model, messages)
        if resp.status_code == 402:
            raise GigaChatQuotaExhausted(f"GigaChat: закончились токены модели {model} (HTTP 402)")
        if resp.status_code == 401:
            # Токен протух на сервере раньше нашего расчёта по expires_at (или кэш
            # устарел) — сбрасываем кэш, получаем свежий токен и пробуем ещё раз (1 retry).
            _gigachat_token["value"] = None
            _gigachat_token["expires_at"] = 0
            token = _get_gigachat_token(api_key)
            resp = _gigachat_chat_request(token, model, messages)
        if resp.status_code == 429 and retries > 0:
            retries -= 1
            print(f"[warn] GigaChat 429 (rate limit) — retry через {delay}с, осталось {retries}", file=sys.stderr)
            time.sleep(delay)
            delay = min(delay * 2, 30)
            continue
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]


def _gigachat_fallback_chain(start_model: str) -> list:
    """Цепочка моделей для автодеградации при исчерпании квоты: от start_model вниз
    по GIGACHAT_MODEL_FALLBACK, плюс оставшиеся модели семейства, если start_model
    задан вручную через LLM_MODEL и не совпадает с порядком списка."""
    chain = [start_model]
    start_idx = GIGACHAT_MODEL_FALLBACK.index(start_model) if start_model in GIGACHAT_MODEL_FALLBACK else -1
    for m in GIGACHAT_MODEL_FALLBACK[start_idx + 1:]:
        if m not in chain:
            chain.append(m)
    return chain


def _call_gigachat_with_fallback(api_key: str, model: str, messages: list) -> str:
    """Вызывает GigaChat начиная с model; при HTTP 402 (закончились бесплатные токены
    у этой модели) автоматически переходит на более дешёвую модель семейства."""
    chain = _gigachat_fallback_chain(model)
    last_err = None
    for candidate in chain:
        try:
            return _call_gigachat(api_key, candidate, messages)
        except GigaChatQuotaExhausted as e:
            last_err = e
            print(f"[warn] {e} — пробую модель {candidate} -> следующий уровень", file=sys.stderr)
    raise last_err or RuntimeError("GigaChat: все модели семейства недоступны")


def _call_openai_compatible(api_key: str, api_base: str, model: str, messages: list) -> str:
    resp = requests.post(
        f"{api_base}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json={
            "model": model,
            "messages": messages,
            "temperature": 0.7,
        },
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def extract_post_data(raw_text: str, prev_post: dict = None, provider: str = None, style: str = None, best_posts: str = None) -> dict:
    """prev_post (опц.) — данные предыдущего поста канала: их количество/типы карточек
    и layout. Передаётся в промпт, чтобы бот не публиковал подряд посты с одинаковой
    сеткой и набором карточек.

    style (опц.) — жанр поста из ротации ("razbor"|"warning"|"fact"|"myth"|"case"),
    чтобы соседние посты выглядели по-разному, как у живой редакции.

    best_posts (опц.) — подсказка «что сейчас залетает у аудитории» (лидирующие
    жанр/тема/схема + примеры лучших постов). LLM делает новый пост в этом же
    ключе, не копируя дословно.

    provider (опц.) — явный выбор: "gigachat" | "gemini" | иной OpenAI-совместимый.
    Если не задан — берётся из LLM_PROVIDER env (по умолчанию gigachat)."""
    p = (provider or os.environ.get("LLM_PROVIDER", "") or "").strip().lower()

    user_content = raw_text
    if prev_post:
        prev_cards = prev_post.get("cards", [])
        prev_types = [c.get("type", "stat") for c in prev_cards]
        prev_layout = prev_post.get("layout")
        user_content = (
            f"Новость:\n{raw_text}\n\n"
            "Контекст: предыдущий пост канала уже использовал такую сетку — "
            f"карточек {len(prev_cards)} (типы: {', '.join(prev_types) or '—'}), "
            f"layout {prev_layout}. Сделай ДРУГОЕ количество карточек, другие типы "
            "и другую сетку layout, чтобы посты не выглядели одинаково."
        )
    if style:
        user_content += f"\n\nТребование к формату поста: {_STYLE_HINTS.get(style, '')}".rstrip()
    if best_posts:
        user_content += f"\n\n{best_posts}"

    messages = [
        {"role": "system", "content": _load_system_prompt()},
        {"role": "user", "content": user_content},
    ]

    if p == "gigachat":
        api_key = os.environ.get("GIGACHAT_API_KEY") or os.environ["LLM_API_KEY"]
        model = os.environ.get("GIGACHAT_MODEL") or os.environ.get("LLM_MODEL") or DEFAULT_GIGACHAT_MODEL
        content = _call_gigachat_with_fallback(api_key, model, messages)
    elif p == "gemini":
        api_key = os.environ.get("GEMINI_API_KEY") or os.environ["LLM_API_KEY"]
        api_base = os.environ.get("GEMINI_API_BASE") or os.environ.get("LLM_API_BASE", DEFAULT_API_BASE)
        model = os.environ.get("GEMINI_MODEL") or os.environ.get("LLM_MODEL") or DEFAULT_MODEL
        content = _call_openai_compatible(api_key, api_base, model, messages)
    else:
        api_key = os.environ["LLM_API_KEY"]
        api_base = os.environ.get("LLM_API_BASE", DEFAULT_API_BASE)
        model = os.environ.get("LLM_MODEL") or DEFAULT_MODEL
        content = _call_openai_compatible(api_key, api_base, model, messages)

    clean = _strip_code_fence(content)
    try:
        return json.loads(clean)
    except (json.JSONDecodeError, TypeError):
        # Показываем админу, что именно вернула модель, чтобы было понятно,
        # менять ли промпт или ретраить.
        snippet = str(content)[:200]
        return {"error": f"LLM вернул невалидный JSON: {snippet}"}


OPINION_SYSTEM_PROMPT = (
    "Ты — редактор канала TrustNode о кибербезопасности. По тексту новости напиши "
    "авторское мнение-вывод к посту: 1-2 предложения, живой комментарий редакции "
    "(что здесь не так, почему это касается читателя, что стоит запомнить). "
    "Это НЕ пересказ фактов и НЕ совет по защите — это позиция и эмоция редакции.\n"
    "Тон: как человек рассказывает знакомому, ирония и предостережение уместны, "
    "канцелярит и слова «важно/актуально» запрещены. Верни ТОЛЬКО текст мнения, "
    "без кавычек, пояснений, markdown и слова «мнение редакции»."
)


def extract_opinion(raw_text: str, provider: str = None) -> str:
    """Лёгкий вызов LLM для «мнения студии»: 1-2 предложения авторского вывода.
    Возвращает короткую строку; при сбое/пустом ответе — пустую строку, чтобы
    вызывающий код подставил шаблонное мнение."""
    try:
        messages = [
            {"role": "system", "content": OPINION_SYSTEM_PROMPT},
            {"role": "user", "content": str(raw_text or "")[:3000]},
        ]
        content = _complete(messages, provider)
        text = _strip_code_fence(content)
        text = _strip_source_tail(str(text or "").strip())
        text = text.replace("Мнение редакции:", "").replace("мнение редакции:", "").strip(" «\"'")
        if len(text) < 20:
            return ""
        return text[:220]
    except Exception as e:  # noqa: BLE001
        print(f"[llm] мнение студии недоступно: {e}")
        return ""


def _resolve_provider(provider: str = None) -> str:
    return (provider or os.environ.get("LLM_PROVIDER", "") or "").strip().lower()


CRITIQUE_SYSTEM_PROMPT = (
    "Ты — строгий редактор телеграм-канала TrustNode о кибербезопасности. "
    "По черновику поста (заголовок + текст) найди признаки «ботопостинга»: "
    "пустые открывалки (важно/срочно/внимание/напоминаем/не пропустите), "
    "клише-канцелярит (в сегодняшней статье/по итогам/стоит отметить), "
    "бессодержательные обобщения («это большая проблема»), повторы мысли. "
    "Верни ТОЛЬКО валидный JSON без пояснений: "
    '{"issues":["короткие замечания"], "fixed_caption":"исправленный текст поста '
    '(HTML, без источника и футера) или пустая строка, если всё оставить как есть"}. '
    "Не выдумывай факты и цифры сверх новости; не добавляй ссылок и футера."
)


def extract_critique(draft: str, provider: str = None) -> dict:
    """Самокритика черновика поста: {"issues": [...], "fixed_caption": "..."}.
    При сбое/невалидном JSON возвращает пустой fixed_caption, чтобы пост не мутировал."""
    try:
        messages = [
            {"role": "system", "content": CRITIQUE_SYSTEM_PROMPT},
            {"role": "user", "content": str(draft or "")[:6000]},
        ]
        content = _complete(messages, provider)
        text = _strip_code_fence(content)
        import re as _re
        m = _re.search(r"\{[\s\S]*\}", text or "")
        if not m:
            return {"issues": [], "fixed_caption": ""}
        data = json.loads(m.group(0))
        issues = data.get("issues") or []
        small = data.get("fixed_caption") or ""
        small = str(small).strip()
        return {
            "issues": [str(x) for x in issues if x][:5],
            "fixed_caption": small if len(small) >= 60 else "",
        }
    except Exception as e:  # noqa: BLE001
        print(f"[llm] самокритик недоступно: {e}")
        return {"issues": [], "fixed_caption": ""}


SHORT_SCRIPT_SYSTEM_PROMPT = (
    "Ты — сценарист коротких экспертных роликов для TikTok/Reels (вертикаль "
    "9:16) в стиле хакерского кибербез-канала. По тексту источника напиши "
    "сценарий озвучки из РОВНО 4 (максимум 4) КОРОТКИХ предложений — "
    "вся суть укладывается в эти 4 фразы, которые диктор читает вслух.\n"
    "Требования:\n"
    "1. Ровно 4 коротких предложения (не больше), без нумерации и без "
    "заголовков с #.\n"
    "2. Каждое предложение — живой разговорный русский без канцелярита: "
    "конкретика, цифры, детали из источника.\n"
    "3. 1-е предложение — крюк: интрига, вопрос или шок-факт. "
    "4-е — вывод-рекомендация в одну строку.\n"
    "4. Запрещено: «важно/актуально/стоит отметить», общие фразы, вступления "
    "вроде «в этой статье», ссылки на источник, markdown.\n"
    "Верни ТОЛЬКО текст из 4 предложений — без пояснений и рамок кода."
)


LONG_SCRIPT_SYSTEM_PROMPT = (
    "Ты — сценарист длинных документальных роликов (5-7 минут) о "
    "кибербезопасности для YouTube (16:9). По тексту источника напиши сценарий "
    "озвучки на 5-7 минут (от 800 до 1100 слов).\n"
    "Структура: 6-7 секций, каждая — заголовок с новой строки (начинается с "
    "#), затем 1-3 абзаца текста. Первая секция — крюк (1-2 предложения), "
    "последняя — вывод-рекомендация. Между ними — разбор: факты из источника, "
    "контекст, механизм атаки простыми словами, конкретные примеры и цифры.\n"
    "Тон — живой экспертный разговор без канцелярита и общих фраз; короткие "
    "предложения; термины с пояснением. Запрещено: «важно/актуально/стоит "
    "отметить», вступления вида «в этой статье», ссылки в тексте, "
    "markdown-форматирование.\n"
    "Верни ТОЛЬКО текст сценария — без пояснений и рамок кода."
)


def rewrite_post_to_script(post_text: str, mode: str = "short",
                           provider: str = None) -> str:
    """Рерайт исходного текста (поста/статьи) в сценарий видео для озвучки.

    mode="short" — TikTok-шортс: РОВНО 4 коротких предложения (вся суть),
                   без # заголовков;
    mode="long"  — YouTube-ролик 5-7 мин (6-7 секций).

    Возвращает текст сценария. Для short — плоский текст из 4 предложений
    (parse_script видео_gen чанкует без #); для long — "# Заголовок" + абзацы.
    При сбое LLM возвращает пустую строку — вызывающий код делает fallback
    на исходный текст."""
    prompt = (SHORT_SCRIPT_SYSTEM_PROMPT if mode == "short"
              else LONG_SCRIPT_SYSTEM_PROMPT)
    try:
        messages = [
            {"role": "system", "content": prompt},
            {"role": "user", "content": str(post_text or "")[:8000]},
        ]
        # S27: рерайт сценариев по умолчанию идёт через GigaChat (пользователь
        # просил именно его); явный provider/env LLM_PROVIDER может переопределить.
        p = (provider or os.environ.get("LLM_PROVIDER", "") or "gigachat"
             ).strip().lower()
        content = _complete(messages, p)
        text = _strip_code_fence(content)
        return str(text or "").strip()
    except Exception as e:  # noqa: BLE001
        print(f"[llm] рерайт сценария ({mode}) недоступен: {e}")
        return ""


MIX_SYSTEM_PROMPT = (
    "Ты — программный продюсер канала TrustNode о кибербезопасности. По контексту "
    "окна публикации выбери формат поста:\n"
    '- "single" — одна главная новость с карточкой;\n'
    '- "digest" — сводка 2-4 новостей одним выпуском;\n'
    '- "poll" — пост с опросом для вовлечения аудитории.\n'
    "Считай число count. Если count < 2 — всегда single (дайджест из одной "
    "новости не собираем). Чередуй форматы, чтобы соседние окна не выглядели "
    "одинаково, и не ставь poll чаще, чем каждое 4-е окно.\n"
    "Верни ТОЛЬКО валидный JSON без пояснений: "
    '{"format":"single|digest|poll","reason":"одна короткая фраза"}'
)


def extract_mix(count: int, window: str = None, date: str = None, provider: str = None) -> dict:
    """Решение формата окна: {"format": "single|digest|poll", "reason": "..."}.
    При сбое/невалидном JSON — правила-фолбэк по count."""
    try:
        if count < 2:
            return {"format": "single", "reason": "мало кандидатов для дайджеста"}
        win_line = f" Окно: {window} ({date})." if window else ""
        messages = [
            {"role": "system", "content": MIX_SYSTEM_PROMPT},
            {"role": "user", "content": f"count={count}.{win_line} Выбери формат."},
        ]
        content = _complete(messages, provider)
        text = _strip_code_fence(content)
        m = re.search(r"\{[\s\S]*\}", text or "")
        if not m:
            raise ValueError("mix: не JSON")
        data = json.loads(m.group(0))
        fmt = str(data.get("format") or "").lower()
        if fmt not in ("single", "digest", "poll"):
            raise ValueError(f"mix: формат {fmt}")
        return {
            "format": fmt,
            "reason": str(data.get("reason") or "")[:120],
        }
    except Exception as e:  # noqa: BLE001
        print(f"[llm] mix недоступен: {e}")
        return {"format": ("digest" if count >= 2 else "single"), "reason": "фолбэк"}


POLL_SYSTEM_PROMPT = (
    "Ты — редактор канала TrustNode о кибербезопасности. По тексту новости "
    "придумай опрос для аудитории.\n"
    "Верни ТОЛЬКО валидный JSON без пояснений: "
    '{"question":"вопрос до 100 символов, понятный без текста новости", '
    '"options":["2-4 коротких варианта до 60 символов каждым"]}.\n'
    "Варианты должны читаться сами по себе. Без markdown и смайликов в вариантах."
)


def extract_poll(raw_text: str, provider: str = None) -> dict:
    """Вопрос+варианты опроса по тексту новости: {"question", "options"}.
    При сбое/невалидном JSON — стандартные правила-фолбэк."""
    fallback = {
        "question": "Сталкивались ли вы с этой схемой?",
        "options": ["Да, было такое", "Слышал о таком", "Впервые слышу", "Не знаю, как защититься"],
    }
    try:
        messages = [
            {"role": "system", "content": POLL_SYSTEM_PROMPT},
            {"role": "user", "content": str(raw_text or "")[:3000]},
        ]
        content = _complete(messages, provider)
        text = _strip_code_fence(content)
        m = re.search(r"\{[\s\S]*\}", text or "")
        if not m:
            raise ValueError("poll: не JSON")
        data = json.loads(m.group(0))
        question = str(data.get("question") or "").strip()
        options = [str(o).strip() for o in (data.get("options") or []) if str(o).strip()]
        if not question or len(options) < 2:
            raise ValueError("poll: пустые question/options")
        return {
            "question": question[:100],
            "options": options[:4],
        }
    except Exception as e:  # noqa: BLE001
        print(f"[llm] poll недоступен: {e}")
        return fallback


def _complete(messages: list, provider: str = None) -> str:
    """Вызывает LLM (GigaChat / Gemini / OpenAI-совместимый) по готовому списку
    сообщений и возвращает сырой текст ответа."""
    p = _resolve_provider(provider)
    if p == "gigachat":
        api_key = os.environ.get("GIGACHAT_API_KEY") or os.environ["LLM_API_KEY"]
        model = os.environ.get("GIGACHAT_MODEL") or os.environ.get("LLM_MODEL") or DEFAULT_GIGACHAT_MODEL
        return _call_gigachat_with_fallback(api_key, model, messages)
    if p == "gemini":
        api_key = os.environ.get("GEMINI_API_KEY") or os.environ["LLM_API_KEY"]
        api_base = os.environ.get("GEMINI_API_BASE") or os.environ.get("LLM_API_BASE", DEFAULT_API_BASE)
        model = os.environ.get("GEMINI_MODEL") or os.environ.get("LLM_MODEL") or DEFAULT_MODEL
        return _call_openai_compatible(api_key, api_base, model, messages)
    api_key = os.environ["LLM_API_KEY"]
    api_base = os.environ.get("LLM_API_BASE", DEFAULT_API_BASE)
    model = os.environ.get("LLM_MODEL") or DEFAULT_MODEL
    return _call_openai_compatible(api_key, api_base, model, messages)


DIGEST_SYSTEM_PROMPT = (
    "Ты — автор канала TrustNode о кибербезопасности. По списку новостей "
    "собери живой разбор. По каждой новости ровно 1 булет (до ~320 символов): "
    "суть факта + твоё развёрнутое мнение о нём, как в личном блоге.\n"
    "Мнение — это НЕ слово «важно» и НЕ пересказ заголовка. Это как человек "
    "рассказывает знакомому: эмоция, ирония, сарказм, предостережение, взгляд "
    "«что здесь не так», «что это значит для нас» и что стоит сделать. Пиши так, "
    "будто это твой личный пост, а не новостная лента.\n"
    "Примеры эталонов:\n"
    "— новость «Выявлена схема мошенничества при покупке машин за рубежом» → "
    "«Продавцы авто за границей берут задаток и испаряются. Как же знакомо: "
    "хочешь выгодно — рискуешь остаться и без машины, и без денег. Совет один: "
    "никаких переводов до осмотра и проверки документов.»\n"
    "— новость «Мошенники наживаются на поиске удалённой работы» → «Работа "
    "мечты из дома? Только сначала оплати доступ к вакансии. Спойлер: это "
    "ловушка. Настоящие работодатели не берут денег за трудоустройство — если "
    "просят предоплату, бросайте это дело и ищите дальше.»\n"
    "Факты бери только из текста новости, без выдумок; не вставляй URL и слова "
    "«источник» в булет.\n"
    "Советов не более 2, каждый до ~50 символов — выпуск должен поместиться в "
    "лимит сообщения Telegram (1024 символа).\n"
    "Верни ТОЛЬКО валидный JSON без пояснений и без markdown-разметки:\n"
    '{"headline":"короткий заголовок выпуска, 1 фраза с интригой или позицией", '
    '"bullets":["по 1 булету на каждую новость — ровно столько булетов, сколько '
    'новостей в списке; развёрнутый разбор с мнением автора"], '
    '"advice":["1-2 коротких совета"]}.'
)


def _strip_source_tail(s: str) -> str:
    """Срезает хвосты «— Источник: https://…» / «Источник: URL», которые LLM
    копирует из сырого текста новости. Сама ссылка добавляется отдельно."""
    import re

    t = str(s or "").strip()
    t = re.sub(r"\s*[—–-]\s*источник\s*:\s*(?:https?://)?\S+\s*$", "", t, flags=re.IGNORECASE)
    t = re.sub(r"\s*источник\s*:\s*(?:https?://)?\S+\s*$", "", t, flags=re.IGNORECASE)
    return t.strip()


def _strip_cdata(s: str) -> str:
    """Убирает из текста XML-мусор типа «<![CDATA[…]]>» и пустые теги, которые
    попадают из RSS-фидов. Нормализует пробелы."""
    import re

    t = str(s or "")
    t = re.sub(r"<!\[CDATA\[|\]\]>", "", t, flags=re.IGNORECASE)
    t = re.sub(r"<[^>]+>", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def _bullet_by_rules(it: dict) -> str:
    """Шаблонный булет из текста новости: первое осмысленное предложение + что
    делать читателю. Используется как фолбэк, когда обе LLM недоступны."""
    import re

    text = _strip_cdata(it.get("text") or "")
    title = str(it.get("title") or "").strip()
    if not text:
        return (title or "Новость")[:150]
    # первое предложение целиком
    first = re.split(r"(?<=[.!?…])\s+", text)[0].strip()
    if len(first) > 140:
        cut = first[:137]
        sp = cut.rfind(" ")
        first = (cut[:sp] if sp > 20 else cut).rstrip(" ,.") + "."
    return first[:150]


# Готовые советы по ситуациям (шаблон): выбираем подходящие по ключевым словам.
_DIGEST_TIPS = [
    ("предоплат|задаток|перевед", "Не платите аванс незнакомцам: проверяйте организацию заранее"),
    ("безопасн[аяо] счёт|дропп", "Никогда не переводите деньги на «безопасный счёт» — это развод"),
    ("штраф|госуслуг", "Проверяйте штрафы только на официальных порталах"),
    ("код|sms|смс|парол", "Не сообщайте коды из SMS и пароли никому"),
    ("ссылк|фишинг|сайт", "Не переходите по подозрительным ссылкам из писем и сообщений"),
    ("звон|банк", "При звонке «из банка» перезвоните сами по номеру с карты"),
]


def _advice_by_rules(items: list) -> list:
    """Советы из шаблона: смотрим текст новостей, выбираем до 2 релевантных."""
    hay = " ".join(
        (str(it.get("title") or "") + " " + str(it.get("text") or "")).lower() for it in items
    )
    picked = []
    for kw, tip in _DIGEST_TIPS:
        if any(w in hay for w in kw.split("|")):
            picked.append(tip[:60])
        if len(picked) >= 2:
            break
    return picked


def _digest_headline_by_rules(items: list) -> str:
    """Заголовок выпуска из шаблона: тема + обобщение."""
    themes = {
        "мошенник": "Мошенники атакуют",
        "фишинг": "Фишинг наступает",
        "дропп": "Дропперы и схемы",
        "банк": "Банковские аферы",
        "штраф": "Штрафы и защита",
        "предоплат": "Предоплата: схемы",
    }
    hay = " ".join(str(it.get("title") or "").lower() for it in items)
    for kw, theme in themes.items():
        if kw in hay:
            return theme
    return "Дайджест TrustNode"


def _opinion_score(b: str) -> float:
    """Оценивает, насколько булет — живое мнение, а не пересказ: маркеры
    эмоции/позиции дают большой вес, содержательный текст — небольшой бонус."""
    b = str(b or "").lower()
    markers = (
        "спойлер", "знакомо", "как же", "ловушка", "развод", "не ведитесь",
        "бегите", "не доверяй", "насторож", "наш взгляд", "наше мнение",
        "мы считаем", "честно", "серьёзно", "увы", "как всегда", "классика",
        "красный флаг", "стоит помнить", "помните", "не платите", "проверяй",
        "осторож", "тревожн", "признак", "афера", "обман", "нажива", "схема",
        "предупрежда", "береги", "задумайтесь", "подвох", "очередно", "опять",
    )
    score = 0.0
    for m in markers:
        if m in b:
            score += 3.0
    score += min(len(b) / 40.0, 4.0)  # содержательность
    return score


def extract_digest(items: list, provider: str = None) -> dict:
    """Собирает дайджест «коллективом»: обе модели (GigaChat и Gemini) пишут
    булеты по всем новостям, для каждой выбираем лучший по признаку «это
    мнение, а не пересказ». Заголовок — от модели с позицией, советы — шаблон
    по ключевым словам. При отказе модели её булеты закрывает вторая, при
    полном отказе — шаблонные булеты из первого предложения новости.
    Возвращает {headline, bullets, advice} (по 1 булету на новость)."""
    primary = provider or os.environ.get("LLM_PROVIDER", "") or "gigachat"
    secondary = "gemini" if primary != "gemini" else "gigachat"

    def _try(prov):
        try:
            return _digest_json(items, prov)
        except Exception as e:  # noqa: BLE001
            print(f"[llm] дайджест {prov} недоступен: {e}")
            return None

    res_primary = _try(primary)
    res_secondary = _try(secondary)

    bullets = [None] * len(items)
    for i in range(len(items)):
        cands = []
        for res in (res_primary, res_secondary):
            if res and i < len(res.get("bullets") or []):
                cands.append(res["bullets"][i])
        if cands:
            bullets[i] = max(cands, key=_opinion_score)

    # заголовок: тот, что больше похож на позицию; иначе любой живой
    headline = ""
    heads = []
    for res in (res_primary, res_secondary):
        if res and res.get("headline"):
            heads.append(res["headline"])
    if heads:
        headline = max(heads, key=_opinion_score)

    # закрываем недостающие булеты шаблоном
    for i in range(len(items)):
        if not bullets[i]:
            bullets[i] = _bullet_by_rules(items[i])

    if not headline:
        headline = _digest_headline_by_rules(items)

    advice = _advice_by_rules(items)
    if not advice:
        advice = ["Проверяйте информацию и никому не сообщайте свои данные"]

    return {
        "headline": _strip_source_tail(str(headline).strip()),
        "bullets": [_strip_source_tail(str(b).strip()) for b in bullets if str(b).strip()][: len(items)],
        "advice": [_strip_source_tail(str(a).strip()) for a in advice][:2],
    }


def _digest_json(items: list, provider: str) -> dict:
    """Один вызов LLM для подмножества новостей: JSON {headline, bullets, advice}.
    bullets — ровно по одному на каждую новость в items."""
    lines = []
    for i, it in enumerate(items, 1):
        title = _strip_cdata(it.get("title") or "")
        text = _strip_cdata(it.get("text") or "")
        link = str(it.get("link") or "").strip()
        lines.append(f"{i}. {title}\n{text}\nСсылка: {link}")
    user_content = "\n\n".join(lines)

    messages = [
        {"role": "system", "content": DIGEST_SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]

    content = _complete(messages, provider)
    clean = _strip_code_fence(content)
    try:
        data = json.loads(clean)
    except (json.JSONDecodeError, TypeError):
        snippet = str(content)[:200]
        return {"error": f"LLM вернул невалидный JSON: {snippet}"}

    bullets = [_strip_source_tail(str(b).strip()) for b in data.get("bullets") or [] if str(b).strip()]
    # По одному булету на каждую новость: если модель вернула меньше (склеила
    # или выбросила новость), результат невалиден — карточка и текст разойдутся.
    if len(bullets) != len(items):
        raise ValueError(f"LLM вернул {len(bullets)} булетов на {len(items)} новостей")

    return {
        "headline": _strip_source_tail(str(data.get("headline") or "").strip()),
        "bullets": bullets,
        "advice": [_strip_source_tail(str(a).strip()) for a in data.get("advice") or [] if str(a).strip()][:2],
    }
