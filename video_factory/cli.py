"""Command-line interface + dry-run + TEST_MODE.

Usage:
  python -m video_factory run "тема" [--work-dir work] [--preset trustnode_news] [--dry-run]
  python -m video_factory resume <job_id> [--from tts]
  python -m video_factory callback <job_id> <status> [--progress 100]

--dry-run / TEST_MODE=1 use template LLM + test TTS + generated visuals,
no network providers, no upload. Produces a real MP4 locally for verification.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .config import Config, load_config
from .pipeline import Pipeline, resume_pipeline, run_pipeline


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m video_factory", description="AI Video Factory pipeline")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_run = sub.add_parser("run", help="Full pipeline: topic -> MP4")
    p_run.add_argument("topic", nargs="?", default=None, help="Video topic (news headline); omit with --job-id")
    p_run.add_argument("--job-id", default=None, help="Fetch topic from Worker job payload")
    p_run.add_argument("--work-dir", default="work")
    p_run.add_argument("--config", default=None)
    p_run.add_argument("--preset", default="trustnode_news")
    p_run.add_argument("--dry-run", action="store_true", help="No network LLM/TTS/stocks; template+test providers")

    p_res = sub.add_parser("resume", help="Resume a job from a stage")
    p_res.add_argument("job_id")
    p_res.add_argument("--from", dest="from_stage", default=None, choices=["script", "tts", "assets", "render", "validate", "upload"])
    p_res.add_argument("--work-dir", default="work")
    p_res.add_argument("--config", default=None)

    p_cb = sub.add_parser("callback", help="Notify Worker about job progress/finish")
    p_cb.add_argument("job_id")
    p_cb.add_argument("status", choices=["running", "completed", "failed"])
    p_cb.add_argument("--progress", type=int, default=None)
    p_cb.add_argument("--error", default=None)
    p_cb.add_argument("--config", default=None)

    p_stage = sub.add_parser("stages", help="Show stage/progress mapping")

    args = parser.parse_args(argv)

    if args.cmd == "stages":
        from .pipeline import STAGES

        for k, v in STAGES.items():
            print(f"{v:3d}%  {k}")
        return 0

    cfg_path = Path(args.config) if getattr(args, "config", None) else None
    cfg = load_config(cfg_path)
    if getattr(args, "dry_run", False):
        os.environ["TEST_MODE"] = "1"
        os.environ["LLM_PROVIDER"] = "template"
        os.environ["TTS_PROVIDER"] = "test"
        cfg.data = {**cfg.data, "providers": {**(cfg.data.get("providers") or {}), "allow_web": False}}
        cfg.data.setdefault("storage", {})["type"] = "local"
        print("[dry-run] template LLM + test TTS + local storage")

    if args.cmd == "run":
        from .job_client import fetch_job, send_callback

        job_id = args.job_id
        topic = args.topic
        if not topic and job_id:
            job = fetch_job(cfg, job_id)
            if not job:
                print(f"[run] cannot fetch job {job_id} from Worker", file=sys.stderr)
                return 1
            topic = str(job.get("topic") or "").strip()
        if not topic:
            print("topic is required (pass it or use --job-id)", file=sys.stderr)
            return 2

        preset_name = args.preset
        preset = _load_preset(Path(cfg_path).parent if cfg_path else Path("config"), preset_name)
        meta = {"preset": preset, "preset_name": preset_name, "job_id": job_id}
        try:
            result = run_pipeline(topic, cfg, args.work_dir, meta)
        except Exception as e:
            if job_id:
                send_callback(cfg, job_id, "failed", error=str(e)[:400])
            raise
        if job_id:
            out = result.get("output")
            send_callback(cfg, job_id, "completed", progress=100, output=out)
        print(json.dumps({k: v for k, v in result.items() if k != "words"}, ensure_ascii=False, indent=2))
        return 0

    if args.cmd == "resume":
        result = resume_pipeline(args.job_id, cfg, args.work_dir, args.from_stage)
        print(json.dumps({k: v for k, v in result.items() if k != "words"}, ensure_ascii=False, indent=2))
        return 0

    if args.cmd == "callback":
        from .job_client import send_callback

        ok = send_callback(cfg, args.job_id, args.status, progress=args.progress, error=args.error)
        print("callback sent" if ok else "callback FAILED")
        return 0 if ok else 1

    return 2


def _load_preset(config_dir: Path, name: str) -> dict:
    p = config_dir / "presets" / f"{name}.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    repo = Path(__file__).resolve().parent.parent
    p = repo / "presets" / f"{name}.json"
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return {"duration_s": 55, "llm": {}, "visual": {"style": "dark"}}  # built-in fallback


if __name__ == "__main__":
    sys.exit(main())