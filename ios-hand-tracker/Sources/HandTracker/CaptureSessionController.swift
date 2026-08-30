import AVFoundation
import CoreVideo

/// Owns the AVCaptureSession and hands off each frame as a CVPixelBuffer.
///
/// Settings here mirror what was discussed for this project and, where
/// possible, the same reasoning already proven in barehands' browser
/// pipeline (`barehands/stage.html`):
/// - 32BGRA output: Core Video does the sensor -> BGRA conversion in
///   hardware, no software color-space step in the middle -- the native
///   equivalent of the browser path never touching color space at all
///   (`getUserMedia` already hands back RGB natively).
/// - `kCVPixelBufferMetalCompatibilityKey`: keeps buffers usable by a
///   Metal-backed `CIContext` (see `FramePreprocessor`) without a CPU round
///   trip.
/// - A capped capture preset (720p default) instead of raw 4K: MediaPipe
///   downsamples internally to a small tensor regardless, so anything past
///   that just burns battery and invites thermal throttling.
/// - A locked frame duration: uniform frame timing helps MediaPipe's own
///   internal velocity estimate between frames -- same reasoning already
///   applied to barehands' `getUserMedia({ frameRate: { ideal: 60 } })`
///   constraint, just enforced at the hardware level here instead of a
///   browser hint.
public final class CaptureSessionController: NSObject {
    public var onFrame: ((CVPixelBuffer, CMTime) -> Void)?

    private let session = AVCaptureSession()
    private let videoOutput = AVCaptureVideoDataOutput()
    private let sessionQueue = DispatchQueue(label: "handtracker.capture.session")
    private let frameQueue = DispatchQueue(label: "handtracker.capture.frames", qos: .userInteractive)

    public enum CaptureError: Error {
        case noCamera
        case cannotAddInput
        case cannotAddOutput
    }

    public override init() {
        super.init()
    }

    public func start(position: AVCaptureDevice.Position = .front,
                       preset: AVCaptureSession.Preset = .hd1280x720,
                       targetFrameRate: Double = 60) throws {
        var startError: Error?
        sessionQueue.sync {
            session.beginConfiguration()
            defer { session.commitConfiguration() }

            session.sessionPreset = preset

            guard let device = AVCaptureDevice.default(.builtInWideAngleCamera,
                                                        for: .video,
                                                        position: position) else {
                startError = CaptureError.noCamera
                return
            }

            do {
                let input = try AVCaptureDeviceInput(device: device)
                guard session.canAddInput(input) else {
                    startError = CaptureError.cannotAddInput
                    return
                }
                session.addInput(input)
            } catch {
                startError = error
                return
            }

            // Frame-rate lock: strict, uniform timing between frames. Falls
            // back to whatever the device's default rate is if the target
            // isn't supported -- never a fatal error, just less-ideal
            // tracking input.
            if let range = device.activeFormat.videoSupportedFrameRateRanges.first(
                where: { $0.maxFrameRate >= targetFrameRate }) {
                do {
                    try device.lockForConfiguration()
                    let fps = min(targetFrameRate, range.maxFrameRate)
                    let duration = CMTimeMake(value: 1, timescale: Int32(fps))
                    device.activeVideoMinFrameDuration = duration
                    device.activeVideoMaxFrameDuration = duration
                    device.unlockForConfiguration()
                } catch {
                    // non-fatal -- camera just runs at its own default rate
                }
            }

            videoOutput.videoSettings = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferMetalCompatibilityKey as String: true,
            ]
            videoOutput.alwaysDiscardsLateVideoFrames = true
            videoOutput.setSampleBufferDelegate(self, queue: frameQueue)
            guard session.canAddOutput(videoOutput) else {
                startError = CaptureError.cannotAddOutput
                return
            }
            session.addOutput(videoOutput)

            if let connection = videoOutput.connection(with: .video),
               connection.isVideoOrientationSupported {
                connection.videoOrientation = .portrait
            }
        }
        if let startError { throw startError }
        sessionQueue.async { [session] in
            session.startRunning()
        }
    }

    public func stop() {
        sessionQueue.async { [session] in
            session.stopRunning()
        }
    }
}

extension CaptureSessionController: AVCaptureVideoDataOutputSampleBufferDelegate {
    public func captureOutput(_ output: AVCaptureOutput,
                               didOutput sampleBuffer: CMSampleBuffer,
                               from connection: AVCaptureConnection) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        onFrame?(pixelBuffer, timestamp)
    }

    public func captureOutput(_ output: AVCaptureOutput,
                               didDrop sampleBuffer: CMSampleBuffer,
                               from connection: AVCaptureConnection) {
        // `alwaysDiscardsLateVideoFrames` already keeps this rare; nothing
        // to recover here, the next frame just arrives on schedule.
    }
}
