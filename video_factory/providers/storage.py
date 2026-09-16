"""Storage provider: local / R2 (via Worker /files) / Telegram.

Interface:
  - save(name, data: bytes, content_type) -> StorageRef {url, provider}
  - save_file(name, path, content_type) -> StorageRef
  - exists(name) -> bool
"""

from __future__ import annotations

import mimetypes
import os
from dataclasses import dataclass
from pathlib import Path

from ..config import Config
from ..errors import upload_failed
from ..logging import get_logger

log = get_logger("vf.storage")


@dataclass
class StorageRef:
    url: str
    provider: str
    key: str = ""


class LocalStorage:
    def __init__(self, base_dir: Path | str = "out/uploads"):
        self.base = Path(base_dir)
        self.base.mkdir(parents=True, exist_ok=True)

    def save_file(self, name: str, path: Path, content_type: str = "video/mp4") -> StorageRef:
        dest = self.base / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        import shutil

        shutil.copyfile(path, dest)
        return StorageRef(url=dest.resolve().as_uri(), provider="local", key=str(dest.resolve()))

    def exists(self, name: str) -> bool:
        return (self.base / name).exists()


class R2Storage:
    """Uploads through the Worker's /files endpoint (BOT_R2 binding or KV fallback)."""

    def __init__(self, worker_url: str, token: str):
        self.worker_url = worker_url.rstrip("/")
        self.token = token

    def _put(self, name: str, data: bytes, content_type: str) -> None:
        import urllib.error
        import urllib.request

        url = f"{self.worker_url}/files/{name}"
        req = urllib.request.Request(url, data=data, method="PUT", headers={"X-Bot-Auth": self.token, "Content-Type": content_type})
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                if resp.status not in (200, 201):
                    raise upload_failed("upload", f"R2 PUT {resp.status}")
        except urllib.error.HTTPError as e:
            raise upload_failed("upload", f"R2 PUT HTTP {e.code}") from e
        except urllib.error.URLError as e:
            raise upload_failed("upload", f"R2 PUT url error: {e.reason}") from e

    def save_file(self, name: str, path: Path, content_type: str = "video/mp4") -> StorageRef:
        self._put(name, path.read_bytes(), content_type)
        return StorageRef(url=f"{self.worker_url}/files/{name}", provider="r2", key=f"files/{name}")

    def exists(self, name: str) -> bool:
        from ._http import _request

        try:
            _, status = _request(f"{self.worker_url}/files/{name}", "GET", None, {"X-Bot-Auth": self.token}, timeout=30)
            return status == 200
        except Exception:
            return False


class TelegramStorage:
    """Sends video straight to a Telegram chat (primary delivery)."""

    def __init__(self, bot_token: str, chat_id: str):
        self.token = bot_token
        self.chat_id = chat_id

    def save_file(self, name: str, path: Path, content_type: str = "video/mp4") -> StorageRef:
        import urllib.request

        # Multipart upload via urllib (no external deps)
        boundary = "----vf" + os.urandom(8).hex()
        parts = []
        for key, val in [("chat_id", self.chat_id)]:
            parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{val}\r\n".encode())
        filename = Path(name).name
        fname_field = filename.replace('"', "")
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"video\"; filename=\"{fname_field}\"\r\nContent-Type: {content_type}\r\n\r\n".encode())
        parts.append(path.read_bytes())
        parts.append(f"\r\n--{boundary}--\r\n".encode())
        body = b"".join(parts)
        url = f"https://api.telegram.org/bot{self.token}/sendVideo"
        req = urllib.request.Request(url, data=body, method="POST", headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                if resp.status != 200:
                    raise upload_failed("upload", f"TG sendVideo {resp.status}")
        except Exception as e:
            raise upload_failed("upload", f"TG sendVideo: {e}") from e
        return StorageRef(url=f"tg://sendVideo/{filename}", provider="telegram", key=filename)

    def exists(self, name: str) -> bool:
        return False  # telegram can't be queried reliably


class StorageProvider:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._impl = self._build()

    def _build(self):
        p = self.cfg.get("storage", {})
        kind = (os.environ.get("STORAGE_TYPE") or p.get("type") or "local").lower()
        worker_url = os.environ.get("BOT_WORKER_URL") or p.get("worker_url")
        token = os.environ.get("BOT_WORKER_TOKEN") or p.get("token")
        if kind == "r2" and worker_url and token:
            return R2Storage(worker_url, token)
        bot_token = os.environ.get("TELEGRAM_BOT_TOKEN")
        chat_id = os.environ.get("TELEGRAM_CHANNEL_ID") or os.environ.get("TELEGRAM_ADMIN_CHAT_ID")
        if kind == "telegram" and bot_token and chat_id:
            return TelegramStorage(bot_token, chat_id)
        return LocalStorage(self.cfg.get("storage.local_dir", "out/uploads"))

    def save_file(self, name: str, path: Path, content_type: str = "video/mp4") -> StorageRef:
        return self._impl.save_file(name, path, content_type)

    def exists(self, name: str) -> bool:
        return self._impl.exists(name)


def get_storage(cfg: Config) -> StorageProvider:
    return StorageProvider(cfg)