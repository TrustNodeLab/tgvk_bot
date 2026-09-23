#!/usr/bin/env python3
"""Загрузка длинного видео (16:9) в VK Видео (не клип).

video.save → multipart video_file → wall.post attachment video{owner}_{id}.
Если доступен bot.vk_clips — использует его upload (общий path),
иначе собственный video.save fallback.

Env: VK_TOKEN, VK_GROUP_ID.
CLI: python bot/vk_video.py <mp4> [title]
"""
from __future__ import annotations

import os
import sys

import requests

VK_API_VERSION = "5.199"
VK_BASE = "https://api.vk.com/method/"


def _call(session: requests.Session, method: str, token: str, **params):
    params["access_token"] = token
    params["v"] = VK_API_VERSION
    r = session.post(VK_BASE + method, data=params, timeout=30)
    r.raise_for_status()
    data = r.json()
    if "error" in data:
        raise RuntimeError(f"VK API error on {method}: {data['error']}")
    return data["response"]


def publish_long_to_vk_video(
    file_path: str,
    token: str | None = None,
    group_id: int | None = None,
    title: str = "",
) -> str:
    """Загрузить mp4 → VK Видео, вернуть attachment `video{owner}_{id}`.

    Сначала пробует bot.vk_clips.upload_short_to_vk (если есть) — общий path.
    Fallback: собственный video.save + upload + wall.post.
    """
    if not os.path.isfile(file_path):
        raise FileNotFoundError(file_path)
    token = (token or os.environ.get("VK_TOKEN") or "").strip()
    if not token:
        raise ValueError("VK_TOKEN not set")
    group_id = int(
        group_id
        or os.environ.get("VK_GROUP_ID")
        or os.environ.get("VK_GROUP_ID_MAIN")
        or 0
    )
    if not group_id:
        raise ValueError("VK_GROUP_ID not set")

    # Предпочитаем общий модуль, если он уже есть
    try:
        from bot.vk_clips import upload_short_to_vk  # noqa: F401

        return upload_short_to_vk(
            file_path, token=token, group_id=group_id, caption=title or "🎬"
        )
    except ImportError:
        pass

    # Fallback: собственный путь
    size = os.path.getsize(file_path)
    session = requests.Session()
    save = _call(
        session,
        "video.save",
        token,
        group_id=group_id,
        name=title or os.path.basename(file_path),
        wallpost=1,
        is_private=0,
    )
    upload_url = save.get("upload_url")
    if not upload_url:
        raise RuntimeError(f"VK video.save without upload_url: {save}")

    with open(file_path, "rb") as fh:
        r = session.post(
            upload_url,
            files={"video_file": (os.path.basename(file_path), fh, "video/mp4")},
            timeout=600,
        )
    r.raise_for_status()
    ur = r.json()
    if ur.get("error"):
        raise RuntimeError(f"VK video upload error: {ur['error']}")

    lst = _call(
        session,
        "video.get",
        token,
        owner_id=-group_id,
        count=1,
    )
    items = (lst or {}).get("items") or []
    if not items:
        lst = _call(
            session,
            "video.get",
            token,
            owner_id=-group_id,
            count=5,
        )
        items = (lst or {}).get("items") or []
    if not items:
        raise RuntimeError("VK video.get returned empty after upload")

    vid = items[0]
    owner = vid.get("owner_id", -group_id)
    video_id = vid.get("id")
    attachment = f"video{owner}_{video_id}"

    msg = title or "🎬"
    _call(
        session,
        "wall.post",
        token,
        owner_id=-group_id,
        from_group=1,
        message=msg,
        attachments=attachment,
    )
    return attachment


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(
            "usage: python bot/vk_video.py <mp4> [title]",
            file=sys.stderr,
        )
        return 2
    try:
        att = publish_long_to_vk_video(
            argv[1], title=argv[2] if len(argv) > 2 else ""
        )
        print(f"OK {att}")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"ERR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
