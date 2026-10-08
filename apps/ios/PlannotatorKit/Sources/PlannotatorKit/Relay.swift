import CryptoKit
import Foundation

// The relay, as the phone meets it (adr/implementation/inbox-mobile.md,
// section 4): the keys it derives from the pairing secret, the envelope it
// opens, the push summary inside one, and its one call at the relay in this
// step, registering the APNs token (exchange 7.29).

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
    let secret: String
    let relaySecret: String

    public init?(relay: InboxRelayRef, device: String, secret: String) {
        guard let keys = RelayKeys(secret: secret, device: device) else { return nil }
        self.relay = relay
        self.device = device
        self.secret = secret
        relaySecret = keys.relaySecret
    }

    /// `POST .../devices/:dev/commands` (7.34): a Send sealed under the up key,
    /// for the Inbox to apply through the door when its socket has it. The
    /// command's id is the Send's idempotency key, inside the seal and outside it.
    public func reply(message id: String, _ body: InboxClient.ReplyBody) async throws(InboxError) -> (queued: Bool, inboxOnline: Bool) {
        guard let base = URL(string: relay.url), let keys = RelayKeys(secret: secret, device: device),
              let plaintext = try? InboxClient.encoder.encode(RelayCommand(id: body.idempotencyKey, path: "/api/inbox/device/messages/\(id)/reply", body: body)),
              let ciphertext = keys.sealUp(plaintext) else { throw .unreadable }
        var request = URLRequest(url: base.appending(path: "/v1/mailboxes/\(relay.mailboxId)/devices/\(device)/commands"))
        request.httpMethod = "POST"
        request.setValue("Bearer \(relaySecret)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(["id": body.idempotencyKey, "ciphertext": ciphertext])
        let answer: RelayQueued = try await InboxClient.send(request)
        return (answer.queued, answer.inboxOnline)
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
        guard let base = URL(string: relay.url) else { throw .unreadable }
        var request = URLRequest(url: base.appending(path: "/v1/mailboxes/\(relay.mailboxId)/devices/\(device)/apns"))
        request.httpMethod = "PUT"
        request.setValue("Bearer \(relaySecret)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONEncoder().encode(Body(token: token, environment: environment))
        _ = try await InboxClient.body(of: request)
    }
}

/// An up command's plaintext (section 4, "What goes down and up").
private struct RelayCommand: Encodable {
    var v = 1
    var id: String
    var method = "POST"
    var path: String
    var body: InboxClient.ReplyBody
}

private struct RelayQueued: Decodable {
    var queued: Bool
    var inboxOnline: Bool
}
