import Foundation
import InboxCore
import InboxWire

/// Tags, 👍 Looks good and Take back on the stand-in computer, with the Inbox's own rules and refusals
/// (packages/server/inbox-tags.ts, packages/shared/inbox/store.ts `ackMessage`, `settleAcks`, `takeBack`,
/// packages/server/inbox-take-back.ts).
extension StandInDoor {
  /// An agent that reads the Inbox only (MCP): taggable, never woken.
  static let reader = (session: "mcp_review", name: "Review bot")

  /// How long a 👍 waits before it goes to the agent (`INBOX_SET_ASIDE_DELAY_MS`).
  public func setAckWindow(_ seconds: TimeInterval) { state.ackWindow = seconds }

  /// Who a thread's reply can tag: every live session (owner first, then those that wrote in the thread, then the
  /// rest), then the agent that reads the Inbox only.
  func taggable(_ id: ThreadID) -> DoorTaggableAnswer? {
    guard let thread = threads.first(where: { $0.threadId == id }) else { return nil }
    let asker = thread.messages.last { $0.author.kind == .agent && !($0.author.session ?? "").hasPrefix("perm:") }?.author
    let writers = Set(thread.messages.compactMap { $0.author.kind == .agent ? $0.author.session : nil })
    var rows: [DoorTaggableSession] = []
    for group in sessionsModel() {
      for live in group.sessions {
        rows.append(
          DoorTaggableSession(
            session: live.session, host: live.host, kind: .live, project: DoorTaggableSessionProject(id: group.project.id, name: group.project.name, root: group.project.root),
            startedAt: live.startedAt, lastAt: live.lastSeenAt, busy: live.busy, idleSince: live.idleSince, taggable: true, owner: live.session == asker?.session, wroteThread: writers.contains(live.session)))
      }
    }
    rows.sort { a, b in
      func rank(_ s: DoorTaggableSession) -> Int { s.owner ? 0 : s.wroteThread ? 1 : s.project?.id == thread.project.id ? 2 : 3 }
      return rank(a) < rank(b)
    }
    let seen = thread.messages.last?.createdAt ?? StandInData.iso(Date())
    rows.append(DoorTaggableSession(session: Self.reader.session, kind: .mcp, name: Self.reader.name, lastAt: seen, taggable: true, owner: false, wroteThread: false))
    return DoorTaggableAnswer(serverSession: session, owner: asker.map { DoorTaggableAnswerOwner(host: $0.host, session: $0.session ?? "") }, sessions: rows)
  }

  func getWriting(_ parts: [String]) -> DoorAnswerBytes? {
    guard parts.count == 3, parts[0] == "threads", parts[2] == "taggable" else { return nil }
    guard let answer = taggable(ThreadID(parts[1])) else { return refuse(404, "thread_not_found", "No thread \(parts[1]).") }
    return encode(200, answer)
  }

  func postWriting(_ parts: [String], _ fields: [String: JSONValue]) -> DoorAnswerBytes? {
    guard parts.count == 3, parts[0] == "messages" else { return nil }
    switch parts[2] {
    case "ack": return ack(MessageID(parts[1]), fields)
    case "take-back": return takeBack(MessageID(parts[1]))
    default: return nil
    }
  }

  private func at(_ message: MessageID) -> (thread: Int, message: Int)? {
    for (t, thread) in threads.enumerated() {
      if let m = thread.messages.firstIndex(where: { $0.id == message }) { return (t, m) }
    }
    return nil
  }

  /// The tags a reply names (`tagTargets`): each a session the person can tag in that thread, never the owner, each
  /// once, in the order given. Nil with the refusal when one is not (nothing is written).
  func replyTags(_ fields: [String: JSONValue], thread: ThreadID, owner: String?) -> (tags: [InboxTag], refusal: DoorAnswerBytes?) {
    guard let listed = fields["tags"], listed != .null else { return ([], nil) }
    guard case .array(let items) = listed else { return ([], refuse(422, "validation_error", "tags: a list of { host, session }.", field: "tags")) }
    let offered = taggable(thread)?.sessions ?? []
    var tags: [InboxTag] = []
    for item in items {
      guard case .object(let tag) = item, case .string(let id)? = tag["session"], !id.isEmpty else { return ([], refuse(422, "validation_error", "tags: a list of { host, session }.", field: "tags")) }
      guard let row = offered.first(where: { $0.session == id }) else {
        return ([], refuse(409, "session_not_live", "A session you tagged is not live any more: nothing was sent. Remove the tag, or tag another session."))
      }
      if case .string(let host)? = tag["host"], let known = row.host, host != known {
        return ([], refuse(409, "tag_host_mismatch", "A session you tagged is another agent than the tag says: nothing was sent. Remove the tag and pick the session from the list again."))
      }
      if id == owner || tags.contains(where: { $0.session == id }) { continue }
      var label: String?
      if case .string(let text)? = tag["label"] { label = text }
      tags.append(InboxTag(host: row.host, session: id, name: row.name, label: label, wakes: row.kind == .live))
    }
    return (tags, nil)
  }

  // MARK: 👍 Looks good

  /// `ackMessage`: on the agent's latest message only, with no question waiting, the person not having written
  /// after it and the thread not archived; it marks the thread read. Another emoji inside its window changes only
  /// the emoji; once sent it never changes. `ack: false` takes back one not sent yet.
  func ack(_ id: MessageID, _ fields: [String: JSONValue]) -> DoorAnswerBytes {
    settleAcks()
    guard let place = at(id) else { return refuse(404, "message_not_found", "No message \(id.rawValue).") }
    let thread = threads[place.thread]
    var message = thread.messages[place.message]
    let on = fields["ack"] != .bool(false)
    var reaction: InboxReaction??
    switch fields["reaction"] {
    case nil: reaction = .none
    case .null?: reaction = .some(nil)
    case .object(let object)?:
      guard case .string(let emoji)? = object["emoji"], Reactions.isEmoji(emoji) else { return refuse(422, "validation_error", "reaction: { emoji: one emoji, label?: string }.", field: "reaction") }
      var label: String?
      if case .string(let text)? = object["label"], !text.isEmpty { label = text }
      reaction = .some(emoji == Reactions.thumbsUp && label == nil ? nil : InboxReaction(emoji: emoji, label: label))
    default: return refuse(422, "validation_error", "reaction: { emoji: one emoji, label?: string }.", field: "reaction")
    }
    if on {
      guard message.author.kind == .agent else { return refuse(422, "ack_not_allowed", "Only an agent's message takes 👍 Looks good.") }
      if thread.resolvedAt != nil || state.rows[thread.threadId]?.resolvedAt != nil { return refuse(409, "thread_resolved", "This thread is archived; unarchive it first.") }
      guard thread.messages.last(where: { $0.author.kind == .agent })?.id == id else { return refuse(409, "ack_stale", "A newer message arrived in this thread; read it first.") }
      if thread.messages[(place.message + 1)...].contains(where: { $0.author.kind == .person && $0.ackOf == nil }) { return refuse(409, "ack_after_reply", "You already replied in this thread after this message.") }
      let agents: [InboxMessageWire] = thread.messages.filter { $0.author.kind == .agent }
      let items: [InboxQuestion] = agents.flatMap { (m: InboxMessageWire) -> [InboxQuestion] in (m.questions ?? []) + (m.actions ?? []) }
      let waits = items.contains { (q: InboxQuestion) -> Bool in q.state == .openValue || q.state == .picked }
      if waits { return refuse(409, "question_open", "A question here waits on you: answer it, or Mark read.") }
      if var ack = message.ack {
        if case .some(let changed) = reaction, ack.reaction != changed {
          if ack.settledSeq != nil { return refuse(409, "ack_sent", "This reaction was sent already; it can't be changed.") }
          ack.reaction = changed
          message.ack = ack
        }
      } else {
        let made = unread.contains(thread.threadId)
        unread.remove(thread.threadId)
        seq += 1
        message.ack = InboxAck(label: Words.labelAck, at: StandInData.iso(Date()), reaction: reaction ?? nil, readSeq: seq, madeRead: made, settledSeq: nil, settledAt: nil, seenAt: nil)
      }
    } else if let ack = message.ack {
      if ack.deliveredAt != nil || ack.settledSeq != nil { return refuse(409, "ack_sent", "This reaction was sent already; it can't be taken back.") }
      message.ack = nil
      if ack.madeRead == true { unread.insert(thread.threadId) }
    }
    threads[place.thread].messages[place.message] = message
    guard let row = listRow(thread.threadId) else { return refuse(404, "thread_not_found", "No thread \(thread.threadId.rawValue).") }
    return encode(200, DoorAckAnswer(message: message, thread: row))
  }

  /// `settleAcks`: a 👍 whose window passed goes to its agent (its note is written; the agent gets it as a reply).
  func settleAcks(now: Date = Date()) {
    for t in threads.indices {
      for m in threads[t].messages.indices {
        guard var ack = threads[t].messages[m].ack, ack.settledSeq == nil, let at = SnoozeRules.date(ack.at), now.timeIntervalSince(at) >= state.ackWindow else { continue }
        seq += 1
        ack.settledSeq = seq
        ack.settledAt = StandInData.iso(now)
        ack.noteId = "msg_STANDINNOTE\(seq)"
        threads[t].messages[m].ack = ack
      }
    }
  }

  // MARK: Take back

  /// `takeBack`: the person's own reply that no agent has, words and files only, the thread's later replies taken
  /// back first. It leaves the thread; its words, files (uploads again) and quote go to the thread's reply draft.
  func takeBack(_ id: MessageID) -> DoorAnswerBytes {
    if let gone = state.takenBack[id] { return encode(200, DoorTakeBackAnswer(message: gone, draft: nil, compose: nil)) }
    guard let place = at(id) else { return refuse(404, "message_not_found", "No message \(id.rawValue).") }
    let thread = threads[place.thread]
    let message = thread.messages[place.message]
    guard message.author.kind == .person else { return refuse(422, "cannot_take_back", "Only your own reply or message can be taken back.") }
    if let delivery = message.delivery {
      return refuse(409, "agent_has_it", "The agent already has this message.", extra: ["by": .string("delivered"), "session": .string(delivery.session), "host": .string(delivery.host)])
    }
    if state.agentHas.contains(id) {
      return refuse(409, "agent_has_it", "The agent already has this message.", extra: ["by": .string("read")])
    }
    if message.id.rawValue == thread.threadId.rawValue, thread.messages.count > 1 { return refuse(422, "cannot_take_back", "Take back the later messages of this thread first.") }
    if thread.messages[(place.message + 1)...].contains(where: { $0.author.kind == .person && $0.ackOf == nil }) { return refuse(422, "cannot_take_back", "Take back the later messages of this thread first.") }
    let asked: [InboxQuestion] = thread.messages.flatMap { (m: InboxMessageWire) -> [InboxQuestion] in (m.questions ?? []) + (m.actions ?? []) }
    let answered = asked.contains { $0.sentReplyId == id.rawValue }
    if answered || (message.sentAnnotations ?? 0) > 0 { return refuse(422, "cannot_take_back", "Only a message of words and files can be taken back.") }
    var gone = message
    gone.takenBackAt = StandInData.iso(Date())
    threads[place.thread].messages.remove(at: place.message)
    state.takenBack[id] = gone
    // Its files: uploads again, for the draft.
    var files: [InboxDraftFile] = []
    for (key, file) in state.files.sorted(by: { $0.key < $1.key }) where file.message == id {
      counter += 1
      let upload = InboxUpload(uploadId: UploadID("upl_STANDINBACK\(counter)"), name: file.record.name, size: file.record.size, kind: file.record.kind, sha256: file.record.sentSha256, createdAt: StandInData.iso(Date()), mediaType: file.record.mediaType)
      state.uploads[upload.uploadId.rawValue] = StandInUpload(record: upload, bytes: file.sent)
      files.append(InboxDraftFile(uploadId: upload.uploadId, name: upload.name, size: upload.size, kind: upload.kind, sha256: upload.sha256, createdAt: upload.createdAt, mediaType: upload.mediaType))
      state.files[key] = nil
    }
    let kept = state.drafts[thread.threadId]
    let words = kept == nil && message.quote != nil ? ReplyQuoteRules.withoutLead(message.body) : message.body
    let body = [words, kept?.body ?? ""].filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.joined(separator: "\n\n")
    let stamp = StandInData.iso(Date())
    let recipients = kept == nil ? [message.to?.session ?? message.delivery?.session].compactMap { $0 } + (message.tags ?? []).map(\.session) : nil
    let draft = InboxReplyDraft(
      v: 1, threadId: thread.threadId, body: body, createdAt: kept?.createdAt ?? stamp, updatedAt: stamp, files: files + (kept?.files ?? []), recipients: recipients,
      quote: kept == nil ? message.quote : kept?.quote)
    state.drafts[thread.threadId] = draft
    return encode(200, DoorTakeBackAnswer(message: gone, draft: draft, compose: nil))
  }

  /// The live sessions as the computer lists them now.
  public func sessionsSnapshot() -> [InboxComposeProject] { sessionsModel() }

  /// The agent picks up this reply: Take back is refused from now on (`agent_has_it`).
  public func agentTakes(_ id: MessageID) { state.agentHas.insert(id) }

  /// The next `count` Take back answers are lost on the way back: the reply is taken back, and the phone hears nothing.
  public func loseTakeBackAnswers(_ count: Int) { state.lostTakeBacks = count }
}
