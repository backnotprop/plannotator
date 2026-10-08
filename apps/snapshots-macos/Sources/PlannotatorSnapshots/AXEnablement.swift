import AppKit
import ApplicationServices

/// Turning on an app's accessibility tree before App Capture reads it, so a person
/// never has to open chrome://accessibility by hand.
///
/// Chromium (Chrome, Edge, Brave, Arc, …) and Electron (Slack, VS Code, Discord,
/// Notion, …) build the tree of their web content only when an assistive app asks.
/// The supported way to ask is `AXManualAccessibility = true` on the application
/// element: Electron documents it for third-party assistive apps, and Chromium
/// answers it the same way. Codex's Appshots does the same (see
/// `ApplicationUIElement.enableAccessibilityIfNeeded` in its capture service).
///
/// `AXEnhancedUserInterface` is the attribute VoiceOver sets. It is NOT written by
/// default: AppKit animates every window frame change while it is on, which makes
/// window managers (Rectangle, Magnet, Amethyst) slow and jumpy in that app, and
/// Chromium reads it as "a screen reader is running". It is used only as a
/// fallback for a known Chromium browser that refuses `AXManualAccessibility`
/// (a build too old to know it), and then put back right after the read.
///
/// `AXManualAccessibility` is written once per process and left on: turning it off
/// after each capture would make Chrome drop the tree and rebuild it (seconds on a
/// big page) on the next capture. It lasts only until that app quits, nothing is
/// written to disk, and it is the state any assistive app (VoiceOver, Grammarly,
/// a password manager) leaves the app in.
enum AXEnablement {
    enum Family: Equatable {
        /// A Chromium browser: Chrome, Chromium, Edge, Brave, Arc, Opera, Vivaldi, ….
        case chromium
        /// An Electron app: Slack, VS Code, Discord, Notion, ….
        case electron
        case other
    }

    /// What to do about the tree before the window is read.
    enum Step: Equatable {
        /// Ask, then wait (bounded) for the web content to appear, then read: a
        /// Chromium or Electron app not yet asked in this process.
        case beforeWalk
        /// Read first; ask only when the tree came back with no content. Covers an
        /// app we do not know (writing an attribute an app does not know is refused
        /// harmlessly, kAXErrorAttributeUnsupported) and one already asked whose
        /// tree has gone empty again. Writing `true` again is not a toggle.
        case ifSparse
    }

    static let manualAttribute = "AXManualAccessibility"
    static let enhancedAttribute = "AXEnhancedUserInterface"

    /// The longest App Capture waits for a tree that was just turned on.
    static let settleLimit: TimeInterval = 0.6
    static let pollInterval: TimeInterval = 0.1
    /// Budget kept for the walk itself after waiting.
    static let walkReserve: TimeInterval = 0.8

    static let chromiumBundleIds: Set<String> = [
        "com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary",
        "org.chromium.Chromium", "com.google.chrome.for.testing",
        "com.microsoft.edgemac", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Dev", "com.microsoft.edgemac.Canary",
        "com.brave.Browser", "com.brave.Browser.beta", "com.brave.Browser.nightly",
        "company.thebrowser.Browser", "company.thebrowser.dia",
        "com.operasoftware.Opera", "com.operasoftware.OperaGX",
        "com.vivaldi.Vivaldi", "com.vivaldi.Vivaldi.snapshot",
        "ru.yandex.desktop.yandex-browser", "net.imput.helium",
    ]

    /// Electron apps carry this framework in Contents/Frameworks.
    static let electronFramework = "Electron Framework.framework"

    /// Frameworks a Chromium browser carries (the bundle id list misses rebrands).
    static let chromiumFrameworks: Set<String> = [
        "Chromium Framework.framework", "Google Chrome Framework.framework", "Microsoft Edge Framework.framework",
        "Brave Browser Framework.framework", "Vivaldi Framework.framework", "Opera Framework.framework",
    ]

    /// Which kind of app this is, from its bundle id and the names in Contents/Frameworks.
    static func family(bundleId: String?, frameworks: [String]) -> Family {
        if frameworks.contains(electronFramework) { return .electron }
        if let bundleId, chromiumBundleIds.contains(bundleId) || bundleId.hasPrefix("com.google.Chrome.") { return .chromium }
        if frameworks.contains(where: chromiumFrameworks.contains) { return .chromium }
        return .other
    }

    static func step(family: Family, alreadyEnabled: Bool) -> Step {
        family != .other && !alreadyEnabled ? .beforeWalk : .ifSparse
    }

    /// Whether to fall back to `AXEnhancedUserInterface`: only a known Chromium browser
    /// that refused `AXManualAccessibility` outright. A timeout (the app was busy) is
    /// not a refusal, and Electron always knows `AXManualAccessibility`.
    static func useEnhancedFallback(family: Family, manualResult: AXError) -> Bool {
        guard family == .chromium else { return false }
        switch manualResult {
        case .attributeUnsupported, .illegalArgument, .failure, .notImplemented: return true
        default: return false
        }
    }

    /// Whether a write means the tree is now on (and need not be asked again in this process).
    static func accepted(_ result: AXError) -> Bool { result == .success }

    /// How long to wait for a tree that was just turned on: at most `settleLimit`, and
    /// never into the share of the budget the walk needs.
    static func settleTime(now: Date, deadline: Date) -> TimeInterval {
        max(0, min(settleLimit, deadline.timeIntervalSince(now) - walkReserve))
    }

    // MARK: Per-process memory

    /// A process identity that survives pid reuse: the pid plus when it launched.
    static func processKey(pid: pid_t, launched: Date?) -> String {
        "\(pid)@\(launched.map { String(Int($0.timeIntervalSince1970 * 1000)) } ?? "?")"
    }

    private static let lock = NSLock()
    private static var enabled = Set<String>()

    static func wasEnabled(_ key: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return enabled.contains(key)
    }

    static func markEnabled(_ key: String) {
        lock.lock()
        defer { lock.unlock() }
        enabled.insert(key)
    }

    // MARK: The app on disk

    static func frameworks(of pid: pid_t) -> [String] {
        guard let url = NSRunningApplication(processIdentifier: pid)?.bundleURL else { return [] }
        let dir = url.appendingPathComponent("Contents/Frameworks").path
        return (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
    }

    // MARK: Writes

    /// Asks the app to build its tree with `AXManualAccessibility`. Returns the write's result.
    @discardableResult
    static func enableManual(_ app: AXUIElement) -> AXError {
        AXUIElementSetAttributeValue(app, manualAttribute as CFString, kCFBooleanTrue)
    }

    /// Whether the fallback writes `AXEnhancedUserInterface` and resets it to false after the
    /// capture. Only an explicit `true` read beforehand (a screen reader such as VoiceOver
    /// set it) is left alone; off or unknown is written and always reset, so the attribute
    /// never outlives the capture.
    static func enhancedIsOurs(before: Bool?) -> Bool { before != true }

    /// `AXEnhancedUserInterface` on, for the fallback. Returns the reset to run after the
    /// capture (a no-op when it was already on), or nil when the write was refused.
    static func enableEnhancedTemporarily(_ app: AXUIElement) -> ((AXUIElement) -> Void)? {
        var before: AnyObject?
        let read = AXUIElementCopyAttributeValue(app, enhancedAttribute as CFString, &before) == .success ? before as? Bool : nil
        guard enhancedIsOurs(before: read) else { return { _ in } }
        guard AXUIElementSetAttributeValue(app, enhancedAttribute as CFString, kCFBooleanTrue) == .success else { return nil }
        return { app in AXUIElementSetAttributeValue(app, enhancedAttribute as CFString, kCFBooleanFalse) }
    }

    // MARK: Time

    /// Kept at the end of the 2 s budget for the `AXEnhancedUserInterface` reset.
    static let restoreReserve: TimeInterval = 0.1
    /// The longest any single accessibility message may wait.
    static let messageTimeout: TimeInterval = 0.25

    /// The messaging timeout for the next query: at most `messageTimeout`, never past
    /// `deadline`; nil when the deadline has passed (do not ask at all).
    static func messagingTimeout(now: Date, deadline: Date) -> Float? {
        let remaining = deadline.timeIntervalSince(now)
        guard remaining > 0.005 else { return nil }
        return Float(min(messageTimeout, remaining))
    }
}
