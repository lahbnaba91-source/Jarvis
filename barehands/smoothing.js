// smoothing.js -- predict-through-dropout estimator for occluded hand
// landmarks. Zero DOM/browser/camera dependencies, loaded the same two
// ways as gestures.js so the live app and its test can't drift:
//   - stage.html loads it as a plain <script> (no bundler, no build
//     step) -- it hangs SMOOTHING off `window`.
//   - test/test-smoothing.js requires it under Node (module.exports).
//
// WHAT THIS IS FOR (2026-09-05, Luis's ask): MediaPipe re-infers all 21
// points every frame with no memory of its own. When a finger goes
// behind the hand its guess jumps wildly or the tracker just drops it.
// stage.html's One Euro filter already kills steady-state jitter well;
// what it does badly is dropout -- smoothLandmarks() currently FREEZES
// an occluded point at its last position for up to LM_STUCK_MAX frames
// (out[i] = prev), so an occluded finger visibly stops dead mid-motion
// and then snaps.
//
// This is a per-axis constant-velocity Kalman filter that runs
// alongside One Euro (NOT replacing it). While a landmark is visible it
// tracks normally. While a landmark is occluded the caller withholds
// the measurement: the filter runs predict-only, so the point keeps
// gliding along its last estimated velocity and decelerates as its
// covariance grows, instead of freezing. When the real point comes
// back, the inflated covariance gives a high gain and it re-locks in a
// frame or two with no permanent offset.
//
// It is a TOGGLE-ABLE path: stage.html's COAST button feeds this
// filter's prediction into One Euro during dropout when on, and is
// byte-identical to the old freeze behaviour when off.
//
// MODEL. Per landmark per axis (21 x 3 = 63 independent 1-D filters):
//   state  x = [ p, v ]                 position, velocity
//   cov    P = [[p00, p01], [p01, p11]] symmetric, kept as 3 scalars
//   predict: constant velocity, continuous white-noise-acceleration Q
//   update : scalar position measurement, H = [1, 0]
// A 2-state filter has a closed-form steady state (the alpha-beta
// filter); the full recursion is kept here only because the dropout
// case deliberately drives P away from steady state and back.
//
// TUNING. KF_Q / KF_R / KF_GATE below are reasoned first passes in raw
// normalized-coordinate units ([0,1] across the frame), NOT fitted from
// recorded footage -- same honesty as stage.html's One Euro constants.
// A recorded VIDEO take of a real occlusion glitch would let these get
// fitted against actual numbers.
(function (root) {
  "use strict";

  // process-noise spectral density, normalized^2 / s^3. Higher = the
  // estimate is allowed to accelerate more between measurements, so it
  // coasts less confidently and re-locks faster. At dt~=1/30 this lets
  // the position wander ~0.02 of the frame per frame from process noise
  // alone -- about a fast hand.
  var KF_Q = 30;
  // measurement-noise variance, normalized^2. ~1e-4 => ~0.01 stdev, a
  // little looser than MediaPipe's real per-point jitter on purpose so
  // the filter doesn't fight One Euro while the point is visible (the
  // coast is the only part that has to be good).
  var KF_R = 1e-4;
  // reject an offered measurement whose normalized innovation squared
  // (y^2 / S, a Mahalanobis distance) exceeds this even if the caller
  // thought it was trusted -- ~9 is a 3-sigma gate. A hard consecutive
  // -reject cap lives in the caller (LM_STUCK_MAX) so sustained "gate
  // failures" that are really fast motion still force a re-lock.
  var KF_GATE = 9;

  var N_AXES = 63;          // 21 landmarks x 3 axes
  var STRIDE = 5;           // p, v, p00, p01, p11 per axis

  // one filter bank for a single tracked hand. `s` is flat for speed;
  // `on` marks which axes have been seeded.
  function makeHandKF() {
    return { s: new Float64Array(N_AXES * STRIDE), on: new Uint8Array(N_AXES) };
  }

  function seedAxis(kf, idx, p0) {
    var b = idx * STRIDE, s = kf.s;
    s[b] = p0; s[b + 1] = 0;
    s[b + 2] = KF_R; s[b + 3] = 0; s[b + 4] = KF_Q * 0.01;
    kf.on[idx] = 1;
  }

  // Advance one axis by dt seconds. `z` is the offered measurement, or
  // null to run predict-only (the dropout / coast path). Returns
  //   { value, coasted, d2 }
  // value  -- the position estimate to hand downstream (to One Euro)
  // coasted-- true if no measurement was folded in this step
  // d2     -- normalized innovation squared when z was offered, else 0
  // opts (all optional): { r, q, gate } override the module constants.
  function stepAxis(kf, idx, dt, z, opts) {
    var s = kf.s, b = idx * STRIDE;
    if (!kf.on[idx]) { seedAxis(kf, idx, z == null ? 0 : z); return { value: s[b], coasted: z == null, d2: 0 }; }
    var q = (opts && opts.q != null) ? opts.q : KF_Q;
    var r = (opts && opts.r != null) ? opts.r : KF_R;
    var gate = (opts && opts.gate != null) ? opts.gate : KF_GATE;
    if (!(dt > 0)) dt = 1 / 120;               // clamp a bad / zero dt

    // ---- predict (constant velocity) ----
    var p = s[b], v = s[b + 1];
    var p00 = s[b + 2], p01 = s[b + 3], p11 = s[b + 4];
    p = p + v * dt;
    var dt2 = dt * dt, dt3 = dt2 * dt;
    p00 = p00 + 2 * p01 * dt + p11 * dt2 + q * dt3 / 3;
    p01 = p01 + p11 * dt + q * dt2 / 2;
    p11 = p11 + q * dt;

    var coasted = true, d2 = 0;
    if (z != null) {
      var y = z - p;              // innovation
      var S = p00 + r;
      d2 = (y * y) / S;
      if (d2 <= gate) {
        var K0 = p00 / S, K1 = p01 / S;
        p = p + K0 * y;
        v = v + K1 * y;
        var n00 = (1 - K0) * p00;
        var n01 = (1 - K0) * p01;
        var n11 = p11 - K1 * p01;
        p00 = n00; p01 = n01; p11 = n11;
        coasted = false;
      }
    }

    s[b] = p; s[b + 1] = v;
    s[b + 2] = p00; s[b + 3] = p01; s[b + 4] = p11;
    return { value: p, coasted: coasted, d2: d2 };
  }

  var SMOOTHING = {
    makeHandKF: makeHandKF,
    seedAxis: seedAxis,
    stepAxis: stepAxis,
    KF_Q: KF_Q, KF_R: KF_R, KF_GATE: KF_GATE,
    N_AXES: N_AXES,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = SMOOTHING;
  } else {
    root.SMOOTHING = SMOOTHING;
  }
})(typeof window !== "undefined" ? window : globalThis);
