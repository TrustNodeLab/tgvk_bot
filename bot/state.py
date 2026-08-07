"""
Состояние бота между запусками.

Раньше хранилось как JSON-файлы прямо в репозитории и коммитилось GitHub Actions
(соответственно каждый запуск писал в git, что давало нагрузку и конфликты).

Фаза 1 миграции: теперь состояние живёт в Cloudflare — большая часть в KV
(state.json, черновики, история), PNG-файлы в R2. Python-бот обращается к ним
через REST-эндпоинты Cloudflare Worker (см. worker/worker.js, пути /kv и /files).

Включается переменными окружения BOT_WORKER_URL и BOT_WORKER_TOKEN. Если их нет —
работаем в прежнем файловом режиме (для локальной разработки/тестов).
"""
import json
import os
import shutil
import tempfile
import uuid

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "..", "data")
STATE_PATH = os.path.join(DATA_DIR, "state.json")
DRAFTS_DIR = os.path.join(DATA_DIR, "drafts")
HISTORY_DIR = os.path.join(DATA_DIR, "history")
MAX_HISTORY = 20

# --- remote-бэкенд (Cloudflare KV/R2 через Worker) ---
WORKER_URL = os.environ.get("BOT_WORKER_URL", "").strip().rstrip("/")
WORKER_TOKEN = os.environ.get("BOT_WORKER_TOKEN", "").strip()
REMOTE = bool(WORKER_URL and WORKER_TOKEN)

_REQ_TIMEOUT = 20


def _r2_upload(key, data, content_type="image/png"):
    try:
        requests.put(
            f"{WORKER_URL}/files/{key}", data=data,
            headers={"X-Bot-Auth": WORKER_TOKEN, "Content-Type": content_type},
            timeout=60)
    except requests.RequestException:
        pass


def _kv_get(key):
    try:
        r = requests.get(f"{WORKER_URL}/kv", params={"key": key},
                         headers={"X-Bot-Auth": WORKER_TOKEN}, timeout=_REQ_TIMEOUT)
        if r.status_code != 200:
            return None
        return r.json()
    except requests.RequestException:
        return None


def _kv_put(key, data):
    try:
        requests.put(f"{WORKER_URL}/kv", params={"key": key}, json=data,
                     headers={"X-Bot-Auth": WORKER_TOKEN}, timeout=_REQ_TIMEOUT)
    except requests.RequestException:
        pass


def _kv_delete(key):
    try:
        requests.delete(f"{WORKER_URL}/kv", params={"key": key},
                        headers={"X-Bot-Auth": WORKER_TOKEN}, timeout=_REQ_TIMEOUT)
    except requests.RequestException:
        pass


def _r2_download(key):
    try:
        r = requests.get(f"{WORKER_URL}/files/{key}", timeout=60)
        return r.content if r.status_code == 200 else None
    except requests.RequestException:
        return None


# ---------- состояние ----------

def load_state() -> dict:
    if REMOTE:
        s = _kv_get("state") or {}
        s.setdefault("seen_guids", [])
        return s
    if not os.path.exists(STATE_PATH):
        return {"last_update_id": 0, "seen_guids": []}
    with open(STATE_PATH, "r", encoding="utf-8") as f:
        state = json.load(f)
    state.setdefault("seen_guids", [])
    return state


MAX_SEEN_GUIDS = 1000


def autopost_enabled(state: dict) -> bool:
    """Автопостинг: при True бот сам публикует найденные новости в VK и TG-канал,
    без подтверждения админом. Хранится в отдельном KV-ключе autopost, чтобы
    перезапись state (воркером/ботом) не сбрасывала тумблер."""
    if REMOTE:
        v = _kv_get("autopost")
        if v is not None:
            return bool(v)
    return bool(state.get("autopost", False))


def set_autopost(state: dict, on: bool):
    state["autopost"] = bool(on)
    if REMOTE:
        _kv_put("autopost", bool(on))
    save_state(state)


def remember_guid(state: dict, guid: str):
    state["seen_guids"].append(guid)
    if len(state["seen_guids"]) > MAX_SEEN_GUIDS:
        state["seen_guids"] = state["seen_guids"][-MAX_SEEN_GUIDS:]


def save_state(state: dict):
    if REMOTE:
        _kv_put("state", state)
        return
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


# ---------- черновики ----------

def _upload_png(png_path: str, key: str):
    """Загружает PNG в R2; возвращает key или None, если файла нет/ошибка."""
    if not png_path or not os.path.exists(png_path):
        return None
    try:
        with open(png_path, "rb") as f:
            data = f.read()
    except OSError:
        return None
    _r2_upload(key, data)
    return key


def save_draft(draft_id: str, draft: dict):
    if REMOTE:
        png_key = _upload_png(draft.get("png_path"), f"drafts/{draft_id}.png")
        if png_key:
            draft["png_key"] = png_key
        _kv_put(f"draft:{draft_id}", draft)
        return
    os.makedirs(DRAFTS_DIR, exist_ok=True)
    path = os.path.join(DRAFTS_DIR, f"{draft_id}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(draft, f, ensure_ascii=False, indent=2)


def load_draft(draft_id: str) -> dict:
    if REMOTE:
        return _kv_get(f"draft:{draft_id}")
    path = os.path.join(DRAFTS_DIR, f"{draft_id}.json")
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def delete_draft(draft_id: str):
    if REMOTE:
        _kv_delete(f"draft:{draft_id}")
        return
    for ext in ("json", "png"):
        path = os.path.join(DRAFTS_DIR, f"{draft_id}.{ext}")
        if os.path.exists(path):
            os.remove(path)


def local_png(png_path, png_key=None):
    """Возвращает путь к PNG на диске для текущего рана. Если файл уже существует
    локально (этот же ран его рендерил) — используем его. Иначе (remote, более
    поздний ран: approve/history) качаем из R2 во временный файл."""
    if png_path and os.path.exists(png_path):
        return png_path
    if REMOTE and png_key:
        data = _r2_download(png_key)
        if not data:
            return None
        tmp = os.path.join(tempfile.gettempdir(), os.path.basename(png_key))
        with open(tmp, "wb") as f:
            f.write(data)
        return tmp
    return None


def upload_card(png_path: str, card_id: str):
    """Загружает готовую карточку в R2 cards/<id>.png (для VK link-card режима,
    когда VK_CARD_URL_BASE указывает на публичный URL Worker'а)."""
    _upload_png(png_path, f"cards/{card_id}.png")


# ---------- история постов ----------

_HISTORY_KEY = "history:all"


def _history_max(entries: list) -> list:
    return entries[:MAX_HISTORY]


def load_history() -> list:
    """Список опубликованных постов, новые сверху."""
    if REMOTE:
        return _kv_get(_HISTORY_KEY) or []
    if not os.path.exists(HISTORY_DIR):
        return []
    entries = []
    for name in os.listdir(HISTORY_DIR):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(HISTORY_DIR, name), "r", encoding="utf-8") as f:
                entries.append(json.load(f))
        except (ValueError, OSError):
            continue
    entries.sort(key=lambda e: e.get("published_at", ""), reverse=True)
    if len(entries) > MAX_HISTORY:
        for old in entries[MAX_HISTORY:]:
            for ext in ("json", "png"):
                p = os.path.join(HISTORY_DIR, f"{old['id']}.{ext}")
                if os.path.exists(p):
                    os.remove(p)
        entries = entries[:MAX_HISTORY]
    return entries


def get_history_entry(post_id: str) -> dict:
    if REMOTE:
        for e in _kv_get(_HISTORY_KEY) or []:
            if e.get("id") == post_id:
                return e
        return None
    path = os.path.join(HISTORY_DIR, f"{post_id}.json")
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_history(entry: dict):
    """Сохраняет опубликованный пост в историю (новый сверху)."""
    if REMOTE:
        entries = _kv_get(_HISTORY_KEY) or []
        entries = [e for e in entries if e.get("id") != entry.get("id")]
        entries.insert(0, entry)
        _kv_put(_HISTORY_KEY, entries[:MAX_HISTORY])
        return
    os.makedirs(HISTORY_DIR, exist_ok=True)
    path = os.path.join(HISTORY_DIR, f"{entry['id']}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(entry, f, ensure_ascii=False, indent=2)


def archive_draft(draft: dict):
    """Переносит опубликованный черновик в историю: сохраняет PNG (в remote —
    загружает в R2), пишет JSON с датой публикации. Возвращает id записи."""
    post_id = draft["id"] if "id" in draft else uuid.uuid4().hex[:10]
    png_key = None
    png = draft.get("png_path")
    if png and os.path.exists(png):
        if REMOTE:
            png_key = _upload_png(png, f"history/{post_id}.png")
        else:
            os.makedirs(HISTORY_DIR, exist_ok=True)
            shutil.copy2(png, os.path.join(HISTORY_DIR, f"{post_id}.png"))
    entry = {
        "id": post_id,
        "published_at": draft.get("published_at", ""),
        "caption": draft.get("caption", ""),
        "png_path": png or "",
        "png_key": png_key if REMOTE else None,
        "cards_summary": draft.get("cards_summary", ""),
    }
    save_history(entry)
    return post_id