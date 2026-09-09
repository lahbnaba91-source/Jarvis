#!/usr/bin/env python3
"""Convert train.py's Keras model to a TFJS Layers model the browser can
load directly with tf.loadLayersModel(), no build step.

Usage:
    python3 export_tfjs.py [--model model] [--out ../../barehands/model/gesture-classifier]

Copies labels.json alongside model.json/*.bin so the browser side has the
softmax-index -> pose-name mapping without hardcoding it a second time.
Default --out lands inside the barehands tree (a new `model/` dir, not
committed until it holds a real trained model -- see .gitignore note in
the README next to this script) so stage.html can fetch it same-origin.
"""
import argparse
import shutil
import sys
from pathlib import Path

import tensorflowjs as tfjs
import tensorflow as tf

HERE = Path(__file__).resolve().parent


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--model", default="model")
    ap.add_argument("--out", default=str(HERE / ".." / ".." / "barehands" / "model" / "gesture-classifier"))
    args = ap.parse_args()

    model_dir = Path(args.model)
    keras_path = model_dir / "model.keras"
    labels_path = model_dir / "labels.json"
    if not keras_path.exists() or not labels_path.exists():
        print(f"{keras_path} / {labels_path} not found -- run train.py first.",
              file=sys.stderr)
        sys.exit(1)

    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=True)

    model = tf.keras.models.load_model(keras_path)
    tfjs.converters.save_keras_model(model, str(out))
    shutil.copy(labels_path, out / "labels.json")

    print(f"exported TFJS layers model + labels.json to {out}")
    print("browser side (NOT wired up yet -- future work, see README): "
          "tf.loadLayersModel('/model/gesture-classifier/model.json'), "
          "predict() on extract_features.py's same normalize_hand() "
          "vector, argmax the softmax against labels.json.")


if __name__ == "__main__":
    main()
