import InboxCore
import InboxWire
import SwiftUI

/// The archived threads, newest archived first (the window's Archived group): twenty, then twenty more, up to a
/// hundred. A swipe to the left or the row's menu unarchives one; a touch opens it.
struct ArchivedScreen: View {
  let session: InboxSession
  let actions: RowActions
  @Environment(\.accessibilityReduceMotion) private var still

  var body: some View {
    let rows = session.archivedPage()
    List {
      ForEach(rows, id: \.threadId) { row in
        ZStack {
          NavigationLink(value: ListRoute.thread(row.threadId)) { EmptyView() }.opacity(0)
          ThreadRow(row: row, held: session.held.contains { $0.thread == row.threadId.rawValue && session.willSend($0) }, starred: row.pinnedAt != nil)
        }
        .listRowBackground(Token.background)
        .listRowInsets(EdgeInsets(top: Space.near, leading: InboxScreen.edge, bottom: Space.near, trailing: InboxScreen.edge))
        .listRowSeparator(.hidden)
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
          if session.canAct(.unarchive) {
            Button {
              actions.perform(.unarchive, on: row)
            } label: {
              Label(PhoneWords.unarchive, systemImage: "tray.and.arrow.up")
            }
            .tint(RowAction.act.tint)
          }
        }
        .contextMenu { ThreadMenuItems(row: row, drawn: .archived, starred: row.pinnedAt != nil, actions: actions) }
        .accessibilityActions { RowSpokenActions(row: row, drawn: .archived, starred: row.pinnedAt != nil, actions: actions) }
      }
      if session.archivedHasMore {
        Button {
          Task { await session.readArchived(more: true) }
        } label: {
          Text(PhoneWords.showMore).actionGround(.bare, wide: false, height: Space.touch)
        }
        .buttonStyle(PressStyle())
        .frame(maxWidth: .infinity)
        .listRowBackground(Token.background)
        .listRowSeparator(.hidden)
      }
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .background(Token.background.ignoresSafeArea())
    .animation(Motion.fade.animation(still: still), value: rows.map(\.threadId))
    .overlay {
      if rows.isEmpty { ContentUnavailableView(PhoneWords.nothingArchived, systemImage: "archivebox") }
    }
    .navigationTitle(PhoneWords.archived)
    .navigationBarTitleDisplayMode(.inline)
    .refreshable { await session.readArchived() }
    .toastHost(actions)
    .task { await session.readArchived() }
  }
}
