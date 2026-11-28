import InboxCore
import InboxWire
import SwiftUI

/// What a thread offers, as menu items: a row's menu (press and hold) and the thread's More menu. The items and
/// their order are the window's (`rowMenuActions`, and the thread's ⋯ sheet); which ones a row gets is RowOffers'.
struct ThreadMenuItems: View {
  enum Place { case row, thread }

  let row: InboxListRow
  /// The group the row is drawn in.
  let drawn: InboxListGroupId?
  /// Starred now (the caller reads the list once for all its rows).
  let starred: Bool
  let actions: RowActions
  var place: Place = .row

  private var where_: ActionWords.Place { place == .thread ? .open : .list }

  /// What this row offers, by the window's rules.
  static func offered(_ row: InboxListRow, drawn: InboxListGroupId?, starred: Bool, session: InboxSession) -> [RowOffers.Action] {
    RowOffers.menu(
      row, drawn: drawn, pinned: session.canAct(.star) ? starred : nil, canMarkRead: session.canAct(.read), canSnooze: session.canAct(.unsnooze), canPrioritize: session.canAct(.priority(true)))
  }

  static func label(_ item: RowOffers.Action, place: Place) -> (String, String) {
    switch item {
    case .pin: return (PhoneWords.starThread, "star")
    case .unpin: return (PhoneWords.unstarThread, "star.slash")
    case .priorityAdd: return (PhoneWords.addToPriority, "arrow.up.to.line")
    case .priorityRemove: return (PhoneWords.removeFromPriority, "arrow.down.to.line")
    case .copyLink: return (PhoneWords.copyLink, "link")
    case .copyId: return (PhoneWords.copyThreadID, "number")
    case .unsnooze: return (PhoneWords.unsnooze, "tray")
    case .read: return (PhoneWords.markRead, place == .thread ? "envelope.open" : "checkmark.circle")
    case .markUnread: return (PhoneWords.markUnread, "envelope")
    case .unread: return (place == .thread ? PhoneWords.moveBackToTop : PhoneWords.moveBack, "tray")
    case .archive: return (place == .thread ? PhoneWords.archiveThread : PhoneWords.archive, "archivebox")
    case .unarchive: return (place == .thread ? PhoneWords.unarchiveThread : PhoneWords.unarchive, "archivebox")
    case .snooze: return (PhoneWords.snooze, "clock")
    case .copyThread, .hidePulls: return ("", "")
    }
  }

  @ViewBuilder private func item(_ action: RowOffers.Action, _ offered: [RowOffers.Action]) -> some View {
    if offered.contains(action) {
      let (words, symbol) = Self.label(action, place: place)
      Button(words, systemImage: symbol) { actions.perform(action, on: row, place: where_) }
    }
  }

  @ViewBuilder private func snooze(_ offered: [RowOffers.Action]) -> some View {
    if offered.contains(.snooze) {
      Menu {
        SnoozeTimes { actions.snooze(row, until: $0) } pickATime: { actions.picking = .row(row, place: where_) }
      } label: {
        Label(PhoneWords.snooze, systemImage: "clock")
      }
    }
    item(.unsnooze, offered)
  }

  @ViewBuilder private func reads(_ offered: [RowOffers.Action]) -> some View {
    item(.read, offered)
    if place == .thread {
      item(.unread, offered)
      item(.markUnread, offered)
    } else {
      item(.markUnread, offered)
      item(.unread, offered)
    }
  }

  var body: some View {
    // Worked out once for the whole menu.
    let offered = Self.offered(row, drawn: drawn, starred: starred, session: actions.session)
    if place == .row {
      // Select first, alone: picking starts with this row picked.
      if drawn != .archived {
        Button(PhoneWords.select, systemImage: "checkmark.circle") { actions.startSelecting(row.threadId) }
        Divider()
      }
      Section {
        item(.pin, offered)
        item(.unpin, offered)
        item(.priorityAdd, offered)
        item(.priorityRemove, offered)
      }
      Section {
        item(.copyLink, offered)
        item(.copyId, offered)
      }
      Section {
        snooze(offered)
        reads(offered)
        item(.archive, offered)
        item(.unarchive, offered)
      }
    } else {
      Section {
        reads(offered)
        snooze(offered)
      }
      Section {
        item(.pin, offered)
        item(.unpin, offered)
        item(.priorityAdd, offered)
        item(.priorityRemove, offered)
      }
      Section {
        item(.copyLink, offered)
        item(.copyId, offered)
      }
      Section {
        item(.archive, offered)
        item(.unarchive, offered)
      }
    }
  }
}

/// What a row offers a screen reader as its actions, beyond its swipes: the star, Priority, the copies, Unsnooze,
/// Move back, and Snooze with each of its times, in the menu's words. The menu itself needs a press and hold.
struct RowSpokenActions: View {
  let row: InboxListRow
  let drawn: InboxListGroupId?
  let starred: Bool
  let actions: RowActions

  var body: some View {
    let offered = ThreadMenuItems.offered(row, drawn: drawn, starred: starred, session: actions.session)
    ForEach([RowOffers.Action.pin, .unpin, .priorityAdd, .priorityRemove, .copyLink, .copyId, .unsnooze, .unread].filter(offered.contains), id: \.self) { item in
      Button(ThreadMenuItems.label(item, place: .row).0) { actions.perform(item, on: row) }
    }
    if offered.contains(.snooze) {
      ForEach(SnoozeRules().choices(now: AppClock.now()), id: \.id) { choice in
        Button("\(PhoneWords.snooze), \(choice.label)") {
          // The time is worked out when the action is taken, not when the row was drawn: a row drawn at 5:59 PM
          // and snoozed "Later today" at 6:01 PM never goes to a time already past. Gone by then: Pick a time.
          if let now = SnoozeRules().choices(now: AppClock.now()).first(where: { $0.id == choice.id }) {
            actions.snooze(row, until: now.until)
          } else {
            actions.picking = .row(row, place: .list)
          }
        }
      }
      Button("\(PhoneWords.snooze), \(PhoneWords.pickATimeTitle)") { actions.picking = .row(row, place: .list) }
    }
    if drawn != .archived { Button(PhoneWords.select) { actions.startSelecting(row.threadId) } }
  }
}

/// The warning before a Mark read that closes questions unanswered, the Pick a time sheet and the reasons an act
/// was not taken: every screen that offers row actions carries these once.
private struct RowActionSheets: ViewModifier {
  @Bindable var actions: RowActions

  func body(content: Content) -> some View {
    content
      .alert(
        actions.warning?.title ?? "", isPresented: Binding(get: { actions.warning != nil }, set: { if !$0 { actions.warning = nil } }), presenting: actions.warning
      ) { warning in
        Button(PhoneWords.cancel, role: .cancel) {}
        Button(warning.go) { Task { await warning.run() } }
      } message: { warning in
        Text(warning.body)
      }
      .sheet(item: $actions.picking) { target in
        SnoozePickSheet { until in
          switch target {
          case .row(let row, _): actions.snooze(row, until: until)
          case .picked: actions.bulk(.snooze, until: until)
          }
        }
      }
  }
}

extension View {
  func rowActionSheets(_ actions: RowActions) -> some View { modifier(RowActionSheets(actions: actions)) }
}
