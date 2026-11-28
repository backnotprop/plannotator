import Foundation
import InboxWire

/// Which of the list's groups are closed (packages/inbox/listGroups.ts, approval "inbox-list-groups-close"): every
/// group closes and opens by a touch on its header; Quiet and the Snoozed band are closed until the person opens
/// them. A closed group keeps the time it was closed, so the list can tell when something new came into it since.
/// The choice is this phone's own, kept in the window's own form ("waiting:1762400000000,quiet:open").
public struct ListFolds: Hashable, Sendable {
  public enum State: Hashable, Sendable {
    case open
    /// Closed since this time (milliseconds, as the window keeps it).
    case closed(since: Int64)
  }

  static let groups: [InboxListGroupId] = [.priority, .stopped, .holding, .waiting, .tagged, .new, .sent, .quiet, .snoozed]
  static let closedByDefault: Set<InboxListGroupId> = [.quiet, .snoozed]

  var choices: [InboxListGroupId: State] = [:]
  /// When the app started: what a group closed by default counts new rows from (`PAGE_LOADED`).
  public var loaded: Int64

  public init(_ raw: String? = nil, loaded: Date = Date()) {
    self.loaded = Int64(loaded.timeIntervalSince1970 * 1000)
    for token in (raw ?? "").split(separator: ",") {
      let bits = token.split(separator: ":", maxSplits: 1).map(String.init)
      guard bits.count == 2, let id = Self.groups.first(where: { $0.rawValue == bits[0] }) else { continue }
      if bits[1] == "open" { choices[id] = .open } else if !bits[1].isEmpty, bits[1].allSatisfy({ $0.isASCII && $0.isNumber }), let since = Int64(bits[1]) { choices[id] = .closed(since: since) }
    }
  }

  /// `formatListGroups`.
  public var raw: String {
    Self.groups.compactMap { id in
      switch choices[id] {
      case .open: return "\(id.rawValue):open"
      case .closed(let since): return "\(id.rawValue):\(since)"
      case nil: return nil
      }
    }.joined(separator: ",")
  }

  /// `groupState`: the person's choice, or the group's default.
  public func state(_ id: InboxListGroupId) -> State {
    choices[id] ?? (Self.closedByDefault.contains(id) ? .closed(since: loaded) : .open)
  }

  public func isOpen(_ id: InboxListGroupId) -> Bool { state(id) == .open }

  /// `toggled`: closing keeps the time; a group open by default opened again loses its entry.
  public mutating func toggle(_ id: InboxListGroupId, now: Date = Date()) {
    if isOpen(id) {
      choices[id] = .closed(since: Int64(now.timeIntervalSince1970 * 1000))
    } else if Self.closedByDefault.contains(id) {
      choices[id] = .open
    } else {
      choices[id] = nil
    }
  }

  /// `reset`: back to its default, as the Snoozed band comes back folded each time it shows.
  public mutating func reset(_ id: InboxListGroupId) { choices[id] = nil }

  /// `newSince`: a closed group's count goes bold when an unread row's latest agent message came after it closed.
  public func hasNews(_ group: InboxListSection) -> Bool {
    guard case .closed(let since) = state(group.id) else { return false }
    return group.threads.contains { row in
      guard row.unread, let at = TimeWords.date(row.lastAgentAt ?? row.lastAt) else { return false }
      return Int64(at.timeIntervalSince1970 * 1000) > since
    }
  }

  /// `FoldedBlocker`: a closed group with an agent stopped or held up inside keeps a warning mark, so a blocker
  /// never hides behind the fold. Its words for a screen reader, or nil when there is none.
  public func blocker(_ group: InboxListSection) -> String? {
    guard !isOpen(group.id) else { return nil }
    let stopped = group.threads.contains { $0.section == .stopped }
    guard stopped || group.threads.contains(where: { $0.section == .holding }) else { return nil }
    let which = group.id == .snoozed ? "snoozed" : "closed"
    return stopped ? "A \(which) thread is stopped on you" : "A \(which) thread is holding up work"
  }
}
