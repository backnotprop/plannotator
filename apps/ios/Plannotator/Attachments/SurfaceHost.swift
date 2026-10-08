import Foundation
import PlannotatorKit
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
    case error(code: String, message: String)
}

/// Plannotator's surface (`apps/hook/dist/surface.html`, bundled) in one
/// `WKWebView` the app keeps warm: the attachment screens (4.1 to 4.4) show
/// it, and Send asks it for the annotations' feedback text.
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
    /// Bridge messages that came from a frame other than the main one, dropped.
    private(set) var droppedFrameMessages = 0
    /// Pins and selections reported for an agent's HTML page with no touch of the person's just before, dropped.
    private(set) var droppedUntouched = 0
    /// Navigations away from the surface the shell refused.
    private(set) var cancelledNavigations = 0
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

    /// Loads the surface once; later calls do nothing.
    func warm() {
        guard !loaded else { return }
        loaded = true
        webView.load(URLRequest(url: Self.surfaceURL))
    }

    func whenReady() async {
        warm()
        if isReady { return }
        await withCheckedContinuation { readyWaiters.append($0) }
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

    /// Waits until the surface has painted what it was last sent (two animation frames).
    func drawn() async {
        _ = try? await webView.callAsyncJavaScript("await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))", contentWorld: .page)
    }

    /// Send's feedback text for these annotations (contract section 5,
    /// `export_feedback`): Plannotator's own export, as the window writes it.
    func feedback(annotations: [InboxAnnotationRecord], attachments: [InboxAttachmentState], texts: [Bridge.Text], projectRoot: String) async -> String? {
        await whenReady()
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
        feedbackWaiters.values.forEach { $0.resume(returning: nil) }
        feedbackWaiters = [:]
        webView.load(URLRequest(url: Self.surfaceURL))
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
                task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": result.mimeType])!)
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
