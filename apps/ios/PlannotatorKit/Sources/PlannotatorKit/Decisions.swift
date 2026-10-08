import Foundation

// Decisions and New message on the device door (contract section 2,
// exchanges 7.21 to 7.24; the TypeScript originals are `InboxDecision` in
// packages/core/inbox-types.ts, `InboxWaitingDecision` in
// packages/server/inbox-decisions.ts and `InboxLiveSession` in
// packages/server/inbox-sessions.ts).

/// The words the decision card keeps (`InboxDecisionDraft`): null fields follow the answer.
public struct InboxDecisionDraft: Codable, Hashable, Sendable {
    public var text: String?
    public var reason: String?

    public init(text: String?, reason: String?) {
        self.text = text
        self.reason = reason
    }
}

public struct InboxDecisionAgent: Codable, Hashable, Sendable {
    public var host: String?
    public var session: String?
    public var name: String?

    /// How the person sees the agent ("Claude Code").
    public var displayName: String { InboxAuthor(kind: "agent", host: host, session: session, name: name).agentName }
}

public struct InboxDecisionSource: Codable, Hashable, Sendable {
    /// `answer`, `agent` or `person`.
    public var kind: String
    public var threadId: String?
    public var agent: InboxDecisionAgent?
}

public struct InboxDecision: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var projectId: String
    public var text: String
    public var reason: String?
    public var source: InboxDecisionSource
    /// `current`, `replaced` or `retired`.
    public var state: String
    public var createdAt: String
    public var changedAt: String?
}

/// A question that records a decision once it is answered and sent: the Waiting group.
public struct InboxWaitingDecision: Codable, Hashable, Sendable, Identifiable {
    public var questionId: String
    public var threadId: String
    public var prompt: String
    public var agent: InboxDecisionAgent?
    public var askedAt: String

    public var id: String { questionId }
}

/// `GET decisions?project=` (exchange 7.22).
public struct InboxDecisionsModel: Codable, Hashable, Sendable {
    public var cursor: Int
    public var projectId: String
    public var waiting: [InboxWaitingDecision]
    public var decisions: [InboxDecision]
}

/// One live agent session of a thread's project (exchange 7.23).
public struct InboxLiveSession: Codable, Hashable, Sendable, Identifiable {
    public var session: String
    public var host: String
    public var startedAt: String
    public var lastSeenAt: String
    /// A turn runs now; nil when the connection does not say.
    public var busy: Bool?
    public var idleSince: String?
    public var wroteThread: Bool

    public var id: String { session }
    public var hostName: String { InboxAuthor.hostNames[host] ?? host }
}

/// `GET threads/:id/sessions`: the project's live sessions, the thread's own writers first.
public struct InboxLiveSessions: Codable, Hashable, Sendable {
    public struct Project: Codable, Hashable, Sendable {
        public var name: String
        public var root: String
    }

    public var home: String?
    public var project: Project
    public var sessions: [InboxLiveSession]

    /// The project's folder as the person reads it: `~/src/ledger` (`tildePath` in packages/inbox/format.ts).
    public var folder: String {
        guard var home, !home.isEmpty else { return project.root }
        while home.hasSuffix("/") { home.removeLast() }
        if project.root == home { return "~" }
        return project.root.hasPrefix(home + "/") ? "~" + project.root.dropFirst(home.count) : project.root
    }
}

extension InboxClient {
    /// `GET decisions?project=`: what waits on a call and every decision of one project (7.22).
    public func decisions(project: String) async throws(InboxError) -> InboxDecisionsModel {
        try await get("decisions", query: [URLQueryItem(name: "project", value: project)])
    }

    /// Done on the decision card (7.21): recording on, with the person's words, or
    /// `nil` to keep the drafted words that follow the answer.
    public func keepDecision(message id: String, key: String, draft: InboxDecisionDraft?) async throws(InboxError) -> InboxQuestion {
        struct Body: Encodable {
            var key: String
            var draft: InboxDecisionDraft?
            enum CodingKeys: String, CodingKey { case idempotencyKey = "idempotency_key", key, recording, draft }
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(UUID().uuidString.lowercased(), forKey: .idempotencyKey)
                try c.encode(key, forKey: .key)
                try c.encode(true, forKey: .recording)
                try c.encode(draft, forKey: .draft) // null keeps the drafted words
            }
        }
        struct Answer: Decodable { var question: InboxQuestion }
        let answer: Answer = try await post("messages/\(id)/decision", Body(key: key, draft: draft))
        return answer.question
    }

    /// `GET threads/:id/sessions`: the live sessions a New message can go to (7.23).
    public func sessions(thread id: String) async throws(InboxError) -> InboxLiveSessions {
        try await get("threads/\(id)/sessions")
    }

    /// `POST threads/:id/message`: New message to one live session (7.24). The key is the caller's, kept across retries.
    public func newMessage(thread id: String, session: String, body: String, idempotencyKey: String) async throws(InboxError) {
        struct Body: Encodable { var idempotencyKey: String; var session: String; var body: String }
        let _: Ignored = try await post("threads/\(id)/message", Body(idempotencyKey: idempotencyKey, session: session, body: body))
    }
}

// MARK: The decision card's drafted words (packages/core/inbox-questions.ts)

public enum DecisionWords {
    /// The statement drafted from an answer (`draftInboxDecisionText`): the chosen
    /// labels as a sentence, several joined with commas and "and", Other or a
    /// written answer as written. Nil when the answer decides nothing.
    public static func text(_ answer: QuestionAnswer?) -> String? {
        guard let answer, answer.skipped != true else { return nil }
        let parts = (answer.selected + [answer.other, answer.text].compactMap { $0 }).map(oneLine).filter { !$0.isEmpty }
        guard !parts.isEmpty else { return nil }
        let joined = parts.count == 1 ? parts[0] : parts.dropLast().joined(separator: ", ") + " and " + parts.last!
        let sentence = joined.prefix(1).uppercased() + joined.dropFirst()
        return sentence.last.map { ".!?…".contains($0) } == true ? sentence : sentence + "."
    }

    /// The Why line (`draftInboxDecisionReason`): "Asked by <agent>: <the question>".
    public static func reason(asker: String, prompt: String) -> String {
        let name = oneLine(asker)
        return "Asked by \(name.isEmpty ? "An agent" : name): \(oneLine(prompt))"
    }

    private static func oneLine(_ value: String) -> String {
        value.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}
