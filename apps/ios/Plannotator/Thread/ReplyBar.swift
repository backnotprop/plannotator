import PlannotatorKit
import SwiftUI
import UIKit

/// 3.4A: the reply bar docked over the thread, New message on its left (8.1),
/// Send always under the thumb.
/// Tapping the field opens the composer above the keyboard (3.5), with the
/// picks written in as words, as on the desktop.
struct ReplyBar: View {
    let session: SourceSession
    let thread: InboxThread
    /// The "3 annotations" chip opens the list (3.6).
    let showAnnotations: () -> Void
    @State private var composing = false
    @State private var words = ""
    @State private var sending = false
    @State private var problem: String?
    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var asker: String { thread.messages.first?.author.agentName ?? "the agent" }
    private var picked: [InboxQuestion] { thread.messages.flatMap { ($0.questions ?? []).filter(\.isPicked) } }
    private var annotationCount: Int { session.pendingAnnotations(thread: thread.threadId).count }
    private var canSend: Bool { !picked.isEmpty || annotationCount > 0 || !words.trimmed.isEmpty || session.hasTypedAnswers(thread: thread.threadId) }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let problem = problem ?? session.sendProblems[thread.threadId] {
                Label(problem, systemImage: "exclamationmark.circle.fill")
                    .accessibilityLabel(problem)
                    .font(.footnote)
                    .foregroundStyle(Color.destructive)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .glassEffect(.regular, in: .rect(cornerRadius: 16))
                    .accessibilityIdentifier("send-problem")
            }
            if composing { composer } else { bar }
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .animation(reduceMotion ? .easeInOut(duration: 0.2) : .snappy, value: composing)
    }

    private var bar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            // New message writes to a live session of a computer's Inbox; Workspaces has none.
            if !session.isWorkspaces { NewMessageButton(session: session, thread: thread, replyInstead: open, problem: $problem) }
            HStack(spacing: 6) {
                Button(action: open) {
                    HStack(spacing: 6) {
                        if picked.isEmpty && annotationCount == 0 && words.trimmed.isEmpty {
                            Text("Reply to \(asker)").foregroundStyle(Color.inkSecondary).lineLimit(1).padding(.leading, 8)
                        } else if !words.trimmed.isEmpty {
                            Text(words).foregroundStyle(Color.ink).lineLimit(1).padding(.leading, 8)
                        }
                        if !picked.isEmpty { picksChip }
                    }
                    .frame(minWidth: 44, minHeight: 48)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(picked.isEmpty ? "Reply to \(asker)" : "Reply to \(asker), \(plural(picked.count, "pick")) waiting")
                .accessibilityIdentifier("reply-field")
                if annotationCount > 0 { annotationsChip }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .frame(minHeight: 48)
            .contentShape(.capsule)
            // The field's empty part opens the composer too.
            .onTapGesture(perform: open)
            .glassEffect(.regular.interactive(), in: .capsule)
            sendButton
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Reply to \(asker) in \(thread.project.name)")
                .font(.footnote)
                .foregroundStyle(Color.inkSecondary)
            TextField("Write a reply", text: $words, axis: .vertical)
                .font(.body)
                .lineLimit(1...8)
                .focused($focused)
                .accessibilityIdentifier("reply-text")
            HStack(spacing: 6) {
                if !picked.isEmpty { picksChip }
                if annotationCount > 0 { annotationsChip }
                Spacer(minLength: 0)
                sendButton
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 10)
        .padding(.top, 12)
        .padding(.bottom, 10)
        .glassEffect(.regular, in: .rect(cornerRadius: 26))
        .onChange(of: focused) { _, now in
            if !now, words.trimmed.isEmpty { composing = false }
        }
    }

    /// "✓ 2 picks", counting up with a numeric transition when a pick lands.
    private var picksChip: some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark").foregroundStyle(Color.inkSecondary).imageScale(.small)
            Text(plural(picked.count, "pick"))
                .contentTransition(.numericText(value: Double(picked.count)))
                .animation(reduceMotion ? nil : .snappy, value: picked.count)
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(Color.ink)
        .padding(.leading, 9)
        .padding(.trailing, 11)
        .padding(.vertical, 6)
        .background(Color.fill, in: .capsule)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("picks-chip")
    }

    /// "3 annotations": they ride the next Send; a tap lists them (3.6).
    private var annotationsChip: some View {
        Button(action: showAnnotations) {
            HStack(spacing: 6) {
                Image(systemName: "text.bubble").foregroundStyle(Color.inkSecondary).imageScale(.small)
                Text(plural(annotationCount, "annotation"))
                    .contentTransition(.numericText(value: Double(annotationCount)))
                    .animation(reduceMotion ? nil : .snappy, value: annotationCount)
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color.ink)
            .padding(.leading, 9)
            .padding(.trailing, 11)
            .padding(.vertical, 6)
            .background(Color.fill, in: .capsule)
            .contentShape(.capsule)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(plural(annotationCount, "annotation")), ride your next Send")
        .accessibilityIdentifier("annotations-chip")
    }

    private var sendButton: some View {
        Button(action: send) {
            ZStack {
                if sending {
                    ProgressView().tint(canSend ? Color.onTint : Color.ink)
                } else {
                    Image(systemName: "arrow.up").font(.system(size: 19, weight: .bold))
                }
            }
            .foregroundStyle(canSend ? Color.onTint : Color.ink)
            .frame(width: 48, height: 48)
            .contentShape(.circle)
        }
        .buttonStyle(.plain)
        .glassEffect(canSend ? .regular.tint(.tint).interactive() : .regular.interactive(), in: .circle)
        .disabled(sending)
        .accessibilityLabel("Send")
        .accessibilityHint(canSend ? "" : "Pick an answer or write a reply first.")
        .accessibilityIdentifier("send")
    }

    private func open() {
        // The picks are written in as words, as the desktop's Edit the reply does.
        if words.trimmed.isEmpty {
            words = picked.compactMap { q in
                q.answer.map { answer in
                    let words = answer.words
                    let end = words.last.map { ".!?".contains($0) } == true ? "" : "."
                    return "\(q.prompt.replacingOccurrences(of: #"[?.!]\s*$"#, with: "", options: .regularExpression)): \(words)\(end)"
                }
            }.joined(separator: " ")
            if !words.isEmpty { words += " " }
        }
        composing = true
        focused = true
    }

    private func send() {
        guard canSend, !sending else {
            if !canSend { open() }
            return
        }
        sending = true
        problem = nil
        let text = words
        // End editing everywhere: Send itself saves what the cards' fields hold.
        focused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        Task {
            defer { sending = false }
            do throws(InboxError) {
                try await session.send(thread: thread.threadId, words: text)
                Haptics.success()
                words = ""
                focused = false
                composing = false
            } catch {
                Haptics.error()
                problem = switch error {
                case .sendUnconfirmed: session.sendUnconfirmed
                case _ where error.isDefinite: error.message
                default: "Not sent. \(error.message) Tap Send to try again."
                }
            }
        }
    }
}
