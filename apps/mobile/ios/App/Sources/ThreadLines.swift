import InboxCore
import InboxWire
import SwiftUI

/// Where a thread stands, in a line over its messages, with the one thing to do about it (the window's lines):
/// "Snoozed until Fri 8:00 AM" with Unsnooze, "Read 3:14 PM. …" with Move back, "Back from snooze · 8:00 AM".
struct ThreadLines: View {
  let row: InboxListRow
  let agent: String
  let actions: RowActions

  private var snoozed: String? {
    guard let snooze = row.snoozed, SnoozeRules.running(snooze.until) else { return nil }
    return PhoneWords.snoozedUntil(SnoozeRules().when(snooze.until))
  }

  private var read: String? {
    guard let readAt = row.readAt, row.resolvedAt == nil else { return nil }
    return PhoneWords.readLine(at: TimeWords().when(readAt), agent: agent)
  }

  var body: some View {
    let session = actions.session
    VStack(spacing: 0) {
      if let snoozed {
        line("clock", snoozed, session.canAct(.unsnooze) ? PhoneWords.unsnooze : nil) { actions.perform(.unsnooze, on: row, place: .open) }
      }
      if let read {
        line("checkmark.circle", read, session.canAct(.moveBack) ? PhoneWords.moveBack : nil) { actions.perform(.unread, on: row, place: .open) }
      }
      if let back = row.snoozeBack {
        line("clock", PhoneWords.backFromSnooze(SnoozeRules().when(back)), nil) {}
      }
    }
    .background(Token.background)
  }

  private func line(_ symbol: String, _ words: String, _ action: String?, run: @escaping () -> Void) -> some View {
    VStack(spacing: 0) {
      HStack(alignment: .firstTextBaseline, spacing: Space.close) {
        Image(systemName: symbol).font(TextRole.meta).foregroundStyle(Token.mutedForeground).accessibilityHidden(true)
        Text(words).font(TextRole.secondary).foregroundStyle(Token.foreground).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
        if let action {
          Button(action, action: run)
            .font(TextRole.link)
            .foregroundStyle(Token.primary)
            .buttonStyle(PressStyle())
            .frame(minHeight: Space.touch)
            .contentShape(Rectangle())
        }
      }
      .padding(.horizontal, Space.page)
      .padding(.vertical, action == nil ? Space.near : 0)
      Hairline()
    }
  }
}

/// An archived thread's foot, where the reply field was: what archiving means, and the way back.
struct ArchivedFoot: View {
  let row: InboxListRow
  let agent: String
  let actions: RowActions

  var body: some View {
    VStack(spacing: 0) {
      Hairline()
      VStack(alignment: .leading, spacing: Space.step) {
        Text(PhoneWords.archivedLine(agent)).font(TextRole.secondary).foregroundStyle(Token.mutedForeground).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
        if actions.session.canAct(.unarchive) {
          Button {
            actions.perform(.unarchive, on: row, place: .open)
          } label: {
            Text(PhoneWords.unarchive).actionGround(.neutral)
          }
          .buttonStyle(PressStyle())
        }
      }
      .padding(.horizontal, Space.page)
      .padding(.vertical, Space.step)
    }
    .background(Token.background)
  }
}
