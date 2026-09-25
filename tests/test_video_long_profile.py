"""Offline contract tests for the long-video profile integration.

The tests target :mod:`bot.video_long` and mock every external boundary needed
by the script, shot-list, EDL, and CLI paths.  No network, TTS, ffmpeg, or
render service is used.  A failing assertion is intentional while the runtime
integration is being implemented; the tests state the public contract rather
than weakening it to match the current baseline.
"""
from __future__ import annotations

import inspect
import io
import json
import os
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# ``video_long`` loads its sibling runtime modules by their legacy top-level
# names.  Keep the profile registry in that same import mode so this suite
# and ``test_long_profiles`` share one module object in CI and locally.
sys.path.insert(0, os.path.join(ROOT, "bot"))

import video_long as target  # noqa: E402
from long_profiles import UnknownProfileError  # noqa: E402


SENTINEL = "SENTINEL-SOURCE-CONTEXT-42"


class _StopAfterScript(Exception):
    """Stop the public-path test before stock, render, and audio work."""


def _bound_inner_arguments(call):
    """Bind a mocked inner call to its current signature for stable assertions."""
    signature = inspect.signature(target._generate_long_inner)
    return signature.bind(*call.args, **call.kwargs).arguments


def _quietly(func, *args, **kwargs):
    """Run a mocked pipeline call without depending on the console code page."""
    with redirect_stdout(io.StringIO()):
        return func(*args, **kwargs)


def _casebook_sections():
    sections = []
    for index, contract in enumerate(
        target.profiles.blueprint("trustnode_casebook", 1, "doc")
    ):
        sections.append(
            {
                **contract,
                "heading": f"Evidence {index + 1}",
                "body": "A source-grounded sentence. " * 8,
                "query": "documentary evidence",
            }
        )
    return sections


class LongVideoProfileTests(unittest.TestCase):
    def test_unknown_profile_fails_before_expensive_inner_work(self):
        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "video.mp4")
            tmpdir = os.path.join(td, "tmp")
            with mock.patch.object(target, "_generate_long_inner") as inner:
                with mock.patch.object(target.os, "makedirs") as make_dirs:
                    with self.assertRaises((ValueError, UnknownProfileError)):
                        target.generate_long(
                            topic="offline",
                            profile="not-registered",
                            out=out,
                            tmpdir=tmpdir,
                        )
            inner.assert_not_called()
            make_dirs.assert_not_called()

    def test_write_script_sends_bounded_source_context_to_every_final_prompt(self):
        prompts = []

        def complete(messages, provider=None):
            prompt = "\n".join(str(message.get("content", "")) for message in messages)
            prompts.append(prompt)
            return json.dumps(
                {
                    "heading": "Evidence",
                    "body": "grounded narration " * 45,
                    "query": "documentary evidence",
                }
            )

        source = SENTINEL + (" additional source context " * 2000)
        with mock.patch.object(
            target, "llm", types.SimpleNamespace(_complete=complete)
        ):
            sections = _quietly(
                target.write_script,
                "case",
                1,
                "doc",
                provider="unit",
                profile="trustnode_casebook",
                source_context=source,
            )

        self.assertTrue(sections)
        self.assertEqual(len(prompts), len(sections))
        for prompt in prompts:
            self.assertIn(SENTINEL, prompt)
            self.assertIn("trustnode_casebook", prompt)
            self.assertIn("profile_role", prompt)
            self.assertGreaterEqual(prompt.count("SOURCE_CONTEXT"), 2)
            self.assertIn("<<<SOURCE_CONTEXT", prompt)
            context = prompt.split("<<<SOURCE_CONTEXT", 1)[1]
            context = context.split("SOURCE_CONTEXT", 1)[0].strip()
            self.assertLessEqual(len(context), target.profiles.MAX_SOURCE_CONTEXT)
            self.assertLess(
                len(context), len(source),
                "the profile prompt must not carry the unbounded source body",
            )

    def test_inner_script_path_delivers_source_context_to_write_script(self):
        seen = {}
        write_signature = inspect.signature(target.write_script)
        build_signature = inspect.signature(target.build_long_shots)

        def fake_write_script(*args, **kwargs):
            seen["write_arguments"] = write_signature.bind_partial(
                *args, **kwargs
            ).arguments
            return [
                {
                    "heading": "Mechanism",
                    "body": "A sourced line.",
                    "query": "documentary evidence",
                    "role": "chapter",
                    "profile_role": "mechanism",
                    "visual_mode": "mechanism_steps",
                    "protected": False,
                    "anchor": None,
                }
            ]

        def stop_after_shots(*args, **kwargs):
            seen["shot_arguments"] = build_signature.bind_partial(
                *args, **kwargs
            ).arguments
            raise _StopAfterScript()

        with tempfile.TemporaryDirectory() as td:
            out = os.path.join(td, "video.mp4")
            tmpdir = os.path.join(td, "tmp")
            with mock.patch("builtins.print"), mock.patch.object(
                target.cine,
                "get_style",
                return_value=(
                    {"palette": {}, "bpm": 72, "bed_level": 1.0, "sfx_level": 1.0},
                    "documentary",
                ),
            ), mock.patch.object(
                target.vg, "find_ffmpeg", return_value="ffmpeg"
            ), mock.patch.object(
                target.vg, "parse_script", return_value=[]
            ), mock.patch.object(
                target, "write_script", side_effect=fake_write_script
            ), mock.patch.object(
                target, "build_long_shots", side_effect=stop_after_shots
            ):
                with self.assertRaises(_StopAfterScript):
                    target._generate_long_inner(
                        "offline",
                        1,
                        "doc",
                        out,
                        60,
                        tmpdir,
                        "voice",
                        True,
                        False,
                        None,
                        None,
                        SENTINEL,
                        None,
                        7,
                        None,
                        profile="trustnode_casebook",
                    )

        self.assertEqual(seen["write_arguments"]["source_context"], SENTINEL)
        self.assertEqual(seen["write_arguments"]["profile"], "trustnode_casebook")
        self.assertEqual(seen["shot_arguments"]["profile"], "trustnode_casebook")

    def test_public_generate_long_uses_casebook_style_and_source_context(self):
        prompts = []

        def complete(messages, provider=None):
            prompt = "\n".join(
                str(message.get("content", "")) for message in messages
            )
            prompts.append(prompt)
            return json.dumps(
                {
                    "heading": "Evidence",
                    "body": "grounded narration " * 45,
                    "query": "documentary evidence",
                }
            )

        def stop_before_expensive_work(*args, **kwargs):
            raise _StopAfterScript()

        with mock.patch("builtins.print"), \
             mock.patch.object(target.os, "makedirs"), \
             mock.patch.object(target.cine, "set_aspect"), \
             mock.patch.object(target.vg, "parse_script", return_value=[]), \
             mock.patch.object(target.vg, "find_ffmpeg", return_value="ffmpeg"), \
             mock.patch.object(
                 target.cine,
                 "get_style",
                 return_value=({"palette": {}, "bpm": 72}, "documentary"),
             ) as get_style, \
             mock.patch.object(
                 target, "llm", types.SimpleNamespace(_complete=complete)
             ), \
             mock.patch.object(
                 target, "build_long_shots", side_effect=stop_before_expensive_work
             ):
            with self.assertRaises(_StopAfterScript):
                target.generate_long(
                    topic="offline",
                    minutes=1,
                    script_text=SENTINEL,
                    profile="trustnode_casebook",
                    no_audio=True,
                )

        self.assertTrue(prompts)
        self.assertTrue(all(SENTINEL in prompt for prompt in prompts))
        self.assertTrue(all("trustnode_casebook" in prompt for prompt in prompts))
        get_style.assert_called()
        style_values = (*get_style.call_args.args, *get_style.call_args.kwargs.values())
        self.assertTrue(any("documentary" in str(value) for value in style_values))

    def test_generate_long_forwards_profile_and_script_context(self):
        with mock.patch.object(target, "_generate_long_inner", return_value="ok") as inner:
            with mock.patch.object(target.cine, "set_aspect"):
                with mock.patch.object(target.os, "makedirs"):
                    result = target.generate_long(
                        topic="offline",
                        minutes=1,
                        script_text=SENTINEL,
                        profile="trustnode_casebook",
                    )

        self.assertEqual(result, "ok")
        arguments = _bound_inner_arguments(inner.call_args)
        self.assertEqual(arguments["script_text"], SENTINEL)
        self.assertEqual(arguments["profile"], "trustnode_casebook")

    def test_omitted_profile_keeps_the_classic_default(self):
        with mock.patch.object(target, "_generate_long_inner", return_value="ok") as inner:
            with mock.patch.object(target.cine, "set_aspect"):
                with mock.patch.object(target.os, "makedirs"):
                    target.generate_long(topic="offline", minutes=1)

        arguments = _bound_inner_arguments(inner.call_args)
        self.assertEqual(arguments.get("profile", "classic"), "classic")

    def test_blank_profile_uses_the_classic_compatibility_key(self):
        with mock.patch.object(target, "_generate_long_inner", return_value="ok") as inner:
            with mock.patch.object(target.cine, "set_aspect"):
                with mock.patch.object(target.os, "makedirs"):
                    target.generate_long(
                        topic="offline", minutes=1, profile="  \t "
                    )

        arguments = _bound_inner_arguments(inner.call_args)
        self.assertEqual(arguments.get("profile", "classic"), "classic")

    def test_casebook_shots_apply_policy_and_keep_anchors_during_trim(self):
        sections = _casebook_sections()
        with mock.patch.object(
            target,
            "_pixel_interstitial",
            side_effect=AssertionError("casebook must not use an interstitial"),
        ) as interstitial:
            shots = target.build_long_shots(
                sections,
                "case",
                profile="trustnode_casebook",
                target_sec=1,
            )

        self.assertTrue(shots)
        self.assertEqual(interstitial.call_count, 0)
        self.assertTrue(all(shot.get("profile") == "trustnode_casebook" for shot in shots))
        self.assertTrue(
            any(shot.get("visual_mode") == "mechanism_steps" for shot in shots)
        )
        anchors = {
            shot.get("anchor")
            for shot in shots
            if shot.get("protected") and shot.get("anchor")
        }
        self.assertIn("cold_open", anchors)
        self.assertIn("close", anchors)

    def test_classic_shot_list_keeps_legacy_ids_and_voice_fields(self):
        sections = [
            {
                "heading": f"Section {index + 1}",
                "body": "A legacy voice sentence. " * 5,
                "role": "hook" if index == 0 else "chapter",
                "query": "technology abstract",
            }
            for index in range(3)
        ]
        shots = target.build_long_shots(sections, "legacy", target_sec=600)
        self.assertTrue(shots)
        self.assertTrue(all(shot.get("id") for shot in shots))
        self.assertTrue(any(shot.get("voice") for shot in shots))

    def test_edl_persists_and_restores_the_canonical_profile(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "video.edl.json")
            target.dump_edl(
                path,
                "case",
                "doc",
                1,
                60,
                [{"id": "shot-1", "dur": 1.0, "voice": "line"}],
                [0.0, 1.0],
                profile="  TrustNode_Casebook  ",
            )
            with open(path, encoding="utf-8") as handle:
                payload = json.load(handle)
            self.assertEqual(payload["profile"], "trustnode_casebook")
            shots, metadata = target.load_edl(path)

        self.assertEqual(shots[0]["id"], "shot-1")
        self.assertEqual(metadata["profile"], "trustnode_casebook")
        self.assertEqual(metadata["format"], "doc")

    def test_legacy_edl_without_profile_remains_classic(self):
        with tempfile.TemporaryDirectory() as td:
            path = os.path.join(td, "legacy.edl.json")
            with open(path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "app": "tgvk-longform",
                        "version": 1,
                        "topic": "legacy",
                        "format": "doc",
                        "minutes": 1,
                        "fps": 60,
                        "shots": [
                            {"id": "L00_00", "dur": 1.0, "voice": "line"}
                        ],
                    },
                    handle,
                )
            shots, metadata = target.load_edl(path)

        self.assertEqual(shots[0]["id"], "L00_00")
        self.assertEqual(
            target.profiles.get_profile(metadata.get("profile"))[1], "classic"
        )

    def test_cli_script_file_reaches_final_llm_prompt(self):
        prompts = []

        def complete(messages, provider=None):
            prompt = "\n".join(
                str(message.get("content", "")) for message in messages
            )
            prompts.append(prompt)
            return json.dumps(
                {
                    "heading": "Evidence",
                    "body": "grounded narration " * 45,
                    "query": "documentary evidence",
                }
            )

        def stop_after_script(*args, **kwargs):
            raise _StopAfterScript()

        with mock.patch("builtins.open", mock.mock_open(read_data=SENTINEL)), \
             mock.patch("builtins.print"), \
             mock.patch.object(target.os, "makedirs"), \
             mock.patch.object(target.cine, "set_aspect"), \
             mock.patch.object(target.vg, "parse_script", return_value=[]), \
             mock.patch.object(target.vg, "find_ffmpeg", return_value="ffmpeg"), \
             mock.patch.object(
                 target.cine,
                 "get_style",
                 return_value=({"palette": {}, "bpm": 72}, "documentary"),
             ), \
             mock.patch.object(
                 target, "llm", types.SimpleNamespace(_complete=complete)
             ), \
             mock.patch.object(
                 target, "build_long_shots", side_effect=stop_after_script
             ):
            with self.assertRaises(_StopAfterScript):
                target.main(
                    [
                        "--script-file",
                        "article.txt",
                        "--profile",
                        "trustnode_casebook",
                        "--minutes",
                        "1",
                    ]
                )

        self.assertTrue(prompts)
        self.assertTrue(all(SENTINEL in prompt for prompt in prompts))
        self.assertTrue(all("trustnode_casebook" in prompt for prompt in prompts))
        self.assertTrue(all("SOURCE_CONTEXT" in prompt for prompt in prompts))

    def test_cli_passes_profile_and_retains_format_aliases(self):
        for profile_args in (
            ["--profile", "trustnode_casebook"],
            ["--profile=trustnode_casebook"],
        ):
            with self.subTest(profile_args=profile_args):
                seen = {}

                def fake_generate(**kwargs):
                    seen.update(kwargs)
                    return "ok"

                with mock.patch.object(
                    target, "generate_long", side_effect=fake_generate
                ):
                    target.main(
                        [
                            "--format",
                            "top",
                            "--topic",
                            "offline",
                            *profile_args,
                        ]
                    )

                self.assertEqual(seen["format"], "top10")
                self.assertEqual(seen["profile"], "trustnode_casebook")

    def test_cli_script_file_preserves_source_text_for_the_api(self):
        seen = {}

        def fake_generate(**kwargs):
            seen.update(kwargs)
            return "ok"

        with mock.patch("builtins.open", mock.mock_open(read_data=SENTINEL)):
            with mock.patch.object(target, "generate_long", side_effect=fake_generate):
                target.main(
                    [
                        "--script-file",
                        "article.txt",
                        "--profile",
                        "trustnode_casebook",
                    ]
                )

        self.assertEqual(seen["script_text"], SENTINEL)
        self.assertEqual(seen["profile"], "trustnode_casebook")


if __name__ == "__main__":
    unittest.main(verbosity=2)
