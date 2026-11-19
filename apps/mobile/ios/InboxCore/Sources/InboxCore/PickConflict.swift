import Foundation
import InboxWire

/// Two places answer one question at nearly the same moment (the phone and a window). The Inbox keeps the save
/// that reaches it first and refuses the other (`question_revision_conflict`, with the revision it holds now).
/// Both end on one answer, quietly: the refusal's words are never shown.
///
/// This is the window's rule, copied (packages/inbox/pickConflict.ts) until the door decides it.
public enum PickConflict {
  /// `PickConflictRule`. Which one is built is the owner's decision, made in pickConflict.ts: this follows it.
  public enum Rule: Sendable { case laterClickWins, firstSaveWins }
  /// `PICK_CONFLICT_RULE`.
  public static let rule: Rule = .laterClickWins
  /// `PICK_CONFLICT_RETRIES`: how many times one answer is saved again over another's, so a question two places
  /// keep changing never loops.
  public static let retries = 2

  public enum Step: Hashable, Sendable {
    /// Save the same answer again at the revision the Inbox holds now.
    case retry(revision: Int64)
    /// Drop it and draw the Inbox's answer.
    case adopt
  }

  /// `conflictRevision`: the revision the Inbox holds now, when the refusal is another answer landing first.
  public static func revision(_ failure: DoorFailure) -> Int64? {
    guard case .refused(_, let error) = failure, error.code == "question_revision_conflict" else { return nil }
    guard case .number(let value)? = error.unknownFields["current_revision"], value >= 0, value.rounded() == value else { return nil }
    return Int64(value)
  }

  /// `onPickConflict`. Nil: not that refusal, or its revision unknown (an older Inbox): the save fails as before.
  public static func step(_ failure: DoorFailure, tries: Int, rule: Rule = PickConflict.rule) -> Step? {
    guard let revision = revision(failure) else { return nil }
    if rule == .firstSaveWins { return .adopt }
    return tries < retries ? .retry(revision: revision) : .adopt
  }

  /// Refusals of a pick that the thread itself says once it is read again (the card draws as sent, replaced or
  /// closed): nothing more is said.
  public static func saysItself(_ code: String) -> Bool {
    ["question_already_sent", "question_superseded", "question_set_aside", "question_revision_conflict"].contains(code)
  }
}
