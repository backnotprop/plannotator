import AVKit
import InboxCore
import PDFKit
import SwiftUI
import WebKit

/// An HTML page an agent attached, as the page itself, held to the window's policy for a page
/// (packages/server/inbox-pages.ts `INBOX_PAGE_CSP`): the page's own script runs, since a prototype is a page that
/// does things, but nothing it does reaches the network, the phone or the app.
///
/// - It is served under a scheme of its own (`WebPage.scheme`) with its policy as a response header, which the page
///   cannot loosen: sandboxed (an opaque origin: no cookies or storage of any site, no forms), script only its own
///   inline script, no fetch, XHR, WebSocket or beacon, no script, style, font, frame or media from anywhere.
///   Pictures come from the web over HTTPS, as the window's do.
/// - A content rule list blocks the same loads again, apart from the page: whatever the page says, a load that is
///   not the page itself or a picture over HTTPS never starts.
/// - The web view keeps nothing (a store of its own, gone when it closes), has no bridge into the app and no token
///   of the computer's, reads no file of the phone's, and never opens a window or asks for the camera, the
///   microphone or the phone's motion.
/// - The page never navigates: a link the person taps that leads to a site opens in the browser (only just after
///   their own tap or key, `PageGate`, so a script cannot send them there, nor a finger that only scrolls), and no
///   other link, script or form takes the page away.
///
/// Comments (`PagePins`) add one thing to this, and nothing to the page's own reach: a script of the app's, in a
/// content world of its own that the page's scripts cannot see or call, which answers one question when the app
/// asks it ("what is under this point?") and, while the person is commenting, keeps their touches from the page's
/// own handlers. It is put there by the app, not loaded by the page, so the page's policy does not cover it and is
/// not loosened for it. No message handler is added: the answer comes back as the result of the app's own call, so
/// there is still nothing the page can post to.
///
/// Its relative pictures and frames are not fetched yet (they come with the page routes).
struct WebPage: UIViewRepresentable {
  let url: URL
  let name: String
  /// What floats over the page's foot (the comment field): the page scrolls its own end clear of it.
  var foot: CGFloat = 0
  /// The person is commenting: a touch pins a spot, and nothing of the page answers it.
  var commenting = false
  /// The pins on the page: the waiting comments', and the one being written (no comment yet).
  var pins: [PagePins.Pin] = []
  var sought: CommentDesk.Sought?
  /// A spot was pinned: what the page's element there is.
  var pinned: (PinnedElement) -> Void = { _ in }
  var opened: (FileComment) -> Void = { _ in }
  /// Hands over the way to pin the element at the middle of the screen (VoiceOver's pin, with no touch).
  var pinsMiddle: (@escaping () -> Void) -> Void = { _ in }

  /// The page's own scheme: apart from every site and from the phone's files. Only the page is served on it.
  static let scheme = "plannotator-file"
  static let address = URL(string: "\(scheme)://page/page.html")!

  /// `INBOX_PAGE_CSP`, with pictures over HTTPS only, and popups allowed by the sandbox only so a link that opens
  /// in a new window reaches the navigation rules below (no window is ever opened).
  static let policy = [
    "sandbox allow-scripts allow-modals allow-popups",
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].joined(separator: "; ")

  /// Every load blocked, then let through again: the page's own scheme, a picture over HTTPS, and the page's own
  /// made-up addresses (data:, blob:, about:).
  static let rules = """
    [
      {"trigger": {"url-filter": ".*"}, "action": {"type": "block"}},
      {"trigger": {"url-filter": "^\(scheme):"}, "action": {"type": "ignore-previous-rules"}},
      {"trigger": {"url-filter": "^https://", "resource-type": ["image"]}, "action": {"type": "ignore-previous-rules"}},
      {"trigger": {"url-filter": "^data:"}, "action": {"type": "ignore-previous-rules"}},
      {"trigger": {"url-filter": "^blob:"}, "action": {"type": "ignore-previous-rules"}},
      {"trigger": {"url-filter": "^about:"}, "action": {"type": "ignore-previous-rules"}}
    ]
    """

  @MainActor private static var compiled: WKContentRuleList?

  /// The rule list, compiled once.
  @MainActor static func ruleList() async -> WKContentRuleList? {
    if let compiled { return compiled }
    let list: WKContentRuleList? = await withCheckedContinuation { done in
      WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "file-page", encodedContentRuleList: rules) { list, _ in done.resume(returning: list) }
    }
    compiled = list
    return list
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    configuration.allowsInlineMediaPlayback = true
    configuration.setURLSchemeHandler(context.coordinator.server, forURLScheme: Self.scheme)
    // Its own controller, kept: the rule list goes on it before the page loads. The app's scripts: pins, in their
    // own world (`PagePins`); and what tells the link gate what the person did (`PageWatch`): keys, heard in that
    // world, and the page's own moves of the focus, heard in the page's.
    configuration.userContentController = context.coordinator.content
    context.coordinator.content.addUserScript(WKUserScript(source: PagePins.script, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: PagePins.world))
    PageWatch.install(on: context.coordinator.content, for: context.coordinator.touches)
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = context.coordinator
    view.uiDelegate = context.coordinator
    view.allowsLinkPreview = false
    // A page that sets no ground of its own is on white, as a browser draws it: its default ink is black.
    view.isOpaque = true
    view.backgroundColor = .white
    view.scrollView.backgroundColor = .white
    view.accessibilityIdentifier = "file-page"
    view.addGestureRecognizer(context.coordinator.touches)
    context.coordinator.touches.watchFocus(in: view)
    context.coordinator.pinning.attach(to: view)
    context.coordinator.ground = view.observe(\.underPageBackgroundColor, options: [.initial, .new]) { view, _ in
      Task { @MainActor in
        guard let ground = view.underPageBackgroundColor else { return }
        view.backgroundColor = ground
        view.scrollView.backgroundColor = ground
      }
    }
    let pinning = context.coordinator.pinning
    context.coordinator.touches.tapped = { [weak pinning] touch in pinning?.tapped(touch) }
    context.coordinator.load(url, in: view)
    apply(to: view, context.coordinator)
    return view
  }

  func updateUIView(_ view: WKWebView, context: Context) {
    if context.coordinator.server.file != url { context.coordinator.load(url, in: view) }
    apply(to: view, context.coordinator)
  }

  private func apply(to view: WKWebView, _ coordinator: Coordinator) {
    // The page runs under the comment field; its own end scrolls clear of it.
    let room = foot
    if abs(view.scrollView.contentInset.bottom - room) > 0.5 {
      view.scrollView.contentInset.bottom = room
      view.scrollView.verticalScrollIndicatorInsets.bottom = room
    }
    coordinator.commenting = commenting
    coordinator.pinning.pinned = pinned
    coordinator.pinning.opened = opened
    coordinator.pinning.set(commenting: commenting, in: view)
    let pinning = coordinator.pinning
    pinsMiddle { [weak pinning] in pinning?.pinMiddle() }
    // VoiceOver: while commenting, the page's own action pins what is in the middle of the screen.
    view.accessibilityCustomActions = commenting ? [UIAccessibilityCustomAction(name: PhoneWords.comment) { [weak pinning] _ in
      pinning?.pinMiddle()
      return true
    }] : nil
    coordinator.pinning.show(pins, in: view)
    if let sought, sought.turn != coordinator.pinning.soughtTurn {
      coordinator.pinning.soughtTurn = sought.turn
      coordinator.pinning.look(at: sought.comment, in: view)
    }
  }

  /// Serves the page, and nothing else: any other address on the scheme is not found.
  final class PageServer: NSObject, WKURLSchemeHandler {
    var file: URL?

    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
      let asked = task.request.url ?? WebPage.address
      let page = asked.scheme == WebPage.scheme && asked.host == WebPage.address.host && asked.path == WebPage.address.path
      let bytes = page ? file.flatMap { try? Data(contentsOf: $0, options: .mappedIfSafe) } : nil
      let headers = [
        "Content-Type": bytes == nil ? "text/plain" : "text/html; charset=utf-8", "Content-Security-Policy": WebPage.policy, "Referrer-Policy": "no-referrer", "Cache-Control": "no-store",
      ]
      guard let response = HTTPURLResponse(url: asked, statusCode: bytes == nil ? 404 : 200, httpVersion: "HTTP/1.1", headerFields: headers) else { return task.didFailWithError(URLError(.badURL)) }
      task.didReceive(response)
      task.didReceive(bytes ?? Data())
      task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
  }

  /// Watches the person's touches and keys on the page for `PageGate` (a link leaves for the browser only just
  /// after their own tap or key). Watches, never takes a touch from the page.
  final class TouchWatch: UIGestureRecognizer, UIGestureRecognizerDelegate {
    private(set) var gate = PageGate()
    /// A tap ended, on this view of the page (the page takes it too, unless its comments' script stops it).
    var tapped: (UITouch) -> Void = { _ in }

    override init(target: Any?, action: Selector?) {
      super.init(target: target, action: action)
      cancelsTouchesInView = false
      delaysTouchesBegan = false
      delaysTouchesEnded = false
      delegate = self
    }

    /// VoiceOver and Switch Control activate a link with no touch on the page: what they show instead is where
    /// their focus lands (`focusLanded`). (A hardware keyboard, Full Keyboard Access included, is seen by its key:
    /// `keyPressed`.)
    static var assistive: Bool { UIAccessibility.isVoiceOverRunning || UIAccessibility.isSwitchControlRunning }

    private weak var page: UIView?

    /// Ask to open a link the page activated now: true once per tap, key or landing of the focus on a link.
    func open() -> Bool { gate.open(at: Date(), assistive: Self.assistive) }

    func pageLoaded() { gate.pageLoaded(at: Date()) }

    /// Hear where VoiceOver's or Switch Control's focus lands; a landing on a link inside `page` is the person
    /// going there. And when the app comes back to the front (VoiceOver then puts its focus back by itself).
    func watchFocus(in page: UIView) {
      self.page = page
      NotificationCenter.default.addObserver(self, selector: #selector(focused(_:)), name: UIAccessibility.elementFocusedNotification, object: nil)
      NotificationCenter.default.addObserver(self, selector: #selector(front(_:)), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    @objc private func focused(_ note: Notification) {
      guard let page, let element = note.userInfo?[UIAccessibility.focusedElementUserInfoKey] as AnyObject?, Self.isInside(element, page) else { return }
      gate.focusLanded(at: Date(), onLink: Self.isLink(element))
    }

    @objc private func front(_ note: Notification) { gate.appActivated(at: Date()) }

    /// Whether an accessibility element is a link (WebKit gives a page's links, and its `role="link"`, this trait).
    static func isLink(_ element: AnyObject) -> Bool { (element as? NSObject)?.accessibilityTraits.contains(.link) ?? false }

    /// Whether an accessibility element is in a view: the view itself, under it, or one of WebKit's elements whose
    /// containers lead to a view under it.
    static func isInside(_ element: AnyObject, _ page: UIView) -> Bool {
      var at: AnyObject? = element
      for _ in 0..<64 {
        guard let current = at else { return false }
        if let view = current as? UIView { return view === page || view.isDescendant(of: page) }
        // WebKit's elements are not all `UIAccessibilityElement`s, but each answers for its container.
        let container = NSSelectorFromString("accessibilityContainer")
        guard let object = current as? NSObject, object.responds(to: container) else { return false }
        at = object.perform(container)?.takeUnretainedValue()
      }
      return false
    }

    private func place(_ touches: Set<UITouch>) -> CGPoint { touches.first?.location(in: nil) ?? .zero }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
      // A second finger is not a tap.
      if (event.allTouches?.count ?? 1) > 1 { return gate.touchCancelled() }
      let at = place(touches)
      gate.touchBegan(at: Date(), x: at.x, y: at.y)
    }
    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
      let at = place(touches)
      gate.touchMoved(x: at.x, y: at.y)
    }
    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
      let at = place(touches)
      if gate.touchEnded(at: Date(), x: at.x, y: at.y), let touch = touches.first { tapped(touch) }
      state = .failed
    }
    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
      gate.touchCancelled()
      state = .failed
    }
    // Return, Enter or Space on a hardware keyboard activates the link that has the focus. Heard from the page
    // (`PageWatch`), which knows whether the focus was in a field of its own: typed there, it arms nothing.
    func keyPressed(editing: Bool) { gate.keyPressed(at: Date(), editing: editing) }

    /// The page's script moved the focus itself.
    func scriptedFocus() { gate.scriptedFocus(at: Date()) }

    func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
  }

  final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
    let server = PageServer()
    let content = WKUserContentController()
    let touches = TouchWatch(target: nil, action: nil)
    let pinning = PagePins()
    /// Past the page's own end (the room under the comment field) is the page's own ground, not white.
    var ground: NSKeyValueObservation?
    /// While the person comments, no link leaves: a touch is a pin.
    var commenting = false

    func load(_ url: URL, in view: WKWebView) {
      server.file = url
      Task { @MainActor in
        // No rule list, no page: the page is never shown without both of its walls.
        guard let rules = await WebPage.ruleList() else { return }
        content.removeAllContentRuleLists()
        content.add(rules)
        view.load(URLRequest(url: WebPage.address))
      }
    }

    /// The page itself (a place on it, or the page again).
    private func isPage(_ target: URL?) -> Bool {
      guard let target else { return false }
      return target.scheme == WebPage.scheme && target.host == WebPage.address.host && target.path == WebPage.address.path
    }

    /// A link the person just tapped, to a site: to the browser. Nothing else leaves.
    private func leave(_ action: WKNavigationAction) {
      guard !commenting, action.navigationType == .linkActivated || action.targetFrame == nil, let target = action.request.url, ["http", "https"].contains(target.scheme?.lowercased() ?? ""), touches.open() else { return }
      UIApplication.shared.open(target)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { touches.pageLoaded() }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
      touches.pageLoaded()
      pinning.loaded(webView)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
      if let frame = action.targetFrame, !frame.isMainFrame {
        // A frame of the page's own (its policy frames nothing from elsewhere).
        let scheme = action.request.url?.scheme?.lowercased() ?? ""
        return decisionHandler([WebPage.scheme, "about", "data", "blob"].contains(scheme) ? .allow : .cancel)
      }
      if action.targetFrame != nil, isPage(action.request.url) { return decisionHandler(.allow) }
      // Anything else would put another page under the file's own name: never.
      leave(action)
      decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
      leave(action)
      return nil
    }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
      decisionHandler(.deny)
    }

    func webView(_ webView: WKWebView, requestDeviceOrientationAndMotionPermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void) {
      decisionHandler(.deny)
    }
  }
}

/// A video or a recording, in the system's player. Read from the phone's own copy, so it plays, seeks and plays
/// again with the computer away. One the system cannot play (a WebM, an Ogg) is a file to share.
struct PlayerPage: View {
  let session: InboxSession
  let item: AttachmentItem
  let url: URL
  /// The page on screen: one swiped away stops.
  let current: Bool
  @State private var playable: Bool?

  var body: some View {
    Group {
      switch playable {
      case true?:
        ZStack {
          Color.black.ignoresSafeArea()
          PlayerView(url: url, current: current)
        }
      case false?:
        FileCard(session: session, item: item, url: url, note: PhoneWords.fileNotShown(item.name))
      case nil:
        Waiting()
      }
    }
    .task(id: url) { playable = (try? await AVURLAsset(url: url).load(.isPlayable)) ?? false }
  }
}

struct PlayerView: UIViewControllerRepresentable {
  let url: URL
  let current: Bool

  func makeUIViewController(context: Context) -> AVPlayerViewController {
    let controller = AVPlayerViewController()
    controller.player = AVPlayer(url: url)
    controller.allowsPictureInPicturePlayback = false
    controller.view.accessibilityIdentifier = "file-player"
    return controller
  }

  func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
    if (controller.player?.currentItem?.asset as? AVURLAsset)?.url != url { controller.player = AVPlayer(url: url) }
    if !current { controller.player?.pause() }
  }

  static func dismantleUIViewController(_ controller: AVPlayerViewController, coordinator: ()) { controller.player?.pause() }
}

/// A PDF, drawn by the system: its pages down the screen, pinched into.
struct PDFPage: UIViewRepresentable {
  let url: URL

  func makeUIView(context: Context) -> PDFView {
    let view = PDFView()
    view.autoScales = true
    view.displayMode = .singlePageContinuous
    view.displayDirection = .vertical
    view.backgroundColor = UIColor(Token.muted)
    view.document = PDFDocument(url: url)
    return view
  }

  func updateUIView(_ view: PDFView, context: Context) {
    if view.document?.documentURL != url { view.document = PDFDocument(url: url) }
  }
}

/// What the page tells the link gate, through two small scripts of the app's own, in every frame, from the start.
///
/// - `keys`, in the pins' own world (`PagePins.world`), which the page's scripts cannot see or reach: on Return,
///   Enter or Space that the person pressed (`isTrusted`: a script's made-up key event is not), whether the focus
///   was in a field of the page's own. It listens first (it is added before any of the page's scripts), so the
///   page cannot move the focus before it looks. Only that world can post to its handler.
/// - `focus`, in the page's own world, since that is where the page calls `focus()`: it wraps `focus()` on HTML
///   and SVG elements, before the page's scripts run, to say the script moved the focus. Everything the wrapper
///   calls is taken before the page runs (`Reflect.apply`, the handler and its `postMessage`), so a page that
///   replaces `Function.prototype.apply` or the handlers cannot reach the browser's own `focus()` through it, and
///   the wrapper itself cannot be replaced. The page can post to this one too, which only keeps links closed.
enum PageWatch {
  static let keyHandler = "plannotatorKey"
  static let focusHandler = "plannotatorScriptFocus"

  static let keys = """
    (() => {
      const handlers = window.webkit && window.webkit.messageHandlers;
      const handler = handlers && handlers.\(keyHandler);
      if (!handler) return;
      const post = handler.postMessage.bind(handler);
      const editable = (element) => {
        let at = element;
        while (at && at.shadowRoot && at.shadowRoot.activeElement) at = at.shadowRoot.activeElement;
        if (!at) return false;
        if (at.isContentEditable) return true;
        // A focused element whose inside the app cannot see (a closed shadow root, a frame) counts as a field.
        if (at.shadowRoot === null && at.tagName.includes("-")) return true;
        return ["INPUT", "TEXTAREA", "SELECT", "IFRAME", "FRAME", "OBJECT", "EMBED"].includes(at.tagName);
      };
      window.addEventListener("keydown", (event) => {
        if (!event.isTrusted || !["Enter", " "].includes(event.key)) return;
        post({ editing: editable(document.activeElement) });
      }, true);
    })();
    """

  static let focus = """
    (() => {
      "use strict";
      const apply = Reflect.apply;
      const define = Object.defineProperty;
      const handlers = window.webkit && window.webkit.messageHandlers;
      const handler = handlers && handlers.\(focusHandler);
      if (!handler) return;
      const postMessage = handler.postMessage;
      if (typeof postMessage !== "function") return;
      const kinds = [window.HTMLElement, window.SVGElement, window.MathMLElement];
      for (let i = 0; i < kinds.length; i += 1) {
        const proto = kinds[i] && kinds[i].prototype;
        const original = proto && proto.focus;
        if (typeof original !== "function") continue;
        const focus = function focus(options) {
          try { apply(postMessage, handler, [1]); } catch (_) {}
          return apply(original, this, [options]);
        };
        // Not configurable, not writable: the page cannot put the browser's own back.
        define(proto, "focus", { value: focus, configurable: false, writable: false, enumerable: true });
      }
    })();
    """

  @MainActor
  static func install(on content: WKUserContentController, for touches: WebPage.TouchWatch) {
    content.addUserScript(WKUserScript(source: keys, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: PagePins.world))
    content.addUserScript(WKUserScript(source: focus, injectionTime: .atDocumentStart, forMainFrameOnly: false, in: .page))
    let heard = Heard(touches)
    content.add(heard, contentWorld: PagePins.world, name: keyHandler)
    content.add(heard, contentWorld: .page, name: focusHandler)
  }

  /// The handler, holding the watch weakly (the controller keeps its handlers).
  private final class Heard: NSObject, WKScriptMessageHandler {
    private weak var touches: WebPage.TouchWatch?
    init(_ touches: WebPage.TouchWatch) { self.touches = touches }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
      switch message.name {
      case PageWatch.keyHandler:
        let editing = ((message.body as? [String: Any])?["editing"] as? Bool) ?? true
        MainActor.assumeIsolated { touches?.keyPressed(editing: editing) }
      case PageWatch.focusHandler:
        MainActor.assumeIsolated { touches?.scriptedFocus() }
      default: break
      }
    }
  }
}
