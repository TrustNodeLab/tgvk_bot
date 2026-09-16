"""Minimal HTTP helpers (no external deps in main path)."""

from __future__ import annotations

import json
import os
import ssl
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


# Cloudflare бот-фильтр режет запросы с User-Agent: Python-urllib/3.x (HTTP 403).
# Все исходящие запросы шлём с нормальным UA, чтобы достучаться до Worker API.
DEFAULT_HEADERS = {
    "User-Agent": "tgvk-bot-webhook/1.0 (+https://github.com/TrustNodeLab/tgvk_bot)",
    "Accept": "application/json, */*",
}

# GigaChat (Сбер) подписан корневым сертификатом НУЦ Минцифры (Russian Trusted
# Root CA), которого НЕТ в системных хранилищах и в certifi — urllib падает с
# CERTIFICATE_VERIFY_FAILED (self-signed certificate in certificate chain).
# Как и bot/llm.py, используем сертификат из репозитория bot/certs/
# (russian_trusted_root_ca.pem, официальный источник Госуслуг) или GIGACHAT_CA_BUNDLE.
GIGACHAT_HOST_HINT = "sberbank.ru"
_REPO_ROOT = Path(__file__).resolve().parents[2]  # tgvk_bot/ (video_factory/providers/..)
GIGACHAT_CA_DEFAULT = _REPO_ROOT / "bot" / "certs" / "russian_trusted_root_ca.pem"


def _gigachat_ca_path() -> str | None:
    """Путь к корневому сертификату НУЦ Минцифры для GigaChat.

    Приоритет: GIGACHAT_CA_BUNDLE env -> bot/certs/russian_trusted_root_ca.pem.
    Возвращает None, если сертификат не найден (тогда TLS отключается явно)."""
    env = os.environ.get("GIGACHAT_CA_BUNDLE", "").strip()
    if env and os.path.exists(env):
        return env
    if GIGACHAT_CA_DEFAULT.exists():
        return str(GIGACHAT_CA_DEFAULT)
    return None


def _ssl_context(url: str) -> ssl.SSLContext | None:
    """HTTPS-контекст под конкретный хост.

    - gigachat.devices.sberbank.ru / ngw.devices.sberbank.ru (sberbank.ru):
      НУЦ Минцифры CA из repo bot/certs или GIGACHAT_CA_BUNDLE; если сертификата
      нет — отключаем проверку TLS (как резерв в bot/llm.py, не тихо).
    - остальные хосты: bundle certifi (если установлен), иначе системный контекст.
    """
    if GIGACHAT_HOST_HINT in url:
        ca = _gigachat_ca_path()
        if ca:
            return ssl.create_default_context(cafile=ca)
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        print(
            "[warn] НУЦ Минцифры сертификат не найден (bot/certs/russian_trusted_root_ca.pem, "
            + "GIGACHAT_CA_BUNDLE), проверка TLS для GigaChat отключена",
            file=__import__("sys").stderr,
        )
        return ctx
    try:
        import certifi  # pip install certifi
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return None


_CONTEXTS: dict[str, ssl.SSLContext | None] = {}  # кэш контекстов по типу


def _request(url: str, method: str, body: bytes | None, headers: dict, timeout: float = 60.0) -> Any:
    merged = {**DEFAULT_HEADERS, **headers}
    req = urllib.request.Request(url, data=body, method=method, headers=merged)
    key = "gigachat" if GIGACHAT_HOST_HINT in url else "default"
    if key not in _CONTEXTS:
        _CONTEXTS[key] = _ssl_context(url)
    ctx = _CONTEXTS[key]
    try:
        if ctx is not None:
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
                raw = resp.read()
                ctype = resp.headers.get("Content-Type", "")
                if "application/json" in ctype or raw[:1] in (b"{", b"["):
                    return json.loads(raw.decode("utf-8", "replace")), resp.status
                return raw, resp.status
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            ctype = resp.headers.get("Content-Type", "")
            if "application/json" in ctype or raw[:1] in (b"{", b"["):
                return json.loads(raw.decode("utf-8", "replace")), resp.status
            return raw, resp.status
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"HTTP {e.code} from {url}: {detail}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"URL error {url}: {e.reason}") from e


def post_json(url: str, obj: dict, headers: dict, timeout: float = 60.0) -> Any:
    h = {"Content-Type": "application/json", **headers}
    raw, _ = _request(url, "POST", json.dumps(obj, ensure_ascii=False).encode("utf-8"), h, timeout)
    return raw


def post_urlencoded(url: str, data: bytes | str, headers: dict, timeout: float = 60.0) -> dict:
    h = {"Content-Type": "application/x-www-form-urlencoded", **headers}
    raw, _ = _request(url, "POST", data if isinstance(data, bytes) else data.encode(), h, timeout)
    return raw if isinstance(raw, dict) else {"raw": raw}


def get_json(url: str, headers: dict, timeout: float = 60.0) -> Any:
    raw, _ = _request(url, "GET", None, headers, timeout)
    return raw


def get_bytes(url: str, headers: dict, timeout: float = 60.0) -> bytes:
    raw, _ = _request(url, "GET", None, headers, timeout)
    return raw if isinstance(raw, bytes) else str(raw).encode()