"""Smart crop & asset normalization for 9:16.

- Normalize any input image to 720x1280 with smart crop (attention heuristic).
- Keep center container clean; avoid cutting faces (upper-third bias heuristic).
- Motion: subtle zoom/pan over the still via crop window animation.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Tuple

from PIL import Image, ImageFilter, ImageOps

TARGET_W, TARGET_H = 720, 1280
TARGET_RATIO = TARGET_W / TARGET_H  # 0.5625


def open_safe(path: Path, max_pixels: int = 40_000_000) -> Image.Image:
    img = Image.open(path)
    img.load()
    if img.width * img.height > max_pixels:
        scale = math.sqrt(max_pixels / (img.width * img.height))
        img = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
    return img.convert("RGB")


def _attention_bias(img: Image.Image) -> Tuple[float, float, float]:
    """Return (cx01, cy01, weight): heuristic attention center.

    Uses luminance variance per region — bright/detailed areas (often faces/text)
    pull the crop window. Cheap saliency proxy, no ML deps.
    """
    small = img.resize((64, 113), Image.BILINEAR)  # 9:16-ish thumbnail
    gray = ImageOps.grayscale(small)
    px = gray.load()
    w, h = small.size
    total = 0.0
    cx, cy = 0.0, 0.0
    # 3x3 variance grid
    grid = [[0.0] * 3 for _ in range(3)]
    for gy in range(3):
        for gx in range(3):
            vals = []
            for y in range(gy * h // 3, (gy + 1) * h // 3):
                for x in range(gx * w // 3, (gx + 1) * w // 3):
                    vals.append(px[x, y])
            mean = sum(vals) / max(1, len(vals))
            var = sum((v - mean) ** 2 for v in vals) / max(1, len(vals))
            grid[gy][gx] = var + mean / 255.0 * 10.0
    for gy in range(3):
        for gx in range(3):
            weight = grid[gy][gx]
            total += weight
            cx += (gx + 0.5) / 3.0 * weight
            cy += (gy + 0.5) / 3.0 * weight
    if total <= 0:
        return 0.5, 0.5, 0.0
    return cx / total, cy / total, total


def smart_crop(img: Image.Image, tw: int = TARGET_W, th: int = TARGET_H, seed: int = 0) -> Image.Image:
    """Crop to exact tw x th targeting attention region."""
    iw, ih = img.size
    target = tw / th
    src_ratio = iw / ih

    if src_ratio > target:
        # too wide: crop width, keep full height
        cw = int(ih * target)
        cx_att, cy_att, wgt = _attention_bias(img)
        if wgt > 0:
            cx = int(cx_att * (iw - cw))
        else:
            cx = (iw - cw) // 2
        cx = max(0, min(iw - cw, cx))
        box = (cx, 0, cx + cw, ih)
    else:
        # too tall: crop height, keep full width
        ch = int(iw / target)
        cx_att, cy_att, wgt = _attention_bias(img)
        # bias toward upper-third for faces
        cy_att = min(cy_att, 0.6) if wgt > 0 else 0.5
        if wgt > 0:
            cy = int(cy_att * (ih - ch))
        else:
            cy = (ih - ch) // 2
        cy = max(0, min(ih - ch, cy))
        box = (0, cy, iw, cy + ch)

    cropped = img.crop(box)
    return cropped.resize((tw, th), Image.LANCZOS)


def crop_window_for_time(
    img: Image.Image,
    t: float,
    dur: float,
    tw: int = TARGET_W,
    th: int = TARGET_H,
    motion: str = "kenburns",
) -> Image.Image:
    """Extract the frame at time t with subtle zoom/pan motion over `dur` seconds.

    motion: 'kenburns' (slow zoom in), 'pan' (left→right), 'none' (static smart crop).
    """
    base = smart_crop(img)
    if motion == "none" or dur <= 0:
        return base
    progress = min(1.0, max(0.0, t / dur))
    if motion == "pan":
        # zoom 1.08, move crop window horizontally
        zoom = 1.08
        zw, zh = int(tw * zoom), int(th * zoom)
        window = base.resize((zw, zh), Image.LANCZOS)
        max_x = zw - tw
        x = int(max_x * progress)
        return window.crop((x, (zh - th) // 2, x + tw, (zh - th) // 2 + th))
    if motion == "zoomout":
        zoom_start, zoom_end = 1.12, 1.0
        z = zoom_start + (zoom_end - zoom_start) * progress
        zw, zh = int(tw * z), int(th * z)
        window = base.resize((zw, zh), Image.LANCZOS)
        x, y = (zw - tw) // 2, (zh - th) // 2
        return window.crop((x, y, x + tw, y + th))
    # default kenburns: slow zoom in 1.0 -> 1.1
    z = 1.0 + 0.10 * progress
    zw, zh = int(tw * z), int(th * z)
    window = base.resize((zw, zh), Image.LANCZOS)
    x, y = (zw - tw) // 2, (zh - th) // 2
    return window.crop((x, y, x + tw, y + th))


def normalize_asset(src: Path, out: Path, tw: int = TARGET_W, th: int = TARGET_H) -> Path:
    """Open, smart-crop, resize to exact 9:16 and save PNG."""
    img = open_safe(src)
    cropped = smart_crop(img, tw, th)
    out.parent.mkdir(parents=True, exist_ok=True)
    cropped.save(out, format="PNG")
    return out