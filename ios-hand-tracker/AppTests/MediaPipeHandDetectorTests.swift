import XCTest
@testable import HandTrackerApp

/// Deliberately narrow scope: these confirm the CocoaPods-linked
/// MediaPipeTasksVision integration actually loads and initializes for
/// real in a built app -- NOT that hand detection produces correct
/// landmarks on real footage, which needs an actual device/camera or a
/// bundled reference image and is out of scope for this harness. See
/// README.md's verification-status note: this is the first thing that
/// will surface whether the model-asset download step, the Podfile, and
/// MediaPipeHandDetector's API usage actually line up.
final class MediaPipeHandDetectorTests: XCTestCase {
    func testModelAssetIsBundled() {
        // Confirms the CI workflow's model-download step actually landed
        // the file where XcodeGen's resources config expects it, and that
        // it got bundled into the app target correctly.
        let path = Bundle.main.path(forResource: "hand_landmarker", ofType: "task")
        XCTAssertNotNil(path, "hand_landmarker.task not found in the app bundle -- check the CI download step and project.yml's resources")
    }

    func testDetectorInitializes() throws {
        // Exercises the real MediaPipeTasksVision HandLandmarker init path
        // end to end: model load, options, CocoaPods linking. Does not
        // call detect() -- no camera frame exists in this test context.
        _ = try MediaPipeHandDetector()
    }
}
