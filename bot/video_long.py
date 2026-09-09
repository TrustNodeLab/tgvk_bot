# -*- coding: utf-8 -*-
"""VidRush-аналог (M20): длинные YouTube-ролики 16:9, 6-40 минут.

Пайплайн: ТЕМА -> СЦЕНАРИЙ (LLM/шаблон) -> SHOT LIST -> TTS (голос ведёт
таймлайн, M19) -> СТOKИ 16:9 -> RENDER 1920x1080 -> AUDIO MIX -> MP4 + EDL/SRT.

Форматы: doc (документалка), breakdown (разбор), top10 (топ).
Правки как в монтажке: рядом с MP4 кладётся EDL (JSON со всеми шотами:
старт/конец/реплика/субтитр/визуал) и SRT-субтитры. Поправил текст или
порядок в EDL -> `python bot/video_long.py --edl-in out/video.edl.json`
-> пересборка с новой озвучкой и монтажом.

Переиспользует движок video_cine (художники, камеры, переходы, звук,
голосовой таймлайн M19) — дублирует только оркестрацию длинного формата.
Шортсы (9:16) не тронуты.
"""

import argparse
import json
import math
import os
import random
import re
import subprocess
import sys
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import video_gen as vg  # noqa: E402 (ffmpeg/mux/tts-утилиты)
import video_cine as cine  # noqa: E402 (движок, M19-хелперы)

try:
    import llm  # noqa: E402 (сценарии)
except Exception:
    llm = None

FPS_LONG = 60              # 60 fps: плавный монтаж (эталон TikTok HEVC 60fps; --fps 120 опция)
CHARS_PER_SEC = 13.0  # русская речь Дмитрия, замер M19
CHUNK_MAX = 140
SUB_MAX = 70

FORMATS = ("doc", "breakdown", "top10")


# ---------- сценарий ----------

def _target_chars(minutes):
    return int(minutes * 60 * CHARS_PER_SEC)


def _blueprint(topic, minutes, format):
    """Скелет секций формата: [(роль, доля_хронометража)]."""
    if format == "top10":
        n = max(3, min(10, int(round(minutes))))
        shares = [0.06] + [0.84 / n] * n + [0.10]
        roles = (["hook"] + ["item"] * n + ["outro"])
        return list(zip(roles, shares))
    if format == "breakdown":
        n = max(2, min(6, int(round(minutes / 1.2))))
        shares = [0.05, 0.10] + [(0.75 / n)] * n + [0.10]
        roles = ["hook", "thesis"] + ["argument"] * n + ["verdict"]
        return list(zip(roles, shares))
    # doc
    n = max(2, min(12, int(round(minutes))))
    shares = [0.08] + [(0.80 / n)] * n + [0.12]
    roles = ["hook"] + ["chapter"] * n + ["finale"]
    return list(zip(roles, shares))


def _fallback_script(topic, minutes, format):
    """Шаблон без LLM (честная заглушка: структура формата, текст generic)."""
    total = _target_chars(minutes)
    out = []
    for i, (role, share) in enumerate(_blueprint(topic, minutes, format)):
        budget = max(200, int(total * share))
        if role == "hook":
            head = f"{topic}: с чего всё началось"
            body = (f"Сегодня разберём тему «{topic}» по косточкам. "
                    f"Это {format}-разбор: факты, контекст и выводы. "
                    f"Досмотрите до конца — главное в финале. " * 12)
        elif role in ("outro", "finale", "verdict"):
            head = f"{topic}: итог"
            body = (f"Подводим итог по теме «{topic}». Главное, что стоит "
                    f"запомнить: контекст решает, детали важны, выводы за вами. "
                    f"Подписывайтесь, дальше — больше. " * 12)
        elif role == "thesis":
            head = f"{topic}: главный тезис"
            body = (f"Главный тезис выпуска про «{topic}»: всё не так однозначно, "
                    f"как кажется на первый взгляд. Разберём по пунктам. " * 12)
        elif role in ("item", "argument", "chapter"):
            head = f"{topic}: часть {i}"
            body = (f"Разбираем «{topic}», пункт {i}. Факты, примеры из практики "
                    f"и что это значит на деле. Запоминайте детали — они "
                    f"пригодятся в финале. " * 12)
        else:
            head, body = f"{topic}", f"Про «{topic}». " * 20
        out.append({"heading": head[:80], "body": body[:budget + 400],
                    "query": f"{topic}", "role": role, "method": "template"})
    return out


def write_script(topic, minutes, format, provider=None):
    """Сценарий секциями [{heading, body, query, role}] через LLM + fallback."""
    total = _target_chars(minutes)
    plan = _blueprint(topic, minutes, format)
    spec = "\n".join(
        f"- {role}: ~{int(total * share)} символов текста для диктора"
        for role, share in plan)
    prompt = (
        f"Ты — сценарист YouTube-канала о кибербезопасности и технологиях. "
        f"Напиши сценарий ролика в формате {format} на тему «{topic}». "
        f"Всего ~{total} символов дикторского текста. Структура:\n{spec}\n"
        f"Правила: body — живой дикторский текст (факты по теме, без воды, "
        f"без приветствий дольше 1 фразы); heading — короткое название части "
        f"(до 6 слов); query — 2-4 слова на АНГЛИЙСКОМ для поиска сток-видео "
        f"под эту часть. Верни ТОЛЬКО валидный JSON без пояснений и markdown: "
        f'{{"sections": [{{"heading": "...", "body": "...", "query": "..."}}]}}')
    if llm is not None:
        try:
            raw = llm._complete([{"role": "user", "content": prompt}],
                                provider)
            m = re.search(r"\{.*\}", raw, re.S)
            data = json.loads(m.group(0) if m else raw)
            secs = []
            for i, (role, _share) in enumerate(plan):
                s = (data.get("sections") or [])[i:i + 1]
                s = s[0] if s else {}
                secs.append({
                    "heading": str(s.get("heading") or f"{topic}: часть {i}")[:80],
                    "body": str(s.get("body") or "")[:6000],
                    "query": str(s.get("query") or topic)[:60],
                    "role": role, "method": "llm"})
            if any(s["body"] for s in secs):
                print(f"[long] сценарий LLM: {len(secs)} секций "
                      f"({sum(len(s['body']) for s in secs)} симв)")
                return secs
        except Exception as e:
            print(f"[long] LLM сценарий не удался ({type(e).__name__}) — шаблон")
    return _fallback_script(topic, minutes, format)


# ---------- секции -> чанки -> шоты ----------

def _sentences(body):
    return [p.strip() for p in
            re.split(r"(?<=[.!?…;:])\s+", (body or "").strip()) if p.strip()]


def _hard_split(sent, limit=CHUNK_MAX):
    if len(sent) <= limit:
        return [sent]
    out, cur = [], ""
    for w in sent.split():
        t = (cur + " " + w).strip()
        if len(t) <= limit:
            cur = t
        else:
            if cur:
                out.append(cur)
            cur = w
    if cur:
        out.append(cur)
    return out or [sent[:limit]]


def _smart_sub(chunk, limit=SUB_MAX):
    if len(chunk) <= limit:
        return chunk
    cut = chunk[:limit].rsplit(" ", 1)
    return cut[0] if len(cut) == 2 and len(cut[0]) >= limit // 2 else chunk[:limit]


_ROLE_ACT = {"hook": "hook", "thesis": "problem", "chapter": "problem",
             "argument": "escalation", "item": "escalation",
             "verdict": "peak", "finale": "climax", "outro": "climax"}

_VISUALS = ["phone_message", "login_screen", "keyboard", "qr_scan",
            "token_panel", "server_corridor", "cables", "person",
            "phone_call", "face_glow", "eye", "server_rack",
            "switch_macro", "consequence", "bokeh", "message"]
_PEAK_POOL = ["attack_grid", "face_glow", "server_corridor", "eye",
              "consequence"]
_CAMERAS = ["push_in", "drift", "push_out", "tilt", "whip_pan", "snap"]
_TRANS = ["hard_cut", "whip", "zoom", "match", "hard_cut", "dip"]


def _mkshot(sid, act, dur, visual, camera, texts, trans_out, sfx="none",
            speed=(1.0, 1.0), accent="accent", fx="", typ=None,
            voice="", sub="", sec=0):
    if typ is None:
        typ = "cinematic"
    subs = ([{"lines": [sub[:SUB_MAX]], "mode": "sub"}]
            if (sub and typ == "cinematic") else [])
    return {"id": sid, "sec": sec, "act": act, "dur": dur, "visual": visual,
            "camera": camera, "texts": texts, "subs": subs,
            "sub": sub[:SUB_MAX], "voice": voice[:CHUNK_MAX],
            "trans_out": trans_out, "sfx": sfx, "speed": speed,
            "accent": accent, "fx": fx, "type": typ}


def _tx(*lines, mode="pop"):
    return [{"lines": [str(l).upper().strip()[:24] for l in lines],
             "mode": mode}]


def build_long_shots(sections, topic, seed=7, target_sec=None):
    """Секции -> shot list без лимита длины (longform).

    target_sec: поджать середину под целевой хронометраж (оценка 14 симв/с
    + 0.6с на чанк) — жертвуем средними чанками, hook/финал не трогаем.
    """
    rnd = random.Random(seed + abs(hash(topic)) % 10 ** 6)
    peak_pool = list(_PEAK_POOL)
    rnd.shuffle(peak_pool)
    off = abs(hash(topic)) % 997
    shots, vi = [], off % len(_VISUALS)
    for si, sec in enumerate(sections):
        role = sec.get("role", "chapter")
        chunks = []
        for sent in _sentences(sec.get("body", "")):
            chunks.extend(_hard_split(sent))
        if not chunks:
            continue
        for k, chunk in enumerate(chunks):
            act = _ROLE_ACT.get(role, "problem")
            if k == len(chunks) - 1 and role in ("verdict", "finale"):
                act = "peak"
            if act == "peak":
                vis, accent = peak_pool[(k + off) % len(peak_pool)], "accent2"
            else:
                vis, accent = _VISUALS[vi % len(_VISUALS)], "accent"
                vi += 1
            sfx = ("impact" if act == "peak"
                   else ("bass" if act == "hook" else "none"))
            dur = max(1.0, len(chunk) / 12.0 + 0.6)
            shots.append(_mkshot(
                f"L{si:02d}_{k:02d}", act, dur, vis,
                _CAMERAS[(len(shots) + off) % len(_CAMERAS)], [],
                _TRANS[(len(shots) * 3 + off) % len(_TRANS)], sfx,
                (1.2, 1.2), accent, "", None, chunk, _smart_sub(chunk),
                sec=si))
            for fld in ("seed",):
                shots[-1][fld] = rnd.randint(1, 10 ** 6)
        # глава-докард между секциями (документальный ритм)
        head = (sec.get("heading") or "").upper().strip().split()
        if head and si < len(sections) - 1:
            words = [w.strip("«»\"'.,!?—–-") for w in head if w][:3]
            lines = []
            cur = ""
            for w in words:
                t = (cur + " " + w).strip()
                if len(t) <= 24:
                    cur = t
                else:
                    break
            if cur:
                lines.append(cur)
            if lines:
                shots.append(_mkshot(
                    f"L{si:02d}_t", "accel", 1.6,
                    "flash" if si % 2 else "question", "snap",
                    _tx(*lines[:2]), "hard_cut", "click", (1.4, 1.4),
                    "accent", "", "typography", sec=si))
                shots[-1]["seed"] = rnd.randint(1, 10 ** 6)
        # пауза посередине ролика
        if si + 1 == max(1, len(sections) // 2) and len(sections) > 1:
            shots.append(_mkshot(
                f"L{si:02d}_p", "twist", 1.8, "pause_black", "static",
                [], "dip", "silence", (0.4, 0.4), "accent", "",
                "cinematic", sec=si))
            shots[-1]["seed"] = rnd.randint(1, 10 ** 6)
    if target_sec:
        def _est():
            return sum(len(s["voice"]) / 14.0 + 0.6 for s in shots
                       if s["voice"])
        for _ in range(512):
            if _est() <= target_sec or len(shots) <= 6:
                break
            mid = [s for s in shots
                   if s["voice"] and not s["id"].startswith("L00")
                   and not s["id"].startswith("L_fin")]
            if not mid:
                break
            victim = max(mid, key=lambda s: len(s["voice"]))
            shots.remove(victim)
    # финал: шёпот + бренд
    last_head = (sections[-1].get("heading") if sections else topic) or topic
    shots.append(_mkshot("L_fin_q", "climax", 2.4, "final_q", "static",
                         _tx(last_head, mode="whisper"), "dip", "bass",
                         (0.6, 0.8), "accent", "", "typography"))
    shots[-1]["seed"] = rnd.randint(1, 10 ** 6)
    shots.append(_mkshot("L_fin_b", "climax", 3.6, "final_brand", "push_out",
                         [], "hard_cut", "impact", (0.7, 1.0), "accent",
                         "", "graphic"))
    shots[-1]["seed"] = rnd.randint(1, 10 ** 6)
    print(f"[long] shot list: {len(shots)} шотов, "
          f"голоса ~{sum(len(s['voice']) / 12.0 for s in shots if s['voice']):.0f}с")
    return shots


# ---------- стоки 16:9 по секциям ----------

def fetch_section_stock(ffmpeg, tmpdir, sections, max_sec=12):
    """По 1 landscape-клипу на секцию -> общие кадры. Возвращает [png...]."""
    frames_all = []
    for si, sec in enumerate(sections[:max_sec]):
        q = (sec.get("query") or "").strip()
        if not q:
            continue
        sdir = os.path.join(tmpdir, f"stock_s{si}")
        try:
            clips, _ = cine.fetch_stock_clips(sdir, [q], max_clips=1,
                                              orientation="landscape")
            if not clips:
                continue
            fr = cine.extract_stock_frames(
                ffmpeg, clips, os.path.join(sdir, "frames"))
            if fr:
                # M25: extract_stock_frames вернул [ [кадры..], ... ] — плоско
                flat = [x for grp in fr for x in grp]
                frames_all.extend(flat)
                print(f"[long] секция {si}: сток «{q}» ({len(flat)} кадров)")
        except Exception as e:
            print(f"[long] секция {si}: сток недоступен ({type(e).__name__})")
            continue
    return frames_all


def assign_section_stock(shots, frames):
    """Живые фоны — текстовым-less cinematic шотам, по кругу секций."""
    if not frames:
        return 0
    ci, n = 0, 0
    for s in shots:
        if cine.shot_kind(s) == "cinematic" and not s.get("texts"):
            # каждый 2-й такой шот — живой фон (микс, не сплошняк)
            if n % 2 == 0:
                s["stock"] = ci % len(frames)
                ci += 1
            n += 1
    print(f"[long] живые фоны назначены {ci} шотам")
    return ci


# ---------- EDL / SRT (монтажный лист) ----------

def dump_edl(path, topic, format, minutes, fps, shots, bounds):
    edl_shots = []
    for i, s in enumerate(shots):
        e = dict(s)
        e["start"] = round(bounds[i] if i < len(bounds) else 0.0, 3)
        e["end"] = round(bounds[i + 1] if i + 1 < len(bounds) else 0.0, 3)
        e.pop("stock", None)
        edl_shots.append(e)
    edl = {"app": "tgvk-longform", "version": 1, "topic": topic,
           "format": format, "minutes": minutes, "fps": fps,
           "aspect": "16:9", "shots": edl_shots}
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(edl, fh, ensure_ascii=False, indent=1)
    return path


def _srt_ts(sec):
    ms = int(sec * 1000)
    return (f"{ms // 3600000:02d}:{(ms // 60000) % 60:02d}:"
            f"{(ms // 1000) % 60:02d},{ms % 1000:03d}")


def dump_srt(path, shots, bounds):
    out = []
    n = 0
    for i, s in enumerate(shots):
        text = (s.get("sub") or s.get("voice") or "").strip()
        if not text:
            continue
        st = bounds[i] if i < len(bounds) else 0.0
        en = bounds[i + 1] if i + 1 < len(bounds) else st + 1.0
        n += 1
        out.append(f"{n}\n{_srt_ts(st)} --> {_srt_ts(en)}\n{text}\n")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(out))
    return path, n


def load_edl(path):
    with open(path, encoding="utf-8") as fh:
        edl = json.load(fh)
    shots = []
    for e in edl.get("shots", []):
        s = dict(e)
        s.pop("start", None)
        s.pop("end", None)
        shots.append(s)
    meta = {k: edl.get(k) for k in ("topic", "format", "minutes", "fps")}
    return shots, meta


# ---------- генерация ----------

def generate_long(topic=None, minutes=6, format="doc", out="out/video_long.mp4",
                  fps=FPS_LONG, tmpdir="out/tmp_long", voice=vg.VOICE_DEFAULT,
                  no_audio=False, voice_over=True, edl_out=None,
                  edl_in=None, script_text=None, provider=None, seed=7):
    """Тема -> длинный ролик 16:9 + EDL/SRT."""
    import shutil as _sh
    minutes = max(1, min(40, int(minutes)))
    if format not in FORMATS:
        format = "doc"
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    os.makedirs(tmpdir, exist_ok=True)
    cine.set_aspect("16:9")
    try:
        return _generate_long_inner(
            topic, minutes, format, out, fps, tmpdir, voice, no_audio,
            voice_over, edl_out, edl_in, script_text, provider, seed)
    finally:
        cine.set_aspect("9:16")


def _generate_long_inner(topic, minutes, format, out, fps, tmpdir, voice,
                         no_audio, voice_over, edl_out, edl_in,
                         script_text, provider, seed):
    import shutil as _sh
    topic = (topic or "Как вас взламывают через фишинг").strip()
    st, key = cine.get_style("cybersecurity_cinematic")
    P = st["palette"]
    bpm = st.get("bpm", 100)
    ffmpeg = vg.find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("нет ffmpeg: pip install imageio-ffmpeg")
    if edl_in:
        shots, meta = load_edl(edl_in)
        topic = meta.get("topic") or topic
        print(f"[long] EDL {edl_in}: {len(shots)} шотов на пересборку")
        sections = []
    elif script_text and str(script_text).strip():
        parsed = vg.parse_script(str(script_text))
        sections = [{"heading": p.get("heading", f"Часть {i + 1}"),
                     "body": p.get("body", ""),
                     "query": topic, "role": "chapter",
                     "method": "article"}
                    for i, p in enumerate(parsed)]
        print(f"[long] статья: {len(sections)} секций")
    else:
        sections = write_script(topic, minutes, format, provider)
    if not edl_in:
        shots = build_long_shots(sections, topic, seed,
                                 target_sec=minutes * 60)
    shots = cine.enforce_balance(shots)
    total_est = sum(float(s["dur"]) for s in shots)
    print(f"[long] план: {len(shots)} шотов, ~{total_est:.0f}с, "
          f"кадров ~{int(total_est * fps)}")
    if total_est * fps > 30000:
        print("[long] ВНИМАНИЕ: очень длинный рендер, "
              "для черновика добавь --fps 12")

    # --- M19: голос ведёт таймлайн (статья/длинный формат: все реплики)
    vmp3, voice_spans = None, []
    if voice_over and not no_audio:
        vmap = [(i, s) for i, s in enumerate(shots)
                if (s.get("voice") or "").strip()]
        if vmap:
            tsecs = []
            for _, s in vmap:
                rate, pitch, vol = cine._prosody(s.get("act"))
                tsecs.append({"voice": s["voice"], "caption": s["id"],
                              "rate": rate, "pitch": pitch, "volume": vol})
            _w = None
            try:
                vmp3, _w = vg.make_voiceover_sections(ffmpeg, tsecs, voice,
                                                      tmpdir)
            except Exception as e:
                print(f"[long] TTS не удался ({type(e).__name__}) "
                      f"— оценка по символам")
                vmp3, _w = None, None
            if _w and len(_w) == len(vmap):
                sec_durs = [float(w) - (0.5 if j < len(vmap) - 1 else 0.0)
                            for j, w in enumerate(_w)]
            else:
                sec_durs = [max(1.5, len(s["voice"]) / 14.0)
                            for _, s in vmap]
                vmp3 = None
            voice_spans = cine._layout_voice_spans(shots, vmap, sec_durs)
            voiced_ids = {id(s) for sp in voice_spans for s in sp["refs"]}
            cine._fit_fillers(shots, voiced_ids, total_est, True)
            total_est = sum(float(s["dur"]) for s in shots)
    for s in shots:
        if (s.get("texts") or s.get("subs")) and s["dur"] < cine._min_dur(s):
            s["dur"] = float(cine._min_dur(s))
    seconds = total_est

    # --- стоки 16:9 по секциям (микс с графикой; без ключей — painters)
    stock = None
    try:
        frames = (fetch_section_stock(ffmpeg, tmpdir, sections)
                  if sections else [])
        if frames:
            stock = {"frames": frames, "cache": {}}
            assign_section_stock(shots, frames)
    except Exception as e:
        print(f"[long] сток недоступен ({type(e).__name__}) — только painters")
        stock = None

    pause_win = None
    acc = 0.0
    for s in shots:
        if s["act"] == "twist" and pause_win is None:
            pause_win = (acc, acc + s["dur"])
        acc += s["dur"]
    silent = os.path.join(tmpdir, "silent.mp4")
    _, bounds = cine.render_cinematic(shots, seconds, fps, silent, bpm, P,
                                      tmpdir, stock)
    real_dur = bounds[-1]
    if vmp3 and voice_spans and cine.np is not None and not no_audio:
        try:
            idx_of = {id(s): i for i, s in enumerate(shots)}
            items = []
            for sp in voice_spans:
                i0 = idx_of.get(id(sp["refs"][0]))
                if i0 is None or i0 >= len(bounds):
                    continue
                items.append((os.path.join(tmpdir, f"sec_{sp['sec']}.mp3"),
                              float(bounds[i0])))
            total_v = sum(float(s["dur"]) for s in shots)
            vmix = cine._assemble_voice(ffmpeg, tmpdir, items, total_v,
                                        cine.SR)
            if vmix:
                vmp3 = vmix
                print(f"[long] голос собран на таймлайн: {len(items)} чанков")
        except Exception as e:
            print(f"[long] сборка голоса не удалась ({type(e).__name__}) "
                  f"— монолит с начала")
    if no_audio or cine.np is None:
        _sh.copy(silent, out)
    else:
        duck = None
        vw = None
        vv = None
        if vmp3:
            vw = os.path.join(tmpdir, "voice.wav")
            r = subprocess.run(
                [ffmpeg, "-y", "-i", vmp3, "-ar", str(cine.SR), "-ac", "1",
                 vw], capture_output=True)
            if r.returncode == 0:
                with wave.open(vw, "rb") as wf:
                    raw = wf.readframes(wf.getnframes())
                vv = (cine.np.frombuffer(raw, dtype=cine.np.int16)
                      .astype(cine.np.float64) * 1.1)
                n = int(real_dur * cine.SR)
                a = cine.np.abs(vv[:n])
                wsize = max(1, int(cine.SR * 0.2))
                cs = cine.np.cumsum(cine.np.insert(a, 0, 0.0))
                env = (cs[wsize:] - cs[:-wsize]) / wsize
                env = cine.np.concatenate(
                    [env, cine.np.full(max(0, n - len(env)), 0.0)])[:n]
                mx = env.max()
                duck = (env / mx) if mx > 0 else cine.np.zeros(n)
        mix = cine.build_soundtrack(shots, bounds, real_dur, bpm, pause_win,
                                    bed=float(st.get("bed_level", 1.0)),
                                    sfx_gain=float(st.get("sfx_level", 1.0)),
                                    duck=duck)
        bed_wav = os.path.join(tmpdir, "bed.wav")
        cine.write_wav(bed_wav, mix)
        if vw is not None and vv is not None:
            m = min(len(vv), len(mix))
            mix2 = mix.astype(cine.np.float64)
            mix2[:m] += vv[:m]
            mix2 = cine.np.clip(mix2, -32768, 32767).astype(cine.np.int16)
            cine.write_wav(bed_wav, mix2)
        vg.mux_audio(ffmpeg, silent, bed_wav, out, real_dur)
    # --- EDL + SRT рядом с роликом
    base, _ = os.path.splitext(out)
    epath = edl_out or (base + ".edl.json")
    spath = base + ".srt"
    dump_edl(epath, topic, format, minutes, fps, shots, bounds)
    _, nsubs = dump_srt(spath, shots, bounds)
    size = os.path.getsize(out)
    print(f"[long] ГОТОВО: {out} ({size / 1048576:.1f} MB, {real_dur:.1f} c, "
          f"{format}, 16:9) + EDL ({len(shots)} шотов) + SRT ({nsubs} реплик)")
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="Длинные YouTube-ролики 16:9")
    ap.add_argument("--topic", default="")
    ap.add_argument("--minutes", type=int, default=6)
    ap.add_argument("--format", default="doc",
                    choices=list(FORMATS) + ["top", "razbor"],
                    help="doc / breakdown / top10 (top/razbor — алиасы)")
    ap.add_argument("--fps", type=int, default=FPS_LONG)
    ap.add_argument("--out", default="out/video_long.mp4")
    ap.add_argument("--tmpdir", default="out/tmp_long")
    ap.add_argument("--voice", default=vg.VOICE_DEFAULT)
    ap.add_argument("--no-audio", action="store_true")
    ap.add_argument("--edl-out", default="")
    ap.add_argument("--edl-in", default="")
    ap.add_argument("--script-file", default="")
    ap.add_argument("--from-post", default="",
                    help="файл с исходным текстом поста: LLM (GigaChat по "
                         "умолчанию) перепишет его в длинный сценарий; при "
                         "сбое используется исходный текст как есть")
    ap.add_argument("--provider", default=None)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args(argv)
    fmt = {"top": "top10", "razbor": "breakdown"}.get(a.format, a.format)
    script_text = ""
    if a.script_file:
        with open(a.script_file, encoding="utf-8") as fh:
            script_text = fh.read()
    if a.from_post:
        # S27: пост -> LLM рерайт в длинный сценарий (GigaChat по умолчанию).
        with open(a.from_post, encoding="utf-8") as fh:
            post_text = fh.read()
        import llm
        rewritten = llm.rewrite_post_to_script(post_text, "long",
                                               a.provider)
        if rewritten:
            print("[long] длинный сценарий сгенерирован LLM из поста "
                  f"({len(rewritten)} симв.)")
            script_text = rewritten
        else:
            print("[long] LLM-рерайт недоступен — исходный пост как сценарий")
            script_text = post_text
    generate_long(topic=a.topic, minutes=a.minutes, format=fmt, out=a.out,
                  fps=a.fps, tmpdir=a.tmpdir, voice=a.voice,
                  no_audio=a.no_audio, edl_out=a.edl_out or None,
                  edl_in=a.edl_in or None, script_text=script_text,
                  provider=a.provider, seed=a.seed)


if __name__ == "__main__":
    main()
