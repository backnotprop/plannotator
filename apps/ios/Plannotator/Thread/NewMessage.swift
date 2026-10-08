import PlannotatorKit
import SwiftUI

/// New message (8.1 to 8.3), the leading button of the reply bar: the
/// person writes to a live session of the thread's project without waiting
/// to be asked, as on the desktop. The live sessions are read when the
/// thread opens and every 10 s while it stays open, as the window reads them.
/// Several live: a system menu names each one (8.1). One: the compose sheet
/// opens addressed to it (8.2), after a fresh read. None: the desktop's
/// words, start it or reply instead (8.3).
struct NewMessageButton: View {
    let session: SourceSession
    let thread: InboxThread
    /// "Reply instead" (8.3): the reply composer.
    let replyInstead: () -> Void
    @Binding var problem: String?
    @State private var live: InboxLiveSessions?
    @State private var composeTo: InboxLiveSession?
    @State private var notRunning = false
    @State private var replyAfter = false
    @State private var reading = false
    @Environment(\.dynamicTypeSize) private var typeSize

    private var sessions: [InboxLiveSession] { live?.sessions ?? [] }

    var body: some View {
        Group {
            if sessions.count >= 2 {
                Menu {
                    Section(heading) {
                        ForEach(sessions) { target in
                            // A menu item reads its first text as the title, the second as the subtitle.
                            Button { composeTo = target } label: {
                                Text("Started \(When.clock(target.startedAt))")
                                Text(words(target))
                                mark(target.host)
                            }
                            .accessibilityIdentifier("live-session-\(target.session)")
                        }
                    }
                } label: {
                    icon
                }
                .menuStyle(.button)
                // The thread's writer stays first even though the menu opens upward.
                .menuOrder(.fixed)
            } else {
                Button(action: press) { icon }
            }
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .circle)
        .accessibilityLabel("New message")
        .accessibilityHint(sessions.isEmpty ? "No session is live in \(thread.project.name) right now." : "Writes to a live session in \(thread.project.name).")
        .accessibilityIdentifier("new-message")
        .popover(isPresented: $notRunning, arrowEdge: .bottom) {
            NotRunningCard(thread: thread, live: live) {
                replyAfter = true
                notRunning = false
            }
            // At the accessibility text sizes the words outgrow a popover: a full-height sheet that scrolls.
            .presentationCompactAdaptation(typeSize.isAccessibilitySize ? .sheet : .popover)
            .presentationDetents([.large])
        }
        .onChange(of: notRunning) { _, shown in
            if !shown, replyAfter {
                replyAfter = false
                replyInstead()
            }
        }
        .sheet(item: $composeTo) { target in
            NewMessageSheet(session: session, thread: thread, target: target, project: live?.project.name ?? thread.project.name)
        }
        .task(id: thread.threadId) {
            while !Task.isCancelled {
                await read()
                try? await Task.sleep(for: .seconds(10))
            }
        }
    }

    private var icon: some View {
        Image(systemName: "square.and.pencil")
            .font(.system(size: 19, weight: .semibold))
            .foregroundStyle(sessions.isEmpty ? Color.inkSecondary : Color.tint)
            .frame(width: 48, height: 48)
            .contentShape(.circle)
    }

    /// "Two Claude Code sessions are live in ledger" (the desktop's heading).
    private var heading: String {
        let counts = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"]
        let count = sessions.count < counts.count ? counts[sessions.count] : String(sessions.count)
        let hosts = Set(sessions.map(\.hostName))
        let which = hosts.count == 1 ? "\(hosts.first!) sessions" : "sessions"
        return "\(count) \(which) are live in \(live?.project.name ?? thread.project.name)"
    }

    /// "Wrote this thread. Idle since 10:05 AM." / "Working now; takes it when the turn ends."
    private func words(_ target: InboxLiveSession) -> String {
        var parts: [String] = []
        if target.wroteThread { parts.append("Wrote this thread.") }
        if target.busy == true {
            parts.append("Working now; takes it when the turn ends.")
        } else if target.busy == false, let idle = target.idleSince {
            parts.append("Idle since \(When.clock(idle)).")
        } else if !target.wroteThread {
            parts.append("Seen \(When.clock(target.lastSeenAt)).")
        }
        return parts.joined(separator: " ")
    }

    @ViewBuilder private func mark(_ host: String) -> some View {
        if let asset = AgentMark.asset(for: host) { Image(asset) } else { Image(systemName: "sparkle") }
    }

    @discardableResult
    private func read() async -> Bool {
        do {
            guard let inbox = session.inbox else { return false }
            live = try await inbox.sessions(thread: thread.threadId)
            return true
        } catch {
            return false
        }
    }

    /// One or none live as last read: read again, so a session that just started counts.
    private func press() {
        guard !reading else { return }
        reading = true
        Task {
            defer { reading = false }
            guard await read() else {
                problem = "Your computer can't be reached right now."
                return
            }
            problem = nil
            // Several now live: the button turns into the menu; the first is the thread's own writer.
            if let first = sessions.first { composeTo = first } else { notRunning = true }
        }
    }
}

/// 8.3: no session is live in the thread's project.
private struct NotRunningCard: View {
    let thread: InboxThread
    let live: InboxLiveSessions?
    let replyInstead: () -> Void

    private var asker: InboxAuthor? { thread.messages.first?.author }
    private var name: String { asker?.agentName ?? "The agent" }
    private var project: String { live?.project.name ?? thread.project.name }
    private var folder: String { live?.folder ?? project }
    /// Hosts whose Plannotator connection can wake a session (the desktop's list).
    private var connected: Bool { ["claude-code", "claude", "pi", "opencode"].contains(asker?.host ?? "") }

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if typeSize.isAccessibilitySize {
            ScrollView { card.frame(maxWidth: .infinity, alignment: .leading) }
        } else {
            card.frame(width: 330, alignment: .leading)
        }
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(connected ? "\(name) is not running in \(project)" : "No agent is running in \(project)")
                .font(.headline)
                .foregroundStyle(Color.ink)
                .accessibilityAddTraits(.isHeader)
            Text(connected
                ? "A new message goes to a live session. Start \(name) in \(folder) and press New message again, or reply here: \(name) reads replies when it next checks the Inbox."
                : "A new message goes to a live Claude Code, Pi or OpenCode session with Plannotator. Start one in \(folder) and press New message again, or reply here: \(name) reads replies when it next checks the Inbox.")
                .font(.subheadline)
                .foregroundStyle(Color.inkSecondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(action: replyInstead) {
                Label("Reply instead", systemImage: "arrowshape.turn.up.left")
                    .font(.body.weight(.semibold))
                    .padding(.horizontal, 6)
                    .frame(minHeight: 44)
            }
            .buttonStyle(.bordered)
            .tint(Color.ink)
            .padding(.top, 8)
            .accessibilityIdentifier("reply-instead")
        }
        .padding(18)
    }
}

/// 8.2: the compose sheet, full height, the session named in the To row.
struct NewMessageSheet: View {
    let session: SourceSession
    let thread: InboxThread
    let target: InboxLiveSession
    let project: String
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var sending = false
    @State private var problem: String?
    @State private var confirmDiscard = false
    /// One key per message, kept across retries until the Inbox gives a definite answer (contract section 6).
    @State private var key = UUID().uuidString.lowercased()
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) { toLabel; chip; inProject }
                    VStack(alignment: .leading, spacing: 8) { HStack(spacing: 10) { toLabel; chip }; inProject }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("new-message-to")
                Divider()
                TextField("Write a message", text: $text, axis: .vertical)
                    .font(.body)
                    .focused($focused)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 14)
                    .accessibilityLabel("New message to \(target.hostName)")
                    .accessibilityIdentifier("new-message-text")
                if let problem {
                    Label(problem, systemImage: "exclamationmark.circle.fill")
                        .font(.footnote)
                        .foregroundStyle(Color.destructive)
                        .padding(.horizontal, 20)
                        .accessibilityLabel(problem)
                        .accessibilityIdentifier("new-message-problem")
                }
                Spacer(minLength: 0)
            }
            .background(Color.screen)
            .navigationTitle("New message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark", role: .cancel) {
                        if text.trimmed.isEmpty { dismiss() } else { confirmDiscard = true }
                    }
                    .tint(Color.ink)
                    .accessibilityIdentifier("new-message-cancel")
                    .confirmationDialog("Discard this message?", isPresented: $confirmDiscard, titleVisibility: .visible) {
                        Button("Discard Message", role: .destructive) { dismiss() }
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(action: send) {
                        if sending { ProgressView() } else { Label("Send", systemImage: "arrow.up") }
                    }
                    .buttonStyle(.glassProminent)
                    .tint(.tint)
                    .disabled(text.trimmed.isEmpty || sending)
                    .accessibilityIdentifier("new-message-send")
                }
            }
        }
        .presentationDetents([.large])
        .interactiveDismissDisabled(!text.trimmed.isEmpty)
        // Edited words are a new message: a retry after an edit gets its own key.
        .onChange(of: text) { key = UUID().uuidString.lowercased() }
        .onAppear { focused = true }
    }

    private var toLabel: some View { Text("To").foregroundStyle(Color.inkSecondary) }

    /// "Pi, started 9:04 AM".
    private var chip: some View {
        HStack(spacing: 7) {
            AgentMark(author: InboxAuthor(kind: "agent", host: target.host))
            Text("\(target.hostName), started \(When.clock(target.startedAt))")
                .font(.callout.weight(.semibold))
                .foregroundStyle(Color.ink)
        }
        .padding(.leading, 9)
        .padding(.trailing, 12)
        .frame(minHeight: 32)
        .background(Color.fill, in: .capsule)
    }

    private var inProject: some View {
        Text("in \(project)").font(.subheadline).foregroundStyle(Color.inkSecondary)
    }

    private func send() {
        guard !text.trimmed.isEmpty, !sending else { return }
        sending = true
        problem = nil
        Task {
            defer { sending = false }
            do throws(InboxError) {
                try await session.newMessage(thread: thread.threadId, to: target, body: text.trimmed, key: key)
                Haptics.success()
                dismiss()
            } catch {
                Haptics.error()
                if error.isDefinite {
                    // A definite answer ends this key; a new try is a new message.
                    key = UUID().uuidString.lowercased()
                    problem = error.message
                } else {
                    problem = "Not sent. \(error.message) Tap Send to try again."
                }
            }
        }
    }
}
