# -*- coding: utf-8 -*-
"""
HTTP-сервис рендера карточек TrustNode (PIL + Exo2/Jura + реальное небо Москвы).

Позволяет Worker'у получать красивые карточки без GitHub: Worker шлёт сюда
JSON с данными поста, сервис возвращает PNG. Стандартная библиотека — только
Pillow и requests (см. requirements.txt), поэтому легко деплоится на любой
хостинг (Render free, локально и т.п.).

Запуск локально:
    python render_service.py           # слушает 0.0.0.0:8000 (или PORT)
Проверка:
    curl -X POST localhost:8000/render -H "Content-Type: application/json" -d @sample.json -o card.png

Эндпоинты:
    POST /render  — JSON: {headline, caption, cards, tier, source, link} -> PNG
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

    headline = str(payload.get("headline") or "Кибербезопасность: главное")
    return {
        "tags": [tag],
        "category": category,
        "headline": [headline],
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


def main():
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[render-service] listening on 0.0.0.0:{PORT}", file=sys.stderr)
    srv.serve_forever()


if __name__ == "__main__":
    main()
