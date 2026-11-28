import Foundation
import InboxWire

/// One change the person makes to a thread's state (not to its messages), as the window makes it: the same door
/// route and body, the same Undo. None of these routes compares and sets; each writes a state, and writing the state
/// a thread already has changes nothing (the window's notes, packages/inbox/rowActions.ts, snoozeWrites.ts,
/// priorityWrites.ts, App.tsx).
public enum ThreadAct: Codable, Hashable, Sendable {
  /// `POST messages/:id/resolve {resolved: true}`, on the thread's root message (its id is the thread's).
  case archive
  case unarchive
  /// Mark read (the right swipe's "Quiet"): `POST threads/:id/read`. Closes the questions that wait as set aside.
  case read
  /// Move back, Mark read's reverse: `POST threads/:id/unread`. Reopens what that Mark read closed.
  case moveBack
  /// Mark unread: `POST threads/:id/mark-unread`. Only takes back the look.
  case markUnread
  /// Mark unread's Undo: `POST threads/:id/seen` through the seq Mark unread answered.
  case seen(throughSeq: Int64?)
  /// Star (the window's pin): `POST threads/:id/pin`. A new star goes last.
  case star
  case unstar
  /// Unstar's Undo: `POST pins {restore}`, at its old place with its old time.
  case restoreStar(index: Int, pinnedAt: String)
  /// The stars' new order: `POST pins {order}`.
  case orderStars([String])
  /// `POST threads/:id/snooze {until}`. `at`: an Undo puts back an earlier snooze with its own time.
  case snooze(until: String, at: String?)
  case unsnooze
  /// `POST threads/:id/priority {priority}`.
  case priority(Bool)
  /// Priority's Undo: `POST threads/:id/priority {restore}`, what the write found.
  case restorePriority(at: String?, offAt: String?)

  /// The door route this act calls.
  public var route: DoorRoute {
    switch self {
    case .archive, .unarchive: return DoorRoutes.postMessageResolve
    case .read: return DoorRoutes.postThreadRead
    case .moveBack: return DoorRoutes.postThreadUnread
    case .markUnread: return DoorRoutes.postThreadMarkUnread
    case .seen: return DoorRoutes.postThreadSeen
    case .star, .unstar: return DoorRoutes.postThreadPin
    case .restoreStar, .orderStars: return DoorRoutes.postPins
    case .snooze, .unsnooze: return DoorRoutes.postThreadSnooze
    case .priority, .restorePriority: return DoorRoutes.postThreadPriority
    }
  }

  /// The request and its body, under one idempotency key.
  func request(thread: ThreadID, key: String) -> (DoorRequest, Data) {
    let encoder = JSONEncoder()
    func data<T: Encodable>(_ body: T) -> Data { (try? encoder.encode(body)) ?? Data("{}".utf8) }
    switch self {
    case .archive: return (Door.postMessageResolve(message: MessageID(thread.rawValue)), data(DoorResolveBody(idempotencyKey: key, resolved: true)))
    case .unarchive: return (Door.postMessageResolve(message: MessageID(thread.rawValue)), data(DoorResolveBody(idempotencyKey: key, resolved: false)))
    case .read: return (Door.postThreadRead(thread: thread), data(DoorKeyBody(idempotencyKey: key)))
    case .moveBack: return (Door.postThreadUnread(thread: thread), data(DoorKeyBody(idempotencyKey: key)))
    case .markUnread: return (Door.postThreadMarkUnread(thread: thread), data(DoorKeyBody(idempotencyKey: key)))
    case .seen(let through): return (Door.postThreadSeen(thread: thread), data(DoorSeenBody(idempotencyKey: key, throughSeq: through)))
    case .star: return (Door.postThreadPin(thread: thread), data(DoorPinBody(idempotencyKey: key, pinned: true)))
    case .unstar: return (Door.postThreadPin(thread: thread), data(DoorPinBody(idempotencyKey: key, pinned: false)))
    case .restoreStar(let index, let pinnedAt):
      return (Door.postPins(), data(DoorPinsBody(idempotencyKey: key, restore: DoorPinsBodyRestore(threadId: thread, index: Double(index), pinnedAt: pinnedAt))))
    case .orderStars(let order): return (Door.postPins(), data(DoorPinsBody(idempotencyKey: key, order: order)))
    case .snooze(let until, let at): return (Door.postThreadSnooze(thread: thread), data(DoorSnoozeBody(idempotencyKey: key, until: until, at: at)))
    case .unsnooze: return (Door.postThreadSnooze(thread: thread), data(DoorSnoozeBody(idempotencyKey: key, until: nil)))
    case .priority(let on): return (Door.postThreadPriority(thread: thread), data(DoorPriorityBody(idempotencyKey: key, priority: on)))
    case .restorePriority(let at, let offAt):
      return (Door.postThreadPriority(thread: thread), data(DoorPriorityBody(idempotencyKey: key, restore: DoorPriorityBefore(at: at, offAt: offAt))))
    }
  }

  // MARK: Drawn at once

  /// The row as this act leaves it, drawn while the write waits or is on its way. Mark read, Archive and Star are
  /// what the window draws at once (`readRowPatch`, `archivedRowPatch`, the star); the phone also draws the others,
  /// since a write can wait here for hours while the computer is away. What only the computer can know (where Move
  /// back puts a thread) is left as it is until the computer's row comes.
  public func drawn(_ row: InboxListRow, at stamp: String) -> InboxListRow {
    var row = row
    switch self {
    case .archive:
      row.resolvedAt = row.resolvedAt ?? stamp
      row.backFromArchive = nil
      row.section = .quiet
      row.unread = false
      // A person's archive ends the snooze and the Priority add (packages/shared/inbox/store.ts resolveThread).
      row.snoozed = nil
      row.priority = nil
    case .unarchive:
      row.resolvedAt = nil
      row.backFromArchive = nil
    case .read:
      row.readAt = stamp
      row.unread = false
      row.unseen = 0
      // Mark read moves the thread to Quiet unless the person's own draft keeps it in New, and ends a snooze.
      if !ListRules.archived(row) { row.section = ListRules.hasUnsent(row) ? .new : .quiet }
      row.snoozed = nil
    case .moveBack:
      row.readAt = nil
    case .markUnread:
      row.unread = true
      row.unseen = max(row.unseen, 1)
      if !ListRules.archived(row), row.section == .quiet { row.section = .new }
    case .seen:
      row.unread = false
      row.unseen = 0
    case .star, .restoreStar:
      row.pinnedAt = row.pinnedAt ?? stamp
    case .unstar:
      row.pinnedAt = nil
    case .orderStars:
      break
    case .snooze(let until, let at):
      row.snoozed = InboxRowSnooze(until: until, at: at ?? stamp)
    case .unsnooze:
      row.snoozed = nil
    case .priority(let on):
      row.priority = on ? InboxRowPriority(person: true, at: stamp, ask: nil) : nil
    case .restorePriority(let at, _):
      row.priority = at.map { InboxRowPriority(person: true, at: $0, ask: nil) }
    }
    return row
  }

  /// The stars' order as this act leaves it.
  public func drawnStars(_ order: [ThreadID], thread: ThreadID) -> [ThreadID] {
    switch self {
    case .star: return order.contains(thread) ? order : order + [thread]
    case .unstar: return order.filter { $0 != thread }
    case .restoreStar(let index, _):
      guard !order.contains(thread) else { return order }
      var next = order
      next.insert(thread, at: min(max(index, 0), next.count))
      return next
    case .orderStars(let named):
      // The server's rule (store.ts orderPins): the named stars first, in that order, then the rest in place.
      let ids: [ThreadID] = named.map { ThreadID($0) }.filter { order.contains($0) }
      return ids + order.filter { !ids.contains($0) }
    default: return order
    }
  }
}

/// What the person saw of a thread when they tapped an act: the state each act turns. A waited act is judged against
/// it, never by a clock. A stamp is kept only when it is the computer's own; a state the phone drew itself (from an
/// act not in a list read yet) keeps none, since only the computer's stamps compare with the computer's.
public struct ShownState: Codable, Hashable, Sendable {
  public var archived: Bool
  public var resolvedAt: String?
  public var readAt: String?
  public var unread: Bool
  public var starred: Bool
  public var pinnedAt: String?
  public var snoozeUntil: String?
  public var priority: Bool
  public var priorityAt: String?
  /// When an agent last wrote, by the computer's stamp.
  public var agentAt: String?

  /// `shown`: the row as the phone drew it at the tap; `computer`: that row as the computer last said it.
  public init(shown: InboxListRow, computer: InboxListRow?) {
    func own(_ path: KeyPath<InboxListRow, String?>) -> String? {
      guard let stamp = shown[keyPath: path], let computer, computer[keyPath: path] == stamp else { return nil }
      return stamp
    }
    archived = ListRules.archived(shown)
    resolvedAt = own(\.resolvedAt)
    readAt = own(\.readAt)
    unread = shown.unread
    starred = shown.pinnedAt != nil
    pinnedAt = own(\.pinnedAt)
    snoozeUntil = shown.snoozed?.until
    priority = shown.priority != nil
    let shownAt: String? = shown.priority?.at
    let computerAt: String? = computer?.priority?.at
    priorityAt = shownAt == computerAt ? shownAt : nil
    agentAt = Self.agentAt(shown)
  }

  static func agentAt(_ row: InboxListRow) -> String? { row.lastAgentAt ?? (row.lastAuthor == .agent ? row.lastAt : nil) }
}

/// A thread action that waited on the phone (made while the computer was away) meets the computer's row before it
/// goes. The phone's rule beside PickConflict's, which compares revisions: the act goes when the computer's row still
/// shows what the person saw at the tap; an act the row already shows is not sent at all; anything else was changed
/// elsewhere meanwhile, and the computer's state stands. Only the computer's own stamps are compared, with each
/// other: never with the phone's clock.
public enum StateConflict {
  public enum Outcome: Hashable, Sendable {
    /// Send it.
    case send
    /// The row already shows it: settle it quietly.
    case already
    /// Changed elsewhere after the tap: the computer's state stands, and the person is told.
    case giveWay
  }

  /// The computer's stamp moved from the one the person saw. Nil on either side says nothing.
  static func moved(_ seen: String?, _ now: String?) -> Bool {
    guard let seen, let now else { return false }
    return seen != now
  }

  /// An agent wrote after the tap and is the last to have written: Archive and Mark read never bury what it said.
  static func agentWrote(_ shown: ShownState, _ row: InboxListRow) -> Bool {
    guard row.lastAuthor == .agent, let now = ShownState.agentAt(row) else { return false }
    return now != shown.agentAt
  }

  /// `shown`: what the person saw at the tap (nil: not known, so only an act the row already shows is held back).
  public static func decide(_ act: ThreadAct, shown: ShownState?, row: InboxListRow?) -> Outcome {
    // A thread the list no longer has: the computer answers for it (a 404 settles it).
    guard let row else { return .send }
    let archived = ListRules.archived(row)
    switch act {
    case .archive:
      if archived { return .already }
      if let shown, agentWrote(shown, row) { return .giveWay }
      return .send
    case .unarchive:
      if !archived { return .already }
      return moved(shown?.resolvedAt, row.resolvedAt) ? .giveWay : .send
    case .read:
      // Read elsewhere meanwhile, and nothing came after.
      if let readAt = row.readAt, !row.unread, row.unseen == 0, shown?.readAt != readAt { return .already }
      // Mark read closes what waits unanswered: never questions an agent asked after the person looked.
      if let shown, agentWrote(shown, row) { return .giveWay }
      return .send
    case .moveBack:
      if row.readAt == nil { return .already }
      return moved(shown?.readAt, row.readAt) ? .giveWay : .send
    case .markUnread:
      return row.unread ? .already : .send
    case .seen, .orderStars:
      return .send
    case .restorePriority(let at, _):
      if row.priority?.at == at { return .already }
      // Added or removed elsewhere meanwhile.
      if let shown, shown.priority != (row.priority != nil) || moved(shown.priorityAt, row.priority?.at) { return .giveWay }
      return .send
    case .star, .restoreStar:
      return row.pinnedAt != nil ? .already : .send
    case .unstar:
      if row.pinnedAt == nil { return .already }
      return moved(shown?.pinnedAt, row.pinnedAt) ? .giveWay : .send
    case .snooze(let until, _):
      if row.snoozed?.until == until { return .already }
      // Snoozed elsewhere to another time meanwhile.
      if let shown, let now = row.snoozed?.until, now != shown.snoozeUntil { return .giveWay }
      return .send
    case .unsnooze:
      guard let snooze = row.snoozed else { return .already }
      if let shown, snooze.until != shown.snoozeUntil { return .giveWay }
      return .send
    case .priority(let on):
      if (row.priority != nil) == on { return .already }
      return moved(shown?.priorityAt, row.priority?.at) ? .giveWay : .send
    }
  }
}

/// What a row offers, by the window's own rules (packages/inbox/markRead.ts, rowMenu.ts, rowSwipe.ts, priority.ts).
/// apps/mobile/contract/vectors/rows.json holds the cases.
public enum RowOffers {
  public enum Action: String, Hashable, Sendable {
    case pin, unpin
    case priorityAdd = "priority-add"
    case priorityRemove = "priority-remove"
    case copyThread = "copy-thread"
    case copyLink = "copy-link"
    case copyId = "copy-id"
    case snooze, unsnooze, read
    case markUnread = "mark-unread"
    case unread
    case hidePulls = "hide-pulls"
    case archive, unarchive
  }

  /// `inboxRowWaitsOnPerson` (`inboxSectionWaitsOnPerson`: Tagged you counts like Waiting on you).
  public static func waitsOnPerson(_ row: InboxListRow) -> Bool {
    switch row.section {
    case .stopped, .holding, .waiting, .tagged: return true
    case .new: return row.unseen > 0 || row.answeredNotSent
    default: return false
    }
  }

  /// `seenHeldInNew`: a plain update the person opened, which the list still draws in New.
  public static func seenHeldInNew(_ row: InboxListRow, drawn: InboxListGroupId?) -> Bool {
    drawn == .new && row.section == .quiet && row.resolvedAt == nil && row.readAt == nil
  }

  /// `offersRowMarkRead` (`inboxRowOffersMarkRead` or a seen update held in New).
  public static func offersMarkRead(_ row: InboxListRow, drawn: InboxListGroupId?) -> Bool {
    ((row.resolvedAt == nil || row.backFromArchive == true) && (row.readAt == nil || row.unseen > 0) && waitsOnPerson(row)) || seenHeldInNew(row, drawn: drawn)
  }

  /// `canToggleRead`.
  public static func canToggleRead(_ row: InboxListRow, drawn: InboxListGroupId?) -> Bool {
    if row.resolvedAt != nil, row.agentAfterArchive != true { return false }
    return row.readAt != nil || waitsOnPerson(row) || seenHeldInNew(row, drawn: drawn)
  }

  /// `canMarkUnread`: read (not bold, its latest agent message seen), not archived, and an agent wrote after the
  /// person's reply. A row whose questions still wait takes it too once opened; its Mark read stays in the menu.
  public static func canMarkUnread(_ row: InboxListRow) -> Bool {
    if row.resolvedAt != nil || row.unread || row.unseen > 0 { return false }
    return row.sent == nil
  }

  /// `priorityAction`. `keeps`: the Inbox keeps priority (it lists the route).
  public static func priority(_ row: InboxListRow, keeps: Bool = true) -> Action? {
    guard keeps else { return nil }
    if row.priority != nil { return .priorityRemove }
    return ListRules.archived(row) ? nil : .priorityAdd
  }

  /// `rowMenuActions`, in the window's order. `pinned` nil: an Inbox that keeps no stars.
  public static func menu(_ row: InboxListRow, drawn: InboxListGroupId?, pinned: Bool?, canMarkRead: Bool = true, canSnooze: Bool = true, canPrioritize: Bool = true) -> [Action] {
    var out: [Action] = []
    if let pinned { out.append(pinned ? .unpin : .pin) }
    if canPrioritize, let priority = priority(row) { out.append(priority) }
    out += [.copyThread, .copyLink, .copyId]
    if canSnooze, !ListRules.archived(row) { out += row.snoozed != nil ? [.snooze, .unsnooze] : [.snooze] }
    if canMarkRead, drawn != .archived {
      if offersMarkRead(row, drawn: drawn) { out.append(.read) }
      if canMarkUnread(row) { out.append(.markUnread) }
      // The window asks this one without the drawn group (rowMenu.ts).
      if row.readAt != nil, canToggleRead(row, drawn: nil) { out.append(.unread) }
    }
    if row.resolvedAt == nil, !(row.hidePulls ?? []).isEmpty { out.append(.hidePulls) }
    if row.resolvedAt == nil { out.append(.archive) } else if drawn == .archived { out.append(.unarchive) }
    return out
  }

  /// `rowSwipeActions`: the right swipe (Mark unread on a read row, else Mark read where offered) and the left (Archive).
  public static func swipe(_ row: InboxListRow, drawn: InboxListGroupId?, canMarkRead: Bool = true, canMarkUnread allowUnread: Bool = true) -> (lead: Action?, trail: Action?) {
    let unread = allowUnread && canMarkUnread(row)
    let read = !unread && canMarkRead && offersMarkRead(row, drawn: drawn)
    return (unread ? .markUnread : read ? .read : nil, row.resolvedAt == nil ? .archive : nil)
  }

  /// `setAsideCount` for one row: what a Mark read would close unanswered.
  public static func setAside(_ row: InboxListRow) -> (questions: Int, actions: Int) {
    let actions = Int(row.questions.actions ?? 0)
    let questions = max(0, Int(row.questions.openValue) - actions) + Int(row.questions.picked)
    return (questions, actions)
  }

  /// `priorityBackIn`'s group: where a row goes back to when it leaves Priority.
  public static func backIn(_ row: InboxListRow) -> InboxListGroupId {
    if ListRules.archived(row) { return .archived }
    if row.snoozed != nil { return .snoozed }
    return InboxListGroupId(rawValue: row.section.rawValue)
  }
}

extension ListRules {
  /// `inboxHasUnsent`: the thread holds something the person has not sent.
  static func hasUnsent(_ row: InboxListRow) -> Bool {
    guard let unsent = row.unsent else { return false }
    return unsent.replyAt != nil || unsent.picks > 0 || unsent.comments > 0 || (unsent.done ?? 0) > 0 || (unsent.cant ?? 0) > 0
  }
}
