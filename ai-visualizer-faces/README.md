# ai-visualizer-faces

Custom faces for [jaredrhod/ai-visualizer](https://github.com/jaredrhod/ai-visualizer), kept here
because the vendored `ai-visualizer/` folder itself is gitignored (see `.gitignore`: "not our
code, updated via its own update.sh") — anything first-party we add to it needs to live outside
that path or it silently never gets tracked.

## Install

Copy a face's folder into your local `ai-visualizer/faces/` (e.g. `/workspaces/Jarvis/ai-visualizer/faces/`)
and restart the server. `server.py` auto-discovers any folder under `faces/` with an `index.html`
— no core.js or server.py changes needed, no registration step.

## Faces

- **puppet** — "Shadow Puppet." Live webcam face-tracking (MediaPipe FaceLandmarker) drives a
  real off-axis/head-coupled projection matrix on the three.js camera, so the scene parallaxes as
  you move. MediaPipe ImageSegmenter gives a feathered live cutout of you, rendered as a
  shadow-casting plane inside a plain gray box room, lit by a spotlight whose color/behavior rides
  the same idle/listening/thinking/speaking/alert bus every other face uses. Falls back to a
  procedural phantom silhouette with no camera or in demo mode. Built and syntax-checked in a
  cloud sandbox with no browser/GPU/webcam available — verify it renders correctly once dropped
  into a real local ai-visualizer checkout.
