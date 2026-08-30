import AVFoundation
import CoreMedia
import CoreVideo

/// Wires capture -> GPU preprocessing -> hand detection -> per-hand
/// smoothing -> a plain callback.
///
/// The detector is injected (`HandLandmarkDetecting`) so this file never
/// imports MediaPipeTasksVision directly -- see README.md for why that
/// matters in this environment and for a sketch of the real adapter.
public final class HandTrackerPipeline {
    public var onResult: (([HandLandmarks]) -> Void)?
    public var preprocessSettings = FramePreprocessor.Settings()

    /// Exposed so a UI layer can attach an `AVCaptureVideoPreviewLayer`
    /// without this package needing to know anything about UIKit/SwiftUI.
    public var captureSession: AVCaptureSession { capture.captureSession }

    private let capture = CaptureSessionController()
    private let preprocessor: FramePreprocessor?
    private let detector: HandLandmarkDetecting
    private var pool: CVPixelBufferPool?
    private var smoothers: [HandLandmarkSmoother] = []

    public init(detector: HandLandmarkDetecting) {
        self.detector = detector
        self.preprocessor = FramePreprocessor()
        capture.onFrame = { [weak self] pixelBuffer, time in
            self?.handle(pixelBuffer: pixelBuffer, time: time)
        }
    }

    public func start() throws {
        try capture.start()
    }

    public func stop() {
        capture.stop()
    }

    private func handle(pixelBuffer: CVPixelBuffer, time: CMTime) {
        let toDetect: CVPixelBuffer
        if let preprocessor, let pool = pixelBufferPool(matching: pixelBuffer) {
            toDetect = preprocessor.process(pixelBuffer, settings: preprocessSettings, outputPool: pool)
                ?? pixelBuffer
        } else {
            // No Metal device (preprocessor init failed) -- feed the raw
            // frame straight to the detector rather than dropping it.
            toDetect = pixelBuffer
        }

        let timestampMs = Int64(CMTimeGetSeconds(time) * 1000)
        guard let result = detector.detect(in: toDetect, timestampMs: timestampMs) else { return }

        while smoothers.count < result.landmarks.count {
            smoothers.append(HandLandmarkSmoother())
        }
        let smoothed = result.landmarks.enumerated().map { index, hand in
            smoothers[index].smooth(hand, timestampMs: Double(timestampMs))
        }
        onResult?(smoothed)
    }

    private func pixelBufferPool(matching pixelBuffer: CVPixelBuffer) -> CVPixelBufferPool? {
        if let pool { return pool }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferMetalCompatibilityKey as String: true,
        ]
        var newPool: CVPixelBufferPool?
        CVPixelBufferPoolCreate(nil, nil, attrs as CFDictionary, &newPool)
        pool = newPool
        return newPool
    }
}
