#!/usr/bin/env python3
"""Train the small MLP gesture classifier on extract_features.py's output.

Usage:
    python3 train.py [--features features.npz] [--out model] [--epochs 80]

Architecture is deliberately small (this replaces a handful of hand-tuned
thresholds, not a vision model): Dense(64, relu) -> Dropout(0.2) ->
Dense(32, relu) -> Dense(n_classes, softmax) on the 63-float normalized
landmark vector from extract_features.py. Saves a Keras model + a
labels.json (softmax index -> pose name, so the browser side and this
script never have to agree on class order by convention) to --out.

Not run yet -- see extract_features.py's docstring. Doesn't hyperparameter-
tune blind, either: 80 epochs / this shape are reasonable starting points,
not numbers fit to real data that doesn't exist yet. Re-tune once a real
dataset and its accuracy curve exist to tune against.
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import tensorflow as tf


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--features", default="features.npz")
    ap.add_argument("--out", default="model")
    ap.add_argument("--epochs", type=int, default=80)
    ap.add_argument("--val-split", type=float, default=0.2)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    if not Path(args.features).exists():
        print(f"{args.features} not found -- run extract_features.py first.",
              file=sys.stderr)
        sys.exit(1)

    data = np.load(args.features, allow_pickle=True)
    X, y_raw = data["X"], data["y"]
    classes = sorted(set(y_raw.tolist()))
    if len(classes) < 2:
        print(f"only {len(classes)} class(es) in {args.features} -- need at "
              "least 2 poses to train a classifier.", file=sys.stderr)
        sys.exit(1)
    class_to_idx = {c: i for i, c in enumerate(classes)}
    y = np.array([class_to_idx[c] for c in y_raw.tolist()], dtype=np.int64)

    per_class_min = min(np.bincount(y))
    if per_class_min < 10:
        print(f"warning: thinnest class has only {per_class_min} samples -- "
              "the split/accuracy below won't mean much yet. Record more "
              "reps before trusting this run.", file=sys.stderr)

    tf.random.set_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    idx = rng.permutation(len(X))
    X, y = X[idx], y[idx]

    model = tf.keras.Sequential([
        tf.keras.layers.Input(shape=(X.shape[1],)),
        tf.keras.layers.Dense(64, activation="relu"),
        tf.keras.layers.Dropout(0.2),
        tf.keras.layers.Dense(32, activation="relu"),
        tf.keras.layers.Dense(len(classes), activation="softmax"),
    ])
    model.compile(optimizer="adam", loss="sparse_categorical_crossentropy",
                  metrics=["accuracy"])

    history = model.fit(
        X, y, epochs=args.epochs, validation_split=args.val_split,
        callbacks=[tf.keras.callbacks.EarlyStopping(
            monitor="val_loss", patience=10, restore_best_weights=True)],
        verbose=2,
    )

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model.save(out / "model.keras")
    (out / "labels.json").write_text(json.dumps(classes, indent=2))

    val_acc = history.history.get("val_accuracy", [None])[-1]
    print(f"\nsaved {out / 'model.keras'} + {out / 'labels.json'}"
          f" ({len(classes)} classes: {', '.join(classes)})")
    if val_acc is not None:
        print(f"final val accuracy: {val_acc:.3f}")


if __name__ == "__main__":
    main()
