import Foundation

/// Whether a link in an attached page may open in the browser: only when the person has just activated it
/// themselves. A page's own script can click a link at any time; what tells the two apart is what the person did
/// just before.
///
/// A touch counts only when it was a tap: down and up in nearly one place, briefly. A finger that scrolls the page,
/// or rests on it, arms nothing, so a page cannot send the person to a site while they read. A key that activates
/// (Return, Space) counts as a tap does. With an assistive technology running (VoiceOver, Switch Control, Full
/// Keyboard Access, Voice Control) there is no touch on the page at all, so an activation is taken as the person's.
public struct PageGate: Sendable {
  /// How far a finger may move and still have tapped, in points.
  public static let slop = 12.0
  /// How long a finger may stay down and still have tapped.
  public static let press: TimeInterval = 0.6
  /// How long after a tap or a key a link may open.
  public static let window: TimeInterval = 0.5

  private var down: (at: Date, x: Double, y: Double)?
  private var moved = false
  private var armed = Date.distantPast

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

  /// Whether a link activated now is the person's doing.
  public func allows(at now: Date, assistive: Bool) -> Bool {
    assistive || (now >= armed && now.timeIntervalSince(armed) < Self.window)
  }
}
