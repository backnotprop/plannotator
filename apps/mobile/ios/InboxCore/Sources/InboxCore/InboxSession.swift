import Foundation
import InboxWire
import Observation

/// The ways to one computer's door, best first. The app gives HTTPS transports; the demo and the tests give a
/// door in memory.
public typealias DoorConnector = @Sendable (PairedComputer) -> [any DoorTransport]

/// One paired computer as the screens see it: its list, its threads, and the person's writes on their way.
/// Every change ends in the same step: read what the computer says and replace the copy. The computer decides.
@MainActor
@Observable
public final class InboxSession {
  /// Whether the computer answers now. Drives the state dot.
  public enum Reach: Sendable { case connecting, here, away }

  /// Whether this app and this Inbox can work together.
  public enum Standing: Hashable, Sendable {
    case ok
    /// The Inbox refuses this app: "Update Plannotator on your phone".
    case appNeedsUpdate
    /// The Inbox is older than this app serves.
    case inboxNeedsUpdate
    /// The computer removed this phone.
    case removed
  }

  public let computer: PairedComputer
  public private(set) var reach: Reach = .connecting
  public private(set) var standing: Standing = .ok
  public private(set) var skew: DoorSkew?
  public private(set) var list: ListModel?
  /// True once the list was read from the computer or from the copy.
  public private(set) var listLoaded = false
  public private(set) var threads: [ThreadID: ThreadModel] = [:]
  /// Threads the computer says are not there.
  public private(set) var missingThreads: Set<ThreadID> = []
  /// The Inbox's own words for the last refusal in a thread, shown where the write was made.
  public private(set) var notices: [ThreadID: String] = [:]
  /// Writes with no definite answer yet, oldest first.
  public private(set) var held: [HeldWrite] = []
  /// Threads with a Send on its way now.
  public private(set) var sending: Set<ThreadID> = []

  private let app: AppIdentity
  private let connector: DoorConnector
  private let copy: LocalCopy
  private var client: DoorClient?
  private var stream: Task<Void, Never>?
  private var reload: Task<Void, Never>?
  private var connecting: Task<Bool, Never>?

  public init(computer: PairedComputer, app: AppIdentity, copy: LocalCopy = LocalCopy(folder: nil), connector: @escaping DoorConnector) {
    self.computer = computer
    self.app = app
    self.copy = copy
    self.connector = connector
  }

  // MARK: Reading

  /// Show the copy at once, then read from the computer.
  public func start() async {
    if list == nil, let kept = copy.list() {
      list = kept
      listLoaded = true
    }
    held = copy.outbox()
    await refresh()
  }

  /// Read again: on launch, on return to the front, on pull to refresh.
  public func refresh() async {
    guard await connect() else { return }
    await flush()
    await readList()
    for id in threads.keys { await readThread(id) }
    listen()
  }

  public func stop() {
    stream?.cancel()
    stream = nil
    reload?.cancel()
    reload = nil
  }

  /// Ask every way for `health` at once, three seconds each: the first to answer carries the session.
  private func connect() async -> Bool {
    if let connecting { return await connecting.value }
    let task = Task { await self.findPath() }
    connecting = task
    let found = await task.value
    connecting = nil
    return found
  }

  private func findPath() async -> Bool {
    if reach != .here { reach = .connecting }
    let token = computer.token
    let app = self.app
    let candidates = connector(computer).map { DoorClient(transport: $0, token: token, app: app) }
    enum Probe: Sendable { case answered(Int, HealthRead), refused(DoorFailure), silent }
    let probe = await withTaskGroup(of: Probe.self) { group -> Probe in
      for (index, candidate) in candidates.enumerated() {
        group.addTask {
          await withTaskGroup(of: Probe.self) { race in
            race.addTask {
              do { return .answered(index, try await candidate.health()) } catch let failure as DoorFailure {
                if case .unreachable = failure { return .silent }
                return .refused(failure)
              } catch { return .silent }
            }
            race.addTask {
              try? await Task.sleep(for: .seconds(3))
              return .silent
            }
            let first = await race.next() ?? .silent
            race.cancelAll()
            return first
          }
        }
      }
      var refusal: Probe?
      for await result in group {
        if case .answered = result {
          group.cancelAll()
          return result
        }
        if case .refused = result { refusal = result }
      }
      return refusal ?? .silent
    }
    switch probe {
    case .answered(let index, let read):
      client = candidates[index]
      skew = read.skew
      reach = .here
      switch read.skew {
      case .ok: standing = .ok
      case .appNeedsUpdate: standing = .appNeedsUpdate
      case .inboxNeedsUpdate: standing = .inboxNeedsUpdate
      }
      return standing == .ok
    case .refused(let failure):
      note(failure)
      reach = standing == .ok ? .away : .here
      return false
    case .silent:
      client = nil
      reach = .away
      stop()
      return false
    }
  }

  /// What a refusal says about the pairing itself.
  private func note(_ failure: DoorFailure) {
    switch failure {
    case .appNeedsUpdate: standing = .appNeedsUpdate
    case .refused(_, let error) where ["device_revoked", "device_token_invalid", "device_token_missing"].contains(error.code): standing = .removed
    case .unreachable:
      reach = .away
      client = nil
      stop()
    default: break
    }
  }

  private func offers(_ route: DoorRoute) -> Bool { skew?.offers(route) ?? false }

  private func readList() async {
    guard let client, offers(DoorRoutes.getThreads) else { return }
    do {
      let read = try await client.threads()
      list = read.model
      listLoaded = true
      copy.saveList(read.model)
    } catch let failure as DoorFailure {
      note(failure)
    } catch {}
  }

  /// A thread: the copy first, then the computer's answer in its place.
  public func open(_ id: ThreadID) async {
    if threads[id] == nil, let kept = copy.thread(id) { threads[id] = kept }
    if client == nil { _ = await connect() }
    await readThread(id)
    await markSeen(id)
  }

  private func readThread(_ id: ThreadID) async {
    guard let client, offers(DoorRoutes.getThread) else { return }
    do {
      let model = try await client.thread(id)
      take(model)
    } catch let failure as DoorFailure {
      if failure.code == .threadNotFound {
        threads[id] = nil
        missingThreads.insert(id)
      }
      note(failure)
    } catch {}
  }

  /// Never let an older answer replace a newer one for the same thread.
  private func take(_ model: ThreadModel) {
    let id = model.thread.threadId
    if let current = threads[id], current.cursor > model.cursor, current.serverSession == model.serverSession { return }
    threads[id] = model
    missingThreads.remove(id)
    copy.saveThread(model)
  }

  /// The thread with the person's held picks drawn over the computer's copy, so a pick made while the computer
  /// is away stays picked.
  public func thread(_ id: ThreadID) -> ThreadModel? {
    guard var model = threads[id] else { return nil }
    let picks = held.filter { $0.kind == .pick && $0.thread == id.rawValue }
    if picks.isEmpty { return model }
    for write in picks {
      guard let body = try? JSONDecoder().decode(DoorPicksBody.self, from: write.body), let message = model.thread.messages.firstIndex(where: { $0.id.rawValue == write.message }) else { continue }
      for pick in body.questions {
        guard let index = model.thread.messages[message].questions?.firstIndex(where: { $0.key == pick.key }) else { continue }
        model.thread.messages[message].questions?[index].answer = pick.answer
        model.thread.messages[message].questions?[index].state = pick.answer == nil ? .openValue : .picked
      }
    }
    return model
  }

  // MARK: Writing

  private func hold(_ write: HeldWrite) {
    held.append(write)
    copy.saveOutbox(held)
  }

  private func settle(_ id: String) {
    held.removeAll { $0.id == id }
    copy.saveOutbox(held)
  }

  /// Send one held write. True when it has a definite answer (applied or refused) and left the outbox.
  private func deliver(_ write: HeldWrite) async -> Bool {
    guard let client, let method = DoorMethod(rawValue: write.method) else { return false }
    // A route this Inbox does not list is never called, so no 404 is kept under the key.
    guard skew?.offers(write.route) ?? false else {
      settle(write.id)
      return true
    }
    let thread = ThreadID(write.thread)
    do {
      let answer = try await client.resend(method: method, path: write.path, body: write.body)
      settle(write.id)
      notices[thread] = nil
      apply(write, answer)
      return true
    } catch let failure as DoorFailure {
      note(failure)
      guard failure.isDefinite else { return false }
      settle(write.id)
      if case .refused(_, let error) = failure, write.kind != .seen { notices[thread] = error.error }
      return true
    } catch {
      return false
    }
  }

  private func apply(_ write: HeldWrite, _ answer: DoorAnswerBytes) {
    let thread = ThreadID(write.thread)
    switch write.kind {
    case .pick:
      guard let picked = try? JSONDecoder().decode(DoorPicksAnswer.self, from: answer.body), var model = threads[thread],
        let index = model.thread.messages.firstIndex(where: { $0.id == picked.messageId })
      else { return }
      // The answer holds the message's questions and action items together: keep each where it was.
      let byKey = Dictionary(picked.questions.map { ($0.key, $0) }, uniquingKeysWith: { $1 })
      model.thread.messages[index].questions = model.thread.messages[index].questions?.map { byKey[$0.key] ?? $0 }
      threads[thread] = model
      copy.saveThread(model)
    case .reply:
      if let result = try? JSONDecoder().decode(ReplyResult.self, from: answer.body), let read = result.threadRead { take(read) }
    case .seen:
      break
    }
  }

  /// Send what waited, in the order made. A write that still has no answer stops the ones behind it for its thread.
  private func flush() async {
    var stopped: Set<String> = []
    for write in held where !stopped.contains(write.thread) {
      if !(await deliver(write)) { stopped.insert(write.thread) }
    }
  }

  private func encode<Body: Encodable>(_ body: Body) -> Data { (try? JSONEncoder().encode(body)) ?? Data("{}".utf8) }

  private func write(kind: HeldWrite.Kind, thread: ThreadID, message: MessageID?, request: DoorRequest, body: Data, key: String) async -> Bool {
    let write = HeldWrite(id: key, kind: kind, thread: thread.rawValue, message: message?.rawValue, route: request.route.name, method: request.route.method.rawValue, path: request.path, body: body, madeAt: Date())
    // Behind an earlier write of this thread that still waits: keep the order.
    let behind = held.contains { $0.thread == thread.rawValue }
    hold(write)
    if behind || client == nil { return false }
    return await deliver(write)
  }

  private func markSeen(_ id: ThreadID) async {
    guard let model = threads[id], offers(DoorRoutes.postThreadSeen) else { return }
    guard let newest = model.thread.messages.compactMap(\.seq).max() else { return }
    let key = UUID().uuidString
    _ = await write(kind: .seen, thread: id, message: nil, request: Door.postThreadSeen(thread: id), body: encode(DoorSeenBody(idempotencyKey: key, throughSeq: newest)), key: key)
  }

  /// Save one answer to the computer at once (nil takes it back). It is not sent to the agent until Send.
  public func pick(thread: ThreadID, message: MessageID, question: InboxQuestion, answer: QuestionAnswer?) async {
    let key = UUID().uuidString
    // `unsent_only`: refused when a reply already sent the question, so a pick can never race the phone's own Send.
    let body = QuestionAnswers.pickBody(key: question.key, revision: question.revision, answer: answer, unsentOnly: true, idempotencyKey: key)
    let done = await write(kind: .pick, thread: thread, message: message, request: Door.postMessagePicks(message: message), body: encode(body), key: key)
    // A refused pick (a newer revision elsewhere, a replaced question): show what the computer has now.
    if done, notices[thread] != nil { await readThread(thread) }
  }

  /// Send: every saved pick in the thread, one reply per agent session, the words riding the last.
  /// False when there was nothing to send or nowhere to send it.
  @discardableResult
  public func send(thread id: ThreadID, words: String) async -> Bool {
    guard let model = thread(id), !sending.contains(id) else { return false }
    let text = words.trimmingCharacters(in: .whitespacesAndNewlines)
    let targets = SendPlan.targets(in: model.thread)
    guard !targets.isEmpty, !text.isEmpty || targets.contains(where: { !$0.questions.isEmpty }) else { return false }
    sending.insert(id)
    defer { sending.remove(id) }
    for (index, target) in targets.enumerated() {
      let last = index == targets.count - 1
      if !last, target.questions.isEmpty { continue }
      let key = UUID().uuidString
      let body = DoorReplyBody(idempotencyKey: key, words: last ? text : "", questions: target.questions, withThread: last ? true : nil)
      _ = await write(kind: .reply, thread: id, message: target.message, request: Door.postMessageReply(message: target.message), body: encode(body), key: key)
    }
    if client != nil { await readList() }
    return true
  }

  /// Whether Send has anything to carry for this thread.
  public func canSend(thread id: ThreadID, words: String) -> Bool {
    guard let model = thread(id), offers(DoorRoutes.postMessageReply) || skew == nil else { return false }
    return SendPlan.hasSomethingToSend(thread: model.thread, words: words) && !SendPlan.targets(in: model.thread).isEmpty
  }

  public func canAnswer() -> Bool { skew == nil || offers(DoorRoutes.postMessagePicks) }

  /// A reply of this thread that waits for the computer.
  public func hasHeldReply(_ id: ThreadID) -> Bool { held.contains { $0.kind == .reply && $0.thread == id.rawValue } }

  public func clearNotice(_ id: ThreadID) { notices[id] = nil }

  /// Remove this phone from the computer, then forget the computer here.
  public func removeThisPhone() async {
    stop()
    if client == nil { _ = await connect() }
    try? await client?.revoke()
    copy.erase()
  }

  // MARK: Live

  /// The door's event stream: each record means something changed, so read again shortly after.
  private func listen() {
    guard stream == nil, let client, offers(DoorRoutes.getEvents) else { return }
    let request = Door.getEvents()
    let call = DoorCall(method: .get, path: request.path, headers: client.headers(for: request, body: false).merging(["Accept": "text/event-stream"]) { $1 })
    let transport = client.transport
    stream = Task { [weak self] in
      var lastID: String?
      var wait = 1.0
      while !Task.isCancelled {
        var next = call
        if let lastID { next.headers["Last-Event-ID"] = lastID }
        do {
          guard let bytes = try await transport.events(next) else { return }
          var reader = EventStreamReader()
          for try await chunk in bytes {
            for frame in reader.feed(chunk) {
              wait = 1.0
              if frame.event == "record" { await MainActor.run { self?.reloadSoon() } }
            }
            if let id = reader.lastEventID { lastID = id }
          }
        } catch let failure as DoorFailure {
          await MainActor.run { self?.note(failure) }
          if failure.isDefinite { return }
        } catch {}
        if Task.isCancelled { return }
        try? await Task.sleep(for: .seconds(wait))
        wait = min(wait * 2, 30)
        guard let self, await MainActor.run(body: { self.reach == .here }) else { return }
      }
    }
  }

  private func reloadSoon() {
    reload?.cancel()
    reload = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(250))
      guard !Task.isCancelled, let self else { return }
      await self.readList()
      for id in self.threads.keys { await self.readThread(id) }
    }
  }
}
