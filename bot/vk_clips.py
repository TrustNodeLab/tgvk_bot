#!/usr/bin/env python3
"""Загрузка короткого (вертикального) видео в VK Клипы / на стену как clip.

video.save (group) → multipart upload video_file → wall.post attachment
video{owner_id}_{id} (или clip-режим, если API поддерживает).

ВАЖНО про токены (диагностика 2026-09-23, run 35902369680):
- video.save ОТВЕРГАЕТ групповой токен (error 5 "invalid token type") —
  нужен USER access token (администратора сообщества) → env VK_VIDEO_TOKEN.
- wall.post (из группы, from_group=1) работает с групповым VK_TOKEN.

Env: VK_VIDEO_TOKEN (user, для video.save), VK_TOKEN (group, для wall.post),
VK_GROUP_ID.
CLI: python bot/vk_clips.py <mp4> [caption]
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


def upload_short_to_vk(
    file_path: str,
    token: str | None = None,
    group_id: int | None = None,
    caption: str = "",
) -> str:
    """Загрузить mp4 → VK, вернуть attachment `video{owner}_{id}`.

    Для клипса wall.post с attachment=video... рендерится как клип/превью
    на стене сообщества. Если group_id не задан — берётся env VK_GROUP_ID.

    Token resolution:
    - video.save/video.get: VK_VIDEO_TOKEN (USER access token — обязателен,
      групповой токен даёт error 5 "invalid token type").
    - wall.post: VK_TOKEN (групповой, работает с from_group=1); если его нет —
      используется VK_VIDEO_TOKEN без from_group.
    """
    if not os.path.isfile(file_path):
        raise FileNotFoundError(file_path)
    video_token = (
        token or os.environ.get("VK_VIDEO_TOKEN") or os.environ.get("VK_TOKEN") or ""
    ).strip()
    if not video_token:
        raise ValueError(
            "VK_VIDEO_TOKEN not set — video.save требует USER access token "
            "(групповой VK_TOKEN даёт error 5 'invalid token type')"
        )
    wall_token = (os.environ.get("VK_TOKEN") or "").strip() or video_token
    from_group = 1 if os.environ.get("VK_TOKEN") else 0
    group_id = int(
        group_id
        or os.environ.get("VK_GROUP_ID")
        or os.environ.get("VK_GROUP_ID_MAIN")
        or 0
    )
    if not group_id:
        raise ValueError("VK_GROUP_ID not set")

    size = os.path.getsize(file_path)
    session = requests.Session()
    # 1) video.save — получаем upload_url
    try:
        save = _call(
            session,
            "video.save",
            video_token,
            group_id=group_id,
            name=os.path.basename(file_path),
            wallpost=1,
            is_private=0,
            privacy_view="all",
            privacy_edit="all",
        )
    except RuntimeError as e:
        if "invalid token type" in str(e):
            raise RuntimeError(
                f"{e} — video.save принимает только USER access token. "
                "Создайте user-токен и задайте GH secret VK_VIDEO_TOKEN "
                "(см. инструкцию в отчёте)."
            ) from e
        raise
    upload_url = save.get("upload_url")
    if not upload_url:
        raise RuntimeError(f"VK video.save without upload_url: {save}")

    # 2) multipart upload
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

    # 3) upload уже завершён upload_url → get id; wall.post attachment
    # В большинстве случаев video.save+upload сразу создаёт видео.
    # Ищем свежее видео, чтобы получить id.
    lst = _call(
        session,
        "video.get",
        video_token,
        owner_id=-group_id,
        count=1,
    )
    items = (lst or {}).get("items") or []
    if not items:
        # запасной путь: upload_url мог не зарегистрировать — повторный get
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

    # 4) wall.post с клипом (если caption пустой — хотя бы точка)
    msg = caption or "🎬"
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
        print("usage: python bot/vk_clips.py <mp4> [caption]", file=sys.stderr)
        return 2
    try:
        att = upload_short_to_vk(argv[1], caption=argv[2] if len(argv) > 2 else "")
        print(f"OK {att}")
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"ERR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
