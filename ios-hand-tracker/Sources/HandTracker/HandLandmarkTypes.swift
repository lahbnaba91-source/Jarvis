import CoreVideo
import Foundation

/// Mirrors the shape of MediaPipe Tasks Vision's `NormalizedLandmark`
/// closely enough that a thin adapter over the real SDK type can convert to
/// this one with a single memberwise mapping. Kept as our own type, not a
/// MediaPipe type, because MediaPipeTasksVision has no official Swift
/// Package Manager distribution as of this writing -- see the note in
/// Package.swift and README.md. This package has to compile standalone
/// without that dependency resolved.
public struct HandLandmark {
    public var x: Float
    public var y: Float
    public var z: Float

    public init(x: Float, y: Float, z: Float) {
        self.x = x
        self.y = y
        self.z = z
    }
}

/// One hand's 21 landmarks, MediaPipe's own indexing order
/// (0 = wrist ... 9 = middle MCP ... 20 = pinky tip).
public typealias HandLandmarks = [HandLandmark]

public enum Handedness {
    case left
    case right
}

public struct HandDetectionResult {
    /// One entry per detected hand.
    public var landmarks: [HandLandmarks]
    /// Parallel to `landmarks`.
    public var handedness: [Handedness]
    public var timestampMs: Int64

    public init(landmarks: [HandLandmarks], handedness: [Handedness], timestampMs: Int64) {
        self.landmarks = landmarks
        self.handedness = handedness
        self.timestampMs = timestampMs
    }
}

/// Conform a thin wrapper around MediaPipe's real `HandLandmarker` to this
/// protocol so the rest of this package never has to import
/// MediaPipeTasksVision directly. `HandTrackerPipeline` takes one of these
/// injected at init -- the real adapter is `App/MediaPipeHandDetector.swift`,
/// one directory up in this project's CocoaPods-integrated Xcode app target
/// (this package itself stays dependency-free; see README.md for why).
public protocol HandLandmarkDetecting {
    func detect(in pixelBuffer: CVPixelBuffer, timestampMs: Int64) -> HandDetectionResult?
}
