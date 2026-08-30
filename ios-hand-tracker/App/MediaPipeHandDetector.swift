import CoreVideo
import Foundation
import HandTracker
import MediaPipeTasksVision

/// The real adapter `HandLandmarkTypes.swift` (in the HandTracker package)
/// left as a seam: wraps MediaPipe's actual `HandLandmarker` behind
/// `HandLandmarkDetecting`, so capture/preprocessing/smoothing never import
/// MediaPipeTasksVision directly.
///
/// API shape below is grounded against Google's own current docs and
/// sample code (not guessed from memory alone) as of this writing:
/// - https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker/ios
/// - https://github.com/google-ai-edge/mediapipe-samples/blob/main/examples/hand_landmarker/ios/HandLandmarker/Services/HandLandmarkerService.swift
/// - https://developers.google.com/edge/api/mediapipe/swift/vision/Classes/MPImage
///
/// Still genuinely unverified: this has never been compiled against the
/// actual resolved CocoaPods version (whatever `pod install` pulls at CI
/// time). If a property or method name below doesn't match, that mismatch
/// -- not a logic bug -- is the most likely first CI failure.
///
/// Uses `.video` running mode (synchronous `detectForVideo`), matching
/// barehands' own web implementation's choice (`runningMode: "VIDEO"` in
/// `stage.html`) rather than `.liveStream` mode's delegate-callback API --
/// keeps this detector a plain synchronous call, matching
/// `HandLandmarkDetecting`'s shape, and keeps both trackers conceptually
/// consistent.
public final class MediaPipeHandDetector: HandLandmarkDetecting {
    public enum DetectorError: Error {
        case modelAssetMissing
    }

    private let landmarker: HandLandmarker

    public init(numHands: Int = 2,
                minHandDetectionConfidence: Float = 0.7,
                minHandPresenceConfidence: Float = 0.5,
                minTrackingConfidence: Float = 0.5) throws {
        // Bundled by the CI workflow's "Download the MediaPipe
        // hand-landmarker model" step into App/Resources/hand_landmarker.task
        // BEFORE `xcodegen generate` runs, from the exact same model URL
        // barehands' `stage.html` already uses in production:
        // https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task
        // Not committed to the repo as a binary -- fetched fresh each CI
        // run instead.
        guard let modelPath = Bundle.main.path(forResource: "hand_landmarker", ofType: "task") else {
            throw DetectorError.modelAssetMissing
        }

        let options = HandLandmarkerOptions()
        options.baseOptions.modelAssetPath = modelPath
        options.runningMode = .video
        options.numHands = numHands
        options.minHandDetectionConfidence = minHandDetectionConfidence
        options.minHandPresenceConfidence = minHandPresenceConfidence
        options.minTrackingConfidence = minTrackingConfidence

        self.landmarker = try HandLandmarker(options: options)
    }

    public func detect(in pixelBuffer: CVPixelBuffer, timestampMs: Int64) -> HandDetectionResult? {
        guard let image = try? MPImage(pixelBuffer: pixelBuffer) else { return nil }
        guard let result = try? landmarker.detectForVideo(
            image: image, timestampInMilliseconds: Int(timestampMs)) else {
            return nil
        }

        let hands: [HandLandmarks] = result.landmarks.map { hand in
            hand.map { lm in HandLandmark(x: lm.x, y: lm.y, z: lm.z) }
        }
        let handedness: [Handedness] = result.handedness.map { categories in
            // MediaPipe's own label, computed against the UNMIRRORED
            // camera image -- flip it here to match a mirrored preview,
            // same reasoning `stage.html` already documents for the web
            // tracker (search that file for "handedness comes back
            // relative to the UNMIRRORED camera image").
            let raw = categories.first?.categoryName
            switch raw {
            case "Left": return .right
            case "Right": return .left
            default: return .right
            }
        }

        return HandDetectionResult(landmarks: hands, handedness: handedness, timestampMs: timestampMs)
    }
}
