import Foundation

/// Times as the window words them (packages/core/inbox-format.ts): "10:42 AM" today, "Oct 3" before,
/// "Sep 2, 2025" in another year. apps/mobile/contract/vectors/time.json holds the cases.
public struct TimeWords: Sendable {
  public var locale: Locale
  public var timeZone: TimeZone

  public init(locale: Locale = .current, timeZone: TimeZone = .current) {
    self.locale = locale
    self.timeZone = timeZone
  }

  public static func date(_ iso: String) -> Date? {
    if let date = withFraction.date(from: iso) { return date }
    return plain.date(from: iso)
  }

  /// Made once (a formatter is costly to make, and a long list parses a time per row); safe from any thread.
  nonisolated(unsafe) private static let withFraction: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()
  nonisolated(unsafe) private static let plain = ISO8601DateFormatter()

  private var calendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    calendar.locale = locale
    return calendar
  }

  private func format(_ date: Date, _ template: String) -> String {
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.timeZone = timeZone
    formatter.calendar = calendar
    formatter.setLocalizedDateFormatFromTemplate(template)
    return formatter.string(from: date)
  }

  private func day(_ date: Date, now: Date) -> String {
    calendar.component(.year, from: date) == calendar.component(.year, from: now) ? format(date, "MMMd") : format(date, "yMMMd")
  }

  /// A row's time.
  public func short(_ iso: String, now: Date = Date()) -> String {
    guard let date = Self.date(iso) else { return "" }
    return calendar.isDate(date, inSameDayAs: now) ? format(date, "jmm") : day(date, now: now)
  }

  /// When a message was written, as a line in a thread says it.
  public func when(_ iso: String, now: Date = Date()) -> String {
    guard let date = Self.date(iso) else { return "" }
    return calendar.isDate(date, inSameDayAs: now) ? format(date, "jmm") : "\(day(date, now: now)), \(format(date, "jmm"))"
  }

  /// The time alone ("3:12 PM"), as the window's `clockTime` says it on an action item's line.
  public func clock(_ iso: String) -> String {
    guard let date = Self.date(iso) else { return "" }
    return format(date, "jmm")
  }

  /// The contract's rule for comparing with the window's words: iOS puts U+202F before AM and PM.
  public static func normalise(_ text: String) -> String {
    text.replacingOccurrences(of: "\u{202F}", with: " ").replacingOccurrences(of: "\u{00A0}", with: " ")
  }
}
