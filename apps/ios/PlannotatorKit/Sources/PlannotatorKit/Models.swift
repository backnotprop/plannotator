import Foundation

// The Inbox's wire shapes as the device door answers them
// (`adr/implementation/inbox-mobile.md` section 2 and exchanges 7.4 to 7.13;
// the TypeScript originals are in `packages/core/inbox-types.ts`). Only the
// fields the app reads are declared; the decoder ignores the rest, so the
// Inbox can add fields without breaking an older app.

public struct InboxAuthor: Codable, Hashable, Sendable {
    public var kind: String
    public var host: String?
    public var session: String?
    public var name: String?

    public init(kind: String, host: String? = nil, session: String? = nil, name: String? = nil) {
        self.kind = kind
        self.host = host
        self.session = session
        self.name = name
    }

    public var isAgent: Bool { kind == "agent" }

    /// How the person sees an agent: the name it gave, else its host's name, else "An agent"
    /// (`inboxAgentName` in `packages/core/inbox-types.ts`).
    public var agentName: String {
        guard isAgent else { return "An agent" }
        if let name, !name.isEmpty { return name }
        if let host, !host.isEmpty { return InboxAuthor.hostNames[host] ?? host }
        return "An agent"
    }

    public static let hostNames: [String: String] = [
        "claude-code": "Claude Code", "claude": "Claude Code", "pi": "Pi",
        "opencode": "OpenCode", "codex": "Codex", "cursor": "Cursor",
    ]
}

public struct InboxProjectRef: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
}

public struct InboxProject: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var threads: Int?
    public var unread: Int?
}

public struct InboxQuestionSummary: Codable, Hashable, Sendable {
    public var open: Int
    public var picked: Int
    public var stopped: Bool
    public var holdsUp: [String]
}

public struct InboxSentState: Codable, Hashable, Sendable {
    public var at: String
    public var checkedAt: String?
}

/// One row of the list: a thread, placed in its section.
public struct InboxListRow: Codable, Hashable, Sendable, Identifiable {
    public var threadId: String
    public var projectId: String
    public var subject: String?
    public var author: InboxAuthor
    public var lastAt: String
    public var questions: InboxQuestionSummary
    public var project: InboxProjectRef
    public var threadName: String?
    public var section: String
    public var unread: Bool
    public var answeredNotSent: Bool
    public var sent: InboxSentState?
    public var guide: Bool?

    public var id: String { threadId }
}

public struct InboxListSection: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var label: String
    public var threads: [InboxListRow]
}

/// `GET threads`: the list model (exchange 7.5).
public struct InboxListModel: Codable, Hashable, Sendable {
    public var cursor: Int
    public var projects: [InboxProject]
    public var sections: [InboxListSection]

    public var threadIds: Set<String> { Set(sections.flatMap { $0.threads.map(\.threadId) }) }
}

public struct InboxChoice: Codable, Hashable, Sendable {
    public var label: String
    public var description: String?
    public var recommended: Bool
    public var settled: Bool
}

/// Plannotator's `QuestionAnswer` v1, as a pick saves it.
public struct QuestionAnswer: Codable, Hashable, Sendable {
    public var v: Int = 1
    public var key: String
    public var kind: String
    public var prompt: String
    public var selected: [String]
    public var other: String?
    public var text: String?
    public var note: String?
    public var skipped: Bool?

    public init(key: String, kind: String, prompt: String, selected: [String] = [], other: String? = nil, text: String? = nil, note: String? = nil, skipped: Bool? = nil) {
        self.key = key
        self.kind = kind
        self.prompt = prompt
        self.selected = selected
        self.other = other
        self.text = text
        self.note = note
        self.skipped = skipped
    }

    /// A pick, Other or free text (`isQuestionAnswered` in core).
    public var isAnswered: Bool {
        !selected.isEmpty || !(other ?? "").trimmed.isEmpty || !(text ?? "").trimmed.isEmpty
    }

    /// Nothing worth keeping: not answered, not skipped, no note (`isQuestionAnswerEmpty`).
    public var isEmpty: Bool { !isAnswered && skipped != true && (note ?? "").trimmed.isEmpty }

    /// The words an answer reads as in a reply draft ("Retry with the same idempotency key").
    public var words: String {
        if skipped == true { return "skipped" }
        var parts = selected
        if let other, !other.trimmed.isEmpty { parts.append(other) }
        if let text, !text.trimmed.isEmpty { parts.append(text) }
        return parts.joined(separator: ", ")
    }
}

/// A question as the window and the phone read it (Workspaces' `Question` plus `message_id`).
public struct InboxQuestion: Codable, Hashable, Sendable, Identifiable {
    public var key: String
    public var position: Int
    public var kind: String
    public var prompt: String
    public var context: String?
    public var choices: [InboxChoice]
    public var recommendation: String?
    public var suggestedText: String?
    public var stopped: String?
    public var holdsUp: [String]
    public var state: String
    public var answer: QuestionAnswer?
    public var revision: Int
    public var pickedAt: String?
    public var sentReplyId: String?
    public var messageId: String
    public var decisionRecording: Bool
    /// The decision card's kept words (7.21); nil follows the answer.
    public var decisionDraft: InboxDecisionDraft?

    public var id: String { "\(messageId)/\(key)" }
    public var isOpen: Bool { state == "open" }
    public var isPicked: Bool { state == "picked" }
    public var isSent: Bool { state == "sent" }
    public var isClosed: Bool { state == "closed" }
    public var hasRecommendation: Bool { choices.contains(where: \.recommended) || suggestedText != nil }

    /// The answer the recommendation stands for (`recommendedQuestionAnswer` in core), keeping a note.
    public func recommendedAnswer(keeping base: QuestionAnswer?) -> QuestionAnswer? {
        let labels = choices.filter(\.recommended).map(\.label)
        var next = QuestionAnswer(key: key, kind: kind, prompt: prompt, note: base?.note)
        if !labels.isEmpty {
            next.selected = labels
            return next
        }
        guard let suggestedText else { return nil }
        if kind == "text" { next.text = suggestedText } else { next.other = suggestedText }
        return next
    }

    /// `open`, `answered`, `skipped` or `settled`, as the card's tag reads (`questionStatus` in core).
    public var status: String {
        if let answer, answer.isAnswered { return "answered" }
        if answer?.skipped == true { return "skipped" }
        if choices.contains(where: \.settled) { return "settled" }
        return "open"
    }
}

public struct InboxDelivery: Codable, Hashable, Sendable {
    public var host: String
    public var at: String
}

public struct InboxAddressee: Codable, Hashable, Sendable {
    public var host: String
}

public struct InboxMessage: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var projectId: String?
    public var threadId: String
    public var replyTo: String?
    public var author: InboxAuthor
    public var subject: String?
    public var body: String
    public var createdAt: String
    public var resolvedAt: String?
    public var agentCheckedAt: String?
    public var delivery: InboxDelivery?
    public var to: InboxAddressee?
    public var questions: [InboxQuestion]?
    /// The guided review this message carries (submit_guide), drawn as its tile in the thread.
    public var guide: InboxGuideRef?
    /// The person's reviewed tick per section, as last saved (absent until the first tick).
    public var guideReviewed: [Bool]?
    /// The sender's key: on the person's reply, the Send's idempotency key.
    public var idempotencyKey: String?
    public var threadName: String?
}

/// What a message keeps about its guided review (`InboxGuideRef` in core): the facts its tile draws.
public struct InboxGuideRef: Codable, Hashable, Sendable {
    public var title: String
    public var sections: Int
    public var files: Int
    public var additions: Int
    public var deletions: Int
}

public struct InboxThreadProject: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    /// The project's folder: a path inside it reads relative in the feedback text.
    public var root: String?
}

public struct InboxThread: Codable, Hashable, Sendable {
    public var threadId: String
    public var project: InboxThreadProject
    public var subject: String?
    public var threadName: String?
    public var resolvedAt: String?
    public var messages: [InboxMessage]
    /// Workspaces only: the document the thread's comment is anchored to. The Inbox never sends it.
    public var document: InboxThreadDocument?
}

/// A Workspaces comment's document: where it lives and the passage it is pinned to.
public struct InboxThreadDocument: Codable, Hashable, Sendable {
    public var workspaceId: String
    public var workspaceName: String?
    public var documentId: String
    public var path: String?
    public var quote: String?
}

/// `GET threads/:id` (exchange 7.7).
public struct InboxThreadResponse: Codable, Hashable, Sendable {
    public var cursor: Int
    public var thread: InboxThread
}

/// `POST messages/:id/picks` and `.../reply` both answer the message's questions (7.10, 7.11).
public struct InboxQuestionsResponse: Codable, Hashable, Sendable {
    public var messageId: String
    public var questions: [InboxQuestion]
}

public struct InboxHealth: Codable, Hashable, Sendable {
    public var ok: Bool
    public var app: String
    public var version: String
}

public struct InboxDevice: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var platform: String
    public var createdAt: String
    public var revokedAt: String?
}

public struct InboxAddresses: Codable, Hashable, Sendable {
    public var tailnet: String?
    public var lan: String?
    public var fingerprint: String?

    public init(tailnet: String?, lan: String?, fingerprint: String?) {
        self.tailnet = tailnet
        self.lan = lan
        self.fingerprint = fingerprint
    }
}

public struct InboxRelayRef: Codable, Hashable, Sendable {
    public var url: String
    public var mailboxId: String
}

/// `POST pair` (exchanges 7.2, 7.3).
public struct InboxPairResponse: Codable, Sendable {
    public struct Computer: Codable, Sendable { public var name: String }
    public var device: InboxDevice
    public var token: String
    public var secret: String
    public var computer: Computer
    public var addresses: InboxAddresses
    public var relay: InboxRelayRef?
}

/// The door's error body, `{ error, code, ...details }` (section 2, "Error codes").
public struct InboxErrorBody: Codable, Sendable {
    public var error: String
    public var code: String
    public var triesLeft: Int?
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
