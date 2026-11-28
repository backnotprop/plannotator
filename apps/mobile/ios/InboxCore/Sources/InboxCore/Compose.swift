import Foundation
import InboxWire

/// Who a new message goes to: one live agent session, as the computer listed it (`GET sessions`).
public struct ComposeTo: Codable, Hashable, Sendable {
  public var host: String
  public var session: String
  /// The session's own title, when its host keeps one.
  public var label: String?
  /// The project it works in, as the computer names it.
  public var project: String

  public init(host: String, session: String, label: String? = nil, project: String) {
    self.host = host
    self.session = session
    self.label = label
    self.project = project
  }

  public init(_ session: InboxComposeSession, in group: InboxComposeProject) {
    self.init(host: session.host, session: session.session, label: session.label, project: group.project.name)
  }
}

/// The new message being written: kept on the phone as it is typed, so closing the sheet, leaving the app or the app
/// being closed loses nothing (the window keeps its own as a draft on the computer; the door carries no draft writes).
public struct ComposeDraft: Codable, Hashable, Sendable {
  public var words: String
  public var to: ComposeTo?
  public var files: [DraftFile]
  public var editedAt: Date
  /// Why the computer did not take it, when a Send that waited was refused: the words are back, and this says why.
  public var notice: InboxSession.Notice?

  public init(words: String = "", to: ComposeTo? = nil, files: [DraftFile] = [], editedAt: Date, notice: InboxSession.Notice? = nil) {
    self.words = words
    self.to = to
    self.files = files
    self.editedAt = editedAt
    self.notice = notice
  }

  /// Nothing the person made is in it.
  public var isEmpty: Bool { words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && files.isEmpty }
}

/// The live sessions New message can send to, as last read.
public enum SessionsRead: Hashable, Sendable {
  case unread
  case reading
  /// What the computer answered just now.
  case live([InboxComposeProject])
  /// The computer does not answer: the sessions as last read (a Send waits on the phone, and the computer decides).
  case kept([InboxComposeProject])
  case unreachable
  case notOffered

  public var projects: [InboxComposeProject] {
    switch self {
    case .live(let projects), .kept(let projects): return projects
    default: return []
    }
  }
}

/// What New message's Send can do now. The words are the window's (packages/inbox/compose/ComposeDialog.tsx).
public enum ComposeReadiness: Hashable, Sendable {
  case ready
  /// No agent chosen: "Choose an agent to send it."
  case chooseAgent
  /// Neither words nor a file.
  case empty
  /// A file is not on the computer yet: "Wait for the files to finish uploading."
  case waitForFiles
  /// This Inbox does not take a new message from a phone.
  case notOffered

  /// The window's rule: one live session, words or a file, every file on the computer. A Send made while the
  /// computer is away waits on the phone (`POST messages` is a held write), as a reply does.
  public static func of(_ draft: ComposeDraft?, offered: Bool) -> ComposeReadiness {
    guard offered else { return .notOffered }
    guard let draft, !draft.isEmpty else { return .empty }
    guard draft.to != nil else { return .chooseAgent }
    if DraftFiles.carried(draft.files).isEmpty, draft.words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .empty }
    return DraftFiles.holdSend(draft.files) ? .waitForFiles : .ready
  }
}

/// What came of New message's Send.
public enum ComposeOutcome: Hashable, Sendable {
  /// The computer wrote the thread.
  case sent(thread: ThreadID, to: ComposeTo)
  /// It waits on the phone for the computer.
  case held
  /// The computer did not take it: the words and files are back in the draft, with why.
  case refused
  /// Nothing could be sent.
  case nothing
}

/// A new message that waits on the phone for the computer.
public struct HeldNew: Hashable, Sendable, Identifiable {
  public var id: String
  public var words: String
  public var to: ComposeTo?
  public var files: Int
}

extension LocalCopy {
  func keepSessions(_ projects: [InboxComposeProject]) { if let data = try? JSONEncoder().encode(projects) { write(data, to: "sessions.json") } }
  func keptSessions() -> [InboxComposeProject]? { read("sessions.json").flatMap { try? JSONDecoder().decode([InboxComposeProject].self, from: $0) } }
}

extension InboxSession {
  // MARK: New message

  /// The new message being written, if any.
  public var composeDraft: ComposeDraft? { draftBook.compose }
  public var sessions: SessionsRead { draftBook.sessions }

  /// Keep the new message as it stands now. An empty one with no agent chosen is not kept. `typing`: written once
  /// the typing pauses.
  public func keepCompose(_ draft: ComposeDraft?, typing: Bool = false) {
    if let draft, draft.isEmpty, draft.to == nil, draft.notice == nil {
      draftBook.compose = nil
    } else {
      draftBook.compose = draft
    }
    if typing { keepDraftsSoon() } else { keepDrafts() }
  }

  /// Change the new message's words or agent, and keep it: a change of the words only once the typing pauses.
  public func changeCompose(now: Date? = nil, _ change: (inout ComposeDraft) -> Void) {
    var draft = draftBook.compose ?? ComposeDraft(editedAt: now ?? clock.now())
    let before = draft
    change(&draft)
    guard draft != before else { return }
    let typing = draft.to == before.to && draft.files == before.files && draft.notice == before.notice
    draft.editedAt = now ?? clock.now()
    keepCompose(draft, typing: typing)
  }

  /// Throw the new message away, its files with it.
  public func discardCompose() {
    for file in draftBook.compose?.files ?? [] { removeFile(file.id, from: .compose) }
    keepCompose(nil)
  }

  public func composeReadiness() -> ComposeReadiness {
    guard standing == .ok else { return .notOffered }
    return ComposeReadiness.of(draftBook.compose, offered: skew == nil || offers(DoorRoutes.postMessages))
  }

  /// Read the live agent sessions (`GET sessions`). While the computer does not answer, the ones last read stay.
  public func readSessions() async {
    let projects = draftBook.sessions.projects
    let kept = copy.keptSessions() ?? (projects.isEmpty ? nil : projects)
    if draftBook.sessions == .unread { draftBook.sessions = kept.map { .kept($0) } ?? .reading }
    if client == nil { _ = await connect() }
    guard let client else {
      draftBook.sessions = kept.map { .kept($0) } ?? .unreachable
      return
    }
    guard offers(DoorRoutes.getSessions) else {
      draftBook.sessions = .notOffered
      return
    }
    do {
      let read = try await client.get(Door.getSessions(), as: DoorSessionsAnswer.self)
      draftBook.sessions = .live(read.projects)
      copy.keepSessions(read.projects)
    } catch let failure as DoorFailure {
      note(failure)
      draftBook.sessions = kept.map { .kept($0) } ?? .unreachable
    } catch {
      draftBook.sessions = kept.map { .kept($0) } ?? .unreachable
    }
  }

  /// Send the new message (`POST messages`). It is in the outbox, with its key, before anything is awaited: a
  /// Send made while the computer is away waits on the phone and goes when it answers.
  public func sendNew() async -> ComposeOutcome {
    guard composeReadiness() == .ready, let draft = draftBook.compose, let to = draft.to, let uploads = DraftFiles.uploads(draft.files) else { return .nothing }
    let key = UUID().uuidString
    let words = draft.words.trimmingCharacters(in: .whitespacesAndNewlines)
    let body = DoorComposeBody(idempotencyKey: key, to: DoorComposeBodyTo(host: to.host, session: to.session), body: words, uploads: uploads.isEmpty ? nil : uploads)
    let thread = Self.composeThread(key)
    enqueue(
      kind: .compose, thread: thread, message: nil, request: Door.postMessages(), body: (try? JSONEncoder().encode(body)) ?? Data("{}".utf8), key: key,
      words: words, subject: (try? JSONEncoder().encode(to)).map { String(decoding: $0, as: UTF8.self) })
    if let index = held.firstIndex(where: { $0.id == key }) {
      held[index].files = DraftFiles.carried(draft.files)
      saveOutbox()
    }
    // In the outbox now: the draft is spent. A refusal hands it back.
    draftBook.compose = nil
    keepDrafts()
    await pump(thread.rawValue)
    // Its key may change on the way (its files sent up again): the thread it stands in for does not.
    if held.contains(where: { $0.thread == thread.rawValue }) { return .held }
    if let sent = draftBook.sent.removeValue(forKey: thread.rawValue) {
      if client != nil { await readList() }
      return .sent(thread: sent, to: to)
    }
    return draftBook.compose?.notice != nil ? .refused : .nothing
  }

  /// The new messages that wait on the phone, oldest first.
  public func heldNewMessages() -> [HeldNew] {
    held.filter { $0.kind == .compose }.map { write in
      HeldNew(id: write.id, words: write.words ?? "", to: Self.composeTo(write), files: (write.files ?? []).count)
    }
  }

  static func composeThread(_ key: String) -> ThreadID { ThreadID("compose:\(key)") }

  static func composeTo(_ write: HeldWrite) -> ComposeTo? {
    write.subject.flatMap { try? JSONDecoder().decode(ComposeTo.self, from: Data($0.utf8)) }
  }

  /// The computer wrote the thread: the files' bytes are let go, and the Send says where it went.
  func composeSent(_ write: HeldWrite, _ answer: DoorAnswerBytes) {
    releaseBytes(write.files ?? [])
    if let made = try? JSONDecoder().decode(DoorComposeAnswer.self, from: answer.body) { draftBook.sent[write.thread] = made.threadId }
    book.needsListRead = true
  }

  /// The computer refused the new message: its words, agent and files come back to the draft, with why. Words
  /// written since go after them. Its files go up again only when the computer no longer has them.
  func composeGivenBack(_ write: HeldWrite, _ notice: Notice) {
    let now = draftBook.compose
    let words = [write.words ?? "", now?.words ?? ""].filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.joined(separator: "\n\n")
    let gone = Self.uploadsGone(notice)
    let files = (write.files ?? []).map { gone ? $0.again : $0 } + (now?.files ?? [])
    keepCompose(ComposeDraft(words: words, to: now?.to ?? Self.composeTo(write), files: files, editedAt: clock.now(), notice: notice))
  }
}
