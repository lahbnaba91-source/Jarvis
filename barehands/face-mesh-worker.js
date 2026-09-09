// face-mesh-worker.js -- off-main-thread MediaPipe FaceLandmarker for the
// barehands SKELETON view (2026-09-09, Luis's ask: "closest to ARKit
// face tracking").
//
// The 478-point face mesh is the exact heavy model the stage.html "FACE
// DETECTOR" note refused to run inline -- it stuttered a real phone to
// 12fps (2026-09-04). So it lives here, in a Worker, on the CPU/WASM
// delegate, off the render thread. The main page sends a downscaled
// frame (ImageBitmap from a canvas, or ImageData) and draws whatever
// mesh came back on the previous tick.
//
// Every stage reports to POST /diag (same origin, no main-thread hop)
// so a headless phone's failure is readable server-side. See
// barehands/DIAGNOSTICS.md.
//
//   in : { bitmap:ImageBitmap } | { img:ImageData }   (+ frames counter)
//   out: { ok:true, ready:true }
//        { ok:true, lm:Float32Array(N*3)|null, blend:[{name,score}]|null,
//          pose:Float32Array(16)|null, frames }
//        { ok:false, err:string }

const DELEGATE = (new URLSearchParams(self.location.search).get("delegate")
  || "cpu").toLowerCase() === "gpu" ? "GPU" : "CPU";

let _seq = 0;
function diag(stage, extra) {
  try {
    fetch("/diag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign(
        { kind: "facemesh-worker", src: "worker", stage,
          seq: ++_seq, t: Date.now() / 1000, delegate: DELEGATE }, extra || {})),
    }).catch(() => {});
  } catch (e) {}
}

self.addEventListener("error", (e) => {
  diag("global-error", { msg: e.message || e.filename || "?", line: e.lineno });
  self.postMessage({ ok: false, err: "worker error: " + (e.message || e.filename || "?") });
});
self.addEventListener("unhandledrejection", (e) => {
  const m = String((e.reason && (e.reason.stack || e.reason.message)) || e.reason || "?");
  diag("global-rejection", { msg: m.slice(0, 600) });
  self.postMessage({ ok: false, err: "worker rejection: " + m.slice(0, 300) });
});

diag("boot", { location: String(self.location.href) });

// MediaPipe WASM errors often arrive message-less (just a stack). Pull
// everything printable off the exception so the diag line is useful.
function errDetail(e) {
  if (e == null) return "unknown";
  const bits = [];
  if (e.name) bits.push(e.name);
  if (e.message) bits.push(e.message);
  if (!e.message && typeof e === "object") {
    try {
      const own = {};
      for (const k of Object.getOwnPropertyNames(e)) own[k] = String(e[k]).slice(0, 200);
      bits.push(JSON.stringify(own));
    } catch (_) {}
  }
  const s = String(e);
  if (s && s !== "[object Object]" && !bits.includes(s)) bits.push(s);
  if (e.stack) bits.push("@ " + String(e.stack).split("\n").slice(0, 4).join(" | "));
  return bits.join("  ").slice(0, 600);
}

let FaceLandmarker, FilesetResolver, landmarker = null;

const ready = (async () => {
  try {
    diag("import-start");
    ({ FaceLandmarker, FilesetResolver } = await import(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs"));
    diag("import-ok", { hasFaceLandmarker: !!FaceLandmarker });

    diag("fileset-start");
    const fileset = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm");
    diag("fileset-ok");

    diag("model-start", { delegate: DELEGATE });
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: DELEGATE,
      },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: true,               // the 52 ARKit-named coefficients
      outputFacialTransformationMatrixes: true,  // 4x4 head pose
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    diag("model-ok");
    self.postMessage({ ok: true, ready: true });
  } catch (e) {
    const msg = errDetail(e);
    diag("init-fail", { msg, delegateTried: DELEGATE });
    self.postMessage({ ok: false, err: "init(" + DELEGATE + "): " + msg.slice(0, 400) });
  }
})();

let ts = 0, firstFrame = true, firstResult = true;
self.onmessage = async (ev) => {
  const d = ev.data || {};
  const frame = d.bitmap || d.img;   // ImageBitmap (canvas) or ImageData
  if (!frame) return;
  if (firstFrame) { firstFrame = false; diag("first-frame-received", { frames: d.frames }); }
  await ready;
  if (!landmarker) { try { frame.close && frame.close(); } catch (e) {} return; }
  try {
    // detectForVideo needs a strictly increasing timestamp; we own the
    // clock here since frames arrive serialized (one-in-flight guard).
    ts += 1;
    const res = landmarker.detectForVideo(frame, ts);
    const face = res.faceLandmarks && res.faceLandmarks[0];
    if (!face || !face.length) {
      self.postMessage({ ok: true, lm: null, blend: null, pose: null, frames: d.frames });
      return;
    }
    if (firstResult) {
      firstResult = false;
      diag("first-result", { pts: face.length, hasBlend: !!(res.faceBlendshapes && res.faceBlendshapes[0]) });
    }
    const lm = new Float32Array(face.length * 3);
    for (let i = 0; i < face.length; i++) {
      lm[i * 3] = face[i].x;
      lm[i * 3 + 1] = face[i].y;
      lm[i * 3 + 2] = face[i].z || 0;
    }
    let blend = null;
    const bs = res.faceBlendshapes && res.faceBlendshapes[0];
    if (bs && bs.categories) {
      blend = bs.categories
        .map(c => ({ name: c.categoryName || c.displayName || "?", score: c.score }))
        .filter(c => c.name !== "_neutral");
    }
    let pose = null;
    const mtx = res.facialTransformationMatrixes && res.facialTransformationMatrixes[0];
    if (mtx && mtx.data) pose = new Float32Array(mtx.data);
    self.postMessage({ ok: true, lm, blend, pose, frames: d.frames }, [lm.buffer]);
  } catch (e) {
    diag("inference-error", { msg: String((e && e.message) || e).slice(0, 400) });
    self.postMessage({ ok: true, lm: null, blend: null, pose: null,
      warn: String((e && e.message) || e), frames: d.frames });
  } finally {
    try { frame.close && frame.close(); } catch (e) {}
  }
};
