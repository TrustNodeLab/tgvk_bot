# -*- coding: utf-8 -*-
"""
HTTP-сервис TrustNode: рендер карточек (PIL + Exo2/Jura + небо Екатеринбурга)
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
    POST /render  — JSON: {headline, caption, cards, tier, source, link,
                           format?: "png"|"gif", frames?: 12} -> PNG либо анимированный GIF
    POST /llm     — JSON: {text, prev_post?, style?, best_posts?} -> структурированный JSON GigaChat
    POST /opinion — JSON: {text} -> {"opinion": "1-2 предложения мнения редакции"}
    POST /mix     — JSON: {count, window?, date?} -> {"format": "single|digest|poll", "reason"}
    POST /poll    — JSON: {text} -> {"question", "options": ["..."]}
    POST /critique — JSON: {draft} -> {"issues": [...], "fixed_caption": "..."}
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
from card_generator import render_card, render_card_gif  # noqa: E402
from llm import extract_post_data, extract_digest, extract_opinion, extract_critique, extract_mix, extract_poll  # noqa: E402

PORT = int(os.environ.get("PORT", "8000"))
YEAR = datetime.now().year

TIER_META = {
    "news": ("НОВОСТИ", "КИБЕРБЕЗОПАСНОСТЬ"),
    "real_threat": ("РЕАЛЬНАЯ УГРОЗА", "КИБЕРБЕЗОПАСНОСТЬ"),
    "medium": ("СРЕДНИЙ РИСК", "КИБЕРБЕЗОПАСНОСТЬ"),
    "safe": ("ПРОФИЛАКТИКА", "КИБЕРБЕЗОПАСНОСТЬ"),
}
DEFAULT_QUOTE = "Не спешите переводить деньги незнакомцам — проверяйте информацию."


def _ekb_now():
    return datetime.utcnow() + timedelta(hours=5)


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
        "quote": str(payload["quote"]) if "quote" in payload else DEFAULT_QUOTE,
        "source": f"TrustNode · {YEAR}",
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
        if self.path == "/digest":
            self._handle_digest()
            return
        if self.path == "/opinion":
            self._handle_opinion()
            return
        if self.path == "/critique":
            self._handle_critique()
            return
        if self.path == "/mix":
            self._handle_mix()
            return
        if self.path == "/poll":
            self._handle_poll()
            return
        if self.path != "/render":
            self._send(404, json.dumps({"error": "not found"}).encode("utf-8"))
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            data = map_data(payload)
            fmt = str(payload.get("format") or "png").lower()
            if fmt not in ("png", "gif"):
                fmt = "png"
            if fmt == "gif":
                frames = int(payload.get("frames") or 12)
                out = os.path.join(tempfile.gettempdir(), "trustnode_card.gif")
                render_card_gif(data, out, dt_ekb=_ekb_now(), frames=frames)
                with open(out, "rb") as f:
                    body = f.read()
                self._send(200, body, "image/gif")
            else:
                out = os.path.join(tempfile.gettempdir(), "trustnode_card.png")
                render_card(data, out, dt_ekb=_ekb_now())
                with open(out, "rb") as f:
                    body = f.read()
                self._send(200, body, "image/png")
        except Exception as e:  # noqa: BLE001
            self._send(500, json.dumps({"error": str(e)}).encode("utf-8"))

    def _handle_llm(self):
        """Прокси к LLM: Worker не может сам ходить в GigaChat (CA Сбера),
        поэтому текст поста генерится здесь, в Python-контуре с сертификатом НУЦ.
        provider: "gigachat" | "gemini" — выбирает модель; по умолчанию LLM_PROVIDER env."""
        if not (os.environ.get("LLM_API_KEY") or os.environ.get("GIGACHAT_API_KEY") or os.environ.get("GEMINI_API_KEY")):
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
            provider = str(payload.get("provider") or "").strip() or None
            style = str(payload.get("style") or "").strip() or None
            best = str(payload.get("best_posts") or "").strip() or None
            result = extract_post_data(text, prev, provider, style, best)
            self._send(200, json.dumps(result, ensure_ascii=False).encode("utf-8"))
        except KeyError as e:
            self._send(503, json.dumps({"error": f"нет секрета: {e}"}).encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send(500, json.dumps({"error": str(e)}).encode("utf-8"))

    def _handle_digest(self):
        """Собирает дайджест из списка новостей: {items: [{title, text, link}]},
        provider: "gigachat"|"gemini". Возвращает {headline, bullets, advice}."""
        if not (os.environ.get("LLM_API_KEY") or os.environ.get("GIGACHAT_API_KEY") or os.environ.get("GEMINI_API_KEY")):
            self._send(503, json.dumps({"error": "LLM_API_KEY не задан"}).encode("utf-8"))
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            items = payload.get("items") or []
            if not isinstance(items, list) or not items:
                self._send(400, json.dumps({"error": "пустой items"}).encode("utf-8"))
                return
            provider = str(payload.get("provider") or "").strip() or None
            result = extract_digest(items, provider)
            self._send(200, json.dumps(result, ensure_ascii=False).encode("utf-8"))
        except KeyError as e:
            self._send(503, json.dumps({"error": f"нет секрета: {e}"}).encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send(500, json.dumps({"error": str(e)}).encode("utf-8"))

    def _handle_opinion(self):
        """«Мнение студии»: лёгкий вызов LLM по тексту новости -> {opinion: "..."
        }. Используется правиловым генератором вместо шаблонного мнения."""
        if not (os.environ.get("LLM_API_KEY") or os.environ.get("GIGACHAT_API_KEY") or os.environ.get("GEMINI_API_KEY")):
            self._send(503, json.dumps({"error": "LLM_API_KEY не задан"}).encode("utf-8"))
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            text = str(payload.get("text") or "").strip()
            if not text:
                self._send(400, json.dumps({"error": "пустой text"}).encode("utf-8"))
                return
            provider = str(payload.get("provider") or "").strip() or None
            opinion = extract_opinion(text, provider)
            self._send(200, json.dumps({"opinion": opinion}, ensure_ascii=False).encode("utf-8"))
        except KeyError as e:
            self._send(503, json.dumps({"error": f"нет секрета: {e}"}).encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send(500, json.dumps({"error": str(e)}).encode("utf-8"))

    def _handle_critique(self):
        """Самокритика черновика поста: {draft} -> {issues, fixed_caption}.
        Строгий второй проход LLM перед публикацией, чтобы вычистить клише."""
        if not (os.environ.get("LLM_API_KEY") or os.environ.get("GIGACHAT_API_KEY") or os.environ.get("GEMINI_API_KEY")):
            self._send(503, json.dumps({"error": "LLM_API_KEY не задан"}).encode("utf-8"))
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            draft = str(payload.get("draft") or "").strip()
            if not draft:
                self._send(400, json.dumps({"error": "пустой draft"}).encode("utf-8"))
                return
            provider = str(payload.get("provider") or "").strip() or None
            result = extract_critique(draft, provider)
            self._send(200, json.dumps(result, ensure_ascii=False).encode("utf-8"))
        except KeyError as e:
            self._send(503, json.dumps({"error": f"нет секрета: {e}"}).encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send(500, json.dumps({"error": str(e)}).encode("utf-8"))

    def _handle_mix(self):
        """Решение формата окна (single/digest/poll): {count, window, date} ->
        {format, reason}. Фолбэк на правила при недоступности LLM."""
        if not (os.environ.get("LLM_API_KEY") or os.environ.get("GIGACHAT_API_KEY") or os.environ.get("GEMINI_API_KEY")):
            self._send(503, json.dumps({"error": "LLM_API_KEY не задан"}).encode("utf-8"))
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            count = int(payload.get("count") or 0)
            window = str(payload.get("window") or "").strip() or None
            date = str(payload.get("date") or "").strip() or None
            provider = str(payload.get("provider") or "").strip() or None
            result = extract_mix(count, window, date, provider)
            self._send(200, json.dumps(result, ensure_ascii=False).encode("utf-8"))
        except KeyError as e:
            self._send(503, json.dumps({"error": f"нет секрета: {e}"}).encode("utf-8"))
        except Exception as e:  # noqa: BLE001
            self._send(500, json.dumps({"error": str(e)}).encode("utf-8"))

    def _handle_poll(self):
        """Вопрос+варианты опроса по тексту новости: {text} -> {question, options}."""
        if not (os.environ.get("LLM_API_KEY") or os.environ.get("GIGACHAT_API_KEY") or os.environ.get("GEMINI_API_KEY")):
            self._send(503, json.dumps({"error": "LLM_API_KEY не задан"}).encode("utf-8"))
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            text = str(payload.get("text") or "").strip()
            if not text:
                self._send(400, json.dumps({"error": "пустой text"}).encode("utf-8"))
                return
            provider = str(payload.get("provider") or "").strip() or None
            result = extract_poll(text, provider)
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