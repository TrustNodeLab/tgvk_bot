#!/usr/bin/env python3
"""Мини HTTP-сервер озвучки на XTTS-v2 (клонирование голоса, CPU).

Замена Piper-режима (bot/tts_server.py): пользователь выбрал голос
«ruslan p-2» — XTTS-клон Piper-ruslan с питчем -2 полутона.

Эмулирует тот же OpenAI-совместимый VoiceStudio API:
  GET  /health              -> {"status":"ok", "voice":"ruslan p-2"}
  GET  /v1/audio/voices     -> список голосов
  POST /v1/audio/speech     -> WAV bytes (model/voice/input/response_format)

Использование (см. также tts_clone.py — переиспользуем его load/synth):
  python bot/tts_server_xtts.py --ref-audio refs/ruslan.wav --pitch -2 --port 3900
"""
import argparse
import io
import json
import os
import sys
import tempfile
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# подключаем scripts/tts_clone.py (load_xtts_model + synth_to_file)
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "..", "scripts"))

from tts_clone import load_xtts_model, synth_to_file  # noqa: E402

DEFAULT_SPEED = 0.9   # как в Piper-режиме (S34h): чуть медленнее
DEFAULT_PITCH = -2.0  # выбор пользователя: «ruslan p-2»
DEFAULT_LANG = "ru"
VOICE_NAME = "XTTS clone ruslan (p-2)"


class Handler(BaseHTTPRequestHandler):
    cfg = None            # XTTS config
    model = None          # XTTS model
    ref_audio = ""        # путь к референс-аудио (голос ruslan)
    lang = DEFAULT_LANG
    speed = DEFAULT_SPEED
    pitch = DEFAULT_PITCH

    def log_message(self, fmt, *args):
        sys.stderr.write("[tts] %s\n" % (fmt % args))

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _synth(self, text: str) -> tuple:
        """Синтез -> (wav_bytes, sample_rate). Промежуточный файл в temp."""
        fd, tmp = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        try:
            rc = synth_to_file(self.cfg, self.model, text, self.ref_audio, tmp,
                               lang=self.lang, speed=self.speed, pitch=self.pitch)
            if rc != 0:
                raise RuntimeError("XTTS synth rc=%d" % rc)
            with wave.open(tmp, "rb") as w:
                sr = w.getframerate()
                n = w.getnframes()
                pcm = w.readframes(n)
            return pcm, sr
        finally:
            try:
                os.remove(tmp)
            except OSError:
                pass

    def do_GET(self):
        if self.path.rstrip("/") == "/health" or self.path == "/":
            self._send_json({"status": "ok", "device": "cpu",
                             "version": "xtts-clone", "voice": VOICE_NAME})
            return
        if self.path.rstrip("/") == "/v1/audio/voices":
            self._send_json([
                {"voice_id": "alloy", "id": "alloy", "name": VOICE_NAME,
                 "type": "local",
                 "description": "XTTS-v2 clone of Piper ruslan, pitch -2"}
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
            t0 = time.time()
            wav, sr = self._synth(text)
            sys.stderr.write("[tts] synthesized %d chars in %.1fs (%d bytes)\n"
                             % (len(text), time.time() - t0, len(wav)))
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
    ap.add_argument("--ref-audio", required=True, help="референс-аудио (голос ruslan)")
    ap.add_argument("--port", type=int, default=3900)
    ap.add_argument("--speed", type=float, default=DEFAULT_SPEED)
    ap.add_argument("--pitch", type=float, default=DEFAULT_PITCH,
                    help="питч-сдвиг в полутонах (выбор: -2 = «ruslan p-2»)")
    ap.add_argument("--lang", default=DEFAULT_LANG)
    args = ap.parse_args()

    if not os.path.isfile(args.ref_audio):
        sys.stderr.write("[tts] ERROR: референс не найден: %s\n" % args.ref_audio)
        return 1

    sys.stderr.write("[tts] loading XTTS-v2 (CPU) ...\n")
    t0 = time.time()
    cfg, model = load_xtts_model()
    sys.stderr.write("[tts] model loaded in %.1fs\n" % (time.time() - t0))

    Handler.cfg = cfg
    Handler.model = model
    Handler.ref_audio = args.ref_audio
    Handler.lang = args.lang
    Handler.speed = args.speed
    Handler.pitch = args.pitch

    # warm-up (первый синтез медленный — делаем до прослушки)
    sys.stderr.write("[tts] warm-up synthesis ...\n")
    t0 = time.time()
    try:
        synth_to_file(cfg, model, "Привет! Это тестовая озвучка.",
                      args.ref_audio, os.path.join(tempfile.gettempdir(), "_xtts_warm.wav"),
                      lang=args.lang, speed=args.speed, pitch=args.pitch)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write("[tts] warm-up error: %r\n" % (e,))
    sys.stderr.write("[tts] warm-up done in %.1fs; speed=%s pitch=%+g lang=%s\n"
                     % (time.time() - t0, args.speed, args.pitch, args.lang))

    srv = ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    sys.stderr.write("[tts] listening on :%d (voice=%s)\n" % (args.port, VOICE_NAME))
    srv.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())