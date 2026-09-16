"""Provider abstractions: LLM / TTS / Visual / Storage.

Each provider is a small class with a stable interface. Adapters are selected
by config `providers.*` (e.g. llm=gigachat|gemini|template, tts=voicestudio|
edge|test, visual=pexels|generated, storage=r2|local|telegram).
```

Implementations never hardcode keys — everything comes from Config/env.
"""

from .llm import LLMProvider, get_llm
from .tts import TTSProvider, get_tts, TTSSegment
from .visual import VisualProvider, get_visual
from .storage import StorageProvider, get_storage

__all__ = [
    "LLMProvider", "get_llm",
    "TTSProvider", "get_tts", "TTSSegment",
    "VisualProvider", "get_visual",
    "StorageProvider", "get_storage",
]