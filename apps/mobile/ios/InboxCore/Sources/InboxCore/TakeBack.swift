import Foundation
import InboxWire

/// Take back (issue #3229; packages/inbox/takeBack.ts, packages/server/inbox-take-back.ts): the person's reply that
/// no agent has yet comes out of the thread and back into the reply box, its words, files and quote with it. There is
/// no time limit: it is offered until an agent has the message. `vectors/writing.json` holds the rule to the window.
public enum TakeBackRule {
  /// `TAKE_BACK_LABEL`.
  public static let label = "Take back"

  /// `carriesAnswers`: a reply that sent answers (to questions or action items) is never taken back.
  static func carriesAnswers(_ message: InboxMessageWire, in messages: [InboxMessageWire]) -> Bool {
    messages.contains { other in ((other.questions ?? []) + (other.actions ?? [])).contains { $0.sentReplyId == message.id.rawValue } }
  }

  /// The Inbox writes `delivery` only once the agent has the message (its state is always `delivered`); the stand-in
  /// computer also writes the line states a phone draws ("queued", "saved") there, which are not a delivery.
  static func delivered(_ delivery: InboxDelivery?) -> Bool {
    guard let delivery else { return false }
    return delivery.state == "delivered" || !["queued", "saved", "sending"].contains(delivery.state)
  }

  /// `takeBackOffered`: the person's own message, which no agent has (not delivered, not read by one, no tagged agent
  /// has it), and which is words and files only. A thread's first message only when it is the only one.
  public static func offered(_ message: InboxMessageWire, in messages: [InboxMessageWire]) -> Bool {
    guard message.author.kind == .person, !delivered(message.delivery), message.takenBackAt == nil, message.readByAgent == nil, message.launch == nil, message.handoff == nil, message.reviewVerdict == nil else { return false }
    if let note = message.ackOf, !note.isEmpty { return false }
    if message.tidy != nil || !(message.setAside ?? []).isEmpty || !(message.reopened ?? []).isEmpty || !(message.reask ?? []).isEmpty { return false }
    if (message.tags ?? []).contains(where: { delivered($0.delivery) || $0.readAt != nil }) { return false }
    if (message.sentAnnotations ?? 0) > 0 || carriesAnswers(message, in: messages) { return false }
    return message.id.rawValue != message.threadId.rawValue || messages.count == 1
  }

  /// `takeBackRefusal`: what the line under the message says when the computer did not take it back.
  public static func refusal(_ failure: DoorFailure?, name: String) -> String {
    if case .refused(_, let error)? = failure {
      if error.code == "agent_has_it" {
        if case .string("handing")? = error.unknownFields["by"] {
          return "\(name) is picking up its messages right now, so this can't be taken back. Try again in a few seconds."
        }
        return "\(name) already has this message, so it can't be taken back. Reply below to change it."
      }
      if error.code == WireErrorCode.cannotTakeBack.rawValue || error.code == WireErrorCode.takenBack.rawValue { return error.error }
    }
    return "It was not taken back. Try again."
  }

  /// The note under the reply box once it was taken back.
  public static func note(_ name: String) -> String { "Taken back. \(name) never got it. Send it again when it's ready." }
}

/// What came of Take back.
public enum TakeBackOutcome: Hashable, Sendable {
  /// Out of the thread: its words, files and quote are in the reply box.
  case taken
  /// The line under the message says why not.
  case refused(String)
}

extension InboxSession {
  // MARK: Take back

  /// Whether Take back is offered on this message now: the window's rule, on a computer that takes it from a phone.
  /// A thread's lone first message is not: its words would go back to a New message draft on the computer, which a
  /// phone can neither read nor clear (the door refuses `draft_id`).
  public func takeBackOffered(_ id: ThreadID, _ message: InboxMessageWire) -> Bool {
    guard standing == .ok, offers(DoorRoutes.postMessageTakeBack), let model = thread(id), !sending.contains(id) else { return false }
    guard message.id.rawValue != model.thread.threadId.rawValue else { return false }
    return TakeBackRule.offered(message, in: model.thread.messages)
  }

  /// Take the reply back (`POST messages/:id/take-back`). The computer writes the words, files and quote into the
  /// thread's reply draft there; the phone puts them in its own reply box (the words first, then any it kept), and a
  /// Send of them clears the computer's draft. Nothing is queued: with the computer away, it says so and changes nothing.
  public func takeBack(_ id: ThreadID, message: MessageID, name: String) async -> TakeBackOutcome {
    if client == nil { _ = await connect() }
    guard let client else { return .refused(TakeBackRule.refusal(nil, name: name)) }
    do {
      let answer = try await client.post(Door.postMessageTakeBack(message: message), DoorKeyBody(idempotencyKey: UUID().uuidString), as: DoorTakeBackAnswer.self)
      if let draft = answer.draft { takenBack(id, draft, message: answer.message) }
      await readThread(id)
      await readList()
      return .taken
    } catch let failure as DoorFailure {
      note(failure)
      return .refused(TakeBackRule.refusal(failure, name: name))
    } catch {
      return .refused(TakeBackRule.refusal(nil, name: name))
    }
  }

  /// The computer's reply draft after Take back, into the phone's: the computer already joined its words with the draft
  /// it kept (the one this phone's box started from, when it did), so they replace the box's words then; words this
  /// phone kept on its own follow them. Its files (already uploads on the computer) and its quote come back, and the
  /// agents the reply tagged, while their `@` stands in the words.
  func takenBack(_ id: ThreadID, _ draft: InboxReplyDraft, message: InboxMessageWire) {
    draftBook.computer[id] = .some(draft)
    let local = draftBook.local[id]
    let mine = (local?.words ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let words = local?.base != nil || mine.isEmpty || draft.body.contains(mine) ? draft.body : "\(draft.body)\n\n\(local?.words ?? "")"
    changeDraft(id) { kept in
      kept.words = words
      let have = Set((kept.files ?? []).compactMap(\.upload))
      let back = (draft.files ?? []).filter { !have.contains($0.uploadId.rawValue) }.map { file in
        DraftFile(id: "taken-\(file.uploadId.rawValue)", name: file.name, size: file.size, type: file.mediaType ?? "", upload: file.uploadId.rawValue, kind: file.kind.rawValue)
      }
      kept.files = back + (kept.files ?? [])
      if kept.quote == nil, let quote = draft.quote { kept.quote = DraftQuote(of: MessageID(quote.of), words: quote.words) }
      let tags = (message.tags ?? []).filter { $0.handedAway != true }.map { DraftTag(session: $0.session, host: $0.host, label: $0.label ?? TagRules.agentName($0.host, $0.name)) }
      kept.tags = tags + (kept.tags ?? [])
    }
    // Sending these words clears the computer's draft (`clear_draft`).
    draftBook.base[id] = draft.updatedAt
    if var kept = draftBook.local[id] {
      kept.base = draft.updatedAt
      draftBook.local[id] = kept
      keepDrafts()
    }
    refilled[id] = words
  }

  /// The words Take back put in the reply box, handed once to the box, which shows them in place of its own.
  public func takeRefilledWords(_ id: ThreadID) -> String? {
    defer { refilled[id] = nil }
    return refilled[id]
  }

}
