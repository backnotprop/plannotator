import Foundation

// Guided reviews as the device door answers them (exchanges 7.19 and 7.20).
// The guide's record and its snapshot cross the surface bridge as they are
// (contract section 5, `open_guide`), so they are read with no key conversion
// and kept as JSON: the app never reads inside a snapshot, Plannotator's
// guide viewer in the surface does.

/// `GET messages/:id/guide`: the guide's record and the stored snapshot.
public struct InboxGuideView: Decodable, Sendable {
    public var message_id: String
    public var guide: JSONValue
    public var snapshot: JSONValue
}

extension InboxClient {
    /// `GET messages/:id/guide` (7.19).
    public func guide(message id: String) async throws(InboxError) -> InboxGuideView {
        try await send(request("messages/\(id)/guide"), decoder: Self.plainDecoder)
    }

    /// `POST messages/:id/guide/reviewed` (7.20): every section's tick, as the
    /// person left them. Answers the ticks as the Inbox keeps them.
    public func saveGuideReviewed(message id: String, reviewed: [Bool]) async throws(InboxError) -> [Bool] {
        struct Body: Encodable {
            var idempotency_key = UUID().uuidString.lowercased()
            var reviewed: [Bool]
        }
        struct Answer: Decodable { var reviewed: [Bool] }
        let answer: Answer = try await post("messages/\(id)/guide/reviewed", Body(reviewed: reviewed), encoder: Self.plainEncoder, decoder: Self.plainDecoder)
        return answer.reviewed
    }
}
