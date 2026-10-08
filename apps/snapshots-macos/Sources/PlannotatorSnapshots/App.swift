import AppKit
import Carbon
import ScreenCaptureKit

/// Plannotator Snapshots: an accessory app (no Dock icon, no menu bar of its own)
/// that owns the global hotkeys, the frozen-screen capture, App Capture window
/// text, the HUD panel and the capture flight. Everything else (the snapshots
/// store, sessions, delivery, Ask) lives in the hub.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let hub = Hub()
    private let panel = PanelController()
    private var hotKeys: HotKeys?
    private var statusItem: NSStatusItem?
    private var overlay: OverlayController?
    private var flights: [String: (flight: Flight, image: CGImage, from: NSRect)] = [:]
    private var settings = (appCapture: false, explainerSeen: false)
    private let permissions = PermissionFlow()
    private var capturing = false
    private var watchdog: Timer?

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(handleURL(_:reply:)), forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        hotKeys = HotKeys { [weak self] action in self?.hotKey(action) }
        panel.onMessage = { [weak self] message in self?.pageMessage(message) }
        permissions.show = { [weak self] state in self?.panel.call("permission", state) }
        permissions.resume = { [weak self] pending in
            guard let pending else { return }
            self?.startCapture(app: pending == .app)
        }
        setUpStatusItem()
        connect()
        permissions.resumeAfterLaunch()
        // The hub restarts (an update, a crash): attach again and reload the page.
        watchdog = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in if await self.hub.needsReattach() { self.connect() } }
        }
        log("Plannotator Snapshots started (screen recording: \(Capture.hasPermission), accessibility: \(AXText.isTrusted))")
    }

    private func connect() {
        Task { @MainActor in
            do {
                let attached = try await hub.attach()
                panel.load(attached)
                sendPermissions()
                if let icon = appIconDataURL() { panel.call("appIcon", icon) }
            } catch {
                log("hub: \(error.localizedDescription)")
            }
        }
    }

    // MARK: Commands from the CLI (plannotator-snapshots://capture?kind=…&dataDir=…&cli=…)

    @objc private func handleURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let text = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
              let url = URLComponents(string: text) else { return }
        let query = Dictionary((url.queryItems ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { $1 })
        if let dataDir = query["dataDir"], !dataDir.isEmpty, dataDir != Config.dataDir {
            Config.setDataDir(dataDir)
            hub.resetAttachment()
        }
        if let cli = query["cli"], let data = cli.data(using: .utf8), let argv = try? JSONSerialization.jsonObject(with: data) as? [String], !argv.isEmpty {
            Config.setCli(argv)
        }
        switch url.host {
        case "capture":
            connect()
            startCapture(app: query["kind"] == "app")
        case "show":
            connect()
            panel.call("toggle")
        case "quit":
            NSApp.terminate(nil)
        default:
            break
        }
    }

    // MARK: Hotkeys

    private func hotKey(_ action: HotKeys.Action) {
        switch action {
        case .screenCapture: startCapture(app: settings.appCapture)
        case .appCapture: startCapture(app: true)
        case .toggle: panel.call("toggle")
        }
    }

    // MARK: Capture

    private func sendPermissions() {
        panel.call("permissions", ["screen": Capture.hasPermission, "accessibility": AXText.isTrusted, "screenEverGranted": permissions.screenEverGranted])
    }

    /// The icon System Settings shows for this app (its own, or the generic one until it has one), for the card's picture.
    private func appIconDataURL() -> String? {
        let image = NSWorkspace.shared.icon(forFile: Bundle.main.bundlePath)
        image.size = NSSize(width: 128, height: 128)
        guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) else { return nil }
        return "data:image/png;base64,\(png.base64EncodedString())"
    }

    private func startCapture(app: Bool) {
        guard !capturing, !permissions.isActive else { return }
        // Ask only when needed: Screen Recording at the first capture,
        // Accessibility only when an App Capture is asked for.
        guard Capture.hasPermission else {
            if permissions.screenEverGranted {
                // Turned off later: the strip says so; its Turn On opens the card.
                sendPermissions()
                panel.call("screenRecordingOff")
            } else {
                permissions.begin(.screen, pending: app ? .app : .region)
            }
            return
        }
        if app && !AXText.isTrusted && !permissions.accessibilityDeclined {
            permissions.begin(.accessibility, pending: .app)
            return
        }
        capturing = true
        permissions.clearPendingShot()
        panel.call("willCapture")
        Task { @MainActor in
            defer { capturing = false }
            if app {
                await takeAppCapture()
                return
            }
            do {
                // Freeze first: menus and hover states stay in the snapshot.
                let frozen = try await Capture.freezeAll()
                let result: OverlayController.Result = await withCheckedContinuation { continuation in
                    let controller = OverlayController(displays: frozen, startInWindowMode: false) { continuation.resume(returning: $0) }
                    overlay = controller
                    controller.show()
                }
                overlay = nil
                await handle(result)
            } catch {
                report(error)
            }
        }
    }

    private func handle(_ result: OverlayController.Result) async {
        switch result {
        case .cancelled:
            return
        case .region(let display, let rect):
            guard let image = Capture.crop(display, to: rect) else { return }
            let global = Coords.toGlobal(rect)
            let under = Capture.window(at: CGPoint(x: global.midX, y: global.midY))
            await register(image: image, from: rect, kind: "region", window: under, scale: display.scale)
        case .display(let display):
            await register(image: display.image, from: display.screen.frame, kind: "display", window: nil, scale: display.scale)
        case .window(let window, let display):
            do {
                let image = try await Capture.window(window.id)
                await register(image: image, from: Coords.toAppKit(window.bounds), kind: "window", window: window, scale: display?.scale ?? 2)
            } catch {
                report(error)
            }
        }
    }

    /// ⌥⇧⌘5: the frontmost window, plus its accessibility text, with no picker.
    private func takeAppCapture() async {
        guard let window = Capture.frontmostWindow() else {
            report(CaptureError.failed("There is no window to capture."))
            return
        }
        do {
            async let image = Capture.window(window.id)
            let text = await Task.detached { AXText.capture(pid: window.pid, bundleId: window.bundleId, windowTitle: window.title, frame: window.bounds) }.value
            let scale = NSScreen.screens.first { $0.frame.intersects(Coords.toAppKit(window.bounds)) }?.backingScaleFactor ?? 2
            await register(image: try await image, from: Coords.toAppKit(window.bounds), kind: "app", window: window, scale: scale, text: text)
        } catch {
            report(error)
        }
    }

    private func register(image: CGImage, from rect: NSRect, kind: String, window: WindowInfo?, scale: CGFloat, text: AXText.Result? = nil) async {
        let captureId = UUID().uuidString.lowercased()
        let incoming = Config.incomingDir
        try? FileManager.default.createDirectory(atPath: incoming, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let file = (incoming as NSString).appendingPathComponent("\(captureId).png")
        do {
            try Capture.writePNG(image, to: file)
            var body: [String: Any] = ["captureId": captureId, "file": file, "kind": kind, "width": image.width, "height": image.height, "display": ["scale": Double(scale)]]
            if let window {
                var source: [String: Any] = ["app": window.app, "windowTitle": window.title, "pid": Int(window.pid)]
                if let bundleId = window.bundleId { source["bundleId"] = bundleId }
                if let url = text?.url { source["url"] = url }
                body["source"] = source
            }
            if let text {
                if let content = text.text {
                    let textFile = (incoming as NSString).appendingPathComponent("\(captureId).txt")
                    FileManager.default.createFile(atPath: textFile, contents: content.data(using: .utf8), attributes: [.posixPermissions: 0o600])
                    body["textFile"] = textFile
                } else if let reason = text.unavailable {
                    body["textUnavailable"] = reason
                }
            }
            let answer = try await hub.registerCapture(body)
            log("captured \(answer.snapshot.id) (\(kind), \(image.width)×\(image.height))")
            flights[captureId] = (Flight(image: image, from: rect), image, rect)
            panel.call("captured", ["captureId": captureId, "snapshotId": answer.snapshot.id, "collectionId": answer.collectionId, "first": answer.first])
            // The flight waits for the page to say where the slot is; never forever.
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.flights.removeValue(forKey: captureId)?.flight.remove() }
        } catch {
            report(error)
        }
    }

    private func report(_ error: Error) {
        log("capture failed: \(error.localizedDescription)")
        if case CaptureError.noPermission = error {
            sendPermissions()
            panel.call("screenRecordingOff")
        } else if !Capture.hasPermission || (error as NSError).domain == SCStreamErrorDomain {
            // ScreenCaptureKit refused (the switch was turned off while running).
            sendPermissions()
            panel.call("screenRecordingOff")
        } else {
            panel.call("captureFailed", error.localizedDescription)
        }
    }

    // MARK: Messages from the page

    private func pageMessage(_ message: [String: Any]) {
        switch message["type"] as? String {
        case "ready":
            // A (re)loaded page starts empty: put back a permission card that is still open.
            permissions.redraw()
        case "capture":
            startCapture(app: message["kind"] as? String == "app")
        case "permission.begin":
            // "Turn On" in the strip or the text view, or the ◫ toggle: the card, with nothing pending.
            let kind = PermissionFlow.Kind(rawValue: message["kind"] as? String ?? "") ?? .screen
            if !permissions.isActive { permissions.begin(kind, pending: nil) }
        case "permission.request":
            permissions.request()
        case "permission.decline":
            permissions.decline()
        case "permission.cancel":
            permissions.cancel()
        case "permission.reopen":
            permissions.reopen()
        case "flightTarget":
            guard let captureId = message["captureId"] as? String, let entry = flights[captureId], let rect = message["rect"] as? [String: Any] else { return }
            let target = panel.screenRect(fromPage: rect)
            // The panel may still be growing into place: let it settle a frame first.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                entry.flight.fly(to: target) { self?.panel.call("flightDone", captureId) }
            }
        case "flightLanded":
            if let captureId = message["captureId"] as? String { flights.removeValue(forKey: captureId)?.flight.remove() }
        case "settings":
            settings.appCapture = message["appCapture"] as? Bool ?? false
            settings.explainerSeen = message["explainerSeen"] as? Bool ?? false
            appCaptureItem?.state = settings.appCapture ? .on : .off
        case "openSettings":
            let pane = message["pane"] as? String == "accessibility" ? "Privacy_Accessibility" : "Privacy_ScreenCapture"
            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") { NSWorkspace.shared.open(url) }
        case "clipboard":
            let board = NSPasteboard.general
            board.clearContents()
            var items: [NSPasteboardWriting] = []
            if let files = message["files"] as? [String] { items += files.map { URL(fileURLWithPath: $0) as NSURL } }
            if let text = message["text"] as? String, items.isEmpty { board.setString(text, forType: .string) }
            if !items.isEmpty {
                board.writeObjects(items)
                if let text = message["text"] as? String { board.setString(text, forType: .string) }
            }
        default:
            break
        }
    }

    // MARK: Menu-bar item

    private var appCaptureItem: NSMenuItem?

    private func setUpStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        // The owner's own menu-bar mark drops in as Resources/MenuBarIcon.png (+ @2x), a template image; until then a system symbol.
        let custom = Bundle.main.image(forResource: "MenuBarIcon")
        custom?.size = NSSize(width: 18, height: 18)
        item.button?.image = custom ?? NSImage(systemSymbolName: "camera.viewfinder", accessibilityDescription: "Plannotator Snapshots")
        item.button?.image?.isTemplate = true
        item.button?.setAccessibilityLabel("Plannotator Snapshots")
        let menu = NSMenu()
        menu.addItem(menuItem("Screen Capture", "4", #selector(menuScreenCapture)))
        menu.addItem(menuItem("App Capture", "5", #selector(menuAppCapture)))
        menu.addItem(menuItem("Screen Capture in 3 Seconds", "", #selector(menuDelayedScreenCapture)))
        menu.addItem(menuItem("Show HUD", "p", #selector(menuToggle)))
        menu.addItem(.separator())
        let appCaptureToggle = menuItem("App Capture for ⌥⇧⌘4", "", #selector(menuToggleAppCapture))
        appCaptureItem = appCaptureToggle
        menu.addItem(appCaptureToggle)
        menu.addItem(.separator())
        menu.addItem(menuItem("Screen Recording…", "", #selector(menuScreenSettings)))
        menu.addItem(menuItem("Accessibility…", "", #selector(menuAccessibilitySettings)))
        menu.addItem(.separator())
        menu.addItem(menuItem("Quit Plannotator Snapshots", "q", #selector(menuQuit)))
        menu.delegate = self
        item.menu = menu
        statusItem = item
    }

    private func menuItem(_ title: String, _ key: String, _ action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        if ["4", "5", "p"].contains(key) { item.keyEquivalentModifierMask = [.option, .shift, .command] }
        item.target = self
        return item
    }

    @objc private func menuScreenCapture() { startCapture(app: false) }
    @objc private func menuAppCapture() { startCapture(app: true) }
    @objc private func menuDelayedScreenCapture() {
        // Menus that are open block global hotkeys; this one closes, waits, and shoots.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in self?.startCapture(app: false) }
    }
    @objc private func menuToggle() { panel.call("toggle") }
    @objc private func menuToggleAppCapture() {
        Task { @MainActor in
            guard let attached = try? await hub.attach() else { return }
            _ = try? await hub.post(entry: attached.entry, token: attached.hudToken, path: "/api/snapshots/settings", json: ["appCapture": !settings.appCapture])
        }
    }
    @objc private func menuScreenSettings() {
        if Capture.hasPermission { permissions.openPane(.screen) } else if !permissions.isActive { permissions.begin(.screen, pending: nil) }
    }
    @objc private func menuAccessibilitySettings() {
        if AXText.isTrusted { permissions.openPane(.accessibility) } else if !permissions.isActive { permissions.begin(.accessibility, pending: nil) }
    }
    @objc private func menuQuit() { NSApp.terminate(nil) }
}

extension AppDelegate: NSMenuDelegate {
    func menuWillOpen(_ menu: NSMenu) {
        menu.items.first { $0.action == #selector(menuScreenSettings) }?.title = Capture.hasPermission ? "Screen Recording ✓" : "Turn On Screen Recording…"
        menu.items.first { $0.action == #selector(menuAccessibilitySettings) }?.title = AXText.isTrusted ? "Accessibility ✓" : "Turn On Accessibility…"
    }
}

