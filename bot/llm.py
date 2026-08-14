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
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
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


def extract_post_data(raw_text: str, prev_post: dict = None, provider: str = None, style: str = None) -> dict:
    """prev_post (опц.) — данные предыдущего поста канала: их количество/типы карточек
    и layout. Передаётся в промпт, чтобы бот не публиковал подряд посты с одинаковой
    сеткой и набором карточек.

    style (опц.) — жанр поста из ротации ("razbor"|"warning"|"fact"|"myth"|"case"),
    чтобы соседние посты выглядели по-разному, как у живой редакции.

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


def _resolve_provider(provider: str = None) -> str:
    return (provider or os.environ.get("LLM_PROVIDER", "") or "").strip().lower()


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
    "Ты — ведущий утреннего/дневного/вечернего выпуска новостей TrustNode о "
    "кибербезопасности. По списку новостей собери дайджест в стиле новостного "
    "вещания: по каждой новости коротко, 2–3 предложения, как диктор новостей — "
    "что произошло, почему это важно читателю. Тон — уверенный ведущий, живой "
    "язык, без канцелярита и без выдуманных цифр/сумм (бери только из текста).\n"
    "Верни ТОЛЬКО валидный JSON без пояснений и без markdown-разметки:\n"
    '{"headline":"короткий заголовок выпуска, 1 фраза", '
    '"bullets":["по каждой новости 2-3 предложения"], '
    '"advice":["2-3 совета, как защититься"]}.'
)


def extract_digest(items: list, provider: str = None) -> dict:
    """Собирает дайджест из списка новостей: headline + по bullets на новость
    (2–3 предложения вещательным стилем) + советы. provider: "gigachat"|"gemini"
    или из LLM_PROVIDER."""
    lines = []
    for i, it in enumerate(items, 1):
        title = str(it.get("title") or "").strip()
        text = str(it.get("text") or "").strip()
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

    return {
        "headline": str(data.get("headline") or "").strip(),
        "bullets": [str(b).strip() for b in data.get("bullets") or [] if str(b).strip()][: len(items)],
        "advice": [str(a).strip() for a in data.get("advice") or [] if str(a).strip()][:3],
    }
