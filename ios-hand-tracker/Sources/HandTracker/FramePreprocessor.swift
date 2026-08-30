import CoreImage
import CoreImage.CIFilterBuiltins
import CoreVideo
import Metal

/// GPU-side frame conditioning before MediaPipe sees a frame, on a
/// Metal-backed `CIContext` so buffers stay in GPU memory end to end (no
/// CPU round trip) -- matching the zero-copy goal discussed alongside
/// `kCVPixelBufferMetalCompatibilityKey` in `CaptureSessionController`.
///
/// HONEST NOTE ON "CLAHE": Core Image ships no literal windowed-histogram
/// CLAHE filter -- there is no `CIFilter` with that name or behavior on any
/// current iOS version. `localContrastBoost` below approximates it the way
/// a stock Core Image pipeline actually can: blur the luminance to get a
/// "local average," subtract it from the original to isolate local detail
/// (`CIBlendKernel.subtract`), scale that detail, and add it back
/// (`CIAdditionCompositing`). This is a standard unsharp-mask-style local
/// contrast boost -- it recovers local detail in shadow/highlight regions a
/// single global contrast multiplier can't touch, which is the effect
/// actually being asked for, but it is not literally tiled histogram
/// equalization. Say so if a reviewer expects the exact algorithm by name.
///
/// Noise reduction uses `CIFilter.noiseReduction()`, a real built-in Apple
/// filter (not hand-rolled), which is the correct stock tool for this
/// rather than a hand-written bilateral kernel.
public final class FramePreprocessor {
    public struct Settings {
        /// CINoiseReduction's own parameters.
        public var noiseLevel: Float = 0.02
        public var noiseSharpness: Float = 0.4
        /// Radius of the "local average" blur -- larger reads as more
        /// global, smaller as more local (and costs more per frame). 32px
        /// is a starting guess, not fitted against real footage.
        public var localContrastRadius: Float = 32
        /// How hard to push pixels away from their local average.
        public var localContrastAmount: Float = 0.6
        /// Straight brightness lift -- same idea as barehands' web
        /// low-light path (a brightness boost gated by measured scene
        /// luminance, see `stage.html`'s `needsLowLight` handling), just
        /// applied here as a settable knob rather than auto-gated. Wire an
        /// actual luminance sample to this if porting that gating too.
        public var brightness: Float = 0

        public init() {}
    }

    private let context: CIContext

    /// Returns nil if this device has no Metal GPU (e.g. the simulator on
    /// some configurations) -- caller should fall back to feeding raw
    /// frames straight to the detector in that case.
    public init?(device: MTLDevice? = MTLCreateSystemDefaultDevice()) {
        guard let device else { return nil }
        self.context = CIContext(mtlDevice: device, options: [.cacheIntermediates: false])
    }

    /// Core Image is not an in-place API -- renders into a buffer drawn
    /// from `outputPool` rather than allocating a fresh `CVPixelBuffer`
    /// every frame.
    public func process(_ pixelBuffer: CVPixelBuffer,
                         settings: Settings,
                         outputPool: CVPixelBufferPool) -> CVPixelBuffer? {
        var image = CIImage(cvPixelBuffer: pixelBuffer)

        let denoise = CIFilter.noiseReduction()
        denoise.inputImage = image
        denoise.noiseLevel = settings.noiseLevel
        denoise.sharpness = settings.noiseSharpness
        if let denoised = denoise.outputImage {
            image = denoised
        }

        image = localContrastBoost(image,
                                    radius: settings.localContrastRadius,
                                    amount: settings.localContrastAmount)

        if settings.brightness != 0 {
            let controls = CIFilter.colorControls()
            controls.inputImage = image
            controls.brightness = settings.brightness
            if let lifted = controls.outputImage {
                image = lifted
            }
        }

        var newBuffer: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, outputPool, &newBuffer)
        guard let output = newBuffer else { return nil }
        context.render(image, to: output)
        return output
    }

    /// unsharp-mask-style local contrast: output = image + amount * (image - blur(image))
    private func localContrastBoost(_ image: CIImage, radius: Float, amount: Float) -> CIImage {
        let extent = image.extent
        let blurred = image
            .clampedToExtent()
            .applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: radius])
            .cropped(to: extent)

        guard let highFrequency = CIBlendKernel.subtract.apply(foreground: image, background: blurred) else {
            return image
        }

        let scaled = highFrequency.applyingFilter("CIColorMatrix", parameters: [
            "inputRVector": CIVector(x: CGFloat(amount), y: 0, z: 0, w: 0),
            "inputGVector": CIVector(x: 0, y: CGFloat(amount), z: 0, w: 0),
            "inputBVector": CIVector(x: 0, y: 0, z: CGFloat(amount), w: 0),
            "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
        ])

        return scaled
            .applyingFilter("CIAdditionCompositing", parameters: [
                kCIInputBackgroundImageKey: image,
            ])
            .cropped(to: extent)
    }
}
