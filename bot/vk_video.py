#!/usr/bin/env python3
"""Публикация длинного видео (16:9) в VK.

Основной путь (нативное VK Видео): video.save → multipart video_file →
video.get → wall.post attachment video{owner_id}_{id}. Требует USER access token.

Fallback (групповой токен, всегда доступен): docs.getWallUploadServer(type=video)
→ upload → docs.save → wall.post attachment doc{owner_id}_{id} — видео-документ
на стене сообщества.

Env: VK_VIDEO_TOKEN (user, опционально), VK_TOKEN (group, для wall.post/fallback),
VK_GROUP_ID.
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
    """Опубликовать mp4 в VK, вернуть attachment.

    `video{owner}_{id}` — нативное VK Видео (нужен user-токен),
    `doc{owner}_{id}` — fallback видео-документ на стене (групповой токен).

    Делегирует bot.vk_clips.upload_short_to_vk (нативный путь + fallback);
    при ImportError — собственный video.save, затем fallback на документ.
    """
    if not os.path.isfile(file_path):
        raise FileNotFoundError(file_path)
    video_token = (
        token or os.environ.get("VK_VIDEO_TOKEN") or os.environ.get("VK_TOKEN") or ""
    ).strip()
    if not video_token:
        raise ValueError(
            "Не задан ни VK_VIDEO_TOKEN, ни VK_TOKEN — VK-публикация невозможна"
        )
    group_id = int(
        group_id
        or os.environ.get("VK_GROUP_ID")
        or os.environ.get("VK_GROUP_ID_MAIN")
        or 0
    )
    if not group_id:
        raise ValueError("VK_GROUP_ID not set")

    # Общий модуль: нативный video.save (user) либо fallback на документ (group)
    try:
        from bot.vk_clips import upload_short_to_vk

        return upload_short_to_vk(
            file_path, token=token, group_id=group_id, caption=title or "Видео"
        )
    except ImportError:
        pass

    session = requests.Session()

    # Fallback при отказе video.save (например, групповой токен)
    def _doc_fallback() -> str:
        from bot.vk_clips import upload_video_as_wall_document

        wall_token = (os.environ.get("VK_TOKEN") or "").strip() or video_token
        att = upload_video_as_wall_document(
            file_path, wall_token, group_id, caption=title or "", title=title or ""
        )
        print(
            f"VK: video.save недоступен (нужен USER access token) — "
            f"использован fallback: {att}",
            file=sys.stderr,
        )
        return att

    if not (token or os.environ.get("VK_VIDEO_TOKEN")):
        return _doc_fallback()

    save = _call(
        session,
        "video.save",
        video_token,
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
        video_token,
        owner_id=-group_id,
        count=1,
    )
    items = (lst or {}).get("items") or []
    if not items:
        lst = _call(
            session,
            "video.get",
            video_token,
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

    msg = title or "Видео"
    wall_token = (os.environ.get("VK_TOKEN") or "").strip() or video_token
    from_group = 1 if os.environ.get("VK_TOKEN") else 0
    _call(
        session,
        "wall.post",
        wall_token,
        owner_id=-group_id,
        from_group=from_group,
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
