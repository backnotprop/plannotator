import Foundation
import InboxWire

/// What the list draws from a read, by the window's own rules (packages/shared/inbox/list.ts,
/// packages/core/inbox-snooze.ts, packages/inbox/held.ts, tabCount.ts, pins.ts): archived threads out, snoozed ones
/// apart in the band and back in their section when their time is over, the Priority group first, the badge, the
/// stars. apps/mobile/contract/vectors/rows.json and snooze.json hold the cases.
///
/// The phone reads `GET threads` with no query, so archived threads come in Quiet and snoozed ones in their
/// sections; the window asks with `?archived=exclude&snoozed=exclude`. `ListView.of` makes the one from the other,
/// and takes either.
public enum ListRules {
  /// `INBOX_SECTIONS`: the approved order.
  public static let sectionOrder: [InboxSectionId] = [.stopped, .holding, .waiting, .new, .sent, .quiet]

  /// `inboxRowArchived`: resolved, and not come back.
  public static func archived(_ row: InboxListRow) -> Bool { row.resolvedAt != nil && row.backFromArchive != true }

  /// `inboxRowInPriority`: it carries a priority, and is neither snoozed (the band wins) nor archived.
  public static func inPriority(_ row: InboxListRow) -> Bool { row.priority != nil && row.snoozed == nil && !archived(row) }

  /// `inboxRowSnoozed`: snoozed now, by the reader's clock.
  public static func snoozed(_ row: InboxListRow, now: Date) -> Bool {
    guard let snooze = row.snoozed else { return false }
    return SnoozeRules.running(snooze.until, now: now)
  }

  /// `inboxRowAsOf`: a snooze past its time is a return, back in its own section (Quiet comes back as New), bold,
  /// at its return time, until the person reads it. An archived thread stays archived and is no longer snoozed.
  public static func asOf(_ row: InboxListRow, now: Date) -> InboxListRow {
    guard let snooze = row.snoozed, !SnoozeRules.running(snooze.until, now: now) else { return row }
    var out = row
    out.snoozed = nil
    if archived(row) { return out }
    out.snoozeBack = snooze.until
    out.unread = true
    if row.section == .quiet { out.section = .new }
    if snooze.until > row.lastAt { out.lastAt = snooze.until }
    return out
  }

  /// JavaScript's `localeCompare` for the strings the list sorts by (ISO times, thread ids).
  static func compare(_ left: String, _ right: String) -> ComparisonResult {
    left.compare(right, options: [], range: nil, locale: Locale(identifier: "en"))
  }

  static func newestFirst(_ left: InboxListRow, _ right: InboxListRow) -> Bool {
    switch compare(right.lastAt, left.lastAt) {
    case .orderedAscending: return true
    case .orderedDescending: return false
    case .orderedSame: return compare(left.threadId.rawValue, right.threadId.rawValue) == .orderedAscending
    }
  }

  /// The band's order: soonest back first; ties on the thread id.
  static func soonestBack(_ left: InboxListRow, _ right: InboxListRow) -> Bool {
    let l = left.snoozed.flatMap { SnoozeRules.date($0.until) }?.timeIntervalSince1970 ?? .nan
    let r = right.snoozed.flatMap { SnoozeRules.date($0.until) }?.timeIntervalSince1970 ?? .nan
    if l != r, !l.isNaN, !r.isNaN { return l < r }
    return compare(left.threadId.rawValue, right.threadId.rawValue) == .orderedAscending
  }

  /// `inboxSplitSnoozed`: those still snoozed apart, soonest first; the others as they stand by `now`.
  public static func splitSnoozed(_ rows: [InboxListRow], now: Date) -> (rows: [InboxListRow], snoozed: [InboxListRow]) {
    var listed: [InboxListRow] = []
    var band: [InboxListRow] = []
    for row in rows {
      let standing = asOf(row, now: now)
      if snoozed(standing, now: now) { band.append(standing) } else { listed.append(standing) }
    }
    return (listed, band.sorted(by: soonestBack))
  }

  /// `inboxSectionsAsOf`: snoozed rows read apart, by `now`: those whose time is over go back into their section,
  /// sorted in newest first; the others stay in the band, soonest first.
  public static func sectionsAsOf(_ sections: [InboxListSection], snoozed: [InboxListRow], now: Date) -> (sections: [InboxListSection], snoozed: [InboxListRow]) {
    let split = splitSnoozed(snoozed, now: now)
    guard !split.rows.isEmpty else { return (sections, split.snoozed) }
    return (sections.map { section in
      let back = split.rows.filter { $0.section.rawValue == section.id.rawValue }
      guard !back.isEmpty else { return section }
      var out = section
      out.threads = (section.threads + back).sorted(by: newestFirst)
      return out
    }, split.snoozed)
  }

  /// `inboxListSections`: every section in the approved order, each newest first (empty ones included).
  public static func sections(_ rows: [InboxListRow]) -> [InboxListSection] {
    sectionOrder.map { id in
      InboxListSection(id: InboxListGroupId(rawValue: id.rawValue), label: Words.sections[id.rawValue] ?? id.rawValue, threads: rows.filter { $0.section == id }.sorted(by: newestFirst))
    }
  }

  /// `listGroups`: the Priority group (newest first), the sections without the rows it took, then the Snoozed band.
  public static func groups(sections: [InboxListSection], snoozed: [InboxListRow]) -> [InboxListSection] {
    var first: [InboxListRow] = []
    let rest = sections.map { section -> InboxListSection in
      guard section.threads.contains(where: inPriority) else { return section }
      first += section.threads.filter(inPriority)
      var out = section
      out.threads = section.threads.filter { !inPriority($0) }
      return out
    }
    return [InboxListSection(id: .priority, label: Words.groupPriority, threads: first.sorted(by: newestFirst))] + rest
      + [InboxListSection(id: .snoozed, label: Words.groupSnoozed, threads: snoozed)]
  }

  /// `inboxTabCount`: threads with agent messages the person has not looked at; an archived one only when it came back.
  public static func badge(_ sections: [InboxListSection]) -> Int {
    var counted: Set<ThreadID> = []
    for section in sections {
      for row in section.threads where row.unseen > 0 && (row.resolvedAt == nil || row.backFromArchive == true) { counted.insert(row.threadId) }
    }
    return counted.count
  }

  /// `tabBadgeLabel`: "" for none, "9+" past nine.
  public static func badgeLabel(_ count: Int) -> String { count <= 0 ? "" : count > 9 ? "9+" : String(count) }

  /// `waitingCount`: the rows that wait on the person (Stopped, Holding, Waiting).
  public static func waitingCount(_ sections: [InboxListSection]) -> Int {
    sections.filter { [.stopped, .holding, .waiting].contains($0.id) }.reduce(0) { $0 + $1.threads.count }
  }

  /// `inboxArchivedRows`: newest archived first; ties on the thread id.
  public static func archivedRows(_ rows: [InboxListRow]) -> [InboxListRow] {
    rows.filter(archived).sorted { left, right in
      switch compare(right.resolvedAt ?? "", left.resolvedAt ?? "") {
      case .orderedAscending: return true
      case .orderedDescending: return false
      case .orderedSame: return compare(left.threadId.rawValue, right.threadId.rawValue) == .orderedAscending
      }
    }
  }

  /// `pinnedState`'s kind: what a star's pill shows.
  public enum PinnedState: String, Hashable, Sendable { case stop, hold, wait, new, sent, quiet, archived }

  public static func pinnedState(_ row: InboxListRow) -> PinnedState {
    if archived(row) { return .archived }
    switch row.section {
    case .stopped: return .stop
    case .holding: return .hold
    case .waiting: return .wait
    case .new: return row.unseen > 0 ? .new : .quiet
    case .sent: return .sent
    default: return .quiet
    }
  }

  /// `movePin`: the stars' order after moving one up (-1) or down (+1); unchanged at an end or for one not starred.
  public static func movePin(_ order: [ThreadID], _ thread: ThreadID, by: Int) -> [ThreadID] {
    var next = order
    guard let at = next.firstIndex(of: thread) else { return next }
    let to = at + by
    guard to >= 0, to < next.count else { return next }
    next.swapAt(at, to)
    return next
  }
}

/// The list as drawn at one moment: what a list screen shows, and when it next changes by itself.
public struct ListView: Hashable, Sendable {
  /// The Priority group, the six sections, then the Snoozed band. Empty groups are kept: the screen leaves them out.
  public var groups: [InboxListSection]
  /// The sections as counted (no group taken out): what the badge and the waiting count read.
  public var sections: [InboxListSection]
  /// The starred threads, in the person's order (an archived one stays starred).
  public var pins: [InboxListRow]
  /// The app icon's count (the window's tab count) and its label.
  public var badge: Int
  public var badgeLabel: String { ListRules.badgeLabel(badge) }
  /// The rows that wait on the person.
  public var waiting: Int
  /// Archived threads the read carried (an Inbox that keeps them in Quiet), newest archived first.
  public var archived: [InboxListRow]
  /// When the soonest snooze ends: the list changes by itself then.
  public var nextWake: Date?

  /// The group a thread is drawn in now, or nil.
  public func group(of thread: ThreadID) -> InboxListGroupId? {
    groups.first { $0.threads.contains { $0.threadId == thread } }?.id ?? (archived.contains { $0.threadId == thread } ? .archived : nil)
  }

  public func row(_ thread: ThreadID) -> InboxListRow? {
    for group in groups { if let row = group.threads.first(where: { $0.threadId == thread }) { return row } }
    return archived.first { $0.threadId == thread } ?? pins.first { $0.threadId == thread }
  }

  /// Draw a read at `now`: the window's read (archived out, snoozed apart) and its clock over it.
  public static func of(_ model: ListModel, now: Date = Date()) -> ListView {
    var seen: Set<ThreadID> = []
    var rows: [InboxListRow] = []
    var carried: [InboxListRow] = model.sections.flatMap(\.threads)
    carried.append(contentsOf: model.snoozed ?? [])
    for row in carried where seen.insert(row.threadId).inserted { rows.append(row) }
    let split = ListRules.splitSnoozed(rows.filter { !ListRules.archived($0) }, now: now)
    let sections = ListRules.sections(split.rows)
    let byID = Dictionary(rows.map { ($0.threadId, ListRules.asOf($0, now: now)) }, uniquingKeysWith: { first, _ in first })
    let pins = (model.pins ?? []).map { byID[$0.threadId] ?? ListRules.asOf($0, now: now) }
    let wake = SnoozeRules.delay(split.snoozed.compactMap { $0.snoozed?.until }, now: now).map { now.addingTimeInterval($0) }
    return ListView(
      groups: ListRules.groups(sections: sections, snoozed: split.snoozed), sections: sections, pins: pins, badge: ListRules.badge(sections),
      waiting: ListRules.waitingCount(sections), archived: ListRules.archivedRows(rows), nextWake: wake)
  }
}
