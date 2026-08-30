import XCTest
@testable import HandTracker

final class OneEuroFilterTests: XCTestCase {
    func testFirstSampleIsPassthrough() {
        let f = OneEuroFilter()
        XCTAssertEqual(f.filter(0.5, tMs: 0), 0.5, accuracy: 1e-9)
    }

    func testConvergesTowardAHeldConstantSignal() {
        let f = OneEuroFilter()
        _ = f.filter(0.0, tMs: 0)
        var last = 0.0
        for i in 1...60 {
            last = f.filter(1.0, tMs: Double(i) * (1000.0 / 60.0))
        }
        // After a full second of a held target, the filter should have
        // caught up close to it -- not exact, since minCutoff always keeps
        // some smoothing lag by design (that's the whole point of it).
        XCTAssertEqual(last, 1.0, accuracy: 0.05)
    }
}

final class HandLandmarkSmootherTests: XCTestCase {
    private func flatHand(x: Float) -> HandLandmarks {
        // 21 landmarks; index 0 = wrist, index 9 = middle MCP -- kept 6
        // units apart so lmSpan-equivalent math has a non-zero denominator,
        // same as a real hand never has wrist and middle-MCP coincident.
        (0..<21).map { i in
            HandLandmark(x: x, y: i == 9 ? 6 : 0, z: 0)
        }
    }

    func testFirstFrameIsPassthrough() {
        let smoother = HandLandmarkSmoother()
        let out = smoother.smooth(flatHand(x: 0.1), timestampMs: 0)
        XCTAssertEqual(out[0].x, 0.1)
    }

    func testHoldsThroughABriefOcclusionSpike() {
        let smoother = HandLandmarkSmoother()
        _ = smoother.smooth(flatHand(x: 0.1), timestampMs: 0)
        // Span here is 6 (wrist-to-middle-MCP, see flatHand), so a jump
        // needs to exceed 0.9 * 6 = 5.4 units to clear jumpCeiling and
        // actually exercise the hold branch -- a smaller spike would just
        // get smoothed normally and pass this assertion for the wrong
        // reason. 10.0 clears it with margin (jump ~= 1.65).
        let spiked = smoother.smooth(flatHand(x: 10.0), timestampMs: 16)
        XCTAssertEqual(spiked[0].x, 0.1, accuracy: 1e-9)   // held exactly at prev, not filtered at all
    }

    func testAcceptsSustainedMotionAfterStuckMaxFrames() {
        let smoother = HandLandmarkSmoother()
        _ = smoother.smooth(flatHand(x: 0.1), timestampMs: 0)
        var last: HandLandmarks = []
        for i in 1...(LandmarkSmoothingConstants.stuckMax + 2) {
            last = smoother.smooth(flatHand(x: 10.0), timestampMs: Double(i) * 16)
        }
        // Sustained "outlier" motion (bigger than jumpCeiling every frame)
        // should eventually be trusted as real rather than held forever --
        // by stuckMax+2 frames it must have started moving off the
        // original 0.1.
        XCTAssertGreaterThan(last[0].x, 0.1)
    }
}
