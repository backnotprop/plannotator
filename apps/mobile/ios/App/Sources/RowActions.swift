import InboxCore
import InboxWire
import Observation
import SwiftUI
import UIKit

/// What the person does to a thread from a row, the picks' bar or the thread's More menu, and the one toast that
/// answers it. The writes themselves are the session's (drawn at once, held while the computer is away, undone as
/// the window undoes them); this decides which toast, when the warning asks first, and what Undo says.
@MainActor
@Observable
final class RowActions {
  /// The one toast on screen: a new one takes the last one's place, as in the window.
  struct Toast: Identifiable, Equatable {
    let id = UUID()
    var words: ToastWords
    var undo: Undo?
  }

  enum Undo: Equatable {
    /// One act's Undo, and what a screen reader is told once it is taken back.
    case one(UndoOffer, said: String)
    case many(BulkUndo)
    /// An act inside a file cover (a comment removed, a drawing added): its Undo is the cover's own.
    case local(said: String)
  }

  /// The warning before a Mark read that closes questions unanswered.
  struct Warning: Identifiable {
    let id = UUID()
    let title: String
    let body: String
    let go: String
    let run: @MainActor () async -> Void
  }

  /// What Pick a time snoozes.
  enum SnoozeTarget: Identifiable, Equatable {
    case row(InboxListRow, place: ActionWords.Place)
    case picked
    var id: String {
      if case .row(let row, _) = self { return row.threadId.rawValue }
      return "picked"
    }
  }

  /// What an act on several rows told, so the refusals of its rows that come later fold into its toast.
  private struct BulkShown {
    let toast: UUID
    let action: BulkAction
    var made: [ThreadID]
    let held: Int
    let detail: String?
    var refused: Int
    var refusal: String?
  }

  let session: InboxSession
  private(set) var toast: Toast?
  private var bulkShown: BulkShown?
  var warning: Warning?
  var picking: SnoozeTarget?
  /// Picking rows: the list is the picks' list, a tap picks.
  private(set) var selecting = false
  /// The list's edit mode: on in the same change that starts picking (the list empties its selection as it
  /// starts, and `firstPick` is picked again); off in the change after picking ends (InboxScreen), since a list
  /// leaving edit mode in the same change that empties its selection stays in edit mode, every circle drawn.
  var editMode: EditMode = .inactive
  var picked: Set<ThreadID> = []
  /// The row picking started from: the list empties its selection as it starts, and this row is picked again.
  var firstPick: ThreadID?
  /// The open thread asks to be closed (its Mark unread).
  private(set) var closes = 0
  private var timer: Task<Void, Never>?

  /// How long a toast stays: an Undo's seven seconds (`MARK_READ_UNDO_MS`), a copy's 4.2 (packages/inbox/App.tsx).
  /// While VoiceOver reads the screen a toast and its Undo stay half a minute: seven seconds is gone before it is
  /// heard and reached.
  static let stays: TimeInterval = UndoOffer.seconds
  static let copyStays: TimeInterval = 4.2
  static let readStays: TimeInterval = 30
  private var heard: Bool { UIAccessibility.isVoiceOverRunning }

  init(session: InboxSession) { self.session = session }

  // MARK: The toast

  /// `until`: when its Undo ends; the toast goes with it, never before and never after.
  private func show(_ words: ToastWords, undo: Undo? = nil, for seconds: TimeInterval = RowActions.stays, until: Date? = nil) {
    timer?.cancel()
    let next = Toast(words: words, undo: undo)
    toast = next
    AccessibilityNotification.Announcement(words.spoken).post()
    let wait = until.map { max($0.timeIntervalSinceNow, 0) } ?? (heard ? max(seconds, Self.readStays) : seconds)
    timer = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(Int(wait * 1000)))
      guard !Task.isCancelled, let self, self.toast?.id == next.id else { return }
      self.toast = nil
    }
  }

  /// The × on the toast, or a swipe across it: the toast goes and its Undo with it.
  func dismissToast() {
    timer?.cancel()
    toast = nil
  }

  private func say(_ words: String) { AccessibilityNotification.Announcement(words).post() }

  func undo() async {
    guard let undo = toast?.undo else { return }
    dismissToast()
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    switch undo {
    case .one(let offer, let said):
      // An Undo that could not be taken (its time ran out, or the computer refused) is said, never silent.
      if await session.undo(offer) { say(said) } else if session.actionNotices.isEmpty { show(ActionWords.failed(ActionWords.threadDidNotChange)) }
    case .many(let group):
      if await session.undoMany(group) { say(ActionWords.movedBack) } else if session.actionNotices.isEmpty { show(ActionWords.failed(ActionWords.someDidNotMoveBack)) }
    case .local:
      break
    }
    told()
  }

  /// The reasons acts were not taken, said once: at once for an act the computer refused, later for acts that
  /// waited on the phone and gave way. Several at once (a bulk action sent when the computer was back) are counted.
  func told() {
    var notices = session.actionNotices
    guard !notices.isEmpty else { return }
    for id in notices.keys { session.clearActionNotice(id) }
    // The rows of the act on several rows whose toast is up: said in that toast, and its Undo stays.
    if let toast, case .many? = toast.undo, var shown = bulkShown, shown.toast == toast.id {
      let theirs = notices.filter { shown.made.contains($0.key) }
      if let first = theirs.values.first {
        for id in theirs.keys { notices[id] = nil }
        shown.refusal = shown.refusal ?? PhoneWords.actNotice(first, computer: session.computer.name)
        shown.refused += theirs.count
        shown.made.removeAll { theirs[$0] != nil }
        bulkShown = shown
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
        let heldOn = Array(repeating: session.computer.name, count: shown.held)
        if let words = ActionWords.bulk(shown.action, made: shown.made.count, held: shown.held, heldOn: heldOn, refused: shown.refused, refusal: shown.refusal, detail: shown.detail) {
          // The same toast, on the same clock: its words change, and its Undo now takes back only what was taken.
          let undo = session.bulkUndoOffer
          self.toast?.words = words
          self.toast?.undo = undo.map { .many($0) }
          AccessibilityNotification.Announcement(words.spoken).post()
        } else {
          show(ActionWords.failed(shown.refusal ?? ActionWords.threadsDidNotChange))
        }
      }
    }
    guard let first = notices.values.first else { return }
    UINotificationFeedbackGenerator().notificationOccurred(.warning)
    let why = PhoneWords.actNotice(first, computer: session.computer.name)
    show(notices.count > 1 ? ActionWords.didNotChange(notices.count, why: why) : ActionWords.failed(why))
  }

  // MARK: One row

  /// One act and its toast. The act is held and its toast shown before anything is sent, so the toast and the
  /// Undo it offers run on one clock; then it is sent. `said`: what a screen reader hears after its Undo.
  @discardableResult
  private func run(_ act: ThreadAct, on row: InboxListRow, toast words: ToastWords?, undone said: String = ActionWords.movedBack, quiet: String? = nil) async -> ActOutcome {
    session.undoSeconds = heard ? Self.readStays : UndoOffer.seconds
    guard let key = session.holdAct(act, on: row.threadId) else {
      show(ActionWords.failed(PhoneWords.actNotice(.notOffered, computer: session.computer.name)))
      return .notOffered
    }
    if let words {
      let offer = session.undoOffer.flatMap { $0.id == key ? $0 : nil }
      show(words, undo: offer.map { .one($0, said: said) }, until: offer?.expires)
    } else if let quiet {
      say(quiet)
    }
    let outcome = await session.deliverAct(key, on: row.threadId)
    if outcome == .refused { told() }
    return outcome
  }

  /// A row's menu item or swipe.
  func perform(_ item: RowOffers.Action, on row: InboxListRow, place: ActionWords.Place = .list) {
    Task {
      switch item {
      case .pin: await run(.star, on: row, toast: nil, quiet: ActionWords.starredSaid(row))
      case .unpin: await run(.unstar, on: row, toast: ActionWords.unstarred(row), undone: ActionWords.starredSaid(row))
      case .priorityAdd: await run(.priority(true), on: row, toast: ActionWords.priorityAdded(row), undone: ActionWords.removedFromPriorityAgain)
      case .priorityRemove: await run(.priority(false), on: row, toast: ActionWords.priorityRemoved(row), undone: ActionWords.backInPriority)
      case .copyLink: copy(link: true, row)
      case .copyId: copy(link: false, row)
      case .unsnooze: await run(.unsnooze, on: row, toast: ActionWords.unsnoozed(row), undone: ActionWords.snoozeMovedBack)
      case .read: markRead(row, place: place)
      case .markUnread:
        // The row is bold again; from Quiet it is back in New, and the open thread closes (its next look would
        // read it again), unless the computer refused: then nothing changed, and the thread stays open.
        let outcome = await run(.markUnread, on: row, toast: ActionWords.markedUnread(row, moved: place == .open || row.section == .quiet))
        if place == .open, outcome != .refused, outcome != .notOffered { closes += 1 }
      case .unread: await run(.moveBack, on: row, toast: nil, quiet: ActionWords.movedBack)
      case .archive: await run(.archive, on: row, toast: ActionWords.archived(row, named: place != .open), undone: ActionWords.unarchivedSaid)
      case .unarchive: await run(.unarchive, on: row, toast: ActionWords.unarchived(row))
      // Copy thread, Snooze (its own menu) and Hide pull request are not a single act here.
      case .copyThread, .snooze, .hidePulls: break
      }
    }
  }

  /// Mark read: the warning asks first when it would close questions or action items unanswered.
  func markRead(_ row: InboxListRow, place: ActionWords.Place) {
    let go: @MainActor () async -> Void = { [weak self] in
      await self?.run(.read, on: row, toast: ActionWords.markedRead(row, place: place))
    }
    let aside = ActionWords.SetAside([row])
    guard aside.warns else { return Task { await go() }.discard() }
    let words = ActionWords.setAsideWarning(aside, bulk: false)
    warning = Warning(title: words.title, body: words.body, go: words.go, run: go)
  }

  func snooze(_ row: InboxListRow, until: Date) {
    let iso = SnoozeRules.iso(until)
    let had = row.snoozed != nil
    Task { await run(.snooze(until: iso, at: nil), on: row, toast: ActionWords.snoozed(row, when: SnoozeRules().when(iso)), undone: had ? ActionWords.snoozeMovedBack : ActionWords.unsnoozedSaid) }
  }

  private func copy(link: Bool, _ row: InboxListRow) {
    let text = link ? ActionWords.origin(of: session.computer).map { ActionWords.threadLink(row.threadId, origin: $0) } : row.threadId.rawValue
    if let text { UIPasteboard.general.string = text }
    show(ActionWords.copied(link: link, row, ok: text != nil), for: Self.copyStays)
  }

  // MARK: The stars' order

  func move(_ thread: ThreadID, by step: Int) {
    let order = (session.listView()?.pins ?? []).map(\.threadId)
    let next = ListRules.movePin(order, thread, by: step)
    guard next != order else { return }
    Task {
      if await session.act(.orderStars(next.map(\.rawValue)), on: thread, undo: false) == .refused { told() }
    }
  }

  // MARK: Several rows

  func startSelecting(_ thread: ThreadID? = nil) {
    firstPick = thread
    picked = thread.map { [$0] } ?? []
    selecting = true
    editMode = .active
    UISelectionFeedbackGenerator().selectionChanged()
  }

  func stopSelecting() {
    selecting = false
    firstPick = nil
    picked = []
  }

  /// The picked rows an action takes, from the list as drawn now.
  func targets(_ action: BulkAction, in view: ListView?) -> [InboxListRow] {
    guard let view else { return [] }
    let rows = view.groups.flatMap(\.threads).filter { picked.contains($0.threadId) }
    return BulkAction.targets(rows, action, drawn: { view.group(of: $0.threadId) }, starred: Set(view.pins.map(\.threadId)))
  }

  /// One action on every picked row it takes: every row drawn at once, one toast and one Undo at once, then sent.
  func bulk(_ action: BulkAction, until: Date? = nil) {
    let rows = targets(action, in: session.listView())
    guard !rows.isEmpty else { return }
    let iso = until.map { SnoozeRules.iso($0) }
    let go: @MainActor () async -> Void = { [weak self] in
      guard let self else { return }
      self.stopSelecting()
      self.session.undoSeconds = self.heard ? Self.readStays : UndoOffer.seconds
      let outcome = self.session.holdMany(action, until: iso, on: rows.map(\.threadId))
      let refusal = outcome.refusal.map { PhoneWords.actNotice($0, computer: self.session.computer.name) }
      guard
        var words = ActionWords.bulk(
          action, made: outcome.made.count, held: outcome.held, heldOn: Array(repeating: self.session.computer.name, count: outcome.held), refused: outcome.refused.count, refusal: refusal,
          detail: iso.map { SnoozeRules().when($0) })
      else {
        // Every row refused: the window's error toast, as a single action's.
        return self.show(ActionWords.failed(refusal ?? ActionWords.threadsDidNotChange))
      }
      // How many wait for the computer is the news here: the words wrap, never cut before it.
      if outcome.held > 0 { words.wraps = true }
      self.show(words, undo: outcome.undo.map { .many($0) }, until: outcome.undo?.expires)
      if let shown = self.toast, outcome.undo != nil {
        self.bulkShown = BulkShown(toast: shown.id, action: action, made: outcome.made, held: outcome.held, detail: iso.map { SnoozeRules().when($0) }, refused: outcome.refused.count, refusal: refusal)
      }
      // Sent after the toast is up; what the computer refuses is said when it answers.
      await self.session.sendMany(outcome.made)
      self.told()
    }
    // Questions these would close unanswered: the warning asks once for all of them.
    let aside = ActionWords.SetAside(rows)
    guard action == .read, aside.warns else { return Task { await go() }.discard() }
    let words = ActionWords.setAsideWarning(aside, bulk: true)
    warning = Warning(title: words.title, body: words.body, go: words.go, run: go)
  }
}

private extension Task {
  /// The task runs by itself; its handle is not kept.
  func discard() {}
}
