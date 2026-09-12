#!/usr/bin/env python3
"""Мини HTTP-сервер озвучки на sherpa-onnx (Piper, ru_RU-dmitri-medium).

Эмулирует OpenAI-совместимый VoiceStudio API, чтобы bot/video_gen.py
работал через TTS_PROVIDER=voicestudio БЕЗ docker:
  GET  /health              -> {"status":"ok"}
  GET  /v1/audio/voices     -> список голосов
  POST /v1/audio/speech     -> WAV bytes (model/voice/input/response_format)

Использование:
  python bot/tts_server.py --model-dir /path/to/model_dir --port 3900
где model_dir содержит model.onnx + tokens.txt + espeak-ng-data/ (для Piper).
"""
import argparse
import io
import json
import sys
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import sherpa_onnx


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
    tts = sherpa_onnx.OfflineTts(cfg)
    return tts


def synth_wav(tts: sherpa_onnx.OfflineTts, text: str, speed: float = 1.0):
    """Генерирует речь и возвращает (wav_bytes, sample_rate)."""
    result = tts.generate(text, sid=0, speed=speed)
    if not result or len(result.samples) == 0:
        raise RuntimeError("sherpa-onnx не вернул сэмплы (пустой текст?)")
    samples = np.asarray(result.samples, dtype=np.float32)
    sr = result.sample_rate
    # float32 -> int16
    pcm = np.clip(samples * 32767.0, -32768, 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue(), sr


class Handler(BaseHTTPRequestHandler):
    tts = None  # set at startup

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
                             "version": "sherpa-piper-mini"})
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
            speed = float(body.get("speed", 1.0) or 1.0)
            wav, sr = synth_wav(self.tts, text, speed)
        except Exception as e:  # noqa: BLE001
            sys.stderr.write("[tts] ERROR: %r\n" % (e,))
            self._send_json({"error": str(e)}, 500)
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)
        sys.stderr.write("[tts] OK %d chars -> %d bytes\n" % (len(text), len(wav)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model-dir", required=True,
                    help="директория Piper-модели: model.onnx + tokens.txt + espeak-ng-data/")
    ap.add_argument("--port", type=int, default=3900)
    args = ap.parse_args()

    sys.stderr.write("[tts] loading model from %s ...\n" % args.model_dir)
    Handler.tts = build_tts(args.model_dir)
    sys.stderr.write("[tts] model loaded. sample_rate=%d\n" % Handler.tts.sample_rate)

    srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    sys.stderr.write("[tts] listening on :%d\n" % args.port)
    srv.serve_forever()


if __name__ == "__main__":
    main()