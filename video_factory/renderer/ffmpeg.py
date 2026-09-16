"""FFmpeg helpers — safe subprocess (args array, no shell interpolation).

find_ffmpeg(): imageio-ffmpeg binary or PATH ffmpeg.
encode_frames(): PNG frames -> H.264/AAC MP4 (yuv420p, faststart).
ffprobe_duration / ffprobe_info(): validation probes.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

from ..errors import ffmpeg_unavailable


def find_ffmpeg() -> str:
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        exe = shutil.which("ffmpeg")
        if exe:
            return exe
    raise ffmpeg_unavailable("render", "ffmpeg not found (install imageio-ffmpeg or ffmpeg)")


def find_ffprobe() -> str | None:
    exe = shutil.which("ffprobe")
    if exe:
        return exe
    ffmpeg = Path(find_ffmpeg())
    sibling = ffmpeg.parent / "ffprobe.exe" if os.name == "nt" else ffmpeg.parent / "ffprobe"
    return str(sibling) if sibling.exists() else None


def _run(args: list[str], timeout_s: int = 600, stage: str = "render") -> subprocess.CompletedProcess:
    try:
        return subprocess.run(args, capture_output=True, timeout=timeout_s)
    except subprocess.TimeoutExpired as e:
        raise ffmpeg_unavailable(stage, f"timeout after {timeout_s}s") from e
    except OSError as e:
        raise ffmpeg_unavailable(stage, str(e)) from e


def encode_frames(
    frames_glob: str,
    out_mp4: Path,
    fps: int = 30,
    width: int = 720,
    height: int = 1280,
    crf: int = 23,
    audio: Path | None = None,
    preset: str = "medium",
    timeout_s: int = 1200,
) -> Path:
    """Frame sequence -> MP4. `frames_glob` e.g. 'work/job/frames/frame_%05d.png'."""
    ffmpeg = find_ffmpeg()
    out_mp4.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_mp4.with_suffix(".tmp.mp4")
    args = [
        ffmpeg, "-y",
        "-framerate", str(fps),
        "-i", frames_glob,
    ]
    if audio is not None:
        args += ["-i", str(audio)]
    args += [
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-pix_fmt", "yuv420p",
        "-vf", f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black",
        "-movflags", "+faststart",
        "-r", str(fps),
        "-c:a", "aac", "-b:a", "192k", "-shortest" if audio is not None else "-an",
        "-t", str(60 * 5),
        str(tmp),
    ]
    # -shortest placement must come as output option; rebuild cleanly:
    args = args[:-1]  # drop previous -t
    out_opts = ["-movflags", "+faststart", "-r", str(fps)]
    if audio is not None:
        out_opts += ["-c:a", "aac", "-b:a", "192k", "-shortest"]
    else:
        out_opts += ["-an"]
    args = [
        ffmpeg, "-y", "-framerate", str(fps), "-i", frames_glob,
    ]
    if audio is not None:
        args += ["-i", str(audio)]
    args += ["-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-pix_fmt", "yuv420p", "-vf", f"scale={width}:{height}"]
    args += out_opts + [str(tmp)]
    proc = _run(args, timeout_s=timeout_s)
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace")[-500:]
        raise ffmpeg_unavailable("render", f"encode failed ({proc.returncode}): {tail}")
    tmp.rename(out_mp4)
    return out_mp4


def make_silence_wav(out_wav: Path, duration_s: float) -> Path:
    ffmpeg = find_ffmpeg()
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    args = [ffmpeg, "-y", "-f", "lavfi", "-i", f"anullsrc=r=44100:cl=mono", "-t", f"{duration_s:.2f}", "-c:a", "pcm_s16le", str(out_wav)]
    proc = _run(args, timeout_s=60, stage="tts")
    if proc.returncode != 0:
        raise ffmpeg_unavailable("tts", "silence gen failed")
    return out_wav


def _probe_duration_via_ffmpeg(path: Path) -> float:
    """Fallback: get duration by running ffmpeg -i and parsing 'Duration:' from stderr."""
    ffmpeg_bin = find_ffmpeg()
    if not ffmpeg_bin:
        return 0.0
    args = [ffmpeg_bin, "-i", str(path)]
    proc = _run(args, timeout_s=30, stage="validate")
    # ffmpeg -i <file> writes metadata to stderr (even on error because no output specified)
    text = proc.stderr.decode("utf-8", errors="replace")
    import re as _re
    m = _re.search(r"Duration:\s*(\d{2}):(\d{2}):(\d{2})\.(\d+)", text)
    if not m:
        return 0.0
    h, mn, s, frac = int(m[1]), int(m[2]), int(m[3]), int(m[4])
    # frac is centiseconds (2 digits) or milliseconds (3 digits)
    ms_div = 100 if len(m[4]) <= 2 else 1000
    return h * 3600 + mn * 60 + s + int(frac) / ms_div


def ffprobe_duration(path: Path) -> float:
    probe = find_ffprobe()
    if not probe:
        return _probe_duration_via_ffmpeg(path)
    args = [probe, "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)]
    proc = _run(args, timeout_s=30, stage="validate")
    if proc.returncode != 0:
        return 0.0
    try:
        return float(json.loads(proc.stdout.decode())["format"]["duration"])
    except Exception:
        return 0.0


def _probe_info_via_ffmpeg(path: Path) -> dict:
    """Parse `ffmpeg -i` stderr into {streams, duration_s} when ffprobe is unavailable."""
    import re as _re

    ffmpeg_bin = find_ffmpeg()
    if not ffmpeg_bin:
        return {}
    proc = _run([ffmpeg_bin, "-i", str(path)], timeout_s=30, stage="validate")
    text = proc.stderr.decode("utf-8", "replace")
    streams = []
    # Stream lines: "  Stream #0:0(und): Video: h264 (High) (avc1 ...), yuv420p(tv, progressive), 720x1280, ..."
    for line in text.splitlines():
        m = _re.search(r"Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: (\w+): ([\w-]+)", line)
        if not m:
            continue
        st = {"index": len(streams), "codec_type": m.group(1).lower(), "codec_name": m.group(2).split()[0].lower()}
        if m.group(1).lower() == "video":
            pm = _re.search(r",\s*([\w]+(?:\([^)]*\))?),\s*(\d{2,4})x(\d{2,4})", line)
            if pm:
                st["pix_fmt"] = pm.group(1).split("(")[0]
                st["width"], st["height"] = int(pm.group(2)), int(pm.group(3))
        streams.append(st)
    return {"streams": streams}


def ffprobe_info(path: Path) -> dict:
    probe = find_ffprobe()
    if not probe:
        return _probe_info_via_ffmpeg(path)
    args = [probe, "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)]
    proc = _run(args, timeout_s=30, stage="validate")
    if proc.returncode != 0:
        return {}
    try:
        return json.loads(proc.stdout.decode())
    except Exception:
        return {}


def has_black_frames(path: Path, threshold: float = 0.98, duration_s: float = 1.0) -> bool:
    """Detect (near-)all-black segment via ffmpeg blackdetect. Returns True if found."""
    ffmpeg = find_ffmpeg()
    args = [ffmpeg, "-i", str(path), "-vf", f"blackdetect=d={duration_s}:pix_th={threshold}", "-an", "-f", "null", "-"]
    proc = _run(args, timeout_s=120, stage="validate")
    out = proc.stderr.decode("utf-8", "replace")
    return "black_start" in out