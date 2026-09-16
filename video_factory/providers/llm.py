"""LLM provider: GigaChat / Gemini / OpenAI-compatible / template (dry-run).

Interface: complete_json(system, user, schema_hint) -> dict  (validated JSON)
"""

from __future__ import annotations

import json
import os
import re
import time
import uuid
from typing import Any

from ..config import Config
from ..errors import llm_invalid_json, llm_unavailable
from ..logging import get_logger

log = get_logger("vf.llm")

SCHEMA_PROMPT = """Верни ТОЛЬКО валидный JSON. Любой текст вне JSON запрещён.
Схема: %s"""


def _extract_json(text: str) -> Any:
    """Robust JSON extraction: strip code fences, find first {...} or [...] block."""
    if text is None:
        raise llm_invalid_json("script", "empty LLM response")
    t = text.strip()
    t = re.sub(r"^```(?:json)?\s*", "", t)
    t = re.sub(r"\s*```$", "", t)
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    # Find the outermost JSON block
    for opener, closer in (("{", "}"), ("[", "]")):
        start = t.find(opener)
        if start == -1:
            continue
        depth = 0
        for i in range(start, len(t)):
            if t[i] == opener:
                depth += 1
            elif t[i] == closer:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(t[start : i + 1])
                    except json.JSONDecodeError:
                        break
    raise llm_invalid_json("script", f"no JSON found in response: {t[:200]!r}")


class TemplateLLM:
    """Deterministic fallback for dry-run / TEST_MODE — no network, no cost."""

    def __init__(self):
        self._count = 0

    def complete_json(self, system: str, user: str, schema_hint: str = "") -> dict:
        topic = ""
        m = re.search(r"[Тт]ема[^:\n]{0,40}[:]\s*(.+)", user) or re.search(r"topic[:]\s*(.+)", user)
        if m:
            topic = m.group(1).strip().strip("\"'")
        self._count += 1
        return {
            "title": f"«{topic or 'Без темы'}» — коротко",
            "hook": f"Разбираем тему: {topic or 'главное из мира технологий'}.",
            "scenes": [
                {
                    "id": 1,
                    "narration": f"{topic or 'Тема'}: вводная. Что произошло и почему это важно.",
                    "visual": {"type": "generated", "query": topic or "technology abstract", "prompt": topic or "abstract tech background"},
                    "overlay": topic or "Главное",
                },
                {
                    "id": 2,
                    "narration": "Ключевые детали и контекст: цифры, даты, имена.",
                    "visual": {"type": "generated", "query": "data analysis", "prompt": "data charts dark minimal"},
                    "overlay": "Детали",
                },
                {
                    "id": 3,
                    "narration": "Что это значит для вас и что будет дальше.",
                    "visual": {"type": "generated", "query": "future technology", "prompt": "futuristic minimal dark"},
                    "overlay": "Итог",
                },
            ],
        }


class GigaChatLLM:
    def __init__(self, api_key: str, model: str = "GigaChat-Pro", base_url: str = "https://gigachat.devices.sberbank.ru"):
        self.api_key = api_key
        self.model = model
        self.base_url = base_url
        self._token: tuple[str, float] | None = None  # (token, expires_at)

    def _auth(self) -> str:
        now = time.time()
        if self._token and self._token[1] > now + 60:
            return self._token[0]
        # OAuth token endpoint (GigaChat)
        data = f"scope={self.base_url}/api/personal_scope".encode()
        headers = {"Authorization": f"Basic {self.api_key}", "Content-Type": "application/x-www-form-urlencoded", "RqUID": str(uuid.uuid4())}
        resp = _post(f"{self.base_url}/api/v2/oauth", data=data, headers=headers)
        tok = resp.get("access_token", "")
        self._token = (tok, now + int(resp.get("expires_at", 1800)))
        return tok

    def complete_json(self, system: str, user: str, schema_hint: str = "") -> dict:
        from ._http import post_json

        token = self._auth()
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": system + "\n" + SCHEMA_PROMPT % schema_hint},
                {"role": "user", "content": user},
            ],
            "temperature": 0.7,
            "max_tokens": 4000,
        }
        resp = post_json(f"{self.base_url}/api/v1/chat/completions", body, {"Authorization": f"Bearer {token}"})
        content = resp["choices"][0]["message"]["content"]
        return _extract_json(content)


class GeminiLLM:
    def __init__(self, api_key: str, model: str = "gemini-2.0-flash"):
        self.api_key = api_key
        self.model = model

    def complete_json(self, system: str, user: str, schema_hint: str = "") -> dict:
        from ._http import post_json

        body = {
            "contents": [{"parts": [{"text": system + "\n" + user}]}],
            "generationConfig": {"temperature": 0.7, "maxOutputTokens": 4000, "responseMimeType": "application/json"},
        }
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent?key={self.api_key}"
        resp = post_json(url, body, {})
        return _extract_json(resp["candidates"][0]["content"]["parts"][0]["text"])


class OpenAIChatLLM:
    """OpenAI-compatible chat completions (works with proxies/local LLMs)."""

    def __init__(self, base_url: str, api_key: str, model: str = "gpt-4o-mini"):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model

    def complete_json(self, system: str, user: str, schema_hint: str = "") -> dict:
        from ._http import post_json

        body = {
            "model": self.model,
            "messages": [{"role": "system", "content": system + "\n" + SCHEMA_PROMPT % schema_hint}, {"role": "user", "content": user}],
            "temperature": 0.7,
        }
        resp = post_json(f"{self.base_url}/chat/completions", body, {"Authorization": f"Bearer {self.api_key}"})
        return _extract_json(resp["choices"][0]["message"]["content"])


def _post(url: str, data: bytes | str, headers: dict) -> dict:
    from ._http import post_urlencoded

    return post_urlencoded(url, data, headers)


class LLMProvider:
    """Facade: picks adapter from config, applies retry policy."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        from ..retry import RetryPolicy

        r = cfg.get("retry", {})
        self.retry = RetryPolicy(max_attempts=int(r.get("max_attempts", 3)), base_delay_s=float(r.get("base_delay_s", 5)), max_delay_s=float(r.get("max_delay_s", 120)))
        self._adapter = self._build()

    def _build(self):
        p = self.cfg.providers()
        kind = (os.environ.get("LLM_PROVIDER") or p.get("llm") or "gigachat").lower()
        if kind == "template":
            return TemplateLLM()
        if kind == "gigachat":
            key = os.environ.get("LLM_API_KEY") or self.cfg.get("providers.llm_key")
            return GigaChatLLM(key) if key else TemplateLLM()
        if kind == "gemini":
            key = os.environ.get("GEMINI_API_KEY") or self.cfg.get("providers.gemini_key")
            return GeminiLLM(key) if key else TemplateLLM()
        if kind in ("openai", "openai-compatible"):
            return OpenAIChatLLM(self.cfg.require("providers.openai_base", "script"), os.environ.get("LLM_API_KEY", ""), os.environ.get("LLM_MODEL", "gpt-4o-mini"))
        return TemplateLLM()

    def generate_script(self, topic: str, preset: dict) -> dict:
        """Topic -> structured script JSON (validated by caller schema)."""
        schema = {
            "$schema": "http://json-schema.org/draft-07/schema#",
            "type": "object",
            "required": ["title", "hook", "scenes"],
            "properties": {
                "title": {"type": "string", "maxLength": 90},
                "hook": {"type": "string", "maxLength": 280},
                "scenes": {
                    "type": "array",
                    "minItems": 3,
                    "maxItems": 8,
                    "items": {
                        "type": "object",
                        "required": ["id", "narration", "visual", "overlay"],
                        "properties": {
                            "id": {"type": "integer"},
                            "narration": {"type": "string", "maxLength": 420},
                            "visual": {"type": "object", "required": ["type", "query", "prompt"]},
                            "overlay": {"type": "string", "maxLength": 90},
                        },
                    },
                },
            },
        }
        system = (
            "Ты — сценарист вертикальных коротких видео (9:16) о технологиях, кибербезопасности и ИТ-новостях. "
            "Стиль: тёмный минимализм, лаконично, факты без воды. Пиши нарратив для озвучки разговорным русским, "
            "3–6 сцен по 12–20 секунд. Каждая сцена: narration (что говорит диктор), visual.type (pexels|generated), "
            "visual.query (англ. поисковый запрос для стоков), visual.prompt (англ. промпт для генерации картинки), "
            "overlay (короткий текст на экране, ≤6 слов)."
        )
        user = f"Тема: {topic}\nПресет: {json.dumps(preset.get('llm', {}), ensure_ascii=False)[:800]}\nХронометраж: {preset.get('duration_s', 55)} сек."
        schema_str = json.dumps(schema, ensure_ascii=False)[:2500]
        try:
            data = self.retry.run(lambda: self._adapter.complete_json(system, user, schema_str), stage="script")
        except Exception as e:
            raise llm_unavailable("script", str(e)) from e
        validated = _validate_script(data)
        return validated


def _validate_script(data: Any) -> dict:
    if not isinstance(data, dict):
        raise llm_invalid_json("script", "expected object")
    scenes = data.get("scenes")
    if not isinstance(scenes, list) or not (3 <= len(scenes) <= 8):
        raise llm_invalid_json("script", f"scenes must be list of 3..8, got {type(scenes).__name__}:{len(scenes) if isinstance(scenes, list) else '?'}")
    out: list[dict] = []
    for i, s in enumerate(scenes):
        if not isinstance(s, dict) or not s.get("narration"):
            raise llm_invalid_json("script", f"scene[{i}] missing narration")
        vis = s.get("visual")
        if not isinstance(vis, dict) or not vis.get("query"):
            vis = {"type": "generated", "query": (s.get("overlay") or "technology")[:60], "prompt": (s.get("overlay") or "technology")[:200]}
        out.append({
            "id": int(s.get("id", i + 1)),
            "narration": str(s["narration"]).strip()[:420],
            "visual": {
                "type": "pexels" if str(vis.get("type", "pexels")) == "pexels" else "generated",
                "query": str(vis.get("query", "technology"))[:60],
                "prompt": str(vis.get("prompt", ""))[:300],
            },
            "overlay": str(s.get("overlay", ""))[:90],
        })
    return {"title": str(data.get("title", "Новости"))[:90], "hook": str(data.get("hook", ""))[:280], "scenes": out}


def get_llm(cfg: Config) -> LLMProvider:
    return LLMProvider(cfg)