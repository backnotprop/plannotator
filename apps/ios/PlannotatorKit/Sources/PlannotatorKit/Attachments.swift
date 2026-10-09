import Foundation

// Attachments and annotations as the device door answers them (exchanges
// 7.14 to 7.18; the TypeScript originals are `InboxAttachmentState` and
// `InboxAnnotationRecord` in `packages/core/inbox-attachments.ts`). These
// shapes also cross the surface bridge as they are (contract section 5), so
// they are read and written with explicit keys and no key conversion: a
// round trip gives back the door's own JSON, and Plannotator's `Annotation`
// inside a record stays exactly as the viewer made it.

/// Any JSON value, carried through untouched (Plannotator's `Annotation`).
public enum JSONValue: Codable, Hashable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let object) = self { return object[key] }
        return nil
    }

    public var string: String? {
        if case .string(let v) = self { return v }
        return nil
    }

    /// The same object with one key set.
    public func setting(_ key: String, to value: JSONValue) -> JSONValue {
        guard case .object(var object) = self else { return self }
        object[key] = value
        return .object(object)
    }
}

public struct InboxAttachmentCurrent: Codable, Hashable, Sendable {
    public var sha256: String
    public var size: Int
    public var mtime: String
}

public struct InboxAttachmentUnavailable: Codable, Hashable, Sendable {
    public var code: String
    public var message: String
}

/// An attachment as the window reads it: the record plus the file as it is now (7.14).
public struct InboxAttachmentState: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var path: String
    public var namedPath: String?
    public var name: String
    public var kind: String
    public var sentSha256: String
    public var size: Int
    public var sentAt: String
    public var sentMtime: String
    public var messageId: String
    public var current: InboxAttachmentCurrent?
    public var changedSinceSent: Bool
    public var unavailable: InboxAttachmentUnavailable?

    enum CodingKeys: String, CodingKey {
        case id, path, name, kind, size, current, unavailable
        case namedPath = "named_path", sentSha256 = "sent_sha256", sentAt = "sent_at", sentMtime = "sent_mtime"
        case messageId = "message_id", changedSinceSent = "changed_since_sent"
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(path, forKey: .path)
        try c.encode(namedPath, forKey: .namedPath) // null, as the door writes it
        try c.encode(name, forKey: .name)
        try c.encode(kind, forKey: .kind)
        try c.encode(sentSha256, forKey: .sentSha256)
        try c.encode(size, forKey: .size)
        try c.encode(sentAt, forKey: .sentAt)
        try c.encode(sentMtime, forKey: .sentMtime)
        try c.encode(messageId, forKey: .messageId)
        try c.encode(current, forKey: .current)
        try c.encode(changedSinceSent, forKey: .changedSinceSent)
        try c.encode(unavailable, forKey: .unavailable)
    }

    public var isHTML: Bool { kind == "html" }
    public var isDiagram: Bool { kind == "mermaid" || kind == "graphviz" }

    /// "Markdown", "HTML", "Mermaid", "Graphviz", or a text file's extension
    /// (`inboxAttachmentKindLabel` in core).
    public var kindLabel: String {
        switch kind {
        case "markdown": return "Markdown"
        case "html": return "HTML"
        case "mermaid": return "Mermaid"
        case "graphviz": return "Graphviz"
        default:
            let ext = (name as NSString).pathExtension
            return ext.isEmpty || ext.lowercased() == "txt" ? "Text" : ext.uppercased()
        }
    }
}

/// One of the person's annotations on an attachment, waiting for a Send (7.17).
public struct InboxAnnotationRecord: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var projectId: String
    public var threadId: String
    public var messageId: String
    public var attachmentId: String
    public var path: String
    /// `"current"` or the sent sha256.
    public var version: String
    /// Plannotator's `Annotation`, as the viewer made it.
    public var annotation: JSONValue
    public var createdAt: String
    public var updatedAt: String
    public var removedAt: String?
    public var sentReplyId: String?

    enum CodingKeys: String, CodingKey {
        case id, path, version, annotation
        case projectId = "project_id", threadId = "thread_id", messageId = "message_id", attachmentId = "attachment_id"
        case createdAt = "created_at", updatedAt = "updated_at", removedAt = "removed_at", sentReplyId = "sent_reply_id"
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encode(projectId, forKey: .projectId)
        try c.encode(threadId, forKey: .threadId)
        try c.encode(messageId, forKey: .messageId)
        try c.encode(attachmentId, forKey: .attachmentId)
        try c.encode(path, forKey: .path)
        try c.encode(version, forKey: .version)
        try c.encode(annotation, forKey: .annotation)
        try c.encode(createdAt, forKey: .createdAt)
        try c.encode(updatedAt, forKey: .updatedAt)
        try c.encode(removedAt, forKey: .removedAt)
        try c.encode(sentReplyId, forKey: .sentReplyId)
    }

    /// The person's words.
    public var text: String { annotation["text"]?.string ?? "" }
    /// What it quotes: the selection, or the element or diagram part it names.
    public var quote: String { annotation["originalText"]?.string ?? "" }

    /// The small tag the 3.6 row shows before a quote: the element a pin is on
    /// ("button"), or the diagram part ("node E") (`annotationTag` in the window).
    public var tag: String? {
        if let diagram = annotation["diagramAnchor"] {
            let kind = diagram["kind"]?.string ?? "node"
            if kind == "diagram" { return "diagram" }
            if let id = diagram["id"]?.string, !id.isEmpty { return "\(kind) \(id)" }
            return kind
        }
        let tag = annotation["elementContext"]?["tag"]?.string ?? annotation["htmlAnchor"]?["tagName"]?.string
        return tag?.lowercased()
    }
}

/// `GET threads/:id/attachments` (7.14): every file the thread carries, and
/// the person's annotations still waiting for a Send.
public struct InboxThreadAttachments: Codable, Hashable, Sendable {
    public var attachments: [InboxAttachmentState]
    public var annotations: [InboxAnnotationRecord]
}

/// `GET attachments/:id/view` (7.15).
public struct InboxAttachmentView: Codable, Hashable, Sendable {
    public var attachment: InboxAttachmentState
    /// `"current"` or the sent sha256: the annotations' key.
    public var version: String
    public var text: String
    /// For HTML, the page with its `<base href>` at the door's asset route.
    public var html: String?
}

extension InboxClient {
    public func attachments(thread id: String) async throws(InboxError) -> InboxThreadAttachments {
        try await send(request("threads/\(id)/attachments"), decoder: Self.plainDecoder)
    }

    /// `GET attachments/:id/view`: the file as it is now, or the version the agent sent.
    public func view(attachment id: String, sent: Bool) async throws(InboxError) -> InboxAttachmentView {
        try await send(request("attachments/\(id)/view", query: sent ? [URLQueryItem(name: "version", value: "sent")] : []), decoder: Self.plainDecoder)
    }

    /// `GET html-assets/<token>/<path>` (7.16): one file of an HTML page's folder, as bytes and type,
    /// on whichever path the client is on (through the relay, the GET's result carries them, section 4).
    public func htmlAsset(_ path: String) async throws(InboxError) -> (data: Data, mimeType: String) {
        let answer = try await exchange(request("html-assets/\(path)"))
        guard answer.status == 200 else { throw InboxError.refused(status: answer.status, code: "asset_not_found", message: "Not found.", triesLeft: nil) }
        let type = answer.contentType?.components(separatedBy: ";").first ?? "application/octet-stream"
        return (answer.data, type)
    }

    /// `POST annotations` (7.17): save a new annotation, or an edit under the same id.
    public func saveAnnotation(attachment id: String, version: String, annotation: JSONValue) async throws(InboxError) -> InboxAnnotationRecord {
        struct Body: Encodable {
            var idempotency_key = UUID().uuidString.lowercased()
            var attachment_id: String
            var version: String
            var annotation: JSONValue
        }
        struct Answer: Decodable { var annotation: InboxAnnotationRecord }
        let answer: Answer = try await post("annotations", Body(attachment_id: id, version: version, annotation: annotation), encoder: Self.plainEncoder, decoder: Self.plainDecoder)
        return answer.annotation
    }

    /// `POST annotations/:id/remove` (7.18).
    public func removeAnnotation(_ id: String) async throws(InboxError) {
        struct Body: Encodable { var idempotency_key = UUID().uuidString.lowercased() }
        let _: Ignored = try await post("annotations/\(id)/remove", Body(), encoder: Self.plainEncoder, decoder: Self.plainDecoder)
    }

    static let plainDecoder = JSONDecoder()
    static let plainEncoder = JSONEncoder()
}
