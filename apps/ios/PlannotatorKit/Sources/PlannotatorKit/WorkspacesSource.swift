import Foundation

// The Workspaces source: its doors mapped onto the Inbox's wire models, so the
// phone draws Workspaces with the same list, thread, cards and reply bar.
//
// - A row is a comment thread that concerns the person: one notification row
//   with `thread_key` `annotation:<id>` (`GET /v1/notifications`). Rows about a
//   whole document, a round or a decision have no thread to answer on a phone
//   and are left to the web app.
// - A thread is the root comment with its replies and its questions
//   (`GET .../annotations/{annoId}`). Its id, and its root message's id, is
//   `<workspace id>/<document id>/<comment id>`, so every call addresses the
//   comment from the id alone.
// - A pick and a Send go through the answers door with an `Idempotency-Key`; a
//   Send carries the decision ticks. Workspaces stores no tick before the Send,
//   so the phone keeps them until it sends.
// - Live changes come from the person's own channel and each team's channel,
//   by ticket (`POST /v1/ws-ticket`); a frame means "read again".

public actor WorkspacesSource: SourceClient {
    public nonisolated let client: WorkspacesClient
    /// The signed-in person: replies of theirs read as "You".
    public nonisolated let userId: String

    private struct Row {
        var notifications: [String]
        var project: InboxProjectRef
        var subject: String
        var document: InboxThreadDocument
    }

    private var projectNames: [String: String] = [:]
    private var rows: [String: Row] = [:]
    private var lastThreads: [String: InboxThread] = [:]

    public init(client: WorkspacesClient, userId: String) {
        self.client = client
        self.userId = userId
    }

    // MARK: The list

    public func list(project: String?) async throws(InboxError) -> InboxListModel {
        let feed: Feed = try await client.get("v1/notifications")
        let comments = feed.items.filter { $0.threadKey.hasPrefix("annotation:") && $0.documentId != nil }
        if comments.contains(where: { $0.event.projectId.map { projectNames[$0] == nil } ?? false }) {
            let answer: ProjectList = try await client.get("v1/projects")
            for project in answer.projects { projectNames[project.id] = project.name }
        }
        var next: [String: Row] = [:]
        var built: [InboxListRow] = []
        for item in comments {
            guard let document = item.documentId else { continue }
            let id = Self.threadId(item.workspace.id, document, String(item.threadKey.dropFirst("annotation:".count)))
            if next[id] != nil {
                next[id]?.notifications.append(item.id)
                continue
            }
            let project = item.event.projectId.flatMap { id in projectNames[id].map { InboxProjectRef(id: id, name: $0) } }
                ?? InboxProjectRef(id: "ws:\(item.workspace.id)", name: item.workspace.name ?? "Workspaces")
            let subject = item.questions?.prompt ?? Self.firstLine(item.event.excerpt) ?? item.workspace.name ?? "A comment"
            next[id] = Row(
                notifications: [item.id], project: project, subject: subject,
                document: InboxThreadDocument(workspaceId: item.workspace.id, workspaceName: item.workspace.name, documentId: document, path: item.event.target?.path, quote: nil)
            )
            let questions = item.questions ?? .init(open: 0, picked: 0, prompt: nil, stopped: false, holdsUp: [])
            built.append(InboxListRow(
                threadId: id, projectId: project.id, subject: subject,
                // The asking agent when one took part (a Sent row's newest event is the person's own).
                author: Self.author(item.actors.first { $0.kind == "agent" || $0.kind == "assistant" } ?? item.event.actor),
                lastAt: item.updatedAt,
                questions: InboxQuestionSummary(open: questions.open, picked: questions.picked, stopped: questions.stopped, holdsUp: questions.holdsUp),
                project: project, threadName: nil, section: Self.section(item, questions), unread: item.seenAt == nil,
                answeredNotSent: questions.open == 0 && questions.picked > 0,
                sent: item.reason == "sent" ? InboxSentState(at: item.updatedAt, checkedAt: item.askedByCheckedAt) : nil,
                guide: nil
            ))
        }
        rows = next
        var projects: [InboxProject] = []
        for row in built where !projects.contains(where: { $0.id == row.projectId }) {
            let mine = built.filter { $0.projectId == row.projectId }
            projects.append(InboxProject(id: row.projectId, name: row.project.name, threads: mine.count, unread: mine.filter(\.unread).count))
        }
        let shown = project.map { id in built.filter { $0.projectId == id } } ?? built
        let sections = Self.sections.map { section in
            InboxListSection(id: section.id, label: section.label, threads: shown.filter { $0.section == section.id })
        }
        return InboxListModel(cursor: 0, projects: projects, sections: sections)
    }

    /// The Inbox's six sections, in its order and words.
    static let sections: [(id: String, label: String)] = [
        ("stopped", "Stopped on you"), ("holding", "Holding up work"), ("waiting", "Waiting on you"),
        ("sent", "Sent"), ("new", "New since you looked"), ("quiet", "Quiet"),
    ]

    /// Where a row sits: what needs the person by what it holds up, the person's
    /// own Sends, then what is only new to them.
    static func section(_ item: Feed.Item, _ questions: Feed.Questions) -> String {
        if item.reason == "sent" { return "sent" }
        if ["tagged", "changes_requested", "approval_requested"].contains(item.reason) {
            if questions.open > 0, questions.stopped { return "stopped" }
            if questions.open > 0, !questions.holdsUp.isEmpty { return "holding" }
            return "waiting"
        }
        return item.seenAt == nil ? "new" : "quiet"
    }

    // MARK: A thread

    public func thread(_ id: String) async throws(InboxError) -> InboxThreadResponse {
        let (workspace, document, annotation) = try Self.parse(id)
        let comment: Comment = try await client.get("v1/workspaces/\(workspace)/documents/\(document)/annotations/\(annotation)")
        let row = rows[id]
        var place = row?.document ?? InboxThreadDocument(workspaceId: workspace, workspaceName: nil, documentId: document, path: nil, quote: nil)
        place.quote = comment.anchor?.quote
        let prefix = "\(workspace)/\(document)/"
        let questions = (comment.questions ?? []).map { question($0, message: id, prefix: prefix) }
        let resolvedAt = comment.state == "resolved" ? comment.updatedAt : nil
        var messages = [InboxMessage(
            id: id, threadId: id, replyTo: nil, author: author(agent: comment.agent, user: comment.author, name: comment.authorName),
            subject: row?.subject, body: comment.body, createdAt: comment.createdAt, resolvedAt: resolvedAt,
            agentCheckedAt: (comment.questions ?? []).compactMap(\.askedByCheckedAt).max(), delivery: nil, to: nil,
            questions: questions.isEmpty ? nil : questions
        )]
        for reply in comment.replies {
            messages.append(InboxMessage(
                id: prefix + reply.id, threadId: id, replyTo: id, author: author(agent: reply.agent, user: reply.author, name: reply.authorName),
                subject: nil, body: reply.body, createdAt: reply.createdAt, resolvedAt: nil, agentCheckedAt: nil, delivery: nil, to: nil, questions: nil
            ))
        }
        let thread = InboxThread(
            threadId: id, project: InboxThreadProject(id: row?.project.id ?? "ws:\(workspace)", name: row?.project.name ?? place.workspaceName ?? "Workspaces"),
            subject: row?.subject ?? questions.first?.prompt ?? Self.firstLine(comment.body), threadName: nil, resolvedAt: resolvedAt,
            messages: messages, document: place
        )
        lastThreads[id] = thread
        return InboxThreadResponse(cursor: 0, thread: thread)
    }

    /// Opening a thread marks its rows seen, and opened (which closes a row that
    /// was only new; a row that waits on an answer stays until the answer).
    public func seen(thread id: String) async throws(InboxError) {
        guard let ids = rows[id]?.notifications, !ids.isEmpty else { return }
        struct Body: Encodable { var seenIds: [String]; var openedIds: [String] }
        let _: WorkspacesClient.Ignored = try await client.send("POST", "v1/notifications/mark", Body(seenIds: ids, openedIds: ids))
    }

    // MARK: Picks, Send, the tick, resolve

    public func pick(message id: String, key: String, revision: Int, answer: QuestionAnswer?) async throws(InboxError) -> InboxQuestionsResponse {
        struct Pick: Encodable {
            var key: String
            var revision: Int
            var answer: QuestionAnswer?
            enum CodingKeys: CodingKey { case key, revision, answer }
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(key, forKey: .key)
                try c.encode(revision, forKey: .revision)
                try c.encode(answer, forKey: .answer) // null clears the pick
            }
        }
        struct Body: Encodable { var annotationId: String; var questions: [Pick] }
        let (workspace, document, annotation) = try Self.parse(id)
        // A keyed pick replays its first answer, so a pick whose answer was lost can be retried.
        let result: AnswerResult = try await client.send(
            "POST", "v1/workspaces/\(workspace)/documents/\(document)/answers",
            Body(annotationId: annotation, questions: [Pick(key: key, revision: revision, answer: answer)]),
            idempotencyKey: UUID().uuidString.lowercased()
        )
        return answered(result, message: id)
    }

    public func reply(message id: String, idempotencyKey: String, words: String, questions: [InboxClient.SendQuestion]) async throws(InboxError) -> InboxQuestionsResponse {
        let (workspace, document, annotation) = try Self.parse(id)
        guard !questions.isEmpty else {
            // Words alone are a plain reply on the comment.
            struct Body: Encodable { var body: String }
            let _: WorkspacesClient.Ignored = try await client.send("POST", "v1/workspaces/\(workspace)/documents/\(document)/annotations/\(annotation)/replies", Body(body: words))
            return InboxQuestionsResponse(messageId: id, questions: [])
        }
        struct Decision: Encodable { var key: String }
        struct Body: Encodable {
            var annotationId: String
            var final = true
            var questions: [InboxClient.SendQuestion]
            var words: String?
            var decisions: [Decision]?
        }
        let ticked = questions.filter { recording(id, $0.key) }.map { Decision(key: $0.key) }
        let result: AnswerResult = try await client.send(
            "POST", "v1/workspaces/\(workspace)/documents/\(document)/answers",
            Body(annotationId: annotation, questions: questions, words: words.isEmpty ? nil : words, decisions: ticked.isEmpty ? nil : ticked),
            idempotencyKey: idempotencyKey
        )
        for question in questions { Ticks.set(nil, "\(id)/\(question.key)") }
        return answered(result, message: id)
    }

    public func resolve(message id: String, resolved: Bool) async throws(InboxError) {
        struct Body: Encodable { var state: String }
        let (workspace, document, annotation) = try Self.parse(id)
        let _: WorkspacesClient.Ignored = try await client.send("PATCH", "v1/workspaces/\(workspace)/documents/\(document)/annotations/\(annotation)", Body(state: resolved ? "resolved" : "open"))
    }

    /// A comment is the team's: the phone does not delete it (the screens offer no Delete here).
    public func delete(thread id: String) async throws(InboxError) {
        throw .refused(status: 405, code: "not_supported", message: "Comments are deleted in Workspaces on the web.", triesLeft: nil)
    }

    /// The card's switch. Workspaces records the decision with the Send, so the
    /// phone keeps the tick until then.
    public func setDecisionRecording(message id: String, key: String, recording: Bool) async throws(InboxError) -> InboxQuestion {
        Ticks.set(recording, "\(id)/\(key)")
        guard var question = lastThreads[id]?.messages.first?.questions?.first(where: { $0.key == key }) else { throw .unreadable }
        question.decisionRecording = recording
        return question
    }

    // MARK: Live changes

    public nonisolated func events(after cursor: Int?) -> AsyncThrowingStream<InboxEvent, Error> {
        let client = client
        let userId = userId
        return AsyncThrowingStream { continuation in
            let task = Task {
                var sockets: [URLSessionWebSocketTask] = []
                do {
                    // The person's own channel, and each team's: a row on a team
                    // workspace is announced on the team's channel.
                    let me = try await client.me()
                    for channel in ["personal:\(userId)"] + me.memberships.map(\.orgId) {
                        let ticket = try await client.ticket(channel: channel)
                        let socket = client.socket(channel: ticket.channel, ticket: ticket.ticket)
                        socket.resume()
                        sockets.append(socket)
                    }
                    continuation.yield(.hello(cursor: 0))
                    let opened = sockets
                    try await withTaskCancellationHandler {
                        try await withThrowingTaskGroup(of: Void.self) { group in
                            for socket in opened {
                                group.addTask {
                                    while true {
                                        let frame = try await socket.receive()
                                        continuation.yield(.record(seq: 0, kind: Self.kind(of: frame)))
                                    }
                                }
                            }
                            try await group.next()
                        }
                    } onCancel: {
                        for socket in opened { socket.cancel(with: .goingAway, reason: nil) }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
                for socket in sockets { socket.cancel(with: .goingAway, reason: nil) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    static func kind(of frame: URLSessionWebSocketTask.Message) -> String {
        let data: Data
        switch frame {
        case .string(let text): data = Data(text.utf8)
        case .data(let bytes): data = bytes
        @unknown default: return ""
        }
        return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["kind"] as? String ?? ""
    }

    // MARK: Mapping

    static func threadId(_ workspace: String, _ document: String, _ annotation: String) -> String {
        "\(workspace)/\(document)/\(annotation)"
    }

    static func parse(_ id: String) throws(InboxError) -> (String, String, String) {
        let parts = id.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, parts.allSatisfy({ !$0.isEmpty }) else { throw .refused(status: 404, code: "thread_not_found", message: "This thread is not in Workspaces.", triesLeft: nil) }
        return (parts[0], parts[1], parts[2])
    }

    private func recording(_ message: String, _ key: String) -> Bool {
        Ticks.get("\(message)/\(key)") ?? lastThreads[message]?.messages.first?.questions?.first { $0.key == key }?.decisionRecording ?? false
    }

    private func answered(_ result: AnswerResult, message id: String) -> InboxQuestionsResponse {
        let (workspace, document, _) = (try? Self.parse(id)) ?? ("", "", "")
        return InboxQuestionsResponse(messageId: id, questions: result.questions.map { question($0, message: id, prefix: "\(workspace)/\(document)/") })
    }

    private func question(_ q: Question, message: String, prefix: String) -> InboxQuestion {
        // A sent question shows whether it recorded a decision; an unsent one the
        // person's tick, else the agent's "Decision: when answered".
        let recording = q.state == "sent" ? q.decisionId != nil : Ticks.get("\(message)/\(q.key)") ?? q.decisionOnAnswer
        return InboxQuestion(
            key: q.key, position: q.position, kind: q.kind, prompt: q.prompt, context: q.context, choices: q.choices,
            recommendation: q.recommendation, suggestedText: q.suggestedText, stopped: q.stopped, holdsUp: q.holdsUp,
            state: q.state, answer: q.answer, revision: q.revision, pickedAt: q.pickedAt,
            sentReplyId: q.sentReplyId.map { prefix + $0 }, messageId: message, decisionRecording: recording
        )
    }

    private func author(agent: Comment.Agent?, user: String?, name: String?) -> InboxAuthor {
        if let agent { return Self.author(Feed.Actor(kind: "agent", name: agent.name)) }
        // The person's own words read as "You"; anyone else's by their name.
        if user == userId { return InboxAuthor(kind: "person", host: nil, session: nil, name: nil) }
        return InboxAuthor(kind: "person", host: nil, session: nil, name: name ?? "Someone on your team")
    }

    static func author(_ actor: Feed.Actor) -> InboxAuthor {
        guard actor.kind == "agent" || actor.kind == "assistant" else {
            return InboxAuthor(kind: "person", host: nil, session: nil, name: actor.name)
        }
        // A known agent's name gets its mark ("Claude Code" is claude-code).
        let host = InboxAuthor.hostNames.first { $0.value == actor.name }?.key
        return InboxAuthor(kind: "agent", host: host, session: nil, name: actor.name)
    }

    static func firstLine(_ text: String?) -> String? {
        text?.split(separator: "\n").lazy.map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty && !$0.hasPrefix(":::") }
            .map { $0.drop { $0 == "#" }.trimmingCharacters(in: .whitespaces) }
    }

    // MARK: Wire shapes (only the fields the phone reads)

    struct Feed: Decodable {
        struct Questions: Decodable {
            var open: Int
            var picked: Int
            var prompt: String?
            var stopped: Bool
            var holdsUp: [String]
        }
        struct Actor: Decodable {
            var kind: String
            var name: String?
        }
        struct Target: Decodable { var path: String? }
        struct Event: Decodable {
            var actor: Actor
            var projectId: String?
            var target: Target?
            var excerpt: String?
        }
        struct Workspace: Decodable {
            var id: String
            var name: String?
        }
        struct Item: Decodable {
            var id: String
            var reason: String
            var threadKey: String
            var workspace: Workspace
            var documentId: String?
            var questions: Questions?
            var askedByCheckedAt: String?
            var event: Event
            var actors: [Actor]
            var updatedAt: String
            var seenAt: String?
        }
        var items: [Item]
    }

    struct ProjectList: Decodable {
        struct Project: Decodable { var id: String; var name: String }
        var projects: [Project]
    }

    struct Question: Decodable {
        var key: String
        var position: Int
        var kind: String
        var prompt: String
        var context: String?
        var choices: [InboxChoice]
        var recommendation: String?
        var suggestedText: String?
        var decisionOnAnswer: Bool
        var stopped: String?
        var holdsUp: [String]
        var askedByCheckedAt: String?
        var state: String
        var answer: QuestionAnswer?
        var revision: Int
        var pickedAt: String?
        var sentReplyId: String?
        var decisionId: String?
    }

    struct Comment: Decodable {
        struct Anchor: Decodable { var quote: String? }
        struct Agent: Decodable { var name: String? }
        struct Reply: Decodable {
            var id: String
            var body: String
            var author: String?
            var authorName: String?
            var agent: Agent?
            var createdAt: String
        }
        var id: String
        var anchor: Anchor?
        var body: String
        var author: String?
        var authorName: String?
        var agent: Agent?
        var state: String
        var createdAt: String
        var updatedAt: String
        var replies: [Reply]
        var questions: [Question]?
    }

    struct AnswerResult: Decodable {
        var questions: [Question]
    }
}

/// The decision ticks the person set, per question, kept until the Send that records them.
enum Ticks {
    private static let name = "workspacesDecisionTicks"

    static func get(_ id: String) -> Bool? {
        (UserDefaults.standard.dictionary(forKey: name) as? [String: Bool])?[id]
    }

    static func set(_ value: Bool?, _ id: String) {
        var all = UserDefaults.standard.dictionary(forKey: name) as? [String: Bool] ?? [:]
        all[id] = value
        UserDefaults.standard.set(all, forKey: name)
    }
}
