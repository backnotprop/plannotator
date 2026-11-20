import Foundation

/// Whether a link in an attached page may open in the browser: only when the person has just activated it
/// themselves. A page's own script can click a link at any time; what tells the two apart is what the person did
/// just before.
///
/// A touch counts only when it was a tap: down and up in nearly one place, briefly. A finger that scrolls the page,
/// or rests on it, arms nothing, so a page cannot send the person to a site while they read. A key that activates
/// (Return, Space) counts as a tap does. Each tap or key opens one link at most.
///
/// With VoiceOver or Switch Control there is no touch on the page: the person moves the focus onto a link, then
/// activates it. So under them a link opens only after the focus landed inside the page since the last link opened
/// (each move of the focus opens one link at most), never in the page's first second, and never twice within a
/// second. A page's script can still open one link after each move of the focus into the page; it cannot open them
/// in a loop.
public struct PageGate: Sendable {
  /// How far a finger may move and still have tapped, in points.
  public static let slop = 12.0
  /// How long a finger may stay down and still have tapped.
  public static let press: TimeInterval = 0.6
  /// How long after a tap or a key a link may open.
  public static let window: TimeInterval = 0.5
  /// Under an assistive technology: nothing opens this soon after the page loads, nor this soon after a link opened.
  public static let settle: TimeInterval = 1

  private var down: (at: Date, x: Double, y: Double)?
  private var moved = false
  private var armed = Date.distantPast
  private var loadedAt = Date.distantPast
  private var focusedAt: Date?
  private var openedAt = Date.distantPast

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

  /// Return or Space was pressed on the page.
  public mutating func keyPressed(at now: Date) { armed = now }

  /// The page (re)loaded.
  public mutating func pageLoaded(at now: Date) { loadedAt = now }

  /// VoiceOver's or Switch Control's focus landed on something inside the page.
  public mutating func focusLanded(at now: Date) { focusedAt = now }

  /// Whether a link activated now is the person's doing.
  public func allows(at now: Date, assistive: Bool) -> Bool {
    if now >= armed && now.timeIntervalSince(armed) < Self.window { return true }
    guard assistive, let focusedAt, focusedAt > openedAt else { return false }
    return now.timeIntervalSince(loadedAt) >= Self.settle && now.timeIntervalSince(openedAt) >= Self.settle
  }

  /// Ask to open a link now: true when it may, and then the tap, key or focus that allowed it is spent.
  public mutating func open(at now: Date, assistive: Bool) -> Bool {
    guard allows(at: now, assistive: assistive) else { return false }
    armed = .distantPast
    openedAt = now
    return true
  }
}
