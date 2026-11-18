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
    /// Route names left out of `health.door.routes`, as an older Inbox would.
    public var withoutRoutes: Set<String> = []
    public var version = "0.29.3"
    /// A status something between the phone and the computer answers every reply with, as a web page: not the Inbox's JSON.
    public var proxyRefusesReplies: Int?
    public init() {}
  }

  public var options: Options
  /// True: no answer at all, as when the computer sleeps.
  public var offline = false
  /// Every call the door received, for the tests.
  public private(set) var calls: [DoorCall] = []

  private var threads: [InboxThread]
  private var unread: Set<ThreadID>
  private var tokens: [String: DeviceID] = [:]
  private var revoked: Set<DeviceID> = []
  private var wrongCodes = 0
  private var offerOpen = true
  private var replays: [String: (method: String, path: String, answer: DoorAnswerBytes)] = [:]
  private var seq: Int64
  private let session = "standin-session"
  private var counter = 0

  public init(options: Options = Options(), threads: [InboxThread]? = nil, unread: Set<ThreadID>? = nil, now: Date = Date()) {
    self.options = options
    let seeded = threads ?? StandInData.threads(now: now)
    self.threads = seeded
    self.unread = unread ?? StandInData.unread
    self.seq = seeded.flatMap(\.messages).compactMap(\.seq).max() ?? 0
  }

  public func setOffline(_ value: Bool) { offline = value }
  public func setOptions(_ change: @Sendable (inout Options) -> Void) { change(&options) }
  public func clearCalls() { calls = [] }
  public func thread(_ id: ThreadID) -> InboxThread? { threads.first { $0.threadId == id } }

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
    seq += 1
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

    guard let bearer = headers["authorization"], bearer.hasPrefix("Bearer ") else { return refuse(401, "device_token_missing", "No device token.") }
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
    return post(call, route: route)
  }

  private func get(_ call: DoorCall) -> DoorAnswerBytes {
    let parts = call.path.split(separator: "/").map(String.init)
    switch parts.count {
    case 1 where parts[0] == "health": return health()
    case 1 where parts[0] == "threads": return encode(200, StandInData.list(threads: threads, unread: unread, session: session, cursor: seq, version: options.version))
    case 2 where parts[0] == "threads":
      let id = ThreadID(parts[1].removingPercentEncoding ?? parts[1])
      guard let thread = threads.first(where: { $0.threadId == id }) else { return refuse(404, "thread_not_found", "That thread is not here.") }
      return encode(200, model(thread))
    default: return refuse(404, "device_route_not_found", "Not a route of the door.")
    }
  }

  private func model(_ thread: InboxThread) -> ThreadModel {
    ThreadModel(serverSession: session, cursor: seq, thread: thread, row: StandInData.row(of: thread, unread: unread.contains(thread.threadId)))
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
    case ("threads", 3, "seen"): answer = seen(ThreadID(parts[1]))
    case ("messages", 3, "picks"): answer = picks(MessageID(parts[1]), body)
    case ("messages", 3, "reply"):
      if let status = options.proxyRefusesReplies { return DoorAnswerBytes(status: status, headers: ["content-type": "text/html"], body: Data("<html><body>Request refused</body></html>".utf8)) }
      answer = reply(MessageID(parts[1]), body)
    default:
      // Not on the list: answered, and never kept under the key.
      return refuse(404, "device_route_not_found", "Not a route of the door.")
    }
    if answer.status < 500 { replays[key] = (call.method.rawValue, call.path, answer) }
    return answer
  }

  private func seen(_ id: ThreadID) -> DoorAnswerBytes {
    guard threads.contains(where: { $0.threadId == id }) else { return refuse(404, "thread_not_found", "That thread is not here.") }
    unread.remove(id)
    return json(200, ["ok": .bool(true)])
  }

  private func locate(_ message: MessageID) -> (thread: Int, message: Int)? {
    for (t, thread) in threads.enumerated() {
      if let m = thread.messages.firstIndex(where: { $0.id == message }) { return (t, m) }
    }
    return nil
  }

  private func picks(_ message: MessageID, _ body: Data) -> DoorAnswerBytes {
    guard let request = try? JSONDecoder().decode(DoorPicksBody.self, from: body) else { return refuse(422, "validation_error", "questions: a list is required.", field: "questions") }
    guard let at = locate(message) else { return refuse(404, "message_not_found", "That message is not here.") }
    var questions = threads[at.thread].messages[at.message].questions ?? []
    for pick in request.questions {
      guard let index = questions.firstIndex(where: { $0.key == pick.key }) else { return refuse(404, "question_not_found", "That question is not on this message.") }
      let question = questions[index]
      if question.state == .superseded { return refuse(422, "question_superseded", "This question was replaced by a newer one.") }
      if question.state == .sent, request.unsentOnly == true { return refuse(409, "question_already_sent", "This answer was already sent.", key: pick.key) }
      if question.revision != pick.revision { return refuse(409, "question_revision_conflict", "This question changed. Read it again.") }
      questions[index].answer = pick.answer
      questions[index].state = pick.answer == nil ? .openValue : .picked
      questions[index].revision += 1
      questions[index].pickedAt = pick.answer == nil ? nil : StandInData.iso(Date())
    }
    threads[at.thread].messages[at.message].questions = questions
    return encode(200, DoorPicksAnswer(messageId: message, questions: questions))
  }

  private func reply(_ message: MessageID, _ body: Data) -> DoorAnswerBytes {
    guard let request = try? JSONDecoder().decode(DoorReplyBody.self, from: body) else { return refuse(422, "validation_error", "The reply could not be read.") }
    guard let at = locate(message) else { return refuse(404, "message_not_found", "That message is not here.") }
    let asked = threads[at.thread].messages[at.message]
    // Check every pick first: one stale question refuses the whole reply, and nothing is written.
    var sends: [(message: Int, question: Int)] = []
    for pick in request.questions ?? [] {
      let target = pick.messageId ?? message
      guard let m = threads[at.thread].messages.firstIndex(where: { $0.id == target }), let q = threads[at.thread].messages[m].questions?.firstIndex(where: { $0.key == pick.key }) else {
        return refuse(404, "question_not_found", "That question is not on this message.")
      }
      guard let question = threads[at.thread].messages[m].questions?[q] else { continue }
      if question.state == .superseded { return refuse(422, "question_superseded", "This question was replaced by a newer one.") }
      if question.revision != pick.revision { return refuse(409, "question_revision_conflict", "This question changed. Read it again.") }
      sends.append((m, q))
    }
    seq += 1
    counter += 1
    let replyID = MessageID("msg_STANDINREPLY\(counter)")
    var answered: [String] = []
    for send in sends {
      guard var question = threads[at.thread].messages[send.message].questions?[send.question] else { continue }
      if let pick = (request.questions ?? []).first(where: { $0.key == question.key }), let answer = pick.answer { question.answer = answer }
      question.state = .sent
      question.sentRevision = question.revision
      question.sentReplyId = replyID.rawValue
      threads[at.thread].messages[send.message].questions?[send.question] = question
      if let answer = question.answer { answered.append(StandInData.words(of: answer)) }
    }
    let words = request.words ?? ""
    let now = StandInData.iso(Date())
    let written = InboxMessageWire(
      seq: seq, id: replyID, projectId: asked.projectId, threadId: asked.threadId, replyTo: message.rawValue, author: InboxAuthor(kind: .person),
      body: words.isEmpty && !answered.isEmpty ? "Answered: \(answered.joined(separator: "; "))" : words, createdAt: now,
      delivery: InboxDelivery(state: "queued", host: asked.author.host ?? "", session: asked.author.session ?? "", at: now))
    threads[at.thread].messages.append(written)
    unread.remove(asked.threadId)
    let wire = (try? JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(written))) ?? .null
    let result = ReplyResult(
      reply: wire, questions: threads[at.thread].messages[at.message].questions ?? [], replayed: false,
      threadRead: request.withThread == true ? model(threads[at.thread]) : nil)
    return encode(200, result)
  }

  // MARK: Answers

  private func encode<T: Encodable>(_ status: Int, _ value: T) -> DoorAnswerBytes {
    DoorAnswerBytes(status: status, headers: ["content-type": "application/json; charset=utf-8", "cache-control": "no-store"], body: (try? JSONEncoder().encode(value)) ?? Data("{}".utf8))
  }

  private func json(_ status: Int, _ fields: [String: JSONValue]) -> DoorAnswerBytes { encode(status, JSONValue.object(fields)) }

  private func refuse(_ status: Int, _ code: String, _ words: String, field: String? = nil, triesLeft: Int? = nil, key: String? = nil, extra: [String: JSONValue] = [:]) -> DoorAnswerBytes {
    encode(status, DoorError(error: words, code: code, field: field, triesLeft: triesLeft.map(Double.init), key: key, unknownFields: extra))
  }
}

/// The stand-in door as a way to it: what the demo and most tests hand the session.
public struct StandInTransport: DoorTransport {
  public let door: StandInDoor
  public init(door: StandInDoor) { self.door = door }
  public func send(_ call: DoorCall) async throws -> DoorAnswerBytes { try await door.handle(call) }
}
