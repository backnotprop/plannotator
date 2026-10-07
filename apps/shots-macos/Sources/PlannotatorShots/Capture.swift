import AppKit
import ScreenCaptureKit
import UniformTypeIdentifiers

/// One display frozen at hotkey time: menus and hover states stay in the shot.
struct FrozenDisplay {
    let screen: NSScreen
    let image: CGImage
    /// Image pixels per point.
    var scale: CGFloat { CGFloat(image.width) / screen.frame.width }
}

/// A window on screen, from CGWindowList (global, top-left-origin bounds).
struct WindowInfo {
    let id: CGWindowID
    let pid: pid_t
    let app: String
    let title: String
    let bounds: CGRect
    var bundleId: String? { NSRunningApplication(processIdentifier: pid)?.bundleIdentifier }
}

enum CaptureError: LocalizedError {
    case noPermission
    case failed(String)
    var errorDescription: String? {
        switch self {
        case .noPermission: return "Plannotator Shots needs Screen Recording"
        case .failed(let text): return text
        }
    }
}

/// ScreenCaptureKit captures that never include our own windows: they are
/// excluded by WINDOW in the content filter (excluding our app alone let an
/// accessory app's panels leak into captures; sharingType = .none is not
/// enough either).
enum Capture {
    static var hasPermission: Bool { CGPreflightScreenCaptureAccess() }

    /// Asks once (the system prompt names Plannotator Shots); later calls only report.
    @discardableResult
    static func requestPermission() -> Bool { CGRequestScreenCaptureAccess() }

    static func freezeAll() async throws -> [FrozenDisplay] {
        guard hasPermission else { throw CaptureError.noPermission }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let ours = content.windows.filter { $0.owningApplication?.processID == ProcessInfo.processInfo.processIdentifier }
        var frozen: [FrozenDisplay] = []
        for screen in NSScreen.screens {
            guard let display = content.displays.first(where: { $0.displayID == screen.displayID }) else { continue }
            let filter = SCContentFilter(display: display, excludingWindows: ours)
            let config = SCStreamConfiguration()
            let scale = screen.backingScaleFactor
            config.width = Int(screen.frame.width * scale)
            config.height = Int(screen.frame.height * scale)
            config.showsCursor = false
            config.captureResolution = .best
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
            frozen.append(FrozenDisplay(screen: screen, image: image))
        }
        if frozen.isEmpty { throw CaptureError.failed("No display could be captured.") }
        return frozen
    }

    /// One window on its own, at full resolution, without the desktop or the windows over it.
    static func window(_ id: CGWindowID) async throws -> CGImage {
        guard hasPermission else { throw CaptureError.noPermission }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let window = content.windows.first(where: { $0.windowID == id }) else { throw CaptureError.failed("That window is gone.") }
        let filter = SCContentFilter(desktopIndependentWindow: window)
        let config = SCStreamConfiguration()
        config.width = Int(filter.contentRect.width * CGFloat(filter.pointPixelScale))
        config.height = Int(filter.contentRect.height * CGFloat(filter.pointPixelScale))
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        config.captureResolution = .best
        return try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    }

    /// Normal app windows on screen, front to back, never ours.
    static func windows() -> [WindowInfo] {
        let own = ProcessInfo.processInfo.processIdentifier
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        return list.compactMap { info in
            guard (info[kCGWindowLayer as String] as? Int) == 0,
                  let id = info[kCGWindowNumber as String] as? CGWindowID,
                  let pid = info[kCGWindowOwnerPID as String] as? pid_t, pid != own,
                  let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict),
                  bounds.width > 40, bounds.height > 40
            else { return nil }
            if let alpha = info[kCGWindowAlpha as String] as? Double, alpha <= 0 { return nil }
            return WindowInfo(
                id: id,
                pid: pid,
                app: info[kCGWindowOwnerName as String] as? String ?? "",
                title: info[kCGWindowName as String] as? String ?? "",
                bounds: bounds
            )
        }
    }

    /// The frontmost app's front window (an App shot's target).
    static func frontmostWindow() -> WindowInfo? {
        guard let app = NSWorkspace.shared.frontmostApplication else { return windows().first }
        return windows().first { $0.pid == app.processIdentifier } ?? windows().first
    }

    /// The topmost window under a global point (top-left origin).
    static func window(at point: CGPoint) -> WindowInfo? {
        windows().first { $0.bounds.contains(point) }
    }

    static func writePNG(_ image: CGImage, to path: String) throws {
        let url = URL(fileURLWithPath: path)
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw CaptureError.failed("Could not write \(path)")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { throw CaptureError.failed("Could not write \(path)") }
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    }

    /// Crop a frozen display to a rect in that screen's AppKit coordinates.
    static func crop(_ display: FrozenDisplay, to rect: CGRect) -> CGImage? {
        let local = rect.offsetBy(dx: -display.screen.frame.minX, dy: -display.screen.frame.minY)
        let scale = display.scale
        let pixel = CGRect(
            x: (local.minX * scale).rounded(),
            y: ((display.screen.frame.height - local.maxY) * scale).rounded(),
            width: (local.width * scale).rounded(),
            height: (local.height * scale).rounded()
        ).intersection(CGRect(x: 0, y: 0, width: display.image.width, height: display.image.height))
        guard !pixel.isEmpty else { return nil }
        return display.image.cropping(to: pixel)
    }
}
