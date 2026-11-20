import InboxCore
import InboxWire
import SwiftUI
import UIKit
import WebKit

/// An attached page with its comments: the page itself (`WebPage`), numbered pins where the waiting comments are,
/// and, while the person is commenting, a pin wherever they touch.
struct PinnedPage: View {
  let url: URL
  let name: String
  let context: CommentContext
  /// How much of the screen's foot the comment field covers: the page's own end rests clear of it.
  var foot: CGFloat = 0

  var body: some View {
    let desk = context.desk
    let takes = context.takes
    let comments = context.comments
    let writing: PinnedElement? = {
      if let draft = desk.draft, draft.file == context.item.id, case .pin(let element) = draft.target { return element }
      return nil
    }()
    let kept = comments.enumerated().compactMap { index, comment in
      comment.pinPoint.map { PagePins.Pin(id: comment.id, number: index + 1, x: $0.x, y: $0.y, comment: comment) }
    }
    WebPage(
      url: url, name: name, foot: foot, commenting: takes && desk.commenting,
      pins: kept + (writing.map { [PagePins.Pin(id: "writing", number: comments.count + 1, x: $0.x, y: $0.y, comment: nil)] } ?? []),
      sought: desk.sought?.comment.attachment == context.item.id ? desk.sought : nil,
      pinned: { context.begin(.pin($0)) },
      opened: { desk.edit($0) })
  }
}

/// Pins on an attached page.
///
/// The page runs under its own strict policy (`WebPage`), which stays as it is. What pinning adds:
/// - `script`, put into the page by the app at document start, in `world`: a content world of the app's own, whose
///   variables and functions the page's scripts cannot see, call or replace. It does two things. While commenting
///   is on it stops the person's touches and clicks before the page's own handlers see them, so a touch pins a
///   spot and presses no button and follows no link. And it answers `describe(x, y)`: the element under a point,
///   as a few short strings.
/// - The app calls `describe` itself when the person taps, and reads its answer as the call's own result. No
///   message handler is added, so there is still nothing a page can post to, and the script sends nothing anywhere.
/// - Every string of the answer is written by the page. It is read as data only (`PinnedElement`): cut to the
///   window's own bounds, put on one line, and never run, shown as markup or used as an address.
///
/// The pins are the app's own views over the page, placed in the page's own points, so they move with it as it
/// scrolls and stay on their spot if it is pinched into.
@MainActor
final class PagePins: NSObject {
  struct Pin: Equatable {
    var id: String
    var number: Int
    /// In the page's own points from its top left.
    var x: Double
    var y: Double
    /// Nil: the pin being written.
    var comment: FileComment?
  }

  static let world = WKContentWorld.world(name: "plannotator-pins")

  /// Read by the app only (`describe`), and quiet until commenting is on. `x` and `y` are in the page's own points.
  static let script = """
    (() => {
      const pins = { on: false };
      const quiet = new Set(["touchstart", "touchmove", "pointerdown", "pointermove"]);
      const stop = (event) => {
        if (!pins.on) return;
        event.stopImmediatePropagation();
        if (event.cancelable && !quiet.has(event.type)) event.preventDefault();
      };
      for (const type of ["click", "dblclick", "auxclick", "contextmenu", "mousedown", "mouseup", "pointerdown", "pointerup", "pointermove", "touchstart", "touchmove", "touchend", "submit"]) {
        window.addEventListener(type, stop, { capture: true, passive: false });
      }
      const line = (text, max) => String(text || "").replace(/\\s+/g, " ").trim().slice(0, max);
      const step = (el) => {
        const tag = el.localName;
        if (el.id) return tag + "#" + CSS.escape(el.id);
        let n = 1;
        for (let prev = el.previousElementSibling; prev; prev = prev.previousElementSibling) if (prev.localName === tag) n += 1;
        let more = n > 1;
        for (let next = el.nextElementSibling; next && !more; next = next.nextElementSibling) if (next.localName === tag) more = true;
        return more ? tag + ":nth-of-type(" + n + ")" : tag;
      };
      const selector = (el) => {
        const parts = [];
        for (let at = el; at && at.nodeType === 1 && at !== document.documentElement; at = at.parentElement) {
          parts.unshift(step(at));
          if (at.id || at === document.body) break;
        }
        return parts.join(" > ");
      };
      const path = (el) => {
        const parts = [];
        for (let at = el; at && at.nodeType === 1 && at !== document.documentElement; at = at.parentElement) {
          const classes = Array.from(at.classList).slice(0, 2).map((name) => "." + name).join("");
          parts.unshift(at.localName + (at.id ? "#" + at.id : "") + classes);
        }
        return parts.join(" > ");
      };
      const heading = (el) => {
        let found = null;
        for (const h of document.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
          if (h === el || (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) found = h; else break;
        }
        return found ? found.localName + ' "' + line(found.textContent, 100) + '"' : "";
      };
      pins.describe = (x, y) => {
        let el = document.elementFromPoint(x - window.scrollX, y - window.scrollY);
        if (!el || el === document.documentElement) el = document.body;
        if (!el) return null;
        const box = el.getBoundingClientRect();
        return {
          tag: el.localName, text: line(el.innerText || el.textContent, 400), selector: line(selector(el), 1024), path: line(path(el), 512), id: line(el.id, 100),
          role: line(el.getAttribute("role"), 32), name: line(el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("title"), 120), heading: heading(el),
          x: x, y: y, rect: { x: box.left, y: box.top, w: box.width, h: box.height, vw: window.innerWidth, vh: window.innerHeight },
        };
      };
      window.__plannotatorPins = pins;
    })();
    """

  var pinned: (PinnedElement) -> Void = { _ in }
  var opened: (FileComment) -> Void = { _ in }
  var soughtTurn = 0
  private var commenting = false
  private var shown: [Pin] = []
  private var views: [PinView] = []
  private var zoom: NSKeyValueObservation?
  private weak var page: WKWebView?

  func attach(to view: WKWebView) {
    page = view
    // Pinched into, the page's points grow: each pin keeps its spot.
    zoom = view.scrollView.observe(\.zoomScale) { [weak self] _, _ in Task { @MainActor in self?.place() } }
  }

  func set(commenting on: Bool, in view: WKWebView) {
    guard on != commenting else { return }
    commenting = on
    // While the page is used, a pin shows where a comment is and takes no touch from the page under it.
    views.forEach { $0.isUserInteractionEnabled = on }
    view.evaluateJavaScript("window.__plannotatorPins && (window.__plannotatorPins.on = \(on ? "true" : "false")); undefined", in: nil, in: Self.world) { _ in }
  }

  /// A page that loaded again starts quiet: say again whether commenting is on.
  func loaded(_ view: WKWebView) {
    let on = commenting
    commenting = !on
    set(commenting: on, in: view)
  }

  /// The person tapped the page (`WebPage.TouchWatch`, which watches the page's touches and takes none). While
  /// commenting, that pins the spot; a tap on a pin is the pin's own.
  func tapped(_ touch: UITouch) {
    guard commenting, let page, !(touch.view is PinView) else { return }
    let scroll = page.scrollView
    let at = touch.location(in: scroll)
    let scale = Double(max(scroll.zoomScale, 0.0001))
    // A place in the scroll view's content is a place on the page, in its own points.
    let (x, y) = (Double(at.x) / scale, Double(at.y) / scale)
    page.callAsyncJavaScript("return window.__plannotatorPins ? window.__plannotatorPins.describe(x, y) : null", arguments: ["x": x, "y": y], in: nil, in: Self.world) { [weak self] result in
      guard case .success(let value) = result, JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value),
        let answer = try? JSONDecoder().decode(JSONValue.self, from: data), let element = PinnedElement(answer)
      else { return }
      UIImpactFeedbackGenerator(style: .light).impactOccurred()
      self?.pinned(element)
    }
  }

  func show(_ pins: [Pin], in view: WKWebView) {
    guard pins != shown else { return }
    shown = pins
    views.forEach { $0.removeFromSuperview() }
    views = pins.map { pin in
      let mark = PinView(pin: pin) { [weak self] in if let comment = pin.comment { self?.opened(comment) } }
      mark.isUserInteractionEnabled = commenting
      view.scrollView.addSubview(mark)
      return mark
    }
    place()
    // The spot being written about comes up over the keyboard.
    if let writing = pins.first(where: { $0.comment == nil }) { lift(x: writing.x, y: writing.y, in: view) }
  }

  /// Bring a spot of the page to a quarter of the way down its room, when it is lower than that.
  private func lift(x: Double, y: Double, in view: WKWebView) {
    let scroll = view.scrollView
    let top = scroll.adjustedContentInset.top
    let onScreen = y * Double(scroll.zoomScale) - scroll.contentOffset.y
    let wanted = top + (scroll.bounds.height - top) * 0.25
    guard onScreen > wanted else { return }
    let most = max(-top, scroll.contentSize.height + scroll.contentInset.bottom - scroll.bounds.height)
    scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: min(most, scroll.contentOffset.y + onScreen - wanted)), animated: !UIAccessibility.isReduceMotionEnabled)
  }

  private func place() {
    guard let scroll = page?.scrollView else { return }
    // The disc stands just over its spot, so what it marks is still read under it.
    for view in views { view.center = CGPoint(x: view.pin.x * Double(scroll.zoomScale), y: view.pin.y * Double(scroll.zoomScale) - PinView.lift) }
  }

  /// Bring a comment's pin to the middle of the page's room.
  func look(at comment: FileComment, in view: WKWebView) {
    guard let point = comment.pinPoint else { return }
    let scroll = view.scrollView
    let room = scroll.bounds.inset(by: scroll.adjustedContentInset)
    let top = -scroll.adjustedContentInset.top
    let most = max(top, scroll.contentSize.height - room.height - scroll.adjustedContentInset.top)
    let y = min(max(top, point.y * Double(scroll.zoomScale) - room.height / 2 - scroll.adjustedContentInset.top), most)
    scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: y), animated: !UIAccessibility.isReduceMotionEnabled)
  }
}

/// A numbered pin over a page: the mark's own red with a light edge, as on a picture, 44 points to touch.
final class PinView: UIControl {
  /// How far over its spot the disc's middle stands.
  static let lift: CGFloat = 18
  let pin: PagePins.Pin
  private let open: () -> Void

  init(pin: PagePins.Pin, open: @escaping () -> Void) {
    self.pin = pin
    self.open = open
    super.init(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
    let disc = UILabel(frame: CGRect(x: 9, y: 9, width: 26, height: 26))
    disc.text = "\(pin.number)"
    disc.textAlignment = .center
    disc.font = .systemFont(ofSize: 14, weight: .bold)
    disc.textColor = .white
    disc.backgroundColor = PictureInk.ink.withAlphaComponent(pin.comment == nil ? 0.8 : 1)
    disc.layer.cornerRadius = 13
    disc.layer.borderWidth = 2
    disc.layer.borderColor = UIColor.white.cgColor
    disc.layer.masksToBounds = true
    disc.isUserInteractionEnabled = false
    addSubview(disc)
    layer.shadowColor = UIColor.black.cgColor
    layer.shadowOpacity = 0.25
    layer.shadowRadius = 3
    layer.shadowOffset = CGSize(width: 0, height: 1)
    addTarget(self, action: #selector(touched), for: .touchUpInside)
    isAccessibilityElement = true
    accessibilityTraits = .button
    accessibilityLabel = pin.comment?.words ?? "\(pin.number)"
    accessibilityIdentifier = "page-pin"
  }

  @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

  @objc private func touched() { open() }
}
