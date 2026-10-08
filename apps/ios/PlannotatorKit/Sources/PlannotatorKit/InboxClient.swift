import Foundation

/// What went wrong talking to the Inbox, in words a person can read.
public enum InboxError: Error, Equatable, Sendable {
    /// The Inbox answered with an error body (`{ error, code }`).
    case refused(status: Int, code: String, message: String, triesLeft: Int?)
    /// The computer could not be reached (no route, asleep, the Inbox stopped).
    case unreachable
    /// The answer was not what the contract says.
    case unreadable
    /// A Send got no answer and the thread could not be read after it: it may
    /// or may not have landed. A retry with the same key is applied once.
    case sendUnconfirmed

    public var message: String {
        switch self {
        case .refused(_, _, let message, _): message
        case .unreachable: "Your computer can't be reached right now."
        case .unreadable: "Your computer sent an answer this app can't read. Update Plannotator on both."
        case .sendUnconfirmed: "Your computer can't be reached, so it is not certain this was sent. Tap Send again; it is sent once either way."
        }
    }

    public var code: String? {
        if case .refused(_, let code, _, _) = self { return code }
        return nil
    }

    /// The phone was removed on the computer, or its token is no longer known: pair again.
    public var isUnpaired: Bool { code == "device_revoked" || code == "device_token_invalid" }

    /// A definite answer (any 4xx): an idempotency key can be dropped after it (contract section 6).
    public var isDefinite: Bool {
        if case .refused(let status, _, _, _) = self { return (400..<500).contains(status) }
        return false
    }
}

/// An Inbox address as a phone holds it: `host:port`. Loopback names speak
/// plain HTTP (the simulator reaches the Mac's own Inbox); every other address
/// is the tailnet publication, which `tailscale serve` answers over HTTPS.
///
/// The host is a plain host name (letters, digits, dots, hyphens), an IPv4
/// literal, or a bracketed IPv6 literal, and nothing else: no `%`, no `@`, no
/// user info, path or query. The host and port are kept as fields; `baseURL`
/// is built from those fields and `hostPort` is written from the same ones,
/// so what a screen shows and what the client dials are one value. Nothing
/// is parsed a second time.
public struct InboxAddress: Hashable, Sendable, Codable {
    public let host: String
    public let port: Int?
    public let baseURL: URL

    public init?(_ text: String) {
        var value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        for prefix in ["https://", "http://"] where value.lowercased().hasPrefix(prefix) {
            value = String(value.dropFirst(prefix.count))
        }
        while value.hasSuffix("/") { value.removeLast() }
        guard !value.isEmpty, !value.contains(where: { "%@/?#\\ ".contains($0) }),
              let parts = URLComponents(string: "https://\(value)"),
              parts.user == nil, parts.password == nil, parts.path.isEmpty, parts.query == nil, parts.fragment == nil,
              let host = parts.percentEncodedHost, Self.isPlainHost(host) else { return nil }
        if let port = parts.port, !(1...65_535).contains(port) { return nil }
        var url = URLComponents()
        url.scheme = Self.loopbackHosts.contains(host.lowercased()) ? "http" : "https"
        url.percentEncodedHost = host
        url.port = parts.port
        guard let base = url.url else { return nil }
        self.host = host
        self.port = parts.port
        self.baseURL = base
    }

    /// `host:port`, written from the fields the client dials.
    public var hostPort: String { port.map { "\(host):\($0)" } ?? host }

    public var isLoopback: Bool { Self.loopbackHosts.contains(host.lowercased()) }

    static let loopbackHosts: Set<String> = ["127.0.0.1", "localhost", "[::1]"]

    static func isPlainHost(_ host: String) -> Bool {
        if host.hasPrefix("[") {
            // A bracketed IPv6 literal: hex digits, colons and dots (an embedded IPv4) only.
            guard host.hasSuffix("]"), host.count > 2 else { return false }
            return host.dropFirst().dropLast().allSatisfy { $0.isHexDigit || $0 == ":" || $0 == "." } && host.contains(":")
        }
        return !host.isEmpty && host.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") }
    }

    // Kept on disk as the `host:port` string and read back through the same checks.
    public init(from decoder: Decoder) throws {
        let text = try decoder.singleValueContainer().decode(String.self)
        guard let address = InboxAddress(text) else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not an Inbox address: \(text)"))
        }
        self = address
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(hostPort)
    }
}

/// The device door, `/api/inbox/device/*`, as one paired phone calls it.
public struct InboxClient: Sendable {
    public let address: InboxAddress
    let token: String

    public init(address: InboxAddress, token: String) {
        self.address = address
        self.token = token
    }

    static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return encoder
    }()

    // MARK: Pairing

    /// `POST pair`: redeem the QR's secret or the six digits for this phone's token (7.2, 7.3).
    public static func pair(at address: InboxAddress, secret: String? = nil, code: String? = nil, name: String) async throws(InboxError) -> InboxPairResponse {
        struct Body: Encodable { var secret: String?; var code: String?; var name: String; var platform = "ios" }
        var request = URLRequest(url: address.baseURL.appending(path: "/api/inbox/device/pair"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? encoder.encode(Body(secret: secret, code: code, name: name))
        return try await send(request)
    }

    // MARK: Reads

    public func health() async throws(InboxError) -> InboxHealth {
        try await get("health")
    }

    public func list(project: String? = nil) async throws(InboxError) -> InboxListModel {
        try await get("threads", query: project.map { [URLQueryItem(name: "project", value: $0)] } ?? [])
    }

    public func thread(_ id: String) async throws(InboxError) -> InboxThreadResponse {
        try await get("threads/\(id)")
    }

    // MARK: Commands (each carries an idempotency key, contract section 6)

    public func seen(thread id: String) async throws(InboxError) {
        struct Body: Encodable { var idempotencyKey = UUID().uuidString }
        let _: Ignored = try await post("threads/\(id)/seen", Body())
    }

    /// `POST messages/:id/picks`: save one question's answer at once, or clear it with nil.
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
        struct Body: Encodable { var idempotencyKey = UUID().uuidString; var questions: [Pick] }
        return try await post("messages/\(id)/picks", Body(questions: [Pick(key: key, revision: revision, answer: answer)]))
    }

    public struct SendQuestion: Encodable, Sendable {
        public var key: String
        public var revision: Int
        /// The pick inside the Send, for the lock-screen answer (7.11); nil sends the saved pick.
        public var answer: QuestionAnswer?
        public init(key: String, revision: Int, answer: QuestionAnswer? = nil) {
            self.key = key
            self.revision = revision
            self.answer = answer
        }
    }

    /// The body of `POST messages/:id/reply`, also what a Send through the relay seals.
    public struct ReplyBody: Encodable, Sendable {
        public var idempotencyKey: String
        public var words: String?
        public var questions: [SendQuestion]
        public init(idempotencyKey: String, words: String?, questions: [SendQuestion]) {
            self.idempotencyKey = idempotencyKey
            self.words = words
            self.questions = questions
        }
    }

    /// `POST messages/:id/reply`: the person's Send. The key is the caller's, kept across retries.
    public func reply(message id: String, idempotencyKey: String, words: String?, questions: [SendQuestion]) async throws(InboxError) -> InboxQuestionsResponse {
        try await post("messages/\(id)/reply", ReplyBody(idempotencyKey: idempotencyKey, words: words, questions: questions))
    }

    public func resolve(message id: String, resolved: Bool) async throws(InboxError) {
        struct Body: Encodable { var idempotencyKey = UUID().uuidString; var resolved: Bool }
        let _: Ignored = try await post("messages/\(id)/resolve", Body(resolved: resolved))
    }

    public func delete(thread id: String) async throws(InboxError) {
        struct Body: Encodable { var idempotencyKey = UUID().uuidString }
        let _: Ignored = try await post("threads/\(id)/delete", Body())
    }

    /// `POST messages/:id/decision`: the card's switch (7.21). The decision card itself is M3.
    public func setDecisionRecording(message id: String, key: String, recording: Bool) async throws(InboxError) -> InboxQuestion {
        struct Body: Encodable { var idempotencyKey = UUID().uuidString; var key: String; var recording: Bool }
        struct Answer: Decodable { var question: InboxQuestion }
        let answer: Answer = try await post("messages/\(id)/decision", Body(key: key, recording: recording))
        return answer.question
    }

    /// `POST revoke`: "Remove this source" (7.25). Repeating it changes nothing.
    public func revoke() async throws(InboxError) {
        struct Body: Encodable {}
        let _: Ignored = try await post("revoke", Body())
    }

    // MARK: Plumbing

    struct Ignored: Decodable {}

    func request(_ path: String, query: [URLQueryItem] = []) -> URLRequest {
        var url = address.baseURL.appending(path: "/api/inbox/device/\(path)")
        if !query.isEmpty { url.append(queryItems: query) }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws(InboxError) -> T {
        try await Self.send(request(path, query: query))
    }

    func post<T: Decodable>(_ path: String, _ body: some Encodable) async throws(InboxError) -> T {
        var request = request(path)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? Self.encoder.encode(body)
        return try await Self.send(request)
    }

    static func send<T: Decodable>(_ request: URLRequest) async throws(InboxError) -> T {
        let data = try await body(of: request)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw .unreadable
        }
    }

    /// The answer's bytes after a 2xx; an error body (`{ error, code }`) becomes `refused`.
    static func body(of request: URLRequest) async throws(InboxError) -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw .unreachable
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if let body = try? decoder.decode(InboxErrorBody.self, from: data) {
                throw .refused(status: status, code: body.code, message: body.error, triesLeft: body.triesLeft)
            }
            throw status >= 500 || status == 0 ? .unreachable : .unreadable
        }
        return data
    }
}
