import PlannotatorKit
import SwiftUI

/// Plannotator's question card at touch size (3.3A): 50-point rows, the whole
/// row is the target, the radio fills with a short spring and the row takes a
/// tint. A pick is saved at once; Send is separate (the reply bar).
struct QuestionCard: View {
    let question: InboxQuestion
    let number: Int
    let total: Int
    let readOnly: Bool
    let session: SourceSession
    let threadId: String
    let onError: (String) -> Void

    private enum Field { case other, note, text }
    @FocusState private var focus: Field?
    @State private var otherOpen = false
    @State private var otherText = ""
    @State private var noteOpen = false
    @State private var noteText = ""
    @State private var freeText = ""
    @ScaledMetric(relativeTo: .body) private var promptSize: CGFloat = 18

    private var locked: Bool { readOnly || question.isSent || question.isClosed }
    private var answer: QuestionAnswer? { question.answer }
    private var base: QuestionAnswer { answer ?? QuestionAnswer(key: question.key, kind: question.kind, prompt: question.prompt) }
    private var status: String { question.status }
    private var selected: [String] {
        status == "answered" || status == "skipped" ? (answer?.selected ?? []) : question.choices.filter(\.settled).map(\.label)
    }
    private var hasOther: Bool { otherOpen || !(answer?.other ?? "").trimmed.isEmpty }
    private var hasNote: Bool { !(answer?.note ?? "").trimmed.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Text(inlineMarkdown(question.prompt))
                .font(.system(size: promptSize, weight: .semibold))
                .foregroundStyle(Color.ink)
                .padding(.horizontal, 2)
                .padding(.top, 8)
            ForEach(contextLines, id: \.self) { line in
                Text(inlineMarkdown(line))
                    .font(.subheadline)
                    .foregroundStyle(Color.inkSecondary)
                    .padding(.horizontal, 2)
                    .padding(.top, 6)
            }
            decisionRow.padding(.top, 10).padding(.bottom, 4)
            if question.kind == "text" {
                textAnswer
            } else {
                ForEach(question.choices, id: \.label) { choiceRow($0) }
                otherRow
            }
            noteArea
            footer
        }
        .padding(.horizontal, 12)
        .padding(.top, 14)
        .padding(.bottom, 6)
        .background(Color.questionCard, in: .rect(cornerRadius: 20))
        .overlay(RoundedRectangle(cornerRadius: 20).strokeBorder(Color.hairline))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Question \(number) of \(total)")
        .accessibilityIdentifier("question-\(question.key)")
        .onAppear {
            otherText = answer?.other ?? ""
            freeText = answer?.text ?? ""
            noteText = answer?.note ?? ""
        }
        // Return ends a field (the fields wrap, so it would otherwise add a line).
        .onChange(of: otherText) { _, text in if text.contains("\n") { otherText = text.replacingOccurrences(of: "\n", with: ""); focus = nil } }
        .onChange(of: noteText) { _, text in if text.contains("\n") { noteText = text.replacingOccurrences(of: "\n", with: ""); focus = nil } }
        .onChange(of: freeText) { _, text in if text.contains("\n") { freeText = text.replacingOccurrences(of: "\n", with: ""); focus = nil } }
        .onChange(of: focus) { old, _ in
            // A field commits when the person leaves it.
            switch old {
            case .other: commitOther()
            case .note: commitNote()
            case .text: commitText()
            case nil: break
            }
        }
    }

    // MARK: Parts

    private var header: some View {
        HStack(spacing: 8) {
            Text("Question \(number) of \(total)".uppercased())
                .font(.caption.weight(.semibold))
                .tracking(0.6)
                .foregroundStyle(Color.inkSecondary)
            Spacer(minLength: 8)
            StatusTag(status: status)
        }
        .padding(.horizontal, 2)
    }

    /// The question's context, then its `Stopped:` and `Holds up:` lines, as the desktop card reads them.
    private var contextLines: [String] {
        var lines: [String] = []
        let context = question.context ?? ""
        if !context.trimmed.isEmpty { lines.append(context) }
        // The parser keeps the block's own lines in the context; add them only when it did not.
        if let stopped = question.stopped, !stopped.trimmed.isEmpty, !context.contains("Stopped:") { lines.append("Stopped: \(stopped)") }
        if !question.holdsUp.isEmpty, !context.contains("Holds up:") {
            let joined = question.holdsUp.joined(separator: "; ")
            lines.append("Holds up: \(joined)\(joined.hasSuffix(".") ? "" : ".")")
        }
        return lines
    }

    /// The decision tag as a real switch (3.1), the small switch the record draws.
    private var decisionRow: some View {
        let on = question.decisionRecording
        let binding = Binding(get: { on }, set: { next in
            Task {
                do throws(InboxError) { try await session.setRecording(question, on: next, thread: threadId) } catch { onError(error.message) }
            }
        })
        return HStack(spacing: 8) {
            Image(systemName: "diamond").foregroundStyle(on ? Color.tint : Color.inkSecondary)
            Text(on ? "Answering this records a decision" : "Record as a decision")
                .font(.subheadline)
                .foregroundStyle(on ? Color.ink : Color.inkSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            Toggle(on ? "Answering this records a decision" : "Record as a decision", isOn: binding)
                .labelsHidden()
                .scaleEffect(0.78)
                .frame(width: 50, height: 26)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(on ? Color.tint.opacity(0.09) : .clear, in: .rect(cornerRadius: 12))
        .overlay { if !on { RoundedRectangle(cornerRadius: 12).strokeBorder(Color.hairline) } }
        .contentShape(.rect(cornerRadius: 12))
        .onTapGesture { if !locked { binding.wrappedValue.toggle() } }
        .disabled(locked)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("decision-\(question.key)")
    }

    private func choiceRow(_ choice: InboxChoice) -> some View {
        let on = selected.contains(choice.label)
        return Button {
            pick(choice.label)
        } label: {
            HStack(spacing: 12) {
                Radio(on: on, square: question.kind == "multi")
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 6) { choiceLabel(choice); if choice.recommended { RecommendedPill() } }
                    VStack(alignment: .leading, spacing: 4) { choiceLabel(choice); if choice.recommended { RecommendedPill() } }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .frame(minHeight: 50)
            .background(on ? Color.tint.opacity(0.12) : .clear, in: .rect(cornerRadius: 14))
            .contentShape(.rect(cornerRadius: 14))
        }
        .buttonStyle(ChoiceStyle())
        .disabled(locked)
        .padding(.top, 2)
        .accessibilityLabel(choice.recommended ? "\(choice.label), recommended" : choice.label)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("choice-\(choice.label)")
    }

    private func choiceLabel(_ choice: InboxChoice) -> some View {
        Text(inlineMarkdown(choice.label))
            .font(.body.weight(.medium))
            .foregroundStyle(Color.ink)
            .multilineTextAlignment(.leading)
    }

    @ViewBuilder private var otherRow: some View {
        let on = hasOther && status == "answered"
        Button {
            otherOpen = true
            focus = .other
        } label: {
            HStack(spacing: 12) {
                Radio(on: on, square: false, dashed: true)
                Text("Other…").font(.body).foregroundStyle(on ? Color.ink : Color.inkSecondary.opacity(0.8))
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .frame(minHeight: 50)
            .background(on ? Color.tint.opacity(0.12) : .clear, in: .rect(cornerRadius: 14))
            .contentShape(.rect(cornerRadius: 14))
        }
        .buttonStyle(ChoiceStyle())
        .disabled(locked)
        .padding(.top, 2)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier("choice-other-\(question.key)")
        if hasOther {
            TextField("Other…", text: $otherText, axis: .vertical)
                .focused($focus, equals: .other)
                .submitLabel(.done)
                .onSubmit { focus = nil }
                .font(.body)
                .padding(.horizontal, 11)
                .padding(.vertical, 9)
                .background(Color.card, in: .rect(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(focus == .other ? Color.tint : Color.hairline))
                .padding(.leading, 46)
                .padding(.trailing, 10)
                .padding(.vertical, 4)
                .disabled(locked)
                .accessibilityLabel("Other answer to question \(number)")
                .accessibilityIdentifier("other-field-\(question.key)")
        }
    }

    private var textAnswer: some View {
        TextField("Your answer", text: $freeText, axis: .vertical)
            .focused($focus, equals: .text)
            .submitLabel(.done)
            .onSubmit { focus = nil }
            .font(.body)
            .padding(.horizontal, 11)
            .padding(.vertical, 10)
            .background(Color.card, in: .rect(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(focus == .text ? Color.tint : Color.hairline))
            .padding(.vertical, 6)
            .disabled(locked)
            .accessibilityLabel("Answer to question \(number)")
    }

    @ViewBuilder private var noteArea: some View {
        if noteOpen {
            TextField("Add a note", text: $noteText, axis: .vertical)
                .focused($focus, equals: .note)
                .submitLabel(.done)
                .onSubmit { focus = nil }
                .font(.subheadline)
                .padding(.horizontal, 11)
                .padding(.vertical, 8)
                .background(Color.card, in: .rect(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.tint))
                .padding(.leading, 46)
                .padding(.trailing, 10)
                .padding(.vertical, 4)
                .accessibilityLabel("Note on question \(number)")
                .accessibilityIdentifier("note-field-\(question.key)")
        } else if let note = answer?.note, !note.trimmed.isEmpty {
            Text("\(Text("Note").fontWeight(.semibold).foregroundStyle(Color.ink)) \(Text(note).foregroundStyle(Color.inkSecondary))")
                .font(.subheadline)
                .padding(.leading, 46)
                .padding(.trailing, 10)
                .padding(.vertical, 4)
        }
    }

    private var footer: some View {
        HStack(spacing: 18) {
            if !locked {
                Button(hasNote ? "Edit note" : "Add note") {
                    noteOpen = true
                    noteText = answer?.note ?? ""
                    focus = .note
                }
                .fixedSize()
                .accessibilityIdentifier("add-note-\(question.key)")
                Button(status == "skipped" ? "Unskip" : "Skip") { toggleSkip() }.fixedSize()
            }
            Spacer(minLength: 0)
            if !locked, status != "answered", question.hasRecommendation {
                Button("Accept recommended") { accept() }
                    .fontWeight(.semibold)
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.horizontal, 13)
                    .padding(.vertical, 6)
                    .background(Color.tint.opacity(0.14), in: .capsule)
                    .accessibilityIdentifier("accept-\(question.key)")
            } else if let line = footerLine {
                Text(line).font(.footnote).foregroundStyle(Color.inkSecondary).multilineTextAlignment(.trailing)
            }
        }
        .font(.subheadline.weight(.medium))
        .foregroundStyle(Color.tint)
        .buttonStyle(.borderless)
        .frame(minHeight: 44)
        .padding(.horizontal, 4)
        .overlay(alignment: .top) { Rectangle().fill(Color.hairline).frame(height: 0.5) }
        .padding(.top, 8)
        .padding(.horizontal, 2)
    }

    /// "Picked 10:51 AM, not sent" or "Sent 10:52 AM" (the desktop's footer).
    private var footerLine: String? {
        if question.isSent {
            let sentAt = session.threads[threadId]?.messages.first { $0.id == question.sentReplyId }?.createdAt
            return sentAt.map { "Sent \(When.clock($0))" } ?? "Sent"
        }
        if question.isPicked, let at = question.pickedAt { return "Picked \(When.clock(at)), not sent" }
        return nil
    }

    // MARK: Picks (each saves at once)

    private func commit(_ next: QuestionAnswer?) {
        session.pick(question, answer: next, thread: threadId, onError: onError)
    }

    private func pick(_ label: String) {
        var next = base
        next.skipped = nil
        if question.kind == "multi" {
            var picked = Set(selected)
            if picked.contains(label) { picked.remove(label) } else { picked.insert(label) }
            next.selected = question.choices.map(\.label).filter(picked.contains)
        } else {
            guard selected != [label] || status != "answered" else { return }
            next.selected = [label]
            next.other = nil
            otherOpen = false
            otherText = ""
        }
        Haptics.selection()
        commit(next)
    }

    private func commitOther() {
        let text = otherText.trimmed
        guard text != (answer?.other ?? "").trimmed else {
            if text.isEmpty { otherOpen = false }
            return
        }
        var next = base
        next.skipped = nil
        next.other = text.isEmpty ? nil : text
        if question.kind != "multi", !text.isEmpty { next.selected = [] }
        if text.isEmpty { otherOpen = false } else { Haptics.selection() }
        commit(next)
    }

    private func commitText() {
        let text = freeText.trimmed
        guard text != (answer?.text ?? "").trimmed else { return }
        var next = base
        next.skipped = nil
        next.text = text.isEmpty ? nil : text
        commit(next)
    }

    private func commitNote() {
        noteOpen = false
        let text = noteText.trimmed
        guard text != (answer?.note ?? "").trimmed else { return }
        var next = base
        next.note = text.isEmpty ? nil : text
        commit(next)
    }

    private func toggleSkip() {
        var next = base
        if status == "skipped" {
            next.skipped = nil
        } else {
            next.selected = []
            next.other = nil
            next.text = nil
            next.skipped = true
            otherOpen = false
            otherText = ""
        }
        Haptics.selection()
        commit(next)
    }

    private func accept() {
        guard let next = question.recommendedAnswer(keeping: base) else { return }
        Haptics.selection()
        if let other = next.other { otherText = other; otherOpen = true }
        commit(next)
    }
}

/// The card's status tag: Open, Answered, Skipped or Settled.
struct StatusTag: View {
    let status: String

    var body: some View {
        Group {
            switch status {
            case "answered": Label("Answered", systemImage: "checkmark").foregroundStyle(Color.success).background(Color.success.opacity(0.14), in: .capsule)
            case "settled": Label("Settled", systemImage: "checkmark").foregroundStyle(Color.success).background(Color.success.opacity(0.14), in: .capsule)
            case "skipped": Text("Skipped").padding(.horizontal, 9).padding(.vertical, 4).foregroundStyle(Color.inkSecondary).overlay(Capsule().strokeBorder(Color.hairline))
            default: Text("Open").padding(.horizontal, 9).padding(.vertical, 4).foregroundStyle(Color.inkSecondary).overlay(Capsule().strokeBorder(Color.hairline))
            }
        }
        .font(.footnote.weight(.semibold))
        .labelStyle(TagLabel())
        .padding(.horizontal, 1)
    }
}

private struct TagLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 5) {
            configuration.icon.imageScale(.small)
            configuration.title
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
    }
}

struct RecommendedPill: View {
    var body: some View {
        Text("Recommended")
            .font(.caption.weight(.semibold))
            .foregroundStyle(Color.tint)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Color.tint.opacity(0.14), in: .rect(cornerRadius: 6))
            .fixedSize()
    }
}

/// The radio (or a multi-choice box) that fills with a short spring when picked;
/// a cross fade under Reduce Motion.
struct Radio: View {
    let on: Bool
    var square = false
    var dashed = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 24

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: square ? size * 0.28 : size / 2)
        ZStack {
            shape.strokeBorder(on ? Color.tint : Color.inkSecondary.opacity(0.55), style: StrokeStyle(lineWidth: 2, dash: dashed ? [3.5, 3] : []))
            if dashed && !on {
                Image(systemName: "plus").font(.system(size: size * 0.45, weight: .semibold)).foregroundStyle(Color.inkSecondary.opacity(0.7))
            }
            if square {
                Image(systemName: "checkmark").font(.system(size: size * 0.5, weight: .bold)).foregroundStyle(Color.tint)
                    .scaleEffect(on ? 1 : 0.3).opacity(on ? 1 : 0)
            } else {
                Circle().fill(Color.tint).frame(width: size * 0.46, height: size * 0.46)
                    .scaleEffect(on ? 1 : 0.3).opacity(on ? 1 : 0)
            }
        }
        .frame(width: size, height: size)
        .animation(reduceMotion ? .easeInOut(duration: 0.15) : .spring(duration: 0.28, bounce: 0.45), value: on)
        .accessibilityHidden(true)
    }
}

/// A pressed choice row darkens a little under the finger (3.3A).
struct ChoiceStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? Color.ink.opacity(0.08) : .clear, in: .rect(cornerRadius: 14))
    }
}
