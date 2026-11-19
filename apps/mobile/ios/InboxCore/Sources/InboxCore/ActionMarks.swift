import Foundation
import InboxWire

/// An action item (something only the person can do) and the person's Done or Can't do it on it. These are the
/// window's rules, copied (packages/inbox/actions.ts, packages/inbox/components/ActionChecklist.tsx,
/// packages/core/inbox-actions.ts) until the contract carries them.
public enum ActionMarks {
  public enum Outcome: String, Sendable { case done, cant }

  /// A Done (with an optional note) or a Can't do it (with its reason).
  public struct Mark: Hashable, Sendable {
    public var outcome: Outcome
    public var note: String?
    public init(_ outcome: Outcome, note: String? = nil) {
      self.outcome = outcome
      self.note = note
    }
  }

  /// TODO(contract): "generated action body type". The body of `POST messages/:id/actions/:id`: the contract lists
  /// the route and has no generated type for its body yet, so its fields are written here (packages/server/inbox.ts,
  /// the action route; packages/inbox/api.ts `actionMarkBody`). `staged` puts the mark in the reply draft, sent with
  /// the person's Send; `note_only` is a note typed under a marked row, which never marks again an item taken back.
  public struct Body: Codable, Hashable, Sendable {
    public var idempotencyKey: String
    public var outcome: String?
    public var note: String?
    public var staged: Bool?
    public var noteOnly: Bool?

    enum CodingKeys: String, CodingKey { case idempotencyKey = "idempotency_key", outcome, note, staged, noteOnly = "note_only" }

    public func encode(to encoder: Encoder) throws {
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode(idempotencyKey, forKey: .idempotencyKey)
      // Taking a mark back is `outcome: null`, said, never left out.
      try c.encode(outcome, forKey: .outcome)
      try c.encodeIfPresent(note, forKey: .note)
      try c.encodeIfPresent(staged, forKey: .staged)
      try c.encodeIfPresent(noteOnly, forKey: .noteOnly)
    }
  }

  /// TODO(contract): "generated action body type" (its answer). The message's questions and action items as they are now.
  public struct Answer: Decodable, Sendable {
    public var questions: [InboxQuestion]
  }

  /// `checkInboxActionResult` (packages/core/inbox-actions.ts): a note is trimmed, an empty one is none, and a
  /// Can't do it with no reason is not a mark at all.
  public static func checked(_ mark: Mark) -> Mark? {
    let note = QuestionAnswers.jsTrim(mark.note ?? "")
    if mark.outcome == .cant, note.isEmpty { return nil }
    return Mark(mark.outcome, note: note.isEmpty ? nil : note)
  }

  static func body(_ mark: Mark?, quiet: Bool = false, idempotencyKey: String) -> Body {
    guard let mark = mark.flatMap(checked) else { return Body(idempotencyKey: idempotencyKey, outcome: nil, note: nil, staged: true) }
    return Body(idempotencyKey: idempotencyKey, outcome: mark.outcome.rawValue, note: mark.note, staged: true, noteOnly: quiet ? true : nil)
  }

  /// What came of a mark the person pressed.
  public enum Taken: Hashable, Sendable {
    /// The computer has it.
    case saved
    /// It waits on the phone for the computer.
    case waits
    /// The computer refused it: what the person typed stays where it is.
    case refused
    /// This Inbox does not offer it.
    case notOffered
  }

  /// `isMootNoteRefusal` (packages/inbox/actionSaves.ts): a note save refused because the item moved on while the
  /// note was in its typing pause is nothing for the person to do anything about, so nothing is said.
  public static func mootNoteRefusal(quiet: Bool, code: String) -> Bool {
    quiet && (code == "action_already_sent" || code == "action_closed")
  }

  /// `ActionCardState` (packages/inbox/actions.ts).
  public enum State: Hashable, Sendable { case open, pending, done, cant, seen, setAside, archived, replaced }

  public static func state(_ action: InboxQuestion) -> State {
    let result = action.actionResult
    if action.state == .superseded { return .replaced }
    if result?.by == .agent { return .seen }
    if action.state == .closed { return action.setAsideAt != nil ? .setAside : .archived }
    guard let result else { return .open }
    if action.state == .picked { return .pending }
    return result.outcome == .cant ? .cant : .done
  }

  /// `isDoneState`.
  public static func isDone(_ action: InboxQuestion) -> Bool {
    switch state(action) {
    case .done, .seen: return true
    case .pending: return action.actionResult?.outcome == .done
    default: return false
    }
  }

  /// `inboxActionInDraft` (packages/core/inbox-types.ts): the mark waits in the reply draft and goes with the next Send.
  public static func inDraft(_ action: InboxQuestion) -> Bool { SendPlan.actionInDraft(action) }

  /// Marked through the timed path (decision mode in the window): sent once its Undo window passes.
  public static func timed(_ action: InboxQuestion) -> Bool { state(action) == .pending && action.actionResult?.staged != true }

  /// The header's count: the items that are not replaced, how many of them are done, and how many were replaced.
  public static func progress(_ actions: [InboxQuestion]) -> (total: Int, done: Int, replaced: Int) {
    let replaced = actions.filter { state($0) == .replaced }.count
    return (actions.count - replaced, actions.filter(isDone).count, replaced)
  }

  /// `nextOpen`: the next item still open after `key` (then from the start).
  public static func nextOpen(_ actions: [InboxQuestion], after key: String) -> String? {
    let at = actions.firstIndex { $0.key == key } ?? -1
    let order = Array(actions[(at + 1)...]) + Array(actions[..<max(at, 0)])
    return order.first { $0.key != key && state($0) == .open }?.key
  }

  /// A message's action items, in order. The door lists them in `questions` (kind "action"); a thread the window
  /// split has them in `actions`.
  public static func items(of message: InboxMessageWire) -> [InboxQuestion] {
    (message.actions ?? (message.questions ?? []).filter { $0.kind == .action }).sorted { $0.position < $1.position }
  }
}
