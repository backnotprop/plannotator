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
  let actions: RowActions
  var place: Place = .row

  private var session: InboxSession { actions.session }
  private var where_: ActionWords.Place { place == .thread ? .open : .list }

  private var offered: [RowOffers.Action] {
    let starred = session.listView()?.pins.contains { $0.threadId == row.threadId } ?? (row.pinnedAt != nil)
    return RowOffers.menu(
      row, drawn: drawn, pinned: session.canAct(.star) ? starred : nil, canMarkRead: session.canAct(.read), canSnooze: session.canAct(.unsnooze), canPrioritize: session.canAct(.priority(true)))
  }

  private func has(_ item: RowOffers.Action) -> Bool { offered.contains(item) }

  private func label(_ item: RowOffers.Action) -> (String, String) {
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

  @ViewBuilder private func item(_ action: RowOffers.Action) -> some View {
    if has(action) {
      let (words, symbol) = label(action)
      Button(words, systemImage: symbol) { actions.perform(action, on: row, place: where_) }
    }
  }

  @ViewBuilder private var snooze: some View {
    if has(.snooze) {
      Menu {
        SnoozeTimes { actions.snooze(row, until: $0) } pickATime: { actions.picking = .row(row, place: where_) }
      } label: {
        Label(PhoneWords.snooze, systemImage: "clock")
      }
    }
    item(.unsnooze)
  }

  @ViewBuilder private var reads: some View {
    item(.read)
    if place == .thread {
      item(.unread)
      item(.markUnread)
    } else {
      item(.markUnread)
      item(.unread)
    }
  }

  var body: some View {
    if place == .row {
      // Select first, alone: picking starts with this row picked.
      if drawn != .archived {
        Button(PhoneWords.select, systemImage: "checkmark.circle") { actions.startSelecting(row.threadId) }
        Divider()
      }
      Section {
        item(.pin)
        item(.unpin)
        item(.priorityAdd)
        item(.priorityRemove)
      }
      Section {
        item(.copyLink)
        item(.copyId)
      }
      Section {
        snooze
        reads
        item(.archive)
        item(.unarchive)
      }
    } else {
      Section {
        reads
        snooze
      }
      Section {
        item(.pin)
        item(.unpin)
        item(.priorityAdd)
        item(.priorityRemove)
      }
      Section {
        item(.copyLink)
        item(.copyId)
      }
      Section {
        item(.archive)
        item(.unarchive)
      }
    }
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
