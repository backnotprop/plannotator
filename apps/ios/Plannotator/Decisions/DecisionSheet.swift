import PlannotatorKit
import SwiftUI

/// 5.1: "Record as a decision", the desktop's decision card as a sheet.
/// "Decision" is drafted from the answer as it is now, "Why (optional)" as
/// "Asked by <agent>: <question>". Done keeps the words and turns recording
/// on; the decision itself is written when the person sends. Cancel keeps
/// nothing.
struct DecisionSheet: View {
    let question: InboxQuestion
    let session: SourceSession
    let threadId: String
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var reason = ""
    @State private var drafted: (text: String?, reason: String) = (nil, "")
    @State private var saving = false
    @State private var problem: String?
    @Environment(\.dynamicTypeSize) private var typeSize

    private var thread: InboxThread? { session.threads[threadId] }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    heading("Decision")
                    TextField("The decision", text: $text, axis: .vertical)
                        .lineLimit(2...6)
                        .fieldCard()
                        .accessibilityLabel("Decision")
                        .accessibilityIdentifier("decision-text")
                    heading("Why \(Text("(optional)").fontWeight(.regular).foregroundStyle(Color.inkSecondary))")
                        .padding(.top, 12)
                    TextField("Why", text: $reason, axis: .vertical)
                        .lineLimit(2...6)
                        .fieldCard()
                        .accessibilityLabel("Why, optional")
                        .accessibilityIdentifier("decision-reason")
                    Label("In \(thread?.project.name ?? "this project"), when you send", systemImage: "folder")
                        .font(.subheadline)
                        .foregroundStyle(Color.inkSecondary)
                        .padding(.horizontal, 16)
                        .padding(.top, 10)
                    if let problem {
                        Label(problem, systemImage: "exclamationmark.circle.fill")
                            .font(.footnote)
                            .foregroundStyle(Color.destructive)
                            .padding(.horizontal, 16)
                            .accessibilityLabel(problem)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color.ground)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark", role: .cancel) { dismiss() }
                        .tint(Color.ink)
                        .accessibilityIdentifier("decision-cancel")
                }
                ToolbarItem(placement: .principal) {
                    Label("Record as a decision", systemImage: "diamond")
                        .labelStyle(DiamondTitle())
                        .accessibilityAddTraits(.isHeader)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", systemImage: "checkmark", role: .confirm, action: done)
                        .disabled(text.trimmed.isEmpty || saving)
                        .accessibilityIdentifier("decision-done")
                }
            }
        }
        // Medium as the record draws it; full height at the accessibility text sizes, where the fields need the room.
        .presentationDetents(typeSize.isAccessibilitySize ? [.large] : [.medium, .large])
        .presentationBackground(Color.ground)
        .onAppear(perform: draft)
    }

    private func heading(_ text: LocalizedStringKey) -> some View {
        Text(text)
            .font(.headline)
            .foregroundStyle(Color.ink)
            .padding(.horizontal, 16)
    }

    /// The words as the desktop drafts them, from the answer as it is now (a field still being typed included).
    private func draft() {
        let answer = session.drafts[question.id].map { question.applying($0) } ?? question.answer
        let asker = thread?.messages.first { $0.id == question.messageId }?.author.agentName ?? "An agent"
        drafted = (DecisionWords.text(answer), DecisionWords.reason(asker: asker, prompt: question.prompt))
        text = question.decisionDraft?.text ?? drafted.text ?? ""
        reason = question.decisionDraft?.reason ?? drafted.reason
    }

    private func done() {
        saving = true
        problem = nil
        // Unedited words stay the draft, which follows the answer (as the desktop keeps them).
        let keptText = text.trimmed == (drafted.text ?? "") ? nil : text.trimmed
        let keptReason = reason.trimmed == drafted.reason ? nil : reason.trimmed
        let kept = keptText == nil && keptReason == nil ? nil : InboxDecisionDraft(text: keptText, reason: keptReason)
        Task {
            defer { saving = false }
            do throws(InboxError) {
                try await session.keepDecision(question, draft: kept, thread: threadId)
                dismiss()
            } catch {
                Haptics.error()
                problem = error.isDefinite ? error.message : "Not kept. \(error.message) Tap Done to try again."
            }
        }
    }
}

/// The sheet's title: the tinted diamond, then the words (the record's 5.1).
private struct DiamondTitle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 7) {
            configuration.icon.foregroundStyle(Color.tint).imageScale(.small)
            configuration.title.font(.headline).foregroundStyle(Color.ink)
        }
    }
}

private extension View {
    /// A field on its own rounded card, as the record draws the sheet's two fields.
    func fieldCard() -> some View {
        font(.body)
            .foregroundStyle(Color.ink)
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(minHeight: 76, alignment: .topLeading)
            .background(Color.card, in: .rect(cornerRadius: 22))
    }
}
