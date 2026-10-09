import Foundation

// What the app does with a store line the relay carried (contract section 4,
// "What goes down and up"): records are full snapshots in the event stream's
// shape, so a message or a question goes straight into the thread the app
// keeps. That is how the phone shows what it last received while the
// computer is asleep; when the computer answers, the app reads the list and
// the open threads again through the relay, and those reads win.

/// A down item's store line, decoded.
public enum InboxRecord: Sendable {
    case message(InboxMessage)
    case question(InboxQuestion)
    case project(InboxProject)
    /// A decision or an annotation: the screens that show them read again.
    case other
}

extension RelayRecord {
    /// The line's record; nil for a `too_large` placeholder or a line this app cannot read.
    public var record: InboxRecord? {
        guard !tooLarge else { return nil }
        struct Message: Decodable { var message: InboxMessage }
        struct Question: Decodable { var question: InboxQuestion }
        struct Project: Decodable { var project: InboxProject }
        let decoder = InboxClient.decoder
        switch kind {
        case "message": return (try? decoder.decode(Message.self, from: json)).map { .message($0.message) }
        case "question": return (try? decoder.decode(Question.self, from: json)).map { .question($0.question) }
        case "project": return (try? decoder.decode(Project.self, from: json)).map { .project($0.project) }
        default: return .other
        }
    }
}

extension InboxThread {
    /// The thread a root message starts.
    public init(root: InboxMessage, projectName: String) {
        self.init(
            threadId: root.threadId,
            project: InboxThreadProject(id: root.projectId ?? "", name: projectName),
            subject: root.subject,
            threadName: root.threadName,
            resolvedAt: root.resolvedAt,
            messages: [root]
        )
    }

    public func contains(message id: String) -> Bool {
        messages.contains { $0.id == id }
    }

    /// A message's line: a known message is replaced (its questions are their
    /// own lines and stay), a new one is added in time order. False when it is
    /// not this thread's.
    @discardableResult
    public mutating func apply(_ message: InboxMessage) -> Bool {
        guard message.threadId == threadId else { return false }
        var next = message
        if let index = messages.firstIndex(where: { $0.id == message.id }) {
            next.questions = messages[index].questions
            messages[index] = next
        } else {
            messages.append(next)
            messages.sort { $0.createdAt < $1.createdAt }
        }
        if message.id == threadId {
            resolvedAt = message.resolvedAt
            subject = message.subject ?? subject
            threadName = message.threadName ?? threadName
        }
        return true
    }

    /// A question's line, into its message. False when that message is not here.
    @discardableResult
    public mutating func apply(_ question: InboxQuestion) -> Bool {
        guard let m = messages.firstIndex(where: { $0.id == question.messageId }) else { return false }
        var questions = messages[m].questions ?? []
        if let q = questions.firstIndex(where: { $0.key == question.key }) { questions[q] = question } else { questions.append(question) }
        messages[m].questions = questions.sorted { $0.position < $1.position }
        return true
    }
}

extension InboxListModel {
    /// A thread a record brought that the list does not show yet, while the
    /// computer cannot answer a list read: under Waiting on you when it asks
    /// something, else New since you looked. The next list read replaces it.
    public mutating func add(_ thread: InboxThread) {
        guard !threadIds.contains(thread.threadId), let root = thread.messages.first else { return }
        let questions = thread.messages.flatMap { $0.questions ?? [] }
        let open = questions.filter(\.isOpen).count
        let row = InboxListRow(
            threadId: thread.threadId,
            projectId: thread.project.id,
            subject: thread.subject,
            author: root.author,
            lastAt: thread.messages.last?.createdAt ?? root.createdAt,
            questions: InboxQuestionSummary(open: open, picked: questions.filter(\.isPicked).count, stopped: questions.contains { $0.isOpen && $0.stopped != nil }, holdsUp: []),
            project: InboxProjectRef(id: thread.project.id, name: thread.project.name),
            threadName: thread.threadName,
            section: open > 0 ? "waiting" : "new",
            unread: true,
            answeredNotSent: false,
            sent: nil,
            guide: nil
        )
        guard let index = sections.firstIndex(where: { $0.id == row.section }) else { return }
        sections[index].threads.insert(row, at: 0)
    }
}
