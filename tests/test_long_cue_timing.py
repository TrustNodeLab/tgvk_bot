"""Cue timing must follow the DETECTED speech, not a uniform spread.

GitHub Actions run 36218160104 failed only at the ``verify_subs`` step with
``вне речи: 7``.  All 7 cues were markdown heading / list-marker tokens
(``Выводы:``, ``1.``, ``2.``, ``3.``, ``5.``) whose END landed inside a detected
pause of 0.7 s or more.

Cause, measured on the real run-4 artifact and reproduced here: the renderer
asked :func:`video_gen.speech_bounds` for ONE ``(onset, speech_duration)`` pair
per TTS chunk and then spread the chunk's word cues evenly over that single
range.  TTS gives a heading or a list marker its own beat, ``silencedetect``
finds that pause inside the chunk, and the uniform spread lays whichever cues
happen to span the pause across it.  ``bot/verify_subs.py`` requires every cue
to fit inside one glued speech island (``< 0.7`` s gaps are merged), so those
cues are reported as outside the narration and the run fails.

These tests drive the REAL cue-emission path --
:func:`video_gen.make_voiceover_sections`, with real ffmpeg silence detection on
real MP3 chunks -- and score the emitted cues with the committed verifier's own
rule.  No video is rendered, no network or TTS engine is used: only numpy math,
a handful of ffmpeg ``silencedetect`` passes and temporary files.  The verifier
is re-implemented here on purpose (see :func:`committed_speech_spans`) so the
test does not silently inherit whatever ``bot/verify_subs.py`` currently holds
in the working tree; only its ``DEFAULT_TOLERANCE`` is read, and only to prove
it is still 0.25.
"""
from __future__ import annotations

import math
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
import wave
from contextlib import redirect_stdout
from io import StringIO
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "bot"))

import numpy as np  # noqa: E402
import verify_subs  # noqa: E402
import video_gen as vg  # noqa: E402
import video_long as vl  # noqa: E402

SR = 24000
# The verifier's contract, mirrored from the committed ``bot/verify_subs.py``:
# ``DEFAULT_TOLERANCE = 0.25``, ``silencedetect=noise=-35dB:d=0.15`` and the
# ``if s - merged[-1][1] < 0.7`` glue that merges short intra-sentence pauses.
DETECTOR_FILTER = "silencedetect=noise=-35dB:d=0.15"
GLUE_SECONDS = 0.7
TOLERANCE = 0.25
# ``CHUNK_GAP`` is the deliberate pause between assembled TTS chunks.  It stays
# 0.5 s: it is glued by the verifier and is not what this fix touches.
CHUNK_GAP = vg.CHUNK_GAP


_FFMPEG = []


def ffmpeg():
    """Resolve the ffmpeg binary once, or fail loudly.

    A skip here would be a false pass: these tests are the only proof that the
    real detector sees the real cue placement.  Resolution is cached and retried
    because this host intermittently hides the bundled binary behind a
    filesystem scanner, and ``shutil.which("ffmpeg")`` is not a fallback when
    ffmpeg was never put on PATH.
    """
    if _FFMPEG:
        return _FFMPEG[0]
    last = None
    for attempt in range(10):
        try:
            exe = vg.find_ffmpeg()
        except Exception as exc:  # noqa: BLE001 - reported below if it persists
            last = exc
            exe = None
        if exe:
            _FFMPEG.append(exe)
            return exe
        time.sleep(0.3 * (attempt + 1))
    raise AssertionError(
        "ffmpeg is required by this suite (imageio-ffmpeg binary unavailable "
        "after 10 attempts): %r" % (last,))


def ffmpeg_run(argv, **kwargs):
    """Run ffmpeg, retrying only a denied process START.

    Some Windows hosts intermittently answer ``CreateProcess`` with
    ``ERROR_ACCESS_DENIED`` (WinError 5) for the bundled ffmpeg binary under a
    burst of spawns.  That is an environment fault, not a product fault, so it
    is retried.  A non-zero ffmpeg exit code is never retried: that is a real
    signal and must reach the assertion.
    """
    last = None
    for attempt in range(3):
        try:
            return subprocess.run(argv, **kwargs)
        except PermissionError as exc:  # WinError 5: process creation denied
            last = exc
            time.sleep(0.25 * (attempt + 1))
    raise last


# --------------------------------------------------------------------------
# synthetic narration
# --------------------------------------------------------------------------

def speech_like(count, sr=SR, freq=180.0, amp=5200.0):
    """A syllable-rate tone burst that never dips below the detector floor."""
    t = np.arange(count) / sr
    syllable = 0.45 + 0.55 * np.abs(np.sin(np.pi * 4.5 * t))
    tone = (np.sin(2 * np.pi * freq * t)
            + 0.6 * np.sin(2 * np.pi * 2 * freq * t)
            + 0.3 * np.sin(2 * np.pi * 3 * freq * t))
    return tone * syllable * amp


def probe_duration(ff, path):
    """``ffmpeg -i`` duration, retried across a lost or crashed binary."""
    last = None
    for attempt in range(3):
        try:
            return vg.mp3_duration(ff, path)
        except OSError as exc:  # denied process start / unreadable file
            last = exc
            time.sleep(0.3 * (attempt + 1))
    raise AssertionError("could not probe %s after 3 attempts: %r" % (path, last))


def build_chunk(segments, path, ff):
    """Write a narration file whose speech is loud exactly on ``segments``.

    ``segments`` is a list of ``(start, end, loud)``.  Everything not marked
    loud is digital silence, so the detected speech times are known up front.
    The WAV is encoded to 24 kHz mono MP3 with the same ffmpeg invocation
    ``_tts_silero`` uses for its own output, so the chunk is byte-for-byte the
    kind of file the renderer is handed in production.
    """
    total = segments[-1][1]
    samples = np.zeros(int(round(total * SR)), dtype=np.float64)
    for lo, hi, loud in segments:
        if not loud:
            continue
        i0, i1 = int(round(lo * SR)), int(round(hi * SR))
        samples[i0:i1] = speech_like(i1 - i0)
    pcm = np.clip(samples, -32768, 32767).astype(np.int16)
    wav_path = os.path.splitext(path)[0] + ".wav"
    with open(wav_path, "wb") as handle:
        with wave.open(handle, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(SR)
            wav.writeframes(pcm.tobytes())
    argv = [ff, "-y", "-i", wav_path, "-ar", "24000", "-ac", "1",
            "-codec:a", "libmp3lame", "-q:a", "2", path]
    result = ffmpeg_run(argv, capture_output=True)
    if result.returncode not in (0, None) or not os.path.isfile(path):
        raise AssertionError("ffmpeg could not encode %s: %r"
                             % (path, result.stderr[-300:]))
    # The renderer probes the file back; a chunk that is not probe-able yet is a
    # host-level visibility problem, so retry before failing loudly.
    for attempt in range(3):
        if probe_duration(ff, path) > 0.3:
            return path
        time.sleep(0.25 * (attempt + 1))
    raise AssertionError("encoded chunk %s is not probe-able (%r)"
                         % (path, probe_duration(ff, path)))


# --------------------------------------------------------------------------
# the committed verifier, re-implemented so this test owns its own authority
# --------------------------------------------------------------------------

def committed_speech_spans(path, ff):
    """Speech islands exactly as the committed ``verify_subs.speech_spans``.

    The two ffmpeg passes are retried because this host intermittently loses
    the bundled binary (``CreateProcess`` denied) and occasionally crashes it
    outright (``0xC0000005``).  A measurement that did not complete must never
    become a verdict, so after the last attempt the failure is re-raised and the
    test errors instead of reporting uncovered cues that were never measured.
    """
    result = None
    last = None
    for attempt in range(3):
        try:
            with tempfile.TemporaryDirectory() as td:
                wav = os.path.join(td, "a.wav")
                ffmpeg_run(
                    [ff, "-y", "-i", path, "-vn", "-ac", "1", "-ar", "24000",
                     wav], capture_output=True, check=True)
                result = ffmpeg_run(
                    [ff, "-hide_banner", "-i", wav, "-af", DETECTOR_FILTER,
                     "-f", "null", "-"],
                    capture_output=True, text=True, check=True)
            break
        except (subprocess.CalledProcessError, OSError) as exc:
            last = exc
            time.sleep(0.3 * (attempt + 1))
    if result is None:
        raise AssertionError(
            "silencedetect could not measure %s after 3 attempts: %r"
            % (path, last))
    err = result.stderr or ""
    match = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
    duration = None
    if match:
        duration = (int(match.group(1)) * 3600 + int(match.group(2)) * 60
                    + float(match.group(3)))
    starts = [float(x) for x in re.findall(r"silence_start: ([0-9.]+)", err)]
    ends = [float(x) for x in re.findall(r"silence_end: ([0-9.]+)", err)]
    spans, cursor = [], 0.0
    for index, start in enumerate(starts):
        if start > cursor + 0.15:
            spans.append((cursor, start))
        cursor = ends[index] if index < len(ends) else cursor
    if duration is not None and duration - cursor > 0.15:
        spans.append((cursor, duration))
    return spans, duration


def committed_glue(spans):
    """Merge pauses shorter than 0.7 s, as the committed verifier does."""
    if not spans:
        return []
    merged = [list(spans[0])]
    for start, end in spans[1:]:
        if start - merged[-1][1] < GLUE_SECONDS:
            merged[-1][1] = end
        else:
            merged.append([start, end])
    return [(start, end) for start, end in merged]


def committed_uncovered(cues, islands, tolerance=TOLERANCE):
    """Cues the committed verifier reports as ``вне речи``."""
    return [
        (cue["text"], cue["start"], cue["end"]) for cue in cues
        if not any(cue["start"] >= start - tolerance
                   and cue["end"] <= end + tolerance
                   for start, end in islands)
    ]


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------

HEADING_TEXT = ("Выводы: Проверьте журналы еженедельно и записывайте итоги "
                "работы в тетради.")
LIST_MARKER_TEXT = "1. Проверьте журналы и отметьте найденные отклонения"
# A >= 0.8 s pause inside the chunk: the shape the CI failure had.
INTERNAL_PAUSE = 0.90
# Chunk 0's own speech, as (start, end, loud) on a 3.6 s file.
PAUSED_CHUNK = [(0.00, 0.30, False), (0.30, 2.30, True),
                (2.30, 2.30 + INTERNAL_PAUSE, False),
                (2.30 + INTERNAL_PAUSE, 5.40, True), (5.40, 5.50, False)]


class LongCueTimingTest(unittest.TestCase):
    """The real renderer must not lay a cue across a detected pause."""

    @classmethod
    def setUpClass(cls):
        cls.ff = ffmpeg()
        # Fixture chunks live in their own directory: each render writes
        # voice.mp3/sil.mp3/lead.mp3/tail.mp3 next to the section index, so a
        # shared writable directory would let one test's assembly collide with
        # the next one's reads.
        cls._chunks_dir = tempfile.TemporaryDirectory()
        chunks_dir = cls._chunks_dir.name
        cls.chunks = {
            0: build_chunk(PAUSED_CHUNK,
                           os.path.join(chunks_dir, "paused.mp3"), cls.ff),
            1: build_chunk([(0.00, 0.30, False), (0.30, 5.40, True),
                            (5.40, 5.50, False)],
                           os.path.join(chunks_dir, "continuous.mp3"), cls.ff),
        }

    @classmethod
    def tearDownClass(cls):
        cls._chunks_dir.cleanup()

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmpdir = self._tmp.name
        self.addCleanup(self._tmp.cleanup)
        self._two_chunk = None

    def _render_two_chunks(self):
        """Assemble the two-chunk case once and share it between the tests."""
        if self._two_chunk is None:
            sections = [{"voice": HEADING_TEXT},
                        {"voice": LIST_MARKER_TEXT}]
            self._two_chunk = self._render(
                sections, [self.chunks[0], self.chunks[1]])
        return self._two_chunk

    def _render(self, sections, chunk_paths):
        """Run the real assembler, retrying only a failed fixture assembly.

        A denied ffmpeg spawn or a momentarily unreadable chunk makes the
        assembler report ``no_audio``/a skipped section.  That is a host fault,
        not a product fault, so the assembly is retried -- and because a real
        defect reproduces on every attempt, the retry can never turn a genuine
        failure into a pass.  The last result is returned either way, so the
        assertions always report the real state.
        """
        result = None
        for attempt in range(4):
            result = self._render_once(sections, chunk_paths)
            if self._assembly_is_complete(result[2], len(sections)):
                return result
            time.sleep(0.3 * (attempt + 1))
        return result

    @staticmethod
    def _assembly_is_complete(meta, expected_chunks):
        """Whether every section really reached the timeline.

        A denied spawn or a lost detector can leave a section voiced but
        uncued.  That is a host fault, so it is retried; a product defect
        reproduces on every attempt and still fails the assertions.
        """
        if meta["audio_state"] != "speech":
            return False
        if len(meta["chunk_bounds"]) != expected_chunks:
            return False
        voiced = {chunk["sec"] for chunk in meta["chunk_bounds"]}
        return {cue["section"] for cue in meta["cues"]} == voiced

    def _render_once(self, sections, chunk_paths):
        with mock.patch.object(vg, "_tts_silero", return_value=list(chunk_paths)), \
                mock.patch.dict(os.environ, {"TTS_PROVIDER": "silero"}):
            with redirect_stdout(StringIO()):
                return vg.make_voiceover_sections(
                    self.ff, sections, "ru-RU-DmitryNeural", self.tmpdir)

    def _assert_contract(self, cues, voice_mp3):
        """Cues are monotonic, positive, and inside a glued speech island."""
        self.assertTrue(cues, "the renderer must emit cues for a voiced chunk")
        for left, right in zip(cues, cues[1:]):
            self.assertLessEqual(left["end"], right["start"],
                                 "cues must stay monotonic and non-overlapping")
        for cue in cues:
            self.assertLess(cue["start"], cue["end"],
                            "every cue needs a positive duration")
        islands = committed_glue(committed_speech_spans(voice_mp3, self.ff)[0])
        uncovered = committed_uncovered(cues, islands)
        print("\n[timing] cues=%d islands=%s" % (
            len(cues), ["%.3f..%.3f" % (s, e) for s, e in islands]))
        print("[timing] uncovered=%s" % (uncovered,))
        self.assertEqual(
            uncovered, [],
            "cues must sit inside a detected speech island; these fall in a "
            "pause or across one: %r" % (uncovered,))
        return islands

    def test_tolerance_is_untouched(self):
        """The fix must not buy coverage by loosening the verifier."""
        self.assertEqual(verify_subs.DEFAULT_TOLERANCE, 0.25)
        self.assertEqual(TOLERANCE, 0.25)
        self.assertEqual(GLUE_SECONDS, 0.7)

    def test_internal_pause_inside_a_chunk_keeps_every_cue_in_speech(self):
        """The CI shape: one >= 0.8 s pause inside the TTS chunk."""
        sections = [{"voice": HEADING_TEXT}]
        _voice, _weights, meta = self._render(sections, [self.chunks[0]])

        self.assertEqual(meta["audio_state"], "speech")
        self._assert_contract(meta["cues"], _voice)

    def test_leading_bare_list_marker_token_keeps_every_cue_in_speech(self):
        """The exact failing token: a chunk that starts with a bare ``1.``."""
        sections = [{"voice": LIST_MARKER_TEXT}]
        _voice, _weights, meta = self._render(sections, [self.chunks[0]])

        self.assertEqual([cue["text"] for cue in meta["cues"]][0], "1.")
        self._assert_contract(meta["cues"], _voice)

    def test_chunk_gap_separators_are_preserved(self):
        """Splitting cues per island must not eat the 0.5 s chunk separator."""
        _voice, _weights, meta = self._render_two_chunks()
        cues = meta["cues"]
        self.assertEqual([chunk["sec"] for chunk in meta["chunk_bounds"]], [0, 1])

        islands = self._assert_contract(cues, _voice)
        first, second = [c for c in cues if c["section"] == 0], \
            [c for c in cues if c["section"] == 1]
        self.assertTrue(first and second)
        # Cues cover SPEECH, not silence, so the distance between the last cue
        # of a chunk and the first cue of the next is the 0.5 s separator plus
        # the two chunks' outer silences.  What matters is that the separator
        # is never eaten: the distance can only be larger than CHUNK_GAP.
        separator = second[0]["start"] - first[-1]["end"]
        outer = ((meta["chunk_bounds"][0]["end"] - meta["chunk_bounds"][0]["speech_end"])
                 + (meta["chunk_bounds"][1]["speech_start"] - meta["chunk_bounds"][1]["start"]))
        print("[gap] cue separator=%.3f CHUNK_GAP=%.3f outer_silences=%.3f"
              % (separator, CHUNK_GAP, outer))
        self.assertEqual(CHUNK_GAP, 0.5, "the deliberate chunk pause stays 0.5 s")
        self.assertGreaterEqual(separator, CHUNK_GAP - 1e-6,
                                "a cue must not reach across the chunk separator")
        self.assertAlmostEqual(separator, CHUNK_GAP + outer, delta=0.25)
        # The separator is concatenated without trimming, so the audio silence
        # at the boundary is CHUNK_GAP plus both chunks' outer silences.  What
        # must survive is that it is a REAL silence: the two chunks stay two
        # separate speech islands instead of one merged span.
        gaps = [(islands[i][1], islands[i + 1][0]) for i in range(len(islands) - 1)]
        boundary = [(start, end) for start, end in gaps
                    if start <= first[-1]["end"] + 1e-6
                    and end >= second[0]["start"] - 1e-6]
        print("[gap] detected gaps=%s boundary=%s"
              % (["%.3f..%.3f" % gap for gap in gaps],
                 ["%.3f..%.3f" % gap for gap in boundary]))
        self.assertTrue(
            boundary,
            "the %0.2fs chunk separator must survive as a real detected "
            "silence; measured gaps %s"
            % (CHUNK_GAP, ["%.3f..%.3f" % gap for gap in gaps]))
        for start, end in boundary:
            self.assertGreaterEqual(
                end - start, CHUNK_GAP - 0.12,
                "the separator must keep its full %0.2fs" % CHUNK_GAP)

    def test_long_render_translation_preserves_the_fix(self):
        """``video_long`` only shifts a cue, so it needs no change of its own."""
        _voice, _weights, meta = self._render_two_chunks()
        source = meta["cues"]
        shots = [{"id": "shot-%d" % index} for index in range(2)]
        spans = [{"sec": 0, "refs": [shots[0]]}, {"sec": 1, "refs": [shots[1]]}]
        chunk_bounds = meta["chunk_bounds"]
        # The long render is time-locked to the voice track, so the first shot
        # of a section starts where that section's audio starts.
        bounds = [0.0] + [chunk["start"] for chunk in chunk_bounds]
        real_dur = chunk_bounds[-1]["end"] + vg.TAIL_OUT

        mapped = vl._map_long_voice_cues(
            source, spans, None, shots, bounds, real_dur,
            chunk_bounds=chunk_bounds)

        self.assertEqual([cue["text"] for cue in mapped],
                         [cue["text"] for cue in source])
        for before, after in zip(source, mapped):
            shift = after["start"] - before["start"]
            self.assertAlmostEqual(shift, after["end"] - before["end"],
                                   delta=1e-9)
            self.assertGreaterEqual(after["start"], 0.0)
        print("[long] mapped=%d translation preserved for every cue" % len(mapped))


class DetectedIslandContractTest(unittest.TestCase):
    """Unit-level guards on the island maths, with no audio at all."""

    def test_word_cues_across_spans_never_crosses_a_pause(self):
        spans = [(0.0, 1.0), (1.9, 3.9)]
        cues = vg.word_cues_across_spans(
            "раз два три четыре пять шесть семь", spans)
        self.assertEqual([cue["text"] for cue in cues],
                         ["раз", "два", "три", "четыре", "пять", "шесть",
                          "семь"])
        for cue in cues:
            self.assertTrue(
                any(cue["start"] >= start - 1e-9 and cue["end"] <= end + 1e-9
                    for start, end in spans),
                "cue %r at %.3f..%.3f crosses a pause" % (
                    cue["text"], cue["start"], cue["end"]))

    def test_single_span_reproduces_the_uniform_spread(self):
        """No detected pause must mean today's behaviour, unchanged."""
        text = "раз два три четыре пять"
        self.assertEqual(
            vg.word_cues_across_spans(text, [(1.0, 4.0)]),
            vg.word_cues(text, 1.0, 4.0))

    def test_degenerate_input_falls_back_instead_of_raising(self):
        self.assertEqual(vg.word_cues_across_spans("раз два", []), [])
        self.assertEqual(vg.word_cues_across_spans("раз два", None), [])
        self.assertEqual(vg.word_cues_across_spans("раз два", [(1.0, 0.5)]), [])
        self.assertEqual(vg.word_cues_across_spans("раз два", [("a", "b")]), [])
        self.assertEqual(vg.word_cues_across_spans("", [(0.0, 1.0)]), [])
        # Sub-millisecond islands cannot host a visible cue and are ignored.
        self.assertEqual(
            vg.word_cues_across_spans("раз два", [(0.0, 0.0001), (0.5, 2.0)]),
            vg.word_cues("раз два", 0.5, 2.0))

    def test_more_islands_than_tokens_keeps_one_cue_per_island(self):
        spans = [(0.0, 0.2), (0.4, 0.6), (0.8, 3.0)]
        cues = vg.word_cues_across_spans("раз два", spans)
        self.assertEqual([cue["text"] for cue in cues], ["раз", "два"])
        for cue in cues:
            self.assertTrue(any(cue["start"] >= start - 1e-9
                                and cue["end"] <= end + 1e-9
                                for start, end in spans))

    def test_speech_bounds_still_reports_the_outer_envelope(self):
        """``speech_bounds`` keeps its (onset, duration) contract."""
        self.assertEqual(vg.speech_bounds("no-such-ffmpeg", "no-such-file"),
                         (0.0, 0.0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
