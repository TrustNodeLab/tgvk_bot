"""Visual provider: Pexels (images) + generated fallback (PIL background).

Cost control order: cache > web (Pexels) > local > generated image > generated video.
Interface: fetch(query, orientation, out_path, size) -> Path of image file.
"""

from __future__ import annotations

import os
from pathlib import Path

from ..config import Config
from ..errors import asset_fetch_failed, asset_invalid
from ..logging import get_logger

log = get_logger("vf.visual")


class GeneratedVisual:
    """Programmatic fallback — gradient + topographic lines + no external deps."""

    def __init__(self, w: int = 720, h: int = 1280):
        self.w = w
        self.h = h

    def fetch(self, query: str, out_path: Path, prompt: str = "", seed: int = 0) -> Path:
        from ..renderer.background import render_topographic_frame

        pil_img = render_topographic_frame((self.w, self.h), seed=seed, query=query)
        pil_img.save(out_path, format="PNG")
        return out_path


class PexelsVisual:
    def __init__(self, api_key: str, w: int = 720, h: int = 1280):
        self.api_key = api_key
        self.w = w
        self.h = h

    def fetch(self, query: str, out_path: Path, prompt: str = "", seed: int = 0) -> Path:
        from ._http import get_json, get_bytes

        url = f"https://api.pexels.com/v1/search?query={query}&per_page=5&orientation=portrait"
        try:
            data = get_json(url, {"Authorization": self.api_key}, timeout=30)
        except Exception as e:
            raise asset_fetch_failed("assets", f"pexels search: {e}") from e
        photos = data.get("photos") or []
        if not photos:
            raise asset_fetch_failed("assets", f"pexels empty for query {query!r}")
        # Prefer larger images close to 9:16
        photos.sort(key=lambda p: _aspect_score(p.get("width", 0), p.get("height", 0), photos.index(p)))
        chosen = None
        for ph in photos:
            srcs = ph.get("src") or {}
            chosen = srcs.get("portrait") or srcs.get("large2x") or srcs.get("original")
            if chosen:
                break
        if not chosen:
            raise asset_fetch_failed("assets", "pexels no src")
        # Map domain to safe hostname (avoid SSRF to private IPs)
        from urllib.parse import urlparse

        host = urlparse(chosen).hostname or ""
        if host not in {"images.pexels.com", "www.pexels.com", "static.pexels.com"}:
            log.warn("pexels unexpected host, using generated", host=host)
            chosen = None
        if not chosen:
            return GeneratedVisual(self.w, self.h).fetch(query, out_path, prompt, seed)
        try:
            raw = get_bytes(chosen, {}, timeout=30)
        except Exception as e:
            raise asset_fetch_failed("assets", f"pexels download: {e}") from e
        if len(raw) < 256:
            raise asset_invalid("assets", f"pexels too small ({len(raw)}B)")
        # Validate by extension->MIME guess; reject HTML
        if raw[:5].lstrip().lower().startswith(b"<!doct") or b"<html" in raw[:512].lower():
            raise asset_invalid("assets", "pexels returned HTML")
        out_path.write_bytes(raw)
        return out_path


def _aspect_score(w: int, h: int, idx: int) -> float:
    if w <= 0 or h <= 0:
        return 1e9
    ratio = w / h  # portrait ~0.5625
    return abs(ratio - 0.5625) * 100 + idx * 0.01


class VisualProvider:
    """Facade: pexels if configured, else generated. Caching handled upstream (assets.py)."""

    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.w = int(cfg.get("video.width", 720))
        self.h = int(cfg.get("video.height", 1280))
        self._pexels = None
        key = os.environ.get("PEXELS_API_KEY") or cfg.get("providers.pexels_key")
        if key:
            self._pexels = PexelsVisual(key, self.w, self.h)
        self._generated = GeneratedVisual(self.w, self.h)

    def fetch(self, query: str, out_path: Path, prompt: str = "", seed: int = 0, allow_web: bool = True) -> Path:
        if self._pexels and allow_web:
            try:
                return self._pexels.fetch(query, out_path, prompt, seed)
            except Exception as e:
                log.warn("pexels failed, falling back to generated", error=str(e)[:120])
        return self._generated.fetch(query, out_path, prompt, seed)


def get_visual(cfg: Config) -> VisualProvider:
    return VisualProvider(cfg)