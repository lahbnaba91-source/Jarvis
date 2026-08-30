import SwiftUI
import HandTracker

/// Proves the pieces actually link and initialize together: the
/// HandTracker package's `HandTrackerPipeline` wired to a real
/// `MediaPipeHandDetector`. Deliberately does NOT call `pipeline.start()`
/// on appear -- that would trigger a real camera-permission prompt the
/// instant CI launches this for testing, which has no one there to answer
/// it and would just hang the run. Wire a real Start button + camera
/// preview layer here when this becomes an actual product surface instead
/// of a build/integration harness.
struct ContentView: View {
    @State private var initError: String?

    var body: some View {
        VStack(spacing: 12) {
            Text("HandTracker")
                .font(.title)
            Text(initError ?? "pipeline not started (see this file's comment)")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
        .onAppear(perform: verifyPipelineInitializes)
    }

    /// Constructs the real pipeline (detector + capture controller) purely
    /// to confirm the MediaPipeTasksVision integration and the bundled
    /// model asset actually resolve at runtime -- does not start capture.
    private func verifyPipelineInitializes() {
        do {
            let detector = try MediaPipeHandDetector()
            _ = HandTrackerPipeline(detector: detector)
            initError = nil
        } catch {
            initError = "pipeline init failed: \(error)"
        }
    }
}

#Preview {
    ContentView()
}
