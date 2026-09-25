"""Offline regression coverage for documentary video-style mix levels.

The long renderer treats omitted ``bed_level`` and ``sfx_level`` values as
full gain.  A voice-over preset must declare restrained values so the
narrative remains dominant and subtitle speech-boundary detection can settle
at the configured silence threshold.

This suite imports only :mod:`video_styles`; it performs no network, TTS,
ffmpeg, or filesystem I/O.
"""
from __future__ import annotations

import math
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "bot"))

import video_styles as target  # noqa: E402


class VideoStylesAudioTests(unittest.TestCase):
    def test_documentary_declares_restrained_voice_over_levels(self):
        style, key = target.get_style("documentary")

        self.assertEqual(key, "documentary")
        self.assertTrue(style["voice_over"])
        for level_name in ("bed_level", "sfx_level"):
            with self.subTest(level=level_name):
                level = style.get(level_name)
                self.assertIsNotNone(level, f"{level_name} must not use the full-gain fallback")
                self.assertTrue(math.isfinite(level))
                self.assertGreater(level, 0.0)
                self.assertLessEqual(level, 0.12)

    def test_documentary_levels_match_the_renderer_gain_contract(self):
        style, _ = target.get_style("DOCUMENTARY")

        # video_long.py passes these values to build_soundtrack(); explicit
        # values keep the documentary bed below the default 1.0 fallback.
        self.assertEqual(style["bed_level"], 0.12)
        self.assertEqual(style["sfx_level"], 0.08)
        self.assertLess(style["bed_level"], 1.0)
        self.assertLess(style["sfx_level"], 1.0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
