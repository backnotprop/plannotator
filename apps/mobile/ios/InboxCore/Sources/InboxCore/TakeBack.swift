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

  /// The Inbox writes `delivery` only once the agent has the message: any `delivery` is one, as the window reads it.
  static func delivered(_ delivery: InboxDelivery?) -> Bool { delivery != nil }

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

  private static func blank(_ text: String) -> Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

  /// `joined` (packages/server/inbox-take-back.ts): the taken-back words and a draft's words, one blank line apart,
  /// the taken-back first; either alone when the other has none.
  static func joined(_ taken: String, _ kept: String?) -> String {
    if !blank(taken), let kept, !blank(kept) { return "\(taken)\n\n\(kept)" }
    return !blank(taken) ? taken : (kept ?? taken)
  }

  /// The taken-back reply's own words, out of the computer's draft after Take back (`body`, which is `joined` of them
  /// and the draft the computer kept before, `kept`). Nil when the body is not made of that draft: it changed on the
  /// computer in between.
  static func takenWords(_ body: String, kept: String?) -> String? {
    guard let kept, !blank(kept) else { return body }
    if body == kept { return "" }
    let tail = Array("\n\n\(kept)".unicodeScalars)
    let scalars = Array(body.unicodeScalars)
    guard scalars.count > tail.count, Array(scalars.suffix(tail.count)) == tail else { return nil }
    var out = String.UnicodeScalarView()
    out.append(contentsOf: scalars.dropLast(tail.count))
    return String(out)
  }

  /// The reply box's words after Take back. The window saves its box to the computer first (`settle`), so the
  /// computer joins the reply's words with exactly what the box held. The phone does not save its box there, so it
  /// joins them itself: `box`, the words in the phone's box; `kept`, the computer's draft as it was before; `body`,
  /// the computer's draft after; `fromKept`, the box's words began as that draft (changed or not on the phone since).
  /// Then the box's words stand in for that draft, as the window's would. Otherwise the computer's words stay too,
  /// and the box's follow them unless the body already holds them. No word of the box is ever lost.
  public static func refill(body: String, kept: String?, box: String, fromKept: Bool) -> String {
    if fromKept, let taken = takenWords(body, kept: kept) { return joined(taken, box) }
    let mine = box.trimmingCharacters(in: .whitespacesAndNewlines)
    return mine.isEmpty || body.contains(mine) ? body : "\(body)\n\n\(box)"
  }
}

/// One Take back of one message, kept across its retries: the same idempotency key, so a retry after a lost answer
/// gets the computer's first answer again, and the computer's draft as it was before the first try.
struct TakeBackAttempt {
  var key: String
  var kept: InboxReplyDraft?
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
  /// thread's reply draft there; the phone puts them in its own reply box with the words already there, and a Send
  /// of them clears the computer's draft. Nothing is queued: with the computer away, it says so and changes nothing.
  /// A try with no answer keeps its key for the next, and an answer with no draft (the reply was taken back already,
  /// by an earlier try) is followed by a read of the computer's draft, as the window always reads it again.
  public func takeBack(_ id: ThreadID, message: MessageID, name: String) async -> TakeBackOutcome {
    if client == nil { _ = await connect() }
    guard let client else { return .refused(TakeBackRule.refusal(nil, name: name)) }
    if draftBook.takingBack[message] == nil {
      // The computer's draft as it is now: the words it joins with the reply's.
      await readComputerDraft(id)
      draftBook.takingBack[message] = TakeBackAttempt(key: UUID().uuidString, kept: computerDraft(id))
    }
    guard let attempt = draftBook.takingBack[message] else { return .refused(TakeBackRule.refusal(nil, name: name)) }
    do {
      let answer = try await client.post(Door.postMessageTakeBack(message: message), DoorKeyBody(idempotencyKey: attempt.key), as: DoorTakeBackAnswer.self)
      draftBook.takingBack[message] = nil
      var draft = answer.draft
      if draft == nil {
        await readComputerDraft(id)
        draft = computerDraft(id)
      }
      if let draft { takenBack(id, draft, kept: attempt.kept, message: answer.message) }
      await readThread(id)
      await readList()
      return .taken
    } catch let failure as DoorFailure {
      if failure.isDefinite { draftBook.takingBack[message] = nil }
      note(failure)
      return .refused(TakeBackRule.refusal(failure, name: name))
    } catch {
      return .refused(TakeBackRule.refusal(nil, name: name))
    }
  }

  /// The computer's reply draft after Take back, into the phone's: its words joined with the box's
  /// (`TakeBackRule.refill`), its files (already uploads on the computer) and its quote, and the agents the reply
  /// tagged, while their `@` stands in the words.
  func takenBack(_ id: ThreadID, _ draft: InboxReplyDraft, kept: InboxReplyDraft?, message: InboxMessageWire) {
    draftBook.computer[id] = .some(draft)
    let local = draftBook.local[id]
    let started = local?.base ?? draftBook.base[id]
    let words = TakeBackRule.refill(body: draft.body, kept: kept?.body, box: local?.words ?? "", fromKept: started != nil && started == kept?.updatedAt)
    changeDraft(id) { box in
      box.words = words
      let have = Set((box.files ?? []).compactMap(\.upload))
      let back = (draft.files ?? []).filter { !have.contains($0.uploadId.rawValue) }.map { file in
        DraftFile(id: "taken-\(file.uploadId.rawValue)", name: file.name, size: file.size, type: file.mediaType ?? "", upload: file.uploadId.rawValue, kind: file.kind.rawValue)
      }
      box.files = back + (box.files ?? [])
      if box.quote == nil, let quote = draft.quote { box.quote = DraftQuote(of: MessageID(quote.of), words: quote.words) }
      let tags = (message.tags ?? []).filter { $0.handedAway != true }.map { DraftTag(session: $0.session, host: $0.host, label: $0.label ?? TagRules.agentName($0.host, $0.name)) }
      box.tags = TagRules.standing(tags + (box.tags ?? []), words: words)
    }
    // Sending these words clears the computer's draft (`clear_draft`).
    draftBook.base[id] = draft.updatedAt
    if var now = draftBook.local[id] {
      now.base = draft.updatedAt
      draftBook.local[id] = now
      keepDrafts()
    }
    refilled[id] = words
  }

  /// Take back on a reply that waits on the phone (its `HeldWrite.id`): nothing has left the phone, so its words,
  /// files, quote and tags go back to the box (`cancelHeld`). One already on its way to the computer is not taken
  /// back here: it is refused as the computer's Take back is when there is no answer, and offered there once it
  /// lands. Nil: no such reply waits any more.
  public func takeBackHeld(_ write: String, name: String) -> TakeBackOutcome? {
    switch cancelHeld(write) {
    case .cancelled: return .taken
    case .onItsWay: return .refused(TakeBackRule.refusal(nil, name: name))
    case .notHeld: return nil
    }
  }

  /// The words Take back put in the reply box, handed once to the box, which shows them in place of its own.
  public func takeRefilledWords(_ id: ThreadID) -> String? {
    defer { refilled[id] = nil }
    return refilled[id]
  }

}
