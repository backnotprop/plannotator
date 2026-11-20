import Foundation
import InboxWire

/// What the picked rows can take at once (packages/inbox/rowPicks.ts `BulkAction`). Hiding pull requests and tags
/// are not here: the phone's door has no route for them yet.
public enum BulkAction: String, Hashable, Sendable, CaseIterable {
  case archive, snooze, read, unread, star, unstar
  case priorityAdd = "priority-add"
  case priorityRemove = "priority-remove"

  /// `bulkTargets`: the picked rows this action takes; a row it cannot take is left as it is. `drawn`: the group a
  /// row is drawn in. `starred`: the threads starred now.
  public static func targets(_ rows: [InboxListRow], _ action: BulkAction, drawn: (InboxListRow) -> InboxListGroupId?, starred: Set<ThreadID>) -> [InboxListRow] {
    rows.filter { row in
      switch action {
      case .archive: return row.resolvedAt == nil
      case .snooze: return !ListRules.archived(row)
      case .read: return RowOffers.offersMarkRead(row, drawn: drawn(row))
      case .unread: return RowOffers.canMarkUnread(row)
      case .star: return !starred.contains(row.threadId)
      case .unstar: return starred.contains(row.threadId)
      case .priorityAdd: return RowOffers.priority(row) == .priorityAdd
      case .priorityRemove: return RowOffers.priority(row) == .priorityRemove
      }
    }
  }

  /// The act this makes on one row. `until`: a snooze's time.
  func act(until: String?) -> ThreadAct? {
    switch self {
    case .archive: return .archive
    case .snooze: return until.map { .snooze(until: $0, at: nil) }
    case .read: return .read
    case .unread: return .markUnread
    case .star: return .star
    case .unstar: return .unstar
    case .priorityAdd: return .priority(true)
    case .priorityRemove: return .priority(false)
    }
  }
}

/// What came of an act on several rows: one toast says it (ActionWords.bulk).
public struct BulkOutcome: Hashable, Sendable {
  public var action: BulkAction
  /// Taken by the computer or waiting on the phone for it.
  public var made: [ThreadID] = []
  /// Of those, the ones that wait: the computer is away.
  public var held = 0
  public var refused: [ThreadID] = []
  /// The first refusal, for the toast's words.
  public var refusal: InboxSession.Notice?
  /// The one Undo for all of them, if any was made.
  public var undo: BulkUndo?
}

/// One Undo for an act on several rows, for the same 7 seconds as a single act's.
public struct BulkUndo: Hashable, Sendable, Identifiable {
  public let id: String
  public let action: BulkAction
  public let expires: Date
  /// Each row's own offer.
  let offers: [UndoOffer]
  /// Rows starred: a star has no offer of its own (the window's bulk Undo unstars them).
  let starred: [ThreadID]
  public var count: Int { offers.count + starred.count }
}

extension InboxSession {
  /// The Undo on offer for the last act on several rows, if any.
  public var bulkUndoOffer: BulkUndo? { book.undoGroup }

  /// Every reason an act was not taken that the person has not been told yet, by thread.
  public var actionNotices: [ThreadID: Notice] { book.notices }

  /// Do one action on several rows: each drawn at once, held while the computer is away and sent in its thread's
  /// order, exactly as a single act is. One Undo takes them all back.
  @discardableResult
  public func actMany(_ action: BulkAction, until: String? = nil, on threads: [ThreadID]) async -> BulkOutcome {
    var outcome = BulkOutcome(action: action)
    guard let act = action.act(until: until) else { return outcome }
    book.undoGroup = nil
    var offers: [UndoOffer] = []
    var starred: [ThreadID] = []
    for thread in threads {
      book.undo = nil
      switch await self.act(act, on: thread, undo: true) {
      case .done, .waits:
        outcome.made.append(thread)
        if held.contains(where: { $0.kind == .state && $0.thread == thread.rawValue && $0.act == act }) { outcome.held += 1 }
        if let offer = book.undo, offer.thread == thread { offers.append(offer) } else if action == .star { starred.append(thread) }
      case .refused:
        outcome.refused.append(thread)
        if outcome.refusal == nil { outcome.refusal = book.notices[thread] }
        // The toast says it once for all of them.
        book.notices[thread] = nil
      case .notOffered:
        outcome.refused.append(thread)
        if outcome.refusal == nil { outcome.refusal = .notOffered }
      }
    }
    book.undo = nil
    if !offers.isEmpty || !starred.isEmpty {
      // One clock for all of them, started when the last one was made.
      let expires = clock.now().addingTimeInterval(UndoOffer.seconds)
      let group = BulkUndo(
        id: UUID().uuidString, action: action, expires: expires,
        offers: offers.map { UndoOffer(id: $0.id, thread: $0.thread, kind: $0.kind, expires: expires, earlier: $0.earlier, starIndex: $0.starIndex) }, starred: starred)
      book.undoGroup = group
      outcome.undo = group
    }
    return outcome
  }

  /// Undo an act on several rows: each row's own Undo, in the order they were made. False when the offer is gone,
  /// or any row could not be put back.
  @discardableResult
  public func undoMany(_ group: BulkUndo, now: Date? = nil) async -> Bool {
    let now = now ?? clock.now()
    guard now < group.expires, book.undoGroup?.id == group.id else { return false }
    book.undoGroup = nil
    var all = true
    for offer in group.offers {
      book.undo = offer
      if !(await undo(offer, now: now)) { all = false }
    }
    for thread in group.starred where await self.act(.unstar, on: thread, undo: false) == .refused { all = false }
    book.undo = nil
    return all
  }

  /// Forget the Undo on offer (its toast was dismissed, or another took its place).
  public func dropUndo() {
    book.undo = nil
    book.undoGroup = nil
  }
}
