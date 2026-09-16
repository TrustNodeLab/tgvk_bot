"""Content-addressed cache.

All external artifacts (LLM script JSON, TTS audio, fetched images) are cached
on disk by SHA256 of the input. This is the primary cost-control mechanism:
cache > web > local > generated image > generated video.

Layout: <cache_dir>/<namespace>/<sha256>.<ext>
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any


def sha256_hex(*parts: str) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update((p or "").encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()


class Cache:
    def __init__(self, root: Path | str, namespace: str = "default"):
        self.root = Path(root)
        self.ns = self.root / namespace
        self.ns.mkdir(parents=True, exist_ok=True)

    def _path(self, digest: str, ext: str) -> Path:
        return self.ns / f"{digest}.{ext}"

    def get(self, digest: str, ext: str) -> Path | None:
        p = self._path(digest, ext)
        return p if p.exists() and p.stat().st_size > 0 else None

    def put(self, digest: str, ext: str, data: bytes) -> Path:
        p = self._path(digest, ext)
        if not p.exists():
            tmp = p.with_suffix(p.suffix + ".tmp")
            tmp.write_bytes(data)
            tmp.rename(p)
        return p

    def put_path(self, digest: str, ext: str, src: Path) -> Path:
        p = self._path(digest, ext)
        if not p.exists():
            p.parent.mkdir(parents=True, exist_ok=True)
            src.rename(p) if src.parent == p.parent else None
            if not p.exists():
                import shutil
                shutil.copyfile(src, p)
        return p

    # --- JSON helpers ---
    def get_json(self, digest: str) -> Any | None:
        p = self._path(digest, "json")
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return None

    def put_json(self, digest: str, obj: Any) -> Path:
        p = self._path(digest, "json")
        if not p.exists():
            p.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
        return p

    def clear(self) -> None:
        for f in self.ns.iterdir():
            try:
                f.unlink()
            except OSError:
                pass