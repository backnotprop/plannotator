import Foundation
import InboxCore
import InboxWire

/// A file the phone sent up (`POST uploads`), not yet named by a Send.
struct StandInUpload: Sendable {
  var record: InboxUpload
  var bytes: Data
}

/// New message and uploads on the stand-in computer, with the Inbox's own refusals (packages/server/inbox-compose.ts,
/// packages/shared/inbox/uploads.ts).
extension StandInDoor {
  /// The live agent sessions: every agent session that wrote in a thread, grouped by project, newest project first.
  /// `liveSessions` replaces them (an empty list: no agent is running).
  func sessionsModel() -> [InboxComposeProject] {
    if let set = state.liveSessions { return set }
    var groups: [String: InboxComposeProject] = [:]
    var order: [String] = []
    for thread in threads {
      for message in thread.messages.reversed() where message.author.kind == .agent {
        guard let session = message.author.session, !session.isEmpty, !session.hasPrefix("perm:"), let host = message.author.host else { continue }
        let key = thread.project.name
        if groups[key] == nil {
          groups[key] = InboxComposeProject(project: InboxComposeProjectProject(id: thread.project.id, name: thread.project.name, root: thread.project.root), sessions: [])
          order.append(key)
        }
        guard !(groups[key]?.sessions.contains { $0.session == session } ?? false) else { continue }
        groups[key]?.sessions.append(
          InboxComposeSession(session: session, host: host, startedAt: message.createdAt, lastSeenAt: message.createdAt, busy: false, idleSince: nil, lastThread: nil))
      }
    }
    return order.compactMap { groups[$0] }
  }

  /// Which sessions are running: `nil` puts back every agent that wrote; `[]` is no agent running.
  public func setLiveSessions(_ projects: [InboxComposeProject]?) { state.liveSessions = projects }

  /// Uploads the next Sends of new messages or replies are refused with, by code (`upload_refused`, say), with the
  /// field the Inbox names (`name`: the file itself; `body`: it could not be received).
  public func refuseUploads(_ code: String?, words: String = "Not attached: .env files often hold secrets.", field: String = "name") {
    state.refusesUploads = code.map { ($0, words, field) }
  }

  /// The computer sweeps its pending uploads (it drops those no draft on it names after a day; a phone's draft lives
  /// on the phone). Their keys still answer their old ids, as the door's command log does.
  public func sweepUploads() { state.uploads = [:] }

  /// The `POST uploads` calls the door received, for the tests.
  public var uploadCalls: [DoorCall] { calls.filter { $0.method == .post && $0.path == "uploads" } }

  /// New messages the computer wrote, newest last (the tests read them).
  public var startedThreads: [InboxThread] { threads.filter { state.started.contains($0.threadId) } }

  func sessionsAnswer() -> DoorAnswerBytes {
    encode(200, DoorSessionsAnswer(serverSession: session, projects: sessionsModel()))
  }

  /// `POST uploads?name=&idempotency_key=`: the file's own bytes.
  func keepUpload(_ call: DoorCall) -> DoorAnswerBytes {
    let query = Dictionary((call.query ?? []).map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { $1 })
    guard let key = query["idempotency_key"], !key.isEmpty else { return refuse(422, "validation_error", "idempotency_key: required on a phone's command (in the query for a file).", field: "idempotency_key") }
    if options.refusesMarkups == WireErrorCode.relayUploadUnavailable.rawValue {
      return refuse(413, WireErrorCode.relayUploadUnavailable.rawValue, "The relay does not carry files.")
    }
    // A key the door knows answers what it answered first, whether that upload is still pending or not.
    if let earlier = state.uploadKeys[key] { return encode(200, DoorUploadAnswer(upload: earlier)) }
    if let refusal = state.refusesUploads { return refuse(refusal.code == "upload_no_space" ? 507 : 422, refusal.code, refusal.words, field: refusal.field) }
    let bytes = call.body ?? Data()
    let name = query["name"].flatMap { $0.isEmpty ? nil : $0 } ?? "file"
    counter += 1
    let type = call.headers.first { $0.key.lowercased() == "content-type" }?.value
    let record = InboxUpload(
      uploadId: UploadID("upl_STANDIN\(counter)"), name: name, size: Int64(bytes.count), kind: Self.kind(of: name, type: type), sha256: Self.sha(bytes), createdAt: StandInData.iso(Date()), mediaType: type)
    if !options.sweepsUploads { state.uploads[record.uploadId.rawValue] = StandInUpload(record: record, bytes: bytes) }
    state.uploadKeys[key] = record
    return encode(200, DoorUploadAnswer(upload: record))
  }

  static func kind(of name: String, type: String?) -> InboxAttachmentKind {
    if type?.hasPrefix("image/") == true { return InboxAttachmentKind(rawValue: "image") }
    if type == "application/pdf" || name.lowercased().hasSuffix(".pdf") { return InboxAttachmentKind(rawValue: "pdf") }
    if name.lowercased().hasSuffix(".md") { return InboxAttachmentKind(rawValue: "markdown") }
    return InboxAttachmentKind(rawValue: "other")
  }

  /// The uploads a Send names, checked as the Inbox checks them; nil and a refusal when one is not pending.
  func takeUploads(_ fields: [String: JSONValue]) -> (uploads: [StandInUpload], refusal: DoorAnswerBytes?) {
    guard let listed = fields["uploads"], listed != .null else { return ([], nil) }
    guard case .array(let ids) = listed else { return ([], refuse(422, "validation_error", "uploads: a list of upload ids.", field: "uploads")) }
    var found: [StandInUpload] = []
    for value in ids {
      guard case .string(let id) = value, let upload = state.uploads[id] else { return ([], refuse(404, "upload_not_found", "That file is no longer here; attach it again.", field: "uploads")) }
      found.append(upload)
    }
    return (found, nil)
  }

  /// The files of a Send become the written message's attachments; the uploads are spent.
  func attach(_ uploads: [StandInUpload], thread: ThreadID, message: MessageID) {
    for upload in uploads {
      _ = addFile(thread: thread, message: message, name: upload.record.name, kind: upload.record.kind, bytes: upload.bytes, mediaType: upload.record.mediaType)
      state.uploads[upload.record.uploadId.rawValue] = nil
    }
  }

  /// The next new message is written and then answered `503`, as when the computer fails after writing: the door
  /// keeps no answer under 500, so the phone's retry meets the store's own replay.
  public func failNextComposeAnswer() { state.failsNextCompose = true }

  /// `POST messages`: a new thread to one live session (`409 session_not_live`, nothing written).
  func startThread(_ fields: [String: JSONValue]) -> DoorAnswerBytes {
    // A key the store wrote a thread under answers that thread again, with no project (store.ts personThreadByKey).
    if case .string(let key)? = fields["idempotency_key"], let made = state.startedByKey[key], let thread = threads.first(where: { $0.threadId == made }), let first = thread.messages.first {
      return encode(200, DoorComposeAnswer(threadId: made, message: first, project: nil, replayed: true))
    }
    guard case .object(let to)? = fields["to"], case .string(let session)? = to["session"], !session.isEmpty else {
      return refuse(422, "validation_error", "to.session: the live session to send to.", field: "to.session")
    }
    var words = ""
    if case .string(let text)? = fields["body"] { words = text }
    let taken = takeUploads(fields)
    if let refusal = taken.refusal { return refusal }
    if words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, taken.uploads.isEmpty { return refuse(422, "validation_error", "body: write a message.", field: "body") }
    guard let group = sessionsModel().first(where: { $0.sessions.contains { $0.session == session } }), let live = group.sessions.first(where: { $0.session == session }) else {
      return refuse(409, "session_not_live", "That session is not live any more: nothing was sent. Pick a live session, or save it as a draft.")
    }
    seq += 1
    counter += 1
    let id = MessageID("msg_STANDINNEW\(counter)")
    let thread = ThreadID(id.rawValue)
    let project = StandInData.project(group.project.name)
    let now = StandInData.iso(Date())
    let message = InboxMessageWire(
      seq: seq, id: id, projectId: ProjectID(project.id), threadId: thread, author: InboxAuthor(kind: .person), body: words, createdAt: now,
      to: InboxAddressee(host: live.host, session: live.session))
    let first = words.split(separator: "\n").first.map(String.init) ?? taken.uploads.first?.record.name ?? ""
    threads.insert(InboxThread(threadId: thread, project: project, subject: String(first.prefix(60)), messages: [message]), at: 0)
    state.started.append(thread)
    if case .string(let key)? = fields["idempotency_key"] { state.startedByKey[key] = thread }
    attach(taken.uploads, thread: thread, message: id)
    let written = threads.first { $0.threadId == thread }?.messages.first ?? message
    if state.failsNextCompose {
      state.failsNextCompose = false
      return refuse(503, "internal_error", "The Inbox failed after writing.")
    }
    return encode(200, DoorComposeAnswer(threadId: thread, message: written, project: DoorComposeAnswerProject(id: project.id, name: project.name, root: project.root), replayed: false))
  }
}
