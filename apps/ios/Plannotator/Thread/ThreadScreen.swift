import PlannotatorKit
import SwiftUI

/// 3.1 to 3.5: the thread read as an email, its questions as native cards,
/// the reply bar docked at the bottom.
struct ThreadScreen: View {
    let session: SourceSession
    let threadId: String
    @Environment(\.dismiss) private var dismiss
    @State private var confirmDelete = false
    @State private var problem: String?
    @State private var retrying = false
    @State private var openFile: OpenFile?
    @State private var showAnnotations = false
    @State private var fileAfterSheet: OpenFile?

    private var thread: InboxThread? { session.threads[threadId] }

    var body: some View {
        Group {
            if session.status == .removed {
                ContentUnavailableView {
                    Label("This phone was removed", systemImage: "iphone.slash")
                } description: {
                    Text("It was removed from the Inbox on \(session.source.name). Pair it again to keep answering.")
                }
            } else if let thread {
                content(thread)
            } else if session.threadProblems[threadId] == .gone {
                // Deleted on the computer (or by another phone): nothing to answer here.
                ContentUnavailableView {
                    Label("This thread was deleted", systemImage: "trash")
                } description: {
                    Text("It was deleted in the Inbox on \(session.source.name).")
                } actions: {
                    Button("Back to Inbox") { dismiss() }
                }
                .accessibilityIdentifier("thread-gone")
            } else if session.threadProblems[threadId] == .unreachable, !retrying {
                ContentUnavailableView {
                    Label("Can't reach \(session.source.name)", systemImage: "wifi.slash")
                } description: {
                    Text("This thread has not been read on this phone yet. Check that the Inbox is running on your computer and that Tailscale is on.")
                } actions: {
                    Button("Try Again") {
                        retrying = true
                        Task {
                            await session.loadThread(threadId)
                            retrying = false
                        }
                    }
                }
                .accessibilityIdentifier("thread-unreachable")
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color.screen)
        .toolbar(.hidden, for: .tabBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let thread {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        resolve(thread, to: thread.resolvedAt == nil)
                    } label: {
                        Label(thread.resolvedAt == nil ? "Resolve" : "Reopen", systemImage: thread.resolvedAt == nil ? "archivebox" : "tray.and.arrow.up")
                    }
                    .accessibilityIdentifier("thread-resolve")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Delete Thread", systemImage: "trash", role: .destructive) { confirmDelete = true }
                    } label: {
                        Label("More", systemImage: "ellipsis")
                    }
                    .accessibilityIdentifier("thread-more")
                }
            }
        }
        .confirmationDialog("Delete this thread?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete Thread", role: .destructive) {
                Task {
                    do throws(InboxError) {
                        try await session.delete(thread: threadId)
                        dismiss()
                    } catch { problem = error.message }
                }
            }
        } message: {
            Text("It is removed from the Inbox on your computer, with its answers.")
        }
        .alert("Something went wrong", isPresented: Binding(get: { problem != nil }, set: { if !$0 { problem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(problem ?? "")
        }
        .fullScreenCover(item: $openFile) { file in
            AttachmentCover(session: session, threadId: threadId, file: file)
        }
        .sheet(isPresented: $showAnnotations, onDismiss: {
            // A file name in the list: the file opens once the sheet has gone.
            openFile = fileAfterSheet
            fileAfterSheet = nil
        }) {
            AnnotationsSheet(session: session, threadId: threadId, current: nil) { file in
                fileAfterSheet = file
                showAnnotations = false
            }
        }
        .task { await session.open(thread: threadId) }
        .onDisappear { session.close(thread: threadId) }
    }

    private func content(_ thread: InboxThread) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text(thread.subject ?? "(no subject)")
                    .font(.title2.bold())
                    .foregroundStyle(Color.ink)
                    .padding(.bottom, 14)
                    .accessibilityAddTraits(.isHeader)
                ForEach(thread.messages) { message in
                    MessageView(message: message, thread: thread, session: session, onError: { problem = $0 }, openFile: { openFile = $0 })
                        .padding(.bottom, 18)
                }
                if let delivery = deliveryLine(thread) {
                    Label(delivery, systemImage: "checkmark.circle")
                        .font(.footnote)
                        .foregroundStyle(Color.inkSecondary)
                        .padding(.bottom, 12)
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
        }
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if thread.resolvedAt == nil {
                ReplyBar(session: session, thread: thread, showAnnotations: { showAnnotations = true })
            } else {
                HStack {
                    Text("Resolved").foregroundStyle(Color.inkSecondary)
                    Spacer()
                    Button("Reopen") { resolve(thread, to: false) }.fontWeight(.semibold)
                }
                .padding(.horizontal, 20)
                .frame(minHeight: 48)
                .glassEffect(.regular, in: .capsule)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            }
        }
        .refreshable { await session.loadThread(threadId) }
    }

    /// The last message is the person's: say where it is (the desktop's words).
    private func deliveryLine(_ thread: InboxThread) -> String? {
        guard let last = thread.messages.last, !last.author.isAgent, let root = thread.messages.first else { return nil }
        let asker = root.author.agentName
        if let to = last.to {
            let host = InboxAuthor.hostNames[to.host] ?? to.host
            if let delivery = last.delivery { return "Delivered to \(host), \(When.clock(delivery.at))" }
            return "\(host) takes it as its next turn."
        }
        if let delivery = last.delivery { return "Delivered to \(asker), \(When.clock(delivery.at))" }
        if let checked = When.date(root.agentCheckedAt), let sent = When.date(last.createdAt), checked >= sent {
            return "Delivered to \(asker), \(When.clock(root.agentCheckedAt))"
        }
        return "Saved for \(asker). It sees it when it checks."
    }

    private func resolve(_ thread: InboxThread, to resolved: Bool) {
        Task {
            do throws(InboxError) {
                try await session.resolve(thread: threadId, resolved: resolved)
                if resolved { dismiss() }
            } catch { problem = error.message }
        }
    }
}

/// One message: the sender row, then the body drawn natively with its
/// question blocks as cards.
struct MessageView: View {
    let message: InboxMessage
    let thread: InboxThread
    let session: SourceSession
    let onError: (String) -> Void
    let openFile: (OpenFile) -> Void

    private var questions: [InboxQuestion] { (message.questions ?? []).sorted { $0.position < $1.position } }

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            sender
            ForEach(Array(MessageBlock.parse(message.body).enumerated()), id: \.offset) { _, block in
                if case .question(let index) = block {
                    if index < questions.count {
                        QuestionCard(question: questions[index], number: index + 1, total: questions.count, readOnly: thread.resolvedAt != nil, session: session, threadId: thread.threadId, onError: onError)
                    }
                } else {
                    MarkdownBlockView(block: block)
                }
            }
            if let files = session.files[thread.threadId], case let attachments = files.attachments.filter({ $0.messageId == message.id }), !attachments.isEmpty {
                AttachmentTiles(attachments: attachments, annotations: files.annotations, open: openFile)
            }
        }
    }

    @Environment(\.dynamicTypeSize) private var typeSize

    /// The sender row; at the accessibility sizes the time moves under the name.
    private var sender: some View {
        let large = typeSize.isAccessibilitySize
        return HStack(alignment: .center, spacing: 11) {
            AgentMark(author: message.author)
                .frame(width: large ? 52 : 40, height: large ? 52 : 40)
                .background(Color.fill, in: .rect(cornerRadius: 11))
            VStack(alignment: .leading, spacing: 1) {
                if message.author.isAgent {
                    Text("\(Text(message.author.agentName).fontWeight(.semibold)) \(Text("in \(thread.project.name)").foregroundStyle(Color.inkSecondary))")
                        .font(.callout)
                    Text("to you").font(.footnote).foregroundStyle(Color.inkSecondary)
                } else {
                    Text("You").font(.callout.weight(.semibold))
                    Text("to \(message.to.map { InboxAuthor.hostNames[$0.host] ?? $0.host } ?? (thread.messages.first?.author.agentName ?? "the agent"))")
                        .font(.footnote).foregroundStyle(Color.inkSecondary)
                }
                if large { Text(When.clock(message.createdAt)).font(.subheadline).foregroundStyle(Color.inkSecondary) }
            }
            if !large {
                Spacer(minLength: 8)
                Text(When.clock(message.createdAt))
                    .font(.subheadline)
                    .foregroundStyle(Color.inkSecondary)
                    .frame(maxHeight: .infinity, alignment: .top)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .combine)
    }
}
