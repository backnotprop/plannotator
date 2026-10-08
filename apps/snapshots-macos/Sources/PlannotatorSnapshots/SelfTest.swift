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

    /// The App Capture tree decisions for well-known apps, checked with no app running.
    /// Returns the failures (empty when all hold).
    static func enablementChecks() -> [String] {
        typealias E = AXEnablement
        var failures: [String] = []
        func check(_ ok: Bool, _ what: String) { if !ok { failures.append(what) } }
        check(E.family(bundleId: "com.google.Chrome", frameworks: []) == .chromium, "Chrome is Chromium")
        check(E.family(bundleId: "com.tinyspeck.slackmacgap", frameworks: ["Electron Framework.framework"]) == .electron, "Slack is Electron")
        check(E.family(bundleId: "com.apple.Safari", frameworks: []) == .other, "Safari is neither")
        check(E.step(family: .chromium, alreadyEnabled: false) == .beforeWalk, "Chrome is asked before the walk")
        check(E.step(family: .chromium, alreadyEnabled: true) == .ifSparse, "Chrome is not asked again unless empty")
        check(E.step(family: .other, alreadyEnabled: false) == .ifSparse, "other apps are asked only when empty")
        check(!E.useEnhancedFallback(family: .electron, manualResult: .attributeUnsupported), "Electron never gets AXEnhancedUserInterface")
        check(!E.useEnhancedFallback(family: .chromium, manualResult: .cannotComplete), "a busy Chrome is not a refusal")
        check(E.enhancedIsOurs(before: nil), "an unknown AXEnhancedUserInterface is reset after the capture")
        let now = Date()
        check(E.settleTime(now: now, deadline: now.addingTimeInterval(2)) == E.settleLimit, "the wait is capped")
        check(E.settleTime(now: now, deadline: now.addingTimeInterval(0.5)) == 0, "the wait never eats the walk's budget")
        return failures
    }

    private final class Outcome: @unchecked Sendable { var failed = false }

    /// Returns false when a check failed.
    static func run(into dir: String, axApp: String? = nil) -> Bool {
        let outcome = Outcome()
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        print("screen recording (preflight): \(Capture.hasPermission)")
        print("accessibility (preflight): \(AXText.isTrusted)")
        let failures = enablementChecks()
        outcome.failed = !failures.isEmpty
        print(failures.isEmpty ? "app text decisions: ok" : "FAIL app text decisions: \(failures.joined(separator: "; "))")
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
                // --ax-app <bundle id>: read that app's front window instead of the frontmost
                // one (e.g. com.google.Chrome, to check the tree is turned on with no setting).
                let target = axApp.flatMap { id in NSRunningApplication.runningApplications(withBundleIdentifier: id).first }
                if axApp != nil, target == nil { print("--ax-app \(axApp!): not running") }
                let picked = target.map { app in windows.first { $0.pid == app.processIdentifier } } ?? Capture.frontmostWindow()
                if let window = picked {
                    let image = try await Capture.window(window.id)
                    try Capture.writePNG(image, to: "\(dir)/window.png")
                    print("\(target == nil ? "frontmost" : "--ax-app") window: \(window.app) (\(window.bundleId ?? "?")), \(Int(window.bounds.width))×\(Int(window.bounds.height)) pt → \(image.width)×\(image.height) px, variety \(String(format: "%.1f", variety(image)))")
                    let t0 = Date()
                    let text = AXText.capture(pid: window.pid, bundleId: window.bundleId, windowTitle: window.title, frame: window.bounds)
                    let ms = Int(Date().timeIntervalSince(t0) * 1000)
                    print("tree: \(text.enablement ?? "not asked")")
                    if let content = text.text {
                        try content.write(toFile: "\(dir)/window-text.txt", atomically: true, encoding: .utf8)
                        print("window text: \(content.count) characters, \(content.split(separator: "\n").count) lines in \(ms) ms\(text.url != nil ? ", with a page URL" : "") → \(dir)/window-text.txt")
                    } else {
                        print("window text: none (\(text.unavailable ?? "?")) in \(ms) ms")
                    }
                    if ms > 2600 { outcome.failed = true; print("FAIL: the text read took \(ms) ms, over the 2 s budget") }
                }
            } catch {
                print("capture failed: \(error.localizedDescription)")
            }
            done.signal()
        }
        done.wait()
        return !outcome.failed
    }
}
