"""
Дайджест-контур: полные тексты статей + рерайт через LLM + запуск видео-s workflow.

Модуль предоставляет API для сборки дайджеста и диспетчеризации
GitHub Actions workflow video-long.yml. В текущей версии bot/main.py нет
вызова dispatch_video_workflow() и Telegram-маршрута для запуска видео;
этот модуль намеренно не добавляет такой call site.

Дайджест и переписывание новостей также используются multigroups.py:
полный текст новости -> GigaChat рерайт -> длинный читаемый пост в VK
(вместо короткой RSS-выжимки).

REST-вызовы к GitHub требуют GH_PAT (PAT с scope workflow) в env.
"""
import html
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor

import requests

from llm import _complete
from long_profiles import DEFAULT_PROFILE, get_profile

REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; TrustNodeBot/1.1)",
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
}

GITHUB_REPO = "TrustNodeLab/tgvk_bot"
VIDEO_WORKFLOW = "video-long.yml"
ARTICLE_TEXT_MAX = 7000      # сколько символов статьи отдаём LLM
DIGEST_INPUT_MAX = 5000      # на одну статью в дайджест
FETCH_TIMEOUT = 12
FETCH_WORKERS = 5


# ---------- полный текст статьи ----------

def _extract_article_text(raw: str) -> str:
    """Из HTML вытаскивает «тело» статьи: убирает script/style/svg, режет на
    абзацы (p/div/article/h1-h3/li/blockquote), берёт только содержательные
    блоки (60+ символов), склеивает. Возвращает до ARTICLE_TEXT_MAX символов
    или None, если текста мало (<300 символов)."""
    raw = re.sub(r"(?is)<(script|style|svg|noscript|iframe)[^>]*>.*?</\1>", " ", raw)
    blocks = re.split(r"(?i)<(?:p|div|article|h1|h2|h3|h4|li|blockquote)[^>]*>", raw)
    out = []
    for b in blocks:
        s = re.sub(r"(?s)<[^>]+>", " ", b)
        s = html.unescape(re.sub(r"\s+", " ", s)).strip()
        if len(s) < 60:
            continue
        if re.match(r"^(cookie|subscribe|sign up|advert|нажмите|подпишись|реклам)", s, re.I):
            continue
        out.append(s)
    text = "\n".join(out)
    if len(text) < 300:
        return None
    return text[:ARTICLE_TEXT_MAX]


def fetch_full_article(url: str, timeout: int = FETCH_TIMEOUT):
    """Полный текст статьи по URL. Возвращает (title, text) или (None, None).
    title — из <title>; text — через _extract_article_text (может быть None,
    если статья короткая/закрыта антиботом)."""
    if not url or not url.startswith(("http://", "https://")):
        return None, None
    try:
        r = requests.get(url, headers=REQUEST_HEADERS, timeout=timeout)
        if r.status_code != 200:
            return None, None
        r.encoding = r.apparent_encoding or r.encoding
        raw = r.text
        m = re.search(r"(?is)<title[^>]*>(.*?)</title>", raw)
        title = html.unescape(m.group(1)).strip() if m else ""
        return title, _extract_article_text(raw)
    except Exception as e:
        print(f"[digest] fetch_full_article {url}: {e}")
        return None, None


def fetch_articles(urls: list) -> list:
    """Полные тексты для списка URL (параллельно). Возвращает список
    (title, text) в том же порядке; неудачные — (None, None)."""
    if not urls:
        return []
    results = [None] * len(urls)
    with ThreadPoolExecutor(max_workers=min(len(urls), FETCH_WORKERS)) as ex:
        futs = {ex.submit(fetch_full_article, u): i for i, u in enumerate(urls)}
        for f in futs:
            try:
                results[futs[f]] = f.result()
            except Exception:
                results[futs[f]] = (None, None)
    return results


# ---------- LLM: дайджест для видео ----------

def build_video_digest(items: list) -> dict:
    """Из 3-5 новостей (title + text + link) строит дайджест для видео.

    Возвращает {"topic": str, "from_post": str}.
      topic     — связная тема ролика (до ~500 символов), объединяющая новости.
      from_post — интригующее вступление сценария (до ~900 символов) по главной
                  новости; video-long.yml передаёт его в GigaChat на написание
                  полного сценария (LLM_PROVIDER: gigachat).
    При сбое LLM — эвристика: topic = перечисление заголовков, from_post =
    первый абзац первой статьи."""
    titles = [i.get("title", "") for i in items if i.get("title")]

    def _fallback():
        topic = "Дайджест: " + "; ".join(t[:80] for t in titles[:4])[:500]
        first_text = ""
        for i in items:
            if i.get("text"):
                first_text = i["text"][:900]
                break
        return {"topic": topic, "from_post": first_text or (titles[0][:400] if titles else "Дайджест новостей")}

    if not items:
        return _fallback()

    # Ограничиваем вход: обрезаем каждую статью, не перегружаем контекст.
    parts = []
    for idx, i in enumerate(items[:5], 1):
        t = i.get("text") or ""
        if len(t) > DIGEST_INPUT_MAX:
            t = t[:DIGEST_INPUT_MAX]
        parts.append(f"--- Новость {idx}: {i.get('title')}\n{t}")
    user = "\n\n".join(parts)
    if len(user) > 26000:
        user = user[:26000]

    try:
        raw = _complete([
            {
                "role": "system",
                "content": (
                    "Ты — редактор документального новостного видеоканала. Тебе дают "
                    "3-5 свежих новостей с полными текстами. Придумай для них ОДНО "
                    "связное видео: объедини новости общей темой (похожий контекст, "
                    "общий вывод или контраст). Верни СТРОГО JSON без пояснений:\n"
                    '{"topic":"тема видео — связный заголовок-анонс до 500 символов '
                    'на русском","from_post":"интригующее вступление сценария до 900 '
                    'символов на русском — зацепка по самой важной новости, без '
                    'канцелярита"}'
                ),
            },
            {"role": "user", "content": user},
        ])
        m = re.search(r"\{[\s\S]*\}", raw or "")
        if not m:
            return _fallback()
        parsed = json.loads(m.group(0))
        topic = str(parsed.get("topic") or "").strip()
        from_post = str(parsed.get("from_post") or "").strip()
        if len(topic) < 10 or len(from_post) < 30:
            return _fallback()
        return {"topic": topic, "from_post": from_post}
    except Exception as e:
        print(f"[digest] build_video_digest error: {e}")
        return _fallback()


def rewrite_news_full(text: str, title: str = "") -> str:
    """Полный рерайт новости живым русским языком: 3-5 абзацев, до ~2600
    символов. Возвращает переписанный текст (без заголовка) или пустую
    строку при сбое/слишком коротком результате."""
    try:
        raw = _complete([
            {
                "role": "system",
                "content": (
                    "Ты — редактор новостного паблика. Тебе дают ПОЛНЫЙ текст статьи. "
                    "Перепиши его живым русским языком, чтобы пост можно было читать "
                    "целиком, не открывая источник: 3-5 абзацев, до 2600 символов. "
                    "Сохрани все факты, цифры, имена и суть; убери воду, повторы и "
                    "рекламный тон. Без заголовка, без эмодзи, без «Подробнее» и "
                    "ссылок в конце. Верни только текст поста."
                ),
            },
            {"role": "user", "content": (f"Заголовок: {title}\n\n" if title else "") + text},
        ])
        out = (raw or "").strip()
        return out if len(out) >= 300 else ""
    except Exception as e:
        print(f"[digest] rewrite_news_full error: {e}")
        return ""


# ---------- запуск видео-воркфлоу ----------

def dispatch_video_workflow(topic: str = "", from_post: str = "", minutes: str = "15",
                            format: str = "doc", script: str = "",
                            profile: str = DEFAULT_PROFILE) -> bool:
    """Dispatch ``video-long.yml`` through the GitHub REST API.

    Returns ``True`` when GitHub accepts the dispatch (HTTP 200, 201, or 204).
    A missing token or a dispatch/HTTP/network failure raises ``RuntimeError``.

    ``profile`` is an optional editorial profile.  A blank or omitted value uses
    the compatible ``classic`` profile; an unknown explicit value is rejected
    before token lookup or any network request.  This is a dormant API: the
    current ``bot/main.py`` has no Telegram call site for this function.

    Token: ``GH_PAT`` in the environment (a PAT with the ``workflow`` scope).
    """
    # Validate explicit profile selection before touching credentials or the
    # network.  ``get_profile`` also supplies the canonical wire value.
    _, profile_key = get_profile(profile)
    pat = os.environ.get("GH_PAT", "").strip()
    if not pat:
        raise RuntimeError("GH_PAT не задан — не могу запустить сборку видео")
    body = {
        "ref": "main",
        "inputs": {
            "minutes": str(minutes),
            "format": format or "doc",
            "topic": topic or "",
            "script": script or "",
            "from_post": from_post or "",
            "profile": profile_key,
        },
    }
    url = f"https://api.github.com/repos/{GITHUB_REPO}/actions/workflows/{VIDEO_WORKFLOW}/dispatches"
    try:
        r = requests.post(
            url,
            json=body,
            headers={
                "Authorization": f"Bearer {pat}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
            timeout=25,
        )
    except Exception as e:
        raise RuntimeError(f"dispatch network error: {e}")
    if r.status_code not in (204, 200, 201):
        raise RuntimeError(f"dispatch failed: HTTP {r.status_code} {r.text[:200]}")
    return True