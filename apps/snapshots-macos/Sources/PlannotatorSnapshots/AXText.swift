import AppKit
import ApplicationServices

/// An App Capture's window text: the window's accessibility tree walked into an
/// indented outline ("role  text"), the way a person reads the window, so the
/// agent can quote exact strings, labels and URLs instead of reading pixels.
///
/// Secure text fields are never read, apps on the exclusion list give no text
/// at all, and the walk stops at a time budget so a huge or slow tree never
/// holds the capture.
enum AXText {
    struct Result {
        let text: String?
        let url: String?
        /// Why there is no text.
        let unavailable: String?
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
            return Result(text: nil, url: nil, unavailable: "this app is on the exclusion list")
        }
        guard isTrusted else { return Result(text: nil, url: nil, unavailable: "Accessibility is off") }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.25)
        guard let window = matchWindow(app: app, title: windowTitle, frame: frame) else {
            return Result(text: nil, url: nil, unavailable: "the window exposes no accessibility tree")
        }
        var result = walk(window)
        if isSparse(result.lines) {
            // Chromium builds its web-content tree only for an assistive app
            // that asks (AXEnhancedUserInterface), Electron for
            // AXManualAccessibility. Asked only when the tree has no content.
            AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
            AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
            Thread.sleep(forTimeInterval: 0.5)
            let again = walk(window)
            if again.lines.count > result.lines.count { result = again }
        }
        let text = result.lines.joined(separator: "\n")
        return Result(text: text.isEmpty ? nil : text + (result.cut ? "\n[… the rest of the window text was not read in time]" : ""), url: result.url, unavailable: text.isEmpty ? "the window exposes no text" : nil)
    }

    /// Only chrome (buttons, menus), no text or page content.
    private static func isSparse(_ lines: [String]) -> Bool {
        let content = lines.filter { line in
            let role = line.trimmingCharacters(in: .whitespaces).split(separator: " ").first ?? ""
            return ["text", "page", "heading", "link", "cell", "field"].contains(String(role))
        }
        return content.count < 3
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

    private static func walk(_ root: AXUIElement) -> (lines: [String], url: String?, cut: Bool) {
        let deadline = Date().addingTimeInterval(budget)
        var lines: [String] = []
        var url: String?
        var cut = false
        var seen = Set<String>()

        func visit(_ element: AXUIElement, depth: Int) {
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
                }
                nextDepth = depth + 1
            }
            guard let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] else { return }
            for child in children {
                visit(child, depth: nextDepth)
                if cut { return }
            }
        }

        visit(root, depth: 0)
        return (lines, url, cut)
    }
}
