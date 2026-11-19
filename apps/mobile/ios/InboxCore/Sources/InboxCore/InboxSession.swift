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
  /// Why something the person did was not taken.
  public enum Notice: Hashable, Sendable, Codable {
    /// The Inbox's own words for its refusal, and its code.
    case refused(String, code: String)
    /// An answer that was not the Inbox's: something between the phone and the computer refused it.
    case unreadable(status: Int)
    /// This Inbox does not offer it.
    case notOffered
    case appNeedsUpdate
  }

  /// Why a Send in a thread was refused, shown at the composer until the person sends again.
  public private(set) var notices: [ThreadID: Notice] = [:]
  /// Why a pick was refused, by question, until the person acts on that question again.
  public private(set) var refusals: [String: Notice] = [:]
  /// The words of a refused Send, to go back into the composer.
  public private(set) var returned: [ThreadID: String] = [:]
  /// Writes with no definite answer yet, oldest first.
  public private(set) var held: [HeldWrite] = []
  /// Threads with a Send on its way now.
  public private(set) var sending: Set<ThreadID> = []

  private let app: AppIdentity
  private let connector: DoorConnector
  private var copy: LocalCopy
  private var removed = false
  private var client: DoorClient?
  private var stream: Task<Void, Never>?
  private var reload: Task<Void, Never>?
  private var connecting: Task<Bool, Never>?
  private var retry: Task<Void, Never>?
  private var pumping: Set<String> = []
  private let retryEvery: Duration

  public init(computer: PairedComputer, app: AppIdentity, copy: LocalCopy = LocalCopy(folder: nil), retryEvery: Duration = .seconds(15), connector: @escaping DoorConnector) {
    self.retryEvery = retryEvery
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
    // Words a refused Send handed back, and why: kept until the composer takes them.
    let kept = copy.givenBack()
    for (thread, back) in kept {
      returned[ThreadID(thread)] = back.words
      notices[ThreadID(thread)] = back.notice
    }
    await refresh()
  }

  /// Read again: on launch, on return to the front, on pull to refresh.
  public func refresh() async {
    guard await connect() else { return }
    await resume()
  }

  /// The computer answers: send what waited, then read what it has now.
  private func resume() async {
    await flush()
    await readList()
    for id in threads.keys { await readThread(id) }
    listen()
  }

  public func stop() {
    stopListening()
    retry?.cancel()
    retry = nil
  }

  private func stopListening() {
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
                // Not a definite answer about this phone: the computer is treated as away, and asked again.
                if !failure.isDefinite { return .silent }
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
      stopListening()
      return false
    case .silent:
      client = nil
      reach = .away
      stopListening()
      if !held.isEmpty { retryLater() }
      return false
    }
  }

  /// What a refusal says about the pairing itself.
  private func note(_ failure: DoorFailure) {
    switch failure {
    case .appNeedsUpdate: standing = .appNeedsUpdate
    // Only a door that says the device is revoked, or that it does not know the token, has removed this phone.
    // A 401 with another code (a token something in between stripped) is tried again and erases nothing.
    case .refused where [.deviceRevoked, .deviceTokenInvalid].contains(failure.code):
      // The computer removed this phone: nothing of that computer stays here.
      standing = .removed
      stopListening()
      removed = true
      copy.erase()
      copy = LocalCopy(folder: nil)
      list = nil
      threads = [:]
      held = []
    case .unreachable:
      reach = .away
      client = nil
      stopListening()
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
    let waiting = held.filter { $0.thread == id.rawValue && $0.kind != .seen }
    if waiting.isEmpty { return model }
    for write in waiting where write.kind == .pick {
      guard let body = try? JSONDecoder().decode(DoorPicksBody.self, from: write.body), let message = model.thread.messages.firstIndex(where: { $0.id.rawValue == write.message }) else { continue }
      for pick in body.questions {
        guard let index = model.thread.messages[message].questions?.firstIndex(where: { $0.key == pick.key }) else { continue }
        model.thread.messages[message].questions?[index].answer = pick.answer
        model.thread.messages[message].questions?[index].state = pick.answer == nil ? .openValue : .picked
      }
    }
    // A Send that waits already carries these answers: they are no longer the person's to change, and a later
    // Send never carries them again (the Inbox refuses a reply that names a question already sent).
    // A Done or Can't do it the computer does not have yet: drawn as marked, in the draft.
    for write in waiting where write.kind == .action {
      guard let mark = try? JSONDecoder().decode(ActionMarks.Body.self, from: write.body), let message = model.thread.messages.firstIndex(where: { $0.id.rawValue == write.message }) else { continue }
      let key = write.path.split(separator: "/").last.map(String.init) ?? ""
      let result = mark.outcome.map { InboxActionResult(outcome: InboxActionResultOutcome(rawValue: $0), note: mark.note, at: Self.stamp(write.madeAt), by: .person, staged: true) }
      func draw(_ item: inout InboxQuestion) {
        item.actionResult = result
        item.state = result == nil ? .openValue : .picked
      }
      if let index = model.thread.messages[message].questions?.firstIndex(where: { $0.key == key }) { draw(&model.thread.messages[message].questions![index]) }
      if let index = model.thread.messages[message].actions?.firstIndex(where: { $0.key == key }) { draw(&model.thread.messages[message].actions![index]) }
    }
    for write in waiting where write.kind == .reply {
      guard let body = try? JSONDecoder().decode(DoorReplyBody.self, from: write.body) else { continue }
      for pick in (body.questions ?? []).map({ ($0.messageId, $0.key) }) + (body.actions ?? []).map({ ($0.messageId, $0.key) }) {
        let target = pick.0?.rawValue ?? write.message
        guard let message = model.thread.messages.firstIndex(where: { $0.id.rawValue == target }) else { continue }
        if let index = model.thread.messages[message].questions?.firstIndex(where: { $0.key == pick.1 }) { model.thread.messages[message].questions?[index].state = .sent }
        if let index = model.thread.messages[message].actions?.firstIndex(where: { $0.key == pick.1 }) { model.thread.messages[message].actions?[index].state = .sent }
      }
    }
    return model
  }

  private static func stamp(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }

  // MARK: Writing

  private func ref(_ message: String?, _ key: String) -> String { "\(message ?? "")/\(key)" }

  /// Why the computer did not take a pick on this question, until the person acts on the question again.
  public func refusal(message: MessageID, key: String) -> Notice? { refusals[ref(message.rawValue, key)] }

  /// Whether this question's pick is still on the phone only.
  public func isHeldPick(message: MessageID, key: String) -> Bool {
    held.contains { write in
      guard write.kind == .pick, write.message == message.rawValue, let body = try? JSONDecoder().decode(DoorPicksBody.self, from: write.body) else { return false }
      return body.questions.contains { $0.key == key }
    }
  }

  /// Whether a Send that waits for the computer carries this question's answer (or this action item's mark).
  public func isHeldSend(message: MessageID, key: String) -> Bool {
    held.contains { write in
      guard write.kind == .reply, let body = try? JSONDecoder().decode(DoorReplyBody.self, from: write.body) else { return false }
      return (body.questions ?? []).contains { $0.key == key && ($0.messageId?.rawValue ?? write.message) == message.rawValue }
        || (body.actions ?? []).contains { $0.key == key && ($0.messageId?.rawValue ?? write.message) == message.rawValue }
    }
  }

  /// Whether this action item's Done or Can't do it is still on the phone only.
  public func isHeldMark(message: MessageID, key: String) -> Bool {
    held.contains { $0.kind == .action && $0.message == message.rawValue && $0.path.hasSuffix("/\(key)") }
  }

  /// A reply's words that wait for the computer, oldest first: drawn in the thread as the person's own message.
  public func heldReplies(_ id: ThreadID) -> [HeldWrite] {
    held.filter { $0.kind == .reply && $0.thread == id.rawValue && !($0.words ?? "").isEmpty }
  }

  private func keepGivenBack() {
    var kept: [String: LocalCopy.GivenBack] = [:]
    for (thread, words) in returned { kept[thread.rawValue] = LocalCopy.GivenBack(words: words, notice: notices[thread]) }
    copy.saveGivenBack(kept)
  }

  private func hold(_ write: HeldWrite) {
    held.append(write)
    copy.saveOutbox(held)
  }

  private func settle(_ id: String) {
    held.removeAll { $0.id == id }
    copy.saveOutbox(held)
  }

  /// A write the computer will never take: say why where it was made, and never lose the person's words.
  private func giveBack(_ write: HeldWrite, _ notice: Notice) {
    let thread = ThreadID(write.thread)
    switch write.kind {
    case .pick:
      let questions = (try? JSONDecoder().decode(DoorPicksBody.self, from: write.body))?.questions ?? []
      // A refusal the thread itself says once read again (answered elsewhere, replaced, closed) adds no words.
      var quiet = false
      if case .refused(_, let code) = notice { quiet = PickConflict.saysItself(code) }
      for question in questions {
        if !quiet { refusals[ref(write.message, question.key)] = notice }
        // A Send made after this pick, for this answer alone, has nothing left to carry.
        dropFromLaterSends(after: write, message: write.message, key: question.key)
      }
    case .action:
      let key = write.path.split(separator: "/").last.map(String.init) ?? ""
      refusals[ref(write.message, key)] = notice
      dropFromLaterSends(after: write, message: write.message, key: key)
    case .reply:
      notices[thread] = notice
      if let words = write.words, !words.isEmpty {
        returned[thread] = [returned[thread], words].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
      }
      keepGivenBack()
    case .seen:
      break
    }
  }

  /// Take one question (or action item) out of the Sends made after `write`; a Send left with no answer, no
  /// action item and no words is not made at all.
  private func dropFromLaterSends(after write: HeldWrite, message: String?, key: String) {
    guard let start = held.firstIndex(where: { $0.id == write.id }) else { return }
    var emptied: [String] = []
    for index in held.indices where index > start && held[index].thread == write.thread && held[index].kind == .reply {
      guard var body = try? JSONDecoder().decode(DoorReplyBody.self, from: held[index].body) else { continue }
      let own = held[index].message
      let before = (body.questions?.count ?? 0) + (body.actions?.count ?? 0)
      body.questions?.removeAll { $0.key == key && ($0.messageId?.rawValue ?? own) == message }
      body.actions?.removeAll { $0.key == key && ($0.messageId?.rawValue ?? own) == message }
      guard (body.questions?.count ?? 0) + (body.actions?.count ?? 0) != before else { continue }
      if body.questions?.isEmpty == true { body.questions = nil }
      if body.actions?.isEmpty == true { body.actions = nil }
      if body.questions == nil, body.actions == nil, (body.words ?? "").isEmpty { emptied.append(held[index].id) } else { held[index].body = encode(body) }
    }
    held.removeAll { emptied.contains($0.id) }
    copy.saveOutbox(held)
  }

  /// Another place's answer landed first (PickConflict). True when the pick was dealt with quietly: saved again
  /// at the revision the Inbox holds now (it stays in the outbox with a new key), or dropped for the Inbox's answer.
  private func settleConflict(_ write: HeldWrite, _ failure: DoorFailure) async -> Bool {
    guard write.kind == .pick, let now = PickConflict.revision(failure), var body = try? JSONDecoder().decode(DoorPicksBody.self, from: write.body), let index = held.firstIndex(where: { $0.id == write.id }) else { return false }
    let message = MessageID(write.message ?? "")
    let stale = body.questions.map { ($0.key, $0.revision) }
    // The person's own later writes on this question name the revision this pick read: they go at the Inbox's.
    for (key, from) in stale { follow(after: write, message: message, key: key, from: from, to: now) }
    // A newer answer of it waits behind this one: that one decides.
    let newer = held.indices.contains { later in
      later > index && held[later].kind == .pick && held[later].message == write.message
        && ((try? JSONDecoder().decode(DoorPicksBody.self, from: held[later].body))?.questions.contains { q in stale.contains { $0.0 == q.key } } ?? false)
    }
    if !newer, case .retry(let revision)? = PickConflict.step(failure, tries: write.tries ?? 0) {
      // The refused key is spent: the same answer goes again as a new write, in the same place in the queue.
      var again = write
      let key = UUID().uuidString
      for q in body.questions.indices { body.questions[q].revision = revision }
      body.idempotencyKey = key
      again.id = key
      again.body = encode(body)
      again.tries = (write.tries ?? 0) + 1
      held[index] = again
      copy.saveOutbox(held)
      return true
    }
    // The Inbox's answer is drawn; a Send behind it carries that answer, at the Inbox's revision.
    settle(write.id)
    await readThread(ThreadID(write.thread))
    return true
  }

  /// Send one held write. True when it has a definite answer (applied or refused) and left the outbox.
  private func deliver(_ write: HeldWrite) async -> Bool {
    guard !removed, let client, let method = DoorMethod(rawValue: write.method) else { return false }
    // A route this Inbox does not list is never called, so no 404 is kept under the key.
    guard skew?.offers(write.route) ?? false else {
      settle(write.id)
      giveBack(write, .notOffered)
      return true
    }
    do {
      let answer = try await client.resend(method: method, path: write.path, body: write.body)
      if removed { return false }
      apply(write, answer)
      settle(write.id)
      return true
    } catch let failure as DoorFailure {
      if removed { return false }
      note(failure)
      guard failure.isDefinite else { return false }
      if await settleConflict(write, failure) { return true }
      // Words first, then the outbox: a refusal never leaves the phone with neither.
      switch failure {
      case .refused(_, let error): giveBack(write, .refused(error.error, code: error.code))
      case .unreadable(let status): giveBack(write, .unreadable(status: status))
      case .appNeedsUpdate: giveBack(write, .appNeedsUpdate)
      default: giveBack(write, .notOffered)
      }
      settle(write.id)
      // Show what the computer has now, beside the refusal.
      if write.kind != .seen { await readThread(ThreadID(write.thread)) }
      return true
    } catch {
      return false
    }
  }

  private func apply(_ write: HeldWrite, _ answer: DoorAnswerBytes) {
    let thread = ThreadID(write.thread)
    switch write.kind {
    case .pick:
      guard let picked = try? JSONDecoder().decode(DoorPicksAnswer.self, from: answer.body) else { return }
      // A saved pick raises its question's revision. Writes the person made after it, while it waited, still name
      // the revision this pick read: they follow it to the revision the computer answered, so the person's own
      // earlier pick never makes their later pick or Send stale.
      let sent = (try? JSONDecoder().decode(DoorPicksBody.self, from: write.body))?.questions ?? []
      for pick in sent {
        guard let now = picked.questions.first(where: { $0.key == pick.key })?.revision, now != pick.revision else { continue }
        follow(after: write, message: picked.messageId, key: pick.key, from: pick.revision, to: now)
      }
      guard var model = threads[thread], let index = model.thread.messages.firstIndex(where: { $0.id == picked.messageId }) else { return }
      // The answer holds the message's questions and action items together: keep each where it was.
      let byKey = Dictionary(picked.questions.map { ($0.key, $0) }, uniquingKeysWith: { $1 })
      model.thread.messages[index].questions = model.thread.messages[index].questions?.map { byKey[$0.key] ?? $0 }
      threads[thread] = model
      copy.saveThread(model)
    case .action:
      // The answer holds the message's questions and action items together: keep each where it was.
      guard let marked = try? JSONDecoder().decode(ActionMarks.Answer.self, from: answer.body), var model = threads[thread], let index = model.thread.messages.firstIndex(where: { $0.id.rawValue == write.message }) else { return }
      let byKey = Dictionary(marked.questions.map { ($0.key, $0) }, uniquingKeysWith: { $1 })
      model.thread.messages[index].questions = model.thread.messages[index].questions?.map { byKey[$0.key] ?? $0 }
      model.thread.messages[index].actions = model.thread.messages[index].actions?.map { byKey[$0.key] ?? $0 }
      threads[thread] = model
      copy.saveThread(model)
    case .reply:
      if let result = try? JSONDecoder().decode(ReplyResult.self, from: answer.body), let read = result.threadRead { take(read) }
    case .seen:
      break
    }
  }

  /// Move the later held writes of this thread that name one question at `from` to the revision the computer gave.
  private func follow(after write: HeldWrite, message: MessageID, key: String, from: Int64, to: Int64) {
    guard let start = held.firstIndex(where: { $0.id == write.id }) else { return }
    for index in held.indices where index > start && held[index].thread == write.thread {
      switch held[index].kind {
      case .pick:
        guard held[index].message == message.rawValue, var body = try? JSONDecoder().decode(DoorPicksBody.self, from: held[index].body) else { continue }
        for q in body.questions.indices where body.questions[q].key == key && body.questions[q].revision == from { body.questions[q].revision = to }
        held[index].body = encode(body)
      case .reply:
        guard var body = try? JSONDecoder().decode(DoorReplyBody.self, from: held[index].body), var questions = body.questions else { continue }
        for q in questions.indices where questions[q].key == key && questions[q].revision == from && (questions[q].messageId?.rawValue ?? held[index].message) == message.rawValue {
          questions[q].revision = to
        }
        body.questions = questions
        held[index].body = encode(body)
      case .seen, .action:
        break
      }
    }
    copy.saveOutbox(held)
  }

  /// Send a thread's held writes in the order made, each after the one before it has its answer. One pump per
  /// thread: a write made while another is on its way joins the same run.
  private func pump(_ thread: String) async {
    guard !pumping.contains(thread) else { return }
    pumping.insert(thread)
    defer { pumping.remove(thread) }
    if client == nil { _ = await connect() }
    while !removed, client != nil, standing == .ok, let next = held.first(where: { $0.thread == thread }) {
      if !(await deliver(next)) { break }
    }
    if held.contains(where: { $0.thread == thread }) { retryLater() }
  }

  /// Send what waited: every thread's queue, in the order made.
  private func flush() async {
    var seen: Set<String> = []
    for thread in held.map(\.thread) where seen.insert(thread).inserted { await pump(thread) }
  }

  /// While something waits and the computer does not answer, ask again now and then.
  private func retryLater() {
    guard retry == nil else { return }
    retry = Task { [weak self] in
      while let self, !Task.isCancelled {
        try? await Task.sleep(for: self.retryEvery)
        if Task.isCancelled { return }
        if self.held.isEmpty || self.standing != .ok { break }
        if await self.connect() { await self.resume() }
        if self.held.isEmpty { break }
      }
      self?.retry = nil
    }
  }

  private func encode<Body: Encodable>(_ body: Body) -> Data { (try? JSONEncoder().encode(body)) ?? Data("{}".utf8) }

  private func enqueue(kind: HeldWrite.Kind, thread: ThreadID, message: MessageID?, request: DoorRequest, body: Data, key: String, words: String? = nil) {
    hold(HeldWrite(id: key, kind: kind, thread: thread.rawValue, message: message?.rawValue, route: request.route.name, method: request.route.method.rawValue, path: request.path, body: body, madeAt: Date(), words: words))
  }

  private func markSeen(_ id: ThreadID) async {
    // Only while the computer answers: a look is told when it is made, never piled up while away.
    guard client != nil, reach == .here, let model = threads[id], offers(DoorRoutes.postThreadSeen) else { return }
    guard let newest = model.thread.messages.compactMap(\.seq).max() else { return }
    held.removeAll { $0.kind == .seen && $0.thread == id.rawValue }
    let key = UUID().uuidString
    enqueue(kind: .seen, thread: id, message: nil, request: Door.postThreadSeen(thread: id), body: encode(DoorSeenBody(idempotencyKey: key, throughSeq: newest)), key: key)
    await pump(id.rawValue)
  }

  /// Put one answer in the outbox now (nil takes it back), before anything else can run: a Send made right after
  /// already sees it. Returns false when this Inbox does not offer picks.
  @discardableResult
  public func hold(pick answer: QuestionAnswer?, thread: ThreadID, message: MessageID, question: InboxQuestion, confirmFull: Bool = false) -> Bool {
    guard canAnswer() else { return false }
    // The person acted on this question again: its last refusal has been read.
    refusals[ref(message.rawValue, question.key)] = nil
    let key = UUID().uuidString
    // `unsent_only`: refused when a reply already sent the question, so a pick can never race the phone's own Send.
    let body = QuestionAnswers.pickBody(key: question.key, revision: question.revision, answer: answer, unsentOnly: true, confirmFull: confirmFull, idempotencyKey: key)
    enqueue(kind: .pick, thread: thread, message: message, request: Door.postMessagePicks(message: message), body: encode(body), key: key)
    return true
  }

  /// Save one answer to the computer at once (nil takes it back). It is not sent to the agent until Send.
  public func pick(thread: ThreadID, message: MessageID, question: InboxQuestion, answer: QuestionAnswer?) async {
    guard hold(pick: answer, thread: thread, message: message, question: question) else { return }
    await pump(thread.rawValue)
  }

  /// One answer, picked and sent at once, to its own message and with nothing else: a permission prompt's answer,
  /// as the window's card sends it (packages/inbox/components/PermissionCard.tsx, `answer`). `confirmFull`: the
  /// person confirmed Full permissions here.
  public func answerNow(thread: ThreadID, message: MessageID, question: InboxQuestion, answer: QuestionAnswer, confirmFull: Bool = false) async {
    guard offers(DoorRoutes.postMessageReply) || skew == nil, hold(pick: answer, thread: thread, message: message, question: question, confirmFull: confirmFull) else { return }
    let key = UUID().uuidString
    // It names the revision the pick read; the pick's answer moves it to the one the pick made (`follow`).
    let body = DoorReplyBody(idempotencyKey: key, words: "", questions: [DoorQuestionPick(key: question.key, revision: question.revision)], withThread: true)
    enqueue(kind: .reply, thread: thread, message: message, request: Door.postMessageReply(message: message), body: encode(body), key: key)
    await pump(thread.rawValue)
    if client != nil { await readList() }
  }

  /// An action item's Done (with an optional note) or Can't do it (with the reason), or taking it back (nil).
  /// It waits in the reply draft and goes with the next Send, as in the window (`staged`; contract flow thread-09).
  /// Returns false when this Inbox does not offer it.
  @discardableResult
  public func mark(action: InboxQuestion, thread: ThreadID, message: MessageID, _ mark: ActionMarks.Mark?) async -> Bool {
    guard hold(mark: mark, action: action, thread: thread, message: message) else { return false }
    await pump(thread.rawValue)
    return true
  }

  /// Put a mark in the outbox now, before anything else can run: a Send made right after already follows it.
  @discardableResult
  public func hold(mark: ActionMarks.Mark?, action: InboxQuestion, thread: ThreadID, message: MessageID) -> Bool {
    guard canMarkActions() else { return false }
    refusals[ref(message.rawValue, action.key)] = nil
    let key = UUID().uuidString
    enqueue(kind: .action, thread: thread, message: message, request: Door.postMessageAction(message: message, action: action.key), body: encode(ActionMarks.body(mark, idempotencyKey: key)), key: key)
    return true
  }

  public func canMarkActions() -> Bool { standing == .ok && (skew == nil || offers(DoorRoutes.postMessageAction)) }

  /// Send what is in the outbox for a thread: what a screen calls after `hold(pick:)`.
  public func deliverHeld(thread: ThreadID) async { await pump(thread.rawValue) }

  /// Send: every saved pick in the thread, one reply per agent session, the words riding the last.
  /// False when there was nothing to send or nowhere to send it.
  @discardableResult
  public func send(thread id: ThreadID, words: String) async -> Bool {
    guard let model = thread(id), !sending.contains(id), !SendPlan.needsComputer(model.thread), offers(DoorRoutes.postMessageReply) || skew == nil else { return false }
    let text = words.trimmingCharacters(in: .whitespacesAndNewlines)
    let targets = SendPlan.targets(in: model.thread)
    guard !targets.isEmpty, !text.isEmpty || targets.contains(where: { !$0.questions.isEmpty || !$0.actions.isEmpty }) else { return false }
    sending.insert(id)
    defer { sending.remove(id) }
    notices[id] = nil
    returned[id] = nil
    keepGivenBack()
    // A reply with neither an answer nor words is never made: the Inbox refuses one ("write a reply or send at
    // least one answer"). So with no words, the agent that wrote last and asked nothing gets no reply.
    let carrying = targets.enumerated().filter { index, target in !target.questions.isEmpty || !target.actions.isEmpty || (index == targets.count - 1 && !text.isEmpty) }.map(\.element)
    for (index, target) in carrying.enumerated() {
      let last = index == carrying.count - 1
      let key = UUID().uuidString
      // The words ride the reply to the agent that wrote last, when that reply is made at all.
      let words = target.message == targets.last?.message ? text : ""
      let body = DoorReplyBody(idempotencyKey: key, words: words, questions: target.questions, actions: target.actions.isEmpty ? nil : target.actions, withThread: last ? true : nil)
      enqueue(kind: .reply, thread: id, message: target.message, request: Door.postMessageReply(message: target.message), body: encode(body), key: key, words: words.isEmpty ? nil : words)
    }
    await pump(id.rawValue)
    if client != nil { await readList() }
    return true
  }

  /// Whether Send has anything to carry for this thread.
  public func canSend(thread id: ThreadID, words: String) -> Bool {
    guard standing == .ok, let model = thread(id), offers(DoorRoutes.postMessageReply) || skew == nil, !SendPlan.needsComputer(model.thread) else { return false }
    return SendPlan.hasSomethingToSend(thread: model.thread, words: words) && !SendPlan.targets(in: model.thread).isEmpty
  }

  public func canAnswer() -> Bool { standing == .ok && (skew == nil || offers(DoorRoutes.postMessagePicks)) }

  /// A reply of this thread that waits for the computer.
  public func hasHeldReply(_ id: ThreadID) -> Bool { held.contains { $0.kind == .reply && $0.thread == id.rawValue } }

  public func clearNotice(_ id: ThreadID) { notices[id] = nil }

  /// The words of a Send the computer refused, handed back once for the composer.
  public func takeReturnedWords(_ id: ThreadID) -> String? {
    defer {
      returned[id] = nil
      keepGivenBack()
    }
    return returned[id]
  }

  /// Remove this phone from the computer, then forget the computer here. From the first line on, nothing of this
  /// computer is written again: a write still on its way cannot bring the erased copy back.
  public func removeThisPhone() async {
    removed = true
    stop()
    let old = copy
    copy = LocalCopy(folder: nil)
    held = []
    old.erase()
    if client == nil { _ = await connect() }
    try? await client?.revoke()
    old.erase()
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
