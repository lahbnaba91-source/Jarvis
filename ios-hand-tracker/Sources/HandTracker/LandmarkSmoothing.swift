import Foundation

/// Constants ported verbatim from `barehands/stage.html` -- same values,
/// not re-tuned for iOS. If retuning is ever needed here, retune both the
/// web and native versions together, or the two trackers will feel
/// noticeably different to the same person moving between them.
public enum LandmarkSmoothingConstants {
    /// Seconds of velocity-based predictive lead at steady motion.
    public static let lookaheadS = 0.05
    /// Acceleration (units/sec^2) at which the lead above halves.
    public static let accelDamp = 15.0
    /// Span-units a landmark may move in one raw frame before it's treated
    /// as an occlusion outlier rather than real motion.
    public static let jumpCeiling = 0.9
    /// Consecutive frames a landmark may be held before the ceiling gives
    /// up rejecting and trusts the raw data again -- a real glitch is a
    /// brief flicker, not sustained; this is what tells the two apart.
    public static let stuckMax = 3
}

/// One-Euro filter, ported from `stage.html`'s `oneEuro()`, including its
/// 2026-08-25 adaptive-lead extension (not the vanilla Casiez et al.
/// algorithm): a FIXED lookahead extrapolates by the current velocity,
/// which is exactly wrong the instant that velocity is about to change (a
/// sudden stop or reversal gets overshot, predicted past where the hand
/// actually stopped, then snaps back). `accel` below is how fast the
/// filtered velocity itself is changing frame to frame -- near zero during
/// steady motion (full lead applies, cancelling lag same as a plain 1-euro
/// filter), spiking right as a stop/reversal happens (lead shrinks toward
/// zero right when a fixed lead would guess wrong).
public final class OneEuroFilter {
    private let minCutoff: Double
    private let beta: Double
    private let dCutoff: Double

    private var xPrev: Double?
    private var dxPrev: Double = 0
    private var tPrev: Double?

    public init(minCutoff: Double = 1.2, beta: Double = 0.7, dCutoff: Double = 1.0) {
        self.minCutoff = minCutoff
        self.beta = beta
        self.dCutoff = dCutoff
    }

    private func alpha(cutoff: Double, dt: Double) -> Double {
        let tau = 1 / (2 * Double.pi * cutoff)
        return 1 / (1 + tau / dt)
    }

    /// - Parameters:
    ///   - x: raw sample.
    ///   - tMs: timestamp in milliseconds (matches the JS call convention).
    public func filter(_ x: Double, tMs: Double) -> Double {
        let t = tMs / 1000
        guard let tp = tPrev else {
            xPrev = x
            tPrev = t
            return x
        }
        let dt = max(t - tp, 1.0 / 120.0)
        let xp = xPrev ?? x
        let dx = (x - xp) / dt
        let aD = alpha(cutoff: dCutoff, dt: dt)
        let dxF = dxPrev + aD * (dx - dxPrev)
        let cutoff = minCutoff + beta * abs(dxF)
        let aX = alpha(cutoff: cutoff, dt: dt)
        let xF = xp + aX * (x - xp)

        let accel = abs(dxF - dxPrev) / dt
        xPrev = xF
        dxPrev = dxF
        tPrev = t
        let lead = LandmarkSmoothingConstants.lookaheadS / (1 + accel / LandmarkSmoothingConstants.accelDamp)
        return xF + dxF * lead
    }
}

/// Per-hand smoothing state -- one instance per tracked hand, mirroring
/// each cursor's `lmF`/`smLast`/`lmStuck` fields in `stage.html`.
///
/// Ported from `smoothLandmarks()`: a per-landmark occlusion guard runs
/// BEFORE the One-Euro filter -- a landmark that jumps more than
/// `jumpCeiling` span-units in one frame is held at its last smoothed
/// position (not fed to the filter at all) for up to `stuckMax` consecutive
/// frames, after which sustained "outlier" motion is trusted as real rather
/// than held forever. This specifically fixes a real bug found live
/// (2026-08-25, "some dots stay in the background and don't go with my
/// hand"): comparing against a stale HELD position instead of the actual
/// last real one made a badly occluded point get stuck for good.
public final class HandLandmarkSmoother {
    private var filters: [(x: OneEuroFilter, y: OneEuroFilter, z: OneEuroFilter)]?
    private var lastSmoothed: HandLandmarks?
    private var stuckCounts: [Int]?

    public init() {}

    /// Call once per frame with that hand's raw 21 landmarks (MediaPipe's
    /// own index order). Returns smoothed landmarks, same order/count.
    public func smooth(_ raw: HandLandmarks, timestampMs: Double) -> HandLandmarks {
        guard let existingFilters = filters,
              let last = lastSmoothed,
              var stuck = stuckCounts,
              existingFilters.count == raw.count else {
            filters = raw.map { _ in (OneEuroFilter(), OneEuroFilter(), OneEuroFilter()) }
            lastSmoothed = raw
            stuckCounts = Array(repeating: 0, count: raw.count)
            return raw
        }

        // The hand's own yardstick -- wrist (index 0) to middle-MCP (index
        // 9), same landmark indices MediaPipe always uses, same as
        // `lmSpan()` in stage.html.
        let dx0 = Double(raw[0].x - raw[9].x)
        let dy0 = Double(raw[0].y - raw[9].y)
        let rawSpan = (dx0 * dx0 + dy0 * dy0).squareRoot()
        let span = rawSpan == 0 ? 1 : rawSpan

        var out = HandLandmarks()
        out.reserveCapacity(raw.count)
        for i in 0..<raw.count {
            let r = raw[i]
            let prev = last[i]
            let jdx = Double(r.x - prev.x)
            let jdy = Double(r.y - prev.y)
            let jump = (jdx * jdx + jdy * jdy).squareRoot() / span

            if jump > LandmarkSmoothingConstants.jumpCeiling &&
                stuck[i] < LandmarkSmoothingConstants.stuckMax {
                out.append(prev)
                stuck[i] += 1
            } else {
                stuck[i] = 0
                let f = existingFilters[i]
                out.append(HandLandmark(
                    x: Float(f.x.filter(Double(r.x), tMs: timestampMs)),
                    y: Float(f.y.filter(Double(r.y), tMs: timestampMs)),
                    z: Float(f.z.filter(Double(r.z), tMs: timestampMs))
                ))
            }
        }
        lastSmoothed = out
        stuckCounts = stuck
        return out
    }
}
