import AppKit
import ScreenCaptureKit

/// The first-run permission flow (approved: .product/approved/screenshot-hud/
/// permissions.html). One card per permission, asked only when needed:
/// Screen Recording at the first capture, Accessibility only for App shots.
///
///   ask      → the card: the exact switch row, enlarged, and one button
///   waiting  → after the button: macOS's own request the first time
///              (registers the app in the System Settings list), the deep
///              link to the pane every later time; checked every second
///   reopen   → only when the switch is on but this process still cannot
///              capture (macOS hands some grants over only on relaunch)
///   granted  → a check for under a second, then the pending shot runs
///
/// The live check for Screen Recording is a real ScreenCaptureKit listing
/// (the preflight can lag the switch); it runs only after the app made its
/// one request, so polling never raises a prompt by itself.
@MainActor
final class PermissionFlow {
    enum Kind: String { case screen, accessibility }
    enum State: String { case ask, waiting, reopen, granted }
    enum Pending: String { case region, app }

    private let defaults = UserDefaults.standard
    private var timer: Timer?
    private(set) var kind: Kind?
    private var pending: Pending?
    /// Calls the page (`shotsHud.permission({ kind, state })`).
    var show: (([String: Any]) -> Void)?
    /// Runs the shot the user asked for once the permission is there.
    var resume: ((Pending?) -> Void)?
    /// App shots without text, for this session ("Not now").
    private(set) var accessibilityDeclined = false

    // MARK: State that outlives a relaunch

    private var requestedScreen: Bool {
        get { defaults.bool(forKey: "requestedScreenRecording") }
        set { defaults.set(newValue, forKey: "requestedScreenRecording") }
    }
    private var requestedAccessibility: Bool {
        get { defaults.bool(forKey: "requestedAccessibility") }
        set { defaults.set(newValue, forKey: "requestedAccessibility") }
    }
    /// Screen Recording worked here once: a later refusal means it was turned off.
    var screenEverGranted: Bool {
        get { defaults.bool(forKey: "screenRecordingWasGranted") }
        set { defaults.set(newValue, forKey: "screenRecordingWasGranted") }
    }

    var isActive: Bool { kind != nil }

    // MARK: Checks

    static func screenWorks() async -> Bool {
        do {
            _ = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            return true
        } catch {
            return false
        }
    }

    // MARK: Flow

    /// Show the card for `kind`; `pending` runs once it is granted.
    func begin(_ kind: Kind, pending: Pending?) {
        self.kind = kind
        self.pending = pending
        // A shot started before macOS made the app quit and reopen resumes after it.
        if let pending { defaults.set(["action": pending.rawValue, "kind": kind.rawValue, "at": Date().timeIntervalSince1970], forKey: "pendingShot") }
        log("permission \(kind.rawValue): ask (pending \(pending?.rawValue ?? "none"))")
        show?(["kind": kind.rawValue, "state": State.ask.rawValue])
        startChecking()
    }

    /// The card's button.
    func request() {
        guard let kind else { return }
        switch kind {
        case .screen:
            if !requestedScreen {
                requestedScreen = true
                let granted = CGRequestScreenCaptureAccess()
                log("permission screen: CGRequestScreenCaptureAccess() -> \(granted)")
            } else {
                openPane(kind)
            }
        case .accessibility:
            if !requestedAccessibility {
                requestedAccessibility = true
                let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
                let trusted = AXIsProcessTrustedWithOptions(options)
                log("permission accessibility: AXIsProcessTrustedWithOptions(prompt) -> \(trusted)")
            } else {
                openPane(kind)
            }
        }
        show?(["kind": kind.rawValue, "state": State.waiting.rawValue])
    }

    func openPane(_ kind: Kind) {
        let pane = kind == .screen ? "Privacy_ScreenCapture" : "Privacy_Accessibility"
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?\(pane)") { NSWorkspace.shared.open(url) }
        log("permission \(kind.rawValue): opened System Settings › \(pane)")
    }

    /// "Not now" (App shots): take the window without its text.
    func decline() {
        guard kind == .accessibility else { return }
        accessibilityDeclined = true
        let pending = self.pending
        finish(showCheck: false)
        log("permission accessibility: not now")
        resume?(pending)
    }

    /// Esc on the card: nothing is taken.
    func cancel() {
        log("permission \(kind?.rawValue ?? "?"): closed")
        finish(showCheck: false)
    }

    private func startChecking() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.check() }
        }
    }

    private var checking = false
    private var reopenShown = false

    private func check() async {
        guard let kind, !checking else { return }
        checking = true
        defer { checking = false }
        switch kind {
        case .screen:
            // Before the one request, only the silent preflight: a ScreenCaptureKit
            // call while undetermined would raise the prompt by itself.
            if !requestedScreen {
                if CGPreflightScreenCaptureAccess() { granted() }
                return
            }
            if await Self.screenWorks() {
                granted()
            } else if CGPreflightScreenCaptureAccess() && !reopenShown {
                // The switch is on, but this process cannot capture yet.
                reopenShown = true
                log("permission screen: switch on, capture refused in this process: reopen")
                show?(["kind": kind.rawValue, "state": State.reopen.rawValue])
            }
        case .accessibility:
            if AXIsProcessTrusted() { granted() }
        }
    }

    private func granted() {
        guard let kind else { return }
        if kind == .screen { screenEverGranted = true }
        log("permission \(kind.rawValue): granted")
        let pending = self.pending
        finish(showCheck: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.9) { [weak self] in
            self?.show?(["kind": kind.rawValue, "state": "done"])
            self?.resume?(pending)
        }
    }

    private func finish(showCheck: Bool) {
        timer?.invalidate()
        timer = nil
        if showCheck, let kind { show?(["kind": kind.rawValue, "state": State.granted.rawValue]) }
        if !showCheck { show?(["kind": kind?.rawValue ?? "", "state": "done"]) }
        kind = nil
        pending = nil
        reopenShown = false
        defaults.removeObject(forKey: "pendingShot")
    }

    /// Relaunch through LaunchServices; the pending shot is kept and resumes.
    func reopen() {
        log("permission: reopening")
        let path = Bundle.main.bundlePath.replacingOccurrences(of: "'", with: "'\\''")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "sleep 0.7; /usr/bin/open -a '\(path)'"]
        try? process.run()
        NSApp.terminate(nil)
    }

    /// After a relaunch: a shot started before it, and still recent, carries on.
    func resumeAfterLaunch() {
        guard let saved = defaults.dictionary(forKey: "pendingShot"),
              let action = Pending(rawValue: saved["action"] as? String ?? ""),
              let kind = Kind(rawValue: saved["kind"] as? String ?? ""),
              let at = saved["at"] as? Double, Date().timeIntervalSince1970 - at < 600
        else {
            defaults.removeObject(forKey: "pendingShot")
            return
        }
        log("permission: resuming a \(action.rawValue) shot after relaunch")
        self.kind = kind
        self.pending = action
        show?(["kind": kind.rawValue, "state": State.waiting.rawValue])
        startChecking()
    }
}
