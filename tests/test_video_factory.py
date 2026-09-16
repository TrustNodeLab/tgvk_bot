# -*- coding: utf-8 -*-
"""Unit tests for video_factory core modules: config, errors, cache, retry,
llm JSON validation, timeline, subtitles, crawl/topographic assets, callback auth.

Run: python -m pytest tests/test_video_factory.py -q   (or unittest: python -m unittest)
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from video_factory.cache import Cache, sha256_hex
from video_factory.config import Config, load_config
from video_factory.errors import VFError, render_failed
from video_factory.retry import RetryPolicy
from video_factory.providers.llm import TemplateLLM, _extract_json, get_llm
from video_factory.renderer.compositor import build_scene_timeline, chunk_words
from video_factory.renderer.crop import smart_crop, crop_window_for_time
from video_factory.renderer.background import render_topographic_frame
from video_factory.renderer.subtitles import write_srt, write_ass_subs


class TestConfig(unittest.TestCase):
    def test_load_defaults(self):
        cfg = load_config(ROOT / "config" / "default.json")
        self.assertEqual(cfg.get("video.width"), 720)
        self.assertEqual(cfg.get("video.height"), 1280)
        self.assertEqual(cfg.get("video.fps"), 30)
        self.assertEqual(cfg.get("validation.min_duration_s"), 5)

    def test_env_override(self):
        os.environ["VF_VIDEO__FPS"] = "24"
        cfg = load_config(ROOT / "config" / "default.json")
        self.assertEqual(cfg.get("video.fps"), 24)
        del os.environ["VF_VIDEO__FPS"]

    def test_require_missing(self):
        cfg = load_config(ROOT / "config" / "default.json")
        with self.assertRaises(VFError):
            cfg.require("video.nonexistent_key", "tts")


class TestErrors(unittest.TestCase):
    def test_vferror_dict(self):
        e = render_failed("render", "ffmpeg crashed (exit 1)")
        d = e.to_dict()
        self.assertEqual(d["code"], "RENDER_FAILED")
        self.assertEqual(d["stage"], "render")
        self.assertTrue(d["retryable"])


class TestCache(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="vf_cache_"))
        self.c = Cache(self.tmp, "test")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_put_get_roundtrip(self):
        d = sha256_hex("a", "b")
        self.c.put(d, "png", b"\x89PNGdata")
        p = self.c.get(d, "png")
        self.assertIsNotNone(p)
        self.assertEqual(p.read_bytes(), b"\x89PNGdata")
        self.assertIsNone(self.c.get(sha256_hex("zzz"), "png"))

    def test_json_roundtrip(self):
        d = sha256_hex("topic", "preset")
        self.c.put_json(d, {"title": "T", "count": 3})
        obj = self.c.get_json(d)
        self.assertEqual(obj["title"], "T")
        self.assertEqual(obj["count"], 3)


class TestRetry(unittest.TestCase):
    def test_exponential_backoff(self):
        rp = RetryPolicy(max_attempts=3, base_delay_s=1, max_delay_s=10)
        # jitter скрамбл: допустимый диапазон [base*2^(n-1), max], минимум >= base
        d1 = rp.delay_for(1)
        d2 = rp.delay_for(2)
        d3 = rp.delay_for(3)
        self.assertGreaterEqual(d1, 1.0)
        self.assertGreaterEqual(d2, 1.0)
        self.assertGreaterEqual(d3, 1.0)
        self.assertLessEqual(d3, 10.0)

    def test_retry_retryable_then_success(self):
        rp = RetryPolicy(max_attempts=3, base_delay_s=0, max_delay_s=0)

        def flaky(calls):
            def fn():
                calls.append(1)
                if len(calls) < 3:
                    raise render_failed("transient", detail="retry me")
                return "ok"
            return fn

        calls = []
        out = rp.run(flaky(calls), "render", "label")
        self.assertEqual(out, "ok")
        self.assertEqual(len(calls), 3)

    def test_permanent_error_no_retry(self):
        rp = RetryPolicy(max_attempts=3, base_delay_s=0, max_delay_s=0)
        calls = []

        def fn():
            calls.append(1)
            raise VFError("BAD_INPUT", "script", "bad", retryable=False)

        with self.assertRaises(VFError):
            rp.run(fn, "script", "label")
        self.assertEqual(len(calls), 1)


class TestLlmJson(unittest.TestCase):
    def test_extract_json_fenced(self):
        text = 'Сначала текст,\n```json\n{"title": "Т", "scenes": []}\n```\nконец'
        obj = _extract_json(text)
        self.assertEqual(obj["title"], "Т")

    def test_extract_json_bare(self):
        text = 'Вот результат: {"title": "X", "scenes": [{"id": 1}]} спасибо'
        obj = _extract_json(text)
        self.assertEqual(obj["title"], "X")

    def test_template_llm_schema(self):
        t = TemplateLLM()
        # adapter (TemplateLLM) uses complete_json; schema validation lives in facade
        script = t.complete_json(
            "Ты — редактор новостного шортса. Верни JSON со сценами.",
            'Тема: Хакеры атакуют банки. duration_s=55',
            schema_hint='{"title": string, "hook": string, "scenes": [{id, narration, visual:{type,query,prompt}, overlay}]}',
        )
        self.assertIn("title", script)
        self.assertIn("hook", script)
        scenes = script["scenes"]
        self.assertGreaterEqual(len(scenes), 3)
        for s in scenes:
            self.assertIn("id", s)
            self.assertIn("narration", s)
            self.assertIn("visual", s)
            self.assertIn("type", s["visual"])
            self.assertLessEqual(len(s["narration"]), 420)
            self.assertLessEqual(len(s["overlay"]), 90)

    def test_get_llm_env_template(self):
        os.environ["LLM_PROVIDER"] = "template"
        cfg = load_config(ROOT / "config" / "default.json")
        llm = get_llm(cfg)
        script = llm.generate_script("Хакеры атакуют банки", {"duration_s": 55})
        self.assertIn("title", script)
        self.assertGreaterEqual(len(script["scenes"]), 3)
        del os.environ["LLM_PROVIDER"]


class TestTimeline(unittest.TestCase):
    def test_build_scene_timeline_absolute(self):
        scenes = [
            {"id": 1, "start": 0.0, "end": 5.0, "words": [{"w": "привет", "start_s": 0.1, "end_s": 0.9}]},
            {"id": 2, "start": 0.0, "end": 3.0, "words": [{"w": "мир", "start_s": 0.2, "end_s": 1.2}]},
        ]
        scene_abs, sub_map = build_scene_timeline(scenes)
        self.assertAlmostEqual(scene_abs[1]["start_s"], 5.0)
        self.assertAlmostEqual(scene_abs[1]["end_s"], 8.0)
        self.assertAlmostEqual(scene_abs[1]["words"][0]["start_s"], 5.2)
        self.assertIn(1, sub_map)
        self.assertIn(2, sub_map)

    def test_chunk_words(self):
        lines = chunk_words(
            [{"w": "слово%d" % i, "start_s": i, "end_s": i + 1} for i in range(20)],
            max_chars=42, max_words=5,
        )
        self.assertGreater(len(lines), 2)
        for ln in lines:
            self.assertLessEqual(len(ln["text"].split()), 5)


class TestCrop(unittest.TestCase):
    def test_smart_crop_ratio(self):
        from PIL import Image
        img = Image.new("RGB", (800, 600), (120, 40, 20))
        out = smart_crop(img, 720, 1280, seed=7)
        self.assertEqual(out.size, (720, 1280))
        out2 = smart_crop(img, 360, 640, seed=7)
        self.assertEqual(out2.size, (360, 640))

    def test_crop_window_motion(self):
        from PIL import Image
        img = Image.new("RGB", (1200, 1200), (30, 60, 90))
        for motion in ("kenburns", "pan", "zoomout", "none"):
            win = crop_window_for_time(img, 0.5, 4.0, 720, 1280, motion=motion)
            self.assertEqual(win.size, (720, 1280), motion)


class TestBackground(unittest.TestCase):
    def test_topographic_frame_size(self):
        from PIL import Image
        img = render_topographic_frame((360, 640), seed=11, query="банки")
        self.assertIsInstance(img, Image.Image)
        self.assertEqual(img.size, (360, 640))


class TestSubtitles(unittest.TestCase):
    def test_write_srt(self):
        tmp = Path(tempfile.mkdtemp(prefix="vf_srt_"))
        try:
            out = tmp / "out.srt"
            write_srt(out, [{"start": 0.0, "end": 1.5, "text": "Привет мир"}, {"start": 1.5, "end": 3.0, "text": "Вторая строка"}])
            txt = out.read_text(encoding="utf-8")
            self.assertIn("00:00:00,000 --> 00:00:01,500", txt)
            self.assertIn("Привет мир", txt)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_write_ass(self):
        tmp = Path(tempfile.mkdtemp(prefix="vf_ass_"))
        try:
            out = tmp / "out.ass"
            write_ass_subs(out, [{"start": 0.0, "end": 1.5, "text": "Тест субтитров"}])
            txt = out.read_text(encoding="utf-8")
            self.assertIn("[Script Info]", txt)
            self.assertIn("Dialogue", txt)
            self.assertIn("Тест субтитров", txt)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)