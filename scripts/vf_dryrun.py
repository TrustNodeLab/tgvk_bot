# -*- coding: utf-8 -*-
"""Local dry-run driver — avoids PowerShell arg encoding issues."""
import sys, shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
WORK = ROOT / "work" / "drytest"

if WORK.exists():
    shutil.rmtree(WORK)

from video_factory.config import load_config
from video_factory.pipeline import run_pipeline
from video_factory.cli import _load_preset
from video_factory.logging import get_logger

log = get_logger("vf.dryrun")

def main() -> int:
    cfg = load_config(ROOT / "config" / "default.json")
    preset_name = "trustnode_news"
    preset = _load_preset(ROOT / "config", preset_name)
    meta = {"preset": preset, "preset_name": preset_name, "job_id": None}
    # dry-run overrides
    import os
    os.environ["TEST_MODE"] = "1"
    os.environ["LLM_PROVIDER"] = "template"
    os.environ["TTS_PROVIDER"] = "test"
    os.environ["STORAGE_TYPE"] = "local"
    cfg.data.setdefault("providers", {})["allow_web"] = False

    topic = "Хакеры атакуют банки: новая волна фишинга"
    result = run_pipeline(topic, cfg, WORK, meta)
    log.info("DRY-RUN OK", result=result)
    return 0

if __name__ == "__main__":
    sys.exit(main())