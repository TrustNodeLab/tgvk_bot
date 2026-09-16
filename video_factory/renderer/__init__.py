"""Renderer package: frame composition + FFmpeg encode + subtitle/audio assets."""

from .ffmpeg import encode_frames, find_ffmpeg, find_ffprobe, ffprobe_duration, ffprobe_info, has_black_frames, make_silence_wav
from .background import render_topographic_frame
from .crop import normalize_asset, smart_crop
from .subtitles import write_srt, write_ass_subs, write_ass_overlay, chunk_words
from .audio import mix_audio, loudness_db
from .compositor import Compositor, build_scene_timeline

__all__ = [
    "encode_frames", "find_ffmpeg", "find_ffprobe", "ffprobe_duration", "ffprobe_info",
    "has_black_frames", "make_silence_wav",
    "render_topographic_frame",
    "normalize_asset", "smart_crop",
    "write_srt", "write_ass_subs", "write_ass_overlay", "chunk_words",
    "mix_audio", "loudness_db",
    "Compositor", "build_scene_timeline",
]