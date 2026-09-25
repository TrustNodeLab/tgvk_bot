"""Offline stdlib tests for the digest video workflow dispatch contract.

The target is :mod:`bot.digest`.  GitHub REST is mocked, so these tests never
perform network or filesystem I/O.  The dispatch API is intentionally dormant
in the current Python application: no Telegram call site is wired in
``bot/main.py``.
"""
from __future__ import annotations

import os
import sys
import unittest
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "bot"))

import digest  # noqa: E402


class Response:
    """Small successful GitHub dispatch response used by the mocks."""

    status_code = 204
    text = ""


class ErrorResponse:
    """Small rejected GitHub response used by the HTTP-error test."""

    status_code = 500
    text = "upstream failed"


class DigestVideoDispatchTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {"GH_PAT": "test-pat"}, clear=False)
        self.environment.start()
        self.addCleanup(self.environment.stop)

        self.post = patch.object(
            digest.requests,
            "post",
            return_value=Response(),
        )
        self.mock_post = self.post.start()
        self.addCleanup(self.post.stop)

    def test_omitted_profile_defaults_to_classic(self):
        self.assertTrue(
            digest.dispatch_video_workflow(
                topic="topic",
                from_post="post",
                minutes="7",
                format="breakdown",
                script="script",
            )
        )

        self.assertEqual(
            self.mock_post.call_args.kwargs["json"],
            {
                "ref": "main",
                "inputs": {
                    "minutes": "7",
                    "format": "breakdown",
                    "topic": "topic",
                    "script": "script",
                    "from_post": "post",
                    "profile": "classic",
                },
            },
        )

    def test_blank_profile_uses_compatibility_default(self):
        self.assertTrue(digest.dispatch_video_workflow(profile=" \t "))
        self.assertEqual(
            self.mock_post.call_args.kwargs["json"]["inputs"]["profile"],
            "classic",
        )

    def test_explicit_profile_is_canonicalized_and_existing_inputs_remain(self):
        self.assertTrue(
            digest.dispatch_video_workflow(
                topic="source topic",
                from_post="source post",
                minutes="6",
                format="top",
                script="SENTINEL-SOURCE-CONTEXT-42",
                profile="  TrustNode_Casebook  ",
            )
        )

        call = self.mock_post.call_args
        self.assertEqual(
            call.kwargs["json"],
            {
                "ref": "main",
                "inputs": {
                    "minutes": "6",
                    "format": "top",
                    "topic": "source topic",
                    "script": "SENTINEL-SOURCE-CONTEXT-42",
                    "from_post": "source post",
                    "profile": "trustnode_casebook",
                },
            },
        )
        self.assertEqual(
            call.args[0],
            "https://api.github.com/repos/TrustNodeLab/tgvk_bot/actions/workflows/"
            "video-long.yml/dispatches",
        )
        self.assertEqual(
            call.kwargs["headers"],
            {
                "Authorization": "Bearer test-pat",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        self.assertEqual(call.kwargs["timeout"], 25)

    def test_unknown_profile_fails_before_token_or_network_work(self):
        with patch.dict(os.environ, {"GH_PAT": ""}, clear=False):
            with self.assertRaisesRegex(ValueError, "unknown long-video profile"):
                digest.dispatch_video_workflow(profile="not-a-profile")

        self.mock_post.assert_not_called()

    def test_http_error_is_reported_without_retry(self):
        self.mock_post.return_value = ErrorResponse()

        with self.assertRaisesRegex(RuntimeError, r"HTTP 500 upstream failed"):
            digest.dispatch_video_workflow(topic="topic", profile="classic")

        self.mock_post.assert_called_once()

    def test_network_error_is_wrapped(self):
        self.mock_post.side_effect = TimeoutError("timed out")

        with self.assertRaisesRegex(RuntimeError, r"dispatch network error: timed out"):
            digest.dispatch_video_workflow(topic="topic", profile="classic")

        self.mock_post.assert_called_once()

    def test_missing_token_behavior_for_valid_profile_is_unchanged(self):
        with patch.dict(os.environ, {"GH_PAT": ""}, clear=False):
            with self.assertRaisesRegex(RuntimeError, "GH_PAT"):
                digest.dispatch_video_workflow(
                    topic="topic",
                    from_post="post",
                    minutes="6",
                    format="doc",
                    script="",
                )

        self.mock_post.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
