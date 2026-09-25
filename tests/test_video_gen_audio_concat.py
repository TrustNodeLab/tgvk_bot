"""Contract tests for the voice-track assembly in :mod:`bot.video_gen`.

The regression these tests lock down happened on GitHub Actions: VoiceStudio
returned 92 chunks whose sample rate did not match the hard-coded 24000 Hz mono
silence files, both concat-demuxer attempts failed, ``make_voiceover_sections``
returned the no-audio state, and ``bot/video_long.py`` then aborted with
``RuntimeError: [long] SRT не построен``.

Every external boundary is mocked - the TTS provider, ``subprocess.run`` and the
ffmpeg binary itself - so the suite needs no network, no TTS engine and no
ffmpeg on PATH.
"""
from __future__ import annotations

import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# ``video_gen`` loads its sibling runtime modules by their legacy top-level
# names, so it is imported the same way the rest of this suite imports ``bot``.
sys.path.insert(0, os.path.join(ROOT, "bot"))

import video_gen as target  # noqa: E402


# Fake TTS chunks.  Keyed by file name so the probe and the silencedetect
# answers stay consistent with each other.
CHUNK_DURATIONS = {"sec_0.mp3": 4.0, "sec_1.mp3": 3.0}
LEAD_SILENCE = 0.2
RAW_BLOB = b"\x01\x02\x03\x04" * 32
MPEG_BLOB = b"\xff\xfb\x90\x00" * 64
FFMPEG = "ffmpeg"


def _sections():
    return [
        {"voice": "Ночная смена началась раньше расписания."},
        {"voice": "Первый сигнал пришёл без опознания."},
    ]


def _duration_of(path):
    return CHUNK_DURATIONS.get(os.path.basename(path), 0.0)


def _probe_stderr(path):
    """Answer of ``ffmpeg -i <path>`` (duration probe, and detector header)."""
    return ("ffmpeg version 4.4.2-0ubuntu0\n"
            "Input #0, mp3, from '%s':\n"
            "  Duration: 00:00:%05.2f, bitrate: 128 kb/s\n"
            % (path, _duration_of(path)))


def _detector_stderr(path):
    """Silencedetect log: short leading and trailing silence around speech."""
    duration = _duration_of(path)
    tail_start = duration - LEAD_SILENCE
    return (
        "ffmpeg version 4.4.2-0ubuntu0\n"
        + _probe_stderr(path)
        + "Output #0, null, to 'pipe:':\n"
        + "[silencedetect @ 0x55f0] silence_start: 0\n"
        + "[silencedetect @ 0x55f0] silence_end: %s | silence_duration: %s\n"
          % (LEAD_SILENCE, LEAD_SILENCE)
        + "[silencedetect @ 0x55f0] silence_start: %s\n" % tail_start
        + "[silencedetect @ 0x55f0] silence_end: %s | silence_duration: %s\n"
          % (duration, LEAD_SILENCE)
    )


def _write(path, blob):
    with open(path, "wb") as handle:
        handle.write(blob)
    return path


def _make_fake_run(concat_fails=True, pcm_fails=False, wav_to_mp3_fails=False):
    """Build a fake ``subprocess.run`` plus the log of calls it received.

    The fake understands exactly the ffmpeg invocations the assembly path makes
    and raises ``AssertionError`` on anything unexpected, so a new call cannot
    slip through unnoticed.
    """
    calls = []

    def fake_run(args, **kwargs):
        argv = [str(a) for a in args]
        calls.append(argv)
        joined = " ".join(argv)

        if "concat" in argv:
            # The CI failure: stream copy and transcode both refused the list.
            if concat_fails:
                return SimpleNamespace(
                    returncode=1,
                    stderr=b"Automatic encoder selection failed\n"
                           b"Invalid data found when processing input\n")
            _write(argv[-1], MPEG_BLOB)
            return SimpleNamespace(returncode=0, stderr="")

        if "pcm_s16le" in argv:
            if pcm_fails:
                return SimpleNamespace(returncode=1, stderr="Unknown encoder 'pcm_s16le'")
            _write(argv[-1], RAW_BLOB)
            return SimpleNamespace(returncode=0, stderr="")

        if "-f" in argv and argv[argv.index("-f") + 1] == "s16le":
            # Final encode of the hand-joined raw stream.
            if pcm_fails:
                return SimpleNamespace(returncode=1, stderr="Invalid data found")
            _write(argv[-1], MPEG_BLOB)
            return SimpleNamespace(returncode=0, stderr="")

        if "anullsrc" in joined:
            _write(argv[-1], MPEG_BLOB)
            return SimpleNamespace(returncode=0, stderr="")

        if "silencedetect" in joined:
            return SimpleNamespace(
                returncode=0, stderr=_detector_stderr(argv[argv.index("-i") + 1]))

        if len(argv) == 3 and argv[1] == "-i":
            return SimpleNamespace(returncode=1, stderr=_probe_stderr(argv[2]))

        if "libmp3lame" in argv and "-ar" in argv:
            # VoiceStudio wav -> mp3 normalisation.
            if wav_to_mp3_fails:
                return SimpleNamespace(returncode=1, stderr="Unknown encoder")
            _write(argv[-1], MPEG_BLOB)
            return SimpleNamespace(returncode=0, stderr="")

        raise AssertionError("unexpected subprocess.run call: %r" % (argv,))

    return fake_run, calls


class VoiceTrackAssemblyTest(unittest.TestCase):
    """The concat demuxer may fail; the voice track still has to be produced."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmpdir = self._tmp.name
        self.addCleanup(self._tmp.cleanup)
        self.chunks = [
            _write(os.path.join(self.tmpdir, name), MPEG_BLOB)
            for name in sorted(CHUNK_DURATIONS)
        ]
        self.sections = _sections()

    def _assemble(self, fake_run):
        with mock.patch.object(target.subprocess, "run", fake_run), \
                mock.patch.object(target, "_tts_silero", return_value=list(self.chunks)), \
                mock.patch.dict(os.environ, {"TTS_PROVIDER": "silero"}):
            with redirect_stdout(io.StringIO()):
                return target.make_voiceover_sections(
                    FFMPEG, self.sections, "ru-RU-DmitryNeural", self.tmpdir)

    def test_pcm_fallback_assembles_track_when_both_concat_attempts_fail(self):
        fake_run, calls = _make_fake_run(concat_fails=True, pcm_fails=False)

        voice_mp3, weights, meta = self._assemble(fake_run)

        self.assertIsNotNone(voice_mp3, "voice track must survive a dead demuxer")
        self.assertEqual(voice_mp3, os.path.join(self.tmpdir, "voice.mp3"))
        self.assertGreater(os.path.getsize(voice_mp3), 0)
        self.assertEqual(meta["audio_state"], "speech")
        # Demuxer list keeps its order, and the fallback consumes that order.
        decoded = [os.path.basename(argv[3]) for argv in calls if "pcm_s16le" in argv]
        self.assertEqual(
            decoded,
            ["lead.mp3", "sec_0.mp3", "sil.mp3", "sec_1.mp3", "tail.mp3"],
        )
        with open(os.path.join(self.tmpdir, "join.txt"), encoding="utf-8") as handle:
            listed = [os.path.basename(line.strip().strip("'"))
                      for line in handle if line.strip()]
        self.assertEqual(listed, decoded)
        # Resampling preserves each chunk duration, so the bounds math holds.
        self.assertEqual([round(w, 3) for w in weights], [4.5, 3.0])
        self.assertEqual([c["sec"] for c in meta["chunk_bounds"]], [0, 1])
        self.assertAlmostEqual(meta["chunk_bounds"][0]["start"], 1.0)
        self.assertAlmostEqual(meta["chunk_bounds"][0]["end"], 5.0)
        self.assertAlmostEqual(meta["chunk_bounds"][1]["start"], 5.5)
        self.assertAlmostEqual(meta["chunk_bounds"][1]["end"], 8.5)
        self.assertTrue(meta["cues"], "fallback-assembled track must yield cues")
        self.assertAlmostEqual(meta["section_bounds"][-1], 8.5)

    def test_no_audio_state_when_every_attempt_including_pcm_fails(self):
        fake_run, _calls = _make_fake_run(concat_fails=True, pcm_fails=True)

        voice_mp3, weights, meta = self._assemble(fake_run)

        self.assertIsNone(voice_mp3)
        self.assertEqual(meta["audio_state"], "no_audio")
        self.assertEqual(meta["cues"], [])
        self.assertEqual(meta["section_bounds"], [])
        self.assertEqual([round(w, 3) for w in weights], [4.5, 3.0])

    def test_concat_demuxer_still_wins_when_it_works(self):
        fake_run, calls = _make_fake_run(concat_fails=False)

        voice_mp3, _weights, meta = self._assemble(fake_run)

        self.assertIsNotNone(voice_mp3)
        self.assertEqual(meta["audio_state"], "speech")
        self.assertEqual(len([argv for argv in calls if "concat" in argv]), 1)
        self.assertEqual([argv for argv in calls if "pcm_s16le" in argv], [])


class VoiceStudioNormalisationTest(unittest.TestCase):
    """Chunk sample rate must match the 24 kHz mono assumption of the assembly."""

    def test_wav_to_mp3_forces_24000_mono(self):
        fake_run, calls = _make_fake_run()
        response = SimpleNamespace(
            content=b"RIFF----WAVEfmt ", status_code=200, headers={})
        response.raise_for_status = lambda: None

        import requests  # imported lazily by _tts_voicestudio in production

        with tempfile.TemporaryDirectory() as tmpdir, \
                mock.patch.object(target.subprocess, "run", fake_run), \
                mock.patch.object(requests, "get", return_value=SimpleNamespace(
                    status_code=503, json=lambda: [])), \
                mock.patch.object(requests, "post", return_value=response):
            with redirect_stdout(io.StringIO()):
                produced = target._tts_voicestudio(
                    [{"voice": "Проверка нормализации."}], "alloy", tmpdir)

        self.assertEqual(produced, [os.path.join(tmpdir, "sec_0.mp3")])
        conversions = [argv for argv in calls if "libmp3lame" in argv and "-ar" in argv]
        self.assertEqual(len(conversions), 1)
        argv = conversions[0]
        self.assertEqual(argv[argv.index("-ar") + 1], "24000")
        self.assertEqual(argv[argv.index("-ac") + 1], "1")


if __name__ == "__main__":
    unittest.main()
