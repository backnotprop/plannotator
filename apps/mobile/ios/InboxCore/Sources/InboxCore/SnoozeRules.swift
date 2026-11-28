import Foundation
import InboxWire

/// Snoozing a thread, as the window does it (packages/core/inbox-snooze.ts, approval "inbox-snooze"): the times the
/// menu offers, Pick a time's days and half hours, the "until" words, and the one rule for whether a thread is
/// snoozed. apps/mobile/contract/vectors/snooze.json holds the cases, in six time zones and across clock changes.
///
/// A snooze is `until` (absolute UTC) against the reader's clock at the moment they read it. Every day and time here
/// is the person's local time, built from local parts, so 8:00 AM stays 8:00 AM across a daylight saving change, and
/// a half hour the change skips is not offered.
public struct SnoozeRules: Sendable {
  public var timeZone: TimeZone

  public init(timeZone: TimeZone = .current) { self.timeZone = timeZone }

  /// `INBOX_SNOOZE_MAX_DAYS`: the furthest ahead a snooze may be set.
  public static let maxDays = 366
  /// `INBOX_SNOOZE_DAYS`: how many days Pick a time lists.
  public static let pickDays = 60
  static let laterTodayHours = 3
  /// From this hour (6 PM) Later today is gone.
  static let laterTodayLastHour = 18
  static let morningHour = 8
  static let pickDaysOut = 2
  static let pickHour = 15

  static let weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

  public enum ChoiceID: String, Hashable, Sendable, CaseIterable { case later, tomorrow, days, week }

  public struct Choice: Hashable, Sendable {
    public var id: ChoiceID
    /// The window's words: "Later today", "Tomorrow", "In 3 days", "Next week".
    public var label: String
    public var until: Date
    public var untilISO: String { Self.iso(until) }
    static func iso(_ date: Date) -> String { SnoozeRules.iso(date) }
  }

  public struct Day: Hashable, Sendable {
    /// "2026-11-05", local.
    public var key: String
    /// "Today", "Tomorrow", then "Thu, Nov 5".
    public var label: String
  }

  public struct Time: Hashable, Sendable {
    /// "15:30", local.
    public var key: String
    /// "3:30 PM".
    public var label: String
    public var until: Date
  }

  // MARK: Local parts, as JavaScript's Date reads and builds them

  struct Parts: Hashable {
    var year: Int, month: Int, day: Int, hour: Int, minute: Int, weekday: Int
  }

  private var calendar: Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    return calendar
  }

  func parts(_ date: Date) -> Parts {
    let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .weekday], from: date)
    return Parts(year: c.year ?? 1970, month: c.month ?? 1, day: c.day ?? 1, hour: c.hour ?? 0, minute: c.minute ?? 0, weekday: (c.weekday ?? 1) - 1)
  }

  /// `new Date(year, month, day, hour, minute)`: the day rolls over as JavaScript rolls it (Nov 31 is Dec 1); a time
  /// the clocks skip takes the offset from before the change (2:30 AM becomes 3:30 AM); a time they repeat is the first.
  func local(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 0, _ minute: Int = 0) -> Date {
    var utc = Calendar(identifier: .gregorian)
    utc.timeZone = TimeZone(identifier: "UTC") ?? timeZone
    let wall = utc.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute)) ?? Date(timeIntervalSince1970: 0)
    let before = timeZone.secondsFromGMT(for: wall.addingTimeInterval(-43_200))
    let after = timeZone.secondsFromGMT(for: wall.addingTimeInterval(43_200))
    // Of the two offsets around it, the ones that name this wall time.
    var found: [Date] = []
    for offset in [before, after] {
      let moment: Date = wall.addingTimeInterval(-Double(offset))
      let shift: Int = Int(wall.timeIntervalSince1970 - moment.timeIntervalSince1970)
      if timeZone.secondsFromGMT(for: moment) == shift { found.append(moment) }
    }
    return found.min() ?? wall.addingTimeInterval(-Double(before))
  }

  private func dayOf(_ date: Date, _ days: Int = 0) -> Date {
    let p = parts(date)
    return local(p.year, p.month, p.day + days)
  }

  private func morningOf(_ date: Date, _ days: Int) -> Date {
    let p = parts(date)
    return local(p.year, p.month, p.day + days, Self.morningHour)
  }

  func clock(_ date: Date) -> String {
    let p = parts(date)
    return "\(p.hour % 12 == 0 ? 12 : p.hour % 12):\(String(format: "%02d", p.minute)) \(p.hour < 12 ? "AM" : "PM")"
  }

  private func dayKey(_ date: Date) -> String {
    let p = parts(date)
    return String(format: "%04d-%02d-%02d", p.year, p.month, p.day)
  }

  // MARK: The window's rules

  /// `inboxSnoozeWhen`: "5:00 PM" today, "Wed 8:00 AM" within the week, "Nov 12, 8:00 AM" further on.
  public func when(_ iso: String, now: Date = Date()) -> String {
    guard let date = Self.date(iso) else { return "" }
    let p = parts(date), n = parts(now)
    if p.year == n.year, p.month == n.month, p.day == n.day { return clock(date) }
    // Whole days between the two local midnights, rounded: a day across a clock change is 23 or 25 hours.
    let days = Int(((dayOf(date).timeIntervalSince1970 - dayOf(now).timeIntervalSince1970) / 86_400).rounded())
    if days > 0, days < 7 { return "\(Self.weekdays[p.weekday]) \(clock(date))" }
    return "\(Self.months[p.month - 1]) \(p.day), \(clock(date))"
  }

  /// `inboxSnoozeChoices`: Later today (three hours from the start of this hour, gone from 6 PM), Tomorrow and In 3
  /// days at 8:00 AM, Next week on Monday 8:00 AM (a full week on when today is Monday). A choice that lands on the
  /// time of one above it is dropped.
  public func choices(now: Date = Date()) -> [Choice] {
    let n = parts(now)
    var made: [(ChoiceID, String, Date)] = []
    if n.hour < Self.laterTodayLastHour { made.append((.later, "Later today", local(n.year, n.month, n.day, n.hour + Self.laterTodayHours))) }
    made.append((.tomorrow, "Tomorrow", morningOf(now, 1)))
    made.append((.days, "In 3 days", morningOf(now, 3)))
    let toMonday = (8 - n.weekday) % 7
    made.append((.week, "Next week", morningOf(now, toMonday == 0 ? 7 : toMonday)))
    var seen: Set<Date> = []
    return made.compactMap { id, label, when in seen.insert(when).inserted ? Choice(id: id, label: label, until: when) : nil }
  }

  /// `inboxSnoozeTimes`: the half hours left on a day, every local time that exists that day and has not passed.
  public func times(day key: String, now: Date = Date()) -> [Time] {
    let bits = key.split(separator: "-").compactMap { Int($0) }
    guard bits.count == 3 else { return [] }
    var out: [Time] = []
    for half in 0..<48 {
      let hours = half / 2, minutes = half % 2 == 1 ? 30 : 0
      let date = local(bits[0], bits[1], bits[2], hours, minutes)
      let p = parts(date)
      if p.hour != hours || p.minute != minutes || date <= now { continue }
      out.append(Time(key: String(format: "%02d:%02d", hours, minutes), label: clock(date), until: date))
    }
    return out
  }

  /// `inboxSnoozeDays`: Pick a time's days, today first. Today goes when no half hour is left in it.
  public func days(now: Date = Date(), count: Int = SnoozeRules.pickDays) -> [Day] {
    var out: [Day] = []
    for offset in 0..<max(count, 0) {
      let date = dayOf(now, offset)
      let key = dayKey(date)
      if offset == 0, times(day: key, now: now).isEmpty { continue }
      let p = parts(date)
      out.append(Day(key: key, label: offset == 0 ? "Today" : offset == 1 ? "Tomorrow" : "\(Self.weekdays[p.weekday]), \(Self.months[p.month - 1]) \(p.day)"))
    }
    return out
  }

  /// `inboxSnoozeFirstPick`: where Pick a time opens, two days out at 3:00 PM.
  public func firstPick(now: Date = Date()) -> (day: String, time: String) {
    (dayKey(dayOf(now, Self.pickDaysOut)), String(format: "%02d:00", Self.pickHour))
  }

  /// `inboxSnoozeKeepTime`: the picked time on a newly picked day, or the next one on, else the day's last.
  public static func keepTime(_ times: [Time], _ time: String) -> String? {
    (times.first { $0.key >= time } ?? times.last)?.key
  }

  /// `inboxSnoozeRunning`: a snooze runs while `until` is ahead of the reader's clock.
  public static func running(_ until: String, now: Date = Date()) -> Bool {
    guard let date = date(until) else { return false }
    return date > now
  }

  public enum Refusal: String, Hashable, Sendable { case invalid, past, far }

  /// `inboxSnoozeRefusal`: why a snooze time is refused (the Inbox refuses the same).
  public static func refusal(_ until: String?, now: Date = Date()) -> Refusal? {
    guard let until, let at = date(until) else { return .invalid }
    if at <= now { return .past }
    return at > now.addingTimeInterval(Double(maxDays) * 86_400) ? .far : nil
  }

  /// `inboxSnoozeDelay`: how long until the nearest snooze still ahead is over, or nil.
  public static func delay(_ untils: [String], now: Date = Date()) -> TimeInterval? {
    untils.compactMap(date).map { $0.timeIntervalSince(now) }.filter { $0 > 0 }.min()
  }

  // MARK: Times on the wire

  public static func date(_ iso: String) -> Date? {
    // JavaScript's Date.parse takes the ISO forms the Inbox writes; anything else is not a time.
    TimeWords.date(iso)
  }

  public static func iso(_ date: Date) -> String { isoFormatter.string(from: date) }

  /// Made once: a list of a thousand rows asks for a stamp per act drawn, and a formatter is costly to make.
  /// `ISO8601DateFormatter` is safe to use from any thread once set up.
  nonisolated(unsafe) private static let isoFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.timeZone = TimeZone(identifier: "UTC")
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()
}
