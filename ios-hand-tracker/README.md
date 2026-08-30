# HandTracker (ios-hand-tracker)

A Swift package scaffold for the native iOS hand-tracking pipeline discussed
alongside barehands (`../barehands/`, this project's web-based, MediaPipe
Tasks Vision-in-Chrome hand tracker). Three pieces, each in its own file
under `Sources/HandTracker/`:

- **`CaptureSessionController`** — `AVCaptureSession` + its
  `AVCaptureVideoDataOutputSampleBufferDelegate`. 32BGRA output (hardware
  color conversion, no software step), Metal-compatible pixel buffers, a
  capped 720p preset, and a locked frame-rate target (60fps default).
- **`FramePreprocessor`** — Core Image, on a Metal-backed `CIContext`: a
  real `CINoiseReduction` pass, then a CLAHE-*style* local-contrast boost
  (see the honest caveat in that file's header — Core Image has no literal
  CLAHE filter; this is an unsharp-mask-style approximation built from
  `CIGaussianBlur` + `CIBlendKernel.subtract` + `CIAdditionCompositing`,
  all real stock Apple filters).
- **`LandmarkSmoothing`** (`OneEuroFilter` + `HandLandmarkSmoother`) — a
  direct, verbatim port of `barehands/stage.html`'s `oneEuro()` and
  `smoothLandmarks()`, including the 2026-08-25 adaptive-lead fix and the
  per-landmark occlusion-hold logic (`LM_JUMP_CEIL`/`LM_STUCK_MAX` in the
  JS, `jumpCeiling`/`stuckMax` here). Same constants, not re-tuned — if this
  ever needs retuning, retune both trackers together or they'll feel
  different to the same person.

`HandTrackerPipeline` wires all three together plus a detector you supply.
`App/MediaPipeHandDetector.swift` is that real detector — see below.

## Verification status — read this before trusting any of it

**None of this has ever been compiled.** It was written in a Linux GitHub
Codespace with no Swift toolchain, no Xcode, and no iOS simulator — none of
that can exist on Linux at all, under any configuration. There was no way
to run `swift build`, `xcodegen generate`, `pod install`, or `xcodebuild`,
or even a syntax check against real Apple/MediaPipe SDK headers, before
handing this over. Treat every file as a first draft: plausible, grounded
against real, current documentation and sample code where it mattered most
(see `App/MediaPipeHandDetector.swift`'s header for the exact sources), but
**unverified**.

`.github/workflows/ios-build.yml` is the actual verification path — a
macOS GitHub Actions runner (a real cloud Mac) that runs the whole chain:
`swift test` on the plain package, then `xcodegen generate` → download the
MediaPipe model → `pod install` → `xcodebuild test` on the app. It has
itself never run yet. The most likely first failures, roughly in the order
they'd surface:

1. Whatever the compiler objects to in the plain `HandTracker` package
   itself (`swift test` step) — the smallest, most isolated thing to fix
   first, no CocoaPods/XcodeGen involved.
2. XcodeGen's `project.yml` producing something that doesn't quite match
   what's expected (target settings, Info.plist keys).
3. `MediaPipeHandDetector.swift`'s exact API usage against whatever
   MediaPipeTasksVision version CocoaPods actually resolves — property or
   method names drifting is far more likely than a logic bug.
4. `CaptureSessionController`/`FramePreprocessor` need a real device (or at
   least a simulator with a working fake camera) to exercise for real —
   camera behavior in the iOS Simulator is limited, and none of this was
   observed running against an actual frame.

## Why there's no MediaPipe dependency in `Package.swift`

Google has **no official Swift Package Manager distribution** for
MediaPipeTasksVision as of this writing — see the still-open
[google-ai-edge/mediapipe#5464](https://github.com/google-ai-edge/mediapipe/issues/5464)
and [#6167](https://github.com/google-ai-edge/mediapipe/issues/6167).
Official distribution is CocoaPods only. A community wrapper,
[SwiftTasksVision](https://github.com/paescebu/SwiftTasksVision), exists,
but it ships unsafe build flags, which Swift Package Manager refuses to
resolve transitively from another package's `Package.swift` — it can only
be added directly in Xcode's own package UI, not scripted here.

So `HandTracker` itself (this package) deliberately has **zero third-party
dependencies** and compiles as pure Swift + Apple frameworks standalone —
`HandLandmarkTypes.swift` defines `HandLandmarkDetecting`, the seam a real
detector plugs into. The real detector lives one layer out, in a
CocoaPods-integrated Xcode project this repo also carries:

- **`project.yml`** — an [XcodeGen](https://github.com/yonaskolb/XcodeGen)
  spec that generates `HandTrackerApp.xcodeproj`: an app target
  (`App/`) that depends on this package locally, plus a test target
  (`AppTests/`). Checked in instead of a hand-written `.xcodeproj` — those
  are UUID-riddled and there was no way to hand-verify one here; XcodeGen's
  output gets validated by the real Xcode toolchain on the CI runner
  instead.
- **`Podfile`** — `pod 'MediaPipeTasksVision'` targeting that generated
  app target. `xcodegen generate` must run **before** `pod install` every
  time — regenerating the `.xcodeproj` afterward wipes CocoaPods'
  integration into it (see the CI workflow for the correct order).
- **`App/MediaPipeHandDetector.swift`** — the real
  `HandLandmarkDetecting` adapter: initializes MediaPipe's `HandLandmarker`
  in `.video` running mode (matching barehands' own `runningMode: "VIDEO"`
  choice, for a synchronous `detectForVideo` call rather than
  `.liveStream`'s delegate-callback API), converts each `CVPixelBuffer` to
  an `MPImage`, and maps the result into `HandTracker`'s own types —
  including the same handedness-flip fix already proven in `stage.html`
  (MediaPipe's label is computed against the unmirrored camera image).
- **`App/HandTrackerAppApp.swift` / `ContentView.swift`** — the minimum
  SwiftUI shell needed for CocoaPods to have a real app to attach to and
  for CI to have something to launch and test. Deliberately does not call
  `pipeline.start()` automatically (that would trigger a real
  camera-permission prompt the moment a CI run launches it, with no one
  there to answer, and just hang) — it only constructs the detector and
  pipeline, to prove the whole dependency chain actually links.
- **`AppTests/MediaPipeHandDetectorTests.swift`** — deliberately narrow:
  confirms the model asset bundled correctly and that `HandLandmarker`
  actually initializes through the real CocoaPods-linked SDK. Does not
  assert anything about detection *accuracy* — that needs a real device or
  a bundled reference image and is out of scope for this harness.

The model asset itself (`hand_landmarker.task`, a multi-MB binary) is
**not committed to this repo** — the CI workflow downloads it fresh each
run from the exact same URL barehands' web tracker already uses live in
production. Swapping MediaPipe for a different backend, or retuning the
capture/preprocessing/smoothing pipeline, still never has to touch anything
under `App/` except this one adapter file.

## Not built here

- No camera preview UI, no Start button wired up — `ContentView` proves the
  pieces link, nothing more. A real product surface needs an
  `AVCaptureVideoPreviewLayer` (or a Metal view fed by `FramePreprocessor`'s
  output) plus a way to actually grant and handle the camera permission.
- No luminance-gated auto brightness (barehands' web version measures scene
  luminance once a second and only boosts when it's actually dim);
  `FramePreprocessor.Settings.brightness` here is a plain manual knob —
  wire real gating logic to it if porting that behavior too.
- No accuracy testing against real footage — everything here is a
  structural/build-integration check, not a "does it track hands well"
  check. That still needs an actual device.
