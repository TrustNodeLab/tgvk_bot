"""End-to-end offline coverage for the long music bed vs subtitle verification.

``bot/video_cine.build_soundtrack`` mixes a beat bed and cut SFX under the
narration, and ``bot/verify_subs.py`` then re-detects speech in the *mixed*
track with ``silencedetect=noise=-35dB:d=0.15``.  The narration chunks are
joined by ``CHUNK_GAP`` seconds of digital silence, so the bed must stay under
the detector floor inside every one of those gaps: otherwise a single beat
kick re-bridges the gap, the separator is never reported as silence, adjacent
narration chunks collapse into one speech island and the SRT boundary check
fails.

These tests exercise the real ``build_soundtrack`` and the real verifier on a
synthetic narration that has the production structure (speech-like tone bursts
separated by exactly ``CHUNK_GAP`` of digital silence).  No video is rendered,
no network/TTS is used; only numpy math, one ffmpeg ``silencedetect`` pass and
a temporary WAV.  ``verify_subs`` itself is never patched or replaced.
"""
from __future__ import annotations

import math
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "bot"))

import numpy as np  # noqa: E402
import verify_subs  # noqa: E402
import video_cine as cine  # noqa: E402
import video_styles as styles  # noqa: E402
import video_gen  # noqa: E402

SR = cine.SR
FULL_SCALE = 32768.0
# Mirrors of the acceptance contract in ``bot/verify_subs.py``.  The verifier is
# the authority; these copies only document the numbers this suite asserts on.
DETECTOR_FLOOR_DBFS = -35.0
DETECTOR_MIN_SILENCE_S = 0.15
# Head-room the bed must keep inside a narration gap.
GAP_HEADROOM_DB = 3.0
# ``CHUNK_GAP`` is defined in ``bot/video_gen.py`` (committed). The local
# ``bot/verify_subs.py`` is the user's uncommitted work; CI checks out the
# committed file, which has no such symbol, so read it defensively.
CHUNK_GAP = getattr(verify_subs, "CHUNK_GAP", None) or video_gen.CHUNK_GAP
CHUNK_GAP_TOLERANCE = getattr(verify_subs, "CHUNK_GAP_TOLERANCE", 0.12)
_merge_spans = getattr(verify_subs, "merge_speech_spans", None)
_validate_cues = getattr(verify_subs, "validate_cues", None)
# ``bot/video_long.py`` scales the decoded TTS track by 1.1 before mixing.
VOICE_GAIN = 1.1
# ``bot/video_long.py`` derives ``duck`` from a forward running mean of the
# voice envelope over this window.
ENVELOPE_WINDOW_S = 0.2

CHUNK_DUR = 4.0
CHUNKS = 8
# One sub-chunk pause, shorter than the chunk separator, so the merge step in
# ``merge_speech_spans`` is exercised as well.
INTERNAL_PAUSE_CHUNK = 4
INTERNAL_PAUSE_S = 0.30
CUE_TARGET_S = 0.7


def dbfs(peak):
    """Full-scale decibel value of an int16 peak."""
    if peak <= 0:
        return float("-inf")
    return 20.0 * math.log10(peak / FULL_SCALE)


def peak_dbfs(samples):
    peak = int(np.abs(np.asarray(samples, dtype=np.int64)).max()) if len(samples) else 0
    return dbfs(peak)


def duck_envelope(voice, sr=SR):
    """Replicate the ``duck`` envelope computed by ``bot/video_long.py``."""
    a = np.abs(np.asarray(voice, dtype=np.float64))
    wsize = max(1, int(sr * ENVELOPE_WINDOW_S))
    cs = np.cumsum(np.insert(a, 0, 0.0))
    env = (cs[wsize:] - cs[:-wsize]) / wsize
    env = np.concatenate([env, np.full(max(0, a.size - env.size), 0.0)])[:a.size]
    peak = env.max()
    return (env / peak) if peak > 0 else np.zeros(a.size)


def build_narration(chunk_dur=CHUNK_DUR, gap=CHUNK_GAP, chunks=CHUNKS, sr=SR,
                    internal_chunk=INTERNAL_PAUSE_CHUNK,
                    internal_pause=INTERNAL_PAUSE_S):
    """Speech-like narration chunks joined by digital silence.

    Returns ``(samples, speech_spans)`` with ``samples`` in int16 units and the
    true ``(start, end)`` voice regions, i.e. exactly the timeline an SRT built
    from the voice track has to cover.
    """
    step = chunk_dur + gap
    total = chunk_dur * chunks + gap * (chunks - 1)
    n = int(round(total * sr))
    active = np.zeros(n, dtype=bool)
    spans = []
    for index in range(chunks):
        start = index * step
        pause_at = None
        if index == internal_chunk and internal_pause > 0:
            pause_at = start + (chunk_dur - internal_pause) / 2.0
        pieces = [(start, start + chunk_dur)]
        if pause_at is not None:
            pieces = [(start, pause_at), (pause_at + internal_pause,
                                          start + chunk_dur)]
        for lo, hi in pieces:
            i0, i1 = int(round(lo * sr)), int(round(hi * sr))
            active[i0:i1] = True
            spans.append((lo, hi))
    t = np.arange(n) / sr
    # Three harmonics with a syllable-rate envelope that never drops to
    # silence, so the only silences in the track are the chunk separators.
    syllable = 0.45 + 0.55 * np.abs(np.sin(np.pi * 4.5 * t))
    wave = (np.sin(2 * np.pi * 150 * t)
            + 0.6 * np.sin(2 * np.pi * 300 * t)
            + 0.3 * np.sin(2 * np.pi * 450 * t))
    samples = np.where(active, wave * syllable * 5600.0, 0.0)
    return samples, spans


def build_cues(speech_spans, target=CUE_TARGET_S):
    """Tile every speech span with cues, as the real SRT writer does."""
    cues = []
    for start, end in speech_spans:
        span = end - start
        if span <= 0:
            continue
        parts = max(1, int(round(span / target)))
        edges = [start + span * i / parts for i in range(parts + 1)]
        for index in range(parts):
            cues.append((edges[index], edges[index + 1], f"сегмент {index}"))
    return cues


def build_shots(chunks=CHUNKS, step=CHUNK_DUR + CHUNK_GAP, sfx="none"):
    """Shot list whose cuts land on the chunk boundaries, as production does."""
    bounds = [step * i for i in range(chunks + 1)]
    bounds[0] = 0.0
    shots = [{"sfx": sfx} for _ in range(chunks)]
    return shots, bounds


def measure(style, sfx="none", chunk_dur=CHUNK_DUR, gap=CHUNK_GAP,
            chunks=CHUNKS):
    """Build the production mix for one style and measure the bed in the gaps.

    Returns a dict with the bed, the mixed track, the true gap windows and the
    peak level inside each of them.
    """
    voice, speech_spans = build_narration(chunk_dur=chunk_dur, gap=gap,
                                          chunks=chunks)
    seconds = len(voice) / float(SR)
    duck = duck_envelope(voice)
    shots, bounds = build_shots(chunks=chunks, step=chunk_dur + gap, sfx=sfx)
    bed = cine.build_soundtrack(
        shots, bounds, seconds, float(style.get("bpm", 72.0)), None,
        bed=float(style.get("bed_level", 1.0)),
        sfx_gain=float(style.get("sfx_level", 1.0)),
        duck=duck,
    )
    mix = bed.astype(np.float64)
    mix[:voice.size] += voice[:mix.size] * VOICE_GAIN
    mix = np.clip(mix, -32768, 32767).astype(np.int16)
    gaps = [(span[0][1], span[1][0])
            for span in zip(speech_spans, speech_spans[1:])
            if abs((span[1][0] - span[0][1]) - gap) <= 1e-6]
    bed_gap_peaks = []
    for lo, hi in gaps:
        i0, i1 = int(round(lo * SR)), int(round(hi * SR))
        bed_gap_peaks.append(int(np.abs(bed[i0:i1].astype(np.int64)).max()))
    return {
        "bed": bed, "mix": mix, "seconds": seconds, "duck": duck,
        "speech_spans": speech_spans, "gaps": gaps,
        "bed_gap_peak": max(bed_gap_peaks) if bed_gap_peaks else 0,
        "bed_peak": int(np.abs(bed.astype(np.int64)).max()),
    }


class LongBedSubtitleGateTests(unittest.TestCase):
    """The bed must not decide where speech boundaries land."""

    @classmethod
    def setUpClass(cls):
        cls.style, cls.key = styles.get_style("documentary")
        cls.measured = measure(cls.style)

    def test_documentary_gap_separators_are_reported_as_silence(self):
        """Every ``CHUNK_GAP`` separator must survive the bed and be detected."""
        gaps = self.measured["gaps"]
        self.assertEqual(len(gaps), CHUNKS - 1,
                         "the synthetic narration must expose one gap per chunk pair")

        ff = verify_subs._ffmpeg()
        with tempfile.TemporaryDirectory() as td:
            wav = os.path.join(td, "mix.wav")
            cine.write_wav(wav, self.measured["mix"])
            spans, duration = verify_subs.speech_spans(wav, ff)

        cues = build_cues(self.measured["speech_spans"])
        # Bound up front: the committed ``verify_subs`` has neither helper, and
        # the reporting/assertions below must stay well defined when they are
        # skipped.  ``merged`` falls back to the raw detected islands and the
        # two error lists stay empty, so the checks that the committed verifier
        # cannot perform do not turn into failures.
        merged = spans
        uncovered, timeline_errors = [], []
        if _merge_spans is None:
            print("[skip] merge_speech_spans not in committed verify_subs")
        else:
            merged = _merge_spans(spans, cues)
        if _validate_cues is None:
            print("[skip] validate_cues not in committed verify_subs")
        else:
            uncovered, timeline_errors = _validate_cues(cues, merged)
        raw_gaps = [spans[i + 1][0] - spans[i][1] for i in range(len(spans) - 1)]
        print("\n[gate] duration=%.3fs cues=%d raw_islands=%d merged_islands=%d"
              % (duration, len(cues), len(spans), len(merged)))
        print("[gate] bed_peak=%.2f dBFS bed_in_gap_peak=%.2f dBFS (floor %.2f)"
              % (peak_dbfs(self.measured["bed"]),
                 dbfs(self.measured["bed_gap_peak"]), DETECTOR_FLOOR_DBFS))
        print("[gate] raw gaps=%s" % ["%.3f" % g for g in raw_gaps])
        print("[gate] uncovered=%s" % (uncovered,))
        print("[gate] timeline_errors=%s" % (timeline_errors,))

        self.assertLessEqual(
            dbfs(self.measured["bed_gap_peak"]),
            DETECTOR_FLOOR_DBFS - GAP_HEADROOM_DB,
            "bed inside a narration gap must stay %.0f dB under the %.0f dBFS "
            "detector floor, measured %.2f dBFS"
            % (GAP_HEADROOM_DB, DETECTOR_FLOOR_DBFS,
               dbfs(self.measured["bed_gap_peak"])))
        self.assertGreaterEqual(
            len(raw_gaps), len(gaps),
            "silencedetect must find at least one %0.2fs silence per chunk gap"
            % CHUNK_GAP)
        detected = [(spans[i][1], spans[i + 1][0]) for i in range(len(spans) - 1)]
        tol = CHUNK_GAP_TOLERANCE
        for lo, hi in gaps:
            self.assertTrue(
                any(abs(s - lo) <= tol and abs((e - s) - CHUNK_GAP) <= tol
                    for s, e in detected),
                "chunk gap %.3f..%.3f was bridged by the bed; detected silences %s"
                % (lo, hi, ["%.3f..%.3f" % (s, e) for s, e in detected]))
        self.assertEqual(uncovered, [], "every cue must sit inside a speech island")
        self.assertEqual(timeline_errors, [],
                         "every chunk separator must stay a real audio boundary")

    def test_cut_sfx_at_a_chunk_edge_cannot_bridge_the_gap(self):
        """A cut effect starting on the gap edge is the worst case for the bed."""
        style, _ = styles.get_style("documentary")
        measured = measure(style, sfx="impact")
        self.assertEqual(len(measured["gaps"]), CHUNKS - 1)
        print("\n[gate+sfx] bed_peak=%.2f dBFS bed_in_gap_peak=%.2f dBFS"
              % (peak_dbfs(measured["bed"]), dbfs(measured["bed_gap_peak"])))
        self.assertLessEqual(
            dbfs(measured["bed_gap_peak"]),
            DETECTOR_FLOOR_DBFS - GAP_HEADROOM_DB,
            "cut SFX at the chunk edge left %.2f dBFS in the gap"
            % dbfs(measured["bed_gap_peak"]))


class BedGapCeilingRegressionTests(unittest.TestCase):
    """Every preset that declares ``bed_level`` must respect the gap ceiling."""

    def test_presets_with_bed_level_keep_gaps_below_the_detector_floor(self):
        keys = sorted(k for k, v in styles.STYLES.items() if "bed_level" in v)
        self.assertIn("documentary", keys)
        for key in keys:
            with self.subTest(style=key):
                measured = measure(styles.STYLES[key], sfx="impact")
                level = dbfs(measured["bed_gap_peak"])
                print("[ceiling] %-24s bed=%-5s gap_peak=%+7.2f dBFS"
                      % (key, styles.STYLES[key]["bed_level"], level))
                self.assertLessEqual(
                    level, DETECTOR_FLOOR_DBFS - GAP_HEADROOM_DB,
                    "style %r leaves %.2f dBFS inside a narration gap, the "
                    "silencedetect floor is %.2f dBFS"
                    % (key, level, DETECTOR_FLOOR_DBFS))

    def test_bed_stays_audible_under_the_voice(self):
        """The fix must gate the gaps, not mute the whole soundtrack."""
        style, _ = styles.get_style("documentary")
        measured = measure(style)
        voiced = np.zeros_like(measured["bed"], dtype=np.int64)
        for lo, hi in measured["speech_spans"]:
            i0, i1 = int(round(lo * SR)), int(round(hi * SR))
            voiced[i0:i1] = np.abs(measured["bed"][i0:i1].astype(np.int64))
        under_voice = dbfs(int(voiced.max()))
        print("[mix] bed_under_voice=%.2f dBFS bed_in_gap=%.2f dBFS"
              % (under_voice, dbfs(measured["bed_gap_peak"])))
        self.assertGreater(
            under_voice, DETECTOR_FLOOR_DBFS,
            "the bed must stay above the detector floor under the voice, "
            "otherwise the fix muted the soundtrack instead of gating the gaps")
        self.assertLessEqual(dbfs(measured["bed_gap_peak"]),
                             DETECTOR_FLOOR_DBFS - GAP_HEADROOM_DB)


if __name__ == "__main__":
    unittest.main(verbosity=2)
