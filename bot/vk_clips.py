#!/usr/bin/env python3
"""Публикация короткого (вертикального) видео в VK.

Два пути (основной → fallback):
1. НАТИВНЫЙ КЛИП/ВИДЕО: video.save → multipart video_file → video.get →
   wall.post attachment video{owner_id}_{id}. Требует USER access token.
2. FALLBACK (групповой токен, всегда доступен): docs.getWallUploadServer(type=video)
   → multipart file → docs.save → wall.post attachment doc{owner_id}_{id}.
   Видео попадает на стену сообщества как видео-документ (проигрывается в посте).

ВАЖНО про токены (диагностика 2026-09-23, live run 35902369680):
- video.save ОТВЕРГАЕТ групповой токен (error 5 "invalid token type") —
  нужен USER access token (администратора сообщества) → env VK_VIDEO_TOKEN.
- wall.post (из группы, from_group=1) и docs.getWallUploadServer работают
  с групповым VK_TOKEN.
- Если VK_VIDEO_TOKEN не задан или video.save отверг токен — автоматически
  используется fallback через документ (пайплайн не падает).

Env: VK_VIDEO_TOKEN (user, опционально — для нативного video.save),
VK_TOKEN (group, для wall.post и fallback), VK_GROUP_ID.
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


def upload_video_as_wall_document(
    file_path: str,
    token: str,
    group_id: int,
    caption: str = "",
    title: str = "",
) -> str:
    """Fallback: загрузить mp4 на стену сообщества как видео-документ.

    Работает с ГРУППОВЫМ токеном (в отличие от video.save):
    docs.getWallUploadServer(type=video) → upload file → docs.save → wall.post.
    Возвращает attachment `doc{owner_id}_{id}`.
    """
    if not os.path.isfile(file_path):
        raise FileNotFoundError(file_path)
    session = requests.Session()

    # docs.getWallUploadServer принимает не все type для community-токена:
    # type=video → error 100 "invalid type" (проверено live run 35903790383),
    # рабочий вариант — type=doc (файл приходит как видео-документ).
    candidates = [("video", "video_file"), ("doc", "file")]
    last_err: Exception | None = None
    uploaded: str | None = None
    for doc_type, field in candidates:
        try:
            upload_info = _call(
                session,
                "docs.getWallUploadServer",
                token,
                group_id=group_id,
                type=doc_type,
            )
            upload_url = upload_info.get("upload_url")
            if not upload_url:
                raise RuntimeError(
                    f"VK docs.getWallUploadServer without upload_url: {upload_info}"
                )
            with open(file_path, "rb") as fh:
                r = session.post(
                    upload_url,
                    files={field: (os.path.basename(file_path), fh, "video/mp4")},
                    timeout=600,
                )
            r.raise_for_status()
            ur = r.json()
            if ur.get("error"):
                raise RuntimeError(f"VK docs upload error: {ur['error']}")
            uploaded = ur.get("file")
            if not uploaded:
                raise RuntimeError(f"VK docs upload returned empty file: {ur}")
            break
        except Exception as e:  # noqa: BLE001 — пробуем следующий кандидат
            last_err = e
            uploaded = None
    if not uploaded:
        raise RuntimeError(f"VK wall document upload failed: {last_err}")

    doc_title = (title or caption or os.path.basename(file_path)).strip()[:200]
    try:
        saved = _call(
            session,
            "docs.save",
            token,
            file=uploaded,
            group_id=group_id,
            title=doc_title,
        )
    except RuntimeError as e:
        # error 15 «group messages are disabled» — docs.save без group_id.
        if "error_code': 15" not in str(e) and "error_code': 15 " not in str(e):
            raise
        saved = _call(session, "docs.save", token, file=uploaded, title=doc_title)

    saved = saved[0] if isinstance(saved, list) else saved
    doc = (saved or {}).get("doc") or saved or {}
    if not doc.get("id"):
        raise RuntimeError(f"VK docs.save returned no doc: {saved}")

    attachment = f"doc{doc['owner_id']}_{doc['id']}"
    _call(
        session,
        "wall.post",
        token,
        owner_id=-group_id,
        from_group=1,
        message=caption or "",
        attachments=attachment,
    )
    return attachment


def upload_short_to_vk(
    file_path: str,
    token: str | None = None,
    group_id: int | None = None,
    caption: str = "",
) -> str:
    """Опубликовать mp4 в VK, вернуть attachment.

    Возвращает `video{owner}_{id}` при нативной загрузке (нужен user-токен)
    или `doc{owner}_{id}` при fallback через групповой токен.

    Token resolution:
    - native video.save/video.get: VK_VIDEO_TOKEN (USER access token) —
      групповой токен даёт error 5 "invalid token type", тогда срабатывает
      автоматический fallback upload_video_as_wall_document (работает на VK_TOKEN).
    - wall.post: VK_TOKEN (групповой, from_group=1); если его нет —
      используется VK_VIDEO_TOKEN без from_group.
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

    session = requests.Session()

    # 0) Нет user-токена → сразу fallback на групповой (video.save заведомо
    #    отвергнет групповой токен, не тратим вызов).
    if not (token or os.environ.get("VK_VIDEO_TOKEN")):
        return upload_video_as_wall_document(
            file_path, wall_token, group_id, caption=caption, title=os.path.basename(file_path)
        )

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
            # user-токен фактически групповой → fallback на документ
            att = upload_video_as_wall_document(
                file_path,
                wall_token,
                group_id,
                caption=caption,
                title=os.path.basename(file_path),
            )
            print(
                f"VK: video.save отверг токен (нужен USER access token) — "
                f"использован fallback: {att}",
                file=sys.stderr,
            )
            return att
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
