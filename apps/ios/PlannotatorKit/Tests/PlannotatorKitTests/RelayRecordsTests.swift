import Foundation
import Testing
@testable import PlannotatorKit

// The two pure pieces of the relay path the app leans on: a down item opens
// only as a record or a result (a push shares the key), and a record goes
// into the thread the app keeps exactly as the next thread read would show it.
@Suite struct RelayRecordsTests {
    static func data(_ object: [String: Any]) -> Data { try! JSONSerialization.data(withJSONObject: object) }

    nonisolated(unsafe) static let root: [String: Any] = [
        "id": "msg_1", "project_id": "prj_1", "thread_id": "msg_1", "reply_to": NSNull(),
        "author": ["kind": "agent", "host": "claude-code"], "subject": "Run the retry tests?", "body": "Ready.",
        "created_at": "2026-10-08T10:42:00.000Z", "resolved_at": NSNull(), "idempotency_key": NSNull(),
    ]

    nonisolated(unsafe) static let question: [String: Any] = [
        "key": "q-1", "position": 0, "kind": "single", "prompt": "Run the retry tests?", "context": NSNull(),
        "choices": [["label": "Yes", "description": NSNull(), "recommended": true, "settled": false]],
        "recommendation": "Yes", "suggested_text": NSNull(), "stopped": NSNull(), "holds_up": [], "state": "open",
        "answer": NSNull(), "revision": 0, "picked_at": NSNull(), "sent_reply_id": NSNull(), "message_id": "msg_1",
        "decision_recording": false,
    ]

    @Test func opensRecordsAndResultsOnly() throws {
        let record = RelayItem(Self.data(["v": 1, "type": "record", "after": 4, "seq": 5, "kind": "message", "id": "msg_1", "message": Self.root]))
        guard case .record(let line) = record else { Issue.record("not a record"); return }
        #expect(line.seq == 5 && line.after == 4 && !line.tooLarge)
        let result = RelayItem(Self.data(["v": 1, "type": "result", "id": "k", "status": 409, "content_type": "application/json", "body_b64": Data("{}".utf8).base64EncodedString()]))
        guard case .result(let answer) = result else { Issue.record("not a result"); return }
        #expect(answer.id == "k" && answer.answer.status == 409)
        // A push sealed under the same key is not a down item.
        #expect(RelayItem(Self.data(["v": 1, "type": "push", "thread_id": "msg_1", "message_id": "msg_1"])) == nil)
        #expect(RelayItem(Self.data(["v": 2, "type": "record", "seq": 1, "kind": "message", "id": "x"])) == nil)
        let placeholder = RelayItem(Self.data(["v": 1, "type": "record", "after": 5, "seq": 6, "kind": "message", "id": "msg_2", "too_large": true]))
        guard case .record(let large) = placeholder else { Issue.record("not a record"); return }
        #expect(large.tooLarge && large.record == nil)
    }

    @Test func appliesRecordsToTheThread() throws {
        func record(_ kind: String, _ body: [String: Any], seq: Int) throws -> InboxRecord {
            guard case .record(let line) = RelayItem(Self.data(["v": 1, "type": "record", "after": seq - 1, "seq": seq, "kind": kind, "id": "x", kind: body])) else { throw CancellationError() }
            return try #require(line.record)
        }
        guard case .message(let root) = try record("message", Self.root, seq: 1),
              case .question(var question) = try record("question", Self.question, seq: 2) else { Issue.record("decode"); return }
        var thread = InboxThread(root: root, projectName: "billing-svc")
        let applied = thread.apply(question)
        #expect(applied)
        // The root's line again (resolved): its question stays.
        var resolved = Self.root
        resolved["resolved_at"] = "2026-10-08T11:00:00.000Z"
        guard case .message(let again) = try record("message", resolved, seq: 3) else { return }
        thread.apply(again)
        #expect(thread.resolvedAt == "2026-10-08T11:00:00.000Z")
        #expect(thread.messages.count == 1 && thread.messages[0].questions?.count == 1)
        question.state = "picked"
        thread.apply(question)
        #expect(thread.messages[0].questions?.first?.state == "picked")
        // Another thread's message is not this one's.
        var other = root
        other.threadId = "msg_9"
        let foreign = thread.apply(other)
        #expect(!foreign)

        var list = InboxListModel(cursor: 3, projects: [], sections: ["stopped", "waiting", "new"].map { InboxListSection(id: $0, label: $0, threads: []) })
        question.state = "open"
        thread.apply(question)
        list.add(thread)
        #expect(list.sections.first { $0.id == "waiting" }?.threads.map(\.threadId) == ["msg_1"])
        list.add(thread)
        #expect(list.threadIds.count == 1)
    }
}
