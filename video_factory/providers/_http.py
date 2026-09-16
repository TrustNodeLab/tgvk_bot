"""Minimal HTTP helpers (no external deps in main path)."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any


# Cloudflare бот-фильтр режет запросы с User-Agent: Python-urllib/3.x (HTTP 403).
# Все исходящие запросы шлём с нормальным UA, чтобы достучаться до Worker API.
DEFAULT_HEADERS = {
    "User-Agent": "tgvk-bot-webhook/1.0 (+https://github.com/TrustNodeLab/tgvk_bot)",
    "Accept": "application/json, */*",
}


def _request(url: str, method: str, body: bytes | None, headers: dict, timeout: float = 60.0) -> Any:
    merged = {**DEFAULT_HEADERS, **headers}
    req = urllib.request.Request(url, data=body, method=method, headers=merged)
    try:
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