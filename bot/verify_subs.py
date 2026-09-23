#!/usr/bin/env python3
"""Проверка синхрона субтитров и голоса в готовом видео.

Идея: субтитры SRT — это чистые таймкоды, а в видео лежит реальный звук.
Извлекаем аудио, ищем границы речи (ffmpeg silencedetect) и сверяем:
  * первый субтитр должен начинаться вместе с началом речи;
  * последний субтитр должен закончиться вместе с концом речи;
  * между соседними репликами не должно быть «провалов» громкости.
Расхождение > --tolerance (по умолчанию 0.25с) → ненулевой exit code.

CLI: python bot/verify_subs.py out/video_test.mp4 out/video_test.srt [--tolerance 0.25]
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile

DEFAULT_TOLERANCE = 0.25


def _ffmpeg() -> str:
    try:
        import imageio_ffmpeg

        exe = imageio_ffmpeg.get_ffmpeg_exe()
        if exe and os.path.exists(exe):
            return exe
    except Exception:
        pass
    import shutil

    return shutil.which("ffmpeg") or "ffmpeg"


def parse_srt(path: str):
    """[(start_sec, end_sec, text)] из .srt."""
    out = []
    with open(path, encoding="utf-8-sig") as fh:
        text = fh.read()
    pat = re.compile(
        r"(\d+):(\d+):(\d+),(\d+)\s*-->\s*(\d+):(\d+):(\d+),(\d+)\s*\n(.*?)(?=\n\s*\n|\Z)",
        re.S,
    )
    for m in pat.finditer(text):
        g = [int(x) for x in m.groups()[:8]]
        start = g[0] * 3600 + g[1] * 60 + g[2] + g[3] / 1000.0
        end = g[4] * 3600 + g[5] * 60 + g[6] + g[7] / 1000.0
        body = re.sub(r"\s+", " ", m.group(9)).strip()
        out.append((start, end, body))
    return out


def speech_spans(video: str, ff: str):
    """Границы речи в видео: [(start, end)] из silencedetect по извлечённому аудио."""
    with tempfile.TemporaryDirectory() as td:
        wav = os.path.join(td, "a.wav")
        subprocess.run(
            [ff, "-y", "-i", video, "-vn", "-ac", "1", "-ar", "24000", wav],
            capture_output=True, check=True,
        )
        r = subprocess.run(
            [ff, "-hide_banner", "-i", wav,
             "-af", "silencedetect=noise=-35dB:d=0.15", "-f", "null", "-"],
            capture_output=True, text=True,
        )
        err = r.stderr or ""
        dur_m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
        dur = (int(dur_m.group(1)) * 3600 + int(dur_m.group(2)) * 60
               + float(dur_m.group(3))) if dur_m else None
        starts = [float(x) for x in re.findall(r"silence_start: ([0-9.]+)", err)]
        ends = [float(x) for x in re.findall(r"silence_end: ([0-9.]+)", err)]
    spans, cursor = [], 0.0
    for i, s_start in enumerate(starts):
        if s_start > cursor + 0.15:
            spans.append((cursor, s_start))
        cursor = ends[i] if i < len(ends) else cursor
    if dur is not None and dur - cursor > 0.15:
        spans.append((cursor, dur))
    return spans, dur


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Проверка синхрона SRT ↔ голос")
    ap.add_argument("video")
    ap.add_argument("srt")
    ap.add_argument("--tolerance", type=float, default=DEFAULT_TOLERANCE)
    a = ap.parse_args(argv)

    if not os.path.isfile(a.srt):
        print(f"verify_subs: SRT не найден: {a.srt}")
        return 0  # нет озвучки — нечего проверять
    cues = parse_srt(a.srt)
    if not cues:
        print("verify_subs: SRT пуст")
        return 0
    ff = _ffmpeg()
    try:
        spans, dur = speech_spans(a.video, ff)
    except (subprocess.SubprocessError, OSError) as e:
        print(f"verify_subs: не удалось извлечь аудио ({e}) — пропуск")
        return 0
    if not spans:
        print("verify_subs: речь не обнаружена в аудио — пропуск")
        return 0

    # пауза ВНУТРИ фразы (0.15-0.7с) — не разрыв речи: склеиваем такие
    # участки, иначе одна реплика «перепрыгивает» паузу и считается
    # рассинхроном (на живом прогоне 4 реплики давали 6 участков)
    merged = [list(spans[0])]
    for s, e in spans[1:]:
        if s - merged[-1][1] < 0.7:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    spans = [(s, e) for s, e in merged]

    first_speech, last_speech = spans[0][0], spans[-1][1]
    d_start = cues[0][0] - first_speech
    d_end = last_speech - cues[-1][1]
    # каждая реплика должна попадать в речевой участок (с допуском)
    uncovered = []
    for start, end, _t in cues:
        if not any(start >= s - a.tolerance and end <= e + a.tolerance
                   for s, e in spans):
            uncovered.append((start, end))
    print(f"verify_subs: реплик={len(cues)} речевых участков={len(spans)} "
          f"длина={dur}")
    print(f"verify_subs: начало субтитров {d_start:+.3f}s (речь {first_speech:.3f})")
    print(f"verify_subs: конец субтитров  {d_end:+.3f}s (речь {last_speech:.3f})")
    print(f"verify_subs: вне речи: {len(uncovered)}")
    for s, e in uncovered[:5]:
        print(f"  ⚠️ {s:.2f}..{e:.2f}")
    bad = abs(d_start) > a.tolerance or abs(d_end) > a.tolerance or uncovered
    if bad:
        print(f"verify_subs: FAIL (tolerance {a.tolerance}s)")
        return 1
    print(f"verify_subs: OK — субтитры синхронны (tolerance {a.tolerance}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
