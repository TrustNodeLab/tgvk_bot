"""Error model for Video Factory.

Every failure is a VFError with:
  - code:      stable machine-readable code (e.g. "TTS_UNAVAILABLE")
  - stage:     pipeline stage ("script" | "tts" | "assets" | "render" | "validate" | "upload")
  - retryable: whether the job may be retried (transient vs permanent failure)
  - message:   human-readable detail (never contains secrets)
"""


class VFError(Exception):
    def __init__(self, code: str, stage: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.stage = stage
        self.message = message
        self.retryable = retryable

    def to_dict(self) -> dict:
        return {
            "code": self.code,
            "stage": self.stage,
            "message": self.message,
            "retryable": self.retryable,
        }

    def __repr__(self) -> str:  # pragma: no cover - debug helper
        return f"VFError({self.code}, {self.stage}, retryable={self.retryable}): {self.message}"


# --- Permanent configuration errors ---
def config_missing(stage: str, key: str) -> VFError:
    return VFError("CONFIG_MISSING", stage, f"Required configuration {key!r} is not set", retryable=False)


def invalid_input(stage: str, detail: str) -> VFError:
    return VFError("INVALID_INPUT", stage, detail, retryable=False)


# --- Transient upstream failures (safe to retry) ---
def llm_unavailable(stage: str, detail: str) -> VFError:
    return VFError("LLM_UNAVAILABLE", stage, f"LLM provider error: {detail}", retryable=True)


def llm_invalid_json(stage: str, detail: str) -> VFError:
    return VFError("LLM_INVALID_JSON", stage, f"LLM returned invalid JSON: {detail}", retryable=False)


def tts_unavailable(stage: str, detail: str) -> VFError:
    return VFError("TTS_UNAVAILABLE", stage, f"TTS provider error: {detail}", retryable=True)


def asset_fetch_failed(stage: str, detail: str) -> VFError:
    return VFError("ASSET_FETCH_FAILED", stage, f"Visual asset fetch failed: {detail}", retryable=True)


def asset_invalid(stage: str, detail: str) -> VFError:
    return VFError("ASSET_INVALID", stage, f"Visual asset invalid: {detail}", retryable=False)


# --- Local processing failures ---
def ffmpeg_unavailable(stage: str, detail: str) -> VFError:
    return VFError("FFMPEG_UNAVAILABLE", stage, f"FFmpeg error: {detail}", retryable=False)


def render_failed(stage: str, detail: str) -> VFError:
    return VFError("RENDER_FAILED", stage, f"Render failed: {detail}", retryable=True)


def validation_failed(stage: str, detail: str) -> VFError:
    return VFError("VALIDATION_FAILED", stage, f"Output validation failed: {detail}", retryable=True)


def upload_failed(stage: str, detail: str) -> VFError:
    return VFError("UPLOAD_FAILED", stage, f"Upload failed: {detail}", retryable=True)


def callback_failed(stage: str, detail: str) -> VFError:
    return VFError("CALLBACK_FAILED", stage, f"Callback to Worker failed: {detail}", retryable=True)