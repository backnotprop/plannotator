import PlannotatorKit
import SwiftUI

/// 5.2: the Decisions tab, per source like the Inbox, the project a menu
/// under the title. Waiting first, then Settled (newest first); Replaced or
/// retired stays folded. A row opens its thread.
struct DecisionsTab: View {
    @Environment(AppModel.self) private var model
    @State private var path: [ThreadRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if let session = model.session {
                    DecisionsList(session: session, path: $path)
                } else {
                    FirstRun()
                }
            }
            .navigationTitle("Decisions")
            .navigationSubtitle(SourceMenu.subtitle(model.session))
            .toolbarTitleMenu { SourceMenu() }
            // As the Inbox tab draws it: iOS 26 shows the title menu's chevron only on an inline title.
            .toolbarTitleDisplayMode(.inline)
            .navigationDestination(for: ThreadRoute.self) { route in
                if let session = model.session { ThreadScreen(session: session, threadId: route.id) }
            }
        }
        .onChange(of: model.session?.id) { path = [] }
    }
}

struct DecisionsList: View {
    let session: SourceSession
    @Binding var path: [ThreadRoute]
    @State private var endedOpen = false

    private var projects: [InboxProject] { session.list?.projects ?? [] }
    private var project: InboxProject? { projects.first { $0.id == session.decisionsProject } }
    private var shown: InboxDecisionsModel? { session.decisionsProject.flatMap { session.decisions[$0] } }

    var body: some View {
        content
            .background(Color.screen)
            // The tab opens on the project with the newest activity, and keeps the
            // person's pick after, until that project is deleted on the computer.
            .task(id: projects.map(\.id)) { await openDefault() }
            .onChange(of: session.decisionsProject) { _, now in
                if now == nil { Task { await openDefault() } }
            }
    }

    private func openDefault() async {
        if session.decisionsProject == nil, let first = session.defaultDecisionsProject {
            await session.showDecisions(project: first)
        }
    }

    @ViewBuilder private var content: some View {
        if session.status == .removed {
            SourceRemoved(session: session)
        } else if session.isWorkspaces {
            ContentUnavailableView("Decisions in Workspaces", systemImage: "diamond", description: Text("This tab shows the decisions of your computer's Inbox. Decisions recorded in Workspaces are on its website."))
        } else if let project, let shown {
            list(project, shown)
        } else if session.list != nil, projects.isEmpty {
            ContentUnavailableView("No decisions yet", systemImage: "diamond", description: Text("When you answer an agent on \(session.name) and record the answer as a decision, it shows up here."))
        } else if session.status == .unreachable {
            SourceUnreachable(session: session)
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func list(_ project: InboxProject, _ model: InboxDecisionsModel) -> some View {
        let settled = model.decisions.filter { $0.state == "current" }.reversed()
        let ended = model.decisions.filter { $0.state != "current" }.reversed()
        return List {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    projectMenu(project)
                    Text("What holds true in \(project.name), and what waits on a call.")
                        .font(.subheadline)
                        .foregroundStyle(Color.inkSecondary)
                }
                .padding(.bottom, 6)
                .plainRow()
            }
            if !model.waiting.isEmpty {
                Section {
                    ForEach(model.waiting) { item in
                        Button { path.append(ThreadRoute(id: item.threadId)) } label: {
                            DecisionRow(text: item.prompt, emphasized: true, source: "Asked by \(item.agent?.displayName ?? "An agent"), \(When.dayWords(item.askedAt))", when: nil)
                        }
                        .plainRow()
                        .accessibilityIdentifier("waiting-\(item.questionId)")
                    }
                } header: {
                    GroupHeader(title: "Waiting", count: model.waiting.count)
                }
            }
            Section {
                if settled.isEmpty {
                    Text("Nothing recorded in \(project.name) yet.")
                        .foregroundStyle(Color.inkSecondary)
                        .plainRow()
                }
                ForEach(settled) { row($0) }
            } header: {
                GroupHeader(title: "Settled", count: settled.count)
            }
            if !ended.isEmpty {
                Section {
                    Button {
                        withAnimation(.snappy) { endedOpen.toggle() }
                    } label: {
                        HStack(alignment: .firstTextBaseline, spacing: 7) {
                            Text("Replaced or retired").font(.headline).foregroundStyle(Color.ink)
                            Text("\(ended.count)").foregroundStyle(Color.inkSecondary)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.tertiary)
                                .rotationEffect(.degrees(endedOpen ? 90 : 0))
                        }
                        .padding(.vertical, 12)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .listRowSeparator(.visible, edges: .top)
                    .listRowSeparatorTint(Color.hairline)
                    .listRowInsets(.init(top: 0, leading: 16, bottom: 0, trailing: 16))
                    .listRowBackground(Color.screen)
                    .accessibilityValue(endedOpen ? "Shown" : "Folded")
                    .accessibilityIdentifier("decisions-ended")
                    if endedOpen { ForEach(ended) { row($0) } }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable { await session.refresh() }
    }

    @ViewBuilder private func row(_ decision: InboxDecision) -> some View {
        let label = DecisionRow(text: decision.text, emphasized: false, source: source(decision), when: When.short(decision.changedAt ?? decision.createdAt))
        // A decision from an answer opens its thread; one an agent recorded has none.
        if let thread = decision.source.threadId {
            Button { path.append(ThreadRoute(id: thread)) } label: { label }
                .plainRow()
                .accessibilityIdentifier("decision-\(decision.id)")
        } else {
            label
                .plainRow()
                .accessibilityIdentifier("decision-\(decision.id)")
        }
    }

    /// "From your answer to Claude Code · Recorded at Send" (the desktop's two muted columns, one line here).
    private func source(_ decision: InboxDecision) -> String {
        let agent = decision.source.agent?.displayName ?? "An agent"
        let ended = decision.state == "replaced" ? "Replaced · " : decision.state == "retired" ? "Retired · " : ""
        switch decision.source.kind {
        case "answer": return "\(ended)From your answer to \(agent) · Recorded at Send"
        case "agent": return "\(ended)Recorded by \(agent) · record_decision"
        default: return "\(ended)Written by you"
        }
    }

    private func projectMenu(_ project: InboxProject) -> some View {
        Menu {
            Picker("Project", selection: Binding(get: { project.id }, set: { id in Task { await session.showDecisions(project: id) } })) {
                ForEach(projects) { Text($0.name).tag($0.id) }
            }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: "folder")
                Text(project.name).fontWeight(.semibold).lineLimit(2)
                Image(systemName: "chevron.down").font(.footnote.weight(.bold))
            }
            .font(.body)
            .foregroundStyle(Color.ink)
            .padding(.horizontal, 14)
            .frame(minHeight: 40)
            .background(Color.fill, in: .capsule)
            .contentShape(.capsule)
        }
        .accessibilityLabel("Project, \(project.name)")
        .accessibilityIdentifier("decisions-project")
    }
}

/// One decision, or one question waiting on a call: the diamond, the words, where it came from and when.
private struct DecisionRow: View {
    let text: String
    let emphasized: Bool
    let source: String
    let when: String?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: "diamond")
                .font(.subheadline)
                .foregroundStyle(Color.inkSecondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(text)
                    .font(.body.weight(emphasized ? .semibold : .regular))
                    .foregroundStyle(Color.ink)
                    .multilineTextAlignment(.leading)
                let line = typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 2)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline, spacing: 8))
                line {
                    Text(source).lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                    if let when {
                        if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
                        Text(when).fixedSize()
                    }
                }
                .font(.subheadline)
                .foregroundStyle(Color.inkSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 10)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

/// "Waiting 1", "Settled 3".
private struct GroupHeader: View {
    let title: String
    let count: Int

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Text(title).font(.headline).foregroundStyle(Color.ink)
            Text("\(count)").font(.body).foregroundStyle(Color.inkSecondary)
        }
        .textCase(nil)
        .padding(.top, 8)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

private extension View {
    /// A row on the plain screen, as the record draws the page: no cell, no separator.
    func plainRow() -> some View {
        buttonStyle(.plain)
            .listRowSeparator(.hidden)
            .listRowBackground(Color.screen)
            .listRowInsets(.init(top: 0, leading: 16, bottom: 0, trailing: 16))
    }
}
