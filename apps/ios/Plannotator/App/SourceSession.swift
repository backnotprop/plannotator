import Foundation
import Observation
import PlannotatorKit

/// The shown source while it is shown (a paired computer's Inbox, or
/// Workspaces): the list, the open threads, the path a computer is reached
/// on (the Wi-Fi, the tailnet, then the relay), the live changes in the
/// foreground, and the person's commands.
@Observable
final class SourceSession {
    enum Status { case connecting, connected, unreachable, removed }
    enum Kind: Equatable { case inbox(Source), workspaces }

    /// The cache's and Send keys' name for this source: a computer's device id, or "workspaces".
    let id: String
    /// "MacBook Pro", or "Workspaces".
    let name: String
    let kind: Kind
    /// The client on the path in use. Every call goes through it, so a call is
    /// the same request on the Wi-Fi, the tailnet and the relay; for
    /// Workspaces, its doors.
    private(set) var client: any SourceClient
    private(set) var status: Status = .connecting
    /// The path in use, nil while none answers.
    private(set) var path: InboxPath?
    /// Through the relay: the computer's Inbox is connected to it now. When it
    /// is not, the phone shows what it last received and its answers wait.
    private(set) var inboxOnline = true
    /// Sends the relay holds for this computer (owner item 26).
    private(set) var pending: [PendingSend] = []
    /// A held Send the computer refused when it came online, by thread.
    var sendProblems: [String: String] = [:]
    /// Messages too large for the relay to carry, and threads whose read
    /// through it was too large: drawn as "Too large to show here" until a
    /// direct path reads them. Kept apart because a thread's id is its root
    /// message's id.
    private(set) var tooLargeMessages: Set<String> = []
    private(set) var tooLargeThreads: Set<String> = []

    /// The list on screen. It draws from the cache first, then refreshes.
    private(set) var list: InboxListModel?
    /// Threads that arrived while the list was scrolled, held behind the "N new" pill (2.3).
    private(set) var newCount = 0
    private var held: InboxListModel?
    /// The list is scrolled away from its top; arriving threads wait behind the pill.
    var scrolled = false {
        didSet { if oldValue, !scrolled { showNew() } }
    }
    /// The project filter (the toolbar menu); nil shows every project.
    private(set) var project: String?
    private(set) var threads: [String: InboxThread] = [:]
    /// Why a thread is not on screen: still loading, the computer could not be
    /// reached before it was ever read, or it is gone (deleted on the computer).
    private(set) var threadProblems: [String: ThreadProblem] = [:]
    /// What the person is typing in a card's Other, note or answer field,
    /// per question id, until it is saved. Send reads these too, so words
    /// still in a field are never lost.
    var drafts: [String: FieldDraft] = [:]
    /// Each open thread's files and the person's annotations waiting for a Send (7.14).
    private(set) var files: [String: InboxThreadAttachments] = [:]

    private var onScreen: [String: Int] = [:]
    private var connecting: Task<Void, Never>?
    private var stream: Task<Void, Never>?
    private var pendingRefresh: Task<Void, Never>?
    private var pickChains: [String: Task<Void, Never>] = [:]
    private var tickChains: [String: Task<Void, Never>] = [:]
    /// Per guide while taps are in flight: how many, and the ticks the Inbox last confirmed.
    private var ticksInFlight: [String: Int] = [:]
    private var confirmedTicks: [String: [Bool]?] = [:]
    private let cache: Cache
    private let directs: [InboxClient]
    private var relay: RelayChannel?
    /// The relay switch is on and the relay holds it on (the app model knows).
    private let relayCarries: () -> Bool

    init(source: Source, credential: DeviceCredential, relayCarries: @escaping () -> Bool) {
        id = source.id
        name = source.name
        kind = .inbox(source)
        cache = Cache(source: source.id)
        self.relayCarries = relayCarries
        directs = source.directClients(token: credential.token)
        client = directs.first ?? InboxClient(address: source.address, token: credential.token)
        list = cache.read(InboxListModel.self, "list")
        pending = PendingSend.all().filter { $0.source == source.id }
        if let ref = source.relay, let relayClient = RelayClient(relay: ref, device: source.id, secret: credential.secret) {
            relay = RelayChannel(client: relayClient, through: SourceState.load(source.id).relayThrough) { [weak self] batch in
                await self?.apply(batch)
            }
        }
    }

    init(workspaces: WorkspacesSource) {
        id = WorkspacesAccount.sourceId
        name = "Workspaces"
        kind = .workspaces
        client = workspaces
        cache = Cache(source: id)
        directs = []
        relayCarries = { false }
        list = cache.read(InboxListModel.self, "list")
    }

    var isWorkspaces: Bool { kind == .workspaces }

    /// The computer's device door, for what only the local Inbox answers (the
    /// decision card's words, the Decisions tab, New message); nil for Workspaces.
    var inbox: InboxClient? { client as? InboxClient }

    /// The relay carries this computer now (its switch on, and the relay holding it on).
    var relayOn: Bool { relayCarries() }

    /// The paired computer this session shows; nil for Workspaces.
    var source: Source? {
        if case .inbox(let source) = kind { return source }
        return nil
    }

    // MARK: The path (9.2)

    /// Comes to the front: chooses the path and reads. Called when the app
    /// comes to the front; `stop()` when it leaves.
    func start() {
        guard connecting == nil, stream == nil, status != .removed else { return }
        connecting = Task { [weak self] in
            await self?.connect()
            self?.connecting = nil
        }
    }

    func stop() {
        connecting?.cancel()
        connecting = nil
        stream?.cancel()
        stream = nil
        pendingRefresh?.cancel()
    }

    /// The person pulled to refresh, tapped Try Again, or a push arrived: the
    /// paths are asked again and what is on screen is read.
    func reconnect() async {
        guard status != .removed else { return }
        await connect()
    }

    /// The relay switch changed on this phone (9.2).
    func relayChanged() async {
        if path == .relay || path == nil { await connect() }
    }

    /// Chooses the path: the Wi-Fi, then the tailnet, each asked for `health`
    /// with a short wait; then the relay while its switch is on. A direct path
    /// reads what is on screen and follows the event stream; the relay reads
    /// what it holds after this phone's last item, then the list when the
    /// computer is online.
    private func connect() async {
        if isWorkspaces {
            // One path: Workspaces' doors, then its live changes by ticket.
            await refreshAll()
            if status == .connected, stream == nil { follow() }
            return
        }
        if let direct = await reachableDirect() {
            use(direct)
            await refreshAll()
            if path != nil, status == .connected, stream == nil { follow() }
            await settleHeld()
            ackRelayByCursor()
            return
        }
        if status == .removed { return }
        if let relay, let source, relayCarries() {
            use(InboxClient(relay: relay, address: source.address, token: ""))
            await readRelay()
            return
        }
        stream?.cancel()
        stream = nil
        path = nil
        status = .unreachable
    }

    /// The first direct path that answers, the Wi-Fi before the tailnet, both
    /// asked at once so one that does not answer costs only its short wait.
    private func reachableDirect() async -> InboxClient? {
        let found = await InboxClient.firstReachable(directs)
        if let unpaired = found.unpaired, found.client == nil { fail(unpaired) }
        return found.client
    }

    private func use(_ next: InboxClient) {
        if next.path != path || next.address != (client as? InboxClient)?.address {
            stream?.cancel()
            stream = nil
        }
        client = next
        path = next.path
    }

    /// The event stream on a direct path, from the list's cursor. When it
    /// drops, one reconnect with the cursor after the stream's own retry
    /// interval: the paths are asked again, and on the relay nothing follows.
    private func follow() {
        let streamClient = client
        stream = Task { [weak self] in
            guard let self else { return }
            do {
                for try await event in streamClient.events(after: self.list?.cursor) {
                    switch event {
                    case .hello: self.status = .connected
                    case .record: self.scheduleRefresh()
                    }
                }
            } catch let error as InboxError {
                self.fail(error)
            } catch {}
            guard !Task.isCancelled, self.status != .removed else { return }
            self.stream = nil
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            await self.connect()
        }
    }

    private func scheduleRefresh() {
        pendingRefresh?.cancel()
        pendingRefresh = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled else { return }
            await self?.refreshAll()
        }
    }

    private func refreshAll() async {
        await refresh()
        for id in onScreen.keys {
            await loadThread(id)
            await loadFiles(id)
        }
    }

    private func fail(_ error: InboxError) {
        if error.isUnpaired {
            status = .removed
            stop()
        } else if error.isUnreachable {
            status = .unreachable
        }
    }

    /// Runs one call on the path in use. When a direct path gets no answer,
    /// the paths are chosen again once and the call runs on the new one; the
    /// caller made its idempotency key before, so it is applied once.
    private func perform<T>(_ call: (any SourceClient) async throws(InboxError) -> T) async throws(InboxError) -> T {
        let first = client
        let firstPath = path
        let firstAddress = (client as? InboxClient)?.address
        do {
            return try await call(first)
        } catch where error == .unreachable && !isWorkspaces && firstPath != .relay {
            await connect()
            guard path != nil, path != firstPath || (client as? InboxClient)?.address != firstAddress else { throw error }
            return try await call(client)
        }
    }

    // MARK: The relay as the path

    /// Reads what the relay holds after this phone's last item (one reconnect
    /// with the cursor when the relay does not answer), then, with the
    /// computer online, the list and the open threads through it.
    private func readRelay() async {
        guard let relay else { return }
        var batch: RelayBatch?
        do throws(InboxError) {
            batch = try await relay.read()
        } catch {
            if error.isUnpaired { return fail(error) }
            batch = try? await relay.read()
        }
        guard let batch else {
            status = .unreachable
            return
        }
        status = .connected
        inboxOnline = batch.inboxOnline
        guard batch.inboxOnline else { return }
        await refreshAll()
    }

    /// A batch of down items, in seq order: each store line this phone has not
    /// seen goes into the threads it keeps. Any batch with records has the
    /// list and the open threads read again while the computer is online,
    /// which also covers an item delayed or dropped (an `after` past the last
    /// seq seen), so no separate gap check is kept. Results settle the Sends
    /// the relay held.
    private func apply(_ batch: RelayBatch) async {
        var state = SourceState.load(self.id)
        var touched = Set<String>()
        for record in batch.records.sorted(by: { $0.seq < $1.seq }) {
            guard record.seq > state.seq else { continue }
            state.seq = record.seq
            if record.tooLarge {
                // A message too large for the relay: drawn in its thread, or noted for the thread it turns out to be in.
                tooLargeMessages.insert(record.kind == "question" ? String(record.id.prefix { $0 != "/" }) : record.id)
                continue
            }
            switch record.record {
            case .message(let message): if applyRecord(message) { touched.insert(message.threadId) }
            case .question(let question): if let thread = applyRecord(question) { touched.insert(thread) }
            case .project(let project): projectNames[project.id] = project.name
            case .other, nil: break
            }
        }
        for id in touched {
            if let thread = threads[id] { cache.write(thread, "thread-\(id)") }
        }
        for result in batch.results { settle(result) }
        SourceState.update(self.id) {
            $0.seq = max($0.seq, state.seq)
            $0.relayThrough = max($0.relayThrough, batch.through)
        }
        inboxOnline = batch.inboxOnline
        if !batch.records.isEmpty, batch.inboxOnline, path == .relay {
            scheduleRefresh()
        }
    }

    private var projectNames: [String: String] = [:]

    /// A message line into its thread; a new thread's root starts one, and the
    /// list shows it until the computer answers a list read.
    private func applyRecord(_ message: InboxMessage) -> Bool {
        if let key = message.idempotencyKey { settlePending { $0.key == key } }
        if var thread = threads[message.threadId] ?? cache.read(InboxThread.self, "thread-\(message.threadId)") {
            thread.apply(message)
            threads[message.threadId] = thread
            return true
        }
        guard message.id == message.threadId else { return false }
        let projectId = message.projectId ?? ""
        let name = projectNames[projectId] ?? list?.projects.first { $0.id == projectId }?.name ?? ""
        let thread = InboxThread(root: message, projectName: name)
        threads[message.threadId] = thread
        if list != nil, project == nil || project == projectId { list?.add(thread) }
        return true
    }

    /// A question line into the thread holding its message; answers that thread.
    private func applyRecord(_ question: InboxQuestion) -> String? {
        for (id, var thread) in threads where thread.contains(message: question.messageId) {
            thread.apply(question)
            threads[id] = thread
            return id
        }
        return nil
    }

    // MARK: Sends the relay holds

    func pending(thread id: String) -> [PendingSend] {
        pending.filter { $0.thread == id }
    }

    private func hold(_ send: PendingSend) {
        PendingSend.add(send)
        pending = PendingSend.all().filter { $0.source == self.id }
    }

    /// The lock-screen answer queued one for this source: show it.
    func reloadPending() {
        pending = PendingSend.all().filter { $0.source == self.id }
    }

    private func settlePending(_ match: (PendingSend) -> Bool) {
        guard pending.contains(where: match) else { return }
        PendingSend.remove { $0.source == self.id && match($0) }
        pending = PendingSend.all().filter { $0.source == self.id }
    }

    /// A held Send's result: it landed (the thread is read again) or the
    /// computer refused it (the thread says why).
    private func settle(_ result: RelayResult) {
        guard let send = pending.first(where: { $0.key == result.id }) else { return }
        settlePending { $0.key == result.id }
        if !(200..<300).contains(result.answer.status) {
            sendProblems[send.thread] = notSent(InboxClient.refusal(status: result.answer.status, data: result.answer.data))
        }
        Task { await loadThread(send.thread) }
    }

    /// Back on the Wi-Fi or the tailnet with Sends the relay held: what became
    /// of each. A landed one is settled by its key in the thread read; the
    /// rest by their result items, read once from the relay (a refusal never
    /// shows in the thread). With the relay switch off no result comes down,
    /// so each is asked again directly with its own key: the door answers from
    /// its log, or applies it now and answers the relay's copy from the log
    /// later; either way once.
    private func settleHeld() async {
        guard !pending.isEmpty, path != .relay else { return }
        for id in Set(pending.map(\.thread)) where threads[id] == nil || !onScreen.keys.contains(id) {
            await loadThread(id)
        }
        guard !pending.isEmpty else { return }
        if relayCarries(), let relay {
            _ = try? await relay.read()
            return
        }
        for send in pending {
            guard let body = send.body else { continue }
            do throws(InboxError) {
                if let inbox = client as? InboxClient {
                    _ = try await inbox.reply(message: send.message, body)
                } else {
                    _ = try await client.reply(message: send.message, idempotencyKey: send.key, words: body.words, questions: body.questions)
                }
                settlePending { $0.key == send.key }
            } catch where error.isDefinite {
                settlePending { $0.key == send.key }
                sendProblems[send.thread] = notSent(error)
            } catch {
                return
            }
            await loadThread(send.thread)
        }
    }

    /// A refused Send in the person's words: the door's own text names a question key.
    func notSent(_ error: InboxError) -> String {
        switch error.code {
        case "question_revision_conflict": "Not sent. \(changedElsewhere)"
        case "question_already_sent": "Not sent. That question was already answered\(isWorkspaces ? " in Workspaces" : " on your computer")."
        case "question_not_found": "Not sent. That question is no longer there."
        default: "Not sent. \(error.message)"
        }
    }

    // MARK: The list

    func refresh() async {
        if path == .relay, !inboxOnline { return }
        do {
            let model = try await client.list(project: project)
            status = .connected
            apply(model)
            if project == nil { cache.write(model, "list") }
            seen(cursor: model.cursor)
        } catch where error == .queued {
            inboxOnline = false
        } catch {
            fail(error)
        }
        // The Decisions tab, once it was opened, follows the same events.
        if decisionsProject != nil { await loadDecisions() }
    }

    /// The store seq this phone has read up to.
    private func seen(cursor: Int) {
        SourceState.update(self.id) { $0.seq = max($0.seq, cursor) }
    }

    /// Read directly, the relay is told by cursor once per connect, so it holds
    /// only what this phone missed (section 4). Once, not after every read: one
    /// mailbox answers its requests one at a time, and a push waits behind them.
    private func ackRelayByCursor() {
        guard path != .relay, relayCarries(), let relay else { return }
        let state = SourceState.load(self.id)
        guard state.seq > state.ackedSeq else { return }
        Task {
            guard (try? await relay.client.ack(cursor: state.seq)) != nil else { return }
            SourceState.update(self.id) { $0.ackedSeq = max($0.ackedSeq, state.seq) }
        }
    }

    func filter(project: String?) async {
        guard project != self.project else { return }
        self.project = project
        held = nil
        newCount = 0
        list = nil
        await refresh()
    }

    private func apply(_ model: InboxListModel) {
        guard let list, scrolled else {
            self.list = model
            held = nil
            newCount = 0
            return
        }
        let added = model.threadIds.subtracting(list.threadIds)
        if added.isEmpty {
            self.list = model
            held = nil
            newCount = 0
        } else {
            held = model
            newCount = added.count
        }
    }

    /// The pill's tap, or the person scrolling back to the top. Answers the
    /// first arrived thread in list order, for the pill to scroll to.
    @discardableResult
    func showNew() -> String? {
        let before = list?.threadIds ?? []
        if let held { list = held }
        held = nil
        newCount = 0
        return list?.sections.lazy.flatMap(\.threads).first { !before.contains($0.threadId) }?.threadId
    }

    // MARK: A thread

    func open(thread id: String) async {
        onScreen[id, default: 0] += 1
        if threads[id] == nil { threads[id] = cache.read(InboxThread.self, "thread-\(id)") }
        if files[id] == nil { files[id] = cache.read(InboxThreadAttachments.self, "files-\(id)") }
        await loadThread(id)
        await loadFiles(id)
        let key = InboxClient.newKey()
        _ = try? await perform { client throws(InboxError) in try await client.seen(thread: id, idempotencyKey: key) }
    }

    func close(thread id: String) {
        onScreen[id, default: 1] -= 1
        if onScreen[id] == 0 { onScreen[id] = nil }
    }

    /// Reads a thread. Answers false when it could not be read.
    @discardableResult
    func loadThread(_ id: String) async -> Bool {
        if path == .relay, !inboxOnline {
            if threads[id] == nil { threadProblems[id] = .unreachable }
            return false
        }
        do {
            let answer = try await client.thread(id)
            threads[id] = answer.thread
            threadProblems[id] = nil
            cache.write(answer.thread, "thread-\(id)")
            // Read whole: what the relay could not carry is here now, and a held Send that landed shows as sent.
            tooLargeMessages.subtract(answer.thread.messages.map(\.id))
            tooLargeThreads.remove(id)
            let keys = Set(answer.thread.messages.compactMap(\.idempotencyKey))
            settlePending { $0.thread == id && keys.contains($0.key) }
            if path != .relay { seen(cursor: answer.cursor) }
            return true
        } catch {
            if error.code == "result_too_large" {
                // The relay cannot carry this thread whole: what this phone has, and the words.
                tooLargeThreads.insert(id)
                if threads[id] == nil { threadProblems[id] = .unreachable }
                return false
            }
            if error == .queued {
                inboxOnline = false
                if threads[id] == nil { threadProblems[id] = .unreachable }
                return false
            }
            if error.code == "thread_not_found" {
                threads[id] = nil
                threadProblems[id] = .gone
                cache.remove("thread-\(id)")
            } else if threads[id] == nil, !error.isUnpaired {
                threadProblems[id] = .unreachable
            }
            fail(error)
            return false
        }
    }

    /// One tap is one pick, saved at once and drawn before the Inbox answers.
    /// Picks in a thread go out one after another, each on the revision the
    /// last answer left (a stale one is `409 question_revision_conflict`).
    /// One the relay holds for an offline computer moves the revision on by
    /// one, as the Inbox will when it applies it, so the next pick and the
    /// Send line up behind it.
    func pick(_ question: InboxQuestion, answer: QuestionAnswer?, thread id: String, onError: @escaping (String) -> Void) {
        let cleared = answer.map(\.isEmpty) ?? true
        edit(thread: id, question: question) { q in
            q.answer = cleared ? nil : answer
            q.state = cleared ? "open" : "picked"
            q.pickedAt = cleared ? nil : ISO8601DateFormatter().string(from: .now)
        }
        let previous = pickChains[id]
        let key = InboxClient.newKey()
        pickChains[id] = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            let revision = self.question(question, in: id)?.revision ?? question.revision
            do throws(InboxError) {
                let saved = try await self.perform { client throws(InboxError) in
                    try await client.pick(message: question.messageId, key: question.key, revision: revision, answer: cleared ? nil : answer, idempotencyKey: key)
                }
                self.replace(saved.questions, message: saved.messageId, thread: id)
            } catch where error == .queued {
                self.inboxOnline = false
                self.edit(thread: id, question: question) { $0.revision = revision + 1 }
            } catch {
                await self.loadThread(id)
                onError(error.code == "question_revision_conflict" ? self.changedElsewhere : "The pick was not saved. \(error.message)")
            }
        }
    }

    func setRecording(_ question: InboxQuestion, on: Bool, thread id: String) async throws(InboxError) {
        edit(thread: id, question: question) { $0.decisionRecording = on }
        let key = InboxClient.newKey()
        do {
            let saved = try await perform { client throws(InboxError) in
                try await client.setDecisionRecording(message: question.messageId, key: question.key, recording: on, idempotencyKey: key)
            }
            replace([saved], message: question.messageId, thread: id)
        } catch where error == .queued {
            inboxOnline = false
        } catch {
            await loadThread(id)
            throw error
        }
    }

    /// Done on the decision card (5.1): recording on, with the person's words
    /// (nil keeps the drafted ones, which follow the answer).
    func keepDecision(_ question: InboxQuestion, draft: InboxDecisionDraft?, thread id: String) async throws(InboxError) {
        guard let inbox else { return }
        let saved = try await inbox.keepDecision(message: question.messageId, key: question.key, draft: draft)
        replace([saved], message: question.messageId, thread: id)
    }

    /// New message (8.2): the person's words to one live session, in this
    /// thread. The key is the caller's, kept until a definite answer.
    func newMessage(thread id: String, to session: InboxLiveSession, body: String, key: String) async throws(InboxError) {
        guard let inbox else { return }
        try await inbox.newMessage(thread: id, session: session.session, body: body, idempotencyKey: key)
        await loadThread(id)
        await refresh()
    }

    // MARK: Decisions (5.2)

    /// The Decisions tab's project; nil until the tab first shows.
    private(set) var decisionsProject: String?
    /// Each project's decisions as last read, drawn from the cache first.
    private(set) var decisions: [String: InboxDecisionsModel] = [:]

    /// Shows a project's decisions: the cached ones at once, then the Inbox's.
    func showDecisions(project: String) async {
        decisionsProject = project
        if decisions[project] == nil { decisions[project] = cache.read(InboxDecisionsModel.self, "decisions-\(project)") }
        await loadDecisions()
    }

    func loadDecisions() async {
        guard let project = decisionsProject, let inbox else { return }
        do {
            let model = try await inbox.decisions(project: project)
            decisions[project] = model
            cache.write(model, "decisions-\(project)")
        } catch {
            if error.code == "project_not_found" {
                decisions[project] = nil
                cache.remove("decisions-\(project)")
                decisionsProject = nil
            }
            fail(error)
        }
    }

    /// The project the tab opens on: the one with the newest activity, as the window chooses.
    var defaultDecisionsProject: String? {
        let rows = list?.sections.flatMap(\.threads) ?? []
        return rows.max { $0.lastAt < $1.lastAt }?.projectId ?? list?.projects.first?.id
    }

    /// The person's Send: every picked, unsent answer, per message, with the
    /// words on the last. Each message's idempotency key is kept until the
    /// Inbox gives a definite answer, across retries, a change of path and app
    /// restarts. One the relay holds for an offline computer is sent as far
    /// as this phone is concerned: the thread says "Sent. Waiting for your
    /// computer" until the reply lands (owner item 26).
    func send(thread id: String, words: String) async throws(InboxError) {
        commitDrafts(thread: id)
        await pickChains[id]?.value
        sendProblems[id] = nil
        guard let thread = threads[id] else { return }
        let annotations = pendingAnnotations(thread: id)
        var targets: [(message: InboxMessage, questions: [InboxClient.SendQuestion])] = thread.messages.compactMap { message in
            let picked = (message.questions ?? []).filter(\.isPicked)
            guard message.author.isAgent, !picked.isEmpty else { return nil }
            return (message, picked.map { .init(key: $0.key, revision: $0.revision) })
        }
        if targets.isEmpty {
            guard !words.trimmed.isEmpty || !annotations.isEmpty, let last = thread.messages.last(where: \.author.isAgent) ?? thread.messages.first else { return }
            targets.append((last, []))
        }
        // The annotations ride the last reply, after its picks, as Plannotator's feedback text.
        let feedback = annotations.isEmpty ? nil : try await feedbackText(annotations, thread: thread)
        var held = false
        for (index, target) in targets.enumerated() {
            let key = SendKeys.key(source: self.id, message: target.message.id)
            let repliesBefore = replies(to: target.message.id, in: thread)
            let last = index == targets.count - 1
            let text = last ? words.trimmed : ""
            let body = InboxClient.ReplyBody(idempotencyKey: key, words: text, questions: target.questions,
                                             feedback: last ? feedback : nil, annotationIds: annotations.map(\.id))
            do {
                let answer = try await perform { client throws(InboxError) in
                    if let inbox = client as? InboxClient { return try await inbox.reply(message: target.message.id, body) }
                    return try await client.reply(message: target.message.id, idempotencyKey: key, words: text, questions: target.questions)
                }
                SendKeys.clear(source: self.id, message: target.message.id)
                replace(answer.questions, message: answer.messageId, thread: id)
            } catch where error == .queued {
                // The relay holds it under its key; a later Send to this message is a new one.
                SendKeys.clear(source: self.id, message: target.message.id)
                hold(PendingSend(source: self.id, thread: id, message: target.message.id, key: key, words: text.isEmpty ? nil : text, body: body))
                for sent in target.questions {
                    guard let question = question(key: sent.key, message: target.message.id, in: id) else { continue }
                    edit(thread: id, question: question) { $0.state = "sent" }
                }
                inboxOnline = false
                held = true
            } catch {
                if error.isDefinite {
                    SendKeys.clear(source: self.id, message: target.message.id)
                    await loadThread(id)
                    throw error
                }
                // No answer: the Inbox may have applied it before the connection
                // dropped. The thread says which; a retry uses the same key and
                // is applied once either way.
                guard await loadThread(id) else { throw .sendUnconfirmed }
                guard let now = threads[id], replies(to: target.message.id, in: now) > repliesBefore else { throw error }
                SendKeys.clear(source: self.id, message: target.message.id)
            }
        }
        if held {
            if let thread = threads[id] { cache.write(thread, "thread-\(id)") }
            return
        }
        await loadThread(id)
        await loadFiles(id)
        await refresh()
    }

    func resolve(thread id: String, resolved: Bool) async throws(InboxError) {
        let key = InboxClient.newKey()
        do {
            try await perform { client throws(InboxError) in try await client.resolve(message: id, resolved: resolved, idempotencyKey: key) }
        } catch where error == .queued {
            inboxOnline = false
            threads[id]?.resolvedAt = resolved ? ISO8601DateFormatter().string(from: .now) : nil
            return
        }
        await loadThread(id)
        await refresh()
    }

    func delete(thread id: String) async throws(InboxError) {
        let key = InboxClient.newKey()
        do {
            try await perform { client throws(InboxError) in try await client.delete(thread: id, idempotencyKey: key) }
        } catch where error == .queued {
            inboxOnline = false
            if var model = list {
                for index in model.sections.indices { model.sections[index].threads.removeAll { $0.threadId == id } }
                list = model
            }
        }
        threads[id] = nil
        cache.remove("thread-\(id)")
        await refresh()
    }

    // MARK: Files and annotations (3.6, 4.1 to 4.4)

    /// Files and annotations come from a computer's Inbox; a Workspaces source has none here.
    var inboxClient: InboxClient? { client as? InboxClient }

    /// The door for a file: only a computer's Inbox serves files.
    private func filesDoor() throws(InboxError) -> InboxClient {
        guard let inboxClient else { throw .refused(status: 0, code: "files_unavailable", message: "Files open from a computer's Inbox.", triesLeft: nil) }
        return inboxClient
    }

    /// Reads a thread's files and the annotations waiting for its next Send.
    func loadFiles(_ id: String) async {
        guard let inbox = inboxClient else { return }
        do {
            let answer = try await inbox.attachments(thread: id)
            files[id] = answer
            cache.write(answer, "files-\(id)")
        } catch {
            if error.code == "thread_not_found" {
                files[id] = nil
                cache.remove("files-\(id)")
            }
        }
    }

    func pendingAnnotations(thread id: String) -> [InboxAnnotationRecord] {
        files[id]?.annotations ?? []
    }

    /// Saves the person's comment (a new one, or an edit under the same id).
    func saveAnnotation(thread id: String, attachment: String, version: String, annotation: JSONValue) async throws(InboxError) -> InboxAnnotationRecord {
        let record = try await filesDoor().saveAnnotation(attachment: attachment, version: version, annotation: annotation)
        if var current = files[id] {
            current.annotations.removeAll { $0.id == record.id }
            current.annotations.append(record)
            files[id] = current
        }
        return record
    }

    func removeAnnotation(thread id: String, annotation: String) async throws(InboxError) {
        try await filesDoor().removeAnnotation(annotation)
        files[id]?.annotations.removeAll { $0.id == annotation }
    }

    /// The annotations as Plannotator's feedback text, each file version's
    /// text read now so line numbers name what the person read (as the window does).
    private func feedbackText(_ annotations: [InboxAnnotationRecord], thread: InboxThread) async throws(InboxError) -> String {
        let attachments = files[thread.threadId]?.attachments ?? []
        let door = try filesDoor()
        var texts: [Bridge.Text] = []
        for record in annotations where !texts.contains(where: { $0.attachment_id == record.attachmentId && $0.version == record.version }) {
            // A file that can no longer be read (deleted or moved on the computer) goes with no text, as the window sends it.
            let text = (try? await door.view(attachment: record.attachmentId, sent: record.version != "current"))?.text ?? ""
            texts.append(.init(attachment_id: record.attachmentId, version: record.version, text: text))
        }
        guard let text = await SurfaceHost.shared.feedback(annotations: annotations, attachments: attachments, texts: texts, projectRoot: thread.project.root ?? ""), !text.isEmpty else {
            throw .refused(status: 0, code: "feedback_unavailable", message: "Your annotations could not be written into the reply. Try Send again.", triesLeft: nil)
        }
        return text
    }

    private func replies(to message: String, in thread: InboxThread) -> Int {
        thread.messages.filter { !$0.author.isAgent && $0.replyTo == message }.count
    }

    // MARK: Guided reviews (6.1, 6.2)

    /// The person's reviewed ticks on a guide, kept at once on screen and saved
    /// through the door. Ticks on one guide go out one after another, each with
    /// every section's tick as the person left them, so the last tap wins.
    /// When one is refused or cannot reach the computer, the ticks go back to
    /// what the Inbox keeps: read again when the computer answers, else the
    /// ticks it last confirmed. `onError` hands those back for the surface to draw.
    func saveTicks(_ reviewed: [Bool], message: String, thread id: String, onError: @escaping (_ message: String, _ kept: [Bool]?) -> Void) {
        if ticksInFlight[message, default: 0] == 0 {
            confirmedTicks[message] = .some(threads[id]?.messages.first { $0.id == message }?.guideReviewed)
        }
        ticksInFlight[message, default: 0] += 1
        editMessage(message, thread: id) { $0.guideReviewed = reviewed }
        let previous = tickChains[message]
        tickChains[message] = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            defer {
                self.ticksInFlight[message, default: 1] -= 1
                if self.ticksInFlight[message] == 0 {
                    self.ticksInFlight[message] = nil
                    self.confirmedTicks[message] = nil
                }
            }
            do throws(InboxError) {
                let saved = try await self.filesDoor().saveGuideReviewed(message: message, reviewed: reviewed)
                self.confirmedTicks[message] = .some(saved)
                // The last tap in flight: the phone holds what the Inbox answered.
                if self.ticksInFlight[message] == 1 { self.editMessage(message, thread: id) { $0.guideReviewed = saved } }
            } catch {
                if await self.loadThread(id) {
                    self.confirmedTicks[message] = .some(self.threads[id]?.messages.first { $0.id == message }?.guideReviewed)
                } else {
                    // The computer cannot say what it keeps: back to what it last confirmed.
                    let confirmed = self.confirmedTicks[message] ?? nil
                    self.editMessage(message, thread: id) { $0.guideReviewed = confirmed }
                }
                let kept = self.threads[id]?.messages.first { $0.id == message }?.guideReviewed
                onError(error.message, kept)
            }
        }
    }

    // MARK: Fields still being typed

    /// Saves every field the person is typing in this thread's cards, as a pick.
    func commitDrafts(thread id: String) {
        guard let thread = threads[id] else { return }
        for question in thread.messages.flatMap({ $0.questions ?? [] }) where drafts[question.id] != nil {
            commitDraft(question, thread: id)
        }
    }

    /// Saves one card's typed fields (when they change its answer) and ends its draft.
    func commitDraft(_ question: InboxQuestion, thread id: String, onError: @escaping (String) -> Void = { _ in }) {
        guard let draft = drafts.removeValue(forKey: question.id) else { return }
        let next = question.applying(draft)
        guard next != question.answer, !(next == nil && question.answer == nil) else { return }
        pick(question, answer: next, thread: id, onError: onError)
    }

    /// Some field in this thread holds words that would change an answer.
    func hasTypedAnswers(thread id: String) -> Bool {
        guard let thread = threads[id] else { return false }
        return thread.messages.flatMap { $0.questions ?? [] }.contains { question in
            guard let draft = drafts[question.id] else { return false }
            let next = question.applying(draft)
            return next != question.answer && next != nil
        }
    }

    // MARK: Local edits

    private func question(_ question: InboxQuestion, in thread: String) -> InboxQuestion? {
        self.question(key: question.key, message: question.messageId, in: thread)
    }

    private func question(key: String, message: String, in thread: String) -> InboxQuestion? {
        threads[thread]?.messages.first { $0.id == message }?.questions?.first { $0.key == key }
    }

    private func edit(thread id: String, question: InboxQuestion, _ change: (inout InboxQuestion) -> Void) {
        guard var thread = threads[id],
              let m = thread.messages.firstIndex(where: { $0.id == question.messageId }),
              let q = thread.messages[m].questions?.firstIndex(where: { $0.key == question.key }) else { return }
        change(&thread.messages[m].questions![q])
        threads[id] = thread
    }

    private func editMessage(_ message: String, thread id: String, _ change: (inout InboxMessage) -> Void) {
        guard var thread = threads[id], let m = thread.messages.firstIndex(where: { $0.id == message }) else { return }
        change(&thread.messages[m])
        threads[id] = thread
    }

    private func replace(_ questions: [InboxQuestion], message: String, thread id: String) {
        guard var thread = threads[id], let m = thread.messages.firstIndex(where: { $0.id == message }) else { return }
        var current = thread.messages[m].questions ?? []
        for question in questions {
            if let q = current.firstIndex(where: { $0.key == question.key }) { current[q] = question }
        }
        thread.messages[m].questions = current
        threads[id] = thread
    }
}

enum ThreadProblem { case unreachable, gone }

/// A card's fields as typed: nil is a field not being edited.
struct FieldDraft: Equatable {
    var other: String?
    var note: String?
    var text: String?
}

extension InboxQuestion {
    /// The answer with the typed fields applied, as the card's own edits make it.
    func applying(_ draft: FieldDraft) -> QuestionAnswer? {
        var next = answer ?? QuestionAnswer(key: key, kind: kind, prompt: prompt)
        if let other = draft.other?.trimmed {
            next.skipped = nil
            next.other = other.isEmpty ? nil : other
            if kind != "multi", !other.isEmpty { next.selected = [] }
        }
        if let text = draft.text?.trimmed {
            next.skipped = nil
            next.text = text.isEmpty ? nil : text
        }
        if let note = draft.note?.trimmed { next.note = note.isEmpty ? nil : note }
        return next.isEmpty ? nil : next
    }
}

/// Send's idempotency keys, one per target message, kept until a definite answer (contract section 6).
enum SendKeys {
    private static let name = "pendingSendKeys"

    static func key(source: String, message: String) -> String {
        var keys = UserDefaults.standard.dictionary(forKey: name) as? [String: String] ?? [:]
        if let key = keys["\(source)|\(message)"] { return key }
        let key = UUID().uuidString.lowercased()
        keys["\(source)|\(message)"] = key
        UserDefaults.standard.set(keys, forKey: name)
        return key
    }

    static func clear(source: String, message: String) {
        var keys = UserDefaults.standard.dictionary(forKey: name) as? [String: String] ?? [:]
        keys["\(source)|\(message)"] = nil
        UserDefaults.standard.set(keys, forKey: name)
    }
}

/// The local cache: the list and the threads as last read, so the app draws
/// before it refreshes. Under Caches, so the system may clear it.
struct Cache {
    let dir: URL

    init(source: String) {
        dir = URL.cachesDirectory.appending(path: "inbox/\(source)", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    func read<T: Decodable>(_ type: T.Type, _ name: String) -> T? {
        (try? Data(contentsOf: dir.appending(path: "\(name).json"))).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }

    func write(_ value: some Encodable, _ name: String) {
        try? JSONEncoder().encode(value).write(to: dir.appending(path: "\(name).json"), options: .atomic)
    }

    func remove(_ name: String) {
        try? FileManager.default.removeItem(at: dir.appending(path: "\(name).json"))
    }

    static func clear(source: String) {
        try? FileManager.default.removeItem(at: URL.cachesDirectory.appending(path: "inbox/\(source)"))
    }
}
