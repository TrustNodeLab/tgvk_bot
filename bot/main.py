"""
Один проход бота. Запускается по расписанию через GitHub Actions (см. .github/workflows/poll.yml).
Каждый запуск: забрать новые апдейты Telegram -> обработать -> сохранить состояние.
Состояние коммитится в репозиторий отдельным шагом workflow после этого скрипта.
"""
import os
import re
import sys
import json
import uuid
import shutil
import traceback
from datetime import datetime, timedelta

from telegram_api import TelegramAPI, reply_keyboard, inline_keyboard
from vk_api import VKAPI
from llm import extract_post_data
from card_generator import render_card
from news_sources import find_candidates, sources_info
from markdown import md_to_html, md_to_plain
import state as st

DATA_DIR = st.DATA_DIR
CARDS_DIR = os.path.join(DATA_DIR, "cards")  # публичные карточки для link-card режима VK

# Сводка последнего сгенерированного поста (карточки/layout), чтобы следующий пост
# отличался сеткой и набором типов. Обновляется на каждый собранный черновик,
# сохраняется в state.json — контекст переживает перезапуски бота.
_last_post_summary: dict = {}


def _summary(data: dict) -> dict:
    return {
        "cards": data.get("cards", []),
        "layout": data.get("layout"),
    }


def _cards_summary(data: dict) -> str:
    """Короткое описание карточки для списка истории."""
    cards = data.get("cards", [])
    types = [c.get("type", "stat") for c in cards]
    return f"{len(cards)} карточки ({', '.join(types) or '—'}), layout {data.get('layout')}"


def now_msk() -> datetime:
    return datetime.utcnow() + timedelta(hours=3)


TG_CAPTION_LIMIT = 1024

RUSTORE_URL = "https://www.rustore.ru/catalog/app/com.frauddetector.app"
SITE_URL = "https://trustnodelab.github.io"
PRODUCT_RADAR_URL = "https://productradar.ru/product/trustnode/"
POST_FOOTER = (
    "🛡️ TrustNode\n"
    f"📲 Скачать приложение: {RUSTORE_URL}\n"
    f"🌐 Сайт проекта: {SITE_URL}\n"
    f"📄 Product Radar: {PRODUCT_RADAR_URL}"
)


def full_post_text(caption: str) -> str:
    """Полный текст поста: caption от LLM + постоянный footer с логотипом и ссылками
    (LLM их не генерирует, чтобы не придумывал неверные URL)."""
    caption = normalize_caption(caption)
    return caption + "\n\n" + POST_FOOTER if caption else POST_FOOTER


_BLOCK_HEADS = ("🔍", "📌", "⚠", "🛡", "💡")


def normalize_caption(caption: str) -> str:
    """Приводит caption к шаблону, даже если LLM сэкономил пустые строки:
    каждый блок (🔍/📌/⚠️/🛡/💡) отделяется пустой строкой, буллеты — по одному на строку."""
    lines = [(ln or "").rstrip() for ln in (caption or "").splitlines()]
    out: list = []
    for i, ln in enumerate(lines):
        stripped = ln.strip()
        if stripped and stripped[0] in _BLOCK_HEADS:
            if out and out[-1].strip():
                out.append("")
        out.append(ln)
    joined = "\n".join(out).strip()
    if not joined:
        return ""
    # «• x • y • z» на одной строке -> каждый пункт с новой строки
    if "•" in joined:
        lines2 = []
        for ln in joined.splitlines():
            if "•" not in ln:
                lines2.append(ln)
                continue
            parts = re.split(r"(?=•\s)", ln)
            for p in parts:
                p = p.strip()
                if p:
                    lines2.append(p)
        joined = "\n".join(lines2)
    return joined


def _fit_caption(caption: str, limit: int = TG_CAPTION_LIMIT) -> str:
    """Подгоняет подпись к фото под лимит Telegram (1024 символа), чтобы картинка и
    текст всегда публиковались одним сообщением. Footer (логотип + ссылки) сохраняется
    целиком — обрезается только тело поста, на границе предложения, с многоточием."""
    if len(caption) <= limit:
        return caption
    body, footer = caption, ""
    sep = "\n\n" + POST_FOOTER
    if caption.endswith(POST_FOOTER) and sep in caption:
        body, footer = caption[: -len(POST_FOOTER)].rstrip(), "\n\n" + POST_FOOTER
    budget = limit - len(footer) - 1  # 1 — на «…»
    if budget <= 0:
        return caption[: max(0, limit - 1)] + "…"
    cut = body[: budget].rstrip()
    # режем по границе последнего предложения, не разрывая середину слова
    for sep_mark in (". ", "! ", "? ", "…", " ", "— "):
        idx = cut.rfind(sep_mark)
        if idx > budget // 2:
            cut = cut[: idx].rstrip() + "…"
            break
    else:
        cut = body[: budget - 1].rstrip() + "…"
    return cut + footer


def _vk_publish(vk: VKAPI, image_path: str, message_md: str, card_id: str):
    """Публикует пост в VK с картинкой. В link-card режиме (VK_CARD_URL_BASE)
    карточка должна быть доступна по публичному URL: в remote-режиме загружаем её
    в R2 (cards/<id>.png), иначе копируем в data/cards/ (раньше коммитилось git'ом).
    Постим ссылку на карточку. Без link-card — обычная загрузка фото с ретраями."""
    message = md_to_plain(message_md)
    if getattr(vk, "card_url_base", None):
        if st.REMOTE:
            st.upload_card(image_path, card_id)
        else:
            os.makedirs(CARDS_DIR, exist_ok=True)
            shutil.copy2(image_path, os.path.join(CARDS_DIR, f"{card_id}.png"))
        return vk.post_card(message, f"{vk.card_url_base}/{card_id}.png")
    return vk.post_to_wall(image_path, message)


def send_photo_smart(tg: TelegramAPI, chat_id, photo_path, caption, reply_markup=None):
    """Telegram режет caption у фото на 1024 символа. Картинка и текст публикуются
    ВСЕГДА одним сообщением: подпись проходит через markdown->HTML (md_to_html), при
    переборе лимита обрезается (_fit_caption). Если и после разметки длина больше
    1024 (теги прибавляют символы) — откатываемся на plain-текст той же подписи,
    чтобы картинка и текст по-прежнему шли одним сообщением без ошибки."""
    raw = caption or ""
    html = md_to_html(_fit_caption(raw))
    if len(html) <= TG_CAPTION_LIMIT:
        return tg.send_photo(chat_id, photo_path, caption=html, parse_mode="HTML",
                             reply_markup=reply_markup)
    plain = _fit_caption(md_to_plain(_fit_caption(raw)))
    return tg.send_photo(chat_id, photo_path, caption=plain, reply_markup=reply_markup)


# ---------- кнопки у превью (inline-клавиатура с callback_data=draft_id) ----------
# Инлайн-кнопки шлют callback_query с callback_data — мы кладём туда короткий
# action:draft_id (вместо полной карточки, как раньше), поэтому апдейт влезает
# в лимит webhook/GitHub input. Так каждая кнопка привязана к своему черновику
# и можно опубликовать один из нескольких постов.

BTN_APPROVE = "✅ Опубликовать"
BTN_REDO = "✏️ Заново"
BTN_CANCEL = "❌ Отмена"
BTN_STATUS = "📊 Статус"
BTN_AUTOPOST = "🔄 Автопостинг"
BTN_SOURCES = "📰 Источники"
BTN_HELP = "❓ Помощь"
BTN_HOME = "🏠 В меню"
BTN_AP_ON = "▶️ Включить автопостинг"
BTN_AP_OFF = "⏸ Выключить автопостинг"
BTN_HISTORY = "📜 История"
BTN_HISTORY_SEND = "📤 Отправить в TG и VK"


def buttons(draft_id: str):
    """Кнопки у превью: callback_data 'action:draft_id', чтобы обработать именно
    этот черновик (при нескольких превью выбор конкретного поста)."""
    return inline_keyboard([
        [(BTN_APPROVE, f"approve:{draft_id}")],
        [(BTN_REDO, f"redo:{draft_id}"), (BTN_CANCEL, f"cancel:{draft_id}")],
    ])


# ---------- интерфейс бота: приветствие / меню / статус / помощь ----------

WELCOME_TEXT = (
    "🛡️ <b>TrustNode — бот-редактор канала</b>\n\n"
    "Привет! Я сам нахожу свежие новости о мошенничестве и "
    "кибербезопасности, собираю карточку с реальным небом над Москвой "
    "и готовлю текст поста для VK и Telegram.\n\n"
    "Что умею:\n"
    "🔍 <b>Автопоиск</b> — каждые ~5 минут проверяю RSS-ленты новостей\n"
    "🎨 <b>Карточки</b> — небо, шрифты Exo 2 / Jura, акцент по уровню угрозы\n"
    "✍️ <b>Посты</b> — экспертный текст по правилам канала\n"
    "⚡ <b>Автопостинг</b> — публикую найденное сам, без одобрения\n\n"
    "Просто пришли мне текст новости — соберу карточку. "
    "Или выбери пункт в меню 👇"
)

HELP_TEXT = (
    "📚 <b>Как пользоваться</b>\n\n"
    "• <b>Пришли текст новости</b> — бот соберёт карточку и превью с кнопками:\n"
    "   ✅ Опубликовать — пост уйдёт в VK и TG-канал\n"
    "   ✏️ Заново — пересобрать по уточнённому тексту\n"
    "   ❌ Отмена — удалить черновик\n\n"
    "• <b>Автопоиск</b> — бот сам находит новости по RSS из config/sources.json "
    "и присылает на одобрение\n\n"
    "• <b>Автопостинг</b> — включи в меню: бот будет публиковать найденные "
    "новости сразу, без твоего участия\n\n"
    "• <b>История</b> — в меню: список последних опубликованных постов, "
    "можно отправить любой из них ещё раз в TG-канал и VK\n\n"
    "Команды:\n"
    "/start — приветствие и меню\n"
    "/status — состояние бота\n"
    "/autopost — тумблер автопостинга"
)


def menu_keyboard(state: dict):
    """Главное меню (reply-клавиатура): статус, автопостинг-тумблер, источники, история, помощь."""
    return reply_keyboard([
        [BTN_STATUS, BTN_AUTOPOST],
        [BTN_SOURCES, BTN_HISTORY],
        [BTN_HELP, BTN_HOME],
    ])


def status_message(state: dict) -> str:
    """Текст статус-команды: режим, источники, свежесть ленты, последний пост."""
    info = sources_info()
    n_feeds = len(info["feeds"])
    n_kw = len(info["keywords"])
    autopost = "ВКЛ" if st.autopost_enabled(state) else "ВЫКЛ"
    last = state.get("last_post")
    last_line = "—"
    if last:
        cards = last.get("cards", [])
        types = [c.get("type", "stat") for c in cards]
        last_line = f"{len(cards)} карточки ({', '.join(types) or '—'}), layout {last.get('layout')}"
    return (
        "📊 <b>Статус бота</b>\n\n"
        f"🔄 Автопостинг: <b>{autopost}</b>\n"
        f"📰 Источников: <b>{n_feeds}</b>\n"
        f"🔑 Ключевых слов: <b>{n_kw}</b>\n"
        f"🖼 Последний пост: {last_line}\n\n"
        "Настройки поиска — в config/sources.json."
    )


def sources_message() -> str:
    info = sources_info()
    feeds = "\n".join(f"• {f}" for f in info["feeds"]) or "—"
    kw = ", ".join(info["keywords"]) or "—"
    return (
        "📰 <b>Источники поиска</b>\n\n"
        f"{feeds}\n\n"
        f"🔑 Ключевые слова:\n{kw}"
    )


def autopost_message(state: dict) -> tuple:
    """Текст + reply-кнопки для сообщения-тумблера автопостинга."""
    on = st.autopost_enabled(state)
    status = "ВКЛ" if on else "ВЫКЛ"
    desc = ("Бот сам публикует найденные новости в VK и TG-канал.\n"
            "Ручные тексты по-прежнему приходят на одобрение."
            if on else
            "Бот присылает найденные новости на одобрение (как сейчас).")
    toggle = BTN_AP_OFF if on else BTN_AP_ON
    kb = reply_keyboard([
        [toggle],
        [BTN_HOME],
    ])
    return f"🔄 Автопостинг: {status}\n{desc}", kb


def handle_new_text(tg: TelegramAPI, admin_chat_id: str, text: str, auto_found: bool = False,
                    prev_post: dict = None, vk: VKAPI = None, channel_id: str = None,
                    auto_publish: bool = False, state: dict = None):
    global _last_post_summary
    data = extract_post_data(text, prev_post=prev_post or _last_post_summary or None)
    if "error" in data:
        if not auto_found:  # автонайденные нерелевантные кандидаты просто тихо пропускаем
            tg.send_message(admin_chat_id, f"Не смог собрать карточку: {data['error']}\nПришли текст точнее.")
        return

    draft_id = uuid.uuid4().hex[:10]
    png_path = os.path.join(DATA_DIR, "drafts", f"{draft_id}.png")
    os.makedirs(os.path.dirname(png_path), exist_ok=True)
    render_card(data, png_path, dt_msk=now_msk())
    _last_post_summary.clear()
    _last_post_summary.update(_summary(data))

    caption = full_post_text(data.get("caption", ""))

    # автопостинг: сразу публикуем в VK и TG-канал, без превью и кнопок
    if auto_publish:
        _vk_publish(vk, png_path, caption, draft_id)
        send_photo_smart(tg, channel_id, png_path, caption)
        st.archive_draft({
            "id": draft_id,
            "published_at": now_msk().isoformat(timespec="seconds"),
            "caption": caption,
            "png_path": png_path,
            "cards_summary": _cards_summary(data),
        })
        tg.send_message(admin_chat_id,
                        f"✅ Автопостинг: опубликовал пост из новости.\n\n{caption[:200]}…"
                        if len(caption) > 200 else
                        f"✅ Автопостинг: опубликовал пост.\n\n{caption}")
        return

    prefix = "🔍 Бот нашёл новость сам:\n\n" if auto_found else ""
    sent = send_photo_smart(tg, admin_chat_id, png_path, prefix + caption, reply_markup=buttons(draft_id))

    st.save_draft(draft_id, {
        "raw_text": text,
        "data": data,
        "caption": caption,
        "png_path": png_path,
        "admin_chat_id": admin_chat_id,
        "preview_message_id": sent["message_id"],
    })

    # Для обратной совместимости со старыми reply-кнопками храним id последнего превью.
    if state is not None:
        state["last_draft_id"] = draft_id
        st.save_state(state)


def _last_draft(state: dict):
    """Последний показанный черновик (для reply-кнопок без id в данных)."""
    draft_id = state.get("last_draft_id")
    if not draft_id:
        return None, None
    try:
        return st.load_draft(draft_id), draft_id
    except FileNotFoundError:
        return None, None


def handle_draft_button(tg: TelegramAPI, vk: VKAPI, channel_id: str, admin_chat_id: str,
                        state: dict, action: str, draft_id: str = None,
                        callback_query_id: str = None):
    """Нажатие кнопки у превью (approve/redo/cancel). Inline-кнопки несут конкретный
    draft_id в callback_data; без него (старые reply-кнопки) — действуем по последнему."""
    if draft_id:
        try:
            draft = st.load_draft(draft_id)
        except FileNotFoundError:
            draft = None
    else:
        draft, draft_id = _last_draft(state)

    def _cleanup():
        # убираем кнопки с превью, чтобы нельзя было обработать его повторно
        try:
            tg.edit_message_reply_markup(
                draft.get("admin_chat_id") or admin_chat_id,
                draft.get("preview_message_id"),
                reply_markup=inline_keyboard([]),
            )
        except Exception:
            pass
        st.delete_draft(draft_id)
        state.pop("last_draft_id", None)

    if not draft:
        if callback_query_id:
            tg.answer_callback_query(callback_query_id, "Черновик уже обработан или устарел.")
        else:
            tg.send_message(admin_chat_id, "Черновик уже обработан или устарел. Пришли новость заново.",
                            reply_markup=menu_keyboard(state))
        return

    if action == "approve":
        png = st.local_png(draft.get("png_path"), draft.get("png_key"))
        if png:
            _vk_publish(vk, png, draft["caption"], draft_id)
            send_photo_smart(tg, channel_id, png, draft["caption"])
        else:
            vk.post_to_wall_text(md_to_plain(draft["caption"]))
            tg.send_message(channel_id, md_to_html(draft["caption"]), parse_mode="HTML")
        st.archive_draft({
            "id": draft_id,
            "published_at": now_msk().isoformat(timespec="seconds"),
            "caption": draft["caption"],
            "png_path": png or draft.get("png_path"),
            "cards_summary": _cards_summary(draft["data"]),
        })
        _cleanup()
        if callback_query_id:
            tg.answer_callback_query(callback_query_id, "✅ Опубликовано в VK и TG-канале")
        else:
            tg.send_message(admin_chat_id, "✅ Опубликовано в VK и TG-канале",
                            reply_markup=menu_keyboard(state))

    elif action == "cancel":
        _cleanup()
        if callback_query_id:
            tg.answer_callback_query(callback_query_id, "❌ Отменено")
        else:
            tg.send_message(admin_chat_id, "❌ Отменено", reply_markup=menu_keyboard(state))

    elif action == "redo":
        _cleanup()
        if callback_query_id:
            tg.answer_callback_query(callback_query_id, "Пришли текст ещё раз, с уточнениями что поменять")
        else:
            tg.send_message(admin_chat_id, "Пришли текст ещё раз, с уточнениями что поменять — соберу заново.",
                            reply_markup=menu_keyboard(state))


def handle_menu_button(tg: TelegramAPI, admin_chat_id: str, state: dict, item: str):
    """Нажатие reply-кнопки главного меню."""
    if item == BTN_HOME:
        state["history_mode"] = False
        st.save_state(state)
    if item == BTN_STATUS:
        tg.send_message(admin_chat_id, status_message(state),
                        reply_markup=menu_keyboard(state), parse_mode="HTML")
    elif item == BTN_SOURCES:
        tg.send_message(admin_chat_id, sources_message(),
                        reply_markup=menu_keyboard(state), parse_mode="HTML")
    elif item == BTN_HELP:
        tg.send_message(admin_chat_id, HELP_TEXT,
                        reply_markup=menu_keyboard(state), parse_mode="HTML")
    elif item == BTN_HOME:
        tg.send_message(admin_chat_id, WELCOME_TEXT,
                        reply_markup=menu_keyboard(state), parse_mode="HTML")


def handle_autopost_button(tg: TelegramAPI, admin_chat_id: str, state: dict):
    """Нажатие кнопки-тумблера автопостинга (ВКЛ/ВЫКЛ) или пункта меню."""
    state["autopost"] = not st.autopost_enabled(state)
    st.save_state(state)
    msg_text, kb = autopost_message(state)
    tg.send_message(admin_chat_id, msg_text, reply_markup=kb)


# ---------- история постов ----------

HISTORY_PAGE = 5


def _fmt_history_time(iso: str) -> str:
    try:
        return datetime.fromisoformat(iso).strftime("%d.%m %H:%M")
    except (ValueError, TypeError):
        return iso or "—"


def handle_history_list(tg: TelegramAPI, admin_chat_id: str, state: dict):
    """Кнопка «📜 История»: список последних опубликованных постов."""
    entries = st.load_history()
    if not entries:
        state["history_mode"] = False
        st.save_state(state)
        tg.send_message(admin_chat_id, "История пуста — пока нет опубликованных постов.",
                        reply_markup=menu_keyboard(state))
        return

    state["history_mode"] = True
    st.save_state(state)

    shown = entries[:HISTORY_PAGE]
    lines = ["📜 Последние посты:\n"]
    for i, e in enumerate(shown, 1):
        lines.append(f"{i}) {_fmt_history_time(e.get('published_at'))} — {e.get('cards_summary', '—')}")
    lines.append("\nВыбери номер поста, чтобы увидеть его и отправить в TG/VK.")

    num_row = [str(i) for i in range(1, len(shown) + 1)]
    kb = reply_keyboard([num_row, [BTN_HOME]])
    tg.send_message(admin_chat_id, "\n".join(lines), reply_markup=kb)


def handle_history_pick(tg: TelegramAPI, admin_chat_id: str, state: dict, num: int):
    """Выбор поста из списка истории по номеру."""
    entries = st.load_history()
    idx = num - 1
    if idx < 0 or idx >= len(entries):
        state["history_mode"] = False
        st.save_state(state)
        tg.send_message(admin_chat_id, "Такого поста нет.", reply_markup=menu_keyboard(state))
        return

    entry = entries[idx]
    state["history_mode"] = False
    state["history_view_id"] = entry["id"]
    st.save_state(state)

    header = f"📜 Пост от {_fmt_history_time(entry.get('published_at'))}\n\n"
    kb = reply_keyboard([[BTN_HISTORY_SEND], [BTN_HOME]])
    png = st.local_png(entry.get("png_path"), entry.get("png_key"))
    if png:
        send_photo_smart(tg, admin_chat_id, png, header + entry.get("caption", ""),
                         reply_markup=kb)
    else:
        tg.send_message(admin_chat_id, header + entry.get("caption", ""), reply_markup=kb)


def handle_history_send(tg: TelegramAPI, vk: VKAPI, channel_id: str, admin_chat_id: str, state: dict):
    """Кнопка «📤 Отправить в TG и VK» у поста из истории."""
    post_id = state.get("history_view_id")
    entry = st.get_history_entry(post_id) if post_id else None
    if not entry:
        state.pop("history_view_id", None)
        st.save_state(state)
        tg.send_message(admin_chat_id, "Пост не найден в истории.", reply_markup=menu_keyboard(state))
        return

    try:
        png = st.local_png(entry.get("png_path"), entry.get("png_key"))
        if png:
            _vk_publish(vk, png, entry["caption"], entry["id"])
            send_photo_smart(tg, channel_id, png, entry["caption"])
        else:
            vk.post_to_wall_text(md_to_plain(entry["caption"]))
            tg.send_message(channel_id, md_to_html(entry["caption"]), parse_mode="HTML")
        state.pop("history_view_id", None)
        st.save_state(state)
        tg.send_message(admin_chat_id, "✅ Пост отправлен в VK и TG-канал",
                        reply_markup=menu_keyboard(state))
    except Exception as e:
        traceback.print_exc()
        tg.send_message(admin_chat_id, f"⚠️ Не удалось отправить пост: {e}",
                        reply_markup=menu_keyboard(state))


def _process_update(tg: TelegramAPI, vk: VKAPI, state: dict, admin_chat_id: str,
                    channel_id: str, upd: dict):
    """Обрабатывает один апдейт Telegram: обычное сообщение (включая нажатия
    reply-кнопок, которые приходят текстом) или нажатие inline-кнопки
    (callback_query с data 'action:draft_id'). Чужие чаты тихо игнорирует."""
    if "callback_query" in upd:
        cq = upd["callback_query"] or {}
        if str((cq.get("chat") or {}).get("id")) == str(admin_chat_id):
            data = cq.get("data") or ""
            action, _, draft_id = data.partition(":")
            if action in ("approve", "redo", "cancel") and draft_id:
                handle_draft_button(tg, vk, channel_id, admin_chat_id, state, action,
                                    draft_id=draft_id, callback_query_id=cq.get("id"))
        return

    if upd.get("message") and str(upd["message"]["chat"]["id"]) == str(admin_chat_id):
        text = upd["message"].get("text")
        if text in (BTN_APPROVE,):
            handle_draft_button(tg, vk, channel_id, admin_chat_id, state, "approve")
        elif text == BTN_REDO:
            handle_draft_button(tg, vk, channel_id, admin_chat_id, state, "redo")
        elif text == BTN_CANCEL:
            handle_draft_button(tg, vk, channel_id, admin_chat_id, state, "cancel")
        elif text == BTN_HISTORY_SEND:
            handle_history_send(tg, vk, channel_id, admin_chat_id, state)
        elif text == BTN_HISTORY:
            handle_history_list(tg, admin_chat_id, state)
        elif state.get("history_mode") and text and text.isdigit():
            handle_history_pick(tg, admin_chat_id, state, int(text))
        elif text in (BTN_STATUS, BTN_SOURCES, BTN_HELP, BTN_HOME):
            handle_menu_button(tg, admin_chat_id, state, text)
        elif text in (BTN_AUTOPOST, BTN_AP_ON, BTN_AP_OFF, "/autopost"):
            handle_autopost_button(tg, admin_chat_id, state)
        elif text == "/start" or text == "/menu":
            state["history_mode"] = False
            st.save_state(state)
            tg.send_message(admin_chat_id, WELCOME_TEXT,
                            reply_markup=menu_keyboard(state), parse_mode="HTML")
        elif text == "/help":
            tg.send_message(admin_chat_id, HELP_TEXT,
                            reply_markup=menu_keyboard(state), parse_mode="HTML")
        elif text == "/status":
            tg.send_message(admin_chat_id, status_message(state),
                            reply_markup=menu_keyboard(state), parse_mode="HTML")
        elif text and not text.startswith("/"):
            handle_new_text(tg, admin_chat_id, text, state=state)


def run():
    bot_token = os.environ["TELEGRAM_BOT_TOKEN"]
    admin_chat_id = os.environ["TELEGRAM_ADMIN_CHAT_ID"]
    channel_id = os.environ["TELEGRAM_CHANNEL_ID"]
    vk_token = os.environ["VK_TOKEN"]
    vk_group_id = os.environ["VK_GROUP_ID"]

    tg = TelegramAPI(bot_token)
    vk = VKAPI(vk_token, vk_group_id, album_id=os.environ.get("VK_ALBUM_ID"),
               card_url_base=os.environ.get("VK_CARD_URL_BASE"))

    state = st.load_state()
    _last_post_summary.clear()
    _last_post_summary.update(state.get("last_post") or {})

    # --- webhook-режим: пришёл ровно один апдейт от Cloudflare Worker ---
    # Приоритетнее обычного запуска: если задан TELEGRAM_UPDATE_JSON, обрабатываем
    # только его (без get_updates и без автопоиска — автопоиск живёт в cron-запусках).
    update_json = os.environ.get("TELEGRAM_UPDATE_JSON", "").strip()
    if update_json:
        try:
            upd = json.loads(update_json)
            # Длинный текст воркер режет на куски (лимит GitHub input ~1000 символов)
            # и передаёт их отдельными env-переменными — склеиваем обратно.
            chunks = [os.environ.get(f"TELEGRAM_UPDATE_JSON_{i}", "").strip()
                      for i in range(2, 11)]
            rest = "".join(c for c in chunks if c)
            if rest and upd.get("message"):
                upd["message"]["text"] = (upd["message"].get("text") or "") + rest

            # --- авто-кандидат от воркера (cron-скан RSS): не сообщение Telegram,
            # а текст новости, который нашёл воркер. Обрабатываем как находку
            # (автопостинг — если включён, иначе превью на одобрение).
            if upd.get("auto_found"):
                guid = upd.get("guid", "")
                text = (upd.get("message") or {}).get("text") or ""
                if guid and guid in set(state.get("seen_guids", [])):
                    print(f"[webhook] auto_found guid already seen, skip: {guid[:60]}", flush=True)
                else:
                    if guid:
                        st.remember_guid(state, guid)
                    st.save_state(state)
                    try:
                        handle_new_text(tg, admin_chat_id, text, auto_found=True,
                                        vk=vk, channel_id=channel_id,
                                        auto_publish=st.autopost_enabled(state),
                                        state=state)
                    except Exception:
                        traceback.print_exc()
                        try:
                            tg.send_message(
                                admin_chat_id,
                                f"⚠️ Автонайденная новость не дошла до approve "
                                f"(guid={guid}): {traceback.format_exc(limit=1)}"
                            )
                        except Exception:
                            pass
                st.save_state(state)
                return

            if upd.get("message"):
                msg_text = upd["message"].get("text") or ""
                print(f"[webhook] text len={len(msg_text)} chars, chunks={sum(1 for c in chunks if c)}", flush=True)
            _process_update(tg, vk, state, admin_chat_id, channel_id, upd)
        except Exception:
            traceback.print_exc()
            try:
                tg.send_message(admin_chat_id, "⚠️ Ошибка обработки webhook-апдейта")
            except Exception:
                pass
        st.save_state(state)
        return

    # --- обычный запуск по cron: get_updates + автопоиск ---
    # После установки webhook Telegram отвечает 409 «can't use getUpdates while
    # webhook is active» — это ожидаемо. Ловим исключение и продолжаем с автопоиском.
    max_id = state.get("last_update_id", 0)
    try:
        offset = state.get("last_update_id", 0) + 1
        updates = tg.get_updates(offset=offset)
        for upd in updates:
            max_id = max(max_id, upd["update_id"])
            try:
                _process_update(tg, vk, state, admin_chat_id, channel_id, upd)
            except Exception as e:
                traceback.print_exc()
                try:
                    tg.send_message(admin_chat_id, f"⚠️ Ошибка обработки: {e}")
                except Exception:
                    pass
    except Exception as e:
        print(f"[warn] get_updates: {e}", file=sys.stderr)
        traceback.print_exc()

    state["last_update_id"] = max_id

    # --- автопоиск: бот сам ищет новости по RSS, без участия Михаила ---
    # max_items=3 — за один проход до 3 новых кандидатов (по запросу Михаила)
    # Если включён автопостинг — найденное публикуется сразу, без одобрения.
    auto_publish = st.autopost_enabled(state)
    try:
        seen = set(state.get("seen_guids", []))
        candidates = find_candidates(seen, max_items=3)
        for cand in candidates:
            st.remember_guid(state, cand["guid"])
            try:
                handle_new_text(tg, admin_chat_id, cand["text"], auto_found=True,
                                vk=vk, channel_id=channel_id, auto_publish=auto_publish,
                                state=state)
            except Exception as e:
                traceback.print_exc()
                try:
                    tg.send_message(
                        admin_chat_id,
                        f"⚠️ Автонайденная новость не дошла до approve "
                        f"(guid={cand['guid']}): {e}"
                    )
                except Exception:
                    pass
    except Exception as e:
        traceback.print_exc()

    st.save_state(state)

    # контекст для следующего запуска: сохраняем сетку последнего поста, чтобы
    # следующий автопост в новом запуске отличался от предыдущего
    if _last_post_summary:
        state["last_post"] = _last_post_summary
        st.save_state(state)


if __name__ == "__main__":
    run()
