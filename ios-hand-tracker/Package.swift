// swift-tools-version:5.9
import PackageDescription

// No external dependency is declared here for MediaPipeTasksVision on
// purpose -- as of this writing Google has no official SPM distribution for
// it (google-ai-edge/mediapipe issues #5464 and #6167, both still open);
// the only community SPM wrapper (SwiftTasksVision) ships unsafe build
// flags, which SPM refuses to resolve from another package's Package.swift
// (Xcode-UI-only). See README.md for how to wire a real detector in without
// that blocking this package from building on its own. This package is
// therefore pure Swift/Apple-framework code with zero third-party deps.
let package = Package(
    name: "HandTracker",
    // macOS is listed here too even though this is iOS-focused code: `swift
    // test` runs the XCTest bundle on the HOST Mac, not an iOS simulator,
    // and with no macOS platform declared SwiftPM fell back to a very old
    // default macOS minimum for that host build (confirmed live in CI,
    // 2026-08-30: "'default(_:for:position:)' is only available in macOS
    // 10.15 or newer"). AVFoundation/CoreImage/Metal are genuinely
    // cross-platform Apple frameworks -- nothing in this package is
    // actually iOS-simulator-specific -- so a modern macOS minimum lets
    // `swift test` compile and run for real on the CI runner, while the
    // app target's own iOS 16 minimum (project.yml) is what actually
    // governs the shipped product.
    platforms: [.iOS(.v16), .macOS(.v13)],
    products: [
        .library(name: "HandTracker", targets: ["HandTracker"]),
    ],
    targets: [
        .target(
            name: "HandTracker",
            path: "Sources/HandTracker"
        ),
        .testTarget(
            name: "HandTrackerTests",
            dependencies: ["HandTracker"],
            path: "Tests/HandTrackerTests"
        ),
    ]
)
