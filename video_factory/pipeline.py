"""Pipeline orchestration: script -> scenes -> tts -> assets -> render -> validate -> upload.

Job artifacts live under work/<job_id>/:
  script.json, scenes.json, timeline.json, audio/, assets/, frames/, final.mp4,
  final.srt, final.ass, thumbnail.png, metadata.json
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from .cache import Cache, sha256_hex
from .config import Config
from .errors import VFError, config_missing, invalid_input
from .logging import get_logger
from .providers import get_llm, get_storage, get_tts, get_visual

log = get_logger("vf.pipeline")

# Job lifecycle stages (progress mapping mirror):
# 0-10 planning, 10-25 script, 25-40 tts, 40-60 assets, 60-85 render, 85-95 validate, 95-100 upload
STAGES = {
    "init": 0,
    "script": 10,
    "plan": 15,
    "tts": 25,
    "assets": 40,
    "render": 60,
    "validate": 85,
    "upload": 95,
    "done": 100,
}


class Job:
    """Resumable job: state persisted to work/<job_id>/job.json after each stage."""

    def __init__(self, work_dir: Path, cfg: Config):
        self.work = Path(work_dir)
        self.cfg = cfg
        self.state_path = self.work / "job.json"
        self.state: dict[str, Any] = self._load()
        self.id = self.state.get("id") or f"job_{int(time.time())}_{os.getpid()}"
        self.state.setdefault("id", self.id)
        self.state.setdefault("stage", "init")
        self.state.setdefault("progress", 0)
        self.state.setdefault("error", None)
        self.state.setdefault("retries", {})
        self.work.mkdir(parents=True, exist_ok=True)

    def _load(self) -> dict:
        if self.state_path.exists():
            try:
                return json.loads(self.state_path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                pass
        return {}

    def save(self) -> None:
        self.state_path.write_text(json.dumps(self.state, ensure_ascii=False, indent=2), encoding="utf-8")

    def set_stage(self, stage: str, progress: int | None = None, **fields) -> None:
        if progress is not None:
            self.state["progress"] = progress
        self.state["stage"] = stage
        self.state["updated_at"] = time.time()
        self.state.update(fields)
        self.save()
        log.info("stage", job=self.id, stage=stage, progress=self.state.get("progress"))

    def set_error(self, err: VFError) -> None:
        self.state["stage"] = "failed"
        self.state["error"] = err.to_dict()
        self.state["updated_at"] = time.time()
        self.save()
        log.error("job failed", job=self.id, code=err.code, stage=err.stage, retryable=err.retryable)

    def bump_retry(self, stage: str) -> int:
        n = int(self.state.get("retries", {}).get(stage, 0))
        self.state.setdefault("retries", {})[stage] = n + 1
        self.save()
        return n + 1


class Pipeline:
    def __init__(self, cfg: Config, work_dir: Path | str = "work"):
        self.cfg = cfg
        self.work_root = Path(work_dir)
        self.cache = Cache(self.work_root / "_cache", "assets")
        self.audio_cache = Cache(self.work_root / "_cache", "tts")

    # ----- helpers -----
    def _job_dir(self, job: Job) -> Path:
        return self.work_root / job.id

    def _asset_for_scene(self, job: Job, scene: dict) -> Path | None:
        """Fetch + smart-crop visual for scene, cached by (query, prompt-major)."""
        vis = scene.get("visual") or {}
        query = vis.get("query", "technology") or "technology"
        prompt = vis.get("prompt", "") or ""
        digest = sha256_hex(job.id, str(scene["id"]), query, prompt[:120])
        cached = self.cache.get(digest, "png")
        if cached:
            return cached
        visual = get_visual(self.cfg)
        tmp = self._job_dir(job) / "assets" / f"raw_{scene['id']}.jpg"
        tmp.parent.mkdir(parents=True, exist_ok=True)
        allow_web = bool(self.cfg.get("providers.allow_web", True)) and os.environ.get("TEST_MODE") != "1"
        try:
            visual.fetch(query, tmp, prompt=prompt, seed=int(job.id.split("_")[-1] or 0) + scene["id"])
        except VFError:
            raise
        from .renderer import normalize_asset

        out = self._job_dir(job) / "assets" / f"asset_{scene['id']}.png"
        normalize_asset(tmp, out, self.cfg.get("video.width", 720), self.cfg.get("video.height", 1280))
        self.cache.put_path(digest, "png", out)
        return out

    # ----- pipeline stages -----
    def run(self, topic: str, meta: dict | None = None) -> dict:
        job = Job(self._job_dir_prefix(), self.cfg)
        job.state.update({"topic": topic, "meta": meta or {}, "created_at": time.time()})
        job.set_stage("init", 0)
        return self._run_job(job)

    def _job_dir_prefix(self) -> Path:
        return self.work_root

    def _run_job(self, job: Job, from_stage: str | None = None) -> dict:
        meta = job.state.get("meta") or {}
        preset = meta.get("preset") or self.cfg.preset()
        duration_target = int(preset.get("duration_s", self.cfg.get("video.max_duration", 60)))

        if from_stage in (None, "script", "plan"):
            # 0-25: script + plan
            llm = get_llm(self.cfg)
            topic = job.state["topic"]
            digest = sha256_hex("script", topic, str(preset)[:400])
            script = self.cache.get_json(digest) or llm.generate_script(topic, preset)
            self.cache.put_json(digest, script)
            self._write_json(job, "script.json", script)
            job.set_stage("script", 15)
            scenes = self.plan_scenes(script, duration_target)
            self._write_json(job, "scenes.json", scenes)
            job.set_stage("plan", 20)

        if from_stage in (None, "tts"):
            # 25-40: TTS per scene -> words -> durations (master timeline)
            scenes = self._read_json(job, "scenes.json")
            tts = get_tts(self.cfg)
            voice = tts.voice_default()
            audio_dir = self._job_dir(job) / "audio"
            audio_dir.mkdir(parents=True, exist_ok=True)
            for sc in scenes:
                audio_path = audio_dir / f"scene_{sc['id']}.mp3"
                digest = sha256_hex("tts", voice, sc["narration"])
                cached = self.audio_cache.get(digest, "mp3")
                if cached:
                    shutil.copyfile(cached, audio_path)
                    seg = tts.synthesize(sc["narration"], audio_path, voice)  # to recompute timing
                    seg_prov = ("cache-" + seg.provider) if seg.provider else "cache"
                    seg.provider = seg_prov
                else:
                    seg = tts.synthesize(sc["narration"], audio_path, voice)
                    self.audio_cache.put(digest, "mp3", audio_path.read_bytes())
                sc["audio"] = audio_path.name
                sc["duration"] = round(seg.duration_s, 3)
                sc["words"] = seg.words
            job.set_stage("tts", 30)
            # Master timeline: absolute scene times from cumulative TTS durations
            from .renderer import build_scene_timeline

            scene_abs, sub_map = build_scene_timeline(scenes)
            self._write_json(job, "timeline.json", {"scenes": scene_abs, "subs": {str(k): v for k, v in sub_map.items()}})
            job.set_stage("plan", 35)

        if from_stage in (None, "assets"):
            # 40-60: visual acquisition (cached)
            timeline = self._read_json(job, "timeline.json")
            scenes = timeline["scenes"]
            assets: dict[str, str] = {}
            for sc in scenes:
                p = self._asset_for_scene(job, sc)
                if p:
                    assets[str(sc["id"])] = str(p)
            job.set_stage("assets", 50)

        if from_stage in (None, "render"):
            # 60-85: composition + audio mix + encode
            self._render(job)
            job.set_stage("render", 70)
        if from_stage in (None, "validate"):
            self._validate(job)
            job.set_stage("validate", 90)
        if from_stage in (None, "upload"):
            self._upload(job)
            job.set_stage("done", 100)
        return job.state

    # ----- plan -----
    def plan_scenes(self, script: dict, duration_target: int) -> list[dict]:
        """Script scenes -> semantic scenes with per-scene TTS targets."""
        total_narr = sum(len(s["narration"]) for s in script["scenes"])
        scenes = []
        for s in script["scenes"]:
            weight = len(s["narration"]) / max(1, total_narr)
            dur = max(4.0, min(20.0, duration_target * weight))
            scenes.append({
                "id": int(s["id"]),
                "narration": s["narration"],
                "visual": s["visual"],
                "overlay": s.get("overlay", ""),
                "motion": "kenburns",
                "start": 0.0,  # placeholder; set after TTS
                "end": dur,
            })
        return scenes

    # ----- render -----
    def _render(self, job: Job) -> None:
        timeline = self._read_json(job, "timeline.json")
        scenes = timeline["scenes"]
        cfg_video = self.cfg.video()
        width, height, fps = int(cfg_video.get("width", 720)), int(cfg_video.get("height", 1280)), int(cfg_video.get("fps", 30))

        from .renderer import Compositor

        comp = Compositor(width, height, fps)
        frames_dir = self._job_dir(job) / "frames"
        assets: dict[int, Any] = {}
        for sc in scenes:
            p = self._job_dir(job) / "assets" / f"asset_{sc['id']}.png"
            if p.exists():
                from PIL import Image

                assets[sc["id"]] = Image.open(p).convert("RGB")
        sub_map: dict[int, list[dict]] = {}
        for k, v in timeline.get("subs", {}).items():
            sub_map[int(k)] = [{**ln, "start": float(ln["start"]), "end": float(ln["end"])} for ln in v]
        seed = int(job.id.split("_")[-1] or 0)
        comp.build_frames(scenes, assets, sub_map, frames_dir, seed=seed)

        # Audio mix
        audio_dir = self._job_dir(job) / "audio"
        voice_parts = []
        cursor = 0.0
        for sc in scenes:
            p = audio_dir / sc.get("audio", f"scene_{sc['id']}.mp3")
            if p.exists():
                voice_parts.append((cursor, p))
            cursor += sc["end_s"] - sc["start_s"]
        mixed = self._job_dir(job) / "audio" / "mixed.wav"
        if voice_parts:
            # Concatenate voice segments into one track
            from .renderer import find_ffmpeg

            ffmpeg = find_ffmpeg()
            concat_txt = self._job_dir(job) / "audio" / "concat.txt"
            with open(concat_txt, "w", encoding="utf-8") as f:
                for _, p in voice_parts:
                    f.write(f"file '{p.resolve().as_posix()}'\n")
            proc = subprocess.run(
                [ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", str(concat_txt), "-c:a", "pcm_s16le", str(mixed)],
                capture_output=True, timeout=300,
            )
            if proc.returncode != 0 or not mixed.exists():
                from .errors import ffmpeg_unavailable

                raise ffmpeg_unavailable("render", f"voice concat failed: {proc.stderr.decode('utf-8', 'replace')[-500:]}")
        else:
            from .renderer import make_silence_wav

            make_silence_wav(mixed, 3.0)
        music = self.cfg.get("audio.music_path")
        from .renderer import mix_audio

        mix_audio(mixed, self._job_dir(job) / "audio" / "mix_final.wav", music_path=Path(music) if music and Path(music).exists() else None, music_volume=float(self.cfg.audio().get("music_volume", 0.12)))

        # Encode
        final = self._job_dir(job) / "final.mp4"
        from .renderer import encode_frames

        encode_frames(str(frames_dir / "frame_%05d.png"), final, fps=fps, width=width, height=height, audio=self._job_dir(job) / "audio" / "mix_final.wav", crf=int(cfg_video.get("crf", 23)))

        # Subtitles + thumbnail
        from .renderer import write_srt, write_ass_subs

        all_lines: list[dict] = []
        for sid in sorted(sub_map):
            all_lines.extend(sub_map[sid])
        write_srt(self._job_dir(job) / "final.srt", all_lines)
        write_ass_subs(self._job_dir(job) / "final.ass", all_lines)
        from PIL import Image

        first = frames_dir / "frame_00001.png"
        if first.exists():
            Image.open(first).convert("RGB").save(self._job_dir(job) / "thumbnail.png")

    def _validate(self, job: Job) -> None:
        final = self._job_dir(job) / "final.mp4"
        min_dur = float(self.cfg.get("validation.min_duration_s", 5))
        from .renderer import ffprobe_info, ffprobe_duration, has_black_frames

        dur = ffprobe_duration(final)
        if dur < min_dur:
            from .errors import validation_failed

            raise validation_failed("validate", f"duration {dur:.1f}s < {min_dur}s")
        info = ffprobe_info(final)
        streams = info.get("streams", [])
        v = next((s for s in streams if s.get("codec_type") == "video"), None)
        a = next((s for s in streams if s.get("codec_type") == "audio"), None)
        if not v or not a:
            from .errors import validation_failed

            raise validation_failed("validate", "missing video or audio stream")
        pix = v.get("pix_fmt", "")
        if pix and pix != "yuv420p":
            from .errors import validation_failed

            raise validation_failed("validate", f"pix_fmt {pix} != yuv420p")
        if has_black_frames(final):
            log.warn("validate: black frame segment detected", job=job.id)
        job.state["validation"] = {"duration_s": round(dur, 2), "video": v.get("codec_name"), "audio": a.get("codec_name"), "pix_fmt": pix}
        job.save()

    def _upload(self, job: Job) -> None:
        final = self._job_dir(job) / "final.mp4"
        if not final.exists():
            from .errors import upload_failed

            raise upload_failed("upload", "final.mp4 missing")
        storage = get_storage(self.cfg)
        ref = storage.save_file(f"{job.id}.mp4", final)
        job.state["output"] = {"url": ref.url, "provider": ref.provider, "key": ref.key}
        # Thumbnail as image if storage supports
        thumb = self._job_dir(job) / "thumbnail.png"
        if thumb.exists():
            try:
                tref = storage.save_file(f"{job.id}.png", thumb, "image/png")
                job.state["output"]["thumbnail"] = tref.url
            except Exception as e:
                log.warn("thumbnail upload failed", error=str(e)[:120])
        job.save()

    # ----- io helpers -----
    def _write_json(self, job: Job, name: str, obj: Any) -> None:
        p = self._job_dir(job) / name
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")

    def _read_json(self, job: Job, name: str) -> Any:
        p = self._job_dir(job) / name
        return json.loads(p.read_text(encoding="utf-8"))


def run_pipeline(topic: str, cfg: Config | None = None, work_dir: str = "work", meta: dict | None = None) -> dict:
    cfg = cfg or Config.load()
    return Pipeline(cfg, work_dir).run(topic, meta)


def resume_pipeline(job_id: str, cfg: Config | None = None, work_dir: str = "work", from_stage: str | None = None) -> dict:
    cfg = cfg or Config.load()
    pipe = Pipeline(cfg, work_dir)
    job = Job(Path(work_dir) / job_id, cfg)
    job.id = job_id
    job.state_path = Path(work_dir) / job_id / "job.json"
    job.state = json.loads(job.state_path.read_text(encoding="utf-8"))
    return pipe._run_job(job, from_stage)