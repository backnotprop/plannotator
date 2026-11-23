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
  public internal(set) var list: ListModel?
  /// True once the list was read from the computer or from the copy.
  public private(set) var listLoaded = false
  public private(set) var threads: [ThreadID: ThreadModel] = [:]
  /// Threads the computer says are not there.
  public internal(set) var missingThreads: Set<ThreadID> = []
  /// Why something the person did was not taken.
  public enum Notice: Hashable, Sendable, Codable {
    /// The Inbox's own words for its refusal, and its code.
    case refused(String, code: String)
    /// An answer that was not the Inbox's: something between the phone and the computer refused it.
    case unreadable(status: Int)
    /// This Inbox does not offer it.
    case notOffered
    case appNeedsUpdate
    /// The pick waited on this phone while another device answered: the Inbox's answer is shown, not this one.
    case gaveWay
  }

  /// A question the person picked on that the agent replaced before the pick went.
  public struct Stale: Hashable, Sendable {
    public var message: MessageID
    public var key: String
  }

  /// Picks an agent replaced before they went, by thread. While any stand, nothing is sent until the person
  /// chooses (the window's stale guard, packages/inbox/components/ReplacedQuestion.tsx `StaleGuard`).
  public private(set) var stale: [ThreadID: [Stale]] = [:]
  /// Threads where a Send stopped at such a replacement: the person is asked what to do.
  public private(set) var stopped: Set<ThreadID> = []

  /// Why a Send in a thread was refused, shown at the composer until the person sends again.
  public private(set) var notices: [ThreadID: Notice] = [:]
  /// Why a pick was refused, by question, until the person acts on that question again.
  public private(set) var refusals: [String: Notice] = [:]
  /// The field a refused pick's refusal names, by question (`DoorError.field`): what the app acts on, never the words.
  private var refusedFields: [String: String] = [:]
  /// The words of a refused Send, to go back into the composer.
  public internal(set) var returned: [ThreadID: String] = [:]
  /// Writes with no definite answer yet, oldest first.
  @ObservationIgnored public internal(set) var held: [HeldWrite] {
    _read {
      _ = drawMark
      yield heldStore
    }
    set {
      heldStore = newValue
      changed()
    }
    _modify {
      yield &heldStore
      changed()
    }
  }
  @ObservationIgnored private var heldStore: [HeldWrite] = []
  /// Moves when `held` or `book` changes: what draws them reads it. The writes of an act on several rows land
  /// quietly (`quietly`), and the batch moves it once at its end, so a thousand rows sent redraw the list once.
  private var drawMark = 0
  @ObservationIgnored private var quiet = 0
  @ObservationIgnored private var quietChanged = false
  @ObservationIgnored private var quietSave = false
  /// The senders of each act on several rows now on its way (BulkActs.swift), so `stop()` can end them.
  @ObservationIgnored var sendLanes: [String: [Task<Void, Never>]] = [:]

  private func changed() {
    if quiet > 0 { quietChanged = true } else { drawMark &+= 1 }
  }

  /// Run `body` with what it changes in `held` and `book` drawn later, and the outbox saved later (`endQuiet`):
  /// one write of a batch landing. `on` false runs it as any other change.
  func quietly<T>(_ on: Bool, _ body: () -> T) -> T {
    guard on else { return body() }
    quiet += 1
    defer { quiet -= 1 }
    return body()
  }

  /// A batch is over (sent, stopped or left waiting): what it changed is drawn once and the outbox saved once.
  /// A write landed and not yet saved as gone is sent again after a crash under its own key: the door replays it.
  func endQuiet() {
    if quietSave {
      quietSave = false
      copy.saveOutbox(held)
    }
    if quietChanged {
      quietChanged = false
      drawMark &+= 1
    }
  }
  /// Threads with a Send on its way now.
  public private(set) var sending: Set<ThreadID> = []

  /// Thread actions: what waits, what landed, the Undo on offer, why one was not taken (ThreadActionsSession.swift).
  @ObservationIgnored var book: ActionBook {
    _read {
      _ = drawMark
      yield bookStore
    }
    set {
      bookStore = newValue
      changed()
    }
    _modify {
      yield &bookStore
      changed()
    }
  }
  @ObservationIgnored private var bookStore = ActionBook()
  /// Reply drafts kept on the phone (ReplyDrafts.swift).
  var draftBook = DraftBook()
  /// Attachments: what the computer says of each, and the bytes kept on the phone (AttachmentsSession.swift).
  var files = FileBook()
  /// Comments on files that wait for a Send (FileCommentsSession.swift).
  var commentBook = CommentBook()
  /// The comment whose words the person is changing in its editor (`setEditing`): one that goes by itself waits for it.
  @ObservationIgnored public internal(set) var editingComment: String?
  /// Whether the phone splits a file's text into the window's blocks, by the bytes' cache key: read once, and never
  /// a reason to draw again.
  @ObservationIgnored var commentSplits: [String: Bool] = [:]
  /// Threads whose comments changed on the computer since they were last read (the event stream says so).
  @ObservationIgnored var commentsChanged: Set<ThreadID> = []
  let bytes: AttachmentCache?
  /// What time it is, and how the session waits for a time (a snooze's end).
  let clock: SessionClock

  private let app: AppIdentity
  private let connector: DoorConnector
  var copy: LocalCopy
  var removed = false
  var client: DoorClient?
  /// The way to the door in use: its place in the connector's list (best first), or nil while away.
  private(set) var pathIndex: Int?
  /// Drawings a way refused to carry (the relay takes no uploads), by held write, with the way that refused. Such a
  /// drawing is tried again only on another way; meanwhile it holds back only itself and its comment.
  @ObservationIgnored var parkedDrawings: [String: Int] = [:]
  /// Threads whose notice is a refusal given back with no words: kept across a relaunch like given-back words.
  @ObservationIgnored var noticesKept: Set<ThreadID> = []
  /// While a drawing waits for another way, the better ways are asked now and then (only with the app in front).
  var pathSearchEvery: Duration = .seconds(60)
  @ObservationIgnored private(set) var pathSearch: Task<Void, Never>?
  @ObservationIgnored private var inFront = true
  /// Sends whose comments' texts are being read before they go (a short wait, never past `feedbackTextWait`).
  @ObservationIgnored var resolving: Set<String> = []
  /// How long a Send waits for the texts its comments' lines are read from; after that they go with no line.
  var feedbackTextWait: Duration = .seconds(4)
  private var stream: Task<Void, Never>?
  private var reload: Task<Void, Never>?
  private var connecting: Task<Bool, Never>?
  private(set) var retry: Task<Void, Never>?
  private var pumping: Set<String> = []
  private let retryEvery: Duration

  public init(computer: PairedComputer, app: AppIdentity, copy: LocalCopy = LocalCopy(folder: nil), retryEvery: Duration = .seconds(15), bytes: AttachmentCache? = nil, clock: SessionClock = .system, connector: @escaping DoorConnector) {
    self.retryEvery = retryEvery
    self.clock = clock
    self.bytes = bytes
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
    // A write still on the phone from before the app was last closed has waited, however it was made: one tapped
    // as the app opened, with the app ended before the computer answered, never goes over an answer made since.
    held = copy.outbox().map { write in
      var write = write
      write.waited = true
      return write
    }
    // Words a refused Send handed back, and why: kept until the composer takes them.
    let kept = copy.givenBack()
    for (thread, back) in kept {
      if back.words.isEmpty { noticesKept.insert(ThreadID(thread)) } else { returned[ThreadID(thread)] = back.words }
      notices[ThreadID(thread)] = back.notice
    }
    loadDrafts()
    loadComments()
    armWake()
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
    pathSearch?.cancel()
    pathSearch = nil
    stopListening()
    book.wake?.cancel()
    book.wake = nil
    retry?.cancel()
    retry = nil
    // An act on several rows on its way stops after the writes already sent: the rest wait in the outbox.
    for lanes in sendLanes.values { for lane in lanes { lane.cancel() } }
  }

  private func stopListening() {
    stream?.cancel()
    stream = nil
    reload?.cancel()
    reload = nil
  }

  /// Ask every way for `health` at once, three seconds each: the first to answer carries the session.
  func connect() async -> Bool {
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
    // While a drawing waits for a way other than the relay, a better way that answers is taken over a faster one.
    let preferBetter = !parkedDrawings.isEmpty
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
      var best: (index: Int, read: HealthRead)?
      for await result in group {
        if case .answered(let index, let read) = result {
          if best.map({ index < $0.index }) ?? true { best = (index, read) }
          if !preferBetter || index == 0 {
            group.cancelAll()
            return .answered(best!.index, best!.read)
          }
        }
        if case .refused = result { refusal = result }
      }
      if let best { return .answered(best.index, best.read) }
      return refusal ?? .silent
    }
    switch probe {
    case .answered(let index, let read):
      client = candidates[index]
      // Another way than the one a drawing was refused on: what waited for it goes now.
      let wayChanged = pathIndex != index && !parkedDrawings.isEmpty
      pathIndex = index
      if wayChanged { Task { [weak self] in await self?.flush() } }
      lookForAnotherWay()
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
      if reach == .away { markWaited() }
      stopListening()
      return false
    case .silent:
      client = nil
      pathIndex = nil
      reach = .away
      markWaited()
      stopListening()
      if !held.isEmpty { retryLater() }
      return false
    }
  }

  /// The computer did not answer: everything still on the phone has waited, a tap made while the app was still
  /// connecting included. None of it goes over an answer made elsewhere meanwhile (PickConflict.decide).
  private func markWaited() {
    guard held.contains(where: { $0.waited != true }) else { return }
    for index in held.indices { held[index].waited = true }
    copy.saveOutbox(held)
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
      bytes?.erase()
      list = nil
      threads = [:]
      held = []
      draftBook = DraftBook()
    case .unreachable:
      reach = .away
      client = nil
      markWaited()
      stopListening()
    default: break
    }
  }

  func offers(_ route: DoorRoute) -> Bool { skew?.offers(route) ?? false }

  func readList() async {
    guard let client, offers(DoorRoutes.getThreads) else { return }
    let started = book.landSeq
    do {
      let read = try await client.threads()
      list = read.model
      listLoaded = true
      copy.saveList(read.model)
      // What landed before this read began is in it now: no longer drawn over it.
      book.landed.removeAll { $0.seq <= started }
      armWake()
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

  func readThread(_ id: ThreadID) async {
    guard let client, offers(DoorRoutes.getThread) else { return }
    do {
      let model = try await client.thread(id)
      take(model)
    } catch let failure as DoorFailure {
      if failure.code == .threadNotFound {
        threads[id] = nil
        missingThreads.insert(id)
        forgetComments(id)
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
        // The agent saw it done itself: only the person's note on it is theirs to change.
        if item.actionResult?.by == .agent {
          let at = item.actionResult?.person?.at ?? Self.stamp(write.madeAt)
          item.actionResult?.person = mark.outcome.map { InboxActionResultPerson(outcome: InboxActionResultPersonOutcome(rawValue: $0), note: mark.note, at: at) }
          return
        }
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

  private static let stamps: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  private static func stamp(_ date: Date) -> String { stamps.string(from: date) }

  // MARK: Writing

  private func ref(_ message: String?, _ key: String) -> String { "\(message ?? "")/\(key)" }

  /// Why the computer did not take a pick on this question, until the person acts on the question again.
  public func refusal(message: MessageID, key: String) -> Notice? { refusals[ref(message.rawValue, key)] }

  /// The field the Inbox named when it refused this question's pick (`confirm_full`, say), while that refusal stands.
  public func refusalField(message: MessageID, key: String) -> String? {
    refusals[ref(message.rawValue, key)] == nil ? nil : refusedFields[ref(message.rawValue, key)]
  }

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
    // A reply with words, or one that carries comments on files and no words: both are the person's, waiting.
    held.filter { $0.kind == .reply && $0.thread == id.rawValue && (!($0.words ?? "").isEmpty || heldComments($0) > 0) }
  }

  func keepGivenBack() {
    var kept: [String: LocalCopy.GivenBack] = [:]
    for (thread, words) in returned { kept[thread.rawValue] = LocalCopy.GivenBack(words: words, notice: notices[thread]) }
    // A refusal that gave back no words (a Send of only comments) is kept too, until it is read.
    noticesKept = noticesKept.filter { notices[$0] != nil }
    for thread in noticesKept where kept[thread.rawValue] == nil { kept[thread.rawValue] = LocalCopy.GivenBack(words: "", notice: notices[thread]) }
    copy.saveGivenBack(kept)
  }

  private func hold(_ write: HeldWrite) {
    held.append(write)
    // Several held at once (an act on many rows) are saved once, by the one that holds them.
    if !book.batching { copy.saveOutbox(held) }
  }

  /// Save the outbox as it stands (after several writes were held or taken back together).
  func saveOutbox() { copy.saveOutbox(held) }

  func settle(_ id: String) {
    held.removeAll { $0.id == id }
    // One write of a batch: the batch saves once at its end (`endQuiet`).
    if quiet > 0 { quietSave = true } else { copy.saveOutbox(held) }
  }

  /// A write the computer will never take: say why where it was made, and never lose the person's words.
  private func giveBack(_ write: HeldWrite, _ notice: Notice) {
    let thread = ThreadID(write.thread)
    switch write.kind {
    case .pick:
      let questions = (try? JSONDecoder().decode(DoorPicksBody.self, from: write.body))?.questions ?? []
      var code = ""
      if case .refused(_, let refused) = notice { code = refused }
      for question in questions {
        // A newer answer of the same question waits behind this one: that one decides, and says what comes of it.
        let newer = laterPick(after: write, key: question.key)
        // Said on the card only when an answer was lost (not for taking one back), as the window does.
        let says = question.answer != nil && !newer
        switch code {
        case "question_superseded":
          // The agent replaced the question: the card redraws as Replaced, and a Send stops until the person chooses.
          let ref = Stale(message: MessageID(write.message ?? ""), key: question.key)
          if !(stale[thread] ?? []).contains(ref) { stale[thread, default: []].append(ref) }
          if says { refusals[self.ref(write.message, question.key)] = notice }
          pullBackSends(after: write, notice: nil)
        case "question_already_sent":
          // It went with a reply while this save waited: that reply stands. A Send behind it goes without it.
          if says { refusals[self.ref(write.message, question.key)] = notice }
          dropFromLaterSends(after: write, message: write.message, key: question.key)
        default:
          // Not saved: the person is told, and a Send made after it does not go on without the answer.
          if !newer { refusals[self.ref(write.message, question.key)] = notice }
          pullBackSends(after: write, notice: notice)
        }
      }
    case .action:
      let key = write.path.split(separator: "/").last.map(String.init) ?? ""
      var code = ""
      if case .refused(_, let refused) = notice { code = refused }
      if !ActionMarks.mootNoteRefusal(quiet: write.quiet == true, code: code) { refusals[ref(write.message, key)] = notice }
      dropFromLaterSends(after: write, message: write.message, key: key)
    case .reply:
      notices[thread] = notice
      if let words = write.words, !words.isEmpty {
        returned[thread] = [returned[thread], words].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
      }
      keepGivenBack()
    case .seen:
      break
    case .state:
      noteRefusedAct(write, notice)
    case .annotation, .markup:
      // The comment stays on the phone with the reason, and rides no Send until it is saved; a Send made after it
      // goes without it, and nothing else of the Send is held back.
      let named = commentsNamed(by: write)
      commentRefused(write, notice)
      // A Send that carried only those comments cannot go at all: it leaves the queue, and the thread says why
      // (its comments stay, each with the reason).
      let emptied = releaseSends(after: write, without: named)
      if !emptied.isEmpty {
        held.removeAll { emptied.contains($0.id) }
        copy.saveOutbox(held)
        notices[ThreadID(write.thread)] = notice
        noticesKept.insert(ThreadID(write.thread))
        keepGivenBack()
      }
    case .annotationRemove:
      commentRefused(write, notice)
    }
  }

  private func laterPick(after write: HeldWrite, key: String) -> Bool {
    guard let start = held.firstIndex(where: { $0.id == write.id }) else { return false }
    return held.indices.contains { later in
      later > start && held[later].kind == .pick && held[later].message == write.message
        && ((try? JSONDecoder().decode(DoorPicksBody.self, from: held[later].body))?.questions.contains { $0.key == key } ?? false)
    }
  }

  /// Nothing goes on without an answer the person meant to send: the Sends made after `write` are taken back, their
  /// words returned to the reply field, and (when there is something to say) the reason shown there.
  private func pullBackSends(after write: HeldWrite, notice: Notice?) {
    guard let start = held.firstIndex(where: { $0.id == write.id }) else { return }
    let thread = ThreadID(write.thread)
    let pulled = held.indices.filter { $0 > start && held[$0].thread == write.thread && held[$0].kind == .reply }.map { held[$0] }
    guard !pulled.isEmpty else { return }
    var more = false
    for reply in pulled {
      if let words = reply.words, !words.isEmpty {
        returned[thread] = [returned[thread], words].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
        more = true
      }
      let body = try? JSONDecoder().decode(DoorReplyBody.self, from: reply.body)
      if (body?.questions?.count ?? 0) + (body?.actions?.count ?? 0) > 1 { more = true }
    }
    held.removeAll { item in pulled.contains { $0.id == item.id } }
    copy.saveOutbox(held)
    if !(stale[thread] ?? []).isEmpty { stopped.insert(thread) }
    // A reply that carried only this one answer and no words (a permission prompt's) has nothing more to say.
    if more, let notice { notices[thread] = notice }
    keepGivenBack()
  }

  /// The person chose at the stale guard: it is shown once for each replacement.
  public func clearStale(_ id: ThreadID) {
    stale[id] = nil
    stopped.remove(id)
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
    guard write.kind == .pick, let now = PickConflict.revision(failure), var body = try? JSONDecoder().decode(DoorPicksBody.self, from: write.body), held.contains(where: { $0.id == write.id }) else { return false }
    let message = MessageID(write.message ?? "")
    let stale = body.questions.map { ($0.key, $0.revision) }
    // What the Inbox holds now is read before anything is decided.
    await readThread(ThreadID(write.thread))
    guard let index = held.firstIndex(where: { $0.id == write.id }) else { return true }
    // A newer answer of it waits behind this one: that one decides, and meets the Inbox's answer itself.
    if stale.contains(where: { laterPick(after: write, key: $0.0) }) {
      settle(write.id)
      return true
    }
    let inbox = threads[ThreadID(write.thread)]?.thread.messages.first { $0.id == message }?.questions ?? []
    let current = inbox.first { q in stale.contains { $0.0 == q.key } }
    var outcome = PickConflict.decide(
      failure, tries: write.tries ?? 0, waited: write.waited == true, tapped: write.madeAt,
      inboxAnswered: current?.answer != nil, inboxPickedAt: current?.pickedAt.flatMap { TimeWords.date($0) })
    // The other place chose what the phone chose: nothing gave way, and nothing is said.
    if outcome == .giveWay, body.questions.allSatisfy({ pick in QuestionAnswers.same(pick.answer, inbox.first { $0.key == pick.key }?.answer) }) { outcome = .adopt }
    switch outcome {
    case .retry(let revision)?:
      // The person's own later writes on this question name the revision this pick read: they go at the Inbox's.
      for (key, from) in stale { follow(after: write, message: message, key: key, from: from, to: revision) }
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
    case .giveWay?:
      // An old pick never goes over a newer answer made elsewhere: that answer is shown, the person is told in
      // one line, and a Send made behind this pick waits for them to look.
      if body.questions.contains(where: { $0.answer != nil }) {
        for (key, _) in stale { refusals[ref(write.message, key)] = .gaveWay }
        pullBackSends(after: write, notice: .refused("", code: "question_revision_conflict"))
      }
    case .lost?:
      // Refused every time, and nothing in the Inbox: the card says the pick was not saved, and a Send behind it
      // waits for the person, as when it gives way.
      for (key, _) in stale { refusals[ref(write.message, key)] = .refused("", code: "question_revision_conflict") }
      pullBackSends(after: write, notice: .refused("", code: "question_revision_conflict"))
    default:
      // The Inbox's answer is drawn, quietly; a Send behind it carries that answer, at the Inbox's revision.
      for (key, from) in stale { follow(after: write, message: message, key: key, from: from, to: now) }
    }
    settle(write.id)
    return true
  }

  /// Send one held write. True when it has a definite answer (applied or refused) and left the outbox.
  /// `quiet`: one write of a batch, drawn and saved with the batch (`quietly`).
  private func deliver(_ write: HeldWrite, quiet: Bool = false) async -> Bool {
    guard !removed, let client, let method = DoorMethod(rawValue: write.method) else { return false }
    // A route this Inbox does not list is never called, so no 404 is kept under the key.
    guard skew?.offers(write.route) ?? false else {
      settle(write.id)
      giveBack(write, .notOffered)
      return true
    }
    // A thread action that waited meets the computer's row first: it never goes over a newer change made elsewhere.
    if write.kind == .state, await settleWaitedAct(write) { return true }
    // Taken back (Undo) while the computer's row was read: nothing goes.
    guard held.contains(where: { $0.id == write.id }) else { return true }
    // A drawing no comment names any more (removed while it waited): it never goes, and nothing else is touched.
    if write.kind == .markup, let hash = write.subject, !drawingNamed(hash) {
      quietly(quiet) { settle(write.id) }
      forgetDrawing(hash)
      return true
    }
    // A comment's save (or a Send) that names a drawing the computer has not kept, with nothing ahead to keep it,
    // never goes: it would name a picture that is not there.
    if namesMissingDrawing(write) {
      quietly(quiet) {
        giveBack(write, .notOffered)
        settle(write.id)
      }
      return true
    }
    // A comment's save is marked as possibly arrived before it leaves, and kept so: if the app ends while it is on its
    // way, a removal made later still follows it.
    var markedNow = false
    if write.kind == .annotation, let index = held.firstIndex(where: { $0.id == write.id }), held[index].mayHaveArrived != true {
      held[index].mayHaveArrived = true
      copy.saveOutbox(held)
      markedNow = true
    }
    quietly(quiet) { _ = book.inFlight.insert(write.id) }
    defer { quietly(quiet) { _ = book.inFlight.remove(write.id) } }
    do {
      let answer: DoorAnswerBytes
      if write.kind == .markup {
        // A drawing is its own bytes, its key in the query (the door's raw-body rule).
        guard let drawing = write.subject.flatMap(drawing) else { throw DoorFailure.notOffered(route: write.route) }
        answer = try await client.sendBytes(path: write.path, query: [URLQueryItem(name: "idempotency_key", value: write.id)], body: drawing, type: "image/png")
      } else {
        answer = try await client.resend(method: method, path: write.path, body: write.body)
      }
      if removed { return false }
      quietly(quiet) {
        apply(write, answer)
        settle(write.id)
      }
      return true
    } catch let failure as DoorFailure {
      if removed { return false }
      note(failure)
      guard failure.isDefinite else {
        // Sent, and no definite answer: the computer may have taken it.
        var arrives = false
        if case .unreachable(_, mayHaveArrived: false) = failure {
          // This try never left. The mark goes only if this try set it: an earlier one (before the app last ended,
          // or with no answer) may still have arrived.
          if markedNow, let index = held.firstIndex(where: { $0.id == write.id }), held[index].mayHaveArrived == true {
            held[index].mayHaveArrived = nil
            copy.saveOutbox(held)
          }
        } else {
          book.inDoubt.insert(write.id)
          arrives = true
        }
        if let index = held.firstIndex(where: { $0.id == write.id }), held[index].waited != true || (arrives && held[index].mayHaveArrived != true) {
          held[index].waited = true
          if arrives { held[index].mayHaveArrived = true }
          copy.saveOutbox(held)
        }
        return false
      }
      if await settleConflict(write, failure) { return true }
      // A drawing removed while it was on its way: its refusal is no one's, and nothing else is touched.
      if write.kind == .markup, let hash = write.subject, !drawingNamed(hash) {
        quietly(quiet) { settle(write.id) }
        forgetDrawing(hash)
        return true
      }
      // A drawing this way cannot carry (the relay takes no uploads): it waits, with its comment's save, for another
      // way, and is not tried again on this one. Everything else in the thread goes on; a Send that carried its
      // comment goes without it (the comment is back in the list, "Needs your computer's network", and goes by
      // itself once the drawing is there).
      if write.kind == .markup, case .refused(_, let error) = failure, error.code == WireErrorCode.relayUploadUnavailable.rawValue {
        parkedDrawings[write.id] = pathIndex ?? -1
        lookForAnotherWay()
        if let index = held.firstIndex(where: { $0.id == write.id }), held[index].waited != true {
          held[index].waited = true
          copy.saveOutbox(held)
        }
        return true
      }
      // The race at Send itself: the agent replaced a picked question as the person sent. Nothing went.
      if write.kind == .reply, case .refused(_, let error) = failure, error.code == "question_superseded", let key = error.key,
        let asked = threads[ThreadID(write.thread)]?.thread.messages.first(where: { message in (message.questions ?? []).contains { $0.key == key && $0.state == .picked } }) {
        let ref = Stale(message: asked.id, key: key)
        if !(stale[ThreadID(write.thread)] ?? []).contains(ref) { stale[ThreadID(write.thread), default: []].append(ref) }
        stopped.insert(ThreadID(write.thread))
      }
      // Words first, then the outbox: a refusal never leaves the phone with neither.
      quietly(quiet) {
        switch failure {
        case .refused(_, let error):
          if write.kind == .pick, let body = try? JSONDecoder().decode(DoorPicksBody.self, from: write.body) {
            for question in body.questions { refusedFields[ref(write.message, question.key)] = error.field }
          }
          // A comment the Send named is not waiting on the computer: dealt with now, so the next Send goes.
          if write.kind == .reply, [WireErrorCode.annotationNotFound.rawValue, WireErrorCode.annotationClosed.rawValue].contains(error.code) {
            replyNamedGoneComment(write, code: error.code, field: error.field, notice: .refused(error.error, code: error.code))
          }
          giveBack(write, .refused(error.error, code: error.code))
        case .unreadable(let status): giveBack(write, .unreadable(status: status))
        case .appNeedsUpdate: giveBack(write, .appNeedsUpdate)
        default: giveBack(write, .notOffered)
        }
        settle(write.id)
      }
      // Show what the computer has now, beside the refusal.
      if write.kind != .seen, write.kind != .state { await readThread(ThreadID(write.thread)) }
      // A refused Send that carried comments: the computer's list of them is read again (the window may have sent or
      // removed some), and a comment it does not have is held back from the next Send.
      if write.kind == .reply, case .refused(_, let error) = failure { await rereadAfterRefusedSend(write, notice: .refused(error.error, code: error.code)) }
      return true
    } catch {
      book.inDoubt.insert(write.id)
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
      commentsSent(write)
      if let result = try? JSONDecoder().decode(ReplyResult.self, from: answer.body), let read = result.threadRead { take(read) }
    case .seen:
      break
    case .state:
      landAct(write, answer)
    case .annotation:
      commentSaved(write, answer)
    case .annotationRemove:
      commentRemoved(write)
    case .markup:
      drawingKept(write, answer)
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
      case .seen, .action, .state, .annotation, .annotationRemove, .markup:
        break
      }
    }
    copy.saveOutbox(held)
  }

  /// Send a thread's held writes in the order made, each after the one before it has its answer. One pump per
  /// thread: a write made while another is on its way joins the same run.
  /// `readsList` false: the caller reads the list once itself, after pumping several threads. `quiet`: a batch's
  /// thread, drawn and saved with the batch.
  func pump(_ thread: String, readsList: Bool = true, quiet: Bool = false) async {
    guard !pumping.contains(thread) else { return }
    pumping.insert(thread)
    defer { pumping.remove(thread) }
    // A Send never waits on a drawing: a comment whose drawing cannot reach the computer now leaves it, for the list.
    releaseHeldBackSends(thread)
    if client == nil { _ = await connect() }
    quietly(quiet) { book.checked = false }
    while !removed, client != nil, standing == .ok {
      // A comment the person sent while its drawing could not go, once the drawing is there: its own Send.
      sendOwed(ThreadID(thread))
      guard let next = held.first(where: { $0.thread == thread && !heldBack($0) }) else { break }
      // A Send whose comments' texts are being read waits for them, briefly (`feedbackTextWait`).
      if resolving.contains(next.id) { break }
      // A Send that carries a comment held back with its drawing goes without it.
      if next.kind == .reply, releaseHeldBackComments(next) { continue }
      if !(await deliver(next, quiet: quiet)) { break }
    }
    // A thread action landed: the list is read again, so its row comes from the computer.
    if readsList, book.needsListRead, client != nil, !removed {
      book.needsListRead = false
      await readList()
    }
    // Left on the phone (the computer away, refused, or in need of an update): what is left has waited. Not what
    // waits only for a drawing this way cannot carry: that waits for another way, not for the computer, and asks
    // nothing again until one answers.
    if held.contains(where: { $0.thread == thread && !heldBack($0) }) {
      markWaited()
      retryLater()
    }
  }

  /// Send what waited: every thread's queue, in the order made.
  private func flush() async {
    var seen: Set<String> = []
    for thread in held.map(\.thread) where seen.insert(thread).inserted { await pump(thread) }
  }

  /// The app is in front (or not): the search for a better way runs only in front.
  public func setInFront(_ on: Bool) {
    inFront = on
    if on {
      lookForAnotherWay()
    } else {
      pathSearch?.cancel()
      pathSearch = nil
    }
  }

  /// While a drawing waits for a way other than the one in use (the relay takes no uploads), the better ways (the
  /// Wi-Fi, the tailnet) are asked every `pathSearchEvery`; the first that answers carries the session, and what
  /// waited goes. No timer otherwise: it stops once nothing waits for another way, or the app is not in front.
  func lookForAnotherWay() {
    guard pathSearch == nil, inFront, !removed, parkedDrawings.values.contains(where: { $0 > 0 }) else { return }
    pathSearch = Task { [weak self] in
      while let self, !Task.isCancelled {
        try? await Task.sleep(for: self.pathSearchEvery)
        guard !Task.isCancelled, self.inFront, !self.removed, let current = self.pathIndex, current > 0,
          self.parkedDrawings.values.contains(current)
        else { break }
        if await self.takeBetterWay(than: current) { break }
      }
      self?.pathSearch = nil
    }
  }

  /// Ask each way better than `current` for `health`, best first; take the first that answers.
  private func takeBetterWay(than current: Int) async -> Bool {
    let token = computer.token
    let app = self.app
    let candidates = connector(computer).map { DoorClient(transport: $0, token: token, app: app) }
    for index in 0..<min(current, candidates.count) {
      let candidate = candidates[index]
      let read = await withTaskGroup(of: HealthRead?.self) { race in
        race.addTask { try? await candidate.health() }
        race.addTask {
          try? await Task.sleep(for: .seconds(3))
          return nil
        }
        let first = await race.next() ?? nil
        race.cancelAll()
        return first
      }
      guard let read, case .ok = read.skew, !removed else { continue }
      client = candidate
      pathIndex = index
      skew = read.skew
      stopListening()
      listen()
      await flush()
      return true
    }
    return false
  }

  #if DEBUG
    /// Debug builds only, for the stand-in's stages: the phone is back on the computer's network, so a drawing the
    /// relay refused goes now (the stand-in has one way, which plays both).
    public func standInBackOnNetwork() async {
      parkedDrawings = [:]
      await flush()
    }
  #endif

  /// While something waits and the computer does not answer, ask again now and then.
  func retryLater() {
    guard retry == nil else { return }
    retry = Task { [weak self] in
      while let self, !Task.isCancelled {
        try? await Task.sleep(for: self.retryEvery)
        if Task.isCancelled { return }
        if self.held.isEmpty || self.onlyHeldBack() || self.standing != .ok { break }
        if await self.connect() { await self.resume() }
        if self.held.isEmpty || self.onlyHeldBack() { break }
      }
      self?.retry = nil
    }
  }

  private func encode<Body: Encodable>(_ body: Body) -> Data { (try? JSONEncoder().encode(body)) ?? Data("{}".utf8) }

  func enqueue(kind: HeldWrite.Kind, thread: ThreadID, message: MessageID?, request: DoorRequest, body: Data, key: String, words: String? = nil, quiet: Bool = false, act: ThreadAct? = nil, shown: ShownState? = nil, waited: Bool = false, undoes: String? = nil, subject: String? = nil) {
    // Made while the computer does not answer: it waits, and so never goes over a newer answer made elsewhere.
    // Not while it is still connecting: a tap made as the app opens is sent the moment the computer answers, and
    // has waited if it turns out not to (markWaited).
    let waits = waited || reach == .away
    var write = HeldWrite(id: key, kind: kind, thread: thread.rawValue, message: message?.rawValue, route: request.route.name, method: request.route.method.rawValue, path: request.path, body: body, madeAt: clock.now(), words: words, waited: waits ? true : nil, quiet: quiet ? true : nil, act: act)
    write.shown = shown
    write.undoes = undoes
    write.subject = subject
    hold(write)
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
  public func mark(action: InboxQuestion, thread: ThreadID, message: MessageID, _ mark: ActionMarks.Mark?) async -> ActionMarks.Taken {
    guard hold(mark: mark, action: action, thread: thread, message: message) else { return .notOffered }
    // A note's autosave may be on its way: this mark goes after it, and its own answer is waited for, so a
    // refusal is never mistaken for "waits".
    while pumping.contains(thread.rawValue) { try? await Task.sleep(for: .milliseconds(15)) }
    await pump(thread.rawValue)
    // Only what the computer answered counts: a refused mark leaves what the person typed where it is.
    if refusals[ref(message.rawValue, action.key)] != nil { return .refused }
    return isHeldMark(message: message, key: action.key) ? .waits : .saved
  }

  /// Put a mark in the outbox now, before anything else can run: a Send made right after already follows it.
  /// `quiet`: a note typed under the marked row (`note_only`).
  @discardableResult
  public func hold(mark: ActionMarks.Mark?, action: InboxQuestion, thread: ThreadID, message: MessageID, quiet: Bool = false) -> Bool {
    guard canMarkActions() else { return false }
    refusals[ref(message.rawValue, action.key)] = nil
    let key = UUID().uuidString
    enqueue(kind: .action, thread: thread, message: message, request: Door.postMessageAction(message: message, action: action.key), body: encode(ActionMarks.body(mark, quiet: quiet, idempotencyKey: key)), key: key, quiet: quiet)
    return true
  }

  public func canMarkActions() -> Bool { standing == .ok && (skew == nil || offers(DoorRoutes.postMessageAction)) }

  /// Send what is in the outbox for a thread: what a screen calls after `hold(pick:)`.
  public func deliverHeld(thread: ThreadID) async { await pump(thread.rawValue) }

  /// Send: every saved pick in the thread, one reply per agent session, the words riding the last.
  /// False when there was nothing to send or nowhere to send it.
  @discardableResult
  public func send(thread id: ThreadID, words: String, pastGuard: Bool = false, clearDraft: String? = nil) async -> Bool {
    // A pick of theirs was replaced before it went: nothing is sent until the person chooses.
    if !(stale[id] ?? []).isEmpty, !pastGuard {
      stopped.insert(id)
      return false
    }
    stale[id] = nil
    stopped.remove(id)
    guard let model = thread(id), !sending.contains(id), !SendPlan.needsComputer(model.thread), offers(DoorRoutes.postMessageReply) || skew == nil else { return false }
    let text = words.trimmingCharacters(in: .whitespacesAndNewlines)
    let targets = SendPlan.targets(in: model.thread)
    // Comments whose drawing cannot reach the computer now (away from its network): no Send carries them, and none
    // waits for them. They stay in the list, marked, and each goes by itself once its drawing is there.
    let owing = commentsToOwe(id)
    guard !targets.isEmpty, !text.isEmpty || !commentsToSend(id).isEmpty || !owing.isEmpty || targets.contains(where: { !$0.questions.isEmpty || !$0.actions.isEmpty }) else { return false }
    sending.insert(id)
    defer { sending.remove(id) }
    // The comments on files that wait: they ride the last reply, with the words (the window's `routeSendAnnotations`).
    // The words are in the outbox before anything is awaited: the texts the comments' lines are read from come after.
    let riding = commentsToSend(id)
    let needsTexts = needsFeedbackTexts(id, for: riding)
    guard !text.isEmpty || !riding.isEmpty || !owing.isEmpty || targets.contains(where: { !$0.questions.isEmpty || !$0.actions.isEmpty }) else { return false }
    notices[id] = nil
    returned[id] = nil
    keepGivenBack()
    if !owing.isEmpty || commentBook.owed.contains(where: { owed in riding.contains { $0.id == owed } }) {
      // Each goes by itself to the agent these words answer (or would, with no words), whoever writes after.
      commentBook.owe(owing.map(\.id), to: targets.last?.message)
      // One that would have gone by itself rides this Send instead.
      commentBook.owed.subtract(riding.map(\.id))
      keepComments()
    }
    // Only such comments: nothing is sent now, and nothing waits in the outbox.
    if text.isEmpty, riding.isEmpty, !targets.contains(where: { !$0.questions.isEmpty || !$0.actions.isEmpty }) { return true }
    // A reply with neither an answer nor words is never made: the Inbox refuses one ("write a reply or send at
    // least one answer"). So with no words, the agent that wrote last and asked nothing gets no reply.
    var carrier: String?
    let carrying = targets.enumerated().filter { index, target in !target.questions.isEmpty || !target.actions.isEmpty || (index == targets.count - 1 && (!text.isEmpty || !riding.isEmpty)) }.map(\.element)
    for (index, target) in carrying.enumerated() {
      let last = index == carrying.count - 1
      let key = UUID().uuidString
      // The words ride the reply to the agent that wrote last, when that reply is made at all.
      let words = target.message == targets.last?.message ? text : ""
      var body = DoorReplyBody(idempotencyKey: key, words: words, questions: target.questions, actions: target.actions.isEmpty ? nil : target.actions, withThread: last ? true : nil)
      // The computer's draft these words came from goes when they are sent (the door forwards `clear_draft`).
      if !words.isEmpty, let clearDraft { body.clearDraft = clearDraft }
      if last, !riding.isEmpty {
        body.feedback = feedback(riding, thread: id)
        body.annotationIds = riding.map(\.id)
        carrier = key
      }
      enqueue(kind: .reply, thread: id, message: target.message, request: Door.postMessageReply(message: target.message), body: encode(body), key: key, words: words.isEmpty ? nil : words)
    }
    // The words are in the outbox now: the thread's draft on the phone is spent.
    if !text.isEmpty { forgetDraft(id) }
    // The texts the comments' lines are read from, fetched now when the phone does not keep them (as the window
    // reads them at Send), for a short while at most; the feedback is then written again with them. A comment whose
    // text did not come goes with its quote and no line.
    if let carrier, needsTexts, client != nil {
      resolving.insert(carrier)
      await fetchFeedbackTexts(id, for: riding, within: feedbackTextWait)
      resolving.remove(carrier)
      rewriteFeedback(carrier, thread: id)
    }
    await pump(id.rawValue)
    if client != nil { await readList() }
    return true
  }

  /// Whether Send has anything to carry for this thread.
  public func canSend(thread id: ThreadID, words: String) -> Bool {
    guard standing == .ok, let model = thread(id), offers(DoorRoutes.postMessageReply) || skew == nil, !SendPlan.needsComputer(model.thread) else { return false }
    return (SendPlan.hasSomethingToSend(thread: model.thread, words: words) || !commentsToSend(id).isEmpty || !commentsToOwe(id).isEmpty) && !SendPlan.targets(in: model.thread).isEmpty
  }

  public func canAnswer() -> Bool { standing == .ok && (skew == nil || offers(DoorRoutes.postMessagePicks)) }

  /// A reply of this thread that waits for the computer.
  public func hasHeldReply(_ id: ThreadID) -> Bool { held.contains { $0.kind == .reply && $0.thread == id.rawValue } }

  public func clearNotice(_ id: ThreadID) {
    notices[id] = nil
    keepGivenBack()
  }

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
    draftBook = DraftBook()
    old.erase()
    bytes?.erase()
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
              if frame.event == "record" {
                let comments = CommentEvents.thread(of: frame.data)
                await MainActor.run { self?.reloadSoon(comments: comments) }
              }
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

  /// `comments`: a comment on a thread's files changed on the computer (made, changed, sent or removed in the
  /// window): that thread's comments are read again too.
  func reloadSoon(comments thread: ThreadID? = nil) {
    if let thread { commentsChanged.insert(thread) }
    reload?.cancel()
    reload = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(250))
      guard !Task.isCancelled, let self else { return }
      await self.readList()
      for id in self.threads.keys { await self.readThread(id) }
      // Each thread is crossed off only as its read starts, and put back when it did not land: a newer event that
      // cancels this pass, or a read the computer did not answer, leaves it to the next one.
      for id in self.commentsChanged {
        guard !Task.isCancelled else { return }
        guard self.threads[id] != nil || self.commentBook.kept[id] != nil else {
          self.commentsChanged.remove(id)
          continue
        }
        self.commentsChanged.remove(id)
        if case .failed = await self.readComments(id) { self.commentsChanged.insert(id) }
      }
    }
  }
}
