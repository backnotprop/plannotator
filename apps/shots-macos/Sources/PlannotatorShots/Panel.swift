import AppKit
import WebKit

/// The HUD: ONE non-activating floating panel hosting the shared web UI (the
/// hub's /hud page), resized between the 46 pt strip, the 760 × 540 panel and
/// the destination picker as the page asks. It never activates this app, so
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
        config.userContentController.add(self, name: "shots")
        webView.navigationDelegate = self
        webView.autoresizingMask = [.width, .height]
        glass.addSubview(webView)
        panel.contentView = glass
        webView.frame = glass.bounds
        webView.setAccessibilityLabel("Plannotator Shots")
    }

    /// Load (or reload, after the hub restarted) the HUD with its token injected before any page script runs.
    func load(_ attached: Hub.Attached) {
        guard loadedSession != attached.entry.serverSession else { return }
        loadedSession = attached.entry.serverSession
        isReady = false
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        let boot = "window.__SHOTS__ = { token: \(jsString(attached.hudToken)), native: true };"
        controller.addUserScript(WKUserScript(source: boot, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        if let url = URL(string: "\(attached.entry.url)/hud") {
            webView.load(URLRequest(url: url))
            log("loading the HUD from \(attached.entry.url)")
        }
    }

    /// Call a function on the page's `window.shotsHud`, queued until the page is ready.
    func call(_ function: String, _ argument: Any? = nil) {
        var json = "undefined"
        if let argument {
            if let data = try? JSONSerialization.data(withJSONObject: argument, options: [.fragmentsAllowed]), let text = String(data: data, encoding: .utf8) { json = text }
        }
        let script = "window.shotsHud && window.shotsHud.\(function)(\(json))"
        if isReady { webView.evaluateJavaScript(script) } else { pendingScripts.append(script) }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if body["type"] as? String == "ready" {
            isReady = true
            for script in pendingScripts { webView.evaluateJavaScript(script) }
            pendingScripts = []
        }
        if body["type"] as? String == "layout" { applyLayout(body) }
        onMessage?(body)
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
        let frame = NSRect(x: visible.maxX - width - 16, y: visible.minY + 16, width: width, height: height)
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

func jsString(_ text: String) -> String {
    let data = try? JSONSerialization.data(withJSONObject: [text])
    let array = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
    return String(array.dropFirst().dropLast())
}
