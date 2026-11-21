import Foundation
import InboxWire

/// What a touch on a question card makes of its answer: the rules of the window's in-thread card
/// (packages/ui/components/blocks/QuestionBlock.tsx:588-663: `commit`, `pick`, `setOther`, `setText`, `setNote`,
/// `toggleSkip`), with `isQuestionAnswerEmpty` (packages/core/question-block.ts:1743-1749).
///
/// These rules are not in the contract yet: they live in a React component and no vector holds them, and they
/// differ from packages/core/inbox-answers.ts (QuestionAnswers here), which the window's decision mode uses. On a
/// pick-any question the card keeps the ticks and the "Other…" words together; inbox-answers clears one for the
/// other. Until the card's rule is in core with vectors, this file is a copy, and is marked so.
public enum CardAnswers {
  public enum Edit: Hashable, Sendable {
    /// The touch changes nothing: no write.
    case nothing
    /// Save this answer (nil takes the answer back: nothing is left worth keeping).
    case save(QuestionAnswer?)
  }

  static func answered(_ answer: QuestionAnswer) -> Bool {
    !answer.selected.isEmpty || !QuestionAnswers.jsTrim(answer.other ?? "").isEmpty || !QuestionAnswers.jsTrim(answer.text ?? "").isEmpty
  }

  /// Nothing worth keeping: not answered, not skipped, no note.
  static func empty(_ answer: QuestionAnswer) -> Bool {
    !answered(answer) && answer.skipped != true && QuestionAnswers.jsTrim(answer.note ?? "").isEmpty
  }

  private static func commit(_ question: InboxQuestion, _ next: QuestionAnswer) -> Edit {
    let value: QuestionAnswer? = empty(next) ? nil : next
    return value == question.answer ? .nothing : .save(value)
  }

  /// The labels that count as picked: the answer's, else the choices the agent marked settled.
  public static func selected(_ question: InboxQuestion) -> [String] {
    if let answer = question.answer, answered(answer) || answer.skipped == true { return answer.selected }
    return question.choices.filter(\.settled).map(\.label)
  }

  /// A tap on a choice. Pick any: the row toggles, in the agent's order, and "Other…" words stay. Pick one: the
  /// pick moves to the row and "Other…" goes; a tap on the picked row does nothing.
  public static func tap(_ question: InboxQuestion, label: String) -> Edit {
    var next = QuestionAnswers.base(question)
    next.skipped = nil
    let current = selected(question)
    if question.kind == .multi {
      let chosen = current.contains(label) ? current.filter { $0 != label } : current + [label]
      let order = question.choices.map(\.label)
      next.selected = chosen.sorted { (order.firstIndex(of: $0) ?? -1) < (order.firstIndex(of: $1) ?? -1) }
      return commit(question, next)
    }
    // A radio that is already checked (the person's pick, or a choice the agent marked settled) does nothing.
    if current.contains(label) { return .nothing }
    next.other = nil
    next.selected = [label]
    return commit(question, next)
  }

  /// Words typed under "Other…". Pick any keeps the ticks; pick one gives them up once there are words.
  public static func other(_ question: InboxQuestion, words: String) -> Edit {
    var next = QuestionAnswers.base(question)
    next.skipped = nil
    if question.kind == .multi { next.selected = selected(question) } else if !QuestionAnswers.jsTrim(words).isEmpty { next.selected = [] }
    next.other = words.isEmpty ? nil : words
    return commit(question, next)
  }

  /// A free-text answer.
  public static func text(_ question: InboxQuestion, words: String) -> Edit {
    var next = QuestionAnswers.base(question)
    next.skipped = nil
    next.text = words.isEmpty ? nil : words
    return commit(question, next)
  }

  /// A note beside the answer; it stands on its own too.
  public static func note(_ question: InboxQuestion, words: String) -> Edit {
    var next = QuestionAnswers.base(question)
    next.note = words.isEmpty ? nil : words
    return commit(question, next)
  }

  /// Skip, or Unskip. Skip gives up the answer and keeps the note; Unskip removes only the skip.
  public static func toggleSkip(_ question: InboxQuestion) -> Edit {
    var next = QuestionAnswers.base(question)
    if next.skipped == true {
      next.skipped = nil
    } else {
      next.other = nil
      next.text = nil
      next.selected = []
      next.skipped = true
    }
    return commit(question, next)
  }

  // MARK: The agent's own suggested answer, and Accept recommended

  /// The agent's recommended answer that is none of its choices: one more row after the choices
  /// (QuestionBlock.tsx:612-635, `pickSuggestion`).
  public static func suggestion(of question: InboxQuestion) -> String? {
    guard question.kind != .text, let text = question.suggestedText, !text.isEmpty else { return nil }
    return text
  }

  /// The suggestion row reads as picked when the "Other…" answer is exactly the agent's text.
  public static func suggestionPicked(_ question: InboxQuestion) -> Bool {
    guard let text = suggestion(of: question) else { return false }
    return question.answer?.other == text
  }

  /// A tap on the suggestion row: it is stored as the "Other…" answer. Pick any: it toggles beside the ticks, and
  /// unticking puts back the person's own Other words it replaced. Pick one: it takes the pick; a tap on it when
  /// picked does nothing.
  public static func tapSuggestion(_ question: InboxQuestion, replaced: String? = nil) -> Edit {
    guard let text = suggestion(of: question) else { return .nothing }
    var next = QuestionAnswers.base(question)
    next.skipped = nil
    let picked = suggestionPicked(question)
    if question.kind == .multi {
      next.selected = selected(question)
      next.other = picked ? replaced : text
      return commit(question, next)
    }
    if picked { return .nothing }
    next.selected = []
    next.other = text
    return commit(question, next)
  }

  /// The answer the question's recommendation stands for (`recommendedQuestionAnswer`,
  /// packages/core/question-block.ts:1781-1794), keeping the person's own Other words on a pick-any question.
  public static func acceptRecommended(_ question: InboxQuestion) -> Edit {
    var next = QuestionAnswers.base(question)
    let kept = question.kind == .multi ? next.other : nil
    next.skipped = nil
    next.other = nil
    next.text = nil
    let labels = question.choices.filter(\.recommended).map(\.label)
    if !labels.isEmpty {
      next.selected = labels
      if let kept, !QuestionAnswers.jsTrim(kept).isEmpty { next.other = kept }
    } else if let text = question.suggestedText, !text.isEmpty {
      next.selected = []
      if question.kind == .text { next.text = text } else { next.other = text }
    } else {
      return .nothing
    }
    return commit(question, next)
  }

  /// Whether the card offers Accept recommended (QuestionBlock.tsx:562-580): while nothing is answered; and on a
  /// pick-any question whose recommendation names choices, until the ticks are exactly those choices.
  public static func offersAccept(_ question: InboxQuestion) -> Bool {
    let labels = question.choices.filter(\.recommended).map(\.label)
    guard !labels.isEmpty || !(question.suggestedText ?? "").isEmpty else { return false }
    let isAnswered = question.answer.map(answered) == true
    let settled = !isAnswered && question.answer?.skipped != true && question.choices.contains(where: \.settled)
    if settled { return false }
    if !isAnswered { return true }
    guard question.kind == .multi, !labels.isEmpty, !question.choices.contains(where: \.settled) else { return false }
    return Set(question.answer?.selected ?? []) != Set(labels)
  }
}
