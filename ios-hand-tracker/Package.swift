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
    platforms: [.iOS(.v16)],
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
