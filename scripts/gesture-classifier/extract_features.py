#!/usr/bin/env python3
"""Turn recorded CALIBRATE takes into an ML-ready feature/label array.

Reads every `calibration:<pose>` take off the running barehands server (the
same /dev/gestures endpoints the dev dashboard's confusion matrix already
uses — no need to re-parse gesture_log.jsonl or duplicate server.py's
take-normalization logic), extracts a scale/translation-invariant feature
vector per hand per frame, and writes them to a single .npz for train.py.

Usage:
    python3 extract_features.py [--server http://127.0.0.1:8794] [--out features.npz]

Requires the barehands server running locally (it is, whenever the board's
up — see server.py, port 8794) and at least a few `calibration:<pose>`
takes in the log. As of 2026-09-09 there are ZERO — this only becomes
runnable once someone actually goes through dev.html's Calibration panel
(or the on-phone CALIBRATE wizard) for real. Run with no data and it exits
with a clear message instead of writing an empty/fake dataset.
"""
import argparse
import sys
from collections import Counter

import numpy as np
import requests

# Landmark indices (MediaPipe HandLandmarker, the same 21-point layout
# every pose function in gestures.js already reads): 0 = wrist, 9 = middle
# finger MCP. Used to make every hand's 63 raw (x,y,z) numbers invariant to
# where the hand is in frame and how close it is to the camera -- without
# this, the model would partly be learning "hand position on screen"
# instead of "hand shape", which is useless once someone moves.
WRIST = 0
MIDDLE_MCP = 9


def normalize_hand(lms):
    """[[x,y,z]*21] -> flat 63-float vector, wrist-relative and scaled by
    wrist-to-middle-MCP distance (the same 'hand span' reference the
    curl-ratio thresholds in gestures.js are built from). Returns None for
    a malformed or degenerate (zero-span) hand so the caller can skip it
    instead of poisoning the dataset with a NaN/inf row."""
    if not lms or len(lms) != 21:
        return None
    pts = np.asarray(lms, dtype=np.float64)
    if pts.shape != (21, 3):
        return None
    wrist = pts[WRIST]
    span = np.linalg.norm(pts[MIDDLE_MCP] - wrist)
    if span < 1e-6:
        return None
    rel = (pts - wrist) / span
    return rel.reshape(-1).astype(np.float32)


def fetch_calibration_takes(server):
    r = requests.get(f"{server}/dev/gestures", timeout=10)
    r.raise_for_status()
    takes = r.json().get("takes", [])
    return [t for t in takes if (t.get("label") or "").startswith("calibration:")]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--server", default="http://127.0.0.1:8794")
    ap.add_argument("--out", default="features.npz")
    args = ap.parse_args()

    try:
        takes = fetch_calibration_takes(args.server)
    except requests.RequestException as e:
        print(f"can't reach the barehands server at {args.server} ({e}) "
              "-- is server.py running?", file=sys.stderr)
        sys.exit(1)

    if not takes:
        print("no `calibration:<pose>` takes found -- nothing to extract. "
              "Run a real calibration pass first (dev.html's Calibration "
              "panel, or the on-phone CALIBRATE wizard), then re-run this.",
              file=sys.stderr)
        sys.exit(1)

    X, y = [], []
    skipped = 0
    for t in takes:
        pose = t["label"].split(":", 1)[1]
        detail = requests.get(f"{args.server}/dev/gestures/{t['id']}", timeout=10).json()
        for frame_hands in detail.get("frames", []):
            for hand in frame_hands:
                feat = normalize_hand(hand)
                if feat is None:
                    skipped += 1
                    continue
                X.append(feat)
                y.append(pose)

    if not X:
        print("every take found had 0 usable hand frames after "
              f"normalization ({skipped} skipped as malformed/degenerate) "
              "-- nothing to write.", file=sys.stderr)
        sys.exit(1)

    X = np.stack(X)
    y = np.asarray(y)
    counts = Counter(y.tolist())
    np.savez(args.out, X=X, y=y)
    print(f"wrote {args.out}: {len(X)} samples, {len(counts)} classes"
          f"{' (' + str(skipped) + ' frames skipped)' if skipped else ''}")
    for pose, n in sorted(counts.items()):
        flag = "  <- thin, want more reps" if n < 30 else ""
        print(f"  {pose:16s} {n:5d}{flag}")


if __name__ == "__main__":
    main()
