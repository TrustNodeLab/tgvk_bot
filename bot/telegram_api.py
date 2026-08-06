"""Минимальная обёртка над Telegram Bot API (без сторонних SDK, только requests)."""
import requests

API = "https://api.telegram.org/bot{token}/{method}"


class TelegramAPI:
    def __init__(self, token: str):
        self.token = token

    def _call(self, method: str, **params):
        files = params.pop("files", None)
        url = API.format(token=self.token, method=method)
        r = requests.post(url, data=params, files=files, timeout=30)
        try:
            data = r.json()
        except ValueError:
            data = {}
        if r.status_code >= 400:
            # Telegram кладёт настоящую причину в JSON-поле description
            desc = data.get("description") or r.text
            raise RuntimeError(f"Telegram API error on {method}: {desc}")
        if not data.get("ok"):
            raise RuntimeError(f"Telegram API error on {method}: {data}")
        return data["result"]

    def get_updates(self, offset: int = None, timeout: int = 0):
        params = {"timeout": timeout}
        if offset is not None:
            params["offset"] = offset
        return self._call("getUpdates", **params)

    def send_message(self, chat_id, text, reply_markup=None, parse_mode=None):
        params = {"chat_id": chat_id, "text": text}
        if reply_markup:
            params["reply_markup"] = reply_markup
        if parse_mode:
            params["parse_mode"] = parse_mode
        return self._call("sendMessage", **params)

    def send_photo(self, chat_id, photo_path, caption=None, reply_markup=None, parse_mode=None):
        with open(photo_path, "rb") as f:
            params = {"chat_id": chat_id}
            if caption:
                params["caption"] = caption
            if reply_markup:
                params["reply_markup"] = reply_markup
            if parse_mode:
                params["parse_mode"] = parse_mode
            return self._call("sendPhoto", files={"photo": f}, **params)

    def edit_message_caption(self, chat_id, message_id, caption=None, reply_markup=None):
        params = {"chat_id": chat_id, "message_id": message_id}
        if caption is not None:
            params["caption"] = caption
        if reply_markup is not None:
            params["reply_markup"] = reply_markup
        return self._call("editMessageCaption", **params)

    def edit_message_text(self, chat_id, message_id, text, reply_markup=None, parse_mode=None):
        params = {"chat_id": chat_id, "message_id": message_id, "text": text}
        if reply_markup is not None:
            params["reply_markup"] = reply_markup
        if parse_mode:
            params["parse_mode"] = parse_mode
        return self._call("editMessageText", **params)

    def answer_callback_query(self, callback_query_id, text=None):
        params = {"callback_query_id": callback_query_id}
        if text:
            params["text"] = text
        return self._call("answerCallbackQuery", **params)

    def edit_message_reply_markup(self, chat_id, message_id, reply_markup=None):
        params = {"chat_id": chat_id, "message_id": message_id}
        if reply_markup is not None:
            params["reply_markup"] = reply_markup
        return self._call("editMessageReplyMarkup", **params)


def inline_keyboard(buttons):
    """buttons: список списков [(text, callback_data), ...] -> JSON для reply_markup"""
    import json
    kb = [[{"text": t, "callback_data": cd} for t, cd in row] for row in buttons]
    return json.dumps({"inline_keyboard": kb})


def reply_keyboard(buttons):
    """buttons: список списков строк -> JSON для ReplyKeyboardMarkup (обычные кнопки).
    Обычные кнопки не шлют callback_query (который не влезает в лимит webhook),
    а присылают текст кнопки обычным сообщением — безопасно для нашей схемы."""
    import json
    kb = [[{"text": t} for t in row] for row in buttons]
    return json.dumps({"keyboard": kb, "resize_keyboard": True})


def hide_keyboard():
    import json
    return json.dumps({"hide_keyboard": True})
