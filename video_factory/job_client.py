"""Client for the Worker job API (HMAC-protected callback).

Callback: POST {worker_url}/api/video/callback
Headers: X-VF-Signature: sha256=<hex>, X-VF-Timestamp: <unix>
Signature = HMAC-SHA256(f"{timestamp}.{body}", secret)
Replay protection: Worker rejects timestamp older than 300s.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import urllib.request

from .config import Config


def send_callback(cfg: Config, job_id: str, status: str, progress: int | None = None, error: str | None = None, output: dict | None = None) -> bool:
    secret = os.environ.get("JOB_CALLBACK_SECRET") or cfg.get("callback.secret")
    worker_url = os.environ.get("BOT_WORKER_URL") or cfg.get("storage.worker_url")
    if not secret or not worker_url:
        print("[callback] missing JOB_CALLBACK_SECRET or BOT_WORKER_URL", file=os.sys.stderr)
        return False
    body = json.dumps({"job_id": job_id, "status": status, "progress": progress, "error": error, "output": output}, ensure_ascii=False).encode()
    ts = int(time.time())
    sig = hmac.new(secret.encode(), f"{ts}.".encode() + body, hashlib.sha256).hexdigest()
    req = urllib.request.Request(
        f"{worker_url.rstrip('/')}/api/video/callback",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "X-VF-Signature": sig, "X-VF-Timestamp": str(ts)},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status in (200, 202)
    except Exception as e:
        print(f"[callback] error: {e}", file=os.sys.stderr)
        return False


def fetch_job(cfg: Config, job_id: str) -> dict | None:
    """GH Actions fetches job payload from Worker."""
    worker_url = os.environ.get("BOT_WORKER_URL") or cfg.get("storage.worker_url")
    token = os.environ.get("BOT_WORKER_TOKEN") or cfg.get("storage.token")
    if not worker_url or not token:
        return None
    import urllib.request

    req = urllib.request.Request(f"{worker_url.rstrip('/')}/api/video/{job_id}", headers={"X-Bot-Auth": token})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as e:
        print(f"[fetch] error fetching job {job_id}: {e}", file=os.sys.stderr)
        return None