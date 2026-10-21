import hashlib
import json
import os
import shutil
import subprocess
import threading
from pathlib import Path

from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

DATA_DIR = Path(os.environ.get("BACKTRACK_DATA_DIR", "./data"))
UPLOAD_DIR = DATA_DIR / "uploads"
STEMS_DIR = DATA_DIR / "stems"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
STEMS_DIR.mkdir(parents=True, exist_ok=True)

STEMS = ("vocals", "drums", "bass", "other")
MODEL = "htdemucs"

app = FastAPI(title="back_track")

# job_id -> {"status": "pending|running|done|error", "error": str|None, "name": str}
jobs: dict[str, dict] = {}
jobs_lock = threading.Lock()

# (job_id, semitones) -> {"status": "pending|running|done|error", "error": str|None}
transpose_jobs: dict[tuple, dict] = {}
transpose_lock = threading.Lock()


def _hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def _stems_ready(job_id: str) -> bool:
    out = STEMS_DIR / job_id
    return all((out / f"{s}.wav").exists() for s in STEMS)


NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
# Krumhansl-Schmuckler key profiles.
KS_MAJOR = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
KS_MINOR = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)


def _chord_templates():
    import numpy as np
    MAJ = np.array([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0], dtype=float)
    MIN = np.array([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0], dtype=float)
    templates, names = [], []
    for i in range(12):
        templates.append(np.roll(MAJ, i)); names.append(NOTE_NAMES[i])
    for i in range(12):
        templates.append(np.roll(MIN, i)); names.append(NOTE_NAMES[i] + "m")
    return np.array(templates), names


def _estimate_key(chroma):
    import numpy as np
    mean = chroma.mean(axis=1)
    best, best_score = None, -1e9
    for i in range(12):
        maj_corr = np.corrcoef(np.roll(KS_MAJOR, i), mean)[0, 1]
        min_corr = np.corrcoef(np.roll(KS_MINOR, i), mean)[0, 1]
        if maj_corr > best_score:
            best_score = maj_corr; best = f"{NOTE_NAMES[i]} major"
        if min_corr > best_score:
            best_score = min_corr; best = f"{NOTE_NAMES[i]} minor"
    return best


# ---- BTC transformer chord recognition (primary) ----

_btc_model = None

# Harte quality → guitar-friendly suffix.
HARTE_SUFFIX = {
    "maj": "", "": "", "min": "m", "dim": "dim", "aug": "aug",
    "maj7": "maj7", "min7": "m7", "7": "7", "dim7": "dim7",
    "hdim7": "m7b5", "minmaj7": "mM7",
    "maj6": "6", "6": "6", "min6": "m6",
    "9": "9", "maj9": "maj9", "min9": "m9",
    "sus2": "sus2", "sus4": "sus4", "11": "11", "13": "13",
}
FLAT_TO_SHARP = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#",
                 "Bb": "A#", "Cb": "B", "Fb": "E"}


def _harte_to_display(chord: str) -> str:
    if not chord or chord == "N":
        return "N.C."
    root, _, qual = chord.partition(":")
    qual = qual.split("/")[0]            # drop inversion (e.g. maj/3)
    root = FLAT_TO_SHARP.get(root, root)
    suffix = HARTE_SUFFIX.get(qual, qual)
    return root + suffix


def _get_btc():
    global _btc_model
    if _btc_model is None:
        from transformers import AutoModel
        _btc_model = AutoModel.from_pretrained(
            "puar-playground/btc-chord", trust_remote_code=True)
    return _btc_model


def _detect_chords_btc(audio_path: Path):
    model = _get_btc()
    raw = model.predict(str(audio_path))   # [{start, end, chord}] in Harte notation
    out = []
    for seg in raw:
        out.append({
            "start": round(float(seg["start"]), 3),
            "end": round(float(seg["end"]), 3),
            "name": _harte_to_display(seg["chord"]),
        })
    return _merge_short(out, 0.3)


def _detect_chords(y_harm, sr, min_dur=0.45):
    """Frame-level chord detection with Viterbi smoothing → true-time segments."""
    import numpy as np
    import librosa

    hop = 2048
    # Use the harmonic component so percussion doesn't smear the chroma.
    y_h = librosa.effects.harmonic(y_harm, margin=4)
    chroma = librosa.feature.chroma_cqt(y=y_h, sr=sr, hop_length=hop)
    frame_times = librosa.frames_to_time(
        np.arange(chroma.shape[1] + 1), sr=sr, hop_length=hop)

    templates, names = _chord_templates()
    frames = chroma / (np.linalg.norm(chroma, axis=0, keepdims=True) + 1e-9)
    templates_n = templates / (np.linalg.norm(templates, axis=1, keepdims=True) + 1e-9)
    sim = templates_n @ frames                      # (n_chords, n_frames), cosine-ish
    emission = np.clip(sim, 1e-6, None)
    emission = emission / emission.sum(axis=0, keepdims=True)

    n = len(names)
    p_self = 0.92                                    # bias toward holding a chord
    trans = np.full((n, n), (1.0 - p_self) / (n - 1))
    np.fill_diagonal(trans, p_self)
    path = librosa.sequence.viterbi(emission, trans)

    segs = []
    cur, start_i = int(path[0]), 0
    for i in range(1, len(path)):
        if int(path[i]) != cur:
            segs.append({"start": float(frame_times[start_i]),
                         "end": float(frame_times[i]), "name": names[cur]})
            cur, start_i = int(path[i]), i
    segs.append({"start": float(frame_times[start_i]),
                 "end": float(frame_times[len(path)]), "name": names[cur]})
    return _merge_short(segs, min_dur)


def _merge_short(segs, min_dur):
    """Fold sub-min_dur flickers into their neighbour, and merge same-name runs."""
    out = []
    for s in segs:
        if out and (out[-1]["name"] == s["name"]):
            out[-1]["end"] = s["end"]
        elif out and (s["end"] - s["start"]) < min_dur:
            out[-1]["end"] = s["end"]            # absorb the flicker
        else:
            out.append(dict(s))
    for s in out:
        s["start"] = round(s["start"], 3)
        s["end"] = round(s["end"], 3)
    return out


def _analyze_audio(stems_dir: Path, source: Path | None = None) -> dict:
    """Estimate tempo, beats, key, and chord labels. Chords come from the BTC
    transformer on the original mix; tempo/key stay on the separated stems."""
    try:
        import librosa
        import numpy as np

        sr = 22050
        y_drums, _ = librosa.load(str(stems_dir / "drums.wav"), mono=True, sr=sr)
        y_other, _ = librosa.load(str(stems_dir / "other.wav"), mono=True, sr=sr)
        y_bass, _ = librosa.load(str(stems_dir / "bass.wav"), mono=True, sr=sr)
        y_harm = y_other + 0.7 * y_bass  # harmonic mix for key analysis

        tempo, beats = librosa.beat.beat_track(y=y_drums, sr=sr)
        beat_times = librosa.frames_to_time(beats, sr=sr).tolist()
        bpm_val = float(tempo) if not hasattr(tempo, "__len__") else float(tempo[0])
        offset = float(beat_times[0]) if beat_times else 0.0

        chroma = librosa.feature.chroma_cqt(y=y_harm, sr=sr)
        key = _estimate_key(chroma)
        duration = float(len(y_harm)) / sr

        # Chords: BTC transformer on the full mix; template method as fallback.
        chord_engine = "btc"
        try:
            chords = _detect_chords_btc(source if source else stems_dir / "other.wav")
        except Exception as e:
            chord_engine = f"template (btc failed: {e})"
            chords = _detect_chords(y_harm, sr)
            if chords:
                chords[0]["start"] = 0.0
                chords[-1]["end"] = round(duration, 3)

        return {
            "bpm": round(bpm_val, 2),
            "offset": round(offset, 4),
            "duration": round(duration, 3),
            "beats": [round(t, 4) for t in beat_times],
            "key": key,
            "chords": chords,
            "chord_engine": chord_engine,
        }
    except Exception as e:
        return {"bpm": None, "offset": 0.0, "beats": [], "key": None, "chords": [], "error": str(e)}


def _run_demucs(job_id: str, src: Path) -> None:
    with jobs_lock:
        jobs[job_id]["status"] = "running"
    try:
        work = STEMS_DIR / job_id
        work.mkdir(parents=True, exist_ok=True)
        # With --filename "{stem}.{ext}", demucs writes to <out>/<model>/<stem>.wav
        cmd = [
            "python", "-m", "demucs.separate",
            "-n", MODEL,
            "-o", str(work),
            "--filename", "{stem}.{ext}",
            str(src),
        ]
        subprocess.run(cmd, check=True, capture_output=True, text=True)
        model_dir = work / MODEL
        stem_files = list(model_dir.glob("*.wav")) if model_dir.exists() else []
        if not stem_files:
            raise RuntimeError("demucs produced no output")
        for stem_file in stem_files:
            shutil.move(str(stem_file), str(work / stem_file.name))
        shutil.rmtree(model_dir, ignore_errors=True)
        meta = _analyze_audio(work, src)
        (work / "meta.json").write_text(json.dumps(meta))
        with jobs_lock:
            jobs[job_id]["status"] = "done"
    except subprocess.CalledProcessError as e:
        with jobs_lock:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["error"] = e.stderr or str(e)
    except Exception as e:
        with jobs_lock:
            jobs[job_id]["status"] = "error"
            jobs[job_id]["error"] = str(e)


@app.post("/api/separate")
async def separate(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(400, "no filename")
    suffix = Path(file.filename).suffix.lower() or ".mp3"
    tmp = UPLOAD_DIR / f"_incoming{suffix}"
    with tmp.open("wb") as f:
        while chunk := await file.read(1 << 20):
            f.write(chunk)

    job_id = _hash_file(tmp)
    final = UPLOAD_DIR / f"{job_id}{suffix}"
    if not final.exists():
        shutil.move(str(tmp), str(final))
    else:
        tmp.unlink(missing_ok=True)

    with jobs_lock:
        existing = jobs.get(job_id)
    if _stems_ready(job_id):
        with jobs_lock:
            jobs[job_id] = {"status": "done", "error": None, "name": file.filename}
        return {"job_id": job_id, "status": "done", "cached": True}

    if existing and existing["status"] in ("pending", "running"):
        return {"job_id": job_id, "status": existing["status"], "cached": False}

    with jobs_lock:
        jobs[job_id] = {"status": "pending", "error": None, "name": file.filename}
    threading.Thread(target=_run_demucs, args=(job_id, final), daemon=True).start()
    return {"job_id": job_id, "status": "pending", "cached": False}


@app.get("/api/status/{job_id}")
def status(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
    if not job and _stems_ready(job_id):
        return {"status": "done", "error": None}
    if not job:
        raise HTTPException(404, "unknown job")
    return {"status": job["status"], "error": job.get("error")}


@app.get("/api/stems/{job_id}/{stem}")
def stem(job_id: str, stem: str, semitones: int = 0):
    if stem not in STEMS:
        raise HTTPException(404, "unknown stem")
    if semitones:
        path = _transposed_dir(job_id, semitones) / f"{stem}.wav"
    else:
        path = STEMS_DIR / job_id / f"{stem}.wav"
    if not path.exists():
        raise HTTPException(404, "stem not ready")
    return FileResponse(path, media_type="audio/wav")


def _transposed_dir(job_id: str, semitones: int) -> Path:
    return STEMS_DIR / job_id / "shifted" / str(semitones)


def _transposed_ready(job_id: str, semitones: int) -> bool:
    d = _transposed_dir(job_id, semitones)
    return all((d / f"{s}.wav").exists() for s in STEMS)


def _run_pitch_shift(job_id: str, semitones: int) -> None:
    key = (job_id, semitones)
    try:
        import librosa
        import soundfile as sf
        import numpy as np
        with transpose_lock:
            transpose_jobs[key]["status"] = "running"
        out_dir = _transposed_dir(job_id, semitones)
        out_dir.mkdir(parents=True, exist_ok=True)
        for s in STEMS:
            src = STEMS_DIR / job_id / f"{s}.wav"
            y, sr = librosa.load(str(src), sr=None, mono=False)
            if y.ndim == 1:
                shifted = librosa.effects.pitch_shift(y=y, sr=sr, n_steps=semitones)
                sf.write(str(out_dir / f"{s}.wav"), shifted, sr)
            else:
                channels = [librosa.effects.pitch_shift(y=y[c], sr=sr, n_steps=semitones)
                            for c in range(y.shape[0])]
                shifted = np.stack(channels, axis=0)
                sf.write(str(out_dir / f"{s}.wav"), shifted.T, sr)
        with transpose_lock:
            transpose_jobs[key]["status"] = "done"
    except Exception as e:
        with transpose_lock:
            transpose_jobs[key]["status"] = "error"
            transpose_jobs[key]["error"] = str(e)


class TransposeRequest(BaseModel):
    job_id: str
    semitones: int


@app.post("/api/transpose")
def transpose(req: TransposeRequest):
    if req.semitones == 0 or _transposed_ready(req.job_id, req.semitones):
        return {"ready": True}
    key = (req.job_id, req.semitones)
    with transpose_lock:
        existing = transpose_jobs.get(key)
        if existing and existing["status"] in ("pending", "running"):
            return {"ready": False, "status": existing["status"]}
        transpose_jobs[key] = {"status": "pending", "error": None}
    threading.Thread(target=_run_pitch_shift, args=(req.job_id, req.semitones), daemon=True).start()
    return {"ready": False, "status": "pending"}


@app.get("/api/transpose/{job_id}/{semitones}")
def transpose_status(job_id: str, semitones: int):
    if semitones == 0 or _transposed_ready(job_id, semitones):
        return {"ready": True}
    with transpose_lock:
        job = transpose_jobs.get((job_id, semitones)) or {}
    return {"ready": False, "status": job.get("status"), "error": job.get("error")}


@app.get("/api/meta/{job_id}")
def meta(job_id: str):
    p = STEMS_DIR / job_id / "meta.json"
    if not p.exists():
        return {"bpm": None, "offset": 0.0}
    return json.loads(p.read_text())


@app.get("/api/library")
def library():
    items = []
    for d in sorted(STEMS_DIR.iterdir()) if STEMS_DIR.exists() else []:
        if d.is_dir() and all((d / f"{s}.wav").exists() for s in STEMS):
            with jobs_lock:
                name = jobs.get(d.name, {}).get("name") or d.name
            items.append({"job_id": d.name, "name": name})
    return {"items": items}


app.mount("/", StaticFiles(directory=Path(__file__).parent / "static", html=True), name="static")
