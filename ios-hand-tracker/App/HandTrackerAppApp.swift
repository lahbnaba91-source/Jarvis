import SwiftUI

/// Deliberately minimal -- this app target exists to give CocoaPods (and
/// therefore MediaPipeTasksVision) somewhere real to attach, and to give
/// CI something to compile and test. It is not a product. `ContentView`
/// does not auto-start the camera on launch (see its own comment) so
/// `xcodebuild test` never blocks on a simulator camera-permission prompt.
@main
struct HandTrackerAppApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
