import PlannotatorKit
import SwiftUI

/// 2.1B: the sections as inset cards; pull to refresh (2.2); "N new" while
/// scrolled (2.3); swipe for Resolve and Delete (2.4).
struct InboxList: View {
    let session: SourceSession
    @Binding var path: [ThreadRoute]
    @State private var quietOpen = false
    @State private var deleting: InboxListRow?
    @State private var problem: String?

    var body: some View {
        content
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { ProjectFilter(session: session) }
            }
            .confirmationDialog("Delete this thread?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), titleVisibility: .visible, presenting: deleting) { row in
                Button("Delete Thread", role: .destructive) { act { try await session.delete(thread: row.threadId) } }
            } message: { _ in
                Text("It is removed from the Inbox on your computer, with its answers.")
            }
            .alert("Something went wrong", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(problem ?? "")
            }
    }

    @ViewBuilder private var content: some View {
        if session.status == .removed {
            SourceRemoved(session: session)
        } else if let list = session.list {
            if list.sections.allSatisfy(\.threads.isEmpty) {
                ScrollView {
                    ContentUnavailableView("Nothing waiting", systemImage: "tray", description: Text(session.emptyHelp))
                        .padding(.top, 80)
                }
                .refreshable { await session.reconnect() }
                .background(Color.screen)
            } else {
                rows(list)
            }
        } else if session.status == .unreachable {
            SourceUnreachable(session: session)
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity).background(Color.screen)
        }
    }

    private func rows(_ list: InboxListModel) -> some View {
        ScrollViewReader { proxy in
            List {
                ForEach(list.sections.filter { !$0.threads.isEmpty }) { section in
                    if section.id == "quiet" {
                        Section {
                            quietToggle(section)
                            if quietOpen { ForEach(section.threads) { row($0) } }
                        }
                    } else {
                        Section {
                            ForEach(section.threads) { row($0) }
                        } header: {
                            HStack(alignment: .firstTextBaseline, spacing: 7) {
                                Text(section.label).font(.headline).foregroundStyle(Color.ink)
                                Text("\(section.threads.count)").font(.body).foregroundStyle(Color.inkSecondary)
                            }
                            .textCase(nil)
                            .accessibilityElement(children: .combine)
                            .accessibilityAddTraits(.isHeader)
                        }
                    }
                }
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(.compact)
            .scrollContentBackground(.hidden)
            .background(Color.ground)
            .refreshable { await session.reconnect() }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentOffset.y + geometry.contentInsets.top > 24
            } action: { _, scrolled in
                session.scrolled = scrolled
            }
            .overlay(alignment: .top) {
                if session.newCount > 0 {
                    Button {
                        // A tap scrolls to the threads that arrived.
                        if let first = session.showNew() {
                            withAnimation { proxy.scrollTo(first, anchor: .center) }
                        }
                    } label: {
                        Label("\(session.newCount) new", systemImage: "arrow.up")
                            .font(.subheadline.weight(.semibold))
                            .labelStyle(NewPillLabel())
                            .padding(.horizontal, 15)
                            .padding(.vertical, 9)
                    }
                    .buttonStyle(.plain)
                    .glassEffect(.regular.interactive(), in: .capsule)
                    .padding(.top, 8)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .accessibilityLabel("\(session.newCount) new threads. Show them.")
                    .accessibilityIdentifier("new-pill")
                }
            }
            .animation(.snappy, value: session.newCount)
        }
    }

    private func row(_ row: InboxListRow) -> some View {
        Button {
            path.append(ThreadRoute(id: row.threadId))
        } label: {
            ListRowView(row: row)
        }
        .tint(Color.ink)
        .listRowBackground(Color.card)
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button {
                act { try await session.resolve(thread: row.threadId, resolved: true) }
            } label: {
                Label("Resolve", systemImage: "archivebox")
            }
            .tint(.tint)
            if session.canDelete {
                Button {
                    deleting = row
                } label: {
                    Label("Delete", systemImage: "trash")
                }
                .tint(.destructive)
            }
        }
    }

    private func quietToggle(_ section: InboxListSection) -> some View {
        Button {
            withAnimation(.snappy) { quietOpen.toggle() }
        } label: {
            HStack(spacing: 7) {
                Text(section.label).font(.headline).foregroundStyle(Color.ink)
                Text("\(section.threads.count)").foregroundStyle(Color.inkSecondary)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(quietOpen ? 90 : 0))
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .listRowBackground(Color.card)
        .accessibilityValue(quietOpen ? "Shown" : "Folded")
    }

    private func act(_ work: @escaping () async throws -> Void) {
        Task {
            do { try await work() } catch { problem = (error as? InboxError)?.message ?? error.localizedDescription }
        }
    }
}

private struct NewPillLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.icon.foregroundStyle(Color.tint)
            configuration.title.foregroundStyle(Color.ink)
        }
    }
}

/// The approved phone row (Workspaces D2): project, count and time on line
/// one; badge, agent mark, the named thread's chip and the subject on line two.
struct ListRowView: View {
    let row: InboxListRow
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        // At the accessibility sizes both lines stack and the subject wraps,
        // so nothing is cut to "…".
        let large = typeSize.isAccessibilitySize
        VStack(alignment: .leading, spacing: 4) {
            Group {
                if large {
                    Text(row.project.name)
                    Text([count, When.short(row.lastAt)].compactMap { $0 }.joined(separator: " · "))
                } else {
                    HStack(alignment: .firstTextBaseline, spacing: 9) {
                        Text(row.project.name).lineLimit(1)
                        Spacer(minLength: 8)
                        if let count { Text(count).lineLimit(1) }
                        Text(When.short(row.lastAt)).monospacedDigit().lineLimit(1)
                    }
                }
            }
            .font(.subheadline)
            .foregroundStyle(Color.inkSecondary)
            let line = large ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(spacing: 7))
            line {
                HStack(spacing: 7) {
                    if let badge {
                        Text(badge)
                            .font(.footnote.weight(.semibold))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.ink.opacity(0.38)))
                            .fixedSize()
                    }
                    AgentMark(author: row.author)
                    if let name = row.threadName {
                        Text(name)
                            .font(.caption.monospaced())
                            .foregroundStyle(Color.inkSecondary)
                            .lineLimit(1)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Color.hairline))
                            .fixedSize(horizontal: !large, vertical: false)
                    }
                }
                Text(subject)
                    .layoutPriority(large ? 0 : -1)
                    .font(.body.weight(row.unread ? .semibold : .regular))
                    .foregroundStyle(row.section == "sent" ? Color.inkSecondary : Color.ink)
                    .lineLimit(large ? 4 : 1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 3)
        .contentShape(.rect)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityIdentifier("row-\(row.threadId)")
    }

    private var badge: String? {
        switch row.section {
        case "stopped": "Stopped"
        case "holding": "Holds up \(row.questions.holdsUp.count)"
        default: nil
        }
    }

    private var count: String? {
        if row.answeredNotSent { return "Answered, not sent" }
        return row.questions.open >= 2 ? "\(row.questions.open) questions" : nil
    }

    /// A Sent row says where its reply is.
    private var subject: String {
        guard row.section == "sent", let sent = row.sent else { return row.subject ?? "(no subject)" }
        if let checked = sent.checkedAt { return "Delivered to \(row.author.agentName), \(When.clock(checked))" }
        return "Saved for \(row.author.agentName). It sees it when it checks."
    }

    private var accessibilityText: String {
        [row.project.name, badge, row.author.agentName, row.threadName, subject, count, When.short(row.lastAt), row.unread ? "Unread" : nil]
            .compactMap { $0 }
            .joined(separator: ", ")
    }
}

/// The toolbar's project filter (the desktop sidebar's folders).
struct ProjectFilter: View {
    let session: SourceSession

    var body: some View {
        Menu {
            Picker("Project", selection: Binding(get: { session.project }, set: { value in Task { await session.filter(project: value) } })) {
                Text("All projects").tag(String?.none)
                ForEach(session.list?.projects ?? []) { project in
                    Text(project.name).badge(project.unread ?? 0).tag(Optional(project.id))
                }
            }
        } label: {
            Image(systemName: session.project == nil ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill")
        }
        .accessibilityLabel("Filter by project")
    }
}
