"""Мультигрупповая публикация в VK-группы DGC / LostLink / LostArt.

Python-порт worker/lib/multigroup.js для GitHub Actions контура (каждые 30 мин).

  DGC      — игровые новости (RU) из RSS-лент, текстовый пост на стену.
  LostLink — игровые новости (EN) из RSS-лент, адаптируются на русский LLM'ом.
  LostArt  — ИИ-арты из ТГ-каналов: скачиваем картинку, конвертируем в GIF и
             публикуем через docs.getWallUploadServer -> docs.save -> wall.post
             (единственный рабочий для группового токена способ показать
             картинку на стене — см. vk_api.py).

Очередь рана: сначала TrustNode (основной main.py), затем DGC -> LostArt ->
LostLink — у всех групп равные условия: каждая публикует 1 пост за слот.

Окна по 30 минут в ЕКБ (UTC+5). Повтор за слот предотвращается KV-ключом
`vk_posted:mg:<group>:<yyyymmdd>:<slot>`. Догонка: слот считается активным
ещё GRACE_MIN минут после конца окна, чтобы ран в :30 мог догнать пропущенный
слот :00.

Токены: VK_TOKEN_DGC / VK_TOKEN_LOSTLINK / VK_TOKEN_LOSTART (env / GH secrets).

Качество контента:
  - EN-новости переписываются живым русским языком (adapt_news_ru) + проход
    самокритики (critique_mg_text) через llm._complete (GigaChat/Gemini).
  - Семантический дедуп: похожая новость из разных лент постится один раз
    (Jaccard-похожесть нормализованных заголовков, порог MG_SIM_T).
  - Кандидаты с .jpg/.png/.gif URL приоритетнее .webp.
  - Картинки уменьшаются до maxSide и конвертируются в GIF через Pillow.
"""
import html
import io
import json
import os
import re
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
import xml.etree.ElementTree as ET

import requests
from PIL import Image

import state as st
from vk_api import VKAPI
from llm import _complete

# ---------- конфиг групп ----------

MULTI_GROUPS = [
    {
        "slug": "dgc",
        "name": "DGC",
        "groupId": 224546089,
        "token_key": "VK_TOKEN_DGC",
        "kind": "news",
        "lang": "ru",
        "footer": "DGC · игровые новости",
    },
    # LostArt перед LostLink — очередь tn -> dgc -> lostart -> lostlink
    {
        "slug": "lostart",
        "name": "LostArt",
        "groupId": 226242897,
        "token_key": "VK_TOKEN_LOSTART",
        "kind": "art",
        "lang": "en",
        "footer": "LostArt · ИИ-арты",
    },
    {
        "slug": "lostlink",
        "name": "LostLink",
        "groupId": 226087950,
        "token_key": "VK_TOKEN_LOSTLINK",
        "kind": "news",
        "lang": "en",
        "footer": "LostLink · игровые новости",
    },
]

# Окна в минутах от полуночи ЕКБ (каждое длится MULTI_WINDOW_LEN_MIN, 1 пост за слот).
MULTI_WINDOWS = {
    "dgc": [5 * 60, 10 * 60, 15 * 60, 20 * 60],
    "lostlink": [8 * 60, 11 * 60, 14 * 60, 17 * 60, 20 * 60],
    "lostart": [9 * 60, 12 * 60, 15 * 60, 18 * 60],
}
MULTI_WINDOW_LEN_MIN = 30
# Догонка: слот можно запостить ещё GRACE_MIN минут после конца окна
# (ран GH в :30 догоняет пропущенный слот :00).
GRACE_MIN = 90

# Ленты: RU — проверены живыми 2026-08-31; EN — polygon/vg247 заменены на
# gamespot/gamesradar/videogameschronicle (мертвы/протухли).
FEEDS_RU = [
    "https://www.playground.ru/rss/news.xml",
    "https://vgtimes.ru/news/rss.xml",
    "https://dtf.ru/rss/all",
    "https://igromania.ru/rss/news.xml",
]
FEEDS_EN = [
    "https://www.pcgamer.com/rss/",
    "https://www.eurogamer.net/feed/",
    "https://www.rockpapershotgun.com/feed/",
    "https://www.gamespot.com/feeds/news/",
    "https://www.gamesradar.com/rss/",
    "https://www.videogameschronicle.com/feed/",
]
MULTI_FEEDS = {"ru": FEEDS_RU, "en": FEEDS_EN}

# aiart исключён — стабильно отдаёт таймаут и тормозит рабочие каналы.
ART_CHANNELS = [
    "aiartcommunity",
    "neuralart",
    "promptart",
    "aipainting",
    "psychedelic_ai",
]

MG_CONFIG_KEY = "mg_config"
VK_POST_LIMIT = 3000
MAX_AGE_MS = 24 * 3600 * 1000
MG_SIM_T = 0.55  # порог Jaccard-похожести заголовков
TITLES_KEY = "mg_titles"
REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; TrustNodeBot/1.0)",
    "Accept": "*/*",
}


def _ekb_now() -> datetime:
    """Текущее время в ЕКБ (UTC+5)."""
    return datetime.utcnow() + timedelta(hours=5)


# ---------- KV (через worker REST, как state.py) ----------

def _kv_get(key):
    return st._kv_get(key)


def _kv_put(key, data):
    st._kv_put(key, data)


# ---------- конфиг (KV-оверрайд) ----------

def load_mg_config() -> dict:
    """Дефолтный конфиг, поверх которого мержится KV mg_config (если есть)."""
    cfg = {
        "windows": {k: list(v) for k, v in MULTI_WINDOWS.items()},
        "feeds": {"ru": list(FEEDS_RU), "en": list(FEEDS_EN)},
        "channels": list(ART_CHANNELS),
    }
    try:
        saved = _kv_get(MG_CONFIG_KEY)
        if not saved:
            return cfg
        if isinstance(saved.get("windows"), dict):
            for slug in ("dgc", "lostlink", "lostart"):
                vals = saved["windows"].get(slug)
                if isinstance(vals, list):
                    nums = [int(n) for n in vals if isinstance(n, (int, float)) and 0 <= n < 1440]
                    if nums:
                        cfg["windows"][slug] = nums
        if isinstance(saved.get("feeds"), dict):
            for lang in ("ru", "en"):
                urls = saved["feeds"].get(lang)
                if isinstance(urls, list):
                    ok = [u for u in urls if isinstance(u, str) and re.match(r"^https?://", u)]
                    if ok:
                        cfg["feeds"][lang] = ok
        if isinstance(saved.get("channels"), list):
            ok = [c for c in saved["channels"] if isinstance(c, str) and re.match(r"^[\w\d_]+$", c)]
            if ok:
                cfg["channels"] = ok
    except Exception as e:  # битый конфиг — работаем на дефолтах
        print(f"[multigroups] load_mg_config error: {e}")
    return cfg


# ---------- окна ----------

def active_multi_window(slug: str, now: datetime = None, windows: dict = None) -> int:
    """Активный слот группы (start окна ЕКБ) или None. С grace-догонкой:
    окно [start, start+LEN+GRACE), чтобы ран в :30 догонял пропущенный :00."""
    now = now or _ekb_now()
    mod = now.hour * 60 + now.minute
    for start in (windows or MULTI_WINDOWS).get(slug, []):
        if start <= mod < start + MULTI_WINDOW_LEN_MIN + GRACE_MIN:
            return start
    return None


# ---------- семантический дедуп заголовков ----------

def title_fingerprint(title: str) -> set:
    """Нормализованный набор слов: нижний регистр, без пунктуации,
    слова короче 4 символов выбрасываются."""
    words = re.sub(r"[^\w\s]", " ", str(title or "").lower()).split()
    return {w for w in words if len(w) >= 4}


def title_similarity(a: set, b: set) -> float:
    """Jaccard |A∩B| / |A∪B|."""
    if not a or not b:
        return 0.0
    inter = len(a & b)
    return inter / (len(a) + len(b) - inter)


def load_recent_titles() -> list:
    try:
        raw = _kv_get(TITLES_KEY)
        items = raw if isinstance(raw, list) else []
        cutoff = time.time() * 1000 - 48 * 3600 * 1000
        return [t for t in items if isinstance(t, dict) and t.get("ts", 0) > cutoff]
    except Exception:
        return []


def remember_title(fp: set):
    try:
        items = load_recent_titles()
        items.append({"fp": sorted(fp), "ts": int(time.time() * 1000)})
        _kv_put(TITLES_KEY, items[-120:])
    except Exception:
        pass


def is_duplicate_title(title: str) -> bool:
    fp = title_fingerprint(title)
    for r in load_recent_titles():
        if title_similarity(fp, set(r.get("fp") or [])) >= MG_SIM_T:
            return True
    return False


# ---------- guid-дедуп (KV-список, list-API воркера недоступен) ----------

_GUID_LIMIT = 500


def load_used_guids(slug: str) -> set:
    try:
        raw = _kv_get(f"mg_guids:{slug}")
        return set(raw or [])
    except Exception:
        return set()


def remember_guid(slug: str, guid: str):
    try:
        used = load_used_guids(slug)
        used.add(guid)
        _kv_put(f"mg_guids:{slug}", list(used)[-_GUID_LIMIT:])
    except Exception:
        pass


# ---------- RSS ----------

def _parse_pubdate(s: str):
    if not s:
        return None
    try:
        dt = parsedate_to_datetime(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        try:
            return datetime.fromisoformat(str(s).strip())
        except Exception:
            return None


def _clean_title(s: str) -> str:
    """Чистит заголовок: убирает хвосты «— Источник: https://…» и висячие тире."""
    t = (s or "").strip()
    t = re.sub(r"\s*(?:[—–-]\s*)?источник\s*:\s*https?://\S+\s*$", "", t, flags=re.I).strip()
    t = re.sub(r"\s*[—–-]+\s*$", "", t).strip()
    return t


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _group1(m) -> str:
    return m.group(1) if m else ""


def parse_rss_items(xml_text: str) -> list:
    """Парсит RSS/Atom: title/link/guid/description/pubDate + картинка
    (enclosure/media:content/media:thumbnail или <img src> в description)."""
    items = []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return items
    for node in root.iter():
        if _local(node.tag) != "item":
            continue

        def pick(tag: str) -> str:
            for child in node.iter():
                if _local(child.tag) == tag and child.text:
                    return child.text.strip()
            return ""

        title = _clean_title(pick("title"))
        link = pick("link")
        guid = pick("guid") or link or title
        desc = pick("description")
        image = ""
        for child in node.iter():
            ln = _local(child.tag)
            if ln in ("enclosure", "content", "thumbnail"):
                url = (child.get("url") or "").strip()
                if url:
                    image = url
                    break
        if not image:
            m = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', desc, re.I)
            if m:
                image = html.unescape(m.group(1))
        pd = _parse_pubdate(pick("pubDate"))
        items.append({
            "guid": guid,
            "title": title,
            "link": link,
            "description": desc,
            "image": image,
            "pub_ts": int(pd.timestamp() * 1000) if pd else None,
        })
    return items


def _fetch_feed(url: str) -> list:
    try:
        r = requests.get(url, headers=REQUEST_HEADERS, timeout=8)
        if r.status_code != 200:
            print(f"[multigroups] feed {url}: HTTP {r.status_code}")
            return []
        text = r.text
        if "\uFFFD" in text:
            try:
                text = r.content.decode("cp1251", errors="replace")
            except Exception:
                pass
        now_ms = int(time.time() * 1000)
        out = []
        for it in parse_rss_items(text):
            if it["pub_ts"] and now_ms - it["pub_ts"] <= MAX_AGE_MS:
                out.append(it)
        return out
    except Exception as e:
        print(f"[multigroups] feed {url}: {e}")
        return []


def fetch_multi_feeds(lang: str, limit: int = 12, feeds: list = None) -> list:
    """Свежие новости из лент языка: параллельный fetch, внутривыборочный
    дедуп похожих заголовков, сортировка по свежести, срез по limit."""
    urls = feeds or MULTI_FEEDS.get(lang, [])
    if not urls:
        return []
    items = []
    with ThreadPoolExecutor(max_workers=min(len(urls), 6)) as ex:
        futs = [ex.submit(_fetch_feed, u) for u in urls]
        for f in futs:
            try:
                items.extend(f.result())
            except Exception:
                pass
    seen = []
    unique = []
    for it in sorted(items, key=lambda x: x["pub_ts"] or 0, reverse=True):
        fp = title_fingerprint(it["title"])
        if any(title_similarity(fp, s) >= MG_SIM_T for s in seen):
            continue
        seen.append(fp)
        unique.append(it)
    return unique[:limit]


def image_score(url: str) -> int:
    """Приоритет картинки по расширению: jpg/png/gif раньше webp/unknown
    (Pillow может декодировать WebP, но старые сборки — нет; сортируем так же,
    как воркер)."""
    url = url or ""
    if re.search(r"\.(jpe?g|png|gif)(\?|$)", url, re.I):
        return 0
    if re.search(r"\.webp(\?|$)", url, re.I):
        return 2
    return 1


# ---------- LLM: адаптация и самокритика ----------

def adapt_news_ru(title: str, desc: str):
    """Переписывает новость живым русским языком (не дословный перевод).
    Возвращает (title, desc) или исходные значения при ошибке/отсутствии LLM."""
    try:
        raw = _complete([
            {
                "role": "system",
                "content": (
                    "Ты редактор игрового новостного канала. Тебе дают заголовок и описание "
                    "новости (возможно, на английском). Перепиши её по-русски живым языком "
                    "геймерского паблика: без канцелярита, без кальки с английского, названия "
                    "игр и имена не переводишь. Верни СТРОГО JSON вида "
                    '{"title":"заголовок до 120 символов","desc":"2-3 предложения, до 400 символов"}. '
                    "Без пояснений."
                ),
            },
            {"role": "user", "content": f"Заголовок: {title}\nОписание: {desc or '(нет)'}"},
        ])
        m = re.search(r"\{[\s\S]*\}", raw or "")
        if not m:
            return title, desc
        parsed = json.loads(m.group(0))
        out_title = str(parsed.get("title") or "").strip()
        out_desc = str(parsed.get("desc") or "").strip()
        return (
            out_title if len(out_title) >= 8 else title,
            out_desc if len(out_desc) >= 20 else desc,
        )
    except Exception as e:
        print(f"[multigroups] adapt_news_ru error: {e}")
        return title, desc


def critique_mg_text(text: str) -> str:
    """Вычищает клише и пустые обобщения из готового текста поста."""
    try:
        out = _complete([
            {
                "role": "system",
                "content": (
                    "Отредактируй текст поста для VK-паблика: убери клише («в мире игр», "
                    "«не может не радовать», «на повестке»), водянистые фразы и повторы. "
                    "Факты, цифры, названия и смысл сохрани. Верни только финальный текст "
                    "без комментариев."
                ),
            },
            {"role": "user", "content": text},
        ])
        out = (out or "").strip()
        return out if len(out) > 40 else text
    except Exception as e:
        print(f"[multigroups] critique_mg_text error: {e}")
        return text


# ---------- картинки: скачивание и конвертация в GIF ----------

def to_gif_bytes(data: bytes) -> bytes:
    """Байты картинки -> GIF. GIF проходит как есть (анимация сохраняется),
    JPEG/PNG/WebP конвертируются через Pillow, картинки больше maxSide
    уменьшаются (квантование+LZW на мегапикселях медленное)."""
    if len(data) < 6:
        return None
    if data[:3] == b"GIF":
        return data
    try:
        img = Image.open(io.BytesIO(data))
        img = img.convert("RGB")
        if max(img.size) > 720:
            img.thumbnail((720, 720))
        buf = io.BytesIO()
        img.save(buf, format="GIF", optimize=False)
        return buf.getvalue()
    except Exception as e:
        print(f"[multigroups] to_gif_bytes: {e}")
        return None


def _save_temp(data: bytes, suffix: str = ".gif") -> str:
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return path


def _remove_safe(path):
    try:
        if path:
            os.remove(path)
    except OSError:
        pass


def _upload_gif_attachment(token: str, group_id: int, gif_bytes: bytes) -> str:
    """Грузит GIF-байты как VK-документ, возвращает `doc{owner}_{id}`."""
    tmp = None
    try:
        tmp = _save_temp(gif_bytes, ".gif")
        vk = VKAPI(token, group_id)
        return vk._upload_wall_gif(tmp, skip_convert=True)
    finally:
        _remove_safe(tmp)


def upload_image_as_doc(image_url: str, group: dict) -> str:
    """Скачивает картинку новости и грузит как GIF-док. Ошибки не роняют
    пост — вернёт None."""
    if not image_url:
        return None
    try:
        r = requests.get(
            image_url,
            headers={**REQUEST_HEADERS, "Accept": "image/jpeg, image/png, image/gif"},
            timeout=10,
        )
        if r.status_code != 200:
            print(f"[multigroups] {group['name']}: image HTTP {r.status_code} {image_url[:80]}")
            return None
        data = r.content
        if len(data) <= 12:
            return None
        gif = to_gif_bytes(data)
        if not gif:
            print(f"[multigroups] {group['name']}: формат картинки не поддерживается ({image_url[:60]})")
            return None
        return _upload_gif_attachment(os.environ.get(group["token_key"], ""), group["groupId"], gif)
    except Exception as e:
        print(f"[multigroups] {group['name']}: image error: {e} ({image_url[:80]})")
        return None


# ---------- ТГ-арты (LostArt) ----------

def parse_tg_art_blocks(html_: str, channel: str) -> list:
    out = []
    block_re = re.compile(
        r'<div class="tgme_widget_message_wrap([\s\S]*?)(?=<div class="tgme_widget_message_wrap|</div>\s*</div>\s*<!--)'
    )
    for m in block_re.finditer(html_):
        b = m.group(1)
        post = _group1(re.search(r'data-post="([^"]+)"', b))
        time_ = _group1(re.search(r'datetime="([^"]+)"', b))
        bg = _group1(re.search(r"background-image:url\('([^']+)'\)", b))
        img = _group1(re.search(r'<img src="([^"]+)" class="tgme_widget_message_photo"', b))
        image = next((s for s in (bg, img) if s.startswith("https://")), "")
        if not image or not post:
            continue
        out.append({"post": post, "image": image, "time": time_, "channel": channel})
    return out


def fetch_art_from_channel(channel: str) -> dict:
    url = f"https://t.me/s/{channel}"
    try:
        r = requests.get(url, headers=REQUEST_HEADERS, timeout=10)
        if r.status_code != 200:
            print(f"[multigroups] t.me/s/{channel}: HTTP {r.status_code}")
            return None
        blocks = parse_tg_art_blocks(r.text, channel)
        if not blocks:
            return None
        for block in blocks[:8]:
            try:
                ir = requests.get(
                    block["image"],
                    headers={**REQUEST_HEADERS, "Accept": "image/jpeg, image/png, image/gif"},
                    timeout=10,
                )
                if ir.status_code != 200:
                    continue
                data = ir.content
                if len(data) < 12:
                    continue
                return {**block, "bytes": data}
            except Exception:
                continue
    except Exception as e:
        print(f"[multigroups] t.me/s/{channel}: {e}")
    return None


def art_caption(art: dict) -> str:
    ch = f"\n🎨 Канал: @{art['channel']}" if art.get("channel") else ""
    stamp = f"\n🕒 {str(art.get('time') or '')[:10]}" if art.get("time") else ""
    return "🌌 Искусственный интеллект · ИИ-арт" + ch + stamp


# ---------- сборка контента (без публикации) ----------

def build_news_payload(group: dict, cfg: dict) -> dict:
    """Готовит новость: текст + вложение. Не постит. Бросает, если публиковать нечего."""
    items = fetch_multi_feeds(group["lang"], 12, cfg["feeds"][group["lang"]])
    if not items:
        raise RuntimeError("нет свежих новостей в лентах")

    used = load_used_guids(group["slug"])
    candidates = [i for i in items if i["guid"][:120] not in used]
    candidates.sort(key=lambda i: image_score(i["image"]))
    # Если есть хоть один кандидат с картинкой — берём только такие,
    # чтобы пост не уходил текстом из-за фида без изображения.
    with_img = [i for i in candidates if i["image"]]
    candidates = (with_img or candidates)[:4]
    if not candidates:
        raise RuntimeError("все свежие новости уже опубликованы")

    last_err = None
    for it in candidates:
        try:
            title = _clean_title(it["title"])[:200]
            desc = re.sub(r"<[^>]+>", " ", it["description"] or "")
            desc = re.sub(r"\s+", " ", desc).strip()[:500]

            # Семантический дедуп: похожая новость уже выходила в любой группе.
            if is_duplicate_title(title):
                print(f"[multigroups] {group['name']}: дубль заголовка, пропускаю: {title[:50]}")
                continue

            # Адаптация на русский (EN-ленты) + самокритика.
            if group["lang"] == "en":
                title, desc = adapt_news_ru(title, desc)
            critiqued = f"{title}\n{desc}" if group["lang"] == "ru" else critique_mg_text(f"{title}\n{desc}")
            nl = critiqued.find("\n")
            if nl > 0:
                t2 = critiqued[:nl].strip()
                d2 = critiqued[nl + 1:].strip()
                if t2:
                    title = t2
                if d2:
                    desc = d2

            text = f"🎮 {title}\n\n"
            if desc:
                text += f"{desc}\n\n"
            text += f"🔗 Подробнее: {it['link']}\n{group['footer']}"
            text = text[:VK_POST_LIMIT]

            attachment = upload_image_as_doc(it["image"], group)
            print(
                f"[multigroups] {group['name']}: пост {title[:40]}: "
                f"картинка {'есть' if attachment else 'НЕТ'}"
            )
            return {"text": text, "attachment": attachment, "guid_key": it["guid"][:120]}
        except Exception as e:
            last_err = e
            print(f"[multigroups] {group['name']}: кандидат не прошёл ({e}), пробую следующий")
    raise last_err or RuntimeError("все кандидаты не прошли")


def build_art_payload(group: dict, cfg: dict) -> dict:
    """Готовит арт: подпись + вложение. Не постит."""
    used = load_used_guids(group["slug"])
    for channel in cfg["channels"]:
        art = fetch_art_from_channel(channel)
        if not art:
            continue
        id_key = f"{channel}:{art['post']}"
        if id_key in used:
            continue
        gif = to_gif_bytes(art["bytes"])
        if not gif:
            continue
        attachment = None
        try:
            attachment = _upload_gif_attachment(
                os.environ.get(group["token_key"], ""), group["groupId"], gif
            )
        except Exception as e:
            print(f"[multigroups] {group['name']}: GIF не загрузился ({e}), арт-пост ссылкой")
        if attachment:
            text = art_caption(art)
        else:
            # Сообщения сообщества выключены в VK — docs.save недоступен.
            # Публикуем ссылку на пост канала, чтобы слот не пропадал.
            text = (
                f"🌌 ИИ-арт в канале @{art['channel']}\n\n"
                f"🔗 Смотреть: https://t.me/{art['channel']}/{art['post']}"
            )
        return {"text": text, "attachment": attachment, "guid_key": id_key}
    raise RuntimeError("нет доступных артов (все каналы без картинок или уже использованы)")


# ---------- публикация ----------

def commit_post(group: dict, slot_start: int, payload: dict):
    """Финальная публикация: wall.post + все KV-отметки."""
    token = os.environ.get(group["token_key"], "")
    vk = VKAPI(token, group["groupId"])
    params = {"owner_id": -group["groupId"], "from_group": 1, "message": payload["text"]}
    if payload.get("attachment"):
        params["attachments"] = payload["attachment"]
    res = vk._call("wall.post", **params)
    post_id = (res or {}).get("post_id")

    now = _ekb_now()
    date_s = now.strftime("%Y-%m-%d")
    try:
        _kv_put(f"vk_posted:mg:{group['slug']}:{date_s}:{slot_start}", post_id or 1)
        if payload.get("guid_key"):
            remember_guid(group["slug"], payload["guid_key"])
        _kv_put(f"mg_last_post:{group['slug']}", int(time.time() * 1000))
        remember_title(title_fingerprint(payload["text"].split("\n")[0] or ""))
    except Exception as e:
        print(f"[multigroups] KV-отметки не записались: {e}")
    return post_id


def publish_multi_group(group: dict, now: datetime = None) -> dict:
    """Публикует один пост для группы, если её слот сейчас активен и ещё не занят."""
    cfg = load_mg_config()
    token = os.environ.get(group["token_key"], "")
    if not token:
        return {"slug": group["slug"], "posted": False, "detail": f"нет токена {group['token_key']}"}

    now = now or _ekb_now()
    slot = active_multi_window(group["slug"], now, cfg["windows"])
    if slot is None:
        return {"slug": group["slug"], "posted": False, "detail": "не активный слот"}

    date_s = now.strftime("%Y-%m-%d")
    key = f"vk_posted:mg:{group['slug']}:{date_s}:{slot}"
    if _kv_get(key) is not None:
        return {"slug": group["slug"], "posted": False, "detail": "слот уже занят"}

    try:
        payload = build_art_payload(group, cfg) if group["kind"] == "art" else build_news_payload(group, cfg)
    except Exception as e:
        return {"slug": group["slug"], "posted": False, "detail": str(e)[:200]}

    post_id = commit_post(group, slot, payload)
    return {"slug": group["slug"], "posted": True, "detail": f"post_id={post_id}"}


def mg_tick(now: datetime = None) -> list:
    """Основная точка входа из main.py: очередь dgc -> lostart -> lostlink,
    каждая группа постит, только если активен её слот."""
    results = []
    for g in MULTI_GROUPS:
        try:
            res = publish_multi_group(g, now)
        except Exception as e:
            res = {"slug": g["slug"], "posted": False, "detail": str(e)[:200]}
        print(f"[multigroups] {g['slug']}: {'POSTED' if res['posted'] else res['detail']}", flush=True)
        results.append(res)
    return results


def mg_summary(results: list) -> str:
    """Текст сводки для админа (Telegram, HTML)."""
    names = {g["slug"]: g["name"] for g in MULTI_GROUPS}
    lines = []
    for r in results:
        name = names.get(r["slug"], r["slug"])
        if r["posted"]:
            lines.append(f"✅ <b>{name}</b>: опубликовано · {r['detail']}")
        elif r["detail"] in ("не активный слот", "слот уже занят"):
            lines.append(f"⏭ {name}: {r['detail']}")
        else:
            lines.append(f"⚠️ {name}: {r['detail']}")
    return "📊 <b>Мультигруппы</b>\n" + "\n".join(lines)