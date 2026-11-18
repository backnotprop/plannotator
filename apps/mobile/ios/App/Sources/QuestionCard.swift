import InboxCore
import InboxWire
import Observation
import SwiftUI

/// What the person has typed on one card and not yet saved. A reference, so Send can save it before it posts.
@MainActor
@Observable
final class CardDraft {
  var other = ""
  var text = ""
  var note = ""
  var otherOpen = false
  var noteOpen = false
}

/// The cards of a thread that hold typed words: Send saves them all first, so what is on screen is what is sent.
@MainActor
final class ThreadDrafts {
  private var savers: [String: () -> Void] = [:]
  func register(_ id: String, _ save: @escaping () -> Void) { savers[id] = save }
  func remove(_ id: String) { savers[id] = nil }
  func saveAll() { for save in savers.values { save() } }
}

/// A question, answered in place (FLOWS 5, mock 4). A touch saves the pick to the computer at once; nothing is
/// sent to the agent until Send. The answers follow the window's card (InboxCore's CardAnswers).
struct QuestionCard: View {
  let session: InboxSession
  let thread: ThreadID
  let message: MessageID
  let question: InboxQuestion
  /// When the reply that sent this answer was written.
  var sentAt: String?
  let drafts: ThreadDrafts

  @State private var draft = CardDraft()
  @FocusState private var focus: Field?
  enum Field { case other, note, text }

  private var answer: QuestionAnswer? { question.answer }
  private var live: Bool { question.state == .openValue || question.state == .picked }
  /// Only single, multi and text are answerable; a kind this app does not know is answered on the computer.
  private var known: Bool { [.single, .multi, .text].contains(question.kind) }
  private var enabled: Bool { live && known && session.canAnswer() }
  private var skipped: Bool { answer?.skipped == true }
  private var id: String { "\(message.rawValue)/\(question.key)" }
  private var picked: [String] { CardAnswers.selected(question) }

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
    .accessibilityElement(children: .contain)
    .onAppear {
      adopt()
      let (session, thread, message, key, draft) = (session, thread, message, question.key, draft)
      drafts.register(id) { CardSaver.save(session: session, thread: thread, message: message, key: key, draft: draft) }
    }
    .onDisappear { drafts.remove(id) }
    .onChange(of: question.revision) { _, _ in adopt() }
    // Typed words save themselves after a pause of half a second, as in the window, and when the field is left.
    .task(id: [draft.other, draft.text, draft.note]) {
      try? await Task.sleep(for: .milliseconds(500))
      if !Task.isCancelled { save() }
    }
    .onChange(of: focus) { before, now in if before != nil, now != before { save() } }
  }

  /// Take the saved answer's words into the fields that are not being typed in.
  private func adopt() {
    if focus != .other { draft.other = answer?.other ?? "" }
    if focus != .note { draft.note = answer?.note ?? "" }
    if focus != .text { draft.text = answer?.text ?? "" }
    draft.otherOpen = draft.otherOpen || answer?.other != nil
    draft.noteOpen = draft.noteOpen || answer?.note != nil
  }

  private func save() { CardSaver.save(session: session, thread: thread, message: message, key: question.key, draft: draft) }

  private func apply(_ edit: CardAnswers.Edit) { CardSaver.apply(edit, session: session, thread: thread, message: message, question: question) }

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
        ChoiceRow(label: choice.label, detail: choice.description, recommended: choice.recommended, multi: question.kind == .multi, selected: picked.contains(choice.label), enabled: enabled) {
          apply(CardAnswers.tap(question, label: choice.label))
        }
      }
      Divider().overlay(Token.border)
      ChoiceRow(label: PhoneWords.other, detail: nil, recommended: false, multi: question.kind == .multi, selected: !(answer?.other ?? "").isEmpty, enabled: enabled, value: answer?.other) {
        draft.otherOpen = true
        focus = .other
      }
      if draft.otherOpen, live || answer?.other != nil {
        field(PhoneWords.otherHint, text: Bindable(draft).other, focus: .other)
          .padding(.leading, 40)
          .padding(.bottom, 4)
      }
    }
  }

  private var textAnswer: some View {
    VStack(alignment: .leading, spacing: 8) {
      // The agent's suggestion is said as one, never drawn as if it were already typed.
      if let suggested = question.suggestedText, !suggested.isEmpty {
        Text("\(PhoneWords.recommended): \(suggested)").font(.subheadline).foregroundStyle(Token.mutedForeground)
      }
      field(PhoneWords.answerHint, text: Bindable(draft).text, focus: .text)
    }
  }

  private func field(_ hint: String, text: Binding<String>, focus which: Field) -> some View {
    TextField(hint, text: text, axis: .vertical)
      .lineLimit(1...5)
      .font(.body)
      .focused($focus, equals: which)
      .disabled(!enabled)
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
      .accessibilityLabel(hint)
  }

  // MARK: Note, Skip

  private var footer: some View {
    VStack(alignment: .leading, spacing: 6) {
      if draft.noteOpen {
        Text(PhoneWords.note).font(.footnote.weight(.semibold)).foregroundStyle(Token.mutedForeground).accessibilityHidden(true)
        field(PhoneWords.noteHint, text: Bindable(draft).note, focus: .note)
      }
      if live {
        HStack {
          Button(draft.noteOpen ? PhoneWords.hideNote : PhoneWords.addNote) {
            draft.noteOpen.toggle()
            focus = draft.noteOpen ? .note : nil
          }
          Spacer()
          Button(skipped ? PhoneWords.undoSkip : PhoneWords.skip) {
            save()
            if let now = CardSaver.current(session: session, thread: thread, message: message, key: question.key) {
              CardSaver.apply(CardAnswers.toggleSkip(now), session: session, thread: thread, message: message, question: now)
            }
          }
        }
        .font(.subheadline.weight(.medium))
        .buttonStyle(.borderless)
        .frame(minHeight: 44)
        .disabled(!enabled)
      }
    }
  }

  @ViewBuilder private var status: some View {
    if let refusal = session.refusal(message: message, key: question.key) {
      // The Inbox's own words for why the pick was not taken; it stays until the person acts on this question.
      Label(PhoneWords.notice(refusal, computer: session.computer.name), systemImage: "exclamationmark.circle")
        .font(.footnote)
        .foregroundStyle(Token.destructive)
    }
    let line: String? = {
      let held = session.isHeldPick(message: message, key: question.key)
      switch question.state {
      case .picked:
        let words = held ? PhoneWords.pickedOnPhone : PhoneWords.picked(at: question.pickedAt.map { TimeWords().when($0) } ?? "")
        return skipped ? "\(PhoneWords.skipped) · \(words)" : words
      case .sent:
        let words = PhoneWords.sent(at: sentAt.map { TimeWords().when($0) } ?? "")
        return skipped ? "\(PhoneWords.skipped) · \(words)" : words
      case .superseded: return PhoneWords.replaced
      default: return nil
      }
    }()
    if let line {
      Text(line).font(.footnote).foregroundStyle(Token.mutedForeground)
    }
  }
}

/// Saving a card's typed words: the same writes a touch makes, built from what the computer (and the outbox)
/// hold at the moment of saving.
@MainActor
enum CardSaver {
  static func current(session: InboxSession, thread: ThreadID, message: MessageID, key: String) -> InboxQuestion? {
    session.thread(thread)?.thread.messages.first { $0.id == message }?.questions?.first { $0.key == key }
  }

  static func apply(_ edit: CardAnswers.Edit, session: InboxSession, thread: ThreadID, message: MessageID, question: InboxQuestion) {
    guard case .save(let answer) = edit, question.state == .openValue || question.state == .picked else { return }
    // In the outbox before anything else runs, then on its way.
    guard session.hold(pick: answer, thread: thread, message: message, question: question) else { return }
    Task { await session.deliverHeld(thread: thread) }
  }

  static func save(session: InboxSession, thread: ThreadID, message: MessageID, key: String, draft: CardDraft) {
    let trim = { (text: String) in text.trimmingCharacters(in: .whitespacesAndNewlines) }
    guard let question = current(session: session, thread: thread, message: message, key: key) else { return }
    if question.kind == .text {
      if trim(draft.text) != trim(question.answer?.text ?? "") { apply(CardAnswers.text(question, words: trim(draft.text)), session: session, thread: thread, message: message, question: question) }
    } else if draft.otherOpen, trim(draft.other) != trim(question.answer?.other ?? "") {
      apply(CardAnswers.other(question, words: trim(draft.other)), session: session, thread: thread, message: message, question: question)
    }
    // The note is read against the answer as it stands after the words above.
    guard let now = current(session: session, thread: thread, message: message, key: key) else { return }
    if trim(draft.note) != trim(now.answer?.note ?? "") { apply(CardAnswers.note(now, words: trim(draft.note)), session: session, thread: thread, message: message, question: now) }
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
  /// What VoiceOver reads as the row's value (the words typed under "Other…").
  var value: String?
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
    // A settled card keeps its words at full contrast: only the touch is off.
    .buttonStyle(ChoiceStyle())
    .allowsHitTesting(enabled)
    .accessibilityElement(children: .combine)
    .accessibilityLabel([label, recommended ? PhoneWords.recommended : nil, detail].compactMap { $0 }.joined(separator: ", "))
    .accessibilityValue(value ?? "")
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
  }

  private var labelText: some View {
    Text(label).font(.body.weight(.semibold)).foregroundStyle(Token.foreground).multilineTextAlignment(.leading)
  }

  @ViewBuilder private var badge: some View {
    if recommended { Text(PhoneWords.recommended).font(.footnote.weight(.semibold)).foregroundStyle(Token.success) }
  }
}

struct ChoiceStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.opacity(configuration.isPressed ? 0.6 : 1)
  }
}
