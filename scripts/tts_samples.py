#!/usr/bin/env python3
"""Сравнение всех доступных русских голосов для TTS.

Генерирует аудио-семплы одного и того же текста с prosody-обработкой
для каждого голоса: 4 Piper (dmitri/denis/ruslan/irina) + 2 edge-tts.

Использование:
  SAMPLE_TEXT="текст" python scripts/tts_samples.py

Выход: samples/manifest.json + файлы .wav/.mp3
"""
import json
import os
import subprocess
import sys

import numpy as np

# ── Конфигурация ──────────────────────────────────────────────────────────────
TEXT = os.environ.get(
    "SAMPLE_TEXT",
    "Кибербезопасность — это основа современного мира. "
    "Мошенники используют фишинг и социальную инженерию, чтобы украсть ваши данные. "
    "Согласитесь, это действительно важно!",
)

PIPER_VOICES = ["dmitri", "denis", "ruslan", "irina"]
EDGE_VOICES = ["ru-RU-DmitryNeural", "ru-RU-SvetlanaNeural"]
MODELS_DIR = os.environ.get("MODELS_DIR", "models")
OUT_DIR = os.environ.get("OUT_DIR", "samples")

# ── Piper: переиспользуем prosody из tts_server.py ────────────────────────────
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "bot"))
from tts_server import build_tts, synth_speech  # noqa: E402


def _rename_model(d: str, voice: str) -> None:
    """sherpa-onnx требует model.onnx, а tar кладёт ru_RU-{voice}-medium.onnx."""
    src_onnx = os.path.join(d, f"ru_RU-{voice}-medium.onnx")
    dst_onnx = os.path.join(d, "model.onnx")
    src_json = os.path.join(d, f"ru_RU-{voice}-medium.onnx.json")
    dst_json = os.path.join(d, "model.onnx.json")
    if os.path.exists(src_onnx) and not os.path.exists(dst_onnx):
        os.rename(src_onnx, dst_onnx)
    if os.path.exists(src_json) and not os.path.exists(dst_json):
        os.rename(src_json, dst_json)


def gen_piper(voice: str) -> tuple[str, str]:
    """Синтез одного Piper-голоса → WAV с prosody → (путь, формат)."""
    d = os.path.join(MODELS_DIR, f"vits-piper-ru_RU-{voice}-medium")
    _rename_model(d, voice)
    tts = build_tts(d)
    wav_bytes, _sr = synth_speech(tts, TEXT)
    path = os.path.join(OUT_DIR, f"piper_{voice}.wav")
    with open(path, "wb") as f:
        f.write(wav_bytes)
    return path, "wav"


def gen_edge(voice: str) -> tuple[str, str]:
    """Синтез одного edge-tts голоса → MP3 → (путь, формат)."""
    short = voice.split("-")[-1]  # DmitryNeural
    path = os.path.join(OUT_DIR, f"edge_{short}.mp3")
    subprocess.run(
        [sys.executable, "-m", "edge_tts",
         "--voice", voice, "--rate=-5%", "--pitch=-1Hz",
         "--text", TEXT, "--write-media", path],
        check=True,
        capture_output=True,
    )
    return path, "mp3"


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    results: list[tuple[str, str, str]] = []

    print("🎙️  Piper (prosody: speed 0.9, паузы, питч):")
    for v in PIPER_VOICES:
        try:
            path, fmt = gen_piper(v)
            label = f"Piper {v.capitalize()}"
            sz = os.path.getsize(path)
            results.append((label, path, fmt))
            print(f"  ✅ {label}: {sz:,} bytes")
        except Exception as e:
            print(f"  ❌ {v}: {e}")

    print("🗣️  Edge-TTS (нейросеть Microsoft):")
    for v in EDGE_VOICES:
        try:
            path, fmt = gen_edge(v)
            short = v.split("-")[-1]
            label = f"Edge {short}"
            sz = os.path.getsize(path)
            results.append((label, path, fmt))
            print(f"  ✅ {label}: {sz:,} bytes")
        except Exception as e:
            print(f"  ❌ {v}: {e}")

    manifest = [[name, path, fmt] for name, path, fmt in results]
    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    print(f"\n📁 {len(results)} семплов → {OUT_DIR}/")
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
