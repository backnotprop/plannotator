import PlannotatorKit
import SwiftUI

struct ThreadRoute: Hashable {
    var id: String
}

/// The Inbox tab: the list (2.1B) under the large title with the source
/// under it, or the first run (1.1) when nothing is paired.
struct InboxTab: View {
    @Environment(AppModel.self) private var model
    @State private var path: [ThreadRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let session = model.session {
                    InboxList(session: session, path: $path)
                } else {
                    FirstRun()
                }
            }
            .navigationTitle("Inbox")
            .navigationSubtitle(SourceMenu.subtitle(model.session))
            .toolbarTitleMenu { SourceMenu() }
            // 1.5A: the title is the switcher. iOS 26 draws the title menu's
            // chevron only on an inline title; a large title hides the switcher
            // until the list scrolls, and a short list never scrolls.
            .toolbarTitleDisplayMode(.inline)
            .navigationDestination(for: ThreadRoute.self) { route in
                if let session = model.session { ThreadScreen(session: session, threadId: route.id) }
            }
        }
        .onChange(of: model.session?.id) { path = [] }
        // A tapped notification's thread, after any change of source above.
        .onChange(of: model.opening, initial: true) {
            guard let route = model.opening else { return }
            model.opening = nil
            path = [route]
        }
    }

}

/// The title's menu (1.5A): each source with what waits in it, one shown at a
/// time, and Add a source. Inbox and Decisions both carry it.
struct SourceMenu: View {
    @Environment(AppModel.self) private var model

    /// The source under the large title, and whether it can be reached.
    static func subtitle(_ session: SourceSession?) -> Text {
        guard let session else { return Text("No source yet") }
        switch session.status {
        case .unreachable:
            let relayOff = session.source != nil && !session.relayOn
            return Text("\(session.name) · Not reachable\(relayOff ? ", relay off" : "")")
        case .removed: return Text("\(session.name) · \(session.isWorkspaces ? "Signed out" : "Removed")")
        case .connected where session.path == .relay:
            return Text("\(session.name) · \(session.inboxOnline ? "Through the relay" : "Waiting for your computer")")
        default: return Text(session.name)
        }
    }

    var body: some View {
        Picker("Source", selection: Binding(get: { model.activeId }, set: { show($0) })) {
            // A button with two texts and an image is the menu row with a
            // subtitle and a mark; the picker adds the checkmark.
            ForEach(model.sources) { source in
                Button {} label: {
                    Text(source.name)
                    Text("Inbox · \(model.waiting(source.id)) waiting")
                    Image(systemName: "laptopcomputer")
                }
                .tag(Optional(source.id))
            }
            if let account = model.workspaces {
                Button {} label: {
                    Text("Workspaces")
                    Text("\(account.teamLine) · \(model.waiting(WorkspacesAccount.sourceId)) waiting")
                    Image("WorkspacesIcon")
                }
                .tag(Optional(WorkspacesAccount.sourceId))
            }
        }
        .pickerStyle(.inline)
        AddSourceMenu()
    }

    private func show(_ id: String?) {
        if id == WorkspacesAccount.sourceId {
            model.showWorkspaces()
        } else if let source = model.sources.first(where: { $0.id == id }) {
            model.show(source)
        }
    }
}

/// "Add a source": a computer's Inbox, or Workspaces while this build has it and no one is signed in.
struct AddSourceMenu: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.hasWorkspaces, model.workspaces == nil {
            Menu("Add a source", systemImage: "plus") {
                Button("Your computer's Inbox", systemImage: "laptopcomputer") { model.pairing = true }
                Button("Workspaces", systemImage: "person.crop.circle") { Task { await model.signInToWorkspaces() } }
            }
        } else {
            Button("Add a source", systemImage: "plus") { model.pairing = true }
        }
    }
}

/// 1.1: nothing connected yet.
struct FirstRun: View {
    @Environment(AppModel.self) private var model
    @ScaledMetric(relativeTo: .largeTitle) private var mark: CGFloat = 84

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Image("Tater")
                    .resizable()
                    .scaledToFit()
                    .frame(height: mark)
                    .padding(.top, 40)
                    .padding(.bottom, 14)
                    .accessibilityHidden(true)
                Text("Nothing connected yet")
                    .font(.title2.bold())
                    .multilineTextAlignment(.center)
                Text(model.hasWorkspaces ? "Connect the Inbox on your computer, Workspaces, or both." : "Connect the Inbox on your computer.")
                    .font(.body)
                    .foregroundStyle(Color.inkSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 36)
                    .padding(.top, 6)
                    .padding(.bottom, 22)
                VStack(spacing: 0) {
                    Button {
                        model.pairing = true
                    } label: {
                        tile(title: "Your computer's Inbox", detail: "Scan the code it shows, or find it nearby") {
                            Image("Tater")
                                .resizable()
                                .scaledToFit()
                                .padding(.top, 6)
                                .frame(width: 44, height: 44, alignment: .bottom)
                                .background(Color.fill, in: .rect(cornerRadius: 12))
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("connect-computer")
                    if model.hasWorkspaces {
                        Divider().padding(.leading, 73)
                        Button {
                            Task { await model.signInToWorkspaces() }
                        } label: {
                            tile(title: "Workspaces", detail: "Sign in with your account", busy: model.signingIn) {
                                Image("WorkspacesIcon").resizable().scaledToFit().frame(width: 44, height: 44)
                            }
                        }
                        .buttonStyle(.plain)
                        .disabled(model.signingIn)
                        .accessibilityIdentifier("connect-workspaces")
                    }
                }
                .background(Color.raised, in: .rect(cornerRadius: 24))
                .padding(.horizontal, 16)
            }
            .frame(maxWidth: .infinity)
        }
        .background(Color.screen)
    }

    /// One row of the card: a mark, what it connects, how, and a chevron.
    private func tile(title: String, detail: String, busy: Bool = false, @ViewBuilder mark: () -> some View) -> some View {
        HStack(spacing: 13) {
            mark().accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.semibold)).foregroundStyle(Color.ink)
                Text(detail).font(.footnote).foregroundStyle(Color.inkSecondary)
            }
            Spacer(minLength: 0)
            if busy {
                ProgressView()
            } else {
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
        }
        .multilineTextAlignment(.leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 15)
        .contentShape(.rect(cornerRadius: 24))
    }
}
