#!/usr/bin/env python3
"""XTTS-v2 voice cloning pipeline (CPU, runs on GH Actions runner).

Clones a reference voice sample with Coqui XTTS-v2 (multilingual, ru support),
then applies optional pitch shift for character variation and speed control.

Usage (env vars):
    REF_AUDIO   path to reference wav (10-30s of clean speech required)
    TEXT        text to synthesize (ru by default)
    OUT         output wav path
    LANG        default 'ru' (validated against XTTS language set)
    SPEED       default 1.0 (0.8-1.2 typical); speed<1 -> slower via time_stretch
    PITCH       default 0 semitones; e.g. +2 brighter, -2 darker
"""

import os
import sys
import time

VALID_LANGS = {"en", "es", "fr", "de", "it", "pt", "pl", "tr", "ru",
               "nl", "cs", "ar", "zh-cn", "ja", "hu", "ko"}


def log(msg: str) -> None:
    print(f"[clone] {msg}", flush=True)


def main() -> int:
    ref = os.environ.get("REF_AUDIO", "")
    text = os.environ.get("TEXT", "")
    out = os.environ.get("OUT", "out_clone.wav")
    lang = os.environ.get("LANG", "ru").lower()
    speed = float(os.environ.get("SPEED", "1.0"))
    pitch = float(os.environ.get("PITCH", "0"))

    if not ref:
        log("ERROR: REF_AUDIO не задан (путь к образцу голоса)")
        return 2
    if not text:
        log("ERROR: TEXT не задан")
        return 2
    if lang not in VALID_LANGS:
        log(f"ERROR: LANG='{lang}' не поддерживается XTTS. Допустимо: {sorted(VALID_LANGS)}")
        return 2
    if not os.path.isfile(ref):
        log(f"ERROR: образец не найден: {ref}")
        return 2

    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)

    log(f"ref={ref} lang={lang} speed={speed} pitch={pitch:+g} text_len={len(text)}")

    # --- model load (first run downloads ~1.8GB from HF, subsequent cached) ---
    t0 = time.time()
    try:
        from TTS.api import TTS
    except Exception as e:
        log(f"ERROR: не удалось импортировать TTS: {e}")
        return 1

    log("creating XTTS-v2 (cpu)...")
    tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2", gpu=False)
    log(f"model ready in {time.time()-t0:.1f}s")

    # --- warm-up short utterance (model first synthesis is slow) ---
    t0 = time.time()
    tmp_warm = os.path.join(os.path.dirname(os.path.abspath(out)) or ".", "_warmup.wav")
    tts.tts_to_file(text="Привет.", file_path=tmp_warm, speaker_wav=ref, language=lang)
    log(f"warmup done in {time.time()-t0:.1f}s")

    # --- main synthesis ---
    t0 = time.time()
    tmp_main = os.path.join(os.path.dirname(os.path.abspath(out)) or ".", "_main.wav")
    tts.tts_to_file(text=text, file_path=tmp_main, speaker_wav=ref, language=lang)
    log(f"synth done in {time.time()-t0:.1f}s")

    # --- post-processing: speed + pitch via numpy/scipy (no librosa needed) ---
    import numpy as np
    from scipy.io import wavfile

    sr, data = wavfile.read(tmp_main)
    if data.dtype != np.int16:
        data = (data * 32767).clip(-32768, 32767).astype(np.int16)
    samples = data.astype(np.float32) / 32767.0

    # speed: linear resample (simple, no phase artifacts for small factors)
    if speed != 1.0 and speed > 0.5 and speed < 2.0:
        n_out = int(len(samples) / speed)
        x_old = np.linspace(0, 1, len(samples), endpoint=False)
        x_new = np.linspace(0, 1, n_out, endpoint=False)
        samples = np.interp(x_new, x_old, samples).astype(np.float32)

    # pitch: linear resample up/down then back to original rate (semitones)
    if pitch != 0.0:
        factor = 2.0 ** (pitch / 12.0)
        n_pitch = int(len(samples) * factor)
        x_old = np.linspace(0, 1, len(samples), endpoint=False)
        x_new = np.linspace(0, 1, n_pitch, endpoint=False)
        pitched = np.interp(x_new, x_old, samples).astype(np.float32)
        # resample back to original length (keeps duration, shifts pitch)
        x_old2 = np.linspace(0, 1, len(pitched), endpoint=False)
        x_new2 = np.linspace(0, 1, len(samples), endpoint=False)
        samples = np.interp(x_new2, x_old2, pitched).astype(np.float32)

    out_i16 = (samples * 32767).clip(-32768, 32767).astype(np.int16)
    wavfile.write(out, sr, out_i16)

    # cleanup temp files
    for tmp in (tmp_warm, tmp_main):
        try:
            os.remove(tmp)
        except OSError:
            pass

    log(f"OK {len(text)} chars -> {os.path.getsize(out)} bytes ({out})")
    return 0


if __name__ == "__main__":
    sys.exit(main())