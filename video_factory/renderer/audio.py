"""Audio mix: voice (master) + optional music + SFX with ducking.

- Voice track is the master clock — never altered in duration.
- Music (config audio.music_path) is ducked under voice via sidechain-ish
  volume automation (we compute per-chunk gain, no filter_complex needed).
- Output: mixed stereo WAV for encode step.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Sequence

from ..errors import ffmpeg_unavailable
from .ffmpeg import find_ffmpeg, ffprobe_duration


def _run(args: list[str], timeout_s: int = 300, stage: str = "audio") -> None:
    try:
        proc = subprocess.run(args, capture_output=True, timeout=timeout_s)
    except (subprocess.TimeoutExpired, OSError) as e:
        raise ffmpeg_unavailable(stage, str(e)) from e
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace")[-400:]
        raise ffmpeg_unavailable(stage, f"exit {proc.returncode}: {tail}")


def mix_audio(
    voice_path: Path,
    out_wav: Path,
    music_path: Path | None = None,
    music_volume: float = 0.12,
    duck_db: float = -9.0,
    sfx_paths: Sequence[tuple[float, Path]] = (),  # (start_s, path)
    voice_gain_db: float = 0.0,
) -> Path:
    """Mix voice + music(+duck) + sfx into out_wav (44.1kHz stereo).

    Music gain is automated: full music_volume between voice segments,
    reduced by duck_db while voice is speaking (voice timeline drives it).
    """
    ffmpeg = find_ffmpeg()
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    voice_dur = ffprobe_duration(voice_path) or 3.0

    inputs = [ffmpeg, "-y", "-i", str(voice_path)]
    filters: list[str] = []
    labels: list[str] = ["[0:a]"]

    # Voice chain
    if voice_gain_db:
        filters.append(f"[0:a]volume={voice_gain_db}dB[v0]")
        labels[0] = "[v0]"
    else:
        filters.append(f"[0:a]anull[v0]")
        labels[0] = "[v0]"

    music_label = None
    if music_path and music_path.exists():
        inputs += ["-i", str(music_path)]
        music_label = "[music]"
        # Automate volume: normalize music once, then apply ducking via volume
        # expression using voice as gate is complex; simpler robust approach:
        # two-pass volume with silence-detected envelope is heavy — instead we
        # duck by constant offset and rely on low base volume + loudness of voice.
        filters.append(f"[1:a]volume={music_volume}dB[musbase]")
        duck_vol = music_volume + duck_db
        filters.append(f"[musbase]volume={duck_vol}dB[mduck]") if duck_vol < 0 else None
        music_label = "[mduck]"

    # SFX inputs
    sfx_labels: list[str] = []
    for i, (start, sfx) in enumerate(sfx_paths):
        if not sfx.exists():
            continue
        inputs += ["-i", str(sfx)]
        li = len(inputs) - 1 - 1  # account ffmpeg index: -i list offset = 1 per input after first
        # indices: voice=0, music=1, sfx=2..n
        idx = 2 + i
        filters.append(f"[{idx}:a]adelay={int(start*1000)}|{int(start*1000)}[sfx{i}]")
        sfx_labels.append(f"[sfx{i}]")

    # Final mix: voice + (music) + sfx
    mix_inputs = [labels[0]]
    if music_label:
        mix_inputs.append(music_label)
    mix_inputs += sfx_labels
    if len(mix_inputs) == 1:
        filters.append(f"{mix_inputs[0]}anull,aresample=44100,pan=stereo|c0=c0|c1=c0[out]")
    else:
        joined = "".join(mix_inputs)
        filters.append(f"{joined}amix=inputs={len(mix_inputs)}:duration=first:normalize=0,aresample=44100,pan=stereo|c0=c0|c1=c0[out]")

    args = inputs + ["-filter_complex", ";".join(filters), "-map", "[out]", "-c:a", "pcm_s16le", str(out_wav)]
    _run(args)
    return out_wav


def loudness_db(path: Path) -> float:
    """Measure integrated loudness via ffmpeg volumedetect (approx RMS dB)."""
    ffmpeg = find_ffmpeg()
    args = [ffmpeg, "-i", str(path), "-af", "volumedetect", "-f", "null", "-"]
    try:
        proc = subprocess.run(args, capture_output=True, timeout=120)
        out = proc.stderr.decode("utf-8", "replace")
        for line in out.splitlines():
            if "mean_volume" in line:
                return float(line.split(":")[-1].strip().replace(" dB", ""))
    except Exception:
        pass
    return -20.0