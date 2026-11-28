import Foundation
import InboxWire

/// The answer a person's tap or typed words make for an agent's question, and the body that saves it
/// (`POST messages/:id/picks`). The rules are the product's own (packages/core/inbox-answers.ts);
/// apps/mobile/contract/vectors/questions.json holds them to it.
public enum QuestionAnswers {
  /// `MAX_QUESTION_PROMPT_CHARS` (packages/core/question-block.ts).
  static let maxPromptCharacters = 400

  /// An answer's copy of its question's prompt, cut between characters (never inside an emoji).
  static func capPrompt(_ prompt: String) -> String {
    // The product counts UTF-16 units and never splits a grapheme: keep whole characters while they fit.
    var out = ""
    var units = 0
    for character in prompt {
      let size = character.utf16.count
      if units + size > maxPromptCharacters { break }
      out.append(character)
      units += size
    }
    return out
  }

  /// The answer kind a question takes (an action item takes none: it is marked, not answered).
  static func answerKind(_ question: InboxQuestion) -> QuestionKind {
    switch question.kind {
    case .multi: return .multi
    case .text: return .text
    default: return .single
    }
  }

  /// Two answers say the same thing to the agent: the same choices (in any order), the same words. No answer and
  /// a taken-back one are the same too.
  public static func same(_ one: QuestionAnswer?, _ other: QuestionAnswer?) -> Bool {
    func words(_ value: String?) -> String { jsTrim(value ?? "") }
    guard let one, let other else { return one == nil && other == nil }
    return Set(one.selected) == Set(other.selected) && words(one.other) == words(other.other) && words(one.text) == words(other.text)
      && words(one.note) == words(other.note) && (one.skipped ?? false) == (other.skipped ?? false)
  }

  /// An answer to build on: the saved one, else empty.
  public static func base(_ question: InboxQuestion) -> QuestionAnswer {
    question.answer ?? QuestionAnswer(v: 1, key: question.key, kind: answerKind(question), prompt: capPrompt(question.prompt), selected: [])
  }

  static func noted(_ answer: inout QuestionAnswer, _ note: String) {
    let trimmed = jsTrim(note)
    answer.note = trimmed.isEmpty ? nil : trimmed
  }

  public static func choice(_ question: InboxQuestion, selected: [String], note: String) -> QuestionAnswer {
    var answer = base(question)
    answer.other = nil
    answer.text = nil
    answer.skipped = nil
    answer.byReply = nil
    answer.selected = selected
    noted(&answer, note)
    return answer
  }

  public static func other(_ question: InboxQuestion, other: String, note: String) -> QuestionAnswer {
    var answer = base(question)
    answer.text = nil
    answer.skipped = nil
    answer.byReply = nil
    answer.selected = []
    answer.other = jsTrim(other)
    noted(&answer, note)
    return answer
  }

  public static func text(_ question: InboxQuestion, text: String, note: String) -> QuestionAnswer {
    var answer = base(question)
    answer.other = nil
    answer.skipped = nil
    answer.byReply = nil
    answer.selected = []
    answer.text = jsTrim(text)
    noted(&answer, note)
    return answer
  }

  public static func skip(_ question: InboxQuestion, note: String) -> QuestionAnswer {
    var answer = base(question)
    answer.other = nil
    answer.text = nil
    answer.byReply = nil
    answer.selected = []
    answer.skipped = true
    noted(&answer, note)
    return answer
  }

  /// What saving one answer posts (nil takes the answer back). The door adds nothing but the key.
  public static func pickBody(key: String, revision: Int64, answer: QuestionAnswer?, unsentOnly: Bool = false, confirmFull: Bool = false, idempotencyKey: String) -> DoorPicksBody {
    DoorPicksBody(
      questions: [DoorPicksBodyQuestionsItem(key: key, revision: revision, answer: answer)],
      unsentOnly: unsentOnly ? true : nil,
      confirmFull: confirmFull ? true : nil,
      idempotencyKey: idempotencyKey)
  }

  /// JavaScript's `String.prototype.trim`: its white space and line terminators, both ends (not U+0085).
  static let jsSpace: Set<Unicode.Scalar> = {
    var set: Set<Unicode.Scalar> = ["\u{9}", "\u{A}", "\u{B}", "\u{C}", "\u{D}", " ", "\u{A0}", "\u{1680}", "\u{2028}", "\u{2029}", "\u{202F}", "\u{205F}", "\u{3000}", "\u{FEFF}"]
    for value in 0x2000...0x200A { set.insert(Unicode.Scalar(value)!) }
    return set
  }()

  static func jsTrim(_ text: String) -> String {
    var scalars = Substring.UnicodeScalarView(text.unicodeScalars)
    while let first = scalars.first, jsSpace.contains(first) { scalars.removeFirst() }
    while let last = scalars.last, jsSpace.contains(last) { scalars.removeLast() }
    return String(scalars)
  }
}
