import Foundation
import Observation
import PlannotatorKit

/// The shown source while it is shown (a paired computer's Inbox, or
/// Workspaces): the list, the open threads, the live changes in the
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
    let client: any SourceClient

    private(set) var status: Status = .connecting
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

    private var onScreen: [String: Int] = [:]
    private var stream: Task<Void, Never>?
    private var pendingRefresh: Task<Void, Never>?
    private var pickChains: [String: Task<Void, Never>] = [:]
    private let cache: Cache

    init(source: Source, token: String) {
        id = source.id
        name = source.name
        kind = .inbox(source)
        client = InboxClient(address: source.address, token: token)
        cache = Cache(source: source.id)
        list = cache.read(InboxListModel.self, "list")
    }

    init(workspaces: WorkspacesSource) {
        id = WorkspacesAccount.sourceId
        name = "Workspaces"
        kind = .workspaces
        client = workspaces
        cache = Cache(source: id)
        list = cache.read(InboxListModel.self, "list")
    }

    var isWorkspaces: Bool { kind == .workspaces }

    // MARK: The stream (foreground only)

    /// Connects: refreshes what is on screen, then follows the event stream from
    /// the list's cursor, reconnecting after a drop. Called when the app comes
    /// to the front; `stop()` when it leaves.
    func start() {
        guard stream == nil, status != .removed else { return }
        stream = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refreshAll()
                if self.status == .removed { return }
                do {
                    for try await event in self.client.events(after: self.list?.cursor) {
                        switch event {
                        case .hello: self.status = .connected
                        case .record: self.scheduleRefresh()
                        }
                    }
                } catch let error as InboxError {
                    self.fail(error)
                } catch {}
                if self.status == .removed { return }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    func stop() {
        stream?.cancel()
        stream = nil
        pendingRefresh?.cancel()
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
        for id in onScreen.keys { await loadThread(id) }
    }

    private func fail(_ error: InboxError) {
        if error.isUnpaired {
            status = .removed
            stop()
        } else if error.isUnreachable {
            status = .unreachable
        }
    }

    // MARK: The list

    func refresh() async {
        do {
            let model = try await client.list(project: project)
            status = .connected
            apply(model)
            if project == nil { cache.write(model, "list") }
        } catch {
            fail(error)
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
        await loadThread(id)
        try? await client.seen(thread: id)
    }

    func close(thread id: String) {
        onScreen[id, default: 1] -= 1
        if onScreen[id] == 0 { onScreen[id] = nil }
    }

    /// Reads a thread. Answers false when it could not be read.
    @discardableResult
    func loadThread(_ id: String) async -> Bool {
        do {
            let answer = try await client.thread(id)
            threads[id] = answer.thread
            threadProblems[id] = nil
            cache.write(answer.thread, "thread-\(id)")
            return true
        } catch {
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
    func pick(_ question: InboxQuestion, answer: QuestionAnswer?, thread id: String, onError: @escaping (String) -> Void) {
        let cleared = answer.map(\.isEmpty) ?? true
        edit(thread: id, question: question) { q in
            q.answer = cleared ? nil : answer
            q.state = cleared ? "open" : "picked"
            q.pickedAt = cleared ? nil : ISO8601DateFormatter().string(from: .now)
        }
        let previous = pickChains[id]
        pickChains[id] = Task { [weak self] in
            await previous?.value
            guard let self else { return }
            let revision = self.question(question, in: id)?.revision ?? question.revision
            do throws(InboxError) {
                let saved = try await self.client.pick(message: question.messageId, key: question.key, revision: revision, answer: cleared ? nil : answer)
                self.replace(saved.questions, message: saved.messageId, thread: id)
            } catch {
                await self.loadThread(id)
                onError(error.code == "question_revision_conflict" ? self.changedElsewhere : "The pick was not saved. \(error.message)")
            }
        }
    }

    func setRecording(_ question: InboxQuestion, on: Bool, thread id: String) async throws(InboxError) {
        edit(thread: id, question: question) { $0.decisionRecording = on }
        do {
            let saved = try await client.setDecisionRecording(message: question.messageId, key: question.key, recording: on)
            replace([saved], message: question.messageId, thread: id)
        } catch {
            await loadThread(id)
            throw error
        }
    }

    /// The person's Send: every picked, unsent answer, per message, with the
    /// words on the last. Each message's idempotency key is kept until the
    /// Inbox gives a definite answer, across retries and app restarts.
    func send(thread id: String, words: String) async throws(InboxError) {
        commitDrafts(thread: id)
        await pickChains[id]?.value
        guard let thread = threads[id] else { return }
        var targets: [(message: InboxMessage, questions: [InboxClient.SendQuestion])] = thread.messages.compactMap { message in
            let picked = (message.questions ?? []).filter(\.isPicked)
            guard message.author.isAgent, !picked.isEmpty else { return nil }
            return (message, picked.map { .init(key: $0.key, revision: $0.revision) })
        }
        if targets.isEmpty {
            guard !words.trimmed.isEmpty, let last = thread.messages.last(where: \.author.isAgent) ?? thread.messages.first else { return }
            targets.append((last, []))
        }
        for (index, target) in targets.enumerated() {
            let key = SendKeys.key(source: self.id, message: target.message.id)
            let repliesBefore = replies(to: target.message.id, in: thread)
            do {
                let answer = try await client.reply(message: target.message.id, idempotencyKey: key, words: index == targets.count - 1 ? words.trimmed : "", questions: target.questions)
                SendKeys.clear(source: self.id, message: target.message.id)
                replace(answer.questions, message: answer.messageId, thread: id)
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
        await loadThread(id)
        await refresh()
    }

    func resolve(thread id: String, resolved: Bool) async throws(InboxError) {
        try await client.resolve(message: id, resolved: resolved)
        await loadThread(id)
        await refresh()
    }

    func delete(thread id: String) async throws(InboxError) {
        try await client.delete(thread: id)
        threads[id] = nil
        cache.remove("thread-\(id)")
        await refresh()
    }

    private func replies(to message: String, in thread: InboxThread) -> Int {
        thread.messages.filter { !$0.author.isAgent && $0.replyTo == message }.count
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
        threads[thread]?.messages.first { $0.id == question.messageId }?.questions?.first { $0.key == question.key }
    }

    private func edit(thread id: String, question: InboxQuestion, _ change: (inout InboxQuestion) -> Void) {
        guard var thread = threads[id],
              let m = thread.messages.firstIndex(where: { $0.id == question.messageId }),
              let q = thread.messages[m].questions?.firstIndex(where: { $0.key == question.key }) else { return }
        change(&thread.messages[m].questions![q])
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
