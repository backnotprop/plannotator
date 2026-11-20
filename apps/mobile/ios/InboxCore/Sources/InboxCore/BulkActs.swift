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
  /// Held for the computer: drawn, and sent or waiting to be.
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
  /// Each row's own offer. One the computer refused, or that gave way, leaves: Undo never sends the reverse of a
  /// write that was never taken.
  var offers: [UndoOffer]
  /// Rows starred: a star has no offer of its own (the window's bulk Undo unstars them).
  var starred: [ThreadID]
  /// Every row the act was made on, refused or not: its toast says the refusals of these.
  public let threads: Set<ThreadID>
  public var count: Int { offers.count + starred.count }

  /// The same Undo without this thread's write (`key`): it was refused or gave way.
  func without(_ key: String, thread: ThreadID, act: ThreadAct?) -> BulkUndo {
    var next = self
    next.offers.removeAll { $0.id == key }
    if act == .star { next.starred.removeAll { $0 == thread } }
    return next
  }
}

/// The threads still to send, shared by the few senders that work through them.
@MainActor
private final class SendLane {
  private var queue: [String]
  private var next = 0
  init(_ queue: [String]) { self.queue = queue }
  func take() -> String? {
    guard next < queue.count else { return nil }
    next += 1
    return queue[next - 1]
  }
}

extension InboxSession {
  /// The Undo on offer for the last act on several rows, if any.
  public var bulkUndoOffer: BulkUndo? { book.undoGroup }

  /// Every reason an act was not taken that the person has not been told yet, by thread.
  public var actionNotices: [ThreadID: Notice] { book.notices }

  /// How many threads' writes go to the computer at a time. The window sends six at once (`AT_ONCE`,
  /// packages/inbox/bulkWrites.ts); the phone sends four.
  static let atOnce = 4

  /// Hold one action on several rows: every row drawn at once, every write in the outbox with one save, and one
  /// Undo on offer for all of them, before anything else can run. Nothing is sent yet (`sendMany` does).
  @discardableResult
  public func holdMany(_ action: BulkAction, until: String? = nil, on threads: [ThreadID]) -> BulkOutcome {
    var outcome = BulkOutcome(action: action)
    guard let act = action.act(until: until) else { return outcome }
    guard canAct(act) else {
      outcome.refused = threads
      outcome.refusal = .notOffered
      return outcome
    }
    // The rows as drawn and as the computer last said them, found once for all of them.
    let now = clock.now()
    var drawn: [ThreadID: InboxListRow] = [:]
    for row in shownList()?.everyRow ?? [] where drawn[row.threadId] == nil { drawn[row.threadId] = ListRules.asOf(row, now: now) }
    var said: [ThreadID: InboxListRow] = [:]
    for row in list?.everyRow ?? [] where said[row.threadId] == nil { said[row.threadId] = row }
    let stars = (list?.pins ?? []).map(\.threadId)
    let expires = now.addingTimeInterval(book.undoSeconds)
    var offers: [UndoOffer] = []
    var starred: [ThreadID] = []
    book.batching = true
    for thread in threads {
      book.notices[thread] = nil
      let earlier = drawn[thread] ?? row(thread, now: now)
      let key = UUID().uuidString
      let (request, body) = act.request(thread: thread, key: key)
      let shown = earlier.map { ShownState(shown: $0, computer: said[thread] ?? self.threads[thread]?.row) }
      enqueue(kind: .state, thread: thread, message: nil, request: request, body: body, key: key, act: act, shown: shown)
      outcome.made.append(thread)
      if let kind = Self.undoKind(act, earlier: earlier) {
        offers.append(UndoOffer(id: key, thread: thread, kind: kind, expires: expires, earlier: earlier, starIndex: stars.firstIndex(of: thread)))
      } else if action == .star {
        starred.append(thread)
      }
    }
    book.batching = false
    saveOutbox()
    if reach == .away { outcome.held = outcome.made.count }
    // One toast, one Undo: it takes the place of the last one, as any new act's does.
    book.undo = nil
    book.undoGroup = nil
    if !offers.isEmpty || !starred.isEmpty {
      let group = BulkUndo(id: UUID().uuidString, action: action, expires: expires, offers: offers, starred: starred, threads: Set(outcome.made))
      book.undoGroup = group
      outcome.undo = group
    }
    return outcome
  }

  /// Send what was held for these threads, a few threads at a time, then read the list once. While the computer
  /// does not answer nothing is tried here: what waits is sent when it is back, as every held write is.
  public func sendMany(_ threads: [ThreadID]) async {
    var seen: Set<String> = []
    let queue = threads.map(\.rawValue).filter { seen.insert($0).inserted }
    guard !queue.isEmpty else { return }
    guard reach != .away else { return retryLater() }
    let lane = SendLane(queue)
    let id = UUID().uuidString
    let lanes = (0..<min(Self.atOnce, queue.count)).map { _ in
      Task { @MainActor [weak self] in
        // The computer stopped answering: what is left waits for it (retryLater), and is never tried one thread
        // and one three-second probe at a time. `stop()` ends the senders too.
        while !Task.isCancelled, let self, self.reach != .away, let thread = lane.take() { await self.pump(thread, readsList: false, quiet: true) }
      }
    }
    sendLanes[id] = lanes
    for task in lanes { await task.value }
    sendLanes[id] = nil
    // Drawn once and saved once for the whole batch, however it ended.
    endQuiet()
    if reach == .away, !held.isEmpty { retryLater() }
    if book.needsListRead, client != nil {
      book.needsListRead = false
      await readList()
    }
  }

  /// Do one action on several rows and send it: each drawn at once, held while the computer is away and sent in
  /// its thread's order, exactly as a single act is. One Undo takes them all back.
  @discardableResult
  public func actMany(_ action: BulkAction, until: String? = nil, on threads: [ThreadID]) async -> BulkOutcome {
    var outcome = holdMany(action, until: until, on: threads)
    await sendMany(outcome.made)
    // What the computer refused, said once for all of them.
    let refused = outcome.made.filter { book.notices[$0] != nil }
    if !refused.isEmpty {
      outcome.refusal = book.notices[refused[0]]
      outcome.refused += refused
      outcome.made.removeAll { refused.contains($0) }
      for thread in refused { book.notices[thread] = nil }
    }
    outcome.held = held.filter { write in write.kind == .state && outcome.made.contains { $0.rawValue == write.thread } }.count
    return outcome
  }

  /// Undo an act on several rows. The rows go back at once: an act still on the phone is taken back and nothing is
  /// sent for it; for one the computer took, its reverse is held, and all of them are saved once and then sent.
  /// False when the offer is gone, or a row could not be put back.
  @discardableResult
  public func undoMany(_ offered: BulkUndo, now: Date? = nil) async -> Bool {
    let now = now ?? clock.now()
    // The offer as it stands now: the rows the computer refused since it was made have left it.
    guard now < offered.expires, let group = book.undoGroup, group.id == offered.id else { return false }
    book.undoGroup = nil
    var all = true
    var touched: [ThreadID] = []
    var slow: [UndoOffer] = []
    let waiting = Set(held.map(\.id))
    var takenBack: Set<String> = []
    book.batching = true
    for offer in group.offers {
      if book.inFlight.contains(offer.id) || book.inDoubt.contains(offer.id) {
        // On its way, or sent with no answer: its own Undo waits for the answer and decides.
        slow.append(offer)
      } else if waiting.contains(offer.id) {
        takenBack.insert(offer.id)
      } else if book.notices[offer.thread] != nil, !book.landed.contains(where: { $0.write.id == offer.id }), book.answers[offer.id] == nil {
        // Refused, so nothing to undo.
        all = false
      } else {
        let shown = shownState(offer.thread, row(offer.thread, now: now))
        for act in reverse(of: offer, now: now) {
          let key = UUID().uuidString
          let (request, body) = act.request(thread: offer.thread, key: key)
          enqueue(kind: .state, thread: offer.thread, message: nil, request: request, body: body, key: key, act: act, shown: shown)
        }
        touched.append(offer.thread)
      }
    }
    for thread in group.starred {
      guard canAct(.unstar) else { all = false; continue }
      let key = UUID().uuidString
      let (request, body) = ThreadAct.unstar.request(thread: thread, key: key)
      enqueue(kind: .state, thread: thread, message: nil, request: request, body: body, key: key, act: .unstar, shown: shownState(thread, row(thread, now: now)))
      touched.append(thread)
    }
    if !takenBack.isEmpty { held.removeAll { takenBack.contains($0.id) } }
    book.batching = false
    saveOutbox()
    await sendMany(touched)
    for offer in slow {
      book.undo = offer
      if !(await undo(offer, now: now)) { all = false }
    }
    if !slow.isEmpty { book.undo = nil }
    if touched.contains(where: { book.notices[$0] != nil }) { all = false }
    return all
  }

  /// Forget the Undo on offer (its toast was dismissed, or another took its place).
  public func dropUndo() {
    book.undo = nil
    book.undoGroup = nil
  }
}
