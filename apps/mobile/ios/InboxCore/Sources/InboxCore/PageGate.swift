import Foundation

/// Whether a link in an attached page may open in the browser: only when the person has just activated it
/// themselves. A page's own script can click a link at any time; what tells the two apart is what the person did
/// just before.
///
/// A touch counts only when it was a tap: down and up in nearly one place, briefly. A finger that scrolls the page,
/// or rests on it, arms nothing, so a page cannot send the person to a site while they read. A key that activates
/// (Return, Space) counts as a tap does, unless it was typed into the page's own field (`editing`). Each tap or
/// key opens one link at most.
///
/// With VoiceOver or Switch Control there is no touch on the page: the person moves the focus onto a link, then
/// activates it. So under them a link opens only within `reach` after the focus landed on a link in the page, one
/// link per landing. A landing counts only when it is the person's move: not one in the second after the page
/// loaded or the app came back to the front (VoiceOver puts its focus back by itself then), so after a link opened
/// and the person returns, a new landing is needed. Nor one within a second of the page's script moving the focus
/// itself (`scriptedFocus`), before or after it. Never two links within a second.
///
/// What a page can still do under them: once the person lands on a link (any element the page calls a link, as
/// `role="link"`), its script can open one link of its choosing, within `reach`, in place of the person.
public struct PageGate: Sendable {
  /// How far a finger may move and still have tapped, in points.
  public static let slop = 12.0
  /// How long a finger may stay down and still have tapped.
  public static let press: TimeInterval = 0.6
  /// How long after a tap or a key a link may open.
  public static let window: TimeInterval = 0.5
  /// Under an assistive technology: nothing opens this soon after the page loads, nor this soon after a link opened.
  public static let settle: TimeInterval = 1
  /// Under an assistive technology: how long after the focus landed on a link the person may activate it.
  public static let reach: TimeInterval = 10

  private var down: (at: Date, x: Double, y: Double)?
  private var moved = false
  private var armed = Date.distantPast
  private var loadedAt = Date.distantPast
  private var focusedAt: Date?
  private var openedAt = Date.distantPast
  private var frontAt = Date.distantPast
  private var scriptedAt = Date.distantPast

  public init() {}

  public mutating func touchBegan(at now: Date, x: Double, y: Double) {
    down = (now, x, y)
    moved = false
  }

  public mutating func touchMoved(x: Double, y: Double) {
    guard let down else { return }
    if abs(x - down.x) > Self.slop || abs(y - down.y) > Self.slop { moved = true }
  }

  /// True when the touch that ended was a tap.
  @discardableResult
  public mutating func touchEnded(at now: Date, x: Double, y: Double) -> Bool {
    touchMoved(x: x, y: y)
    defer { down = nil }
    guard let down, !moved, now.timeIntervalSince(down.at) <= Self.press else { return false }
    armed = now
    return true
  }

  public mutating func touchCancelled() { down = nil }

  /// Return or Space was pressed on the page; `editing`: while a field of the page's own (a text box, a menu,
  /// anything editable) had the focus, so it was typed, not a link activated.
  public mutating func keyPressed(at now: Date, editing: Bool) {
    guard !editing else { return }
    armed = now
  }

  /// The page's script moved the focus itself (`focus()`): a landing near it may be the script's, not the person's.
  public mutating func scriptedFocus(at now: Date) {
    scriptedAt = now
    if let focusedAt, abs(now.timeIntervalSince(focusedAt)) < Self.settle { self.focusedAt = nil }
  }

  /// The page (re)loaded.
  public mutating func pageLoaded(at now: Date) { loadedAt = now }

  /// The app came (back) to the front.
  public mutating func appActivated(at now: Date) { frontAt = now }

  /// VoiceOver's or Switch Control's focus landed on something inside the page; `onLink`: on a link.
  public mutating func focusLanded(at now: Date, onLink: Bool) {
    guard onLink, now.timeIntervalSince(loadedAt) >= Self.settle, now.timeIntervalSince(frontAt) >= Self.settle, now.timeIntervalSince(scriptedAt) >= Self.settle else { return }
    focusedAt = now
  }

  /// Whether a link activated now is the person's doing.
  public func allows(at now: Date, assistive: Bool) -> Bool {
    if now >= armed && now.timeIntervalSince(armed) < Self.window { return true }
    guard assistive, let focusedAt, focusedAt > openedAt, focusedAt > loadedAt, focusedAt > frontAt, now >= focusedAt, now.timeIntervalSince(focusedAt) <= Self.reach else { return false }
    return now.timeIntervalSince(openedAt) >= Self.settle
  }

  /// Ask to open a link now: true when it may, and then the tap, key or focus that allowed it is spent.
  public mutating func open(at now: Date, assistive: Bool) -> Bool {
    guard allows(at: now, assistive: assistive) else { return false }
    armed = .distantPast
    openedAt = now
    return true
  }
}
