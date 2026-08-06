"""
Автономный поиск кандидатов на пост: сканирует RSS-ленты новостных сайтов,
фильтрует по ключевым словам темы (мошенничество/кибербезопасность), докачивает
текст статьи для передачи в LLM. Список фидов и ключевых слов — в config/sources.json,
чтобы Михаил мог редактировать без изменения кода.
"""
import json
import os
import re
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import xml.etree.ElementTree as ET
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "..", "config", "sources.json")

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; TrustNodeBot/1.0)"}

# Посты должны быть про актуальные события — новости старше MAX_AGE_DELTA не берём.
MAX_AGE_DELTA = timedelta(days=2)


def _load_config() -> dict:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def sources_info() -> dict:
    """Сводка по настройке поиска (для статус-команды бота)."""
    cfg = _load_config()
    return {
        "feeds": cfg.get("feeds", []),
        "keywords": cfg.get("keywords", []),
    }


def _matches_keywords(text: str, keywords: list) -> bool:
    low = text.lower()
    return any(kw.lower() in low for kw in keywords)


def _parse_feed(xml_text: str) -> list:
    items = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return items
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        guid = (item.findtext("guid") or link or title).strip()
        desc = (item.findtext("description") or "").strip()
        pub_date = _parse_pubdate(item.findtext("pubDate") or item.findtext("dc:date"))
        if title and link:
            items.append({"guid": guid, "title": title, "link": link,
                          "description": desc, "pub_date": pub_date})
    return items


def _parse_pubdate(raw: str):
    """Парсит pubDate RSS (RFC 2822 или ISO 8601). Возвращает tz-aware datetime
    или None, если дата отсутствует/не распарсилась (тогда запись не фильтруем)."""
    if not raw:
        return None
    raw = raw.strip()
    try:
        dt = parsedate_to_datetime(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt
        except Exception:
            return None


_CODE_HINTS = ("function", "window.", "document.", "=>", "var ", "counter", "topmailru",
               "yandex", "liveinternet", "advad", "adblock", "script", "push({")


def _looks_like_code(text: str) -> bool:
    """Отсекает <p>-абзацы с inline-JS/аналитикой (часто встречаются у новостных
    сайтов, например у Коммерсанта) — это не текст статьи, а мусор для LLM."""
    if "{" in text and "}" in text:
        return True
    low = text.lower()
    return any(h in low for h in _CODE_HINTS)


def _decode(raw: bytes) -> str:
    """Декодирует тело HTTP-ответа в юникод. Многие русские RSS-ленты не отдают
    charset в заголовке Content-Type, и requests по умолчанию принимает latin-1 —
    из-за этого windows-1251 ленты превращаются в «кракозябры». Пробуем UTF-8,
    затем windows-1251."""
    if not raw:
        return ""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("cp1251", errors="replace")


def _fetch_article_excerpt(url: str, max_chars: int = 2500) -> str:
    """Простое извлечение текста статьи без тяжёлых зависимостей: title + <p>-абзацы."""
    try:
        r = requests.get(url, headers=HEADERS, timeout=15)
        r.raise_for_status()
        html = _decode(r.content)
    except Exception:
        return ""

    paragraphs = re.findall(r"<p[^>]*>(.*?)</p>", html, re.DOTALL | re.IGNORECASE)
    text_parts = []
    for p in paragraphs:
        clean = re.sub(r"<[^>]+>", " ", p)
        clean = re.sub(r"\s+", " ", clean).strip()
        if len(clean) > 40 and not _looks_like_code(clean):
            # отсекаем короткие служебные абзацы (меню, копирайты) и JS-блоки
            text_parts.append(clean)
        if sum(len(t) for t in text_parts) > max_chars:
            break
    return " ".join(text_parts)[:max_chars]


def find_candidates(seen_guids: set, max_items: int = 1) -> list:
    """Возвращает до max_items новых кандидатов: [{"guid","title","link","text"}]."""
    config = _load_config()
    feeds = config.get("feeds", [])
    keywords = config.get("keywords", [])
    exclude_keywords = config.get("exclude_keywords", [])

    candidates = []
    now = datetime.now(timezone.utc)
    for feed_url in feeds:
        try:
            r = requests.get(feed_url, headers=HEADERS, timeout=15)
            r.raise_for_status()
        except Exception:
            continue
        for item in _parse_feed(_decode(r.content)):
            if item["guid"] in seen_guids:
                continue
            # актуальность: новости не старше MAX_AGE_DELTA (нет pubDate — пропускаем)
            pd = item.get("pub_date")
            if pd is None or now - pd > MAX_AGE_DELTA:
                continue
            haystack = item["title"] + " " + item["description"]
            if not _matches_keywords(haystack, keywords):
                continue
            # жёсткий стоп-фильтр: тема не про потребительское мошенничество
            # (коррупция/чиновники, военные преступления, насилие и т.п.) —
            # отбрасываем, даже если позитивный keyword совпал
            if _matches_keywords(haystack, exclude_keywords):
                continue
            candidates.append(item)

    # берём самые свежие первыми в порядке следования лент; ограничиваем количество за цикл,
    # чтобы не заваливать Михаила черновиками и не жечь бесплатную квоту LLM за один проход
    result = []
    for c in candidates[:max_items]:
        excerpt = _fetch_article_excerpt(c["link"])
        text = f"{c['title']}\n\n{excerpt or c['description']}\n\nИсточник: {c['link']}"
        result.append({"guid": c["guid"], "title": c["title"], "link": c["link"], "text": text})
    return result
