import AppKit
import WebKit

/// The HUD: ONE non-activating floating panel hosting the shared web UI (the
/// hub's /hud page), resized between the 46 pt strip, the panel (760 × 540 by
/// default, resizable from its top-left corner) and the destination picker as
/// the page asks. It never activates this app, so
/// the app you were in stays the active app; it takes the keyboard only while
/// the panel or picker is open, and gives it back when it collapses.
final class HUDPanel: NSPanel {
    var allowsKey = false
    override var canBecomeKey: Bool { allowsKey }
    override var canBecomeMain: Bool { false }
}

@MainActor
final class PanelController: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
    enum Mode: String { case hidden, strip, panel, picker, permission }

    let panel: HUDPanel
    let webView: WKWebView
    private let glass: NSVisualEffectView
    private let resizer = PanelResizer()
    private(set) var mode: Mode = .hidden
    private(set) var targetFrame: NSRect = .zero
    private var loadedSession: String?
    var onMessage: (([String: Any]) -> Void)?
    var isReady = false
    private var pendingScripts: [String] = []

    override init() {
        panel = HUDPanel(contentRect: NSRect(x: 0, y: 0, width: 420, height: 46), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = .floating
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.isMovableByWindowBackground = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        // Best effort for other apps' captures; our own captures exclude it by window.
        panel.sharingType = .none

        glass = NSVisualEffectView()
        glass.material = .hudWindow
        glass.blendingMode = .behindWindow
        glass.state = .active
        glass.wantsLayer = true
        glass.layer?.cornerRadius = 23
        glass.layer?.masksToBounds = true
        glass.layer?.cornerCurve = .continuous

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        webView = WKWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear
        super.init()
        config.userContentController.add(self, name: "snapshots")
        webView.navigationDelegate = self
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]
        glass.addSubview(webView)
        panel.contentView = glass
        webView.frame = glass.bounds
        // Above the web view, but it only takes the mouse along the top and left edges.
        resizer.frame = glass.bounds
        resizer.autoresizingMask = [.width, .height]
        resizer.isHidden = true
        glass.addSubview(resizer)
        resizer.controller = self
        webView.setAccessibilityLabel("Plannotator Snapshots")
    }

    /// Load (or reload, after the hub restarted) the HUD with its token injected before any page script runs.
    func load(_ attached: Hub.Attached) {
        guard loadedSession != attached.entry.serverSession else { return }
        loadedSession = attached.entry.serverSession
        isReady = false
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        let boot = "window.__SNAPSHOTS__ = { token: \(jsString(attached.hudToken)), native: true };"
        controller.addUserScript(WKUserScript(source: boot, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if let url = URL(string: "\(attached.entry.url)/hud") {
            webView.load(URLRequest(url: url))
            log("loading the HUD from \(attached.entry.url)")
        }
    }

    /// Call a function on the page's `window.snapshotsHud`, queued until the page is ready.
    func call(_ function: String, _ argument: Any? = nil) {
        var json = "undefined"
        if let argument {
            if let data = try? JSONSerialization.data(withJSONObject: argument, options: [.fragmentsAllowed]), let text = String(data: data, encoding: .utf8) { json = text }
        }
        let script = "window.snapshotsHud && window.snapshotsHud.\(function)(\(json))"
        if isReady { webView.evaluateJavaScript(script) } else { pendingScripts.append(script) }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if body["type"] as? String == "ready" {
            log("HUD ready")
            isReady = true
            for script in pendingScripts { webView.evaluateJavaScript(script) }
            pendingScripts = []
        }
        if body["type"] as? String == "layout" { applyLayout(body) }
        onMessage?(body)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        log("HUD page loaded")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        log("HUD web content process ended")
        loadedSession = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        log("HUD load failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        log("HUD load failed: \(error.localizedDescription)")
        loadedSession = nil
    }

    // MARK: Layout

    private func applyLayout(_ body: [String: Any]) {
        let next = Mode(rawValue: body["mode"] as? String ?? "") ?? .hidden
        log("HUD layout: \(next)")
        let width = CGFloat(body["width"] as? Double ?? 0)
        let height = CGFloat(body["height"] as? Double ?? 46)
        let focus = body["focus"] as? Bool ?? false
        let previous = mode
        mode = next
        if next == .hidden || width < 10 {
            if panel.isVisible { panel.orderOut(nil) }
            panel.allowsKey = false
            return
        }
        let screen = previous == .hidden ? NSScreen.withMouse : (panel.screen ?? NSScreen.withMouse)
        let visible = screen.visibleFrame
        var size = NSSize(width: width, height: height)
        if next == .panel {
            // The page asks for the default; the size the person dragged it to wins.
            panelMinimum = size
            size = PanelSize.clamp(PanelSize.saved ?? size, minimum: size, visible: visible)
        }
        resizer.isHidden = next != .panel
        // Mid-drag the resizer owns the frame (the page re-renders as it grows).
        if resizer.isDragging { return }
        let frame = NSRect(x: visible.maxX - size.width - 16, y: visible.minY + 16, width: size.width, height: size.height)
        targetFrame = frame
        glass.layer?.cornerRadius = next == .strip ? 23 : next == .picker ? 12 : next == .permission ? 18 : 14
        if !panel.isVisible || previous == .hidden || Config.reduceMotion {
            panel.setFrame(frame, display: true)
        } else if panel.frame != frame {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.28
                context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.25, 1)
                panel.animator().setFrame(frame, display: true)
            }
        }
        panel.allowsKey = focus
        if focus {
            panel.makeKeyAndOrderFront(nil)
            panel.makeFirstResponder(webView)
        } else {
            if panel.isKeyWindow {
                // Give the keyboard back to the app you were in: a panel that is
                // ordered out loses key status, and this app never was active.
                panel.orderOut(nil)
            }
            panel.orderFrontRegardless()
        }
    }

    // MARK: Resizing the panel

    /// The page's default panel size, which is also the smallest it may be.
    private(set) var panelMinimum = PanelSize.standard

    /// Bounds for a drag: the default at least, the screen's visible area (16 pt margins) at most,
    /// and the bottom-right corner it stays pinned to (where applyLayout puts it).
    func resizeLimits() -> (min: NSSize, max: NSSize, anchor: NSPoint) {
        let visible = (panel.screen ?? NSScreen.withMouse).visibleFrame
        let most = PanelSize.clamp(NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude), minimum: panelMinimum, visible: visible)
        return (panelMinimum, most, NSPoint(x: visible.maxX - 16, y: visible.minY + 16))
    }

    /// One drag step: grow up and left from the bottom-right anchor. No animation:
    /// the frame follows the pointer event by event.
    func resizePanel(to size: NSSize) {
        let limits = resizeLimits()
        let width = min(max(size.width, limits.min.width), limits.max.width).rounded()
        let height = min(max(size.height, limits.min.height), limits.max.height).rounded()
        let frame = NSRect(x: limits.anchor.x - width, y: limits.anchor.y, width: width, height: height)
        guard frame != panel.frame else { return }
        targetFrame = frame
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        panel.setFrame(frame, display: true)
        CATransaction.commit()
    }

    func finishResize() {
        let size = panel.frame.size
        PanelSize.saved = size == panelMinimum ? nil : size
        log("HUD panel resized to \(Int(size.width)) × \(Int(size.height))")
    }

    /// Double-click on an edge: back to the default size.
    func resetPanelSize() {
        PanelSize.saved = nil
        let limits = resizeLimits()
        let frame = NSRect(x: limits.anchor.x - limits.min.width, y: limits.anchor.y, width: limits.min.width, height: limits.min.height)
        targetFrame = frame
        if Config.reduceMotion {
            panel.setFrame(frame, display: true)
        } else {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.28
                context.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.9, 0.25, 1)
                panel.animator().setFrame(frame, display: true)
            }
        }
        log("HUD panel size reset")
    }

    /// A rect the page reported (window coordinates, top-left origin, points) in screen coordinates.
    func screenRect(fromPage rect: [String: Any]) -> NSRect {
        let x = CGFloat(rect["x"] as? Double ?? 0)
        let y = CGFloat(rect["y"] as? Double ?? 0)
        let w = CGFloat(rect["width"] as? Double ?? 0)
        let h = CGFloat(rect["height"] as? Double ?? 0)
        let frame = targetFrame == .zero ? panel.frame : targetFrame
        return NSRect(x: frame.minX + x, y: frame.maxY - y - h, width: w, height: h)
    }
}

/// The open-snapshot panel's size, remembered across opens and restarts in the
/// app's own UserDefaults: it describes this Mac's screen, so it stays native.
enum PanelSize {
    static let standard = NSSize(width: 760, height: 540)
    private static let key = "panelSize"

    static var saved: NSSize? {
        get {
            guard let text = UserDefaults.standard.string(forKey: key) else { return nil }
            let size = NSSizeFromString(text)
            return size.width > 0 && size.height > 0 ? size : nil
        }
        set {
            if let newValue { UserDefaults.standard.set(NSStringFromSize(newValue), forKey: key) } else { UserDefaults.standard.removeObject(forKey: key) }
        }
    }

    /// Between the default and the visible screen less a 16 pt margin on every side.
    static func clamp(_ size: NSSize, minimum: NSSize, visible: NSRect) -> NSSize {
        let maxWidth = max(minimum.width, visible.width - 32)
        let maxHeight = max(minimum.height, visible.height - 32)
        return NSSize(width: min(max(size.width, minimum.width), maxWidth).rounded(), height: min(max(size.height, minimum.height), maxHeight).rounded())
    }
}

/// The panel's resize edges: a 5 pt band along the top and the left, and a
/// 14 pt square in the top-left corner (the page draws the corner's mark and
/// shows the same cursors). The panel is anchored bottom-right, so it grows up
/// and left. The drag runs here, not in the page: each frame is set from the
/// pointer's screen position inside the same mouse event, with no round trip
/// through the web view, so it keeps up at 120 Hz and never chases a window
/// that moves under the pointer.
@MainActor
final class PanelResizer: NSView {
    weak var controller: PanelController?
    private(set) var isDragging = false
    private var start: (mouse: NSPoint, size: NSSize, edges: Edges)?

    struct Edges: OptionSet {
        let rawValue: Int
        static let top = Edges(rawValue: 1)
        static let left = Edges(rawValue: 2)
    }

    private static let band: CGFloat = 5
    private static let corner: CGFloat = 14

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    private func edges(at point: NSPoint) -> Edges {
        if point.x < Self.corner && point.y < Self.corner { return [.top, .left] }
        var edges: Edges = []
        if point.y < Self.band { edges.insert(.top) }
        if point.x < Self.band { edges.insert(.left) }
        return edges
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !isHidden, let superview else { return nil }
        return edges(at: convert(point, from: superview)).isEmpty ? nil : self
    }

    private func cursor(for edges: Edges) -> NSCursor {
        if #available(macOS 15.0, *) {
            switch edges {
            case [.top, .left]: return .frameResize(position: .topLeft, directions: .all)
            case .top: return .frameResize(position: .top, directions: .all)
            default: return .frameResize(position: .left, directions: .all)
            }
        }
        if edges == .top { return .resizeUpDown }
        if edges == .left { return .resizeLeftRight }
        // macOS 14 has no public diagonal resize cursor; AppKit's own window one is what windows show.
        let diagonal = NSSelectorFromString("_windowResizeNorthWestSouthEastCursor")
        if NSCursor.responds(to: diagonal), let cursor = NSCursor.perform(diagonal)?.takeUnretainedValue() as? NSCursor { return cursor }
        return .crosshair
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseMoved, .cursorUpdate, .activeAlways, .inVisibleRect], owner: self))
    }

    override func cursorUpdate(with event: NSEvent) { updateCursor(event) }
    override func mouseMoved(with event: NSEvent) { updateCursor(event) }

    private func updateCursor(_ event: NSEvent) {
        guard !isHidden, !isDragging else { return }
        let found = edges(at: convert(event.locationInWindow, from: nil))
        if !found.isEmpty { cursor(for: found).set() }
    }

    override func mouseDown(with event: NSEvent) {
        let found = edges(at: convert(event.locationInWindow, from: nil))
        guard !found.isEmpty, let window else { return }
        if event.clickCount == 2 {
            controller?.resetPanelSize()
            return
        }
        isDragging = true
        start = (NSEvent.mouseLocation, window.frame.size, found)
        cursor(for: found).push()
    }

    override func mouseDragged(with event: NSEvent) {
        guard let start, let controller else { return }
        let mouse = NSEvent.mouseLocation
        var size = start.size
        if start.edges.contains(.left) { size.width = start.size.width - (mouse.x - start.mouse.x) }
        if start.edges.contains(.top) { size.height = start.size.height + (mouse.y - start.mouse.y) }
        controller.resizePanel(to: size)
    }

    override func mouseUp(with event: NSEvent) {
        guard start != nil else { return }
        start = nil
        isDragging = false
        NSCursor.pop()
        controller?.finishResize()
    }
}

func jsString(_ text: String) -> String {
    let data = try? JSONSerialization.data(withJSONObject: [text])
    let array = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
    return String(array.dropFirst().dropLast())
}
