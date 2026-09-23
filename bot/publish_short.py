#!/usr/bin/env python3
"""Агрегатор публикации короткого видео: VK Клипы → TikTok.

Собирает результаты по каждой площадке, НЕ падает при ошибке одной.
Env: VK_TOKEN, VK_GROUP_ID, TIKTOK_ACCESS_TOKEN.
CLI: python bot/publish_short.py <mp4> [caption]
"""
from __future__ import annotations

import sys


def publish_short(file_path: str, caption: str = "") -> dict:
    """Публикует mp4 в VK Клипы и TikTok. Возвращает {'vk':..., 'tiktok':...}."""
    results: dict = {"vk": None, "tiktok": None, "errors": []}

    try:
        from bot.vk_clips import upload_short_to_vk

        results["vk"] = upload_short_to_vk(file_path, caption=caption)
    except Exception as e:  # noqa: BLE001
        results["errors"].append(f"vk: {e}")

    try:
        from bot.tiktok_post import post_video

        results["tiktok"] = post_video(file_path, caption=caption)
    except Exception as e:  # noqa: BLE001
        results["errors"].append(f"tiktok: {e}")

    return results


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(
            "usage: python bot/publish_short.py <mp4> [caption]",
            file=sys.stderr,
        )
        return 2
    caption = argv[2] if len(argv) > 2 else ""
    res = publish_short(argv[1], caption)
    print(res)
    # exit 0, если хотя бы одна площадка приняла (или обе упали с понятной
    # причиной отсутствия кредов — workflow continue-on-error всё равно)
    if res["vk"] or res["tiktok"] or res["errors"]:
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
