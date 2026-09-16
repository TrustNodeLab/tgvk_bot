"""Retry policy with exponential backoff.

Applies only to retryable errors (VFError.retryable=True). NN failures are
bounded by config: retry.max_attempts (default 3), retry.base_delay_s (5),
retry.max_delay_s (120). Jitter avoids thundering herd on shared services.
"""

from __future__ import annotations

import random
import time
from typing import Callable, TypeVar

from .errors import VFError

T = TypeVar("T")


class RetryPolicy:
    def __init__(self, max_attempts: int = 3, base_delay_s: float = 5.0, max_delay_s: float = 120.0):
        self.max_attempts = max_attempts
        self.base_delay_s = base_delay_s
        self.max_delay_s = max_delay_s

    def delay_for(self, attempt: int) -> float:
        """attempt is 0-based. Exponential backoff + jitter."""
        exp = min(self.base_delay_s * (2 ** attempt), self.max_delay_s)
        jitter = random.uniform(0, exp * 0.2)
        return exp + jitter

    def run(self, fn: Callable[[], T], stage: str, label: str = "") -> T:
        last_err: Exception | None = None
        for attempt in range(self.max_attempts):
            try:
                return fn()
            except VFError as e:
                last_err = e
                if not e.retryable or attempt == self.max_attempts - 1:
                    raise
            except (TimeoutError, ConnectionError, OSError) as e:
                last_err = e
                if attempt == self.max_attempts - 1:
                    raise VFError("UPSTREAM_FAILED", stage, f"{label}{': ' if label else ''}{e}", retryable=True) from e
            delay = self.delay_for(attempt)
            time.sleep(delay)
        assert last_err is not None
        raise last_err