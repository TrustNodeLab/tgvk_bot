"""Central configuration.

Loads config/default.json (repo) with env override: VF_<KEY> or plain KEY.
Also supports nested overrides via VF_<SECTION>__<KEY>.

Safety: this module NEVER logs values; it only reports presence.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = REPO_ROOT / "config" / "default.json"


def deep_merge(base: dict, override: dict) -> dict:
    out = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _env_overrides() -> dict:
    """VF_* -> nested dict. `VF_VIDEO__WIDTH=720` -> {'video': {'width': '720'}}."""
    out: dict[str, Any] = {}
    for key, val in os.environ.items():
        if key.startswith("VF_"):
            parts = key[3:].split("__")
            node = out
            for p in parts[:-1]:
                node = node.setdefault(p.lower(), {})
            node[parts[-1].lower()] = val
    return out


def _coerce(value: Any, hint: Any) -> Any:
    if hint is None:
        return value
    if isinstance(hint, bool):
        return str(value).lower() in ("1", "true", "yes", "on")
    if isinstance(hint, int):
        try:
            return int(value)
        except (TypeError, ValueError):
            return hint
    if isinstance(hint, float):
        try:
            return float(value)
        except (TypeError, ValueError):
            return hint
    if isinstance(hint, list):
        if isinstance(value, str):
            return [v.strip() for v in value.split(",") if v.strip()]
        return value
    return value


def _coerce_tree(cfg: dict, base: dict) -> dict:
    out = dict(cfg)
    for k, v in cfg.items():
        hint = base.get(k) if isinstance(base, dict) else None
        if isinstance(v, dict):
            out[k] = _coerce_tree(v, hint if isinstance(hint, dict) else {})
        else:
            out[k] = _coerce(v, hint)
    return out


@dataclass
class Config:
    """Immutable-ish merged config tree with dot-path access."""

    data: dict = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path | None = None) -> "Config":
        path = path or DEFAULT_CONFIG_PATH
        if path.exists():
            base = json.loads(path.read_text(encoding="utf-8"))
        else:
            base = {}
        merged = deep_merge(base, _env_overrides())
        merged = _coerce_tree(merged, base)
        return cls(merged)

    def get(self, dotted: str, default: Any = None) -> Any:
        node: Any = self.data
        for part in dotted.split("."):
            if isinstance(node, dict) and part in node:
                node = node[part]
            else:
                return default
        return node

    def require(self, dotted: str, stage: str) -> Any:
        from .errors import config_missing

        val = self.get(dotted)
        if val is None or val == "":
            raise config_missing(stage, dotted)
        return val

    def video(self) -> dict:
        return self.get("video", {})

    def audio(self) -> dict:
        return self.get("audio", {})

    def preset(self) -> dict:
        return self.get("preset", {})

    def providers(self) -> dict:
        return self.get("providers", {})


def load_config(path: Path | None = None, overrides: dict | None = None) -> Config:
    cfg = Config.load(path)
    if overrides:
        cfg.data = deep_merge(cfg.data, overrides)
    return cfg