import AppKit
import ApplicationServices

/// An App Capture's window text: the window's accessibility tree walked into an
/// indented outline ("role  text"), the way a person reads the window, so the
/// agent can quote exact strings, labels and URLs instead of reading pixels.
///
/// Chromium and Electron apps are asked to build their tree first (see
/// AXEnablement), so Chrome needs no setting turned on by hand; an app that
/// still gives no text sends its picture on its own. Secure text fields are
/// never read, apps on the exclusion list give no text (and are never asked),
/// and one 2 s budget covers asking, waiting and the walk, so a huge or slow
/// tree never holds the capture.
enum AXText {
    struct Result {
        let text: String?
        let url: String?
        /// Why there is no text.
        let unavailable: String?
        /// What was done to turn the app's tree on, for the log and --selftest.
        let enablement: String?
    }

    /// Password managers, Keychain and Messages: a window image only.
    static let excluded: Set<String> = [
        "com.1password.1password", "com.agilebits.onepassword7", "com.agilebits.onepassword-osx",
        "com.bitwarden.desktop", "com.apple.keychainaccess", "com.apple.Passwords", "com.apple.MobileSMS",
    ]

    static var isTrusted: Bool { AXIsProcessTrusted() }

    private static let budget: TimeInterval = 2.0

    private static let roleNames: [String: String] = [
        "AXWindow": "window", "AXStaticText": "text", "AXTextField": "field", "AXTextArea": "field",
        "AXComboBox": "field", "AXSearchField": "field", "AXButton": "button", "AXLink": "link",
        "AXHeading": "heading", "AXImage": "image", "AXCheckBox": "checkbox", "AXRadioButton": "radio",
        "AXPopUpButton": "popup", "AXMenuButton": "menu", "AXMenuItem": "item", "AXTab": "tab",
        "AXTabGroup": "tabs", "AXWebArea": "page", "AXRow": "row", "AXCell": "cell", "AXTable": "table",
        "AXList": "list", "AXOutline": "outline", "AXGroup": "group", "AXToolbar": "toolbar",
        "AXSlider": "slider", "AXValueIndicator": "value", "AXDisclosureTriangle": "toggle",
        "AXScrollArea": "", "AXSplitGroup": "", "AXSplitter": "", "AXLayoutArea": "", "AXUnknown": "",
    ]

    static func capture(pid: pid_t, bundleId: String?, windowTitle: String, frame: CGRect) -> Result {
        if let bundleId, excluded.contains(bundleId) {
            return Result(text: nil, url: nil, unavailable: "this app is on the exclusion list", enablement: nil)
        }
        guard isTrusted else { return Result(text: nil, url: nil, unavailable: "Accessibility is off", enablement: nil) }
        // One budget for everything: asking for the tree, waiting for it, and the walk.
        let deadline = Date().addingTimeInterval(budget)
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.25)
        let family = AXEnablement.family(bundleId: bundleId, frameworks: AXEnablement.frameworks(of: pid))
        let key = AXEnablement.processKey(pid: pid, launched: NSRunningApplication(processIdentifier: pid)?.launchDate)
        var notes: [String] = []
        var restore: (() -> Void)?
        defer { restore?() }

        /// Asks the app to build its tree (see AXEnablement); true when it said yes.
        func ask() -> Bool {
            let manual = AXEnablement.enableManual(app)
            if AXEnablement.accepted(manual) {
                AXEnablement.markEnabled(key)
                notes.append("\(AXEnablement.manualAttribute) set")
                return true
            }
            if restore == nil, AXEnablement.useEnhancedFallback(family: family, manualResult: manual),
               let undo = AXEnablement.enableEnhancedTemporarily(app) {
                restore = undo
                notes.append("\(AXEnablement.enhancedAttribute) set for this capture (\(AXEnablement.manualAttribute) refused: \(manual.rawValue))")
                return true
            }
            notes.append("\(AXEnablement.manualAttribute) refused (\(manual.rawValue))")
            return false
        }

        /// Waits, bounded, until the window shows content, polling with a short probe walk.
        func settle(_ window: AXUIElement) {
            let started = Date()
            let until = started.addingTimeInterval(AXEnablement.settleTime(now: started, deadline: deadline))
            while true {
                let probe = walk(window, deadline: min(until, Date().addingTimeInterval(0.15)), stopAfterContent: sparseThreshold)
                if !isSparse(probe.lines) {
                    notes.append("tree ready in \(Int(Date().timeIntervalSince(started) * 1000)) ms")
                    return
                }
                if Date().addingTimeInterval(AXEnablement.pollInterval) > until { break }
                Thread.sleep(forTimeInterval: AXEnablement.pollInterval)
            }
            notes.append("no content after \(Int(Date().timeIntervalSince(started) * 1000)) ms")
        }

        let step = AXEnablement.step(family: family, alreadyEnabled: AXEnablement.wasEnabled(key))
        // Asked before looking for the window, so the app starts building at once.
        let askedFirst = step == .beforeWalk && ask()
        guard let window = matchWindow(app: app, title: windowTitle, frame: frame) else {
            return Result(text: nil, url: nil, unavailable: noText, enablement: summary(family, notes))
        }
        if askedFirst { settle(window) }
        var result = walk(window, deadline: deadline)
        if step == .ifSparse, isSparse(result.lines), !result.cut, ask() {
            settle(window)
            let again = walk(window, deadline: deadline)
            if again.lines.count > result.lines.count { result = again }
        }
        let text = result.lines.joined(separator: "\n")
        return Result(
            text: text.isEmpty ? nil : text + (result.cut ? "\n[… the rest of the window text was not read in time]" : ""),
            url: result.url,
            unavailable: text.isEmpty ? noText : nil,
            enablement: summary(family, notes)
        )
    }

    /// Why there is no text when the app gave none: the picture goes on its own (not an error).
    static let noText = "this app gave no text, so the picture is sent on its own"

    private static func summary(_ family: AXEnablement.Family, _ notes: [String]) -> String {
        "\(family)" + (notes.isEmpty ? "" : ": " + notes.joined(separator: ", "))
    }

    /// Fewer content lines than this reads as "only chrome (buttons, menus)".
    static let sparseThreshold = 3
    private static let contentRoles: Set<String> = ["text", "page", "heading", "link", "cell", "field"]

    /// Only chrome (buttons, menus), no text or page content.
    static func isSparse(_ lines: [String]) -> Bool {
        let content = lines.filter { line in
            let role = line.trimmingCharacters(in: .whitespaces).split(separator: " ").first ?? ""
            return contentRoles.contains(String(role))
        }
        return content.count < sparseThreshold
    }

    private static func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
        var value: AnyObject?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }

    private static func string(_ element: AXUIElement, _ name: String) -> String? {
        guard let value = attribute(element, name) else { return nil }
        if let text = value as? String { return text }
        if let number = value as? NSNumber { return number.stringValue }
        if CFGetTypeID(value) == CFURLGetTypeID() { return (value as! URL).absoluteString }
        return nil
    }

    private static func matchWindow(app: AXUIElement, title: String, frame: CGRect) -> AXUIElement? {
        guard let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] else {
            return attribute(app, kAXFocusedWindowAttribute).map { $0 as! AXUIElement }
        }
        func frameOf(_ window: AXUIElement) -> CGRect {
            var origin = CGPoint.zero, size = CGSize.zero
            if let value = attribute(window, kAXPositionAttribute) { AXValueGetValue(value as! AXValue, .cgPoint, &origin) }
            if let value = attribute(window, kAXSizeAttribute) { AXValueGetValue(value as! AXValue, .cgSize, &size) }
            return CGRect(origin: origin, size: size)
        }
        return windows.first { frameOf($0).integral == frame.integral }
            ?? windows.first { !title.isEmpty && string($0, kAXTitleAttribute) == title }
            ?? (attribute(app, kAXFocusedWindowAttribute).map { $0 as! AXUIElement })
            ?? windows.first
    }

    private static func clean(_ text: String) -> String {
        text.replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ⏎ ").trimmingCharacters(in: .whitespaces)
    }

    /// The window's outline, stopping at `deadline` (`cut`), or early once
    /// `stopAfterContent` content lines were found (the readiness probe).
    private static func walk(_ root: AXUIElement, deadline: Date, stopAfterContent: Int? = nil) -> (lines: [String], url: String?, cut: Bool) {
        var lines: [String] = []
        var url: String?
        var cut = false
        var enough = false
        var content = 0
        var seen = Set<String>()

        func visit(_ element: AXUIElement, depth: Int) {
            if enough { return }
            if Date() > deadline {
                cut = true
                return
            }
            let role = string(element, kAXRoleAttribute) ?? ""
            let subrole = string(element, kAXSubroleAttribute) ?? ""
            if subrole == "AXSecureTextField" {
                lines.append(String(repeating: "  ", count: depth) + "field  [secure, not read]")
                return
            }
            if role == "AXWebArea", url == nil, let found = string(element, "AXURL") { url = found }
            let name = roleNames[role] ?? role.replacingOccurrences(of: "AX", with: "").lowercased()
            let title = string(element, kAXTitleAttribute) ?? ""
            let value = role == "AXStaticText" || role.hasSuffix("TextField") || role == "AXTextArea" || role == "AXComboBox" || role == "AXSlider" || role == "AXCheckBox"
                ? string(element, kAXValueAttribute) ?? ""
                : ""
            let description = string(element, kAXDescriptionAttribute) ?? ""
            let selected = string(element, kAXSelectedTextAttribute) ?? ""
            var parts = [title, value, description].map(clean).filter { !$0.isEmpty }
            // The same string twice (a label that is also its value) reads once.
            parts = parts.reduce(into: [String]()) { acc, part in if !acc.contains(part) { acc.append(part) } }
            var nextDepth = depth
            if !name.isEmpty, !parts.isEmpty {
                var line = String(repeating: "  ", count: depth) + name.padding(toLength: max(name.count, 6), withPad: " ", startingAt: 0) + " " + parts.joined(separator: " · ")
                if role == "AXWebArea", let url, depth <= 2 { line += "  <\(url)>" }
                if !selected.isEmpty { line += "   (selected: \(clean(selected)))" }
                let key = "\(depth)|\(line)"
                if !seen.contains(key) {
                    seen.insert(key)
                    lines.append(line)
                    if contentRoles.contains(name) {
                        content += 1
                        if let stop = stopAfterContent, content >= stop { enough = true }
                    }
                }
                nextDepth = depth + 1
            }
            guard let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { return }
            for child in children {
                visit(child, depth: nextDepth)
                if cut || enough { return }
            }
        }

        visit(root, depth: 0)
        return (lines, url, cut)
    }
}
