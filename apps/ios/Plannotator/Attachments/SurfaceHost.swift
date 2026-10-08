import Foundation
import PlannotatorKit
import SwiftUI
import UIKit
import WebKit

/// What the surface tells the shell (contract section 5, "Surface to shell"),
/// as the app reads it.
enum SurfaceEvent {
    case ready
    /// A text selection settled (`draft` set) or cleared (nil).
    case selection(quote: String, draft: JSONValue?)
    /// An HTML pin landed, or Parent or Child moved it.
    case pin(label: String, draft: JSONValue)
    /// A tap on a block (pinpoint) or a diagram part: the composer opens now.
    case draft(kind: String, label: String, draft: JSONValue)
    /// A saved mark was tapped.
    case annotation(id: String)
    /// A guide's Reviewed tick: every section's tick (6.1, 6.2).
    case reviewed(messageId: String, reviewed: [Bool])
    /// The guide moved: a section is on screen, or the sections with nil (6.1, 6.2).
    case section(messageId: String, section: Int?, sections: Int)
    case error(code: String, message: String)
}

/// Plannotator's surface (`apps/hook/dist/surface.html`, bundled) in one
/// `WKWebView` the app keeps warm: the attachment screens (4.1 to 4.4) and
/// the guided review (6.1, 6.2) show it, and Send asks it for the
/// annotations' feedback text.
///
/// - `plannotator-surface://app/surface.html` serves the bundled file.
/// - `plannotator-asset://inbox/api/html-assets/<token>/<path>` serves the
///   open HTML page's own folder through the device door (exchange 7.16),
///   so its relative files load and the token never reaches web content.
/// - Bridge messages are taken from the main frame only: an agent's page,
///   in the surface's sandboxed frame, can post to the handler too.
/// - Links open only for `https` and `mailto`: the surface's own `link` (its
///   markdown, a real tap), or a new window an agent's page opened right after
///   the person's touch; every other navigation away is cancelled.
@Observable
final class SurfaceHost: NSObject {
    static let shared = SurfaceHost()

    @ObservationIgnored let webView: SurfaceWebView
    @ObservationIgnored let assets = AssetSchemeHandler()
    private(set) var isReady = false
    /// The offline rule list could not be compiled, so the surface is never loaded.
    private(set) var isUnavailable = false
    /// Bridge messages that came from a frame other than the main one, dropped.
    private(set) var droppedFrameMessages = 0
    /// Pins and selections reported for an agent's HTML page with no touch of the person's just before, dropped.
    private(set) var droppedUntouched = 0
    /// Navigations away from the surface the shell refused.
    private(set) var cancelledNavigations = 0
    /// The surface itself failed to load: files cannot be opened until the app restarts.
    private(set) var loadError: String?
    /// What the proof reads when a first open never draws: loads, web content ends, the rule list.
    private(set) var trace = "loads=0"
    @ObservationIgnored private var loads = 0
    @ObservationIgnored private var terminations = 0
    @ObservationIgnored private var rules = "pending"
    @ObservationIgnored private var readyWatch: Task<Void, Never>?
    /// An agent's HTML page is open: its pins and selections are page-reported
    /// (contract section 5), so one counts only right after the person's own touch.
    @ObservationIgnored var pageReported = false
    @ObservationIgnored private let touches = TouchStamp()

    /// The screen showing the surface: its events, and the links it opens.
    @ObservationIgnored var onEvent: ((SurfaceEvent) -> Void)?
    @ObservationIgnored var onLink: ((ContentLink) -> Void)?

    @ObservationIgnored private var loaded = false
    @ObservationIgnored private var outbox: [String] = []
    @ObservationIgnored private var readyWaiters: [CheckedContinuation<Void, Never>] = []
    @ObservationIgnored private var feedbackWaiters: [String: CheckedContinuation<String?, Never>] = [:]

    static let surfaceURL = URL(string: "plannotator-surface://app/surface.html")!

    override private init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(SurfaceSchemeHandler(), forURLScheme: "plannotator-surface")
        config.setURLSchemeHandler(assets, forURLScheme: "plannotator-asset")
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.dataDetectorTypes = []
        webView = SurfaceWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.add(self, name: "plannotatorSurface")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        touches.cancelsTouchesInView = false
        touches.delaysTouchesBegan = false
        touches.delaysTouchesEnded = false
        touches.delegate = touches
        webView.addGestureRecognizer(touches)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        #if DEBUG
        webView.isInspectable = true
        #endif
    }

    /// Loads the surface once; later calls do nothing. The web view never
    /// reaches the network: every http, https, ws and wss load is blocked by a
    /// content rule list before the surface loads (Safari View Controller, a
    /// separate view, opens links). Without the rule list the surface is never
    /// loaded and files cannot be opened (`isUnavailable`).
    func warm() {
        guard !loaded else { return }
        loaded = true
        Task {
            guard let list = try? await WKContentRuleListStore.default().compileContentRuleList(
                forIdentifier: "plannotator-surface-offline", encodedContentRuleList: Self.offlineRules) else {
                rules = "refused"
                isUnavailable = true
                releaseWaiters()
                return
            }
            rules = "ok"
            webView.configuration.userContentController.add(list)
            load()
        }
    }

    /// Every http, https, ws and wss load is blocked, except an http or https
    /// request to open a new window: that is how a tapped link in an agent's
    /// page reaches `createWebViewWith`, which never makes a web view for it.
    /// (A content rule's url-filter has no alternation, so ws and wss are a rule of their own.)
    static let offlineRules = #"[{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}},{"trigger":{"url-filter":"^wss?://"},"action":{"type":"block"}},{"trigger":{"url-filter":"^https?://","resource-type":["popup"]},"action":{"type":"ignore-previous-rules"}}]"#

    /// The policy every file of an agent's page folder is served under: the
    /// surface's own (`apps/inbox/surface.html`), so a page the agent's page
    /// embeds from its folder is as offline as the page itself.
    static let assetPolicy = "default-src 'none'; script-src 'unsafe-inline' plannotator-asset:; style-src 'unsafe-inline' plannotator-asset: data:; img-src plannotator-asset: data: blob:; font-src plannotator-asset: data:; media-src plannotator-asset: data: blob:; frame-src plannotator-asset: about: data: blob:; worker-src blob:; connect-src 'none'; base-uri plannotator-asset:; form-action 'none'"

    private func load() {
        loads += 1
        updateTrace()
        webView.load(URLRequest(url: Self.surfaceURL))
    }

    private func releaseWaiters() {
        updateTrace()
        readyWaiters.forEach { $0.resume() }
        readyWaiters = []
    }

    private func updateTrace() {
        trace = "loads=\(loads) ended=\(terminations) rules=\(rules) ready=\(isReady) error=\(loadError ?? "none")"
    }

    /// Waits for the surface, or returns at once when it cannot load (`isUnavailable`, `loadError`).
    func whenReady() async {
        warm()
        if isReady || isUnavailable || loadError != nil { return }
        watchReady()
        await withCheckedContinuation { readyWaiters.append($0) }
    }

    /// Someone is waiting on a loaded surface that has said nothing for 30 s (seen
    /// on a CI simulator: loaded, no failure, no "ready"): load it again, twice at most.
    private func watchReady() {
        guard readyWatch == nil else { return }
        readyWatch = Task { [weak self] in
            for _ in 0..<2 {
                try? await Task.sleep(for: .seconds(30))
                guard let self, !Task.isCancelled, !self.isReady, !self.isUnavailable, self.loadError == nil, self.rules == "ok" else { break }
                self.load()
            }
            self?.readyWatch = nil
        }
    }

    /// Sends a message to the surface (`window.plannotatorSurface.receive`),
    /// queued until it is ready.
    func send(_ message: some Encodable) {
        guard let data = try? JSONEncoder().encode(message), let json = String(data: data, encoding: .utf8) else { return }
        guard isReady else {
            outbox.append(json)
            warm()
            return
        }
        deliver(json)
    }

    private func deliver(_ json: String) {
        webView.callAsyncJavaScript("window.plannotatorSurface.receive(JSON.parse(m))", arguments: ["m": json], in: nil, in: .page) { _ in }
    }

    /// The theme and the Dynamic Type size: the body size at this size over the default's (17 pt).
    func sendAppearance(scheme: ColorScheme, typeSize: DynamicTypeSize) {
        let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(typeSize))
        let scale = UIFontMetrics(forTextStyle: .body).scaledValue(for: 17, compatibleWith: traits) / 17
        send(Bridge.SetAppearance(theme: scheme == .dark ? "dark" : "light", text_scale: Double(scale)))
    }

    /// Waits until the surface has painted what it was last sent (two animation frames).
    func drawn() async {
        _ = try? await webView.callAsyncJavaScript("await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))", contentWorld: .page)
    }

    /// Send's feedback text for these annotations (contract section 5,
    /// `export_feedback`): Plannotator's own export, as the window writes it.
    func feedback(annotations: [InboxAnnotationRecord], attachments: [InboxAttachmentState], texts: [Bridge.Text], projectRoot: String) async -> String? {
        await whenReady()
        guard !isUnavailable else { return nil }
        let id = UUID().uuidString
        return await withCheckedContinuation { continuation in
            feedbackWaiters[id] = continuation
            send(Bridge.ExportFeedback(id: id, annotations: annotations, attachments: attachments, texts: texts, project_root: projectRoot))
        }
    }

    /// The shell moved the pin itself (Parent or Child): the pin that follows is the person's.
    func stampTouch() {
        touches.last = .now
    }

    /// A page-reported pin, selection or draft counts only within a second of a touch.
    private func touched() -> Bool {
        guard pageReported else { return true }
        if Date.now.timeIntervalSince(touches.last) < 1.2 { return true }
        droppedUntouched += 1
        return false
    }

    // MARK: Links

    fileprivate func open(_ url: URL) {
        guard let link = ContentLink(url) else { return }
        onLink?(link)
    }

    fileprivate func receive(_ body: JSONValue) {
        guard body["v"] == .number(1), let type = body["type"]?.string else { return }
        switch type {
        case "ready":
            isReady = true
            readyWatch?.cancel()
            readyWatch = nil
            updateTrace()
            let queued = outbox
            outbox = []
            queued.forEach(deliver)
            readyWaiters.forEach { $0.resume() }
            readyWaiters = []
            onEvent?(.ready)
        case "selection":
            let draft = body["draft"].flatMap { $0 == .null ? nil : $0 }
            if draft != nil, !touched() { return }
            onEvent?(.selection(quote: body["quote"]?.string ?? "", draft: draft))
        case "pin":
            guard let draft = body["draft"], touched() else { return }
            onEvent?(.pin(label: body["target"]?["label"]?.string ?? "", draft: draft))
        case "draft":
            guard let draft = body["draft"], touched() else { return }
            onEvent?(.draft(kind: body["target"]?["kind"]?.string ?? "block", label: body["target"]?["label"]?.string ?? "", draft: draft))
        case "annotation":
            if let id = body["id"]?.string { onEvent?(.annotation(id: id)) }
        case "reviewed":
            guard let id = body["message_id"]?.string, case .array(let values)? = body["reviewed"] else { return }
            onEvent?(.reviewed(messageId: id, reviewed: values.map { $0 == .bool(true) }))
        case "section":
            guard let id = body["message_id"]?.string, case .number(let sections)? = body["sections"] else { return }
            let section: Int? = if case .number(let n)? = body["section"] { Int(n) } else { nil }
            onEvent?(.section(messageId: id, section: section, sections: Int(sections)))
        case "link":
            if let href = body["href"]?.string, let url = URL(string: href) { open(url) }
        case "feedback":
            if let id = body["id"]?.string { feedbackWaiters.removeValue(forKey: id)?.resume(returning: body["text"]?.string ?? "") }
        case "error":
            onEvent?(.error(code: body["code"]?.string ?? "", message: body["message"]?.string ?? ""))
        default:
            break
        }
    }
}

extension SurfaceHost: WKScriptMessageHandler {
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        // The surface itself speaks from the main frame. An agent's page runs in
        // a frame of its own and can post here too; it is never heard.
        guard message.frameInfo.isMainFrame else {
            droppedFrameMessages += 1
            return
        }
        guard JSONSerialization.isValidJSONObject(message.body),
              let data = try? JSONSerialization.data(withJSONObject: message.body),
              let body = try? JSONDecoder().decode(JSONValue.self, from: data) else { return }
        receive(body)
    }
}

extension SurfaceHost: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if action.targetFrame?.isMainFrame ?? false {
            return url == Self.surfaceURL ? .allow : .cancel
        }
        // The agent's page itself (its srcdoc frame), and frames it embeds from
        // its own folder. A script moving the agent's frame anywhere is cancelled.
        if url.absoluteString == "about:srcdoc" || url.absoluteString == "about:blank" { return .allow }
        if url.scheme == "plannotator-asset", action.targetFrame?.request.url?.absoluteString != "about:srcdoc" { return .allow }
        cancelledNavigations += 1
        return .cancel
    }

    /// A link the person tapped in an agent's page opens as a new window (ui's
    /// `hostNavigates`). No web view is ever made for it: the shell opens the
    /// URL itself, and only right after the person's own touch.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        if Date.now.timeIntervalSince(touches.last) < 1.2 { open(url) } else { cancelledNavigations += 1 }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The system ended the page (memory): load it again; the screen re-opens its file on ready.
        isReady = false
        terminations += 1
        feedbackWaiters.values.forEach { $0.resume(returning: nil) }
        feedbackWaiters = [:]
        load()
    }

    /// The surface itself did not load (never an agent's frame: those are subframes).
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        surfaceFailed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        surfaceFailed(error)
    }

    private func surfaceFailed(_ error: Error) {
        let error = error as NSError
        // A load replaced by the next one (a reload) is not a failure.
        guard !isReady, error.code != NSURLErrorCancelled, error.code != 102 else { return }
        loadError = error.localizedDescription
        releaseWaiters()
    }
}

/// Watches the person's touches on the web view without taking them: the
/// time of the last one, for page-reported pins and selections.
final class TouchStamp: UIGestureRecognizer, UIGestureRecognizerDelegate {
    var last = Date.distantPast

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        last = .now
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        last = .now
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        last = .now
        state = .failed
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        last = .now
        state = .failed
    }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }
}

/// A link the person tapped in content, as the app may open it: `https` in
/// Safari View Controller, `mailto` in the mail sheet. Nothing else, so no URL
/// from an agent ever reaches the app's own URL handler (row 5120).
enum ContentLink: Identifiable, Equatable {
    case web(URL)
    case mail(URL)

    init?(_ url: URL) {
        switch url.scheme?.lowercased() {
        case "https": self = .web(url)
        case "mailto": self = .mail(url)
        default: return nil
        }
    }

    var id: String {
        switch self {
        case .web(let url), .mail(let url): url.absoluteString
        }
    }
}

/// The web view, with Comment first in the edit menu of a text selection (4.1).
final class SurfaceWebView: WKWebView {
    /// Set while a markdown or text file is open: Comment on the selection.
    var onComment: (() -> Void)?

    override func buildMenu(with builder: UIMenuBuilder) {
        super.buildMenu(with: builder)
        guard let onComment else { return }
        let comment = UIAction(title: "Comment") { _ in onComment() }
        builder.insertChild(UIMenu(options: .displayInline, children: [comment]), atStartOfMenu: .root)
    }
}

/// `plannotator-surface://app/surface.html`: the bundled surface, and nothing else.
final class SurfaceSchemeHandler: NSObject, WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url, url == SurfaceHost.surfaceURL,
              let file = Bundle.main.url(forResource: "surface", withExtension: "html"),
              let data = try? Data(contentsOf: file) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/html; charset=utf-8"])!)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
}

/// `plannotator-asset://inbox/api/html-assets/<token>/<path>`: the open HTML
/// page's own folder, fetched through the device door with the phone's token.
/// Any other path, or another page's token, answers nothing.
final class AssetSchemeHandler: NSObject, WKURLSchemeHandler {
    /// The open page's door and its folder token, from the `<base href>` of its view.
    var client: InboxClient?
    var token: String?
    private var running: [ObjectIdentifier: Task<Void, Never>] = [:]

    static let prefix = "/api/html-assets/"

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url, url.host() == "inbox", let client, let token else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        // Decoded once here; the door's URL is encoded once again when it is built.
        let path = url.path(percentEncoded: false)
        guard path.hasPrefix("\(Self.prefix)\(token)/") else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let id = ObjectIdentifier(task)
        running[id] = Task { [weak self] in
            let result: (data: Data, mimeType: String)?
            do throws(InboxError) {
                result = try await client.htmlAsset(String(path.dropFirst(Self.prefix.count)))
            } catch {
                result = nil
            }
            // A stopped task must not be answered.
            guard let self, self.running.removeValue(forKey: id) != nil else { return }
            if let result {
                task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: [
                    "Content-Type": result.mimeType,
                    "Content-Security-Policy": SurfaceHost.assetPolicy,
                ])!)
                task.didReceive(result.data)
                task.didFinish()
            } else {
                task.didFailWithError(URLError(.resourceUnavailable))
            }
        }
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {
        running.removeValue(forKey: ObjectIdentifier(task))?.cancel()
    }
}

/// The shell's messages (contract section 5, "Shell to surface").
enum Bridge {
    struct Text: Encodable {
        var attachment_id: String
        var version: String
        var text: String
    }

    struct OpenAttachment: Encodable {
        let v = 1, type = "open_attachment"
        var attachment: InboxAttachmentState
        var version: String
        var text: String
        var html: String?
        var annotations: [InboxAnnotationRecord]
        var focus: String?

        enum CodingKeys: String, CodingKey { case v, type, attachment, version, text, html, annotations, focus }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(v, forKey: .v)
            try c.encode(type, forKey: .type)
            try c.encode(attachment, forKey: .attachment)
            try c.encode(version, forKey: .version)
            try c.encode(text, forKey: .text)
            try c.encode(html, forKey: .html)
            try c.encode(annotations, forKey: .annotations)
            try c.encode(focus, forKey: .focus)
        }
    }

    /// A guided review opens on its sections (6.1). `guide` and `snapshot` are the door's JSON as it answered them (7.19).
    struct OpenGuide: Encodable {
        let v = 1, type = "open_guide"
        var message_id: String
        var guide: JSONValue
        var snapshot: JSONValue
        var reviewed: [Bool]?

        enum CodingKeys: String, CodingKey { case v, type, message_id, guide, snapshot, reviewed }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(v, forKey: .v)
            try c.encode(type, forKey: .type)
            try c.encode(message_id, forKey: .message_id)
            try c.encode(guide, forKey: .guide)
            try c.encode(snapshot, forKey: .snapshot)
            try c.encode(reviewed, forKey: .reviewed) // null: no ticks kept yet
        }
    }

    /// The bar's back button in 6.2: a section, or the sections with nil.
    struct OpenSection: Encodable {
        let v = 1, type = "open_section"
        var section: Int?

        enum CodingKeys: String, CodingKey { case v, type, section }
        func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(v, forKey: .v)
            try c.encode(type, forKey: .type)
            try c.encode(section, forKey: .section)
        }
    }

    /// The wrap button in 6.2's bar: diffs wrapped, or one line per row for a sideways read.
    struct SetWrap: Encodable {
        let v = 1, type = "set_wrap"
        var wrap: Bool
    }

    struct CommentSelection: Encodable {
        let v = 1, type = "comment_selection"
    }

    struct SetMode: Encodable {
        let v = 1, type = "set_mode"
        var mode: String
    }

    struct StepPin: Encodable {
        let v = 1, type = "step_pin"
        var direction: String
    }

    struct SetAppearance: Encodable {
        let v = 1, type = "set_appearance"
        var theme: String
        var text_scale: Double
    }

    struct CommitAnnotation: Encodable {
        let v = 1, type = "commit_annotation"
        var annotation: InboxAnnotationRecord
    }

    struct RemoveAnnotation: Encodable {
        let v = 1, type = "remove_annotation"
        var id: String
    }

    struct ExportFeedback: Encodable {
        let v = 1, type = "export_feedback"
        var id: String
        var annotations: [InboxAnnotationRecord]
        var attachments: [InboxAttachmentState]
        var texts: [Text]
        var project_root: String
    }
}
