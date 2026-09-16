"""Subtitles: SRT + ASS (burned-in) generation with Cyrillic support.

Timeline master = TTS word timestamps. Lines chunked to ~4 words / 40 chars.
"""

from __future__ import annotations

from pathlib import Path
from typing import Sequence

SRT_STYLE_HEADER = ""  # SRT has no style header


def _ts_srt(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _ts_ass(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    cs = int((seconds - int(seconds)) * 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def chunk_words(words: Sequence[dict], max_chars: int = 42, max_words: int = 5) -> list[dict]:
    """Group word timestamps into subtitle lines."""
    lines: list[dict] = []
    cur: list[dict] = []
    cur_chars = 0
    for w in words:
        wlen = len(w.get("w", ""))
        if cur and (cur_chars + wlen + 1 > max_chars or len(cur) >= max_words):
            lines.append({"start": cur[0]["start_s"], "end": cur[-1]["end_s"], "text": " ".join(x["w"] for x in cur)})
            cur, cur_chars = [], 0
        cur.append(w)
        cur_chars += wlen + 1
    if cur:
        lines.append({"start": cur[0]["start_s"], "end": cur[-1]["end_s"], "text": " ".join(x["w"] for x in cur)})
    return lines


def write_srt(path: Path, lines: Sequence[dict]) -> Path:
    parts = []
    for i, ln in enumerate(lines, start=1):
        parts.append(f"{i}\n{_ts_srt(ln['start'])} --> {_ts_srt(ln['end'])}\n{ln['text']}\n")
    path.write_text("\n".join(parts), encoding="utf-8")
    return path


ASS_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 720
PlayResY: 1280
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Sub,Exo 2,44,&H00FFFFFF,&H000000FF,&H00101418,&H96000000,-1,0,0,0,100,100,0,0,1,2.5,1.5,2,40,40,64,1
Style: Overlay,Exo 2,52,&H00FFFFFF,&H000000FF,&H00FF8236,&H96000000,-1,0,0,0,100,100,0,0,1,2.5,2,8,60,60,48,1
"""


def write_ass_subs(path: Path, lines: Sequence[dict]) -> Path:
    parts = [ASS_HEADER, "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
    for ln in lines:
        text = ln["text"].replace("{", "(").replace("}", ")")
        parts.append(f"Dialogue: 0,{_ts_ass(ln['start'])},{_ts_ass(ln['end'])},Sub,,0,0,0,,{text}")
    path.write_text("\n".join(parts), encoding="utf-8")
    return path


def write_ass_overlay(path: Path, entries: Sequence[dict]) -> Path:
    """overlay entries: [{start, end, text}] — big centered text at 8% from bottom."""
    parts = [ASS_HEADER, "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
    for e in entries:
        text = e["text"].replace("{", "(").replace("}", ")")
        parts.append(f"Dialogue: 0,{_ts_ass(e['start'])},{_ts_ass(e['end'])},Overlay,,0,0,0,,{text}")
    path.write_text("\n".join(parts), encoding="utf-8")
    return path