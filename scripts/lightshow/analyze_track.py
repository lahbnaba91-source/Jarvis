#!/usr/bin/env python3
"""Offline light-show cue generator: analyzes a real audio file and emits
the exact same band/onset/build-drop decisions the live mic-reactive
showLoop() in stage.html makes -- just run against the true full-length
waveform instead of a noisy room mic, so every timestamp is exact instead
of guessed live.

Usage:
    analyze_track.py <audio-file> <out.json> [--track-id <spotify-uri>]

Requires numpy -- run with jarvis-voice's venv (already has it):
    /workspaces/Jarvis/jarvis-voice/.venv/bin/python3 analyze_track.py ...

Pipeline:
  1. Decode to mono float32 PCM @ 22050Hz via ffmpeg (no extra audio libs).
  2. Frame it (46ms Hann window, 20ms hop) and FFT each frame.
  3. Bucket into bass(<250Hz)/mid(250-4000Hz)/high(>4000Hz) band energy,
     same split as the live JS.
  4. Per-band floor/ceil normalize using the 5th/95th percentile over the
     WHOLE track (we have all the data, so this beats the live version's
     online adaptive floor/ceil -- no warm-up period, no drift).
  5. Same short/long EMA + rising/spike thresholds as showLoop() decide
     groove/build/drop frame by frame, and the same 1.2s-between-commands
     throttle decides which frames actually become a cue.
  6. Each cue's fire time = its true timestamp minus LATENCY_MS (800ms,
     the bulb's measured cloud round-trip), so it lands compensated.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

SR = 22050
WIN = 1024          # ~46ms
HOP = 441            # ~20ms

# server.py logs every fired cue's real cloud round-trip and, after 5
# gesture-triggered sessions, averages them into this file -- once it
# exists, that measured number replaces the 800ms starting guess.
_CALIBRATION_PATH = Path(__file__).resolve().parent / "state" / "calibration.json"
try:
    LATENCY_MS = json.loads(_CALIBRATION_PATH.read_text())["latency_ms"]
except Exception:
    LATENCY_MS = 800     # starting guess, pre-calibration


def decode_pcm(path: str) -> np.ndarray:
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(SR),
         "-f", "f32le", "-"],
        capture_output=True, check=True,
    )
    return np.frombuffer(out.stdout, dtype=np.float32)


def band_energies(pcm: np.ndarray):
    window = np.hanning(WIN).astype(np.float32)
    freqs = np.fft.rfftfreq(WIN, d=1 / SR)
    bass_mask = freqs < 250
    mid_mask = (freqs >= 250) & (freqs < 4000)
    high_mask = freqs >= 4000

    n_frames = max(0, (len(pcm) - WIN) // HOP + 1)
    bass = np.zeros(n_frames, dtype=np.float32)
    mid = np.zeros(n_frames, dtype=np.float32)
    high = np.zeros(n_frames, dtype=np.float32)
    for i in range(n_frames):
        frame = pcm[i * HOP: i * HOP + WIN] * window
        mag = np.abs(np.fft.rfft(frame))
        bass[i] = mag[bass_mask].mean() if bass_mask.any() else 0
        mid[i] = mag[mid_mask].mean() if mid_mask.any() else 0
        high[i] = mag[high_mask].mean() if high_mask.any() else 0
    return bass, mid, high


def normalize(raw: np.ndarray) -> np.ndarray:
    floor, ceil = np.percentile(raw, [5, 95])
    span = max(ceil - floor, 1e-6)
    return np.clip((raw - floor) / span, 0, 1)


# wide, high-contrast, fully-saturated palette -- each band cycles
# through its own pool (round-robin) so consecutive hits on the SAME
# band still vary, instead of every high-band hit looking identical
BAND_PALETTE = {
    "bass": [(255, 60, 0, 100), (255, 0, 40, 100)],           # orange, red
    "mid": [(255, 20, 147, 100), (170, 0, 255, 100)],         # pink, purple
    "high": [(0, 255, 60, 100), (0, 220, 255, 100)],          # green, cyan
}
BASE_COLOR = (20, 20, 255, 100)   # vivid resting blue, full brightness
# 2.5s floor between ANY two commands (was 1.2s) -- firing near the bulb's
# real ~0.8s round-trip left near-zero slack; commands started stacking
# up in Hubspace's queue and executing late/out-of-order under load.
# 2.5s keeps a healthy buffer so the cloud never falls behind.
MIN_GAP_MS = 2500

# Hand-placed STATE ANCHORS: a few high-impact moments beat automated
# onset detection can't reliably characterize on its own (a deliberate
# brightness ramp through a build section). These always fire and
# suppress any automated pulse within ANCHOR_GUARD_MS of them, so they
# never get stepped on by a same-second automated hit.
ANCHOR_GUARD_MS = 2000
MANUAL_ANCHORS = [
    # (t_ms, r, g, b, brightness) -- the build-up ramp into the return
    (211021, 20, 20, 255, 35),     # 03:31.021 -- step to 35%
    (224638, 20, 20, 255, 55),     # 03:44.638 -- step to 55%
    (238255, 20, 20, 255, 80),     # 03:58.255 -- step to 80%
    (248468, 255, 255, 255, 100),  # 04:08.468 -- the return, bright white
]


def gen_cues(bass, mid, high):
    """Hit-pulse model: per-band onset (rising-edge vs that band's own
    recent baseline, same shape as the live showLoop's updateBand), then
    non-max-suppress to at most one pulse per MIN_GAP_MS -- the strongest
    hit in each window wins, colored by whichever band drove it. Genre-
    agnostic (unlike a build/drop state machine, which assumes an EDM
    quiet-to-loud arc this track may not have): it just finds real hits.
    """
    n = len(bass)
    bands = {"bass": bass, "mid": mid, "high": high}
    state = {name: {"short": 0.0, "baseline": 0.0} for name in bands}
    events = []  # (t_ms, band, strength)
    for i in range(n):
        t_ms = i * HOP / SR * 1000
        best_band, best_strength = None, 0.0
        for name, arr in bands.items():
            s = state[name]
            v = float(arr[i])
            s["short"] += (v - s["short"]) * 0.3
            s["baseline"] += (v - s["baseline"]) * 0.02
            strength = s["short"] - s["baseline"]
            if strength > 0.35 and strength > best_strength:
                best_strength = strength
                best_band = name
        if best_band:
            events.append((t_ms, best_band, best_strength))

    # manual anchors always win: drop any automated event too close to one
    anchor_ts = [a[0] for a in MANUAL_ANCHORS]
    events = [e for e in events
              if all(abs(e[0] - at) >= ANCHOR_GUARD_MS for at in anchor_ts)]

    # non-max suppression: strongest hit wins any MIN_GAP_MS window
    kept = []
    for t_ms, band, strength in sorted(events, key=lambda e: -e[2]):
        if all(abs(t_ms - k[0]) >= MIN_GAP_MS for k in kept):
            kept.append((t_ms, band, strength))
    kept.sort(key=lambda e: e[0])

    cues = []
    palette_idx = {name: 0 for name in bands}
    for idx, (t_ms, band, _) in enumerate(kept):
        pool = BAND_PALETTE[band]
        r, g, b, br = pool[palette_idx[band] % len(pool)]
        palette_idx[band] += 1
        cues.append({"t_ms": round(t_ms), "fire_at_ms": max(0, round(t_ms - LATENCY_MS)),
                     "r": r, "g": g, "b": b, "brightness": br, "band": band})
        # settle back to base before the next pulse, if there's a real gap
        next_t = kept[idx + 1][0] if idx + 1 < len(kept) else None
        settle_t = t_ms + MIN_GAP_MS
        if next_t is None or next_t - settle_t >= MIN_GAP_MS:
            r, g, b, br = BASE_COLOR
            cues.append({"t_ms": round(settle_t), "fire_at_ms": max(0, round(settle_t - LATENCY_MS)),
                         "r": r, "g": g, "b": b, "brightness": br, "band": None})

    for t_ms, r, g, b, br in MANUAL_ANCHORS:
        cues.append({"t_ms": t_ms, "fire_at_ms": max(0, round(t_ms - LATENCY_MS)),
                     "r": r, "g": g, "b": b, "brightness": br, "band": "anchor"})
    cues.sort(key=lambda c: c["t_ms"])
    return cues


def main():
    if len(sys.argv) < 3:
        print("usage: analyze_track.py <audio-file> <out.json> [--track-id <uri>]",
              file=sys.stderr)
        sys.exit(1)
    audio_path, out_path = sys.argv[1], sys.argv[2]
    track_id = None
    if "--track-id" in sys.argv:
        track_id = sys.argv[sys.argv.index("--track-id") + 1]

    pcm = decode_pcm(audio_path)
    duration_s = len(pcm) / SR
    bass_raw, mid_raw, high_raw = band_energies(pcm)
    bass, mid, high = normalize(bass_raw), normalize(mid_raw), normalize(high_raw)
    cues = gen_cues(bass, mid, high)

    with open(out_path, "w") as f:
        json.dump({"track_id": track_id, "duration_s": round(duration_s, 2),
                    "latency_ms": LATENCY_MS, "cues": cues}, f, indent=2)

    print(json.dumps({"duration_s": round(duration_s, 2), "n_cues": len(cues),
                       "out": out_path}))


if __name__ == "__main__":
    main()
