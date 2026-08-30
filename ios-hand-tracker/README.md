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

This was written in a Linux GitHub Codespace with no Swift toolchain, no
Xcode, no iOS simulator — none of that can exist on Linux at all. Every
file started as a best-effort guess against documentation, verified for
real only once pushed to `.github/workflows/ios-build.yml`'s macOS runner
(a real cloud Mac). It took **ten CI runs** to get a clean build, each one
surfacing one real, previously-unknown problem — a genuine record of what
"never compiled before" actually costs, not a smooth story:

1. `Package.swift` had no macOS platform minimum → `swift test` (which runs
   on the host Mac, not iOS) choked on AVFoundation APIs needing macOS
   10.15+. Fixed: added `.macOS(.v13)`.
2. CI's simulator target (`iPhone 16 Pro Max`) didn't exist on the runner's
   current Xcode — device catalog had moved to the iPhone 17 line.
3. The test target had no `Info.plist` and nothing generating one → code
   signing refused to proceed.
4. `HandLandmarker.detectForVideo(...)` was a guessed method name — the
   real one, confirmed by dumping the actual resolved framework's headers
   in CI rather than guessing again, is
   `detect(videoFrame:timestampInMilliseconds:)`.
5. The test target couldn't resolve the `MediaPipeTasksVision` module at
   compile time — the Podfile only wired it into the app target.
6. Fixing #5 with CocoaPods' `inherit! :search_paths` compiled fine but
   then **crashed at runtime**: `"Function with name FlowLimiterCalculator
   already registered"` — MediaPipe's native C++ calculator registry
   aborted because its code got embedded in both the app binary and the
   test bundle separately, and got loaded twice into one process.
7. Tried the other standard fix (`TEST_HOST`/`BUNDLE_LOADER` to make Xcode
   treat it as a genuinely hosted test) — same crash persisted, because
   CocoaPods still generated its own embed phase for the test target
   regardless.
8. Removing the Podfile entry entirely to stop the double-embed brought
   back failure #5 (module unresolvable at compile time again).

\#6–8 are a real structural conflict, not a fixable config mistake: Swift
needs the framework linked to compile `@testable import`, but MediaPipe's
global C++ registry can't survive being loaded twice in one process. The
actual resolution: **stop running a hosted XCTest bundle against
MediaPipe-linked code at all.** `HandTrackerAppTests` was removed; CI now
**builds** (not tests) the app target — that still proves the expensive,
valuable thing (CocoaPods + XcodeGen + the real `MediaPipeHandDetector.swift`
compiling and linking against the actual resolved SDK) without running
inside a process that can't survive it. The plain `HandTracker` package's
own tests (`swift test`, zero MediaPipe dependency) are the real automated
test coverage.

Still not verified by any of this: `CaptureSessionController` and
`FramePreprocessor` actually working against a live camera feed on a real
device — a build passing proves it compiles and links, not that it tracks
a hand correctly. That needs an actual iPhone.

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
  spec that generates `HandTrackerApp.xcodeproj`: one app target (`App/`)
  that depends on this package locally. Checked in instead of a
  hand-written `.xcodeproj` — those are UUID-riddled and there was no way
  to hand-verify one here; XcodeGen's output gets validated by the real
  Xcode toolchain on the CI runner instead. No test target — see
  Verification status above for why.
- **`Podfile`** — `pod 'MediaPipeTasksVision'` targeting that generated
  app target, nothing else. `xcodegen generate` must run **before**
  `pod install` every time — regenerating the `.xcodeproj` afterward wipes
  CocoaPods' integration into it (see the CI workflow for the correct
  order).
- **`App/MediaPipeHandDetector.swift`** — the real
  `HandLandmarkDetecting` adapter: initializes MediaPipe's `HandLandmarker`
  in `.video` running mode (matching barehands' own `runningMode: "VIDEO"`
  choice), converts each `CVPixelBuffer` to an `MPImage`, calls
  `detect(videoFrame:timestampInMilliseconds:)` (the real method name,
  confirmed against the actual resolved SDK's headers — not the
  `detectForVideo` name an earlier version of this file guessed), and maps
  the result into `HandTracker`'s own types — including the same
  handedness-flip fix already proven in `stage.html` (MediaPipe's label is
  computed against the unmirrored camera image).
- **`App/HandTrackerAppApp.swift` / `ContentView.swift`** — the minimum
  SwiftUI shell needed for CocoaPods to have a real app to attach to and
  for CI to have something to build. Deliberately does not call
  `pipeline.start()` automatically (that would trigger a real
  camera-permission prompt the moment the app launches, with no one there
  to answer) — it only constructs the detector and pipeline, to prove the
  whole dependency chain actually links.

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
