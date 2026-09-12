#!/usr/bin/env python3
"""Мини HTTP-сервер озвучки на sherpa-onnx (Piper, ru_RU-dmitri-medium).

Эмулирует OpenAI-совместимый VoiceStudio API, чтобы bot/video_gen.py
работал через TTS_PROVIDER=voicestudio БЕЗ docker:
  GET  /health              -> {"status":"ok"}
  GET  /v1/audio/voices     -> список голосов
  POST /v1/audio/speech     -> WAV bytes (model/voice/input/response_format)

«Живость» речи (S34h): скорость 0.9 + паузы между предложениями +
вариация темпа + питч-интонация (? вверх, ! вверх, конец вниз).

Использование:
  python bot/tts_server.py --model-dir /path/to/model_dir --port 3900
где model_dir содержит model.onnx + tokens.txt + espeak-ng-data/ (для Piper).
"""
import argparse
import io
import json
import re
import sys
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx

# --- Параметры «живости» (дефолты; пользователь может крутить флагами) ---
DEFAULT_SPEED = 0.9        # «чуть-чуть помедленнее» (1.0 = эталон Piper)
PAUSE_AFTER_PERIOD = 0.30  # сек паузы после «.» / «…»
PAUSE_AFTER_EMPHASIS = 0.42  # сек после «!» / «?»
PAUSE_AT_END = 0.55        # завершающая пауза после последнего предложения


def build_tts(model_dir: str) -> sherpa_onnx.OfflineTts:
    cfg = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=f"{model_dir}/model.onnx",
                tokens=f"{model_dir}/tokens.txt",
                lexicon="",
                data_dir=f"{model_dir}/espeak-ng-data",
                dict_dir="",
            ),
            num_threads=4,
            debug=False,
        ),
        rule_fsts="",
        max_num_sentences=1,
    )
    return sherpa_onnx.OfflineTts(cfg)


def _resample_linear(x: np.ndarray, factor: float) -> np.ndarray:
    """Линейная передискретизация. factor>1 => короче (выше питч)."""
    n_out = max(1, int(round(len(x) / factor)))
    idx = np.linspace(0.0, len(x) - 1.0, n_out)
    i0 = idx.astype(np.int64)
    i1 = np.minimum(i0 + 1, len(x) - 1)
    frac = idx - i0
    return x[i0] * (1.0 - frac) + x[i1] * frac


def pitch_shift(samples: np.ndarray, semitones: float) -> np.ndarray:
    """Сдвиг высоты тона без изменения длительности (±2 полутона — безопасно)."""
    if not semitones or abs(semitones) < 0.01:
        return samples
    f = 2.0 ** (semitones / 12.0)
    return _resample_linear(_resample_linear(samples, f), 1.0 / f)


def split_sentences(text: str):
    """Разбивает текст на предложения, сохраняя знак в конце каждого."""
    parts = re.split(r"(?<=[.!?…])", text.strip())
    return [p.strip() for p in parts if p.strip()]


def gen_samples(tts: sherpa_onnx.OfflineTts, text: str, speed: float,
                pitch: float) -> np.ndarray:
    """Синтез одного предложения -> float32 [-1..1] с питч-сдвигом."""
    result = tts.generate(text, sid=0, speed=speed)
    if not result or len(result.samples) == 0:
        raise RuntimeError("sherpa-onnx не вернул сэмплы (пустой текст?)")
    samples = np.asarray(result.samples, dtype=np.float32)
    if pitch:
        samples = pitch_shift(samples, pitch)
    return samples


def synth_speech(tts: sherpa_onnx.OfflineTts, text: str,
                 base_speed: float = DEFAULT_SPEED,
                 pause_period: float = PAUSE_AFTER_PERIOD,
                 pause_emph: float = PAUSE_AFTER_EMPHASIS,
                 pause_end: float = PAUSE_AT_END):
    """Синтез фразы с паузами и живой интонацией -> (wav_bytes, sample_rate).

    - Пауза между предложениями (после !/? длиннее).
    - Темп варьируется: короткие предложения чуть медленнее, длинные быстрее,
      плюс лёгкое чередование, чтобы не звучать монотонно.
    - Питч: ? вверх, ! вверх сильнее, последнее предложение вниз (завершение).
    """
    sentences = split_sentences(text)
    if not sentences:
        raise RuntimeError("пустой текст")
    sr = tts.sample_rate
    chunks: list[np.ndarray] = []
    n = len(sentences)
    for i, s in enumerate(sentences):
        is_last = (i == n - 1)
        end_char = s[-1] if s else "."

        speed = base_speed
        if len(s) < 35:
            speed = base_speed * 0.96          # короткие — чуть медленнее
        elif len(s) > 140:
            speed = base_speed * 1.03          # длинные — чуть быстрее
        elif i % 2:
            speed = base_speed * 0.99          # лёгкое чередование темпа
        else:
            speed = base_speed * 1.01

        pitch = 0.0
        if end_char == "?":
            pitch = 1.5                        # вопрос — тон вверх
        elif end_char == "!":
            pitch = 2.0                        # восклицание — ещё выше
        elif is_last:
            pitch = -1.5                       # финал — тон вниз (завершение)

        chunks.append(gen_samples(tts, s, speed, pitch))

        if is_last:
            chunks.append(np.zeros(int(sr * pause_end), dtype=np.float32))
        else:
            pause = pause_emph if end_char in "!?" else pause_period
            chunks.append(np.zeros(int(sr * pause), dtype=np.float32))

    full = np.concatenate(chunks)
    pcm = np.clip(full * 32767.0, -32768, 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue(), sr


class Handler(BaseHTTPRequestHandler):
    tts = None           # set at startup
    default_speed = DEFAULT_SPEED

    def log_message(self, fmt, *args):
        sys.stderr.write("[tts] %s\n" % (fmt % args))

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") == "/health" or self.path == "/":
            self._send_json({"status": "ok", "device": "cpu",
                             "version": "sherpa-piper-prosody"})
            return
        if self.path.rstrip("/") == "/v1/audio/voices":
            self._send_json([
                {"voice_id": "alloy", "id": "alloy", "name": "Piper Dmitri (ru)",
                 "type": "local", "description": "sherpa-onnx vits-piper-ru_RU-dmitri-medium"}
            ])
            return
        self._send_json({"error": "not found"}, 404)

    def do_POST(self):
        if self.path.rstrip("/") != "/v1/audio/speech":
            self._send_json({"error": "not found"}, 404)
            return
        try:
            ln = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(ln).decode("utf-8"))
            text = body.get("input", "")
            speed = float(body.get("speed") or self.default_speed)
            wav, sr = synth_speech(self.tts, text, speed)
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("[tts] ERROR: %r\n" % (e,))
            self._send_json({"error": str(e)}, 500)
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)
        # кол-во предложений для диагностики
        ns = len(split_sentences(text))
        sys.stderr.write("[tts] OK %d chars (%d sents) -> %d bytes\n"
                         % (len(text), ns, len(wav)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True,
                    help="директория Piper-модели: model.onnx + tokens.txt + espeak-ng-data/")
    ap.add_argument("--port", type=int, default=3900)
    ap.add_argument("--speed", type=float, default=DEFAULT_SPEED,
                    help="скорость речи (0.9 = чуть медленнее эталона)")
    ap.add_argument("--pause-period", type=float, default=PAUSE_AFTER_PERIOD,
                    help="пауза после точки, сек")
    ap.add_argument("--pause-emphasis", type=float, default=PAUSE_AFTER_EMPHASIS,
                    help="пауза после !?, сек")
    ap.add_argument("--pause-end", type=float, default=PAUSE_AT_END,
                    help="завершающая пауза, сек")
    args = ap.parse_args()

    sys.stderr.write("[tts] loading model from %s ...\n" % args.model_dir)
    Handler.tts = build_tts(args.model_dir)
    Handler.default_speed = args.speed
    sys.stderr.write("[tts] model loaded. sample_rate=%d, speed=%s\n"
                     % (Handler.tts.sample_rate, args.speed))

    srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    sys.stderr.write("[tts] listening on :%d\n" % args.port)
    srv.serve_forever()


if __name__ == "__main__":
    main()