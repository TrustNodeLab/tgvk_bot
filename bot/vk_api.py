"""Публикация поста с картинкой на стену сообщества VK через VK API (wall.post)."""
import os
import sys
import time

import requests

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

    def _upload_image(self, upload_url, image_path, field):
        """POST картинки на upload-сервер VK. Возвращает JSON-ответ сервера
        (server/photo|photos_list/hash). Если сервер отклонил файл, поля пустые."""
        with open(image_path, "rb") as f:
            r = self.session.post(
                upload_url,
                files={field: ("photo.png", f, "image/png")},
                timeout=60,
            )
        r.raise_for_status()
        return r.json()

    def _upload_messages_photo(self, image_path):
        # Групповой токен VK не может звать photos.getWallUploadServer (error 27).
        # Обходной путь: загружаем фото как «сообщение сообщества» через
        # photos.getMessagesUploadServer + photos.saveMessagesPhoto — эти методы
        # доступны групповым токенам (нужны scopes photos/messages/offline).
        upload_info = self._call("photos.getMessagesUploadServer")
        result = self._upload_image(upload_info["upload_url"], image_path, "photo")
        if not result.get("photo"):
            raise RuntimeError(f"VK: upload-сервер сообщений вернул пустой photo: {result}")
        saved = self._call(
            "photos.saveMessagesPhoto",
            photo=result["photo"],
            server=result["server"],
            hash=result["hash"],
        )
        photo = saved[0]
        return f"photo{photo['owner_id']}_{photo['id']}"

    def _upload_album_photo(self, image_path):
        # Путь «альбом сообщества» (фото там постоянное, не теряется из поста):
        # photos.getUploadServer(album_id, group_id) + photos.save.
        # Требует прав photos у токена; для группового токена VK вернёт error 27
        # на getUploadServer — в этом случае вызывающий код откатывается на путь
        # «сообщение сообщества» выше.
        upload_info = self._call(
            "photos.getUploadServer",
            album_id=self.album_id,
            group_id=self.group_id,
        )
        result = self._upload_image(upload_info["upload_url"], image_path, "file1")
        if not result.get("photos_list"):
            raise RuntimeError(f"VK: album upload-сервер вернул пустой photos_list: {result}")
        saved = self._call(
            "photos.save",
            album_id=self.album_id,
            group_id=self.group_id,
            server=result["server"],
            photos_list=result["photos_list"],
            hash=result["hash"],
        )
        photo = saved[0]
        return f"photo{photo['owner_id']}_{photo['id']}"

    def _upload_wall_photo(self, image_path) -> str:
        if not os.path.exists(image_path):
            raise FileNotFoundError(image_path)
        # Задан альбом → сначала грузим в него. Если токен не может (error 27
        # для группового токена) или альбом сломан — молча откатываемся дальше.
        if self.album_id:
            try:
                return self._upload_album_photo(image_path)
            except Exception as e:
                print(f"[vk] album upload failed ({e}); falling back to messages photo",
                      file=sys.stderr)
        # Основной путь с ретраями на транзиентные отказы upload-сервера.
        last_err = None
        for attempt in range(MAX_ATTEMPTS):
            try:
                return self._upload_messages_photo(image_path)
            except Exception as e:
                last_err = e
                if attempt < MAX_ATTEMPTS - 1:
                    time.sleep(RETRY_DELAY * (attempt + 1))
        raise RuntimeError(
            f"VK: не удалось загрузить фото после {MAX_ATTEMPTS} попыток: {last_err}"
        )

    def post_to_wall(self, image_path: str, message: str) -> dict:
        attachment = self._upload_wall_photo(image_path)
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