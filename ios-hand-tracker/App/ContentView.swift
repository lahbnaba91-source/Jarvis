import SwiftUI
import HandTracker

/// Real, minimal end-to-end harness: a camera preview, a Start button, and
/// a live readout of what MediaPipe actually detects -- enough to confirm
/// hand tracking genuinely works on a device, without building a full
/// skeleton-overlay UI (that's product work, this is a test harness).
///
/// Does NOT auto-start capture on appear -- only the Start button calls
/// `pipeline.start()`, so a camera-permission prompt only ever appears
/// after a real tap, never on cold launch (matters for automated
/// build/CI contexts, and is just better behavior for a real user too).
struct ContentView: View {
    @State private var status = "Not started"
    @State private var handCount = 0
    @State private var isRunning = false

    private let pipeline: HandTrackerPipeline?
    private let initError: String?

    init() {
        do {
            let detector = try MediaPipeHandDetector()
            pipeline = HandTrackerPipeline(detector: detector)
            initError = nil
        } catch {
            pipeline = nil
            initError = "pipeline init failed: \(error)"
        }
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            if let pipeline {
                CameraPreviewView(session: pipeline.captureSession)
                    .ignoresSafeArea()
            } else {
                Color.black.ignoresSafeArea()
            }

            VStack(spacing: 12) {
                Text(initError ?? status)
                    .font(.footnote)
                    .foregroundStyle(.white)
                Text("Hands detected: \(handCount)")
                    .font(.footnote)
                    .foregroundStyle(.white)

                Button(isRunning ? "Stop" : "Start") {
                    isRunning ? stop() : start()
                }
                .disabled(pipeline == nil)
                .buttonStyle(.borderedProminent)
            }
            .padding()
            .background(.black.opacity(0.6))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .padding()
        }
        .onAppear {
            pipeline?.onResult = { hands in
                DispatchQueue.main.async { handCount = hands.count }
            }
        }
    }

    private func start() {
        do {
            try pipeline?.start()
            isRunning = true
            status = "Running"
        } catch {
            status = "start() failed: \(error)"
        }
    }

    private func stop() {
        pipeline?.stop()
        isRunning = false
        handCount = 0
        status = "Stopped"
    }
}

#Preview {
    ContentView()
}
