import Foundation
import InboxCore
import InboxWire

/// A door that answers from memory, in the wire's own shapes: every answer is a Wire.swift type encoded to JSON,
/// so the app reads it exactly as it reads a computer. It keeps the door's rules the app depends on: the bearer
/// token, the app header and its floor, idempotency keys and their replay, question revisions.
///
/// It is the app's "Try it without a computer", the tests' computer and the screenshots' computer. It is not the
/// Inbox: its list sections and previews are simple stand-ins for rules the real computer owns.
public actor StandInDoor {
  public struct Options: Sendable {
    public var computerName = "Work Mac"
    public var secret = "standin-secret-0000000000000000000000000000"
    public var code = "246810"
    public var contract = 1
    public var minAppContract = 1
    /// False: an Inbox from before the handshake, whose `health` has no `door`.
    public var answersDoor = true
    /// The thread's files are listed without the comments that wait, as an Inbox from before that field does.
    public var omitsComments = false
    /// Route names left out of `health.door.routes`, as an older Inbox would.
    public var withoutRoutes: Set<String> = []
    public var version = "0.29.3"
    /// How many arriving picks find that another place answered the question a moment before (its revision one up).
    public var racesPicks = 0
    /// A status something between the phone and the computer answers every reply with, as a web page: not the Inbox's JSON.
    public var proxyRefusesReplies: Int?
    /// Threads whose archive something between the phone and the computer refuses with a web page (a 403): one
    /// row of an act on several rows that is not taken.
    public var proxyRefusesArchive: Set<String> = []
    /// True: the Authorization header never reaches the door, as when something in between strips it.
    public var stripsToken = false
    /// A code every drawing is refused with (`413 markup_too_large`, or the relay's `413 relay_upload_unavailable`).
    public var refusesMarkups: String?
    public init() {}
  }

  public var options: Options
  /// True: no answer at all, as when the computer sleeps.
  public var offline = false
  /// Every call the door received, for the tests.
  public private(set) var calls: [DoorCall] = []

  var threads: [InboxThread]
  var unread: Set<ThreadID>
  /// Stars, archives, snoozes, priority, drafts and files (StandInRowState.swift).
  var state = StandInState()
  private var tokens: [String: DeviceID] = [:]
  private var revoked: Set<DeviceID> = []
  private var wrongCodes = 0
  private var offerOpen = true
  private var replays: [String: (method: String, path: String, answer: DoorAnswerBytes)] = [:]
  var seq: Int64
  let session = "standin-session"
  var counter = 0

  public init(options: Options = Options(), threads: [InboxThread]? = nil, unread: Set<ThreadID>? = nil, now: Date = Date()) {
    self.options = options
    let seeded = threads ?? StandInData.threads(now: now)
    self.threads = seeded
    self.unread = unread ?? StandInData.unread
    self.seq = seeded.flatMap(\.messages).compactMap(\.seq).max() ?? 0
  }

  public func setOffline(_ value: Bool) { offline = value }

  /// Hold the answer to every pick (the pick itself is applied) until `release()`: a write still on its way.
  public func holdPickAnswers() { holding = true }
  public func release() {
    holding = false
    for waiter in waiters { waiter.resume() }
    waiters = []
  }
  func held(_ call: DoorCall) async {
    guard holding, call.method == .post, call.path.hasSuffix("/picks") else { return }
    await withCheckedContinuation { waiters.append($0) }
  }
  private var holding = false
  private var waiters: [CheckedContinuation<Void, Never>] = []

  /// One more thread on the computer.
  public func add(_ thread: InboxThread) {
    threads.insert(thread, at: 0)
    seq = max(seq, thread.messages.compactMap(\.seq).max() ?? 0)
    unread.insert(thread.threadId)
  }
  public func setOptions(_ change: @Sendable (inout Options) -> Void) { change(&options) }
  public func clearCalls() { calls = [] }
  /// The thread is gone from the computer (deleted there): every read of it is `404 thread_not_found`.
  public func removeThread(_ id: ThreadID) { threads.removeAll { $0.threadId == id } }
  public func thread(_ id: ThreadID) -> InboxThread? { threads.first { $0.threadId == id } }
  /// Change a thread as the computer's own side would (an archive, a Mark read that set a question aside).
  public func change(_ id: ThreadID, _ edit: @Sendable (inout InboxThread) -> Void) {
    if let index = threads.firstIndex(where: { $0.threadId == id }) { edit(&threads[index]) }
  }

  /// A token for a phone that is already paired: the demo and the tests skip the pairing screen with it.
  public func issueToken() -> (token: String, device: DeviceID) {
    counter += 1
    let token = "tok_standin_\(counter)"
    let device = DeviceID("dev_STANDIN\(counter)")
    tokens[token] = device
    return (token, device)
  }

  /// An agent writes a new message, as it would while the person is away.
  public func agentWrites(thread id: ThreadID, body: String, questions: [InboxQuestion] = []) {
    guard let index = threads.firstIndex(where: { $0.threadId == id }), let first = threads[index].messages.first(where: { $0.author.kind == .agent }) else { return }
    // After every message already there, a thread added with its own numbers (the long ones) included.
    seq = max(seq, threads[index].messages.compactMap(\.seq).max() ?? 0) + 1
    counter += 1
    let message = MessageID("msg_STANDINNEW\(counter)")
    var asked = questions
    for q in asked.indices { asked[q].messageId = message }
    threads[index].messages.append(
      InboxMessageWire(questions: asked.isEmpty ? nil : asked, seq: seq, id: message, projectId: first.projectId, threadId: id, author: first.author, body: body, createdAt: StandInData.iso(Date())))
    unread.insert(id)
  }

  // MARK: The door

  public func handle(_ call: DoorCall) throws -> DoorAnswerBytes {
    calls.append(call)
    if offline { throw URLError(.cannotConnectToHost) }
    let headers = Dictionary(call.headers.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { $1 })
    if headers["origin"] != nil { return refuse(403, "origin_not_allowed", "The door takes no Origin.") }
    let route = "\(call.method.rawValue) \(call.path)"
    if route == "POST pair" { return pair(call) }

    guard !options.stripsToken, let bearer = headers["authorization"], bearer.hasPrefix("Bearer ") else { return refuse(401, "device_token_missing", "No device token.") }
    guard let device = tokens[String(bearer.dropFirst(7))] else { return refuse(401, "device_token_invalid", "That device token is not known.") }
    if revoked.contains(device), route != "POST revoke" { return refuse(401, "device_revoked", "This device was removed.") }
    if let app = AppIdentity.parse(headers[AppIdentity.headerName.lowercased()]), app.contract < options.minAppContract, call.path != "health", call.path != "revoke" {
      return refuse(426, "app_needs_update", "Update Plannotator on your phone.", extra: ["min_app_contract": .number(Double(options.minAppContract))])
    }

    if call.method == .get { return get(call) }
    if route == "POST revoke" {
      revoked.insert(device)
      return json(200, ["device": .object(["id": .string(device.rawValue), "revoked_at": .string(StandInData.iso(Date()))])])
    }
    if route == "POST markups" { return keepDrawing(call) }
    return post(call, route: route)
  }

  private func get(_ call: DoorCall) -> DoorAnswerBytes {
    let parts = call.path.split(separator: "/").map(String.init)
    switch parts.count {
    case 1 where parts[0] == "health": return health()
    case 1 where parts[0] == "threads": return encode(200, dressed(StandInData.list(threads: threads, unread: unread, session: session, cursor: seq, version: options.version)))
    case 2 where parts[0] == "threads" && parts[1] != "archived":
      let id = ThreadID(parts[1].removingPercentEncoding ?? parts[1])
      guard let thread = threads.first(where: { $0.threadId == id }) else { return refuse(404, "thread_not_found", "That thread is not here.") }
      return encode(200, model(thread))
    default: return getMore(call, parts) ?? refuse(404, "device_route_not_found", "Not a route of the door.")
    }
  }

  func model(_ thread: InboxThread) -> ThreadModel {
    ThreadModel(serverSession: session, cursor: seq, thread: thread, row: dressed(StandInData.row(of: thread, unread: unread.contains(thread.threadId))))
  }

  private func health() -> DoorAnswerBytes {
    var health = InboxHealth(ok: true, app: "plannotator-inbox", version: options.version, serverSession: session, pid: 1)
    if options.answersDoor {
      let phone = DoorRoutes.all.filter { $0.grant == .phone && !options.withoutRoutes.contains($0.name) }
      health.unknownFields["door"] = .object([
        "contract": .number(Double(options.contract)),
        "routes": .array(phone.map { .string($0.name) }),
        "not_by_relay": .array(phone.filter { !$0.relay }.map { .string($0.name) }),
        "grants": .array([]),
        "min_app_contract": .number(Double(options.minAppContract)),
      ])
    }
    return encode(200, health)
  }

  private func pair(_ call: DoorCall) -> DoorAnswerBytes {
    guard let body = call.body, let request = try? JSONDecoder().decode(DoorPairRequest.self, from: body) else {
      return refuse(422, "validation_error", "name: a name is required.", field: "name")
    }
    let expired = { self.refuse(410, "offer_expired", "This pairing code is no longer open. Make a new one on your computer.") }
    guard request.secret != nil || request.code != nil else { return refuse(422, "validation_error", "secret or code: one is required.", field: "secret") }
    guard offerOpen else { return expired() }
    if let secret = request.secret {
      guard secret == options.secret else { return expired() }
    } else if request.code != options.code {
      wrongCodes += 1
      let left = max(5 - wrongCodes, 0)
      if left == 0 { offerOpen = false }
      return refuse(401, "pairing_code_wrong", "That code is not the one on your computer.", triesLeft: left)
    }
    let issued = issueToken()
    let now = StandInData.iso(Date())
    let answer = DoorPairAnswer(
      device: InboxDevicePublic(name: request.name, id: issued.device, createdAt: now, lastSeenAt: now, platform: request.platform, carriage: true),
      token: issued.token, secret: options.secret, computer: DoorPairAnswerComputer(name: options.computerName),
      addresses: DoorPairAnswerAddresses(tailnet: "work-mac.example.ts.net:8443"), relay: nil)
    return encode(201, answer)
  }

  private func post(_ call: DoorCall, route: String) -> DoorAnswerBytes {
    guard let body = call.body, case .object(let fields)? = try? JSONDecoder().decode(JSONValue.self, from: body) else {
      return refuse(422, "validation_error", "The body must be a JSON object.")
    }
    guard case .string(let key)? = fields["idempotency_key"], !key.isEmpty else {
      return refuse(422, "validation_error", "idempotency_key: a key is required.", field: "idempotency_key")
    }
    if let earlier = replays[key] {
      guard earlier.method == call.method.rawValue, earlier.path == call.path else { return refuse(409, "idempotency_key_reused", "That key was used for another write.") }
      var replay = earlier.answer
      replay.headers["idempotent-replayed"] = "true"
      return replay
    }
    let parts = call.path.split(separator: "/").map { String($0).removingPercentEncoding ?? String($0) }
    let answer: DoorAnswerBytes
    switch (parts.first, parts.count, parts.last) {
    case ("threads", 3, "seen"): answer = seen(ThreadID(parts[1]), fields)
    case ("messages", 3, "picks"): answer = picks(MessageID(parts[1]), fields)
    case ("messages", 4, _) where parts[2] == "actions": answer = markAction(MessageID(parts[1]), parts[3], fields)
    case ("messages", 3, "resolve") where options.proxyRefusesArchive.contains(parts[1]):
      return DoorAnswerBytes(status: 403, headers: ["content-type": "text/html"], body: Data("<html><body>Request refused</body></html>".utf8))
    case ("messages", 3, "reply"):
      if let status = options.proxyRefusesReplies { return DoorAnswerBytes(status: status, headers: ["content-type": "text/html"], body: Data("<html><body>Request refused</body></html>".utf8)) }
      answer = reply(MessageID(parts[1]), fields)
    default:
      // Not on the list: answered, and never kept under the key.
      guard let more = postMore(parts, fields) else { return refuse(404, "device_route_not_found", "Not a route of the door.") }
      answer = more
    }
    if answer.status < 500 { replays[key] = (call.method.rawValue, call.path, answer) }
    return answer
  }

  // The refusals below are the Inbox's own, in its order and with its codes and statuses, so a write the real
  // door would refuse is refused here too: packages/server/inbox.ts (`seen`), and packages/shared/inbox/store.ts
  // `targetMessage`, `sendMessageOf`, `planAnswers`, `savePicks`, `markAction` and `sendReply`.

  private func seen(_ id: ThreadID, _ fields: [String: JSONValue]) -> DoorAnswerBytes {
    guard threads.contains(where: { $0.threadId == id }) else { return refuse(404, "thread_not_found", "No thread \(id.rawValue).") }
    if let through = fields["through_seq"], through != .null {
      guard case .number(let value) = through, value >= 0, value.rounded() == value else {
        return refuse(422, "validation_error", "through_seq: a message seq (a whole number, 0 or more).", field: "through_seq")
      }
    }
    unread.remove(id)
    return json(200, ["ok": .bool(true)])
  }

  private func locate(_ message: MessageID) -> (thread: Int, message: Int)? {
    for (t, thread) in threads.enumerated() {
      if let m = thread.messages.firstIndex(where: { $0.id == message }) { return (t, m) }
    }
    return nil
  }

  private struct Refused: Error { let answer: DoorAnswerBytes }
  private enum Mode { case pick(unsentOnly: Bool), send }
  private enum Planned { case set(QuestionAnswer), clear, keep }

  /// The message a write answers: there, and not closed by an archive.
  private func target(_ message: MessageID) throws -> (thread: Int, message: Int) {
    guard let at = locate(message) else { throw Refused(answer: refuse(404, "message_not_found", "No message \(message.rawValue).")) }
    if threads[at.thread].resolvedAt != nil { throw Refused(answer: refuse(409, "thread_resolved", "This thread is resolved; reopen it to answer.")) }
    return at
  }

  /// `planAnswers`: every entry is checked before anything is written.
  private func plan(thread t: Int, message m: Int, entries: [(index: Int, entry: JSONValue)], mode: Mode, confirmFull: Bool = false) throws -> [(question: Int, planned: Planned)] {
    let message = threads[t].messages[m]
    let questions = message.questions ?? []
    let permission = message.author.kind == .agent && (message.author.session ?? "").hasPrefix("perm:")
    var seen: Set<String> = []
    var out: [(Int, Planned)] = []
    for (index, entry) in entries {
      let field = "questions[\(index)]"
      guard case .object(let fields) = entry, case .string(let key)? = fields["key"] else { throw Refused(answer: refuse(422, "validation_error", "\(field).key: required.", field: "\(field).key")) }
      guard seen.insert(key).inserted else { throw Refused(answer: refuse(422, "validation_error", "\(field).key: listed twice.", field: "\(field).key")) }
      guard case .number(let number)? = fields["revision"], number >= 0, number.rounded() == number else {
        throw Refused(answer: refuse(422, "validation_error", "\(field).revision: a non-negative integer is required.", field: "\(field).revision"))
      }
      if (message.actions ?? []).contains(where: { $0.key == key }) || questions.contains(where: { $0.key == key && $0.kind == .action }) {
        throw Refused(answer: refuse(422, "validation_error", "\(field).key: \(key) is an action item, not a question; mark it Done or Can't do it on its card.", field: "\(field).key", key: key))
      }
      guard let q = questions.firstIndex(where: { $0.key == key }) else { throw Refused(answer: refuse(404, "question_not_found", "No question \(key) on message \(message.id.rawValue).", key: key)) }
      let record = questions[q]
      if record.supersededBy != nil || record.state == .superseded {
        throw Refused(answer: refuse(422, "question_superseded", "Question \(key) was replaced by a newer question; it can no longer be answered.", key: key))
      }
      if record.setAsideAt != nil {
        throw Refused(answer: refuse(409, "question_set_aside", "Question \(key) was closed when the thread was marked read; move the thread back to answer it.", key: key))
      }
      if record.revision != Int64(number) {
        throw Refused(answer: refuse(409, "question_revision_conflict", "Question \(key) changed since you read it (revision \(record.revision)).", key: key, extra: ["current_revision": .number(Double(record.revision))]))
      }
      let alreadySent = record.answer != nil && record.revision > 0 && record.sentRevision == record.revision
      let sent = Refused(answer: refuse(409, "question_already_sent", "The answer to \(key) was already sent.", key: key))
      if case .pick(let unsentOnly) = mode, unsentOnly || permission, alreadySent { throw sent }
      if case .send = mode, permission, alreadySent { continue }
      switch (fields["answer"], mode) {
      case (.null?, .send): throw Refused(answer: refuse(422, "validation_error", "\(field).answer: a Send cannot clear a pick.", field: "\(field).answer"))
      case (.null?, .pick): out.append((q, .clear))
      case (nil, .pick): throw Refused(answer: refuse(422, "validation_error", "\(field).answer: a pick needs an answer (or null to clear).", field: "\(field).answer"))
      case (nil, .send):
        if record.answer == nil { throw Refused(answer: refuse(422, "validation_error", "\(field).answer: nothing is picked for \(key).", field: "\(field).answer")) }
        if record.sentRevision == record.revision { throw sent }
        out.append((q, .keep))
      case (let value?, _):
        guard let answer = try? value.decodedAnswer(), answer.key == key else { throw Refused(answer: refuse(422, "validation_error", "\(field).answer: not an answer to \(key).", field: "\(field).answer")) }
        // The first time in a session, Full permissions is picked only with the person's confirmation.
        if permission, answer.selected.contains(PermissionPrompt.full) {
          var confirmed = false
          if case .pick = mode { confirmed = confirmFull }
          if !confirmed, !PermissionPrompt.fullUsed(in: threads[t], before: message) {
            throw Refused(answer: refuse(422, "validation_error", "Full permissions: confirm it first (confirm_full).", field: "confirm_full"))
          }
        }
        out.append((q, .set(answer)))
      }
    }
    return out
  }

  private func picks(_ message: MessageID, _ fields: [String: JSONValue]) -> DoorAnswerBytes {
    do {
      let at = try target(message)
      guard case .array(let entries)? = fields["questions"], !entries.isEmpty else { return refuse(422, "validation_error", "questions: at least one question is required.", field: "questions") }
      if options.racesPicks > 0, case .object(let first)? = entries.first, case .string(let key)? = first["key"], let q = threads[at.thread].messages[at.message].questions?.firstIndex(where: { $0.key == key }) {
        options.racesPicks -= 1
        var raced = threads[at.thread].messages[at.message].questions![q]
        raced.answer = QuestionAnswers.choice(raced, selected: raced.choices.last.map { [$0.label] } ?? [], note: "")
        raced.state = .picked
        raced.revision += 1
        raced.pickedAt = StandInData.iso(Date())
        threads[at.thread].messages[at.message].questions![q] = raced
      }
      let planned = try plan(thread: at.thread, message: at.message, entries: entries.enumerated().map { ($0.offset, $0.element) }, mode: .pick(unsentOnly: fields["unsent_only"] == .bool(true)), confirmFull: fields["confirm_full"] == .bool(true))
      var questions = threads[at.thread].messages[at.message].questions ?? []
      for (q, change) in planned {
        if case .set(let answer) = change { questions[q].answer = answer } else { questions[q].answer = nil }
        questions[q].state = questions[q].answer == nil ? .openValue : .picked
        questions[q].revision += 1
        questions[q].pickedAt = questions[q].answer == nil ? nil : StandInData.iso(Date())
      }
      threads[at.thread].messages[at.message].questions = questions
      return encode(200, DoorPicksAnswer(messageId: message, questions: questions))
    } catch let refused as Refused {
      return refused.answer
    } catch {
      return refuse(500, "internal_error", "The stand-in failed.")
    }
  }

  /// `markAction`: Done (with an optional note), Can't do it (with a reason), Skip (no note: one sent is dropped), or null to take it back.
  private func markAction(_ message: MessageID, _ key: String, _ fields: [String: JSONValue]) -> DoorAnswerBytes {
    do {
      let at = try target(message)
      var questions = threads[at.thread].messages[at.message].questions ?? []
      guard let q = questions.firstIndex(where: { $0.key == key }) else { return refuse(404, "question_not_found", "No action item \(key) on message \(message.rawValue).", key: key) }
      guard questions[q].kind == .action else { return refuse(422, "validation_error", "\(key) is a question, not an action item; answer it on its card.", field: "key", key: key) }
      if let staged = fields["staged"], staged != .null, staged != .bool(true), staged != .bool(false) { return refuse(422, "validation_error", "staged: a boolean.", field: "staged") }
      var outcome: InboxActionResultOutcome?
      switch fields["outcome"] {
      case .null?: outcome = nil
      case .string("done")?: outcome = .done
      case .string("cant")?: outcome = .cant
      case .string("skip")?: outcome = .skip
      default: return refuse(422, "validation_error", "outcome: \"done\", \"cant\", \"skip\", or null to undo.", field: "outcome")
      }
      var note = ""
      if let raw = fields["note"], raw != .null {
        guard case .string(let text) = raw else { return refuse(422, "validation_error", "note: text.", field: "note") }
        note = text.trimmingCharacters(in: .whitespacesAndNewlines)
      }
      if outcome == .skip { note = "" }
      if outcome == .cant, note.isEmpty { return refuse(422, "validation_error", "note: say why you can't do it; the agent gets it word for word.", field: "note") }
      let state = questions[q].state
      if state == .sent { return refuse(409, "action_already_sent", "Action item \(key) was already sent to the agent.", key: key) }
      guard state == .openValue || state == .picked else { return refuse(409, "action_closed", "Action item \(key) is \(state.rawValue): it can no longer be marked.", key: key) }
      // A note save that lands after the mark was taken back: the take-back wins.
      if fields["note_only"] == .bool(true), state == .openValue {
        return encode(200, JSONValue.object(["questions": (try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(questions))) ?? .array([])]))
      }
      guard let outcome else {
        if state == .picked {
          questions[q].actionResult = nil
          questions[q].state = .openValue
          questions[q].revision += 1
          questions[q].pickedAt = nil
          threads[at.thread].messages[at.message].questions = questions
        }
        return encode(200, JSONValue.object(["questions": (try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(questions))) ?? .array([])]))
      }
      let staged = fields["staged"] == .bool(true)
      let now = StandInData.iso(Date())
      // A staged mark that changes keeps the time it was first marked.
      let kept = staged && questions[q].actionResult?.staged == true && state == .picked ? questions[q].actionResult?.at : nil
      questions[q].actionResult = InboxActionResult(outcome: outcome, note: note.isEmpty ? nil : note, at: kept ?? now, by: .person, staged: staged ? true : nil)
      questions[q].state = .picked
      questions[q].revision += 1
      questions[q].pickedAt = kept ?? now
      threads[at.thread].messages[at.message].questions = questions
      return encode(200, JSONValue.object(["questions": (try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(questions))) ?? .array([])]))
    } catch let refused as Refused {
      return refused.answer
    } catch {
      return refuse(500, "internal_error", "The stand-in failed.")
    }
  }

  private func reply(_ message: MessageID, _ fields: [String: JSONValue]) -> DoorAnswerBytes {
    do {
      let at = try target(message)
      let asked = threads[at.thread].messages[at.message]
      var entries: [JSONValue] = []
      if let listed = fields["questions"], listed != .null {
        guard case .array(let items) = listed else { return refuse(422, "validation_error", "questions: must be a list.", field: "questions") }
        entries = items
      }
      var words = ""
      if case .string(let text)? = fields["words"] { words = text }
      // One Send to one session is one reply: each answer is planned against its own message's questions.
      var byMessage: [(message: Int, entries: [(index: Int, entry: JSONValue)])] = []
      for (index, entry) in entries.enumerated() {
        var m = at.message
        if case .object(let object) = entry, let raw = object["message_id"] {
          let field = "questions[\(index)].message_id"
          guard case .string(let id) = raw else { return refuse(422, "validation_error", "\(field): a message id.", field: field) }
          if id != message.rawValue {
            guard let other = threads[at.thread].messages.firstIndex(where: { $0.id.rawValue == id }), threads[at.thread].messages[other].author.kind == .agent, asked.author.kind == .agent,
              let session = asked.author.session, !session.isEmpty, threads[at.thread].messages[other].author.session == session, (threads[at.thread].messages[other].author.host ?? "") == (asked.author.host ?? "")
            else { return refuse(422, "validation_error", "\(field): \(id) is not a message of this thread from the session the reply goes to.", field: field) }
            m = other
          }
        }
        if let known = byMessage.firstIndex(where: { $0.message == m }) { byMessage[known].entries.append((index, entry)) } else { byMessage.append((m, [(index, entry)])) }
      }
      var planned: [(message: Int, question: Int, planned: Planned)] = []
      for group in byMessage {
        planned += try plan(thread: at.thread, message: group.message, entries: group.entries, mode: .send).map { (group.message, $0.question, $0.planned) }
      }
      // The action items whose mark waits in the draft and goes with this reply.
      var marks: [(message: Int, question: Int)] = []
      if case .array(let items)? = fields["actions"] {
        for (index, item) in items.enumerated() {
          guard case .object(let object) = item, case .string(let key)? = object["key"] else { return refuse(422, "validation_error", "actions[\(index)].key: required.", field: "actions[\(index)].key") }
          var m = at.message
          if case .string(let id)? = object["message_id"], let other = threads[at.thread].messages.firstIndex(where: { $0.id.rawValue == id }) { m = other }
          guard let q = threads[at.thread].messages[m].questions?.firstIndex(where: { $0.key == key && $0.kind == .action }) else { return refuse(404, "question_not_found", "No action item \(key).", key: key) }
          guard threads[at.thread].messages[m].questions?[q].state == .picked else { return refuse(409, "action_already_sent", "Action item \(key) was already sent to the agent.", key: key) }
          marks.append((m, q))
        }
      }
      var feedback = ""
      if case .string(let text)? = fields["feedback"] { feedback = text.trimmingCharacters(in: .whitespacesAndNewlines) }
      // `planSentAnnotations`: each comment named is in this thread and still waits.
      var carried: [String] = []
      if let listed = fields["annotation_ids"], listed != .null {
        guard case .array(let ids) = listed else { return refuse(422, "validation_error", "annotation_ids: must be a list.", field: "annotation_ids") }
        for (index, value) in ids.enumerated() {
          let field = "annotation_ids[\(index)]"
          guard case .string(let id) = value, let record = state.annotations[id], record.threadId == asked.threadId else { return refuse(404, "annotation_not_found", "\(field): no such annotation in this thread.", field: field) }
          if carried.contains(id) { return refuse(422, "validation_error", "\(field): listed twice.", field: field) }
          if record.removedAt != nil || record.sentReplyId != nil { return refuse(409, "annotation_closed", "\(field): already sent or removed.", field: field) }
          carried.append(id)
        }
      }
      if planned.isEmpty, marks.isEmpty, feedback.isEmpty, words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        if case .object(let first)? = entries.first, case .string(let key)? = first["key"] { return refuse(409, "question_already_sent", "The answer to \(key) was already sent.", key: key) }
        return refuse(422, "validation_error", "words: write a reply or send at least one answer.", field: "words")
      }
      seq += 1
      counter += 1
      let replyID = MessageID("msg_STANDINREPLY\(counter)")
      var answered: [String] = []
      for (m, q, change) in planned {
        guard var question = threads[at.thread].messages[m].questions?[q] else { continue }
        if case .set(let answer) = change {
          question.answer = answer
          question.revision += 1
        }
        question.state = .sent
        question.sentRevision = question.revision
        question.sentReplyId = replyID.rawValue
        threads[at.thread].messages[m].questions?[q] = question
        if let answer = question.answer { answered.append(StandInData.words(of: answer)) }
      }
      for (m, q) in marks {
        guard var item = threads[at.thread].messages[m].questions?[q] else { continue }
        item.state = .sent
        item.sentRevision = item.revision
        item.sentReplyId = replyID.rawValue
        threads[at.thread].messages[m].questions?[q] = item
        answered.append(item.actionResult?.outcome == .cant ? "Can't do it: \(item.prompt)" : "Done: \(item.prompt)")
      }
      let now = StandInData.iso(Date())
      let written = InboxMessageWire(
        seq: seq, id: replyID, projectId: asked.projectId, threadId: asked.threadId, replyTo: message.rawValue, author: InboxAuthor(kind: .person),
        body: [words.isEmpty && !answered.isEmpty ? "Answered: \(answered.joined(separator: "; "))" : words, feedback].filter { !$0.isEmpty }.joined(separator: "\n\n"), createdAt: now,
        delivery: InboxDelivery(state: "queued", host: asked.author.host ?? "", session: asked.author.session ?? "", at: now))
      threads[at.thread].messages.append(written)
      for id in carried { state.annotations[id]?.sentReplyId = replyID.rawValue }
      unread.remove(asked.threadId)
      let wire = (try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(written))) ?? .null
      let result = ReplyResult(
        reply: wire, questions: threads[at.thread].messages[at.message].questions ?? [], replayed: false,
        threadRead: fields["with_thread"] == .bool(true) ? model(threads[at.thread]) : nil)
      return encode(200, result)
    } catch let refused as Refused {
      return refused.answer
    } catch {
      return refuse(500, "internal_error", "The stand-in failed.")
    }
  }

  // MARK: Answers

  func encode<T: Encodable>(_ status: Int, _ value: T) -> DoorAnswerBytes {
    DoorAnswerBytes(status: status, headers: ["content-type": "application/json; charset=utf-8", "cache-control": "no-store"], body: (try? JSONEncoder().encode(value)) ?? Data("{}".utf8))
  }

  func json(_ status: Int, _ fields: [String: JSONValue]) -> DoorAnswerBytes { encode(status, JSONValue.object(fields)) }

  func refuse(_ status: Int, _ code: String, _ words: String, field: String? = nil, triesLeft: Int? = nil, key: String? = nil, extra: [String: JSONValue] = [:]) -> DoorAnswerBytes {
    encode(status, DoorError(error: words, code: code, field: field, triesLeft: triesLeft.map(Double.init), key: key, unknownFields: extra))
  }
}

/// The stand-in door as a way to it: what the demo and most tests hand the session.
public struct StandInTransport: DoorTransport {
  public let door: StandInDoor
  public init(door: StandInDoor) { self.door = door }
  public func send(_ call: DoorCall) async throws -> DoorAnswerBytes {
    let answer = try await door.handle(call)
    await door.held(call)
    return answer
  }
}

extension JSONValue {
  fileprivate func decodedAnswer() throws -> QuestionAnswer { try JSONDecoder().decode(QuestionAnswer.self, from: JSONEncoder().encode(self)) }
}
