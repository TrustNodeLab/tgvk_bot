#!/usr/bin/env python3
"""TikTok Content Posting API — прямой загрузка MP4.

Env: TIKTOK_ACCESS_TOKEN (Bearer, scope video.publish).
Flow: /v2/post/publish/video/init/ (FILE_UPLOAD) → PUT upload_url
→ /v2/post/publish/status/fetch/ до publish_id done/failed.

Если токена нет — ValueError с подсказкой (не падает при импорте).
CLI: python bot/tiktok_post.py <mp4> [caption]
"""
from __future__ import annotations

import os
import sys
import time

import requests

TIKTOK_INIT = (
    "https://open.tiktokapis.com/v2/post/publish/video/init/"
)
TIKTOK_STATUS = (
    "https://open.tiktokapis.com/v2/post/publish/status/fetch/"
)
CHUNK = 10 * 1024 * 1024  # 10MB


def _headers(token: str) -> dict:
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json; charset=UTF-8",
    }


def post_video(
    file_path: str,
    caption: str = "",
    access_token: str | None = None,
) -> str:
    """Загрузить mp4 в TikTok (Direct Post или private draft).

    Возвращает publish_id. Без токена — ValueError.
    """
    if not os.path.isfile(file_path):
        raise FileNotFoundError(file_path)
    token = (access_token or os.environ.get("TIKTOK_ACCESS_TOKEN") or "").strip()
    if not token:
        raise ValueError(
            "TIKTOK_ACCESS_TOKEN not set — TikTok Content Posting API "
            "требует OAuth access_token со scope video.publish"
        )

    size = os.path.getsize(file_path)
    session = requests.Session()
    title = (caption or os.path.basename(file_path))[:2200]

    # 1) init
    init_body = {
        "post_info": {
            "title": title,
            # unaudited app → только SELF_ONLY; публичный пост после аудита
            "privacy_level": os.environ.get(
                "TIKTOK_PRIVACY_LEVEL", "SELF_ONLY"
            ),
            "disable_duet": False,
            "disable_comment": False,
            "disable_stitch": False,
        },
        "source_info": {
            "source_info_type": "FILE_UPLOAD",
            "video_size": size,
            "chunk_size": CHUNK,
            "total_chunk_count": max(1, (size + CHUNK - 1) // CHUNK),
        },
    }
    r = session.post(TIKTOK_INIT, headers=_headers(token), json=init_body, timeout=60)
    r.raise_for_status()
    data = r.json().get("data") or {}
    upload_url = data.get("upload_url")
    publish_id = data.get("publish_id")
    if not upload_url or not publish_id:
        raise RuntimeError(f"TikTok init failed: {r.text[:500]}")

    # 2) chunked PUT upload
    with open(file_path, "rb") as fh:
        offset = 0
        index = 0
        while True:
            chunk = fh.read(CHUNK)
            if not chunk:
                break
            end = offset + len(chunk) - 1
            headers = {
                "Content-Range": f"bytes {offset}-{end}/{size}",
                "Content-Length": str(len(chunk)),
                "Content-Type": "video/mp4",
            }
            up = session.put(upload_url, data=chunk, headers=headers, timeout=300)
            up.raise_for_status()
            offset += len(chunk)
            index += 1
            print(f"[tiktok] chunk {index} ok ({end + 1}/{size})")

    # 3) status poll
    status_body = {"publish_id": publish_id}
    for _ in range(30):
        time.sleep(3)
        sr = session.post(
            TIKTOK_STATUS, headers=_headers(token), json=status_body, timeout=30
        )
        sr.raise_for_status()
        sd = sr.json().get("data") or {}
        status = (sd.get("status") or "").upper()
        if status in ("PUBLISH_COMPLETE", "SEND_TO_USER_INBOX_COMPLETE", "DONE"):
            print(f"[tiktok] published {publish_id}")
            return publish_id
        if status in ("FAILED", "SEND_TO_USER_INBOX_FAILED"):
            raise RuntimeError(f"TikTok publish failed: {sd}")
    print(f"[tiktok] status poll timeout for {publish_id}")
    return publish_id


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(
            "usage: python bot/tiktok_post.py <mp4> [caption]",
            file=sys.stderr,
        )
        return 2
    try:
        pid = post_video(
            argv[1], caption=argv[2] if len(argv) > 2 else ""
        )
        print(f"OK {pid}")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"ERR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
