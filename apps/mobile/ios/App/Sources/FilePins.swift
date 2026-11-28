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
      opened: { desk.edit($0) },
      // Kept by file: the cover lays out the pages beside this one too, and the action is the page on screen's.
      pinsMiddle: { desk.pinMiddle[context.item.id] = $0 })
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
      // The DOM's own methods and getters, taken now, before the page runs: a page can shadow a document's or a
      // form's names with its own elements (`<img name="elementFromPoint">`), never these.
      const own = (proto, name) => Object.getOwnPropertyDescriptor(proto, name);
      const getter = (proto, name) => { const d = own(proto, name); return d && d.get; };
      const call = (fn, self, ...args) => (fn ? Reflect.apply(fn, self, args) : undefined);
      const D = Document.prototype, E = Element.prototype, N = Node.prototype, H = HTMLElement.prototype;
      const doc = document;
      const fromPoint = own(D, "elementFromPoint").value, queryAll = own(D, "querySelectorAll").value;
      const body = getter(D, "body"), root = getter(D, "documentElement");
      const rect = own(E, "getBoundingClientRect").value, attr = own(E, "getAttribute").value;
      const localName = getter(E, "localName"), elId = getter(E, "id"), classes = getter(E, "classList");
      const prev = getter(E, "previousElementSibling"), next = getter(E, "nextElementSibling");
      const parent = getter(N, "parentElement"), nodeType = getter(N, "nodeType"), textContent = getter(N, "textContent");
      const position = own(N, "compareDocumentPosition").value, innerText = getter(H, "innerText");
      const style = getter(H, "style");
      const FOLLOWING = Node.DOCUMENT_POSITION_FOLLOWING;
      const pins = { on: false };
      // Touches and moves only watched, never held: scrolling never waits on this script.
      const watched = new Set(["touchstart", "touchmove", "pointerdown", "pointermove", "pointerover", "pointerout", "pointerenter", "pointerleave", "mousemove", "mouseover", "mouseout", "mouseenter", "mouseleave"]);
      const stop = (event) => {
        if (!pins.on) return;
        event.stopImmediatePropagation();
        if (event.cancelable && !watched.has(event.type)) event.preventDefault();
      };
      for (const type of ["click", "dblclick", "auxclick", "contextmenu", "mousedown", "mouseup", "pointerdown", "pointerup", "pointermove", "pointerover", "pointerout", "pointerenter", "pointerleave", "pointercancel", "mousemove", "mouseover", "mouseout", "mouseenter", "mouseleave", "touchstart", "touchmove", "touchend", "touchcancel", "submit"]) {
        const passive = type === "touchstart" || type === "touchmove";
        window.addEventListener(type, stop, { capture: true, passive });
      }
      // A frame is a document of its own, which this script's listeners do not reach: while commenting, a touch on
      // it lands on the frame's element here, in this document, and is a pin.
      const frames = () => call(queryAll, doc, "iframe, frame, object, embed");
      // A frame's own inline pointer-events (and its priority) is kept while commenting and put back after.
      const before = new WeakMap();
      const still = (on) => {
        for (const frame of frames()) {
          const s = call(style, frame);
          if (!s) continue;
          if (on) {
            if (!before.has(frame)) before.set(frame, [s.getPropertyValue("pointer-events"), s.getPropertyPriority("pointer-events")]);
            s.setProperty("pointer-events", "none", "important");
          } else if (before.has(frame)) {
            const [value, priority] = before.get(frame);
            before.delete(frame);
            if (value) s.setProperty("pointer-events", value, priority); else s.removeProperty("pointer-events");
          }
        }
      };
      new MutationObserver(() => { if (pins.on) still(true); }).observe(doc, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
      pins.set = (on) => { pins.on = on; still(on); };
      const line = (text, max) => String(text || "").replace(/\\s+/g, " ").trim().slice(0, max);
      const tagOf = (el) => call(localName, el);
      const step = (el) => {
        const tag = tagOf(el);
        const id = call(elId, el);
        if (id) return tag + "#" + CSS.escape(id);
        let n = 1;
        for (let p = call(prev, el); p; p = call(prev, p)) if (tagOf(p) === tag) n += 1;
        let more = n > 1;
        for (let x = call(next, el); x && !more; x = call(next, x)) if (tagOf(x) === tag) more = true;
        return more ? tag + ":nth-of-type(" + n + ")" : tag;
      };
      const top = () => call(root, doc), page = () => call(body, doc);
      const selector = (el) => {
        const parts = [];
        for (let at = el; at && call(nodeType, at) === 1 && at !== top(); at = call(parent, at)) {
          parts.unshift(step(at));
          if (call(elId, at) || at === page()) break;
        }
        return parts.join(" > ");
      };
      const path = (el) => {
        const parts = [];
        for (let at = el; at && call(nodeType, at) === 1 && at !== top(); at = call(parent, at)) {
          const names = Array.from(call(classes, at) || []).slice(0, 2).map((name) => "." + name).join("");
          const id = call(elId, at);
          parts.unshift(tagOf(at) + (id ? "#" + id : "") + names);
        }
        return parts.join(" > ");
      };
      const heading = (el) => {
        let found = null;
        for (const h of call(queryAll, doc, "h1,h2,h3,h4,h5,h6")) {
          if (h === el || (call(position, h, el) & FOLLOWING)) found = h; else break;
        }
        return found ? tagOf(found) + ' "' + line(call(textContent, found), 100) + '"' : "";
      };
      const words = (el) => { try { return call(innerText, el) || call(textContent, el); } catch (e) { return call(textContent, el); } };
      pins.describe = (x, y) => {
        let el = call(fromPoint, doc, x - window.scrollX, y - window.scrollY);
        if (!el || el === top()) el = page();
        if (!el) return null;
        const box = call(rect, el);
        return {
          tag: tagOf(el), text: line(words(el), 400), selector: line(selector(el), 1024), path: line(path(el), 512), id: line(call(elId, el), 100),
          role: line(call(attr, el, "role"), 32), name: line(call(attr, el, "aria-label") || call(attr, el, "alt") || call(attr, el, "title"), 120), heading: heading(el),
          x: x, y: y, rect: { x: box.left, y: box.top, w: box.width, h: box.height, vw: window.innerWidth, vh: window.innerHeight },
        };
      };
      // The element at the middle of what is on screen: where a pin goes when the person asks for one without a
      // touch (VoiceOver).
      pins.middle = () => ({ x: window.scrollX + window.innerWidth / 2, y: window.scrollY + window.innerHeight / 2 });
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
    view.evaluateJavaScript("window.__plannotatorPins && window.__plannotatorPins.set(\(on ? "true" : "false")); undefined", in: nil, in: Self.world) { _ in }
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

  /// Pin the element at the middle of what is on screen: VoiceOver's way to pin, with no touch on the page.
  func pinMiddle() {
    guard let page else { return }
    // Asked for with Comment just turned on: the page's script is told first (the calls run in order), so this one
    // pin is not lost to the next redraw.
    if !commenting { set(commenting: true, in: page) }
    page.callAsyncJavaScript("const p = window.__plannotatorPins; if (!p) return null; const m = p.middle(); return p.describe(m.x, m.y)", arguments: [:], in: nil, in: Self.world) { [weak self] result in
      guard case .success(let value) = result, JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value),
        let answer = try? JSONDecoder().decode(JSONValue.self, from: data), let element = PinnedElement(answer)
      else { return }
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

  /// The disc's side at the person's text size: 26 points at the default, never past 44.
  static var side: CGFloat { min(44, UIFontMetrics(forTextStyle: .footnote).scaledValue(for: 26)) }

  init(pin: PagePins.Pin, open: @escaping () -> Void) {
    self.pin = pin
    self.open = open
    let side = Self.side
    let room = max(44, side + 18)
    super.init(frame: CGRect(x: 0, y: 0, width: room, height: room))
    let disc = UILabel(frame: CGRect(x: (room - side) / 2, y: (room - side) / 2, width: side, height: side))
    disc.text = "\(pin.number)"
    disc.textAlignment = .center
    // The number follows the person's text size, as the disc does.
    disc.font = UIFont.systemFont(ofSize: side * 0.54, weight: .bold)
    disc.adjustsFontSizeToFitWidth = true
    disc.minimumScaleFactor = 0.6
    disc.textColor = .white
    disc.backgroundColor = PictureInk.ink.withAlphaComponent(pin.comment == nil ? 0.8 : 1)
    disc.layer.cornerRadius = side / 2
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
