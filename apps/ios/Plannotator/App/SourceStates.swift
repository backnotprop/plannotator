import SwiftUI

/// The shown source was removed on the computer, or signed out of Workspaces: pair or sign in again (Inbox and Decisions).
struct SourceRemoved: View {
    let session: SourceSession
    @Environment(AppModel.self) private var model

    var body: some View {
        ContentUnavailableView {
            Label(session.removedTitle, systemImage: session.removedSymbol)
        } description: {
            Text(session.removedHelp)
        } actions: {
            Button(session.removedAction) {
                if session.isWorkspaces { Task { await model.signInToWorkspaces() } } else { model.pairing = true }
            }
            .buttonStyle(.borderedProminent)
        }
        .background(Color.screen)
    }
}

/// The shown source cannot be reached and nothing was read before (Inbox and Decisions).
struct SourceUnreachable: View {
    let session: SourceSession

    var body: some View {
        ContentUnavailableView {
            Label("Can't reach \(session.name)", systemImage: "wifi.slash")
        } description: {
            Text(session.unreachableHelp)
        } actions: {
            Button("Try Again") { Task { await session.reconnect() } }
        }
        .background(Color.screen)
    }
}
