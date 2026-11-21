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
  /// Pick any: the person's own Other words the suggestion row replaced when ticked, put back when it is unticked.
  var replacedOther: String?
}

/// The cards of a thread that hold typed words: Send saves them all first, so what is on screen is what is sent.
@MainActor
final class ThreadDrafts {
  private var savers: [String: () -> Void] = [:]
  func register(_ id: String, _ save: @escaping () -> Void) { savers[id] = save }
  func remove(_ id: String) { savers[id] = nil }
  func saveAll() { for save in savers.values { save() } }
  /// The reasons typed under a Can't do it or a Deny with a reason, by card, while their field is open. The thread
  /// is built as it scrolls: a card scrolled far away and back is built anew, and opens with its words still there.
  var reasons: [String: String] = [:]
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
  /// Its place among the message's questions: the card's eyebrow, "Question 1 of 2".
  var place: (index: Int, count: Int)?
  let drafts: ThreadDrafts

  @State private var draft = CardDraft()
  @Environment(ScrollBox.self) private var scroll: ScrollBox?
  @Environment(\.cardKey) private var cardKey
  @FocusState private var focus: Field?
  enum Field { case other, note, text }
  /// The choices' mark at this text size: what stands under a row starts in the column of its words (`$side`).
  @MarkSide private var side

  private var answer: QuestionAnswer? { question.answer }
  private var live: Bool { question.state == .openValue || question.state == .picked }
  /// Only single, multi and text are answerable; a kind this app does not know is answered on the computer.
  private var known: Bool { [.single, .multi, .text].contains(question.kind) }
  private var enabled: Bool { live && known && session.canAnswer() }
  private var skipped: Bool { answer?.skipped == true }
  private var id: String { "\(message.rawValue)/\(question.key)" }
  private var picked: [String] { CardAnswers.selected(question) }

  /// The card's parts, top to bottom, each a step quieter than the prompt: where it stands among the questions and
  /// what it holds up; what happened to the pick, if anything, where the person reads first; the prompt; its
  /// context; the answers; the note; where the pick stands; then, under a hairline, what else can be done.
  var body: some View {
    let refusal = session.refusal(message: message, key: question.key)
    let acts = known && live
    VStack(alignment: .leading, spacing: 0) {
      header.lineEdge("head")
      if let refusal {
        // A pick the computer did not take, in the app's own words, where the person reads first (and VoiceOver
        // before the prompt); it stays until they act on this question. A clash with another device's answer
        // never comes here in red: it settles quietly.
        let calm = refusal == .gaveWay
        CardNotice(words: PhoneWords.pickNotice(refusal, computer: session.computer.name), symbol: calm ? "arrow.triangle.2.circlepath" : "exclamationmark.circle", role: calm ? .quiet : .stop)
          .lineEdge("refusal")
          .padding(.top, Space.near)
      }
      Text(question.prompt)
        .font(TextRole.prompt)
        .foregroundStyle(Token.foreground)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
        .lineEdge("prompt")
        .padding(.top, refusal == nil ? Space.close : Space.step)
      ForEach([question.context, question.stakes].compactMap { $0 }.filter { !$0.isEmpty }, id: \.self) { line in
        Text(line).font(TextRole.secondary).foregroundStyle(Token.mutedForeground).fixedSize(horizontal: false, vertical: true).lineEdge("context/\(line)").padding(.top, Space.trim)
      }
      VStack(alignment: .leading, spacing: Space.close) {
        if !known {
          Label(PhoneWords.answerOnComputer, systemImage: "desktopcomputer").font(TextRole.secondary).foregroundStyle(Token.mutedForeground)
        } else if !live {
          settledAnswer.lineEdge("settled")
        } else if question.kind == .text {
          textAnswer
        } else {
          choices
        }
        if acts, draft.noteOpen { noteField }
        status
      }
      .padding(.top, Space.snug)
      if acts {
        Hairline().padding(.top, Space.step)
        footer
      }
    }
    .padding([.top, .horizontal], Space.card)
    // The foot's words stand in a 44-point row that already holds the air under them.
    .padding(.bottom, acts ? Space.tight : Space.card)
    .cardSurface(drafted: live && question.state == .picked && refusal == nil)
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
    .onChange(of: focus) { before, now in
      if before != nil, now != before { save() }
      // A field taken up by any means (a touch, VoiceOver, a keyboard) says which card the person is on.
      if now != nil, let cardKey { scroll?.act(cardKey) }
    }
  }

  /// Take the saved answer's words into the fields that are not being typed in.
  private func adopt() {
    if focus != .other { draft.other = CardAnswers.suggestionPicked(question) ? "" : answer?.other ?? "" }
    if focus != .note { draft.note = answer?.note ?? "" }
    if focus != .text { draft.text = answer?.text ?? "" }
    draft.otherOpen = draft.otherOpen || (answer?.other != nil && !CardAnswers.suggestionPicked(question))
    draft.noteOpen = draft.noteOpen || answer?.note != nil
  }

  private func save() { CardSaver.save(session: session, thread: thread, message: message, key: question.key, draft: draft) }

  private func apply(_ edit: CardAnswers.Edit) {
    if let cardKey { scroll?.act(cardKey) }
    CardSaver.apply(edit, session: session, thread: thread, message: message, question: question)
  }

  private var header: some View {
    ViewThatFits(in: .horizontal) {
      HStack(alignment: .firstTextBaseline) {
        kindText
        Spacer(minLength: Space.close)
        marks
      }
      VStack(alignment: .leading, spacing: Space.tight) {
        kindText
        marks
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .font(TextRole.meta)
    .foregroundStyle(Token.mutedForeground)
  }

  @ViewBuilder private var kindText: some View {
    if let place { Text(PhoneWords.eyebrow(place.index, place.count, multi: question.kind == .multi)).fontWeight(.medium) }
  }

  /// What rides on the answer, said in its role's colour: amber is a caution, and work held up until the person
  /// answers.
  @ViewBuilder private var marks: some View {
    HStack(alignment: .firstTextBaseline, spacing: Space.near) {
      if question.reversible?.value == false { Text(PhoneWords.cantBeUndone).foregroundStyle(Role.caution.ink).fontWeight(.semibold) }
      // Amber while the answer is still wanted; a settled card (sent, replaced) holds nothing up any more.
      if !question.holdsUp.isEmpty { RoleLine(words: PhoneWords.holdingUp(question.holdsUp), role: live ? .hold : .quiet) }
    }
  }

  // MARK: Choices

  private var choices: some View {
    VStack(alignment: .leading, spacing: Space.hair) {
      ForEach(Array(question.choices.enumerated()), id: \.element.label) { index, choice in
        ChoiceRow(label: choice.label, detail: choice.description, recommended: choice.recommended, multi: question.kind == .multi, selected: picked.contains(choice.label), enabled: enabled) {
          apply(CardAnswers.tap(question, label: choice.label))
        }
        .lineEdge("choice/\(index)")
      }
      if let suggestion = CardAnswers.suggestion(of: question) {
        // The agent's own answer that is none of its choices: a row of its own, as in the window.
        ChoiceRow(label: suggestion, detail: nil, recommended: true, multi: question.kind == .multi, selected: CardAnswers.suggestionPicked(question), enabled: enabled) {
          let picked = CardAnswers.suggestionPicked(question)
          if !picked {
            let own = answer?.other ?? ""
            draft.replacedOther = own.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : own
          }
          apply(CardAnswers.tapSuggestion(question, replaced: draft.replacedOther))
          if picked { draft.replacedOther = nil }
        }
        .lineEdge("suggestion")
      }
      ChoiceRow(label: PhoneWords.other, detail: nil, recommended: false, multi: question.kind == .multi, selected: !(answer?.other ?? "").isEmpty && !CardAnswers.suggestionPicked(question), enabled: enabled, value: CardAnswers.suggestionPicked(question) ? nil : answer?.other, open: true) {
        draft.otherOpen = true
        focus = .other
      }
      .lineEdge("other")
      if draft.otherOpen {
        // Under the row it belongs to, in the column of its words.
        field(PhoneWords.otherHint, text: Bindable(draft).other, focus: .other)
          .lineEdge("otherField")
          .padding(.leading, $side)
          .padding(.top, Space.tight)
      }
    }
  }

  private var textAnswer: some View {
    VStack(alignment: .leading, spacing: Space.close) {
      // The agent's suggestion is said as one, never drawn as if it were already typed.
      if let suggested = question.suggestedText, !suggested.isEmpty {
        HStack(alignment: .firstTextBaseline, spacing: Space.close) {
          Chip(words: PhoneWords.recommended, tone: .accent)
          Text(suggested).font(TextRole.secondary).foregroundStyle(Token.foreground).fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(PhoneWords.recommended): \(suggested)")
        .lineEdge("suggested")
      }
      field(PhoneWords.answerHint, text: Bindable(draft).text, focus: .text).lineEdge("textField")
    }
  }

  /// A card that is settled (sent, replaced, closed) shows what was answered as words, with nothing to tap.
  private var settledAnswer: some View {
    VStack(alignment: .leading, spacing: Space.close) {
      if skipped {
        answered(PhoneWords.skipped, symbol: "arrow.uturn.right", quiet: true)
      }
      ForEach(answer?.selected ?? [], id: \.self) { label in
        answered(label, symbol: "checkmark")
      }
      ForEach([answer?.other, answer?.text].compactMap { $0 }.filter { !$0.isEmpty }, id: \.self) { words in
        answered(words, symbol: "checkmark")
      }
      if let note = answer?.note, !note.isEmpty {
        Text("\(PhoneWords.note): \(note)").font(TextRole.secondary).foregroundStyle(Token.mutedForeground).padding(.leading, $side)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// One answered line: its tick stands where the choices' marks stood, its words where theirs did.
  private func answered(_ words: String, symbol: String, quiet: Bool = false) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: Space.step) {
      Image(systemName: symbol).font(.system(size: side * 0.68, weight: .bold)).foregroundStyle(quiet ? Token.mutedForeground : Role.done.ink).frame(width: side).accessibilityHidden(true)
      Text(words).font(TextRole.label).foregroundStyle(quiet ? Token.mutedForeground : Token.foreground).fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .combine)
  }

  private func field(_ hint: String, text: Binding<String>, focus which: Field) -> some View {
    TextField(hint, text: text, axis: .vertical)
      .lineLimit(1...5)
      .font(TextRole.body)
      .focused($focus, equals: which)
      .disabled(!enabled)
      .padding(.horizontal, Space.step)
      .padding(.vertical, Space.near)
      .frame(minHeight: Space.touch)
      .fieldGround(focused: focus == which)
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

  private var noteField: some View {
    VStack(alignment: .leading, spacing: Space.trim) {
      Text(PhoneWords.note).font(TextRole.metaStrong).foregroundStyle(Token.mutedForeground).accessibilityHidden(true)
      field(PhoneWords.noteHint, text: Bindable(draft).note, focus: .note).lineEdge("noteField")
    }
    .padding(.top, Space.tight)
  }

  /// What else can be done with the question, in one row: the quiet ways on the left, the agent's own answer, when
  /// it has one, as the one tinted button on the right. One under the other when the words are too large.
  private var footer: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 0) { footerButtons(spread: true) }
      VStack(alignment: .leading, spacing: 0) { footerButtons(spread: false) }
    }
    .buttonStyle(PressStyle())
    .disabled(!enabled)
    .lineEdge("footer")
  }

  @ViewBuilder private func footerButtons(spread: Bool) -> some View {
    Button {
      draft.noteOpen.toggle()
      focus = draft.noteOpen ? .note : nil
    } label: {
      quietWords(draft.noteOpen ? PhoneWords.hideNote : PhoneWords.addNote, whole: spread)
    }
    Button {
      save()
      if let now = CardSaver.current(session: session, thread: thread, message: message, key: question.key) {
        CardSaver.apply(CardAnswers.toggleSkip(now), session: session, thread: thread, message: message, question: now)
      }
    } label: {
      quietWords(skipped ? PhoneWords.undoSkip : PhoneWords.skip, leading: spread ? Space.page : 0, whole: spread)
    }
    if spread { Spacer(minLength: Space.step) }
    if CardAnswers.offersAccept(question) {
      Button {
        draft.replacedOther = nil
        apply(CardAnswers.acceptRecommended(question))
      } label: {
        Text(PhoneWords.acceptRecommended)
          .fixedSize(horizontal: spread, vertical: true)
          .font(TextRole.link)
          .foregroundStyle(Token.primary)
          .padding(.horizontal, Space.step)
          .frame(minHeight: Size.capsule)
          .background(Token.primary.opacity(0.14), in: Capsule())
          .touchTarget()
      }
    }
  }

  /// Words alone to touch: the air before them is theirs to touch too, and the whole is 44 points at least. In
  /// the one row they are `whole`: never squeezed onto two lines there (when they do not fit whole, the row gives
  /// way to one under the other, where they may wrap).
  private func quietWords(_ words: String, leading: CGFloat = 0, whole: Bool) -> some View {
    // In the foreground, as in the window: the accent in this row is the agent's own answer alone.
    Text(words).font(TextRole.link).foregroundStyle(Token.foreground).fixedSize(horizontal: whole, vertical: true).padding(.leading, leading).touchTarget()
  }

  @ViewBuilder private var status: some View {
    let line: String? = {
      // The pick gave way: the line over the choices says whose answer is shown; "in your draft" would name it as
      // the person's own.
      if session.refusal(message: message, key: question.key) == .gaveWay { return nil }
      let held = session.isHeldPick(message: message, key: question.key)
      switch question.state {
      case .picked:
        let time = question.pickedAt.map { TimeWords().when($0) } ?? ""
        let words = held ? PhoneWords.pickedOnPhone : PhoneWords.picked(at: time)
        return skipped ? "\(PhoneWords.skipped) · \(words)" : words
      case .sent:
        // An answer in a Send that waits for the computer is not sent yet: say what it waits for.
        if session.isHeldSend(message: message, key: question.key) { return PhoneWords.willSendWhenBack(session.computer.name) }
        return PhoneWords.sent(at: sentAt.map { TimeWords().when($0) } ?? "")
      case .superseded: return PhoneWords.replaced
      default: return nil
      }
    }()
    if let line {
      Text(line).font(TextRole.meta).foregroundStyle(Token.mutedForeground).lineEdge("status").padding(.top, Space.tight)
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
    // The words are stored as typed, as the window stores them.
    guard let question = current(session: session, thread: thread, message: message, key: key), question.state == .openValue || question.state == .picked else { return }
    if question.kind == .text {
      if draft.text != question.answer?.text ?? "" { apply(CardAnswers.text(question, words: draft.text), session: session, thread: thread, message: message, question: question) }
    } else if draft.otherOpen {
      // The Other field's own words: the agent's suggestion, when its row is picked, is not the field's.
      let stored = CardAnswers.suggestionPicked(question) ? "" : question.answer?.other ?? ""
      if draft.other != stored { apply(CardAnswers.other(question, words: draft.other), session: session, thread: thread, message: message, question: question) }
    }
    // The note is read against the answer as it stands after the words above.
    guard let now = current(session: session, thread: thread, message: message, key: key) else { return }
    if draft.note != now.answer?.note ?? "" { apply(CardAnswers.note(now, words: draft.note), session: session, thread: thread, message: message, question: now) }
  }
}
