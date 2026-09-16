"""Video Factory — production pipeline for vertical 9:16 AI short videos.

Architecture:
    User --/video--> Telegram --> Cloudflare Worker (job orchestration, KV state)
        --> dispatch job_id --> GitHub Actions (compute/render)
        --> FFmpeg MP4 --> storage (TG/R2) --> callback --> Worker --> User

The Worker NEVER renders. All heavy work runs in GitHub Actions.
"""

__version__ = "1.0.0"