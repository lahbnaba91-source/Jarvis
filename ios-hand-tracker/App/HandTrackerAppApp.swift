import SwiftUI

/// Deliberately minimal -- this app target exists to give CocoaPods (and
/// therefore MediaPipeTasksVision) somewhere real to attach, to give CI
/// something to compile, and to give a real device a way to actually run
/// the pipeline and confirm hand tracking works. `ContentView` never
/// auto-starts the camera on launch, only on a real Start-button tap, so
/// there's never an unexpected permission prompt (and CI, which only
/// builds this target, never touches the camera at all).
@main
struct HandTrackerAppApp: App {
    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}
