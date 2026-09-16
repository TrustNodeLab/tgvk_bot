"""Compositor — renders each frame (PIL) then encodes with FFmpeg.

Per scene:
  - background (topographic, subtle motion via seed drift)
  - media container (smart-cropped asset with zoom/pan)
  - overlay text + subtitles burned in
  - transitions: crossfade via fade-in of next scene media (simple opacity)

Frame budget: 720x1280@30fps. 60s video = 1800 frames.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Sequence

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .background import render_topographic_frame
from .crop import crop_window_for_time, smart_crop
from .subtitles import chunk_words

COLOR_TEXT = (238, 240, 246)
COLOR_ACCENT = (56, 130, 255)
COLOR_SUB = (255, 255, 255)

# Layout (relative to 720x1280)
MEDIA_BOX = (0.08, 0.16, 0.92, 0.92)     # center container for asset
OVERLAY_Y = 0.92                          # bottom band at 92% height
SUB_Y = 0.90


def _load_font(size: int) -> ImageFont.FreeTypeFont:
    candidates = [
        Path("fonts/Exo2-Variable.ttf"),
        Path(__file__).resolve().parents[2] / "fonts" / "Exo2-Variable.ttf",
    ]
    for c in candidates:
        if c.exists():
            try:
                return ImageFont.truetype(str(c), size)
            except Exception:
                pass
    return ImageFont.load_default()


def _truncate(text: str, max_chars: int) -> str:
    return text if len(text) <= max_chars else text[: max_chars - 1] + "…"


def _alpha_overlay(base: Image.Image, text: str, y_frac: float, accent: bool = False, size: int = 52) -> Image.Image:
    """Draw centered overlay text at y_frac with subtle dark pill behind."""
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font = _load_font(size)
    text = _truncate(text, 34)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (base.width - tw) // 2 - bbox[0]
    y = int(base.height * y_frac) - th // 2 - bbox[1]
    # pill
    pad_x, pad_y = 28, 14
    pill = [x + bbox[0] - pad_x, y + bbox[1] - pad_y, x + bbox[0] + tw + pad_x, y + bbox[1] + th + pad_y]
    draw.rounded_rectangle(pill, radius=22, fill=(8, 10, 16, 160), outline=(*COLOR_ACCENT, 60) if accent else None, width=2)
    color = COLOR_ACCENT if accent and False else COLOR_TEXT
    draw.text((x, y), text, font=font, fill=(*color, 255))
    if base.mode != "RGBA":
        base = base.convert("RGBA")
    return Image.alpha_composite(base, overlay)


def _draw_subtitles(base: Image.Image, line: dict) -> Image.Image:
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font = _load_font(38)
    text = _truncate(line["text"], 60)
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (base.width - tw) // 2 - bbox[0]
    y = int(base.height * 0.875) - bbox[1]
    # soft shadow outline for readability on any bg
    for dx in (-2, 0, 2):
        for dy in (-2, 0, 2):
            draw.text((x + dx, y + dy), text, font=font, fill=(0, 0, 0, 200))
    draw.text((x, y), text, font=font, fill=(*COLOR_SUB, 255))
    if base.mode != "RGBA":
        base = base.convert("RGBA")
    return Image.alpha_composite(base, overlay)


class Compositor:
    def __init__(self, width: int = 720, height: int = 1280, fps: int = 30):
        self.w = width
        self.h = height
        self.fps = fps

    def render_scene_frame(
        self,
        bg: Image.Image,
        asset: Image.Image | None,
        t_in_scene: float,
        scene_dur: float,
        overlay_text: str = "",
        subtitle_line: dict | None = None,
        seed: int = 0,
        motion: str = "kenburns",
    ) -> Image.Image:
        """One frame. bg is pre-rendered static background (we re-render per frame with drift)."""
        frame = bg.copy()

        # Media container
        if asset is not None:
            win = crop_window_for_time(asset, t_in_scene, scene_dur, tw=int(self.w * 0.84), th=int(self.h * 0.76), motion=motion)
            # rounded mask
            mask = Image.new("L", win.size, 0)
            md = ImageDraw.Draw(mask)
            md.rounded_rectangle([0, 0, win.width, win.height], radius=28, fill=255)
            bw, bh = win.size
            bx = (self.w - bw) // 2
            by = int(self.h * 0.52) - bh // 2
            frame.paste(win, (bx, by), mask)
            # subtle border
            border = Image.new("RGBA", frame.size, (0, 0, 0, 0))
            bd = ImageDraw.Draw(border)
            bd.rounded_rectangle([bx, by, bx + bw, by + bh], radius=28, outline=(255, 255, 255, 36), width=2)
            frame = Image.alpha_composite(frame.convert("RGBA"), border).convert("RGB")

        if overlay_text:
            frame = _alpha_overlay(frame, overlay_text, OVERLAY_Y - 0.06, accent=True)
        if subtitle_line:
            frame = _draw_subtitles(frame, subtitle_line)
        return frame

    def build_frames(
        self,
        scenes: Sequence[dict],
        assets: dict[int, Image.Image],
        subtitle_map: dict[int, list[dict]],
        out_dir: Path,
        seed: int = 0,
    ) -> int:
        """Render all frames to out_dir/frame_%05d.png. Returns frame count."""
        out_dir.mkdir(parents=True, exist_ok=True)
        bg = render_topographic_frame((self.w, self.h), seed=seed)
        idx = 0
        for scene in scenes:
            sid = scene["id"]
            asset = assets.get(sid)
            dur = scene["end_s"] - scene["start_s"]
            sub_lines = subtitle_map.get(sid, [])
            n_frames = max(1, int(round(dur * self.fps)))
            for f in range(n_frames):
                t = f / self.fps
                line = None
                for ln in sub_lines:
                    if ln["start"] <= t <= ln["end"] + 1e-6:
                        line = ln
                        break
                frame = self.render_scene_frame(
                    bg,
                    asset,
                    t,
                    dur,
                    overlay_text=scene.get("overlay", ""),
                    subtitle_line=line,
                    seed=seed + sid,
                    motion=scene.get("motion", "kenburns"),
                )
                frame.save(out_dir / f"frame_{idx + 1:05d}.png")
                idx += 1
        return idx


def build_scene_timeline(scenes_with_words: Sequence[dict]) -> tuple[list[dict], dict[int, list[dict]]]:
    """From scenes (each with words list) produce absolute timeline + subtitle map.

    Scenes: [{id, start, end, words: [{w,start_s,end_s}]}]
    Returns (scene_abs, sub_map) where scene_abs has absolute start/end and
    sub_map[sid] = subtitle lines with absolute times.
    """
    scene_abs: list[dict] = []
    sub_map: dict[int, list[dict]] = {}
    cursor = 0.0
    for sc in scenes_with_words:
        dur = sc["end"] - sc["start"]
        start = cursor
        end = cursor + dur
        words_abs = []
        for w in sc.get("words", []):
            ws, we = w["start_s"], w["end_s"]
            # clamp word times within scene duration
            words_abs.append({"w": w["w"], "start_s": start + ws, "end_s": start + min(we, dur)})
        lines = chunk_words(words_abs)
        sub_map[sc["id"]] = lines
        scene_abs.append({**sc, "start_s": start, "end_s": end, "words": words_abs})
        cursor = end
    return scene_abs, sub_map