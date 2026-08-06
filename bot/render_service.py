# -*- coding: utf-8 -*-
"""
HTTP-сервис TrustNode: рендер карточек (PIL + Exo2/Jura + небо Москвы)
и прокси к GigaChat для генерации текстов постов.

Позволяет Worker'у получать красивые карточки и настоящие LLM-тексты без
GitHub: Worker шлёт сюда JSON с данными поста, сервис возвращает PNG либо
структурированный JSON от GigaChat. Стандартная библиотека — Pillow, requests,
certifi и urllib3 (см. requirements.txt), поэтому легко деплоится на любой
хостинг (Render free, локально и т.п.).

Запуск локально:
    python render_service.py           # слушает 0.0.0.0:8000 (или PORT)
Проверка:
    curl -X POST localhost:8000/render -H "Content-Type: application/json" -d @sample.json -o card.png

Эндпоинты:
    POST /render  — JSON: {headline, caption, cards, tier, source, link} -> PNG
    POST /llm     — JSON: {text, prev_post?} -> структурированный JSON GigaChat
    GET  /health  — {"ok": true}
"""
import json
import os
import sys
import tempfile
import threading
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from card_generator import render_card  # noqa: E402
from llm import extract_post_data  # noqa: E402

PORT = int(os.environ.get("PORT", "8000"))
YEAR = datetime.now().year

TIER_META = {
    "news": ("НОВОСТИ", "КИБЕРБЕЗОПАСНОСТЬ"),
    "real_threat": ("РЕАЛЬНАЯ УГРОЗА", "КИБЕРБЕЗОПАСНОСТЬ"),
    "medium": ("СРЕДНИЙ РИСК", "КИБЕРБЕЗОПАСНОСТЬ"),
    "safe": ("ПРОФИЛАКТИКА", "КИБЕРБЕЗОПАСНОСТЬ"),
}
DEFAULT_QUOTE = "Не спешите переводить деньги незнакомцам — проверяйте информацию."


def _msk_now():
    return datetime.utcnow() + timedelta(hours=3)


def map_data(payload: dict) -> dict:
    """Из формата Worker (headline — строка, cards с type) в схему render_card."""
    tier = payload.get("tier", "news")
    if tier not in TIER_META:
        tier = "news"
    category, tag = TIER_META[tier]

    cards = []
    for c in payload.get("cards", [])[:6]:
        ctype = c.get("type", "stat")
        card = {"type": ctype}
        card["number"] = str(c.get("number", ""))
        card["label"] = str(c.get("label", ""))
        card["desc"] = str(c.get("desc", ""))
        card["before"] = str(c.get("before", ""))
        card["after"] = str(c.get("after", ""))
        card["items"] = [str(i) for i in (c.get("items") or [])[:4]]
        cards.append(card)
    if not cards:
        cards = [{"type": "stat", "number": "—", "label": "информация", "desc": str(payload.get("caption", ""))[:200]}]

    headline_raw = payload.get("headline")
    if isinstance(headline_raw, list):
        headline_lines = [str(h).strip() for h in headline_raw[:3] if str(h).strip()]
    else:
        headline_lines = [str(headline_raw or "Кибербезопасность: главное")]
    if not headline_lines:
        headline_lines = ["Кибербезопасность: главное"]

    return {
        "tags": [tag],
        "category": category,
        "headline": headline_lines,
        "tier": tier,
        "cards": cards,
        "quote": str(payload.get("quote") or DEFAULT_QUOTE),
        "source": f"TrustNode · {YEAR}",
        "links": ["t.me/TrustNode_team", "vk.com/trustnode"],
        "site": "trustnodelab.github.io",
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, code, body=b"", ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, json.dumps({"ok": True, "pid": os.getpid()}).encode("utf-8"))
        else:
            self._send(404, json.dumps({"error": "not found"}).encode("utf-8"))

    def do_POST(self):
        if self.path == "/llm":
            self._handle_llm()
            return
        if self.path != "/render":
            self._send(404, json.dumps({"error": "not found"}).encode("utf-8"))
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            data = map_data(payload)
            out = os.path.join(tempfile.gettempdir(), "trustnode_card.png")
            render_card(data, out, dt_msk=_msk_now())
            with open(out, "rb") as f:
                png = f.read()
            self._send(200, png, "image/png")
        except Exception as e:  # noqa: BLE001
            self._send(500, json.dumps({"error": str(e)}).encode("utf-8"))

    def _handle_llm(self):
        """Прокси к GigaChat: Worker не может сам ходить в GigaChat (CA Сбера),
        поэтому текст поста генерится здесь, в Python-контуре с сертификатом НУЦ."""
        if not os.environ.get("LLM_API_KEY"):
            self._send(503, json.dumps({"error": "LLM_API_KEY не задан"}).encode("utf-8"))
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            text = str(payload.get("text") or "").strip()
            if not text:
                self._send(400, json.dumps({"error": "пустой text"}).encode("utf-8"))
                return
            prev = payload.get("prev_post")
            result = extract_post_data(text, prev)
            self._send(200, json.dumps(result, ensure_ascii=False).encode("utf-8"))
        except KeyError as e:
            self._send(503, json.dumps({"error": f"нет секрета: {e}"}).encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send(500, json.dumps({"error": str(e)}).encode("utf-8"))


def main():
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[render-service] listening on 0.0.0.0:{PORT}", file=sys.stderr)
    srv.serve_forever()


if __name__ == "__main__":
    main()
