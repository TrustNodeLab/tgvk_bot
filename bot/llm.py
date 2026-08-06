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
            "temperature": 0.4,
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
            "temperature": 0.4,
        },
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def extract_post_data(raw_text: str, prev_post: dict = None) -> dict:
    """prev_post (опц.) — данные предыдущего поста канала: их количество/типы карточек
    и layout. Передаётся в промпт, чтобы бот не публиковал подряд посты с одинаковой
    сеткой и набором карточек."""
    api_key = os.environ["LLM_API_KEY"]
    provider = os.environ.get("LLM_PROVIDER", "").strip().lower()

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

    messages = [
        {"role": "system", "content": _load_system_prompt()},
        {"role": "user", "content": user_content},
    ]

    if provider == "gigachat":
        model = os.environ.get("LLM_MODEL") or DEFAULT_GIGACHAT_MODEL
        content = _call_gigachat_with_fallback(api_key, model, messages)
    else:
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
