import AVKit
import InboxCore
import PDFKit
import SwiftUI
import WebKit

/// An HTML page an agent attached, as the page itself: in a web view that keeps nothing (no cookies, no storage
/// kept between openings), with no bridge into the app and no token of the computer's. The page's own script runs,
/// since a prototype is a page that does things; a link to another site opens in the browser, and nothing else
/// leaves the page. Its relative pictures and frames are not fetched yet (they come with the page routes).
struct WebPage: UIViewRepresentable {
  let url: URL
  let name: String

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
    configuration.allowsInlineMediaPlayback = true
    let view = WKWebView(frame: .zero, configuration: configuration)
    view.navigationDelegate = context.coordinator
    view.allowsLinkPreview = false
    view.isOpaque = false
    view.backgroundColor = .clear
    view.scrollView.backgroundColor = .clear
    view.accessibilityIdentifier = "file-page"
    context.coordinator.load(url, in: view)
    return view
  }

  func updateUIView(_ view: WKWebView, context: Context) {
    if context.coordinator.shown != url { context.coordinator.load(url, in: view) }
  }

  final class Coordinator: NSObject, WKNavigationDelegate {
    var shown: URL?

    func load(_ url: URL, in view: WKWebView) {
      shown = url
      // As a string with no address of its own: the page is no file on the phone and no page of any site, so it
      // can read neither.
      let html = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
      view.loadHTMLString(html, baseURL: nil)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
      guard action.navigationType == .linkActivated || action.navigationType == .formSubmitted else { return decisionHandler(.allow) }
      // A place on the same page.
      if let target = action.request.url, target.scheme == "about" { return decisionHandler(.allow) }
      if action.navigationType == .linkActivated, let target = action.request.url, ["http", "https"].contains(target.scheme?.lowercased() ?? "") { UIApplication.shared.open(target) }
      decisionHandler(.cancel)
    }
  }
}

/// A video or a recording, in the system's player. Read from the phone's own copy, so it plays, seeks and plays
/// again with the computer away.
struct PlayerPage: View {
  let url: URL
  let item: AttachmentItem

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      PlayerView(url: url)
    }
  }
}

struct PlayerView: UIViewControllerRepresentable {
  let url: URL

  func makeUIViewController(context: Context) -> AVPlayerViewController {
    let controller = AVPlayerViewController()
    controller.player = AVPlayer(url: url)
    controller.allowsPictureInPicturePlayback = false
    controller.view.accessibilityIdentifier = "file-player"
    return controller
  }

  func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
    if (controller.player?.currentItem?.asset as? AVURLAsset)?.url != url { controller.player = AVPlayer(url: url) }
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
