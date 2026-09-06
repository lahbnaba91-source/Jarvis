#!/usr/bin/env node
// test-smoothing.js -- correctness + performance harness for the
// predict-through-dropout landmark filter (../smoothing.js). No
// dependencies, no framework: run with `node test/test-smoothing.js`
// from the barehands folder -- same "nothing to install" rule as the
// rest of this repo.
//
// Checks three things:
//
//   1. COAST -- when a landmark's measurement is withheld (occlusion),
//      the estimate keeps moving along its last velocity instead of
//      freezing, and does not run away.
//
//   2. RE-LOCK -- when the measurement returns, the filter snaps back
//      onto truth within a few frames with no permanent offset, and a
//      single one-frame spike is rejected by the innovation gate.
//
//   3. BUDGET -- the whole 63-axis filter bank costs well under a
//      millisecond per frame. Hard gate: p99 < 1000us. (Real numbers
//      are ~1-2 orders of magnitude under that; the gate is a floor,
//      not a target.)
"use strict";

const path = require("path");
const S = require(path.join(__dirname, "..", "smoothing.js"));

let failed = 0;
function ok(cond, msg) {
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
  if (!cond) failed++;
}
function approx(a, b, tol) { return Math.abs(a - b) <= tol; }

// ---------------------------------------------------------------------
// 1 + 2. COAST + RE-LOCK
// One axis, driven along a smooth ramp at constant velocity so the
// "truth" is unambiguous: p(t) = 0.2 + 0.6 * t over 2 s, 30 fps.
// ---------------------------------------------------------------------
(function coastAndRelock() {
  const kf = S.makeHandKF();
  const IDX = 8 * 3;                 // index-fingertip, x axis
  const dt = 1 / 30;
  const vel = 0.6;                   // normalized / s
  const truth = t => 0.2 + vel * t;
  const noise = () => (Math.random() - 0.5) * 0.004;

  let coastErr = 0, relockErr = 0, maxCoastDrift = 0;
  const DROP_START = 30, DROP_LEN = 6;   // hide the point for 6 frames (~200ms)

  for (let f = 0; f < 60; f++) {
    const t = f * dt;
    const occluded = f >= DROP_START && f < DROP_START + DROP_LEN;
    const z = occluded ? null : truth(t) + noise();
    const r = S.stepAxis(kf, IDX, dt, z);

    if (occluded) {
      ok(r.coasted === true || f === DROP_START, "frame " + f + " reported coasted");
      maxCoastDrift = Math.max(maxCoastDrift, Math.abs(r.value - truth(t)));
      if (f === DROP_START + DROP_LEN - 1) coastErr = Math.abs(r.value - truth(t));
    }
    if (f === DROP_START + DROP_LEN + 2) relockErr = Math.abs(r.value - truth(t));
  }

  // during a 200ms dropout on a hand moving 0.6/s the coast should stay
  // within a few % of the frame -- a freeze would sit ~0.12 off by the
  // end (vel * DROP_LEN * dt).
  ok(coastErr < 0.03, "coast tracks a moving finger through 6-frame dropout (err " + coastErr.toFixed(4) + " < 0.03)");
  ok(coastErr < vel * DROP_LEN * dt * 0.5, "coast beats a freeze by >2x (err " + coastErr.toFixed(4) + " vs freeze " + (vel * DROP_LEN * dt).toFixed(4) + ")");
  ok(maxCoastDrift < 0.05, "coast never runs away (max drift " + maxCoastDrift.toFixed(4) + " < 0.05)");
  ok(relockErr < 0.01, "re-locks within 3 frames of the point returning (err " + relockErr.toFixed(4) + " < 0.01)");
})();

// ---------------------------------------------------------------------
// 2b. GATE -- a single wild one-frame reading is rejected, not tracked.
// ---------------------------------------------------------------------
(function gate() {
  const kf = S.makeHandKF();
  const IDX = 12 * 3;
  const dt = 1 / 30;
  for (let f = 0; f < 20; f++) S.stepAxis(kf, IDX, dt, 0.5 + (Math.random() - 0.5) * 0.002);
  const spike = S.stepAxis(kf, IDX, dt, 0.95);      // ~0.45 jump in one frame
  ok(spike.coasted === true, "one-frame spike is gated out (d2 " + spike.d2.toFixed(1) + " > gate)");
  ok(spike.value < 0.6, "estimate ignores the spike (stayed at " + spike.value.toFixed(3) + ", not ~0.95)");
  const back = S.stepAxis(kf, IDX, dt, 0.5);
  ok(approx(back.value, 0.5, 0.02), "recovers immediately after the spike (" + back.value.toFixed(3) + ")");
})();

// ---------------------------------------------------------------------
// 3. BUDGET -- full 63-axis bank, per-frame cost.
// ---------------------------------------------------------------------
(function budget() {
  const FRAMES = 20000;
  const dt = 1 / 30;
  const kf = S.makeHandKF();
  // realistic-ish input: 21 landmarks doing independent slow random
  // walks, with ~4% of axis-frames occluded at random.
  const pos = new Float64Array(S.N_AXES).fill(0.5);
  const times = new Float64Array(FRAMES);

  // warm up (JIT) before timing
  for (let w = 0; w < 500; w++) {
    for (let a = 0; a < S.N_AXES; a++) S.stepAxis(kf, a, dt, pos[a]);
  }

  for (let f = 0; f < FRAMES; f++) {
    const t0 = process.hrtime.bigint();
    for (let a = 0; a < S.N_AXES; a++) {
      pos[a] += (Math.random() - 0.5) * 0.01;
      const z = Math.random() < 0.04 ? null : pos[a];
      S.stepAxis(kf, a, dt, z);
    }
    times[f] = Number(process.hrtime.bigint() - t0) / 1000;   // us
  }

  times.sort();
  const p = q => times[Math.min(FRAMES - 1, Math.floor(q * FRAMES))];
  let mean = 0; for (const x of times) mean += x; mean /= FRAMES;
  console.log("  --- per-frame cost, 63-axis bank, " + FRAMES + " frames ---");
  console.log("      mean " + mean.toFixed(2) + "us   p50 " + p(0.5).toFixed(2) +
              "us   p99 " + p(0.99).toFixed(2) + "us   max " + times[FRAMES - 1].toFixed(2) + "us");
  ok(p(0.99) < 1000, "p99 per-frame cost < 1000us (was " + p(0.99).toFixed(2) + "us)");
  ok(mean < 200, "mean per-frame cost < 200us (was " + mean.toFixed(2) + "us)");
})();

console.log(failed ? "\n" + failed + " check(s) FAILED" : "\nall checks passed");
process.exit(failed ? 1 : 0);
