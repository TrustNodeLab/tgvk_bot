"""Конвертация небольшого подмножества Markdown, которое LLM/админ использует
в постах: **жирный**, *курсив*, `код`, [текст](url), ~~зачёркнутый~~,
__подчёркнутый__.

Платформы по-разному относятся к разметке в тексте поста:
  - Telegram рендерит её через parse_mode="HTML"   -> md_to_html();
  - VK wall.post НЕ рендерит markdown (только plain-текст с автолинковкой
    голых URL) -> md_to_plain().

Оба конвертера безопасны для «битой» разметки: незакрытый маркер или
обрезанный посередине токен остаётся буквальным текстом — без падения и без
сломанного HTML (незакрытых тегов).
"""
import re

_TOKEN = re.compile(
    r"(\*\*[^*\n]+\*\*"              # **bold**
    r"|`[^`\n]+`"                    # `code`
    r"|~~[^~\n]+~~"                  # ~~strikethrough~~
    r"|(?<!_)__[^_\n]+__(?!_)"       # __underline__
    r"|\[[^\]\n]+\]\([^)\s]+\)"      # [text](url)
    r"|(?<!\*)\*[^*\n]+\*(?!\*))",   # *italic*
    re.S,
)

_LINK = re.compile(r"\[([^\]\n]+)\]\(([^)\s]+)\)")

_TAG = {"bold": "b", "em": "i", "u": "u", "s": "s"}


def _split(text: str):
    """Список токенов: ('text', s) | ('bold'|'em'|'u'|'s'|'code', s) |
    ('link', text, url). Вложенные маркеры внутри контента разбираются рекурсивно
    в _convert (внутри токена разрешены любые символы, кроме его маркера)."""
    parts, pos = [], 0
    for m in _TOKEN.finditer(text):
        if m.start() > pos:
            parts.append(("text", text[pos:m.start()]))
        tok = m.group(1)
        kinds = (("**", "bold"), ("~~", "s"), ("__", "u"))
        matched = False
        for marker, kind in kinds:
            if tok.startswith(marker) and tok.endswith(marker):
                parts.append((kind, tok[len(marker):-len(marker)]))
                matched = True
                break
        if matched:
            pass
        elif tok.startswith("`"):
            parts.append(("code", tok[1:-1]))
        elif tok.startswith("["):
            m2 = _LINK.match(tok)
            parts.append(("link", m2.group(1), m2.group(2)))
        else:
            parts.append(("em", tok[1:-1]))
        pos = m.end()
    if pos < len(text):
        parts.append(("text", text[pos:]))
    return parts


def _escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _convert(text: str, mode: str) -> str:
    out = []
    for item in _split(text):
        kind = item[0]
        if mode == "vk":
            if kind == "link":
                t, url = item[1], item[2]
                out.append(f"{t} ({url})" if t != url else url)
            elif kind in ("bold", "em", "u", "s"):
                out.append(_convert(item[1], "vk"))
            else:  # code / text
                out.append(item[1])
        else:  # tg -> html
            if kind == "text":
                out.append(_escape(item[1]))
            elif kind == "code":
                out.append(f"<code>{_escape(item[1])}</code>")
            elif kind == "link":
                out.append(f'<a href="{_escape(item[2])}">{_escape(item[1])}</a>')
            else:
                out.append(f"<{_TAG[kind]}>{_convert(item[1], 'tg')}</{_TAG[kind]}>")
    return "".join(out)


def md_to_html(text: str) -> str:
    """Markdown -> Telegram HTML (parse_mode='HTML'). Побочные символы экранируются."""
    return _convert(text or "", "tg")


def md_to_plain(text: str) -> str:
    """Markdown -> чистый текст для VK wall.post (разметка убирается)."""
    return _convert(text or "", "vk")