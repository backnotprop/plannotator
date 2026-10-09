import CryptoKit
import Foundation

// The relay, as the phone meets it (adr/implementation/inbox-mobile.md,
// section 4): the keys it derives from the pairing secret, the envelope it
// opens, the push summary inside one, its calls at the relay (the APNs
// token, its switch, commands up, items down and their acknowledgment), and
// the relay as a path to the door (`RelayChannel`).

/// The relay keys derived from the pairing secret `S` and the device id:
/// `K` opens what the Inbox sends (pushes, down items), `U` seals the
/// commands this phone sends up, `R` is the phone's bearer at the relay.
public struct RelayKeys: Sendable {
    public let key: SymmetricKey
    public let upKey: SymmetricKey
    public let relaySecret: String

    /// `HKDF-SHA256(ikm = S, salt = device id, info = "plannotator-inbox relay <key | up | auth> v1", 32 bytes)`.
    public init?(secret: String, device: String) {
        guard let ikm = Base64URL.decode(secret) else { return nil }
        let material = SymmetricKey(data: ikm)
        let salt = Data(device.utf8)
        func derive(_ info: String) -> SymmetricKey {
            HKDF<SHA256>.deriveKey(inputKeyMaterial: material, salt: salt, info: Data("plannotator-inbox relay \(info) v1".utf8), outputByteCount: 32)
        }
        key = derive("key")
        upKey = derive("up")
        relaySecret = derive("auth").withUnsafeBytes { Base64URL.encode(Data($0)) }
    }

    /// Seals a command under the up key, in the same layout, with a fresh IV.
    public func sealUp(_ plaintext: Data) -> String? {
        guard let box = try? AES.GCM.seal(plaintext, using: upKey), let combined = box.combined else { return nil }
        return Base64URL.encode(combined)
    }

    /// Opens an envelope under the up key (the vectors' command envelope).
    func openUp(_ envelope: String) -> Data? {
        Self.open(envelope, key: upKey)
    }

    /// Opens `base64url(IV || ciphertext || tag)`, AES-256-GCM, no additional data
    /// (`packages/core/crypto.ts`). Nil when it is not this key's envelope.
    public func open(_ envelope: String) -> Data? {
        Self.open(envelope, key: key)
    }

    static func open(_ envelope: String, key: SymmetricKey) -> Data? {
        guard let bytes = Base64URL.decode(envelope), bytes.count >= 28,
              let nonce = try? AES.GCM.Nonce(data: bytes.prefix(12)),
              let box = try? AES.GCM.SealedBox(nonce: nonce, ciphertext: bytes.dropFirst(12).dropLast(16), tag: bytes.suffix(16))
        else { return nil }
        return try? AES.GCM.open(box, using: key)
    }
}

public enum Base64URL {
    public static func encode(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    public static func decode(_ text: String) -> Data? {
        var value = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        value += String(repeating: "=", count: (4 - value.count % 4) % 4)
        return Data(base64Encoded: value)
    }
}

/// The push summary a phone decrypts (section 4, "Push").
public struct PushSummary: Codable, Hashable, Sendable {
    public struct Choice: Codable, Hashable, Sendable {
        public var label: String
        public var recommended: Bool
    }

    public struct Question: Codable, Hashable, Sendable {
        public var key: String
        public var revision: Int
        public var prompt: String
        public var context: String?
        public var choices: [Choice]
    }

    public var v: Int
    /// Always "push": pushes and down items share the key, so a push opens only with this type.
    public var type: String?
    public var threadId: String
    public var messageId: String
    public var subject: String?
    public var project: String?
    public var agent: String?
    public var question: Question?

    /// The lock screen's title: the thread's subject (render 7.1).
    public var title: String {
        if let subject, !subject.trimmed.isEmpty { return subject }
        return question?.prompt ?? ""
    }

    /// "<agent> in <project>", then ": <context>" when the question carries one (render 7.1).
    public var body: String {
        var line = [agent, project].compactMap { $0?.trimmed.isEmpty == false ? $0 : nil }.joined(separator: " in ")
        if let context = question?.context?.trimmed, !context.isEmpty { line += line.isEmpty ? context : ": \(context)" }
        return line
    }

    /// The choices as lock-screen actions, recommended first (render 7.2): each
    /// carries its index in the summary, which is its action's `choice.<n>`.
    public var actions: [(index: Int, label: String)] {
        guard let question, (1...4).contains(question.choices.count) else { return [] }
        let indexed = question.choices.enumerated().map { (index: $0.offset, choice: $0.element) }
        return (indexed.filter(\.choice.recommended) + indexed.filter { !$0.choice.recommended }).map { ($0.index, $0.choice.label) }
    }

    /// Opens a push's envelope with the first paired device whose key fits:
    /// the push does not name the device, and AES-GCM refuses every other key.
    public static func open(_ envelope: String, devices: [(id: String, secret: String)]) -> (device: String, summary: PushSummary)? {
        for device in devices {
            guard let keys = RelayKeys(secret: device.secret, device: device.id), let plaintext = keys.open(envelope),
                  let summary = try? InboxClient.decoder.decode(PushSummary.self, from: plaintext), summary.v == 1, summary.type == "push" else { continue }
            return (device.id, summary)
        }
        return nil
    }
}

/// The phone's calls at the relay with its relay secret.
public struct RelayClient: Sendable {
    public let relay: InboxRelayRef
    public let device: String
    let keys: RelayKeys

    public init?(relay: InboxRelayRef, device: String, secret: String) {
        guard let keys = RelayKeys(secret: secret, device: device), URL(string: relay.url) != nil else { return nil }
        self.relay = relay
        self.device = device
        self.keys = keys
    }

    /// `POST .../devices/:dev/commands` (7.34): a door request sealed under the
    /// up key, for the Inbox to apply through the door when its socket has it.
    /// The id is the request's idempotency key (a POST's, section 6) or a
    /// fresh one, inside the seal and outside it. Answers whether the relay
    /// took it now (false: it already held that id) and whether the Inbox's
    /// socket is connected.
    public func post(_ request: DoorRequest, id: String, timeout: TimeInterval? = nil) async throws(InboxError) -> (queued: Bool, inboxOnline: Bool) {
        var command: [String: Any] = ["v": 1, "id": id, "method": request.method, "path": request.doorPath]
        if let body = request.body, let object = try? JSONSerialization.jsonObject(with: body) { command["body"] = object }
        guard let plaintext = try? JSONSerialization.data(withJSONObject: command), let ciphertext = keys.sealUp(plaintext) else { throw .unreadable }
        var call = call("commands", method: "POST", body: ["id": id, "ciphertext": ciphertext])
        if let timeout { call.timeoutInterval = timeout }
        let answer: RelayQueued = try await InboxClient.send(call)
        return (answer.queued, answer.inboxOnline)
    }

    /// A Send sealed as a command (7.34); its id is the Send's idempotency key.
    public func reply(message id: String, _ body: InboxClient.ReplyBody, timeout: TimeInterval? = nil) async throws(InboxError) -> (queued: Bool, inboxOnline: Bool) {
        let request = DoorRequest(method: "POST", path: "messages/\(id)/reply", body: try? InboxClient.encoder.encode(body))
        return try await post(request, id: body.idempotencyKey, timeout: timeout)
    }

    /// `GET .../devices/:dev/items?after=n` (7.32): every held item after `n`,
    /// each opened under the device key. An item that is neither a record nor a
    /// result (a push passed off as one, or anything this key does not open) is skipped.
    public func items(after n: Int) async throws(InboxError) -> RelayBatch {
        var request = call("items", method: "GET")
        request.url?.append(queryItems: [URLQueryItem(name: "after", value: String(n))])
        let held: RelayHeld = try await InboxClient.send(request)
        var batch = RelayBatch(records: [], results: [], inboxOnline: held.inboxOnline, through: n)
        for item in held.items {
            batch.through = max(batch.through, item.n)
            guard let plaintext = keys.open(item.ciphertext) else { continue }
            switch RelayItem(plaintext) {
            case .record(let record): batch.records.append(record)
            case .result(let result): batch.results.append(result)
            case nil: continue
            }
        }
        return batch
    }

    /// `POST .../ack` (7.33) through item `n`, or by store cursor after the
    /// phone read those lines over the Wi-Fi or the tailnet.
    public func ack(through n: Int? = nil, cursor: Int? = nil) async throws(InboxError) {
        var body: [String: Int] = [:]
        if let n { body["through"] = n } else if let cursor { body["cursor"] = cursor }
        _ = try await InboxClient.body(of: call("ack", method: "POST", body: body))
    }

    /// `PUT .../carriage` (7.35): this phone's relay switch (9.2). On, with the
    /// store cursor the phone holds, so the Inbox resumes after it.
    public func setCarriage(on: Bool, cursor: Int) async throws(InboxError) {
        struct Body: Encodable { var on: Bool; var cursor: Int? }
        _ = try await InboxClient.body(of: call("carriage", method: "PUT", body: Body(on: on, cursor: on ? cursor : nil)))
    }

    /// `PUT .../devices/:dev/apns` (7.29): this phone's APNs token, or nil to remove it.
    public func registerAPNs(token: String?, environment: String) async throws(InboxError) {
        struct Body: Encodable { var token: String?; var environment: String
            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(token, forKey: .token) // null removes it
                try c.encode(environment, forKey: .environment)
            }
            enum CodingKeys: CodingKey { case token, environment }
        }
        _ = try await InboxClient.body(of: call("apns", method: "PUT", body: Body(token: token, environment: environment)))
    }

    private func call(_ sub: String, method: String) -> URLRequest {
        // `init?` checked the URL.
        var request = URLRequest(url: URL(string: relay.url)!.appending(path: "/v1/mailboxes/\(relay.mailboxId)/devices/\(device)/\(sub)"))
        request.httpMethod = method
        request.setValue("Bearer \(keys.relaySecret)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func call(_ sub: String, method: String, body: some Encodable) -> URLRequest {
        var request = call(sub, method: method)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(body)
        return request
    }
}

/// One store line as a down item carries it: the event stream's `record`
/// plus `after`, the seq this phone's previous item reached (a lower last
/// seen seq means an item was delayed or dropped), or a placeholder for a
/// line too large for the relay (`too_large`).
public struct RelayRecord: Sendable {
    public var seq: Int
    public var after: Int
    public var kind: String
    public var id: String
    public var tooLarge: Bool
    /// The plaintext, `{ v, type, after, seq, kind, id, <kind>: record }`.
    public var json: Data
}

/// The door's answer to an up command, under the id sealed inside the command.
public struct RelayResult: Sendable {
    public var id: String
    public var answer: DoorAnswer
}

/// What one read of the relay brought.
public struct RelayBatch: Sendable {
    public var records: [RelayRecord]
    public var results: [RelayResult]
    /// The Inbox's socket is connected now (owner item 26).
    public var inboxOnline: Bool
    /// The last item number read: the next read starts after it.
    public var through: Int
}

enum RelayItem {
    case record(RelayRecord)
    case result(RelayResult)

    /// A down item's plaintext, read only when its sealed `type` is `record`
    /// or `result` (a push shares the key and must not pass for one).
    init?(_ plaintext: Data) {
        guard let object = try? JSONSerialization.jsonObject(with: plaintext) as? [String: Any], object["v"] as? Int == 1 else { return nil }
        switch object["type"] as? String {
        case "record":
            guard let seq = object["seq"] as? Int, let kind = object["kind"] as? String, let id = object["id"] as? String else { return nil }
            self = .record(RelayRecord(seq: seq, after: object["after"] as? Int ?? 0, kind: kind, id: id, tooLarge: object["too_large"] as? Bool == true, json: plaintext))
        case "result":
            guard let id = object["id"] as? String, let status = object["status"] as? Int,
                  let body = (object["body_b64"] as? String).flatMap({ Data(base64Encoded: $0) }) else { return nil }
            self = .result(RelayResult(id: id, answer: DoorAnswer(status: status, contentType: object["content_type"] as? String, data: body)))
        default:
            return nil
        }
    }
}

/// The relay as a path to the door, for one paired computer: commands go up
/// sealed, results and store lines come down as items. One read at a time;
/// every read hands its batch to `deliver` (the app applies the records and
/// settles its waiting Sends), then acknowledges it, so the relay deletes
/// what the phone has applied.
public actor RelayChannel {
    public let client: RelayClient
    /// The last item number read.
    public private(set) var through: Int
    /// The relay's last word on the Inbox's socket.
    public private(set) var inboxOnline: Bool?
    private let deliver: @Sendable (RelayBatch) async -> Void
    private var reading: Task<RelayBatch, any Error>?
    private var awaited: [String: DoorAnswer?] = [:]

    public init(client: RelayClient, through: Int, deliver: @escaping @Sendable (RelayBatch) async -> Void) {
        self.client = client
        self.through = through
        self.deliver = deliver
    }

    /// Reads what the relay holds after the last item, hands it over, and acknowledges it.
    @discardableResult
    public func read() async throws(InboxError) -> RelayBatch {
        let task: Task<RelayBatch, any Error>
        if let reading {
            task = reading
        } else {
            task = Task { try await self.fetch() }
            reading = task
        }
        do {
            let batch = try await task.value
            if reading == task { reading = nil }
            return batch
        } catch {
            if reading == task { reading = nil }
            throw (error as? InboxError) ?? .unreachable
        }
    }

    private func fetch() async throws(InboxError) -> RelayBatch {
        let batch = try await client.items(after: through)
        inboxOnline = batch.inboxOnline
        for result in batch.results where awaited.keys.contains(result.id) { awaited[result.id] = result.answer }
        await deliver(batch)
        if batch.through > through {
            // Acknowledged once applied; if the ack is lost, the next read brings them again and the app skips what it has.
            try? await client.ack(through: batch.through)
            through = batch.through
        }
        return batch
    }

    /// A door request as a command: posted, then, while the Inbox is online,
    /// read back until its result arrives (about 15 s at most, reading at
    /// 0.25 s and doubling to 4 s). `queued` when the Inbox is not online or
    /// the result has not come back: the relay holds the command, and the
    /// Inbox applies it once when it connects.
    public func command(_ request: DoorRequest) async throws(InboxError) -> DoorAnswer {
        let id = request.idempotencyKey ?? InboxClient.newKey()
        if request.waits { awaited[id] = .some(nil) }
        defer { awaited[id] = nil }
        let posted = try await client.post(request, id: id)
        inboxOnline = posted.inboxOnline
        guard request.waits else { return DoorAnswer(status: 202, contentType: "application/json", data: Data("{}".utf8)) }
        guard posted.inboxOnline else { throw .queued }
        var wait = 0.25
        for _ in 0..<7 {
            try? await Task.sleep(for: .seconds(wait))
            guard let batch = try? await read() else { throw .queued }
            if case .some(.some(let answer)) = awaited[id] { return answer }
            guard batch.inboxOnline else { throw .queued }
            wait = min(wait * 2, 4)
        }
        throw .queued
    }
}

private struct RelayQueued: Decodable {
    var queued: Bool
    var inboxOnline: Bool
}

private struct RelayHeld: Decodable {
    struct Item: Decodable { var n: Int; var ciphertext: String }
    var items: [Item]
    var inboxOnline: Bool
}
