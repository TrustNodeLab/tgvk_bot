"""Offline regression coverage for SYNC-12 and SYNC-14.

The suite exercises the public long-video orchestration with mocked renderer,
TTS, ffmpeg, and network boundaries.  The workflow checks are static and do
not start GitHub Actions or contact external services.
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "bot"))
import video_long as target  # noqa: E402


WORKFLOW = ROOT / ".github" / "workflows" / "video-long.yml"


class LongVideoRecoveryTests(unittest.TestCase):
    def test_no_audio_smoke_copies_render_and_writes_profile_edl(self):
        for profile in ("classic", "trustnode_casebook"):
            with self.subTest(profile=profile), tempfile.TemporaryDirectory() as td:
                out = os.path.join(td, "video.mp4")
                edl = os.path.join(td, "video.edl.json")
                tmpdir = os.path.join(td, "tmp")
                rendered = {}
                sections = [{
                    "heading": "Evidence",
                    "body": "A grounded sentence.",
                    "query": "documentary evidence",
                    "role": "chapter",
                    "profile_role": "evidence",
                    "visual_mode": "documentary_evidence",
                }]
                shot = {
                    "id": "L00_00",
                    "sec": 0,
                    "act": "chapter",
                    "dur": 1.0,
                    "visual": "evidence",
                    "voice": "",
                }

                def fake_render(shots, seconds, fps, silent, bpm, palette,
                                render_tmpdir, stock=None):
                    rendered["shots"] = list(shots)
                    with open(silent, "wb") as handle:
                        handle.write(b"silent-render")
                    return None, [0.0, float(seconds)]

                def fake_shots(*args, **kwargs):
                    rendered["profile"] = kwargs.get("profile")
                    return [dict(shot, profile=kwargs.get("profile"))]

                def fake_style(style_name):
                    rendered["style_name"] = style_name
                    return {"palette": {}, "bpm": 72}, style_name

                with mock.patch.object(target.cine, "set_aspect"), \
                     mock.patch.object(
                         target.cine,
                         "get_style",
                         side_effect=fake_style,
                     ), \
                     mock.patch.object(target.vg, "find_ffmpeg", return_value="ffmpeg"), \
                     mock.patch.object(target, "write_script", return_value=sections), \
                     mock.patch.object(target, "build_long_shots", side_effect=fake_shots), \
                     mock.patch.object(target.cine, "enforce_balance", side_effect=lambda shots: shots), \
                     mock.patch.object(target, "fetch_section_stock", return_value=[]), \
                     mock.patch.object(target.cine, "render_cinematic", side_effect=fake_render), \
                     redirect_stdout(io.StringIO()):
                    result = target.generate_long(
                        topic="offline",
                        minutes=1,
                        out=out,
                        tmpdir=tmpdir,
                        no_audio=True,
                        voice_over=False,
                        edl_out=edl,
                        script_text="source",
                        profile=profile,
                    )

                self.assertEqual(result, out)
                self.assertEqual(rendered["profile"], profile)
                self.assertEqual(
                    rendered["style_name"],
                    "cybersecurity_cinematic"
                    if profile == "classic" else "documentary",
                )
                with open(out, "rb") as handle:
                    self.assertEqual(handle.read(), b"silent-render")
                with open(edl, encoding="utf-8") as handle:
                    payload = json.load(handle)
                self.assertEqual(payload["profile"], profile)
                self.assertEqual(payload["shots"][0]["profile"], profile)

    def test_no_audio_with_explicit_srt_fails_before_render(self):
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "video.mp4")
            with mock.patch.object(target.cine, "render_cinematic") as render:
                with self.assertRaisesRegex(RuntimeError, "SRT.*аудио"):
                    target.generate_long(
                        topic="offline",
                        out=out,
                        tmpdir=os.path.join(td, "tmp"),
                        no_audio=True,
                        srt_out=os.path.join(td, "video.srt"),
                    )
            render.assert_not_called()

    def test_dual_script_and_post_are_rejected_before_file_or_generation_work(self):
        with mock.patch.object(target, "generate_long") as generate, \
             mock.patch("builtins.open", side_effect=AssertionError("source opened")):
            stderr = io.StringIO()
            with redirect_stderr(stderr), self.assertRaises(SystemExit) as raised:
                target.main([
                    "--script-file", "script.txt",
                    "--from-post", "post.txt",
                ])
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("mutually exclusive", stderr.getvalue())
        generate.assert_not_called()

    def test_single_script_source_remains_supported(self):
        seen = {}
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
            handle.write("SCRIPT-ONLY-SENTINEL")
            script_path = handle.name
        try:
            with mock.patch.object(
                target,
                "generate_long",
                side_effect=lambda **kwargs: seen.update(kwargs) or "ok",
            ):
                target.main(["--script-file", script_path, "--profile", "classic"])
        finally:
            os.unlink(script_path)
        self.assertEqual(seen["script_text"], "SCRIPT-ONLY-SENTINEL")
        self.assertEqual(seen["source_context"], "SCRIPT-ONLY-SENTINEL")

    def test_single_post_source_remains_supported(self):
        for profile in ("classic", "trustnode_casebook"):
            with self.subTest(profile=profile):
                seen = {}
                post_module = mock.Mock()
                post_module.rewrite_post_to_script.return_value = "REWRITTEN-POST"
                with tempfile.NamedTemporaryFile(
                    "w", encoding="utf-8", delete=False
                ) as handle:
                    handle.write("POST-ONLY-SENTINEL")
                    post_path = handle.name
                try:
                    with mock.patch.dict(sys.modules, {"llm": post_module}), \
                         mock.patch.object(
                             target,
                             "generate_long",
                             side_effect=lambda **kwargs: seen.update(kwargs) or "ok",
                         ), \
                         redirect_stdout(io.StringIO()):
                        target.main([
                            "--from-post",
                            post_path,
                            "--profile",
                            profile,
                            "--minutes",
                            "7",
                        ])
                finally:
                    os.unlink(post_path)
                post_module.rewrite_post_to_script.assert_called_once()
                rewrite_args, rewrite_kwargs = post_module.rewrite_post_to_script.call_args
                self.assertEqual(rewrite_args[0], "POST-ONLY-SENTINEL")
                self.assertEqual(rewrite_args[1], "long")
                self.assertEqual(rewrite_kwargs["profile"], profile)
                self.assertEqual(rewrite_kwargs["minutes"], 7)
                self.assertEqual(
                    rewrite_kwargs["source_context"], "POST-ONLY-SENTINEL"
                )
                self.assertEqual(seen["script_text"], "REWRITTEN-POST")
                self.assertEqual(seen["source_context"], "POST-ONLY-SENTINEL")
                self.assertEqual(seen["profile"], profile)

    def test_workflow_rejects_dual_sources_before_setup(self):
        text = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("LONG_SCRIPT_INPUT: ${{ github.event.inputs.script }}", text)
        self.assertIn("LONG_POST_INPUT: ${{ github.event.inputs.from_post }}", text)
        self.assertIn("script and from_post are mutually exclusive", text)
        validation = text.split("      - name: Validate source inputs", 1)[1]
        validation = validation.split("      - uses: actions/setup-python@v6", 1)[0]
        self.assertIn('${LONG_SCRIPT_INPUT:-}', validation)
        self.assertIn('${LONG_POST_INPUT:-}', validation)
        validation_index = text.index("      - name: Validate source inputs")
        self.assertLess(
            validation_index,
            text.index("      - uses: actions/setup-python@v6"),
        )
        self.assertLess(
            validation_index,
            text.index("      - name: Install dependencies"),
        )
        self.assertLess(
            validation_index,
            text.index("      - name: Start VoiceStudio"),
        )
        self.assertIn('SCRIPT_TEXT: ${{ github.event.inputs.script }}', text)
        self.assertIn('SCRIPT_ARGS+=(--script-file "script.txt")', text)
        self.assertIn('SCRIPT_ARGS+=(--from-post "post.txt")', text)
        self.assertIn('"${SCRIPT_ARGS[@]}"', text)
        generation = text.split("      - name: Generate long video", 1)[1]
        generation = generation.split("      - name: Require non-empty SRT", 1)[0]
        guard = 'if [ -n "${SCRIPT_TEXT:-}" ] && [ -n "${POST_TEXT:-}" ]; then'
        self.assertIn(guard, generation)
        self.assertLess(generation.index(guard), generation.index('printf'))
        self.assertIn(
            "script and from_post are mutually exclusive; provide only one source",
            generation,
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
