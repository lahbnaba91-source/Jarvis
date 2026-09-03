// gestures.js -- pure hand-pose detectors, zero DOM/browser/camera
// dependencies. Loaded two ways from the ONE file, so the live app and
// its regression test can never quietly drift apart:
//   - stage.html loads it as a plain <script> (no bundler, no build
//     step -- same "nothing to install" rule as the rest of this repo).
//     It hangs every function off `window` as a global, same as if
//     they'd been declared inline the way they used to be.
//   - test/test-gestures.js requires it under Node (module.exports).
// Every formula below was extracted VERBATIM from stage.html's inline
// gesture logic on 2026-08-27 -- same numbers, same math, nothing
// retuned. If a threshold ever needs to change, change it here; both
// the live app and the test pick it up automatically.
(function (root) {
  "use strict";

  function hypot2(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  // tip-to-wrist / base-to-wrist ratio, the convention every gate here
  // is built from (see stage.html's lmExtended/wristRatio for the same
  // shape). W0 = landmark 0, the wrist.
  function wristRatio(lms, tip, base) {
    const W0 = lms[0];
    return hypot2(lms[tip], W0) / (hypot2(lms[base], W0) || 1);
  }

  // which of the 4 non-thumb fingers read "extended" (1.45x cut) --
  // index, middle, ring, pinky, in that order. The base extArr every
  // pose gate below composes from.
  function extArr(lms) {
    return [[8, 5], [12, 9], [16, 13], [20, 17]].map(([t, m]) =>
      wristRatio(lms, t, m) > 1.45);
  }

  // thumb extended, 1.45x cut -- same formula as extArr's fingers, just
  // CMC(2)->tip(4) instead of MCP->tip. Named thumbExt in stage.html's
  // claw section, thumbExtMid in its middleUp/fingerGun section -- same
  // math, one function here.
  function thumbExtended(lms) {
    return wristRatio(lms, 4, 2) > 1.45;
  }

  // ROCK ON: index + pinky extended (1.35x), middle + ring curled
  // (1.15x) -- its own thresholds, independent of extArr on purpose.
  function rockSign(lms) {
    const out = (t, m) => wristRatio(lms, t, m) > 1.35;
    const inn = (t, m) => wristRatio(lms, t, m) < 1.15;
    return out(8, 5) && out(20, 17) && inn(12, 9) && inn(16, 13);
  }

  // MIDDLE FINGER UP: middle alone extended, thumb NOT extended.
  function middleUpSign(lms) {
    const e = extArr(lms);
    return e[1] && !e[0] && !e[2] && !e[3] && !thumbExtended(lms);
  }

  // PEACE SIGN: index + middle extended, ring + pinky curled.
  function peaceSign(lms) {
    const e = extArr(lms);
    return e[0] && e[1] && !e[2] && !e[3];
  }

  // SHUSH: index alone extended, thumb + other three curled -- the "one
  // finger to the lips" hand shape. Pose-only here; stage.html gates it
  // further on the fingertip actually sitting near the FaceDetector's
  // mouth keypoint, which is what makes it a real shush and not just a
  // point. Distinct from middleUpSign (middle alone) and from
  // clawPose/fingerGunSign (both need the thumb OUT).
  function shushSign(lms) {
    const e = extArr(lms);
    return e[0] && !e[1] && !e[2] && !e[3] && !thumbExtended(lms);
  }

  // FORCE-PULL CHARGE/AIM ("the claw"): thumb + index out, other three
  // curled. Fitted from real recorded takes (thumb 1.56-1.65, index
  // 1.87-2.47, others 1.16-1.40 -- see state/gesture_log.jsonl).
  // 2026-08-27 (found building the regression harness, not live-reported
  // yet): fingerGunSign's tight-fist curl (<0.92) is a strict SUBSET of
  // this pose's loose curl allowance (<=1.45) -- every other condition
  // between the two is identical, so without this exclusion, doing the
  // dun-dun pose would ALWAYS also read as a claw and silently arm a
  // force-pull charge in the background. Explicitly carved out so the
  // two stay mutually exclusive, matching what "make dun-dun a different
  // pose" actually meant -- see test/test-gestures.js, which asserts
  // this invariant on every recorded take.
  // excludeDunDun (2026-08-27, the settings-panel build): defaults true
  // (the shipped, tested behavior -- also what the Node regression test
  // always exercises, since it never passes this). Pass false only when
  // the dun-dun toggle itself is off in the settings panel -- with no
  // competing feature to protect against, that tight-fist hand shape
  // should just register as a normal claw again instead of neither.
  function clawPose(lms, curlMax, excludeDunDun) {
    if (excludeDunDun === undefined) excludeDunDun = true;
    const e = extArr(lms);
    const base = thumbExtended(lms) && e[0] && !e[1] && !e[2] && !e[3];
    return excludeDunDun ? base && !fingerGunSign(lms, curlMax) : base;
  }

  // FORCE-PULL FIRE ("the snap"/"like button"): thumb stays out, index
  // folds back in from the charge pose above.
  function snapPose(lms) {
    const e = extArr(lms);
    return thumbExtended(lms) && !e[0];
  }

  // DUN DUN: the SAME thumb+index shape as clawPose above -- thumb and
  // index don't separate the two poses at all (both land in the same
  // fitted range). What does: clawPose curls the other three fingers
  // LOOSELY (fitted 1.16-1.40); this pose curls them into a TIGHT fist
  // (<0.92 default, cut mid-canyon against a real recorded take that
  // measured 0.57-0.67 -- see state/gesture_log.jsonl and stage.html's
  // own comment where this is wired in). Deliberately distinct from
  // clawPose so aiming a force-pull never also triggers this.
  // curlMax (2026-08-27, the settings-panel build): optional override
  // for the settings panel's live retuning -- defaults to the fitted
  // 0.92 so the Node regression test (which never passes one) always
  // checks the shipped default, not whatever a user last dragged a
  // slider to.
  function fingerGunSign(lms, curlMax) {
    const cap = typeof curlMax === "number" ? curlMax : 0.92;
    const e = extArr(lms);
    const tight = wristRatio(lms, 12, 9) < cap &&
                  wristRatio(lms, 16, 13) < cap &&
                  wristRatio(lms, 20, 17) < cap;
    return thumbExtended(lms) && e[0] && tight;
  }

  // FIST: all four fingers curled AND thumb curled -- the "rock" throw
  // for rock-paper-scissors. A fist while CARRYING an item is the
  // force-pull hold, so stage.html only reads this when nothing's
  // grabbed.
  function fistSign(lms) {
    const e = extArr(lms);
    return !e[0] && !e[1] && !e[2] && !e[3] && !thumbExtended(lms);
  }

  // OPEN PALM: all four fingers extended -- the "paper" throw. Thumb is
  // not required either way (it reads inconsistently splayed vs tucked
  // across real hands); the four-finger fan is the reliable tell.
  function openPalmSign(lms) {
    const e = extArr(lms);
    return e[0] && e[1] && e[2] && e[3];
  }

  const GESTURES = {
    wristRatio, extArr, thumbExtended,
    rockSign, middleUpSign, peaceSign, shushSign, fistSign, openPalmSign,
    clawPose, snapPose, fingerGunSign,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = GESTURES;
  } else {
    Object.assign(root, GESTURES);
  }
})(typeof window !== "undefined" ? window : globalThis);
