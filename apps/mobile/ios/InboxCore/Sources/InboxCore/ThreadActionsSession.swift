import Foundation
import InboxWire

/// What the session keeps for thread actions.
struct ActionBook {
  struct Landed { var seq: Int; var write: HeldWrite }
  /// Why an act on a thread was not taken, until the person acts on that thread again.
  var notices: [ThreadID: InboxSession.Notice] = [:]
  /// The one Undo on offer (a new one replaces it, as the window's one toast does).
  var undo: UndoOffer?
  /// Acts the computer took whose effect the last list read may not hold yet: still drawn over it.
  var landed: [Landed] = []
  var landSeq = 0
  /// What each landed act answered (Priority's `before`, Mark unread's `through_seq`), for its Undo. Kept for the
  /// last few only.
  var answers: [String: Data] = [:]
  var answerOrder: [String] = []
  /// Writes on their way now: too late to take back without a reply of their own.
  var inFlight: Set<String> = []
  /// Writes sent with no definite answer: the computer may have taken them, so an Undo sends the reverse.
  var inDoubt: Set<String> = []
  /// A list read this pump already made for a waited act.
  var checked = false
  var needsListRead = false
  /// The Archived group as last read (`GET threads/archived`) and how many it asks for.
  var archived: ArchivedModel?
  var archivedLimit = UndoOffer.archivedFirst
  /// A snooze ends: the list changes by itself then.
  var wake: Task<Void, Never>?
  /// Moves when a snooze ends, so what reads the list draws again.
  var tick = 0
}

/// What time it is, and how to wait for a time. The system clock in the app; a clock the tests move by hand.
public struct SessionClock: Sendable {
  public var now: @Sendable () -> Date
  /// Wait this many seconds (throws when the waiting task is cancelled).
  public var sleep: @Sendable (TimeInterval) async throws -> Void

  public init(now: @escaping @Sendable () -> Date, sleep: @escaping @Sendable (TimeInterval) async throws -> Void) {
    self.now = now
    self.sleep = sleep
  }

  public static let system = SessionClock(now: { Date() }, sleep: { try await Task.sleep(for: .milliseconds(Int($0 * 1000))) })
}

/// The Undo the window's toast offers after an act, for 7 seconds (`MARK_READ_UNDO_MS`, contract check list-11).
public struct UndoOffer: Hashable, Sendable, Identifiable {
  public enum Kind: Hashable, Sendable {
    case archived, unarchived, markedRead, markedUnread, unstarred
    case snoozed(until: String)
    case unsnoozed, priorityAdded, priorityRemoved
  }

  public static let seconds: TimeInterval = 7
  /// The Archived group's first read and each "Show more" (packages/inbox/data/queries/archived.ts).
  public static let archivedFirst = 20
  public static let archivedMax = 100

  /// The act's idempotency key.
  public let id: String
  public let thread: ThreadID
  public let kind: Kind
  public let expires: Date
  /// The row before the act: what its Undo puts back.
  let earlier: InboxListRow?
  /// Where the star stood before an Unstar.
  let starIndex: Int?
}

/// What came of asking for an act.
public enum ActOutcome: Hashable, Sendable {
  /// Taken by the computer, or waiting on the phone for it: drawn either way.
  case done
  /// Waits on the phone: the computer is away.
  case waits
  /// The computer refused it; `actionNotice(thread)` says why.
  case refused
  /// This Inbox does not offer it.
  case notOffered
}

extension InboxSession {
  // MARK: Reading

  /// The Undo on offer now, if any.
  public var undoOffer: UndoOffer? { book.undo }

  /// Why the last act on this thread was not taken, until the person acts on the thread again.
  public func actionNotice(_ thread: ThreadID) -> Notice? { book.notices[thread] }
  public func clearActionNotice(_ thread: ThreadID) { book.notices[thread] = nil }

  /// Every act still on the phone or landed and not yet in a list read, oldest first.
  private var drawnActs: [HeldWrite] {
    book.landed.map(\.write) + held.filter { $0.kind == .state && $0.act != nil }
  }

  /// The list as the computer last said, with the person's acts drawn over it.
  public func shownList() -> ListModel? {
    guard var model = list else { return nil }
    let acts = drawnActs
    guard !acts.isEmpty else { return model }
    func draw(_ row: InboxListRow) -> InboxListRow {
      acts.filter { $0.thread == row.threadId.rawValue }.reduce(row) { row, write in write.act!.drawn(row, at: SnoozeRules.iso(write.madeAt)) }
    }
    for index in model.sections.indices { model.sections[index].threads = model.sections[index].threads.map(draw) }
    model.snoozed = model.snoozed?.map(draw)
    // The stars: drawn in their new order, each row as it stands.
    var rows: [ThreadID: InboxListRow] = [:]
    for row in model.sections.flatMap(\.threads) + (model.snoozed ?? []) + (model.pins ?? []).map(draw) { rows[row.threadId] = rows[row.threadId] ?? row }
    var order = (model.pins ?? []).map(\.threadId)
    for write in acts { order = write.act!.drawnStars(order, thread: ThreadID(write.thread)) }
    if model.pins != nil || acts.contains(where: { if case .star = $0.act { return true }; return false }) {
      model.pins = order.compactMap { rows[$0] }
    }
    return model
  }

  /// The list drawn at `now` (the session's clock when nil): groups, stars, badge and when it next changes by itself.
  public func listView(now: Date? = nil) -> ListView? {
    _ = book.tick
    let now = now ?? clock.now()
    return shownList().map { ListView.of($0, now: now) }
  }

  /// A thread's row as the list draws it, else as its last read carried it.
  public func row(_ thread: ThreadID, now: Date? = nil) -> InboxListRow? {
    let now = now ?? clock.now()
    if let row = listView(now: now)?.row(thread) { return row }
    if let row = archivedRows().first(where: { $0.threadId == thread }) { return row }
    guard let row = threads[thread]?.row else { return nil }
    let acts = drawnActs.filter { $0.thread == thread.rawValue }
    return ListRules.asOf(acts.reduce(row) { $1.act!.drawn($0, at: SnoozeRules.iso($1.madeAt)) }, now: now)
  }

  /// The Archived group: its last read with the person's acts drawn over it, else the archived threads the list
  /// carried. Newest archived first.
  public func archivedRows() -> [InboxListRow] {
    let acts = drawnActs
    var rows = book.archived?.threads ?? ListView.of(list ?? ListModel(serverSession: "", version: "", cursor: 0, projects: [], sections: [])).archived
    rows = rows.map { row in acts.filter { $0.thread == row.threadId.rawValue }.reduce(row) { $1.act!.drawn($0, at: SnoozeRules.iso($1.madeAt)) } }
    // A thread archived here and not read back yet joins the group.
    for write in acts where write.act == .archive && !rows.contains(where: { $0.threadId.rawValue == write.thread }) {
      if let row = list.flatMap({ ListView.of($0).row(ThreadID(write.thread)) }) { rows.append(write.act!.drawn(row, at: SnoozeRules.iso(write.madeAt))) }
    }
    return ListRules.archivedRows(rows)
  }

  /// Whether the Archived group has more to show.
  public var archivedHasMore: Bool {
    guard let read = book.archived else { return false }
    return Int64(read.threads.count) < read.total && book.archivedLimit < UndoOffer.archivedMax
  }

  /// Read the Archived group (`GET threads/archived`): 20 first, then 20 more each time, up to 100, as the window.
  public func readArchived(more: Bool = false) async {
    if more { book.archivedLimit = min(book.archivedLimit + UndoOffer.archivedFirst, UndoOffer.archivedMax) }
    if client == nil { _ = await connect() }
    guard let client, offers(DoorRoutes.getThreadsArchived) else { return }
    do {
      book.archived = try await client.get(Door.getThreadsArchived(), query: [URLQueryItem(name: "offset", value: "0"), URLQueryItem(name: "limit", value: String(book.archivedLimit))], as: ArchivedModel.self)
    } catch let failure as DoorFailure {
      _ = failure
    } catch {}
  }

  // MARK: Acting

  /// Whether this Inbox offers the act (a route it does not list is never called).
  public func canAct(_ act: ThreadAct) -> Bool { standing == .ok && (skew == nil || offers(act.route)) }

  /// Do one act on a thread: drawn at once, held while the computer is away, sent in order with the thread's other
  /// writes. `undo`: offer the window's Undo for it.
  @discardableResult
  public func act(_ act: ThreadAct, on thread: ThreadID, undo: Bool = true) async -> ActOutcome {
    guard canAct(act) else { return .notOffered }
    book.notices[thread] = nil
    let earlier = row(thread)
    let starIndex = list?.pins?.firstIndex { $0.threadId == thread }
    let key = UUID().uuidString
    let (request, body) = act.request(thread: thread, key: key)
    enqueue(kind: .state, thread: thread, message: nil, request: request, body: body, key: key, act: act, shown: shownState(thread, earlier))
    if undo, let kind = Self.undoKind(act, earlier: earlier) {
      book.undo = UndoOffer(id: key, thread: thread, kind: kind, expires: clock.now().addingTimeInterval(UndoOffer.seconds), earlier: earlier, starIndex: starIndex)
    }
    await pump(thread.rawValue)
    if book.notices[thread] != nil { return .refused }
    return held.contains { $0.id == key } ? .waits : .done
  }

  /// Which acts the window offers an Undo for (Star and a new order have none).
  static func undoKind(_ act: ThreadAct, earlier: InboxListRow?) -> UndoOffer.Kind? {
    switch act {
    case .archive: return .archived
    case .unarchive: return .unarchived
    case .read: return .markedRead
    case .markUnread: return .markedUnread
    case .unstar: return earlier?.pinnedAt == nil ? nil : .unstarred
    case .snooze(let until, _): return .snoozed(until: until)
    // Unsnooze offers Undo only when a snooze stood.
    case .unsnooze: return earlier?.snoozed == nil ? nil : .unsnoozed
    case .priority(let on): return on ? .priorityAdded : .priorityRemoved
    default: return nil
    }
  }

  /// Undo an act. When the act has not left the phone yet, it is taken back and nothing is sent; otherwise the
  /// window's reverse is sent after it. False when the offer is gone (its 7 seconds passed, or another replaced it),
  /// or there is nothing it can send back.
  @discardableResult
  public func undo(_ offer: UndoOffer, now: Date? = nil) async -> Bool {
    let now = now ?? clock.now()
    guard now < offer.expires, book.undo?.id == offer.id else { return false }
    book.undo = nil
    if held.contains(where: { $0.id == offer.id }), !book.inFlight.contains(offer.id), !book.inDoubt.contains(offer.id) {
      settle(offer.id)
      return true
    }
    // On its way now: its answer decides the reverse.
    while book.inFlight.contains(offer.id) { try? await Task.sleep(for: .milliseconds(15)) }
    // Refused, so nothing to undo: the refusal says so.
    if book.notices[offer.thread] != nil, !book.landed.contains(where: { $0.write.id == offer.id }), book.answers[offer.id] == nil { return false }
    let reverse = reverse(of: offer, now: now)
    // Sent with no definite answer, so still held: whether the computer took it is not known. It goes no further, and
    // each reverse waits to meet the computer's row, which says whether there is anything to take back.
    let inDoubt = held.contains { $0.id == offer.id }
    if inDoubt {
      guard !reverse.isEmpty else { return false }
    }
    let shown = shownState(offer.thread, row(offer.thread, now: now))
    if inDoubt { settle(offer.id) }
    for act in reverse {
      let key = UUID().uuidString
      let (request, body) = act.request(thread: offer.thread, key: key)
      enqueue(kind: .state, thread: offer.thread, message: nil, request: request, body: body, key: key, act: act, shown: shown, waited: inDoubt)
    }
    await pump(offer.thread.rawValue)
    return true
  }

  /// The window's reverse of each act (App.tsx archive's onUndo, markRead's, snoozeWrites.ts, priorityWrites.ts,
  /// pins' restore), from the row before it and what the computer answered.
  func reverse(of offer: UndoOffer, now: Date) -> [ThreadAct] {
    let earlier = offer.earlier
    let snoozeBack: [ThreadAct] = earlier?.snoozed.flatMap { SnoozeRules.running($0.until, now: now) ? [.snooze(until: $0.until, at: $0.at)] : nil } ?? []
    let answer = book.answers[offer.id]
    switch offer.kind {
    case .archived:
      let priority: [ThreadAct] = earlier?.priority.map { [.restorePriority(at: $0.at, offAt: nil)] } ?? []
      return [.unarchive] + snoozeBack + priority
    case .unarchived:
      return [.archive]
    case .markedRead:
      return snoozeBack + [earlier?.readAt == nil ? .moveBack : .markUnread]
    case .markedUnread:
      guard let read = answer.flatMap({ try? JSONDecoder().decode(DoorMarkUnreadAnswer.self, from: $0) }), read.wrote else { return [] }
      return [.seen(throughSeq: read.throughSeq)]
    case .unstarred:
      guard let index = offer.starIndex, let pinnedAt = earlier?.pinnedAt else { return [] }
      return [.restoreStar(index: index, pinnedAt: pinnedAt)]
    case .snoozed:
      guard let snooze = earlier?.snoozed, SnoozeRules.running(snooze.until, now: now) else { return [.unsnooze] }
      return [.snooze(until: snooze.until, at: snooze.at)]
    case .unsnoozed:
      guard let snooze = earlier?.snoozed else { return [] }
      return [.snooze(until: snooze.until, at: snooze.at)]
    case .priorityAdded, .priorityRemoved:
      if let before = answer.flatMap({ try? JSONDecoder().decode(DoorPriorityAnswer.self, from: $0) })?.before { return [.restorePriority(at: before.at, offAt: before.offAt)] }
      return [.priority(offer.kind == .priorityRemoved)]
    }
  }

  // MARK: The session's hooks (InboxSession.swift)

  /// An act the computer took: drawn until the next list read holds it, and its answer kept for its Undo.
  func landAct(_ write: HeldWrite, _ answer: DoorAnswerBytes) {
    book.landSeq += 1
    book.landed.append(ActionBook.Landed(seq: book.landSeq, write: write))
    book.answers[write.id] = answer.body
    book.answerOrder.append(write.id)
    while book.answerOrder.count > 16 { book.answers[book.answerOrder.removeFirst()] = nil }
    book.needsListRead = true
    // A snooze the computer answered with no snooze: its time had passed (the window's `snooze_past`).
    if case .snooze? = write.act, let answered = try? JSONDecoder().decode(DoorSnoozeAnswer.self, from: answer.body), answered.snoozed == nil {
      book.landed.removeAll { $0.write.id == write.id }
      book.notices[ThreadID(write.thread)] = .refused("", code: WireErrorCode.snoozePast.rawValue)
    }
  }

  /// An act the computer refused: the row goes back to what the computer has, and the person is told why. A thread
  /// gone from the computer settles it quietly.
  func noteRefusedAct(_ write: HeldWrite, _ notice: Notice) {
    let thread = ThreadID(write.thread)
    if case .refused(_, let code) = notice, [WireErrorCode.threadNotFound.rawValue, WireErrorCode.messageNotFound.rawValue].contains(code) {
      missingThreads.insert(thread)
      return
    }
    book.notices[thread] = notice
    if book.undo?.id == write.id { book.undo = nil }
    book.needsListRead = true
  }

  /// The thread's row as the computer last said it, with none of the person's acts drawn over it.
  func computerRow(_ thread: ThreadID) -> InboxListRow? {
    list.flatMap { model in (model.sections.flatMap(\.threads) + (model.snoozed ?? []) + (model.pins ?? [])).first { $0.threadId == thread } }
      ?? book.archived?.threads.first { $0.threadId == thread }
  }

  /// What the person sees of a thread now, for an act made on it.
  func shownState(_ thread: ThreadID, _ shown: InboxListRow?) -> ShownState? {
    shown.map { ShownState(shown: $0, computer: computerRow(thread) ?? threads[thread]?.row) }
  }

  /// A waited act meets the computer's row before it goes (StateConflict). True when it was settled here.
  func settleWaitedAct(_ write: HeldWrite) async -> Bool {
    guard write.waited == true, let act = write.act else { return false }
    if !book.checked {
      book.checked = true
      await readList()
    }
    let thread = ThreadID(write.thread)
    // The acts the computer took since that read are not in it yet: drawn over it, so an act is judged against the
    // row the acts before it left (an Unarchive after an Archive that just went).
    let since = book.landed.map(\.write).filter { $0.thread == write.thread }
    let row = computerRow(thread).map { row in since.reduce(row) { $1.act?.drawn($0, at: SnoozeRules.iso($1.madeAt)) ?? $0 } }
    switch StateConflict.decide(act, shown: write.shown, row: row) {
    case .send: return false
    case .already:
      settle(write.id)
      return true
    case .giveWay:
      settle(write.id)
      book.notices[thread] = .gaveWay
      if book.undo?.id == write.id { book.undo = nil }
      return true
    }
  }

  /// Keep a timer for the soonest snooze: when it ends, the list draws again and is read again.
  func armWake(now: Date? = nil) {
    book.wake?.cancel()
    book.wake = nil
    let now = now ?? clock.now()
    guard let model = list else { return }
    let untils = (model.sections.flatMap(\.threads) + (model.snoozed ?? []) + (model.pins ?? [])).compactMap { $0.snoozed?.until }
    // Held to a day: a snooze months away wakes the timer early, and it sets itself again.
    guard let delay = SnoozeRules.delay(untils, now: now).map({ min($0, 86_400) }) else { return }
    let clock = self.clock
    book.wake = Task { [weak self] in
      try? await clock.sleep(delay + 0.05)
      guard !Task.isCancelled, let self else { return }
      self.book.tick += 1
      if self.client != nil { await self.readList() } else { self.armWake() }
    }
  }
}
