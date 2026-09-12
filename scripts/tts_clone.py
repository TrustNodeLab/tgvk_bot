#!/usr/bin/env python3
"""XTTS-v2 voice cloning pipeline (CPU, headless — no TTS.api, no input()).

Low-level Coqui XTTS API: XttsConfig + Xtts.init_from_config + model.synthesize.
Model auto-downloaded via huggingface_hub.snapshot_download('coqui/XTTS-v2').
Ru supported natively (16 languages).

Exports:
    load_xtts_model() -> (cfg, model)      (downloads ~1.8GB on first call)
    synth_to_file(cfg, model, text, ref, out, lang='ru', speed=1.0, pitch=0.0)
        -> writes int16 PCM wav (sr=24000) with np.interp speed/pitch post
main() = single-shot CLI driven by env vars (REF_AUDIO/TEXT/OUT/LANG/SPEED/PITCH).
"""

import os
import sys
import time

VALID_LANGS = {"en", "es", "fr", "de", "it", "pt", "pl", "tr", "ru",
               "nl", "cs", "ar", "zh-cn", "ja", "hu", "ko"}


def log(msg: str) -> None:
    print(f"[clone] {msg}", flush=True)


def load_xtts_model():
    """Download (if needed) + init XTTS-v2 on CPU. Returns (cfg, model)."""
    t0 = time.time()
    from huggingface_hub import snapshot_download
    from TTS.tts.configs.xtts_config import XttsConfig
    from TTS.tts.models.xtts import Xtts

    mdir = snapshot_download("coqui/XTTS-v2")
    log(f"model dir: {mdir} ({time.time()-t0:.0f}s download/check)")

    cfg = XttsConfig()
    cfg.load_json(os.path.join(mdir, "config.json"))
    model = Xtts.init_from_config(cfg)
    model.load_checkpoint(cfg, checkpoint_dir=mdir, eval=True)
    model.cpu()
    log(f"model ready in {time.time()-t0:.1f}s")
    return cfg, model


def synth_to_file(cfg, model, text: str, ref: str, out: str,
                  lang: str = "ru", speed: float = 1.0, pitch: float = 0.0) -> int:
    """Synthesize one utterance; returns 0 ok / nonzero fail."""
    import numpy as np
    from scipy.io import wavfile

    if not os.path.isfile(ref):
        log(f"ERROR: образец не найден: {ref}")
        return 2

    try:
        out_dict = model.synthesize(text, cfg, speaker_wav=ref, language=lang)
    except Exception as e:
        log(f"ERROR synthesize: {e}")
        return 1
    wav = out_dict.get("wav")
    if wav is None:
        log("ERROR: no wav in synthesize result")
        return 1
    if hasattr(wav, "cpu"):  # torch tensor
        wav = wav.detach().cpu().numpy()
    samples = np.asarray(wav, dtype=np.float32).reshape(-1)
    sr = 24000

    # speed: linear resample
    if speed != 1.0 and 0.5 < speed < 2.0:
        n_out = int(len(samples) / speed)
        x_old = np.linspace(0.0, 1.0, len(samples), endpoint=False)
        x_new = np.linspace(0.0, 1.0, n_out, endpoint=False)
        samples = np.interp(x_new, x_old, samples).astype(np.float32)

    # pitch: resample up/down then back (semitones)
    if pitch != 0.0 and abs(pitch) >= 0.01:
        f = 2.0 ** (pitch / 12.0)
        n_p = int(len(samples) * f)
        x_old = np.linspace(0.0, 1.0, len(samples), endpoint=False)
        x_new = np.linspace(0.0, 1.0, n_p, endpoint=False)
        pitched = np.interp(x_new, x_old, samples).astype(np.float32)
        x_old2 = np.linspace(0.0, 1.0, len(pitched), endpoint=False)
        x_new2 = np.linspace(0.0, 1.0, len(samples), endpoint=False)
        samples = np.interp(x_new2, x_old2, pitched).astype(np.float32)

    out_i16 = (samples * 32767.0).clip(-32768, 32767).astype(np.int16)
    os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
    wavfile.write(out, sr, out_i16)
    log(f"OK {len(text)} chars -> {os.path.getsize(out)} bytes ({out})")
    return 0


def main() -> int:
    ref = os.environ.get("REF_AUDIO", "")
    text = os.environ.get("TEXT", "")
    out = os.environ.get("OUT", "out_clone.wav")
    lang = os.environ.get("LANG", "ru").lower()
    speed = float(os.environ.get("SPEED", "1.0"))
    pitch = float(os.environ.get("PITCH", "0"))

    if not ref or not text:
        log("ERROR: нужны REF_AUDIO и TEXT")
        return 2
    if lang not in VALID_LANGS:
        log(f"ERROR: LANG='{lang}' не поддерживается. Допустимо: {sorted(VALID_LANGS)}")
        return 2

    log(f"ref={ref} lang={lang} speed={speed} pitch={pitch:+g} text_len={len(text)}")
    cfg, model = load_xtts_model()

    # warm-up (first synthesis is slow)
    t0 = time.time()
    tmp_warm = os.path.join(os.path.dirname(os.path.abspath(out)) or ".", "_warmup.wav")
    synth_to_file(cfg, model, "Привет.", ref, tmp_warm, lang=lang)
    try:
        os.remove(tmp_warm)
    except OSError:
        pass
    log(f"warmup done in {time.time()-t0:.1f}s")

    t0 = time.time()
    rc = synth_to_file(cfg, model, text, ref, out, lang=lang, speed=speed, pitch=pitch)
    log(f"main synth done in {time.time()-t0:.1f}s")
    return rc


if __name__ == "__main__":
    sys.exit(main())