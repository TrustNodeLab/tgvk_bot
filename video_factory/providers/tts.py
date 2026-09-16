"""TTS provider: voicestudio (XTTS) / edge / elevenlabs / test.

Interface: synthesize(text, voice, out_path) -> TTSSegment with timing info.
Timing (word boundaries) is the master clock for the whole timeline.

TTSSegment: {path, duration_s, words: [{w, start_s, end_s}]}
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..config import Config
from ..logging import get_logger

log = get_logger("vf.tts")


@dataclass
class TTSSegment:
    path: Path
    duration_s: float
    words: list[dict] = field(default_factory=list)  # [{w, start_s, end_s}]
    provider: str = ""

    def to_dict(self) -> dict:
        return {"path": str(self.path), "duration_s": round(self.duration_s, 3), "words": self.words, "provider": self.provider}


def _probe_duration(path: Path) -> float:
    """Duration via ffprobe if available, else fallback estimate."""
    try:
        from ..renderer.ffmpeg import ffprobe_duration

        d = ffprobe_duration(path)
        if d:
            return d
    except Exception:
        pass
    # Fallback: rough estimate for mp3 via header bitrate
    try:
        data = path.read_bytes()[: 100_000]
        # Look for an MPEG audio frame header near start
        for i in range(len(data) - 4):
            if data[i] == 0xFF and (data[i + 1] & 0xE0) == 0xE0:
                bitrate_idx = (data[i + 2] >> 4) & 0x0F
                bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
                kbps = bitrates[bitrate_idx] if bitrate_idx < 16 else 128
                if kbps:
                    return (path.stat().st_size * 8) / (kbps * 1000)
                break
    except Exception:
        pass
    return 3.0


def _split_words(text: str) -> list[str]:
    return [w for w in re.split(r"\s+", text.strip()) if w]


def _proportional_words(text: str, dur: float) -> list[dict]:
    """Assign word timings proportionally by character length (fallback)."""
    words = _split_words(text)
    total_chars = max(1, sum(len(w) for w in words))
    out = []
    t = 0.0
    for w in words:
        wd = dur * len(w) / total_chars
        out.append({"w": w, "start_s": round(t, 3), "end_s": round(t + wd, 3)})
        t += wd
    return out


class TestTTS:
    """Silent audio for dry-run / TEST_MODE (no network, no keys, no ffmpeg)."""

    def synthesize(self, text: str, voice: str, out_path: Path) -> TTSSegment:
        dur = max(1.2, min(8.0, len(text) / 14.0))  # ~14 chars/sec RU speech
        self._write_silence_wav(out_path, dur)
        return TTSSegment(path=out_path, duration_s=dur, words=_proportional_words(text, dur), provider="test")

    @staticmethod
    def _write_silence_wav(out_path: Path, dur: float, sample_rate: int = 24000, channels: int = 1, bits: int = 16):
        """Pure-python silent WAV (no ffmpeg needed)."""
        out_path.parent.mkdir(parents=True, exist_ok=True)
        num_samples = max(1, int(sample_rate * dur))
        data_size = num_samples * channels * (bits // 8)
        with open(out_path, "wb") as f:
            # RIFF header
            f.write(b"RIFF")
            f.write((36 + data_size).to_bytes(4, "little"))
            f.write(b"WAVE")
            # fmt chunk
            f.write(b"fmt ")
            f.write((16).to_bytes(4, "little"))
            f.write((1).to_bytes(2, "little"))  # PCM
            f.write(channels.to_bytes(2, "little"))
            f.write(sample_rate.to_bytes(4, "little"))
            f.write((sample_rate * channels * bits // 8).to_bytes(4, "little"))
            f.write((channels * bits // 8).to_bytes(2, "little"))
            f.write(bits.to_bytes(2, "little"))
            # data chunk (silence)
            f.write(b"data")
            f.write(data_size.to_bytes(4, "little"))
            f.write(b"\x00" * data_size)


class EdgeTTS:
    """Microsoft Edge neural voices — free, high quality RU."""
    # VOICE_MAP = {"ru": "ru-RU-DmitryNeural", "en": "en-US-GuyNeural"}
    def synthesize(self, text: str, voice: str, out_path: Path) -> TTSSegment:
        import edge_tts

        async def _run():
            communicate = edge_tts.Communicate(text, voice or "ru-RU-DmitryNeural")
            await communicate.save(str(out_path))

        import asyncio

        asyncio.run(_run())
        # Word boundaries via subprocess metadata (text) — approximate alignment:
        dur = _probe_duration(out_path)
        return TTSSegment(path=out_path, duration_s=dur, words=_proportional_words(text, dur), provider="edge")


class VoiceStudioTTS:
    """XTTS via local VoiceStudio server (port 3900, OpenAI-compatible /v1/audio/speech)."""

    def __init__(self, base_url: str = "http://127.0.0.1:3900/v1", voice: str = "alloy", timeout_s: int = 640):
        self.base_url = base_url.rstrip("/")
        self.voice = voice
        self.timeout_s = timeout_s

    def synthesize(self, text: str, voice: str | None, out_path: Path) -> TTSSegment:
        from ._http import _request

        body = json.dumps({
            "model": "tts-1",
            "input": text,
            "voice": voice or self.voice,
            "response_format": "mp3",
        }).encode("utf-8")
        raw, _ = _request(f"{self.base_url}/audio/speech", "POST", body, {"Content-Type": "application/json"}, timeout=self.timeout_s)
        out_path.write_bytes(raw if isinstance(raw, bytes) else str(raw).encode())
        dur = _probe_duration(out_path)
        return TTSSegment(path=out_path, duration_s=dur, words=_proportional_words(text, dur), provider="voicestudio")


class ElevenLabsTTS:
    def __init__(self, api_key: str, voice_id: str = "onwK4e9ZLuTAKqWW03F9"):
        self.api_key = api_key
        self.voice_id = voice_id

    def synthesize(self, text: str, voice: str | None, out_path: Path) -> TTSSegment:
        from ._http import _request

        body = json.dumps({"text": text, "model_id": "eleven_multilingual_v2", "voice_settings": {"stability": 0.5, "similarity_boost": 0.7}}).encode()
        raw, _ = _request(f"https://api.elevenlabs.io/v1/text-to-speech/{voice or self.voice_id}", "POST", body, {"xi-api-key": self.api_key, "Content-Type": "application/json"}, timeout=120)
        out_path.write_bytes(raw if isinstance(raw, bytes) else str(raw).encode())
        dur = _probe_duration(out_path)
        return TTSSegment(path=out_path, duration_s=dur, words=_proportional_words(text, dur), provider="elevenlabs")


class TTSProvider:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._adapter = self._build()

    def _build(self):
        p = self.cfg.providers()
        kind = (os.environ.get("TTS_PROVIDER") or p.get("tts") or "voicestudio").lower()
        if kind == "test":
            return TestTTS()
        if kind == "edge":
            return EdgeTTS()
        voicestudio_url = os.environ.get("VOICESTUDIO_URL") or p.get("voicestudio_url") or "http://127.0.0.1:3900/v1"
        if kind == "voicestudio":
            return VoiceStudioTTS(base_url=voicestudio_url, voice=os.environ.get("VOICESTUDIO_VOICE") or p.get("voicestudio_voice") or "alloy", timeout_s=int(os.environ.get("VOICESTUDIO_TIMEOUT") or p.get("voicestudio_timeout") or 640))
        if kind == "elevenlabs" and os.environ.get("ELEVENLABS_API_KEY"):
            return ElevenLabsTTS(os.environ["ELEVENLABS_API_KEY"], os.environ.get("VOICE_ID", "onwK4e9ZLuTAKqWW03F9"))
        # Unknown kind -> Voicestudio if reachable, else Edge
        return VoiceStudioTTS(base_url=voicestudio_url, voice=os.environ.get("VOICESTUDIO_VOICE") or "alloy")

    def voice_default(self) -> str:
        return os.environ.get("VOICE_DEFAULT") or (self.cfg.providers().get("voice") or "ru-RU-DmitryNeural")

    def synthesize(self, text: str, out_path: Path, voice: str | None = None) -> TTSSegment:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        seg = self._adapter.synthesize(text, voice or self.voice_default(), out_path)
        if seg.duration_s <= 0:
            seg.duration_s = 1.0
        return seg


def get_tts(cfg: Config) -> TTSProvider:
    return TTSProvider(cfg)