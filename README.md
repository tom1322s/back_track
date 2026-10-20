# back_track

Local app for guitar practice: upload an MP3, split it into stems (vocals / drums / bass / other), then play along with per-stem volume, speed control (pitch preserved), and a metronome.

## Run

```sh
docker compose up --build
```

Then open http://localhost:8000.

Separated stems and uploads are persisted in `./data/` on the host.

## How it works

- **Separation**: [Demucs](https://github.com/facebookresearch/demucs) `htdemucs` model (4 stems). Runs on CPU — ~1–3 min per song.
- **Playback**: browser Web Audio API. One `<audio>` per stem routed through a `GainNode`, synced each frame to the lead stem.
- **Speed**: `playbackRate` with `preservesPitch` so tuning stays correct.
- **Metronome**: scheduler running on `AudioContext.currentTime` for sample-accurate clicks.

## Notes

- First build downloads the Demucs model (~80MB) and torch (~800MB) — give it a few minutes.
- For 6-stem separation (splits `guitar` and `piano` out of `other`), change `MODEL = "htdemucs"` to `MODEL = "htdemucs_6s"` in `app/main.py` and extend the `STEMS` tuple in both `main.py` and `app.js`.
- The cache key is a SHA-256 of the file, so re-uploading the same song skips separation.
