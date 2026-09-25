"""Offline cross-boundary regression for the long-video source sentinel.

The active ``/long`` Worker route is executed in a Node subprocess with an
in-memory KV and a strict ``fetch`` stub, so no GitHub or Telegram request can
escape.  The workflow is not launched: its ``SCRIPT_TEXT`` step is extracted
with a small stdlib parser, the quoted ``--script-file`` transport is checked
and emulated in a temporary directory, and the real ``video_long.main()`` path
then runs until immediately after ``write_script()``.

That deliberate workflow limitation keeps the test hermetic while still proving
the full executable contract: Worker payload -> workflow input/source file ->
CLI -> ``generate_long()`` -> ``write_script(source_context=...)`` ->
``profiles.script_rules()`` -> every final ``llm._complete`` prompt.  No LLM
provider, TTS, ffmpeg, renderer, or network service is used.
"""
from __future__ import annotations

import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import ExitStack, redirect_stdout
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
BOT_ROOT = ROOT / "bot"
WORKFLOW = ROOT / ".github" / "workflows" / "video-long.yml"
sys.path.insert(0, str(BOT_ROOT))

import video_long as target  # noqa: E402


SENTINEL = "SENTINEL-SOURCE-CONTEXT-42"
WORKER_SOURCE_LIMIT = 3500
_TAIL_SENTINEL = "TAIL-MUST-NOT-SURVIVE-WORKER-BOUND"

_NODE_ROUTE_HARNESS = r"""
const testCases = __CASES_JSON__;
const { default: worker } = await import("./worker/worker.js");

async function runCase(source, profile) {
const values = new Map();
const env = {
  BOT_KV: {
    async get(key, type) {
      const value = values.get(key);
      if (value === undefined || value === null) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value) { values.set(key, value); },
    async delete(key) { values.delete(key); },
    async list({ prefix = "" } = {}) {
      return {
        keys: [...values.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((name) => ({ name })),
      };
    },
  },
  BOT_R2: null,
  GITHUB_TOKEN: "offline",
  OWNER: "offline",
  REPO: "offline",
  TELEGRAM_BOT_TOKEN: "offline",
  TELEGRAM_ADMIN_CHAT_ID: "1",
  TELEGRAM_CHANNEL_ID: "1",
  VK_TOKEN: "offline",
  VK_GROUP_ID: "1",
  BOT_AUTH: "offline",
  WEBHOOK_SECRET: "offline",
};

const githubCalls = [];
globalThis.fetch = async (url, options = {}) => {
  const value = String(url);
  if (value.includes("api.telegram.org")) {
    return new Response(
      JSON.stringify({ ok: true, result: { message_id: 1 } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }
  if (
    value.includes("api.github.com") &&
    value.includes("/actions/workflows/video-long.yml/dispatches")
  ) {
    githubCalls.push({ url: value, options });
    return new Response(null, { status: 204 });
  }
  throw new Error(`unexpected network call: ${value}`);
};

const suffix = profile === null ? "" : ` --profile ${profile}`;
const request = new Request("https://offline.invalid/", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Telegram-Bot-Api-Secret-Token": "offline",
  },
  body: JSON.stringify({
    update_id: 42,
    message: {
      message_id: 42,
      chat: { id: 1 },
      from: { id: 1 },
      text: `/long 1 doc offline topic${suffix}`,
      reply_to_message: {
        message_id: 41,
        chat: { id: 1 },
        text: source,
      },
    },
  }),
});

const pending = [];
const response = await worker.fetch(request, env, {
  waitUntil(promise) { pending.push(Promise.resolve(promise)); },
});
await Promise.all(pending);
if (response.status !== 200) {
  throw new Error(`worker webhook returned ${response.status}`);
}
if (githubCalls.length !== 1) {
  throw new Error(`expected one long-video dispatch, got ${githubCalls.length}`);
}
const payload = JSON.parse(githubCalls[0].options.body || "{}");
return payload;
}

const payloads = [];
for (const testCase of testCases) {
  payloads.push(await runCase(testCase.source, testCase.profile));
}
process.stdout.write(`WORKER_DISPATCH_JSON=${JSON.stringify(payloads)}`);
"""


class _StopAfterScript(Exception):
    """Stop before shot construction, stock lookup, render, and audio work."""


class LongProfileE2EContractTests(unittest.TestCase):
    def _workflow_step(self, name: str) -> str:
        text = WORKFLOW.read_text(encoding="utf-8")
        marker = f"      - name: {name}\n"
        start = text.find(marker)
        self.assertNotEqual(start, -1, f"workflow step not found: {name}")
        body_start = start + len(marker)
        next_step = re.search(r"(?m)^      - (?:name|uses):", text[body_start:])
        body_end = body_start + (next_step.start() if next_step else len(text) - body_start)
        return text[body_start:body_end]

    def _workflow_script_file(self, source: str, temp_root: Path) -> Path:
        """Validate and emulate only the workflow's quoted script-file branch."""
        step = self._workflow_step("Generate long video")
        self.assertIn("SCRIPT_TEXT: ${{ github.event.inputs.script }}", step)
        self.assertIn("VIDEO_PROFILE: ${{ steps.profile.outputs.canonical }}", step)
        self.assertIn(
            "printf '%s' \"$SCRIPT_TEXT\" > script.txt",
            step,
        )
        self.assertIn('SCRIPT_ARGS+=(--script-file "script.txt")', step)
        self.assertIn('--profile "$VIDEO_PROFILE"', step)
        self.assertIn('"${SCRIPT_ARGS[@]}"', step)

        write_match = re.search(
            r"""(?m)^\s*printf\s+'%s'\s+"\$SCRIPT_TEXT"\s+>\s*"""
            r"""(?P<path>[A-Za-z0-9_.-]+)\s*$""",
            step,
        )
        arg_match = re.search(
            r"""SCRIPT_ARGS\+=\(--script-file\s+"(?P<path>[^"]+)"\)""",
            step,
        )
        self.assertIsNotNone(write_match, "workflow SCRIPT_TEXT write not found")
        self.assertIsNotNone(arg_match, "quoted --script-file argument not found")
        self.assertEqual(
            write_match.group("path"),
            arg_match.group("path"),
            "workflow must pass the exact file created from SCRIPT_TEXT",
        )

        relative_path = Path(write_match.group("path"))
        self.assertFalse(relative_path.is_absolute(), "test adapter must stay sandboxed")
        script_path = temp_root / relative_path
        script_path.write_text(source, encoding="utf-8")
        return script_path

    def _run_worker_routes(
        self, cases: list[tuple[str, str | None]]
    ) -> list[dict]:
        node = shutil.which("node")
        self.assertIsNotNone(node, "Node.js is required for the active Worker route")
        harness = _NODE_ROUTE_HARNESS.replace(
            "__CASES_JSON__",
            json.dumps(
                [
                    {"source": source, "profile": profile}
                    for source, profile in cases
                ],
                ensure_ascii=False,
            ),
        )
        completed = subprocess.run(
            [node, "--input-type=module", "-"],
            input=harness,
            cwd=ROOT,
            text=True,
            encoding="utf-8",
            capture_output=True,
            timeout=30,
            check=False,
        )
        self.assertEqual(
            completed.returncode,
            0,
            "hermetic Worker route failed:\n"
            f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        marker = "WORKER_DISPATCH_JSON="
        marker_at = completed.stdout.rfind(marker)
        self.assertNotEqual(marker_at, -1, f"Worker payload missing: {completed.stdout!r}")
        payloads = json.loads(completed.stdout[marker_at + len(marker):])
        self.assertIsInstance(payloads, list)
        self.assertEqual(len(payloads), len(cases))
        return payloads

    def _capture_python_prompts(
        self,
        script_path: Path,
        profile: str,
        temp_root: Path,
    ) -> tuple[list[str], list[tuple[str, str]], int]:
        """Run the real CLI/generator path up to the first post-script boundary."""
        prompts: list[str] = []

        def complete(messages, provider=None):
            del provider
            prompts.append(
                "\n".join(str(message.get("content", "")) for message in messages)
            )
            return json.dumps(
                {
                    "heading": f"Evidence {len(prompts) + 1}",
                    "body": "source-grounded narration " * 60,
                    "query": "documentary evidence",
                }
            )

        def stop_after_script(*args, **kwargs):
            raise _StopAfterScript()

        with ExitStack() as stack:
            stack.enter_context(mock.patch.object(target.cine, "set_aspect"))
            stack.enter_context(
                mock.patch.object(target.vg, "find_ffmpeg", return_value="ffmpeg")
            )
            stack.enter_context(mock.patch.object(target.vg, "parse_script", return_value=[]))
            stack.enter_context(
                mock.patch.object(
                    target.cine,
                    "get_style",
                    return_value=(
                        {
                            "palette": {},
                            "bpm": 72,
                            "bed_level": 1.0,
                            "sfx_level": 1.0,
                        },
                        "documentary",
                    ),
                )
            )
            rules_mock = stack.enter_context(
                mock.patch.object(
                    target.profiles,
                    "script_rules",
                    wraps=target.profiles.script_rules,
                )
            )
            llm_mock = stack.enter_context(
                mock.patch.object(target.llm, "_complete", side_effect=complete)
            )
            stack.enter_context(
                mock.patch.object(target, "build_long_shots", side_effect=stop_after_script)
            )
            with redirect_stdout(io.StringIO()):
                with self.assertRaises(_StopAfterScript):
                    target.main(
                        [
                            "--topic",
                            "offline topic",
                            "--minutes",
                            "1",
                            "--format",
                            "doc",
                            "--profile",
                            profile,
                            "--script-file",
                            str(script_path),
                            "--out",
                            str(temp_root / "video.mp4"),
                            "--tmpdir",
                            str(temp_root / "tmp"),
                            "--no-audio",
                        ]
                    )

        self.assertTrue(prompts)
        self.assertEqual(llm_mock.call_count, len(prompts))
        self.assertEqual(rules_mock.call_count, len(prompts))
        rule_inputs = [
            (call.args[0], call.kwargs["source_context"])
            for call in rules_mock.call_args_list
        ]
        return prompts, rule_inputs, llm_mock.call_count

    def _assert_full_boundary(
        self,
        source: str,
        requested_profile: str | None,
        payload: dict,
    ) -> None:
        inputs = payload.get("inputs")
        self.assertIsInstance(inputs, dict, "Worker dispatch has no workflow inputs")
        expected_profile = "classic" if requested_profile is None else requested_profile
        self.assertEqual(inputs.get("profile"), expected_profile)
        self.assertEqual(inputs.get("minutes"), "1")
        self.assertEqual(inputs.get("format"), "doc")

        transported = inputs.get("script")
        self.assertIsInstance(transported, str)
        self.assertIn(SENTINEL, transported)
        self.assertLessEqual(len(transported), WORKER_SOURCE_LIMIT)

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            script_path = self._workflow_script_file(transported, temp_root)
            self.assertEqual(script_path.read_text(encoding="utf-8"), transported)
            prompts, rule_inputs, llm_call_count = self._capture_python_prompts(
                script_path, expected_profile, temp_root
            )

        normalized_source = " ".join(transported.split())
        for prompt, (rule_profile, rule_source) in zip(
            prompts, rule_inputs, strict=True
        ):
            self.assertEqual(rule_profile, expected_profile)
            self.assertEqual(rule_source, transported)
            self.assertIn(expected_profile, prompt)
            self.assertIn("profile_role", prompt)
            self.assertIn("<<<SOURCE_CONTEXT", prompt)
            self.assertIn(SENTINEL, prompt)

            context = prompt.split("<<<SOURCE_CONTEXT", 1)[1]
            context = context.split("SOURCE_CONTEXT", 1)[0].strip()
            self.assertIn(SENTINEL, context)
            self.assertIn(normalized_source, context)
            self.assertLessEqual(len(context), target.profiles.MAX_SOURCE_CONTEXT)

        self.assertEqual(llm_call_count, len(prompts))
        if len(source) > WORKER_SOURCE_LIMIT:
            self.assertEqual(len(transported), WORKER_SOURCE_LIMIT)
            self.assertNotIn(_TAIL_SENTINEL, transported)
            self.assertTrue(all(_TAIL_SENTINEL not in prompt for prompt in prompts))

    def test_route_profiles_survive_workflow_cli_and_every_final_prompt(self):
        default_source = f"{SENTINEL}\nDefault-profile source fact."
        casebook_source = (
            f"{SENTINEL}\n"
            + "bounded source fact with enough detail to cross the Worker limit. " * 90
            + f"\n{_TAIL_SENTINEL}"
        )
        self.assertGreater(len(casebook_source), WORKER_SOURCE_LIMIT)
        cases = [
            (default_source, None),
            (casebook_source, "trustnode_casebook"),
        ]
        payloads = self._run_worker_routes(cases)
        for case, payload in zip(cases, payloads, strict=True):
            source, requested_profile = case
            with self.subTest(profile=requested_profile or "classic"):
                self._assert_full_boundary(
                    source,
                    requested_profile=requested_profile,
                    payload=payload,
                )


if __name__ == "__main__":
    unittest.main(verbosity=2)
