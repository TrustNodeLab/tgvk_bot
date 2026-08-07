"""Публикация поста с картинкой на стену сообщества VK через VK API (wall.post).

Групповой токен не может грузить фото на стену/в альбом (error 27 на
photos.save*), а загруженные как «сообщение сообщества» (photos.saveMessagesPhoto)
фото на стене НЕ рендерятся картинкой (пост выглядит как «только текст»).
Единственный рабочий путь для картинки на стене токеном сообщества — загрузить
карточку как GIF-документ через docs.getWallUploadServer + docs.save: VK рендерит
GIF-документ (doc, type=3) в посте встроенной картинкой.
"""
import os
import sys
import time

import requests
from PIL import Image

VK_API_VERSION = "5.199"
VK_BASE = "https://api.vk.com/method/"
# VK upload-сервер иногда транзиентно отклоняет валидную картинку и возвращает
# пустой photo (что даёт error_code 100 на следующем шаге сохранения). Повторяем
# попытку с новым upload_url — обычно первый же ретрай проходит.
MAX_ATTEMPTS = 3
RETRY_DELAY = 2  # секунды, с прогрессией (2, 4)


class VKAPI:
    def __init__(self, token: str, group_id: int, album_id: int = None,
                 card_url_base: str = None):
        self.token = token
        self.group_id = int(group_id)  # положительное число id сообщества
        # Опц. альбом сообщества для постоянного фото (см. README). Если задан,
        # сначала пробуем грузить в альбом, при любой ошибке откатываемся на
        # «сообщение сообщества» — так пост всегда уйдёт с картинкой.
        self.album_id = int(album_id) if album_id else None
        # Опц. «ссылка-карточка»: если задан публичный базовый URL, где лежат
        # карточки (например raw.githubusercontent или GitHub Pages), VK постит
        # ссылку на карточку вместо загрузки фото (групповой токен не может
        # грузить фото в альбом/на стену — error 27). См. README.
        self.card_url_base = (card_url_base or "").rstrip("/") or None
        self.session = requests.Session()

    def _call(self, method, **params):
        params["access_token"] = self.token
        params["v"] = VK_API_VERSION
        r = self.session.post(VK_BASE + method, data=params, timeout=30)
        r.raise_for_status()
        data = r.json()
        if "error" in data:
            raise RuntimeError(f"VK API error on {method}: {data['error']}")
        return data["response"]

    @staticmethod
    def _png_to_gif(png_path: str, gif_path: str) -> None:
        """Конвертация карточки PNG → GIF через PIL. VK рендерит GIF-документ в
        посте встроенной картинкой, а PNG-документ показывает файлом-иконкой.
        PIL-квантование до 256 цветов (как у проверенного эталона mmsiscsar155.gif)."""
        img = Image.open(png_path).convert("RGB")
        img.save(gif_path, format="GIF", save_all=False, optimize=False)

    def _upload_wall_gif(self, image_path: str) -> str:
        """Главный путь публикации картинки на стену токеном сообщества:
        PNG → GIF → docs.getWallUploadServer → docs.save → doc{owner}_{id}.
        Возвращает attachment `doc{owner}_{id}` (VK рендерит его картинкой)."""
        if not os.path.exists(image_path):
            raise FileNotFoundError(image_path)
        gif_path = image_path.rsplit(".", 1)[0] + ".gif"
        try:
            self._png_to_gif(image_path, gif_path)
        except Exception as e:
            raise RuntimeError(f"VK: не удалось сконвертировать карточку в GIF: {e}")

        last_err = None
        for attempt in range(MAX_ATTEMPTS):
            try:
                upload_info = self._call("docs.getWallUploadServer", group_id=self.group_id)
                upload_url = upload_info["upload_url"]
                with open(gif_path, "rb") as f:
                    r = self.session.post(
                        upload_url,
                        files={"file": ("card.gif", f, "image/gif")},
                        timeout=60,
                    )
                r.raise_for_status()
                ur = r.json()
                if not ur.get("file"):
                    raise RuntimeError(f"VK: docs upload вернул пустой file: {ur}")
                saved = self._call("docs.save", file=ur["file"])
                saved = saved[0] if isinstance(saved, list) else saved
                doc = (saved or {}).get("doc") or saved or {}
                if not doc.get("id"):
                    raise RuntimeError(f"VK: docs.save вернул без doc: {saved}")
                return f"doc{doc['owner_id']}_{doc['id']}"
            except Exception as e:
                last_err = e
                if attempt < MAX_ATTEMPTS - 1:
                    time.sleep(RETRY_DELAY * (attempt + 1))
        raise RuntimeError(
            f"VK: не удалось загрузить GIF после {MAX_ATTEMPTS} попыток: {last_err}"
        )

    def post_to_wall(self, image_path: str, message: str) -> dict:
        attachment = self._upload_wall_gif(image_path)
        return self._call(
            "wall.post",
            owner_id=-self.group_id,  # отрицательный owner_id = сообщество
            from_group=1,
            message=message,
            attachments=attachment,
        )

    def post_to_wall_text(self, message: str) -> dict:
        return self._call(
            "wall.post",
            owner_id=-self.group_id,
            from_group=1,
            message=message,
        )

    def post_card(self, message: str, card_url: str) -> dict:
        """Пост, где карточка показана ссылкой-карточкой VK: передаём прямую ссылку
        на PNG во attachments — VK сам подтянет превью изображения. Обход для
        группового токена, которому запрещена загрузка фото в альбом/на стену."""
        return self._call(
            "wall.post",
            owner_id=-self.group_id,
            from_group=1,
            message=message,
            attachments=card_url,
        )