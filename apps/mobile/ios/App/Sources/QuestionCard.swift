import InboxCore
import InboxWire
import SwiftUI

/// A question, answered in place (FLOWS 5, mock 4). A tap saves the pick to the computer at once; nothing is sent
/// to the agent until Send. The answers are built by the product's own rules (InboxCore's QuestionAnswers).
struct QuestionCard: View {
  let session: InboxSession
  let thread: ThreadID
  let message: MessageID
  let question: InboxQuestion

  @State private var otherOpen = false
  @State private var otherText = ""
  @State private var noteOpen = false
  @State private var noteText = ""
  @State private var freeText = ""
  @State private var busy = false
  @FocusState private var focus: Field?
  enum Field { case other, note, text }

  private var answer: QuestionAnswer? { question.answer }
  private var live: Bool { question.state == .openValue || question.state == .picked }
  /// Only single, multi and text are answerable; a kind this app does not know is answered on the computer.
  private var known: Bool { [.single, .multi, .text].contains(question.kind) }
  private var enabled: Bool { live && known && session.canAnswer() && !busy }
  private var skipped: Bool { answer?.skipped == true }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      header
      Text(question.prompt)
        .font(.title3.weight(.semibold))
        .foregroundStyle(Token.foreground)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
      ForEach([question.context, question.stakes].compactMap { $0 }.filter { !$0.isEmpty }, id: \.self) { line in
        Text(line).font(.subheadline).foregroundStyle(Token.mutedForeground).fixedSize(horizontal: false, vertical: true)
      }
      if !known {
        Label(PhoneWords.answerOnComputer, systemImage: "desktopcomputer").font(.subheadline).foregroundStyle(Token.mutedForeground)
      } else if question.kind == .text {
        textAnswer
      } else {
        choices
      }
      if known, live || answer?.note != nil { footer }
      status
    }
    .padding(16)
    .background(Token.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Token.border.opacity(0.6)))
    .opacity(live ? 1 : 0.72)
    .onAppear(perform: adopt)
    .onChange(of: question.revision) { _, _ in adopt() }
  }

  /// Take the saved answer's words into the fields, so what the computer holds is what is shown.
  private func adopt() {
    if focus != .other { otherText = answer?.other ?? "" }
    if focus != .note { noteText = answer?.note ?? noteText }
    if focus != .text { freeText = answer?.text ?? "" }
    otherOpen = otherOpen || answer?.other != nil
    noteOpen = noteOpen || answer?.note != nil
  }

  private var header: some View {
    ViewThatFits(in: .horizontal) {
      HStack(alignment: .firstTextBaseline) {
        kindText
        Spacer(minLength: 8)
        marks
      }
      VStack(alignment: .leading, spacing: 4) {
        kindText
        marks
      }
    }
    .font(.subheadline)
    .foregroundStyle(Token.mutedForeground)
  }

  @ViewBuilder private var kindText: some View {
    if let kind = PhoneWords.kind(question.kind) { Text(kind) }
  }

  @ViewBuilder private var marks: some View {
    HStack(spacing: 10) {
      if question.reversible?.value == false { Text(PhoneWords.cantBeUndone).foregroundStyle(Token.warning).fontWeight(.semibold) }
      if !question.holdsUp.isEmpty { Text(PhoneWords.holdingUp(question.holdsUp)) }
    }
  }

  // MARK: Choices

  private var choices: some View {
    VStack(spacing: 0) {
      ForEach(Array(question.choices.enumerated()), id: \.element.label) { index, choice in
        if index > 0 { Divider().overlay(Token.border) }
        ChoiceRow(
          label: choice.label, detail: choice.description, recommended: choice.recommended, multi: question.kind == .multi, selected: answer?.selected.contains(choice.label) == true, enabled: enabled
        ) { tap(choice.label) }
      }
      Divider().overlay(Token.border)
      ChoiceRow(label: PhoneWords.other, detail: nil, recommended: false, multi: question.kind == .multi, selected: answer?.other != nil, enabled: enabled) {
        otherOpen = true
        focus = .other
      }
      if otherOpen, live || answer?.other != nil {
        field(PhoneWords.otherHint, text: $otherText, focus: .other) { commitOther() }
          .padding(.leading, 40)
          .padding(.bottom, 4)
      }
    }
  }

  private var textAnswer: some View {
    field(question.suggestedText ?? PhoneWords.otherHint, text: $freeText, focus: .text) { commitText() }
  }

  private func field(_ hint: String, text: Binding<String>, focus which: Field, commit: @escaping () -> Void) -> some View {
    TextField(hint, text: text, axis: .vertical)
      .lineLimit(1...5)
      .font(.body)
      .focused($focus, equals: which)
      .disabled(!live || !session.canAnswer())
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .frame(minHeight: 44)
      .background(Token.input.opacity(0.5), in: RoundedRectangle(cornerRadius: Token.radius, style: .continuous))
      .toolbar {
        if focus == which {
          ToolbarItemGroup(placement: .keyboard) {
            Spacer()
            Button(PhoneWords.done) { self.focus = nil }.fontWeight(.semibold)
          }
        }
      }
      // Leaving the field saves what is in it: the same write a tap on a choice makes.
      .onChange(of: focus) { before, now in if before == which, now != which { commit() } }
      .accessibilityLabel(hint)
  }

  // MARK: Note, Skip

  private var footer: some View {
    VStack(alignment: .leading, spacing: 8) {
      if noteOpen {
        field(PhoneWords.noteHint, text: $noteText, focus: .note) { commitNote() }
      }
      if live {
        HStack {
          if !noteOpen {
            Button(PhoneWords.addNote) {
              noteOpen = true
              focus = .note
            }
          }
          Spacer()
          Button(skipped ? PhoneWords.undoSkip : PhoneWords.skip) { skipped ? save(nil) : save(QuestionAnswers.skip(question, note: noteText)) }
        }
        .font(.subheadline.weight(.medium))
        .buttonStyle(.borderless)
        .frame(minHeight: 44)
        .disabled(!enabled)
      }
    }
  }

  @ViewBuilder private var status: some View {
    let line: String? = {
      switch question.state {
      case .picked: return skipped ? "\(PhoneWords.skipped) · \(PhoneWords.picked(at: pickedTime))" : PhoneWords.picked(at: pickedTime)
      case .sent: return skipped ? "\(PhoneWords.skipped) · \(PhoneWords.sent)" : PhoneWords.sent
      case .superseded: return PhoneWords.replaced
      default: return nil
      }
    }()
    if let line {
      Text(line).font(.footnote).foregroundStyle(Token.mutedForeground)
    }
  }

  private var pickedTime: String { question.pickedAt.map { TimeWords().when($0) } ?? "" }

  // MARK: The writes

  private func save(_ answer: QuestionAnswer?) {
    guard live, session.canAnswer(), !busy else { return }
    busy = true
    Task {
      await session.pick(thread: thread, message: message, question: question, answer: answer)
      busy = false
    }
  }

  private func tap(_ label: String) {
    let current = answer?.selected ?? []
    var next: [String]
    if question.kind == .multi {
      // Keep the picks in the order the agent listed the choices.
      let chosen = current.contains(label) ? current.filter { $0 != label } : current + [label]
      next = question.choices.map(\.label).filter(chosen.contains)
    } else {
      // A tap on another row moves the pick; a tap on the picked row takes it back.
      next = current == [label] ? [] : [label]
    }
    if next.isEmpty { save(nil) } else { save(QuestionAnswers.choice(question, selected: next, note: noteText)) }
  }

  private func commitOther() {
    let words = otherText.trimmingCharacters(in: .whitespacesAndNewlines)
    if words.isEmpty {
      if answer?.other != nil { save(nil) }
      otherOpen = false
    } else if words != answer?.other {
      save(QuestionAnswers.other(question, other: words, note: noteText))
    }
  }

  private func commitText() {
    let words = freeText.trimmingCharacters(in: .whitespacesAndNewlines)
    if words.isEmpty {
      if answer?.text != nil { save(nil) }
    } else if words != answer?.text {
      save(QuestionAnswers.text(question, text: words, note: noteText))
    }
  }

  /// A note rides the answer it is for: saved with it now when there is one, else with the next pick.
  private func commitNote() {
    let note = noteText.trimmingCharacters(in: .whitespacesAndNewlines)
    if note.isEmpty, answer?.note == nil { noteOpen = false }
    guard let answer, note != (answer.note ?? "") else { return }
    if answer.skipped == true { save(QuestionAnswers.skip(question, note: note)) }
    else if let other = answer.other { save(QuestionAnswers.other(question, other: other, note: note)) }
    else if let text = answer.text { save(QuestionAnswers.text(question, text: text, note: note)) }
    else { save(QuestionAnswers.choice(question, selected: answer.selected, note: note)) }
  }
}

/// One choice: a whole row to tap, 44 points at least.
struct ChoiceRow: View {
  let label: String
  let detail: String?
  let recommended: Bool
  let multi: Bool
  let selected: Bool
  let enabled: Bool
  let action: () -> Void

  private var symbol: String {
    if multi { return selected ? "checkmark.square.fill" : "square" }
    return selected ? "checkmark.circle.fill" : "circle"
  }

  var body: some View {
    Button(action: action) {
      HStack(alignment: .firstTextBaseline, spacing: 12) {
        Image(systemName: symbol)
          .font(.title2)
          .foregroundStyle(selected ? Token.primary : Token.mutedForeground)
          .frame(minWidth: 28)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
              labelText
              badge
            }
            VStack(alignment: .leading, spacing: 2) {
              labelText
              badge
            }
          }
          if let detail, !detail.isEmpty {
            Text(detail).font(.subheadline).foregroundStyle(Token.mutedForeground).multilineTextAlignment(.leading)
          }
        }
        Spacer(minLength: 0)
      }
      .padding(.vertical, 12)
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!enabled)
    .accessibilityElement(children: .combine)
    .accessibilityLabel([label, recommended ? PhoneWords.recommended : nil, detail].compactMap { $0 }.joined(separator: ", "))
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
  }

  private var labelText: some View {
    Text(label).font(.body.weight(.semibold)).foregroundStyle(Token.foreground).multilineTextAlignment(.leading)
  }

  @ViewBuilder private var badge: some View {
    if recommended { Text(PhoneWords.recommended).font(.footnote.weight(.semibold)).foregroundStyle(Token.success) }
  }
}
