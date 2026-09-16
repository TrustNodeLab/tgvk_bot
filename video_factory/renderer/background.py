"""Programmatic topographic background — dark minimal, no external video asset.

Generates a PIL frame (or an animated sequence via render loop) with:
  - deep dark base gradient
  - topographic contour lines (deterministic from seed)
  - subtle accent glow
  - optional masked center container area (kept clean for media)

Cost class: generated image (cheapest tier after cache/web/local).
"""

from __future__ import annotations

import math
import random
from typing import Sequence, Tuple

from PIL import Image, ImageDraw, ImageFilter

COLOR_BG_TOP = (10, 14, 24)      # #0A0E18
COLOR_BG_BOTTOM = (4, 6, 12)     # #04060C
COLOR_ACCENT = (56, 130, 255)    # electric blue
COLOR_ACCENT2 = (255, 64, 72)    # red accent
COLOR_LINE = (38, 52, 92)
COLOR_LINE_DIM = (24, 32, 58)


def _lerp(a: Tuple[int, int, int], b: Tuple[int, int, int], t: float) -> Tuple[int, int, int]:
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))  # type: ignore[return-value]


def _field(x: float, y: float, seed: int) -> float:
    """Deterministic pseudo-noise field for contour lines."""
    rnd = random.Random(seed)
    rnd.seed(seed)
    s = 0.0
    for i in range(3):
        ox, oy, amp, freq = rnd.uniform(-500, 500), rnd.uniform(-500, 500), rnd.uniform(0.25, 0.6), rnd.uniform(0.0018, 0.0045)
        s += amp * math.sin((x + ox) * freq) * math.cos((y + oy) * freq * 1.3)
    return s


def render_topographic_frame(
    size: Tuple[int, int] = (720, 1280),
    seed: int = 0,
    accent: Tuple[int, int, int] = COLOR_ACCENT,
    accent2: Tuple[int, int, int] = COLOR_ACCENT2,
    query: str = "",
    container: Tuple[float, float, float, float] | None = None,
) -> Image.Image:
    """Single 9:16 frame. container = (x0, y0, x1, y1) in 0..1 relative to keep clean."""
    w, h = size
    img = Image.new("RGB", (w, h))
    px = img.load()

    # Vertical gradient
    for y in range(h):
        t = y / max(1, h - 1)
        col = _lerp(COLOR_BG_TOP, COLOR_BG_BOTTOM, t)
        for x in range(w):
            px[x, y] = col

    # Deterministic contour lines: samples across field, draw iso-lines
    rnd = random.Random(seed)
    base = rnd.uniform(-0.4, 0.4)
    step = rnd.choice([0.18, 0.22, 0.26])
    levels = [base + i * step for i in range(6)]
    draw = ImageDraw.Draw(img, "RGBA")

    # Downsample field resolution for speed: draw coarse then upscale blur
    small = Image.new("L", (w // 2, h // 2))
    spx = small.load()
    for sy in range(h // 2):
        for sx in range(w // 2):
            v = _field(sx * 2, sy * 2, seed)
            spx[sx, sy] = int(128 + 120 * v / max(0.01, abs(v) + 0.5)) if v != 0 else 128
    small = small.filter(ImageFilter.GaussianBlur(2))
    small = small.resize((w, h), Image.BILINEAR)

    # Contour bands: mark pixels whose field value crosses a level
    band = Image.new("L", (w, h), 0)
    bpx = band.load()
    data = small.load()
    for y in range(h):
        for x in range(w):
            v = data[x, y] / 255.0 * 3.0 - 1.5  # normalize roughly to field range
            for lv in levels:
                if abs(v - lv) < 0.03:
                    bpx[x, y] = 255
                    break
    band = band.filter(ImageFilter.GaussianBlur(0.8))
    colored = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    colored.paste((*COLOR_LINE, 90), (0, 0), band)
    img = img.convert("RGBA")
    img.alpha_composite(colored)

    # Accent glows (subtle)
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    r = min(w, h) // 3
    cx, cy = w * 0.82, h * 0.14
    for i in range(60, 0, -4):
        alpha = int(18 * (1 - i / 60))
        gd.ellipse([cx - i, cy - i, cx + i, cy + i], fill=(*accent, alpha))
    cx2, cy2 = w * 0.15, h * 0.92
    for i in range(48, 0, -4):
        alpha = int(14 * (1 - i / 48))
        gd.ellipse([cx2 - i, cy2 - i, cx2 + i, cy2 + i], fill=(*accent2, alpha))
    img.alpha_composite(glow)

    # Dim the media container area so overlays stay readable
    if container is not None:
        dim = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        dd = ImageDraw.Draw(dim)
        x0, y0, x1, y1 = (int(container[0] * w), int(container[1] * h), int(container[2] * w), int(container[3] * h))
        dd.rounded_rectangle([x0, y0, x1, y1], radius=24, fill=(0, 0, 0, 60))
        img.alpha_composite(dim)

    out = img.convert("RGB")
    return out


def render_topographic_frames(size, seed, count: int = 1, fps: int = 30) -> Sequence[Image.Image]:
    """Animated variant: slowly drifting contours (for Ken-Burns-like motion)."""
    frames = []
    for i in range(count):
        frame = render_topographic_frame(size, seed=seed + i, query="", container=(0.08, 0.06, 0.92, 0.94))
        frames.append(frame)
    return frames