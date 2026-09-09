// barehands DEV DASHBOARD — client for dev.html.
//
// Polls /dev/telemetry (pushed by stage.html?dev=1) ~11x/sec and paints:
//   - the smoothed hand skeleton on black
//   - one tuning row per tracked hand: every wrist-ratio the gesture
//     detectors gate on, drawn as a bar against its threshold, plus the
//     live "is this gesture firing right now" chips
//   - a status line (fps, delegate, smoothing cost, coast rate)
// Writes ONLY gesture thresholds, through the same /config endpoint the
// built-in settings panel uses. Never touches the board. No dependencies.

(function () {
  "use strict";

  var POLL_MS = 110;       // fetch cadence (board pushes ~11Hz)
  var PANEL_MS = 220;      // DOM panel/status refresh — slower on purpose,
                           //   reading numbers doesn't need frame rate and
                           //   DOM writes are the cost on an older phone
  var STALE_MS = 1500;     // no fresh frame for this long => "stale"
  var LOG_MS = 3000;

  // ---- skeleton drawing: a faithful port of stage.html's drawSkeleton
  // + toScreen + the lm* helpers, so this canvas reads IDENTICALLY to
  // barehands' own SKELETON overlay -- same cover-fit, same mirror flip
  // (x -> 1-x), same palm mesh, bones, dot sizes, bounding box, pinch
  // line, the r= / per-finger ratio+angle text and the Hand:Pose label.
  // Numbers/topology/colours copied verbatim from stage.html.
  var HAND_CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,4],
    [0,5],[5,6],[6,7],[7,8],
    [5,9],[9,10],[10,11],[11,12],
    [9,13],[13,14],[14,15],[15,16],
    [13,17],[17,18],[18,19],[19,20],
    [0,17]
  ];
  var PALM_TRIS = [[0,1,5],[0,5,9],[0,9,13],[0,13,17]];
  var FINGER_ORDER = ["thumb","index","middle","ring","pinky"];
  // [base, joint, dip, tip] per finger (thumb base = CMC, rest = MCP)
  var LM_FINGERS = {
    thumb:  [1,2,3,4],   index: [5,6,7,8],    middle: [9,10,11,12],
    ring:   [13,14,15,16], pinky: [17,18,19,20]
  };
  function lmD(lms,a,b){ return Math.hypot(lms[a][0]-lms[b][0], lms[a][1]-lms[b][1]); }
  function lmSpan(lms){ return lmD(lms,0,9); }
  function lmTipRatio(lms,f){ var g=LM_FINGERS[f]; return lmD(lms,g[3],0)/(lmD(lms,g[0],0)||1); }
  function lmAngleDeg(lms,a,b,c){
    var v1x=lms[a][0]-lms[b][0], v1y=lms[a][1]-lms[b][1];
    var v2x=lms[c][0]-lms[b][0], v2y=lms[c][1]-lms[b][1];
    var m1=Math.hypot(v1x,v1y), m2=Math.hypot(v2x,v2y);
    if(!m1||!m2) return 0;
    var cs=Math.max(-1,Math.min(1,(v1x*v2x+v1y*v2y)/(m1*m2)));
    return Math.acos(cs)*180/Math.PI;
  }
  function lmFingerAngle(lms,f){ var g=LM_FINGERS[f]; return lmAngleDeg(lms,g[0],g[1],g[3]); }

  // the wrist-ratio bars: which landmark pair, and the reference lines to
  // draw on each. 1.45 = the extArr extension cut every finger gate uses;
  // 1.35 / 1.15 = rockSign's own outer/inner cuts; fgc = the live
  // finger-gun curl ceiling (comes from telemetry.gestures.fingerGunCurl).
  var RATIO_ROWS = [
    { key:"idx",   label:"index  (8/5)" },
    { key:"mid",   label:"middle (12/9)" },
    { key:"ring",  label:"ring   (16/13)" },
    { key:"pinky", label:"pinky  (20/17)" },
    { key:"thumb", label:"thumb  (4/2)" }
  ];
  var RATIO_MAX = 2.5;

  var CHIPS = [
    ["pinched","pinch"],["rock","rock"],["middle","middle"],["peace","peace"],
    ["shush","shush"],["fist","fist"],["palm","palm"],["fingerGun","fingergun"],
    ["claw","claw"],["snap","snap"]
  ];

  var $ = function (id) { return document.getElementById(id); };

  var cv = $("skel"), ctx = cv.getContext("2d");
  var frozen = false, lastFrame = null, lastFrameAt = 0, everConnected = false;

  // ---- canvas sizing (retina-aware). We keep the CSS px size too and
  // draw under a DPR transform, so every pixel constant below is the
  // SAME number stage.html uses.
  var cssW = 1, cssH = 1;
  function sizeCanvas() {
    var r = cv.getBoundingClientRect();
    // cap at 2 — a 3x phone doubles fill cost for no readable gain here
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = Math.max(1, Math.round(r.width));
    cssH = Math.max(1, Math.round(r.height));
    cv.width = Math.max(1, Math.round(cssW * dpr));
    cv.height = Math.max(1, Math.round(cssH * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener("resize", function () { sizeCanvas(); paint(lastFrame); });

  // toScreen, ported: cover-fit the board's capture frame into this
  // canvas and mirror X, exactly like stage.html.
  function makeToScreen(aspect) {
    var vw = aspect || 1.7778, vh = 1;               // ratio only; scale cancels
    var scale = Math.max(cssW / vw, cssH / vh);
    var dw = vw * scale, dh = vh * scale;
    var ox = (cssW - dw) / 2, oy = (cssH - dh) / 2;
    return function (lm) { return { x: ox + (1 - lm[0]) * dw, y: oy + lm[1] * dh }; };
  }

  // ---- skeleton paint — mirrors stage.html's drawSkeleton -----------
  function paint(data) {
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    if (!data || !data.hands || !data.hands.length) {
      ctx.fillStyle = "rgba(255,255,255,0.28)";
      ctx.font = Math.round(cssH * 0.035) + "px ui-monospace,Menlo,monospace";
      ctx.textAlign = "center";
      ctx.fillText(everConnected ? "no hand in frame" : "waiting for /dev/telemetry…",
        cssW / 2, cssH / 2);
      return;
    }

    var toScreen = makeToScreen(data.aspect);

    for (var h = 0; h < data.hands.length; h++) {
      var hd = data.hands[h], lms = hd.lms;
      if (!lms || lms.length < 21) continue;
      var pinched = !!(hd.fired && hd.fired.pinched);
      var pts = lms.map(toScreen);

      // low-poly palm mesh
      ctx.beginPath();
      for (var t = 0; t < PALM_TRIS.length; t++) {
        var tr = PALM_TRIS[t];
        ctx.moveTo(pts[tr[0]].x, pts[tr[0]].y);
        ctx.lineTo(pts[tr[1]].x, pts[tr[1]].y);
        ctx.lineTo(pts[tr[2]].x, pts[tr[2]].y);
        ctx.closePath();
      }
      ctx.fillStyle = "rgba(111,229,214,0.12)";
      ctx.fill();
      ctx.strokeStyle = "rgba(143,240,228,0.5)";
      ctx.lineWidth = 1;
      ctx.stroke();

      // bones
      ctx.beginPath();
      for (var b = 0; b < HAND_CONNECTIONS.length; b++) {
        var e = HAND_CONNECTIONS[b];
        ctx.moveTo(pts[e[0]].x, pts[e[0]].y);
        ctx.lineTo(pts[e[1]].x, pts[e[1]].y);
      }
      ctx.strokeStyle = "rgba(111,229,214,0.9)";
      ctx.lineWidth = 2;
      ctx.stroke();

      // joint dots
      ctx.beginPath();
      for (var p = 0; p < pts.length; p++) {
        ctx.moveTo(pts[p].x + 3.5, pts[p].y);
        ctx.arc(pts[p].x, pts[p].y, 3.5, 0, Math.PI * 2);
      }
      ctx.fillStyle = "#eafffb";
      ctx.fill();

      // bounding box
      var xs = pts.map(function (q) { return q.x; });
      var ys = pts.map(function (q) { return q.y; });
      var minX = Math.min.apply(null, xs) - 16, maxX = Math.max.apply(null, xs) + 16;
      var minY = Math.min.apply(null, ys) - 16, maxY = Math.max.apply(null, ys) + 16;
      ctx.strokeStyle = "rgba(143,240,228,0.85)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);

      // pinch line, thumb tip -> index tip
      var tipA = pts[4], tipB = pts[8];
      ctx.strokeStyle = pinched ? "rgba(255,70,70,0.95)" : "rgba(111,229,214,0.55)";
      ctx.lineWidth = pinched ? 4 : 2;
      ctx.beginPath();
      ctx.moveTo(tipA.x, tipA.y);
      ctx.lineTo(tipB.x, tipB.y);
      ctx.stroke();

      // ---- text readout (always on here — this is the tuning view).
      // barehands draws this at 11-13px on a full screen where a hand is
      // big; in this small canvas that reads huge and the fingertip
      // labels collide. Scale every label + its offset to the hand's
      // actual on-screen size so it sits the same as in the app.
      var spanPx = Math.hypot(pts[0].x - pts[9].x, pts[0].y - pts[9].y);
      var k = Math.max(0.45, Math.min(1, spanPx / 165));
      var f11 = Math.max(8, Math.round(11 * k));
      var f12 = Math.max(8, Math.round(12 * k));
      var f13 = Math.max(9, Math.round(13 * k));
      var off = Math.max(5, 8 * k);
      var span = lmSpan(lms);
      var pinchGap = span > 0 ? lmD(lms, 4, 8) / span : 1;
      var midX = (tipA.x + tipB.x) / 2, midY = (tipA.y + tipB.y) / 2;
      ctx.font = f12 + "px 'SF Mono', Menlo, monospace";
      ctx.fillStyle = pinched ? "#ff4646" : "#8ff0e4";
      ctx.fillText("r=" + pinchGap.toFixed(2) + (pinched ? " GRABBING" : ""),
        midX + off, midY - off);

      ctx.font = f11 + "px 'SF Mono', Menlo, monospace";
      for (var f = 0; f < FINGER_ORDER.length; f++) {
        var fin = FINGER_ORDER[f];
        var ratio = lmTipRatio(lms, fin), angle = lmFingerAngle(lms, fin);
        var pt = pts[LM_FINGERS[fin][3]];
        ctx.fillStyle = ratio <= 1.35 ? "#ff4646" : "#8ff0e4";
        ctx.fillText(ratio.toFixed(2) + " " + angle.toFixed(0) + "°", pt.x + off, pt.y);
      }

      var extended = 0, EP = [[8, 6], [12, 10], [16, 14], [20, 18]];
      for (var xi = 0; xi < EP.length; xi++)
        if (lmD(lms, EP[xi][0], 0) > lmD(lms, EP[xi][1], 0)) extended++;
      var pose = (hd.fired && hd.fired.rock) ? "ROCK 🤘"
        : pinched ? "Pinch (GRAB)"
        : extended === 0 ? "Fist" : extended >= 4 ? "Open" : "Pointer";
      // MediaPipe handedness is for the UNMIRRORED image; flip to match
      var handLbl = hd.hand === "Left" ? "Right" : hd.hand === "Right" ? "Left" : "?";
      ctx.font = f13 + "px 'SF Mono', Menlo, monospace";
      ctx.fillStyle = "#8ff0e4";
      ctx.fillText(handLbl + ": " + pose, minX, minY - off);
    }
  }

  // ---- per-hand metric panel -------------------------------------
  var handsWrap = $("hands");
  var panelCache = [];   // built lazily, reused across frames

  function buildPanel(h) {
    var root = document.createElement("div");
    root.className = "hand";
    var title = document.createElement("h2");
    title.textContent = "HAND " + h;
    root.appendChild(title);

    var rows = {};
    RATIO_ROWS.forEach(function (r) {
      var m = document.createElement("div");
      m.className = "metric";
      m.innerHTML =
        '<div class="lab"><span>' + r.label + '</span><i></i></div>' +
        '<div class="track"><div class="fill"></div>' +
        '<div class="mark ext"></div>' +
        '<div class="mark soft rout"></div>' +
        '<div class="mark soft rin"></div>' +
        '<div class="mark" data-at="fgc" style="background:#8a6cff"></div></div>';
      root.appendChild(m);
      rows[r.key] = {
        val: m.querySelector("i"),
        fill: m.querySelector(".fill"),
        extMark: m.querySelector(".mark.ext"),
        routMark: m.querySelector(".mark.rout"),
        rinMark: m.querySelector(".mark.rin"),
        fgcMark: m.querySelector('[data-at="fgc"]')
      };
    });

    var pinch = document.createElement("div");
    pinch.className = "metric";
    pinch.innerHTML = '<div class="lab"><span>pinch gap / span / ratio</span><i></i></div>';
    root.appendChild(pinch);

    var chips = document.createElement("div");
    chips.className = "chips";
    var chipEls = {};
    CHIPS.forEach(function (c) {
      var el = document.createElement("span");
      el.className = "chip";
      el.textContent = c[1];
      chips.appendChild(el);
      chipEls[c[0]] = el;
    });
    root.appendChild(chips);

    handsWrap.appendChild(root);
    return { root: root, rows: rows, pinch: pinch.querySelector("i"), chips: chipEls };
  }

  function updatePanels(data, gestures) {
    var hands = (data && data.hands) || [];
    var g = gestures || {};
    var fgc = +g.fingerGunCurl || 0.92;
    var extCut = +g.extendCut || 1.45;      // live cut — bars mark THIS now
    var rOut = +g.rockOutCut || 1.35;
    var rIn = +g.rockInCut || 1.15;
    var pct = function (x) { return (x / RATIO_MAX * 100) + "%"; };

    for (var h = 0; h < hands.length; h++) {
      if (!panelCache[h]) panelCache[h] = buildPanel(h);
      var p = panelCache[h], hd = hands[h];
      p.root.style.display = "";

      RATIO_ROWS.forEach(function (r) {
        var v = hd.wr && typeof hd.wr[r.key] === "number" ? hd.wr[r.key] : 0;
        var ext = v > extCut;
        var row = p.rows[r.key];
        row.val.textContent = v.toFixed(3);
        row.val.className = ext ? "hit" : "";
        row.fill.style.width = Math.max(0, Math.min(1, v / RATIO_MAX)) * 100 + "%";
        row.fill.className = ext ? "fill hit" : "fill";
        row.extMark.style.left = pct(extCut);
        row.routMark.style.left = pct(rOut);
        row.rinMark.style.left = pct(rIn);
        row.fgcMark.style.left = pct(fgc);
      });

      var ratio = hd.span > 0 ? (hd.gap / hd.span) : 0;
      p.pinch.textContent =
        (hd.gap != null ? hd.gap.toFixed(4) : "–") + "  /  " +
        (hd.span != null ? hd.span.toFixed(4) : "–") + "  /  " +
        ratio.toFixed(3) + (hd.fired && hd.fired.pinched ? "   ● GRAB" : "");
      p.pinch.className = hd.fired && hd.fired.pinched ? "hit" : "";

      CHIPS.forEach(function (c) {
        var on = hd.fired && hd.fired[c[0]];
        p.chips[c[0]].className = on ? "chip on" : "chip";
      });
    }
    for (var k = hands.length; k < panelCache.length; k++) {
      if (panelCache[k]) panelCache[k].root.style.display = "none";
    }
  }

  // ---- status bar -------------------------------------------------
  function updateStatus(data, live) {
    var dot = $("conndot"), conn = $("conn");
    if (!everConnected && !data) {
      dot.className = "dot";
      conn.textContent = armed ? "connecting… (board open?)" : "tap Connect to board";
    }
    else if (!live) { dot.className = "dot off"; conn.textContent = "OFFLINE"; }
    else if (Date.now() - lastFrameAt > STALE_MS) { dot.className = "dot stale"; conn.textContent = "STALE"; }
    else { dot.className = "dot live"; conn.textContent = "LIVE"; }

    if (!data) return;
    $("fps").textContent = data.fps != null ? data.fps : "–";
    $("delegate").textContent = data.delegate || "–";
    $("smooth").textContent =
      (data.smoothP50 != null ? data.smoothP50 : "–") + " / " +
      (data.smoothP99 != null ? data.smoothP99 : "–");
    $("coast").textContent = data.coastRate != null ? data.coastRate : "–";
    $("nhands").textContent = (data.hands && data.hands.length) || 0;
  }

  // ---- tuning controls -----------------------------------------
  var f2 = function (v) { return (+v).toFixed(2); };
  var RANGE_MAP = {
    extendCut:         { el:"t_ext",   out:"o_ext",   fmt:f2, int:false },
    rockOutCut:        { el:"t_rout",  out:"o_rout",  fmt:f2, int:false },
    rockInCut:         { el:"t_rin",   out:"o_rin",   fmt:f2, int:false },
    fingerGunCurl:     { el:"t_fgc",   out:"o_fgc",   fmt:f2, int:false },
    rotateLatchMs:     { el:"t_latch", out:"o_latch", fmt:function (v) { return (v | 0) + "ms"; }, int:true },
    rotateDragCancelPx:{ el:"t_drag",  out:"o_drag",  fmt:function (v) { return (v | 0) + "px"; }, int:true }
  };
  var CHECK_MAP = { rockOn:"t_rock", fingerGun:"t_fg", peaceSign:"t_peace",
                    shush:"t_shush", pileDeck:"t_pile" };
  // shipped defaults — must match server.py's DEFAULT_GESTURES
  var DEFAULTS = {
    extendCut:1.45, rockOutCut:1.35, rockInCut:1.15, fingerGunCurl:0.92,
    rotateLatchMs:2000, rotateDragCancelPx:800,
    rockOn:true, fingerGun:true, peaceSign:true, shush:true, pileDeck:true
  };
  var dirtyUntil = {};        // key -> ts; ignore inbound value while user-owned
  var writeTimer = null, pendingPatch = {};

  function syncControls(g) {
    if (!g) return;
    var now = Date.now();
    Object.keys(RANGE_MAP).forEach(function (key) {
      if ((dirtyUntil[key] || 0) > now) return;
      var m = RANGE_MAP[key], el = $(m.el);
      if (el && g[key] != null && document.activeElement !== el) {
        el.value = g[key];
        $(m.out).textContent = m.fmt(g[key]);
      }
    });
    Object.keys(CHECK_MAP).forEach(function (key) {
      if ((dirtyUntil[key] || 0) > now) return;
      var el = $(CHECK_MAP[key]);
      if (el && g[key] != null) el.checked = !!g[key];
    });
  }

  function queueWrite(key, value) {
    dirtyUntil[key] = Date.now() + 2500;
    pendingPatch[key] = value;
    var note = $("savenote");
    note.className = "save-note";
    note.textContent = "saving " + key + "…";
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(flushWrite, 260);
  }

  function flushWrite() {
    var patch = pendingPatch; pendingPatch = {};
    fetch("/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gestures: patch })
    }).then(function (r) { return r.json(); }).then(function (j) {
      var note = $("savenote");
      if (j && j.ok) {
        note.className = "save-note ok";
        note.textContent = "saved: " + Object.keys(patch).join(", ") +
          "  (board picks it up within ~1s)";
      } else {
        note.className = "save-note err";
        note.textContent = "rejected: " + JSON.stringify(j);
      }
    }).catch(function (e) {
      var note = $("savenote");
      note.className = "save-note err";
      note.textContent = "write failed: " + e;
    });
  }

  Object.keys(RANGE_MAP).forEach(function (key) {
    var m = RANGE_MAP[key], el = $(m.el);
    if (!el) return;
    el.addEventListener("input", function () {
      $(m.out).textContent = m.fmt(el.value);
      queueWrite(key, m.int ? (el.value | 0) : +el.value);
    });
  });
  Object.keys(CHECK_MAP).forEach(function (key) {
    var el = $(CHECK_MAP[key]);
    if (!el) return;
    el.addEventListener("change", function () { queueWrite(key, el.checked); });
  });

  var resetBtn = $("t_reset");
  if (resetBtn) resetBtn.addEventListener("click", function () {
    Object.keys(DEFAULTS).forEach(function (key) { queueWrite(key, DEFAULTS[key]); });
    // reflect immediately; syncControls would too once the write lands
    Object.keys(RANGE_MAP).forEach(function (key) {
      var m = RANGE_MAP[key], el = $(m.el);
      if (el && DEFAULTS[key] != null) { el.value = DEFAULTS[key]; $(m.out).textContent = m.fmt(DEFAULTS[key]); }
    });
    Object.keys(CHECK_MAP).forEach(function (key) {
      var el = $(CHECK_MAP[key]);
      if (el && DEFAULTS[key] != null) el.checked = !!DEFAULTS[key];
    });
  });

  // ---- calibration: guided pose capture, driven from THIS device -------
  // 2026-09-09 CALIBRATE rework (Luis's call 2026-08-30 feedback: the old
  // on-phone wizard was confusing, one hand holds the phone while the
  // other has to gesture AND read instructions off the same screen).
  // Same 5-pose x 3-rep sequence stage.html's on-phone wizard uses (kept
  // byte-identical so both paths tag takes the same `calibration:<pose>`
  // way), but every step's name/instructions/progress live HERE while
  // the board just shows a glance-able toast per capture (see stage.html's
  // pollDevArm). Each rep fires one POST /dev/capture with that pose's
  // label; the board picks it up on its next /dev/arm poll (<=2.5s) and
  // runs the same runImageCapture() a manual RECORD press uses.
  var CAL_STEPS = [
    { label: "pinch", title: "Pinch grab", instr: "Touch your thumb and index fingertip together, like picking something up." },
    { label: "claw-charge", title: "Force-pull charge", instr: "Point thumb and index finger straight out like a finger gun, other three fingers curled in." },
    { label: "finger-gun", title: "Finger gun", instr: "Same finger-gun shape, but curl the other three fingers into a tight fist this time." },
    { label: "peace-sign", title: "Peace sign", instr: "Hold up your index and middle finger in a V, the other fingers curled down." },
    { label: "rock-on", title: "Rock on", instr: "Extend your index finger and pinky, curl your middle and ring finger in." },
  ];
  var CAL_REPS = 3;
  // no completion event exists on the wire -- /dev/capture is fire-and-
  // forget, same as the gesture lab's plain "Capture 3s" button below,
  // which already assumes success after a fixed wait. Matches
  // runImageCapture's real timing (3s ready countdown + 2s hold + save)
  // with margin, same 6500ms that button already uses.
  var CAL_WAIT_MS = 6500;
  var calStepI = 0, calRepI = 0, calCount = 0, calBusy = false;

  function calButtons(disabled) {
    ["calCaptureBtn", "calRedoBtn", "calSkipBtn", "calStopBtn"].forEach(function (id) {
      var el = $(id);
      if (el) el.disabled = disabled;
    });
  }

  function calLabelFor(i) { return "calibration:" + CAL_STEPS[i].label; }

  function calRenderStep() {
    var step = CAL_STEPS[calStepI];
    $("calProg").textContent = "POSE " + (calStepI + 1) + "/" + CAL_STEPS.length +
      " — rep " + (calRepI + 1) + "/" + CAL_REPS;
    $("calPoseTitle").textContent = step.title;
    $("calPoseInstr").textContent = step.instr;
    $("calMsg").className = "save-note"; $("calMsg").textContent = "";
  }

  function calCapture() {
    if (calBusy || calStepI >= CAL_STEPS.length) return;
    calBusy = true;
    calButtons(true);
    var msg = $("calMsg");
    msg.className = "save-note"; msg.textContent = "board capturing… hold the pose";
    fetch("/dev/capture", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: calLabelFor(calStepI) }),
    }).then(function () {
      setTimeout(function () {
        msg.className = "save-note ok"; msg.textContent = "captured";
        calCount++;
        calBusy = false;
        calButtons(false);
        refreshTakes();
        calAdvance();
      }, CAL_WAIT_MS);
    }).catch(function () {
      msg.className = "save-note err"; msg.textContent = "capture request failed — is the board open?";
      calBusy = false;
      calButtons(false);
    });
  }

  function calAdvance() {
    calRepI++;
    if (calRepI >= CAL_REPS) { calRepI = 0; calStepI++; }
    if (calStepI >= CAL_STEPS.length) { calFinish(); return; }
    calRenderStep();
    if ($("calAuto").checked) calCapture();
  }

  function calRedo() {
    if (calBusy) return;
    if (calRepI > 0) calRepI--;
    else if (calStepI > 0) { calStepI--; calRepI = CAL_REPS - 1; }
    calRenderStep();
  }

  function calSkipPose() {
    if (calBusy) return;
    calStepI++; calRepI = 0;
    if (calStepI >= CAL_STEPS.length) { calFinish(); return; }
    calRenderStep();
  }

  function calStop() {
    if (calBusy) return;
    $("calRun").hidden = true;
    $("calIntro").hidden = false;
  }

  function calFinish() {
    $("calRun").hidden = true;
    $("calDone").hidden = false;
    $("calCount").textContent = calCount;
  }

  function calStart() {
    calStepI = 0; calRepI = 0; calCount = 0;
    $("calIntro").hidden = true; $("calDone").hidden = true; $("calRun").hidden = false;
    calRenderStep();
    calCapture();
  }

  (function calWire() {
    if (!$("calbox")) return;
    $("calStartBtn").addEventListener("click", calStart);
    $("calRestartBtn").addEventListener("click", calStart);
    $("calCaptureBtn").addEventListener("click", calCapture);
    $("calRedoBtn").addEventListener("click", calRedo);
    $("calSkipBtn").addEventListener("click", calSkipPose);
    $("calStopBtn").addEventListener("click", calStop);
  })();

  // ---- gesture lab: saved-take playback + live fire re-evaluation ------
  // Loads recorded takes (state/gesture_log.jsonl via /dev/gestures), plays
  // them on the skeleton canvas, and re-runs gestures.js's pose detectors
  // against every frame at the CURRENT slider thresholds — so you see which
  // frames of a real recorded pose would fire, and watch that shift as you
  // drag the cuts. Needs gestures.js loaded (a <script> in dev.html): it
  // hangs the detectors off window.
  var POSE_FNS = ["rockSign", "middleUpSign", "peaceSign", "shushSign",
    "fistSign", "openPalmSign", "clawPose", "snapPose", "fingerGunSign"];
  var POSE_SHORT = { rockSign: "rock", middleUpSign: "middle", peaceSign: "peace",
    shushSign: "shush", fistSign: "fist", openPalmSign: "palm", clawPose: "claw",
    snapPose: "snap", fingerGunSign: "gun" };
  var HAVE_G = typeof window.rockSign === "function" &&
    typeof window.configureThresh === "function";

  var lab = null;            // { id, kind, label, frames:[[hand:[[x,y,z]*21],...],...] }
  var labI = 0, labPlaying = false, labActive = false, labFrame = null, labTimer = null;

  function curThreshCfg() {
    return {
      extendCut: +($("t_ext").value) || DEFAULTS.extendCut,
      rockOutCut: +($("t_rout").value) || DEFAULTS.rockOutCut,
      rockInCut: +($("t_rin").value) || DEFAULTS.rockInCut,
    };
  }

  // pose detectors for ONE hand — array landmarks in, {x,y,z} objects the
  // gestures.js formulas want.
  function firesFor(handLms) {
    if (!HAVE_G || !handLms || handLms.length < 21) return [];
    var o = handLms.map(function (p) { return { x: p[0], y: p[1], z: p[2] || 0 }; });
    var hit = [];
    for (var i = 0; i < POSE_FNS.length; i++) {
      try { if (window[POSE_FNS[i]](o)) hit.push(POSE_SHORT[POSE_FNS[i]]); } catch (e) {}
    }
    return hit;
  }

  function frameFires(hands) {
    var s = {};
    (hands || []).forEach(function (hl) { firesFor(hl).forEach(function (n) { s[n] = 1; }); });
    return Object.keys(s);
  }

  function drawFireStrip() {
    var box = $("firestrip");
    if (!box) return;
    if (!lab) { box.innerHTML = ""; return; }
    if (HAVE_G) window.configureThresh(curThreshCfg());
    var per = lab.frames.map(frameFires);
    var names = {};
    per.forEach(function (fs) { fs.forEach(function (n) { names[n] = 1; }); });
    var rows = Object.keys(names).sort();
    if (!rows.length) { box.innerHTML = '<p class="muted">nothing fires on any frame at these cuts</p>'; return; }
    box.innerHTML = rows.map(function (name) {
      var cells = per.map(function (fs, i) {
        return '<i class="' + (fs.indexOf(name) >= 0 ? "on" : "") +
          (i === labI ? " cur" : "") + '"></i>';
      }).join("");
      return '<div class="frow"><b>' + name + '</b><div class="ftrack">' + cells + "</div></div>";
    }).join("");
  }

  function setLabFrame(i) {
    if (!lab) return;
    labI = Math.max(0, Math.min(lab.frames.length - 1, i | 0));
    var hands = lab.frames[labI] || [];
    labFrame = {
      aspect: 4 / 3,
      hands: hands.map(function (lms) { return { lms: lms, fired: { pinched: 0 }, hand: null }; }),
    };
    if (HAVE_G) window.configureThresh(curThreshCfg());
    var fires = frameFires(hands);
    $("playframe").textContent = (labI + 1) + " / " + lab.frames.length +
      (fires.length ? "  ·  " + fires.join(", ") : "  ·  —");
    var scrub = $("playscrub");
    if (+scrub.value !== labI) scrub.value = labI;
    drawFireStrip();
  }

  function labStep() {
    if (!lab || !labPlaying) return;
    setLabFrame((labI + 1) % lab.frames.length);
    labTimer = setTimeout(labStep, lab.frames.length > 3 ? 100 : 750);
  }

  function labPlay(on) {
    labPlaying = on && lab && lab.frames.length > 1;
    $("playpause").textContent = labPlaying ? "❚❚" : "▶";
    if (labTimer) { clearTimeout(labTimer); labTimer = null; }
    if (labPlaying) labStep();
  }

  function closeLab() {
    labActive = false; lab = null; labPlaying = false;
    if (labTimer) { clearTimeout(labTimer); labTimer = null; }
    $("player").hidden = true;
  }

  function openTake(id) {
    fetch("/dev/gestures/" + id, { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.frames || !j.frames.length) return;
        lab = j; labActive = true; labI = 0;
        $("player").hidden = false;
        $("playttl").textContent = "take #" + j.id + (j.kind ? " · " + j.kind : "");
        $("playlabel").value = j.label || "";
        $("playscrub").max = Math.max(0, j.frames.length - 1);
        setLabFrame(0);
        labPlay(true);
      });
  }

  function refreshTakes() {
    fetch("/dev/gestures", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var takes = (j && j.takes) || [];
        var ul = $("takelist");
        if (!takes.length) {
          ul.innerHTML = '<li class="muted">no takes yet — open the board and hit Capture 3&nbsp;s</li>';
          return;
        }
        ul.innerHTML = takes.map(function (t) {
          var when = t.ts ? new Date(t.ts * 1000).toLocaleTimeString() : "?";
          return '<li data-id="' + t.id + '"><b>' + (t.label || "unlabeled") + "</b> " +
            "<span>" + t.kind + " · " + t.frames + "f · " + t.hands + "h · " + when + "</span></li>";
        }).join("");
      })
      .catch(function () {});
  }

  (function labWire() {
    if (!$("labbox")) return;
    $("takelist").addEventListener("click", function (e) {
      var li = e.target.closest && e.target.closest("li[data-id]");
      if (li) openTake(+li.getAttribute("data-id"));
    });
    $("playpause").addEventListener("click", function () { labPlay(!labPlaying); });
    $("playclose").addEventListener("click", closeLab);
    $("playscrub").addEventListener("input", function () {
      labPlay(false); setLabFrame(+this.value);
    });
    $("playlabel").addEventListener("change", function () {
      if (!lab) return;
      var v = this.value.trim();
      fetch("/dev/gestures/" + lab.id, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: v }),
      }).then(function () { lab.label = v; refreshTakes(); }).catch(function () {});
    });
    $("capbtn").addEventListener("click", function () {
      var msg = $("labmsg");
      msg.className = "save-note"; msg.textContent = "board recording… hold the pose";
      fetch("/dev/capture", { method: "POST" }).then(function () {
        setTimeout(function () {
          msg.className = "save-note ok";
          msg.textContent = "saved (if the board was open)";
          refreshTakes();
        }, 6500);
      }).catch(function () {
        msg.className = "save-note err"; msg.textContent = "capture request failed";
      });
    });
    $("mtxbtn").addEventListener("click", runMatrix);
    // keep the fire-strip honest as the thresholds move
    ["t_ext", "t_rout", "t_rin"].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener("input", function () { if (lab) setLabFrame(labI); });
    });
    $("labbox").addEventListener("toggle", function () {
      if (this.open) refreshTakes();
    });
  })();

  // ---- confusion matrix: every take x every pose at the current cuts ---
  function runMatrix() {
    var box = $("matrix");
    box.hidden = false;
    box.innerHTML = '<p class="muted">running…</p>';
    if (!HAVE_G) { box.innerHTML = '<p class="muted">gestures.js not loaded — can’t evaluate</p>'; return; }
    fetch("/dev/gestures", { cache: "no-store" }).then(function (r) { return r.json(); })
      .then(function (j) {
        var takes = (j && j.takes) || [];
        if (!takes.length) { box.innerHTML = '<p class="muted">no takes to run</p>'; return; }
        var poses = POSE_FNS.map(function (n) { return POSE_SHORT[n]; });
        var rows = new Array(takes.length);
        var pending = takes.length;
        takes.forEach(function (t, ti) {
          fetch("/dev/gestures/" + t.id, { cache: "no-store" }).then(function (r) { return r.json(); })
            .then(function (full) {
              window.configureThresh(curThreshCfg());
              var held = (full.frames && full.frames.length) || 1;
              var count = {};
              (full.frames || []).forEach(function (hands) {
                frameFires(hands).forEach(function (n) { count[n] = (count[n] || 0) + 1; });
              });
              rows[ti] = { label: t.label || ("#" + t.id), held: held, count: count };
            })
            .catch(function () { rows[ti] = { label: "#" + t.id, held: 1, count: {} }; })
            .then(function () { if (--pending === 0) paintMatrix(box, poses, rows); });
        });
      });
  }

  function paintMatrix(box, poses, rows) {
    var h = '<table class="mtx"><tr><th>take \\ pose</th>';
    poses.forEach(function (p) { h += "<th>" + p + "</th>"; });
    h += "</tr>";
    rows.forEach(function (r) {
      h += "<tr><th>" + r.label + "</th>";
      poses.forEach(function (p) {
        var pct = Math.round(100 * (r.count[p] || 0) / r.held);
        var self = r.label.toLowerCase().indexOf(p) >= 0;
        var cls = pct === 0 ? "z" : self ? "ok" : "bad";
        h += '<td class="' + cls + '">' + (pct || "") + "</td>";
      });
      h += "</tr>";
    });
    h += "</table><p class=\"muted\">% of a take’s frames that fire each pose, at the current cuts. " +
      "green = the take’s own labeled pose, red = a false fire.</p>";
    box.innerHTML = h;
  }

  // ---- freeze --------------------------------------------------
  $("freeze").addEventListener("click", function () {
    frozen = !frozen;
    this.classList.toggle("on", frozen);
    this.textContent = frozen ? "frozen" : "freeze";
  });

  // ---- live feed: Server-Sent Events. One long-lived connection the
  // server pushes each telemetry frame down — no per-frame request
  // overhead, no poll-interval quantization. Falls back to polling if
  // EventSource is missing or the stream stays dead.
  var netOk = true, es = null, usingPoll = false, esErrs = 0;

  function onFrame(data) {
    if (!data || data.t == null) return;
    everConnected = true;
    netOk = true;
    if (!lastFrame || data.t !== lastFrame.t) {
      lastFrame = data;
      lastFrameAt = Date.now();
    }
  }

  function startPoll() {
    if (usingPoll) return;
    usingPoll = true;
    (function loop() {
      fetch("/dev/telemetry", { cache: "no-store" })
        .then(function (r) { return r.json(); })
        .then(onFrame)
        .catch(function () { netOk = false; })
        .then(function () { setTimeout(loop, POLL_MS); });
    })();
  }

  function startStream() {
    if (usingPoll) return;
    if (typeof EventSource === "undefined") { startPoll(); return; }
    try { es = new EventSource("/dev/stream"); }
    catch (e) { startPoll(); return; }
    es.onmessage = function (ev) {
      esErrs = 0;
      try { onFrame(JSON.parse(ev.data)); } catch (e) {}
    };
    es.onerror = function () {
      netOk = false;
      // EventSource reconnects itself; only fall back to polling if it's
      // genuinely closed and keeps failing.
      if (es && es.readyState === 2 && ++esErrs >= 3) {
        try { es.close(); } catch (e) {}
        es = null;
        startPoll();
      }
    };
  }

  // a stream the browser thinks is fine but has gone silent (tunnel
  // hiccup) — reopen it.
  function streamWatchdog() {
    if (!usingPoll && lastFrameAt && Date.now() - lastFrameAt > 3000) {
      try { es && es.close(); } catch (e) {}
      es = null; esErrs = 0;
      startStream();
    }
    setTimeout(streamWatchdog, 2000);
  }

  // ---- render loop: interpolate the skeleton toward the latest frame,
  // so an irregular ~11Hz feed over the tunnel still moves at display
  // rate instead of stuttering. DOM panels refresh slower, off the raw
  // frame (numbers don't need to be interpolated).
  var lastRenderT = 0, lastPanelAt = 0, view = null;

  function lerpView(prev, f, k) {
    var usable = prev && prev.hands && prev.hands.length === f.hands.length;
    var out = { aspect: f.aspect, hands: [] };
    for (var h = 0; h < f.hands.length; h++) {
      var src = f.hands[h], pv = usable ? prev.hands[h] : null, lms = [];
      for (var i = 0; i < src.lms.length; i++) {
        var s = src.lms[i];
        if (pv && pv.lms[i]) {
          var p = pv.lms[i];
          lms.push([p[0] + (s[0] - p[0]) * k,
                    p[1] + (s[1] - p[1]) * k,
                    p[2] + (s[2] - p[2]) * k]);
        } else {
          lms.push([s[0], s[1], s[2]]);
        }
      }
      out.hands.push({ lms: lms, fired: src.fired, hand: src.hand });
    }
    return out;
  }

  function render() {
    requestAnimationFrame(render);
    var now = performance.now();
    var dt = lastRenderT ? Math.min(now - lastRenderT, 100) : 16;
    lastRenderT = now;
    var f = lastFrame;
    if (!frozen) {
      if (labActive) {
        // a saved take owns the canvas — no interpolation, it's stepped
        view = null;
        paint(labFrame);
      } else if (f && f.hands && f.hands.length) {
        view = lerpView(view, f, 1 - Math.exp(-dt / 55));
        paint(view);
      } else {
        view = null;
        paint(f);
      }
    }
    var ms = Date.now();
    if (ms - lastPanelAt >= PANEL_MS) {
      lastPanelAt = ms;
      updatePanels(f, f && f.gestures);
      syncControls(f && f.gestures);
      updateStatus(f, netOk);
    }
  }

  // ---- log tail --------------------------------------------
  function pollLog() {
    if (!$("logbox").open) { setTimeout(pollLog, LOG_MS); return; }
    fetch("/dev/log?n=200", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var pre = $("log");
        var atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
        pre.textContent = (j.lines || []).join("\n");
        if (atBottom) pre.scrollTop = pre.scrollHeight;
      })
      .catch(function () {})
      .then(function () { setTimeout(pollLog, LOG_MS); });
  }

  // ---- board arm: the "Connect to board" button. This page can't reach
  // into the board's stage.html, so instead it POSTs /dev/arm as a ~3s
  // heartbeat; stage.html polls that and starts emitting telemetry with no
  // reload. Auto-armed on load so it just connects — the button toggles it.
  var armed = false, armBeat = null;

  function pushArm(on) {
    return fetch("/dev/arm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ on: on }),
      keepalive: true,
    }).catch(function () {});
  }

  function setArmed(on) {
    armed = on;
    var btn = $("connbtn");
    if (btn) {
      btn.textContent = on ? "Disconnect" : "Connect to board";
      btn.className = on ? "on" : "";
    }
    if (armBeat) { clearInterval(armBeat); armBeat = null; }
    if (on) {
      pushArm(true);
      armBeat = setInterval(function () { pushArm(true); }, 3000);
    } else {
      pushArm(false);
    }
  }

  (function () {
    var b = $("connbtn");
    if (b) b.addEventListener("click", function () { setArmed(!armed); });
    window.addEventListener("pagehide", function () { if (armed) pushArm(false); });
  })();

  sizeCanvas();
  paint(null);
  setArmed(true);
  updateStatus(null, true);
  startStream();
  streamWatchdog();
  render();
  pollLog();
})();
