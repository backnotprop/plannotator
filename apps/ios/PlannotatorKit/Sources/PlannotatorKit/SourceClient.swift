import Foundation

/// What a shown source answers: the list, a thread, a pick, a Send and the
/// rest, in the Inbox's own wire models. The Inbox's device door fills it as it
/// is (`InboxClient`); Workspaces fills it by mapping its doors onto the same
/// models (`WorkspacesSource`), so one session and one set of screens serve both.
public protocol SourceClient: Sendable {
    func list(project: String?) async throws(InboxError) -> InboxListModel
    func thread(_ id: String) async throws(InboxError) -> InboxThreadResponse
    // Each command takes the caller's idempotency key, made once per intent and
    // kept across a change of path (contract section 6); Workspaces keys its
    // own doors and may ignore it.
    func seen(thread id: String, idempotencyKey: String) async throws(InboxError)
    func pick(message id: String, key: String, revision: Int, answer: QuestionAnswer?, idempotencyKey: String) async throws(InboxError) -> InboxQuestionsResponse
    func reply(message id: String, idempotencyKey: String, words: String, questions: [InboxClient.SendQuestion]) async throws(InboxError) -> InboxQuestionsResponse
    func resolve(message id: String, resolved: Bool, idempotencyKey: String) async throws(InboxError)
    func delete(thread id: String, idempotencyKey: String) async throws(InboxError)
    func setDecisionRecording(message id: String, key: String, recording: Bool, idempotencyKey: String) async throws(InboxError) -> InboxQuestion
    /// Live changes while the app is open: `hello` once connected, then one
    /// `record` per change. It ends when the connection drops.
    func events(after cursor: Int?) -> AsyncThrowingStream<InboxEvent, Error>
}

extension InboxClient: SourceClient {}
