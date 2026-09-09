# Gesture classifier training pipeline

Trains the small MLP classifier from barehands' "ML gesture classifier"
idea (see the vault's `Jarvis Hands (barehands)` system note) — replacing
`gestures.js`'s hand-tuned
thresholds (curl ratio, span, angle) with a model trained directly on the 21
MediaPipe landmarks per hand, run in-browser via TensorFlow.js.

## Status: scaffold only, not yet run

`gesture_log.jsonl` holds **zero** `calibration:<pose>` takes as of
2026-09-09. This pipeline can't train on nothing, so nothing has been
trained, no accuracy numbers exist, and no model has shipped — building
those blind would be exactly the kind of guessed threshold this whole
effort exists to get away from. It's ready to run the moment real reps
exist.

**To get real data:** run through the CALIBRATE flow — either dev.html's
Calibration panel (recommended, a second device drives it) or the on-phone
CALIBRATE button — for real, more than once. More reps per pose beats
exactly 3; the wizard's 3-rep default is a floor, not a target.

## Pipeline

```
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# 1. Pull every calibration:<pose> take off the running server (port 8794)
#    and turn it into a feature/label array.
.venv/bin/python3 extract_features.py

# 2. Train the MLP on that array.
.venv/bin/python3 train.py

# 3. Export to a browser-loadable TFJS Layers model.
.venv/bin/python3 export_tfjs.py
```

Each script's own docstring (`--help`) has the full flag list and
reasoning. `extract_features.py` needs `server.py` running locally (it
reads the same `/dev/gestures` endpoints the dev dashboard's confusion
matrix already uses); `train.py` and `export_tfjs.py` are offline.

## Feature representation

Each hand, each frame → a flat 63-float vector: the 21 `[x,y,z]` landmarks,
translated so the wrist sits at the origin and scaled by the wrist-to-
middle-MCP distance (landmarks 0 and 9) — the same "hand span" reference
the existing curl-ratio thresholds are built from. Makes the vector
invariant to where the hand is on screen and how close it is to the
camera; without that the model would partly be learning "position on
screen" instead of "hand shape."

## Label vocabulary

Whatever `calibration:<pose>` labels actually exist in the log — currently
the 5 poses both CALIBRATE flows tag: `pinch`, `claw-charge`, `finger-gun`,
`peace-sign`, `rock-on`. `train.py` derives its class list from the data
itself, not a hardcoded list, so recording extra/different poses under
their own `calibration:<name>` label (a manual RECORD press with that
exact label, or a new step added to CAL_STEPS in both stage.html and
dev.js) just works without a code change here.

## Not built yet: the browser side

`export_tfjs.py` writes a loadable model to `barehands/model/gesture-
classifier/`, but nothing in `stage.html` loads it or calls it instead of
`gestures.js`'s pose functions. That's deliberate — wiring in a model with
zero accuracy data behind it would be worse than the thresholds it'd
replace. Once a real trained model has real accuracy numbers worth
trusting, the swap-in is its own pass: `tf.loadLayersModel()`, run
`normalize_hand()`'s same transform (mirror it client-side or share it)
on live landmarks each frame, argmax the softmax against `labels.json`.
