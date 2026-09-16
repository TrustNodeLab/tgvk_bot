"""Structured logging with stage tagging.

Never logs secrets: callers must pass only safe strings.
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any


class Logger:
    def __init__(self, name: str = "vf", level: str | None = None):
        self.name = name
        self.level = (level or os.environ.get("VF_LOG_LEVEL", "INFO")).upper()
        self._levels = {"DEBUG": 10, "INFO": 20, "WARN": 30, "ERROR": 40}

    def _log(self, lvl: str, msg: str, **fields: Any) -> None:
        if self._levels.get(lvl, 20) < self._levels.get(self.level, 20):
            return
        rec = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()),
            "level": lvl,
            "logger": self.name,
            "msg": msg,
        }
        rec.update(fields)
        line = json.dumps(rec, ensure_ascii=False, default=str)
        stream = sys.stderr if lvl == "ERROR" else sys.stdout
        try:
            print(line, file=stream, flush=True)
        except Exception:
            pass  # never crash on logging

    def debug(self, msg: str, **kw): self._log("DEBUG", msg, **kw)
    def info(self, msg: str, **kw): self._log("INFO", msg, **kw)
    def warn(self, msg: str, **kw): self._log("WARN", msg, **kw)
    def error(self, msg: str, **kw): self._log("ERROR", msg, **kw)


def get_logger(name: str = "vf") -> Logger:
    return Logger(name)