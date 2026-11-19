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
    // TODO(contract): "typed door error fields" (`current_revision`).
    guard case .number(let value)? = error.unknownFields["current_revision"], value >= 0, value.rounded() == value else { return nil }
    return Int64(value)
  }

  /// `onPickConflict`. Nil: not that refusal, or its revision unknown (an older Inbox): the save fails as before.
  public static func step(_ failure: DoorFailure, tries: Int, rule: Rule = PickConflict.rule) -> Step? {
    guard let revision = revision(failure) else { return nil }
    if rule == .firstSaveWins { return .adopt }
    return tries < retries ? .retry(revision: revision) : .adopt
  }

  public enum Outcome: Hashable, Sendable {
    case retry(revision: Int64)
    /// The window's own end: the Inbox's answer is drawn, quietly.
    case adopt
    /// The phone's pick is older than the answer the Inbox holds: that answer stays, and the person is told.
    case giveWay
    /// A waited pick was refused every time it went again, and the Inbox holds no answer: it is dropped, and the
    /// person is told it was not saved, never left to think it was.
    case lost
  }

  /// The phone's own rule, on top of the window's. The window takes the order saves reach the Inbox for the order
  /// of the clicks. A pick that waited on the phone while the computer was away breaks that, so for such a pick
  /// the times decide: it gives way only when the Inbox holds an answer picked AFTER the person tapped. The tap's
  /// time is the phone's clock at the tap; the other answer's is the Inbox's own `picked_at`. With no answer in
  /// the Inbox (another device picked and took it back) there is nothing to give way to, and the pick is saved.
  /// An answer whose time the Inbox does not give is taken as newer: the Inbox's order stands where the phone
  /// cannot show its own is later. A pick that never waited follows the window's rule alone.
  public static func decide(_ failure: DoorFailure, tries: Int, waited: Bool, tapped: Date, inboxAnswered: Bool, inboxPickedAt: Date?, rule: Rule = PickConflict.rule) -> Outcome? {
    guard let step = step(failure, tries: tries, rule: rule) else { return nil }
    if waited, inboxAnswered, inboxPickedAt.map({ $0 > tapped }) ?? true { return .giveWay }
    if waited, case .adopt = step, !inboxAnswered, let now = revision(failure) { return tries < retries + 2 ? .retry(revision: now) : .lost }
    switch step {
    case .retry(let revision): return .retry(revision: revision)
    case .adopt: return .adopt
    }
  }
}
