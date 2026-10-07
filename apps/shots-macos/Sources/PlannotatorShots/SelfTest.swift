import AppKit

enum SelfTest {
    /// How varied an image is (0 = one flat color): a wallpaper-only or blank capture scores low.
    static func variety(_ image: CGImage) -> Double {
        let w = 64, h = 64
        var pixels = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return 0 }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        var lum: [Double] = []
        for i in stride(from: 0, to: pixels.count, by: 4) { lum.append(0.299 * Double(pixels[i]) + 0.587 * Double(pixels[i + 1]) + 0.114 * Double(pixels[i + 2])) }
        let mean = lum.reduce(0, +) / Double(lum.count)
        return (lum.map { ($0 - mean) * ($0 - mean) }.reduce(0, +) / Double(lum.count)).squareRoot()
    }

    static func run(into dir: String) {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        print("screen recording (preflight): \(Capture.hasPermission)")
        print("accessibility (preflight): \(AXText.isTrusted)")
        print("displays: \(NSScreen.screens.map { "\(Int($0.frame.width))×\(Int($0.frame.height))@\($0.backingScaleFactor)x" }.joined(separator: ", "))")
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            do {
                let started = Date()
                let frozen = try await Capture.freezeAll()
                print("freeze: \(frozen.count) display(s) in \(Int(Date().timeIntervalSince(started) * 1000)) ms")
                for (i, display) in frozen.enumerated() {
                    let path = "\(dir)/display-\(i).png"
                    try Capture.writePNG(display.image, to: path)
                    print("  display \(i): \(display.image.width)×\(display.image.height) px, variety \(String(format: "%.1f", variety(display.image))) → \(path)")
                }
                if let first = frozen.first {
                    let rect = CGRect(x: first.screen.frame.midX - 200, y: first.screen.frame.midY - 100, width: 400, height: 200)
                    if let crop = Capture.crop(first, to: rect) {
                        try Capture.writePNG(crop, to: "\(dir)/region.png")
                        print("region crop 400×200 pt → \(crop.width)×\(crop.height) px")
                    }
                }
                let windows = Capture.windows()
                print("windows on screen: \(windows.count)")
                if let window = Capture.frontmostWindow() {
                    let image = try await Capture.window(window.id)
                    try Capture.writePNG(image, to: "\(dir)/window.png")
                    print("frontmost window: \(window.app) (\(window.bundleId ?? "?")), \(Int(window.bounds.width))×\(Int(window.bounds.height)) pt → \(image.width)×\(image.height) px, variety \(String(format: "%.1f", variety(image)))")
                    let t0 = Date()
                    let text = AXText.capture(pid: window.pid, bundleId: window.bundleId, windowTitle: window.title, frame: window.bounds)
                    let ms = Int(Date().timeIntervalSince(t0) * 1000)
                    if let content = text.text {
                        try content.write(toFile: "\(dir)/window-text.txt", atomically: true, encoding: .utf8)
                        print("window text: \(content.count) characters, \(content.split(separator: "\n").count) lines in \(ms) ms\(text.url != nil ? ", with a page URL" : "") → \(dir)/window-text.txt")
                    } else {
                        print("window text: none (\(text.unavailable ?? "?")) in \(ms) ms")
                    }
                }
            } catch {
                print("capture failed: \(error.localizedDescription)")
            }
            done.signal()
        }
        done.wait()
    }
}
