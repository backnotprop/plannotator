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

  let session: InboxSession
  private(set) var toast: Toast?
  var warning: Warning?
  var picking: SnoozeTarget?
  /// Picking rows: the list is the picks' list, a tap picks.
  var selecting = false
  var picked: Set<ThreadID> = []
  /// The open thread asks to be closed (its Mark unread).
  private(set) var closes = 0
  private var timer: Task<Void, Never>?

  /// How long a toast stays: an Undo's seven seconds (`MARK_READ_UNDO_MS`), a copy's 4.2 (packages/inbox/App.tsx).
  static let stays: TimeInterval = UndoOffer.seconds
  static let copyStays: TimeInterval = 4.2

  init(session: InboxSession) { self.session = session }

  // MARK: The toast

  private func show(_ words: ToastWords, undo: Undo? = nil, for seconds: TimeInterval = RowActions.stays) {
    timer?.cancel()
    let next = Toast(words: words, undo: undo)
    toast = next
    AccessibilityNotification.Announcement(words.spoken).post()
    timer = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(Int(seconds * 1000)))
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
      if await session.undo(offer) { say(said) }
    case .many(let group):
      if await session.undoMany(group) { say(ActionWords.movedBack) } else { show(ActionWords.failed(ActionWords.someDidNotMoveBack)) }
    }
    told()
  }

  /// A reason an act was not taken, said once: at once for an act the computer refused, later for one that waited
  /// on the phone and gave way.
  func told() {
    guard let notice = session.actionNotices.values.first else { return }
    for id in session.actionNotices.keys { session.clearActionNotice(id) }
    UINotificationFeedbackGenerator().notificationOccurred(.warning)
    show(ActionWords.failed(PhoneWords.actNotice(notice, computer: session.computer.name)))
  }

  // MARK: One row

  /// One act and its toast. `said`: what a screen reader hears after its Undo.
  private func run(_ act: ThreadAct, on row: InboxListRow, toast words: ToastWords?, undone said: String = ActionWords.movedBack, quiet: String? = nil) async {
    switch await session.act(act, on: row.threadId) {
    case .done, .waits:
      if let words {
        let offer = session.undoOffer.flatMap { $0.thread == row.threadId ? $0 : nil }
        show(words, undo: offer.map { .one($0, said: said) })
      } else if let quiet {
        say(quiet)
      }
    case .refused:
      told()
    case .notOffered:
      show(ActionWords.failed(PhoneWords.actNotice(.notOffered, computer: session.computer.name)))
    }
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
        // read it again).
        await run(.markUnread, on: row, toast: ActionWords.markedUnread(row, moved: place == .open || row.section == .quiet))
        if place == .open { closes += 1 }
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
    selecting = true
    picked = []
    UISelectionFeedbackGenerator().selectionChanged()
    // The list empties its selection as it starts picking: the row is picked once it has.
    guard let thread else { return }
    Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(120))
      if selecting { picked.insert(thread) }
    }
  }

  func stopSelecting() {
    selecting = false
    picked = []
  }

  /// The picked rows as the list draws them now (a pick that left the list drops out).
  func pickedRows() -> [InboxListRow] {
    guard let view = session.listView() else { return [] }
    return view.groups.flatMap(\.threads).filter { picked.contains($0.threadId) }
  }

  /// The picked rows an action takes.
  func targets(_ action: BulkAction) -> [InboxListRow] {
    guard let view = session.listView() else { return [] }
    return BulkAction.targets(pickedRows(), action, drawn: { view.group(of: $0.threadId) }, starred: Set(view.pins.map(\.threadId)))
  }

  /// One action on every picked row it takes: one toast, one Undo.
  func bulk(_ action: BulkAction, until: Date? = nil) {
    let rows = targets(action)
    guard !rows.isEmpty else { return }
    let iso = until.map { SnoozeRules.iso($0) }
    let go: @MainActor () async -> Void = { [weak self] in
      guard let self else { return }
      self.stopSelecting()
      let outcome = await self.session.actMany(action, until: iso, on: rows.map(\.threadId))
      let refusal = outcome.refusal.map { PhoneWords.actNotice($0, computer: self.session.computer.name) }
      guard
        let words = ActionWords.bulk(
          action, made: outcome.made.count, held: outcome.held, heldOn: Array(repeating: self.session.computer.name, count: outcome.held), refused: outcome.refused.count, refusal: refusal,
          detail: iso.map { SnoozeRules().when($0) })
      else {
        // Every row refused: the window's error toast, as a single action's.
        return self.show(ActionWords.failed(refusal ?? ActionWords.threadsDidNotChange))
      }
      self.show(words, undo: outcome.undo.map { .many($0) })
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
