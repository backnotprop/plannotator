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
    /// Workspaces could not be reached (no network, or the service failed).
    case workspacesUnreachable
    /// Workspaces answered 401: the session ended (signed out here or elsewhere).
    case signedOut
    /// The relay holds the command for a computer it cannot reach now; the
    /// Inbox applies it once when it connects (owner item 26).
    case queued

    public var message: String {
        switch self {
        case .refused(_, _, let message, _): message
        case .unreachable: "Your computer can't be reached right now."
        case .unreadable: "Your computer sent an answer this app can't read. Update Plannotator on both."
        case .sendUnconfirmed: "Your computer can't be reached, so it is not certain this was sent. Tap Send again; it is sent once either way."
        case .workspacesUnreachable: "Workspaces can't be reached right now."
        case .signedOut: "You were signed out of Workspaces. Sign in again to keep answering."
        case .queued: "Sent. Waiting for your computer."
        }
    }

    /// The source could not be reached: the computer, or Workspaces.
    public var isUnreachable: Bool { self == .unreachable || self == .workspacesUnreachable }

    public var code: String? {
        if case .refused(_, let code, _, _) = self { return code }
        return nil
    }

    /// The phone was removed on the computer, or its token is no longer known: pair again.
    /// For Workspaces: the session ended; sign in again. At the relay, `device_not_found`:
    /// the computer removed this phone there too.
    public var isUnpaired: Bool { code == "device_revoked" || code == "device_token_invalid" || code == "device_not_found" || self == .signedOut }

    /// A definite answer (any 4xx): an idempotency key can be dropped after it (contract section 6).
    public var isDefinite: Bool {
        if case .refused(let status, _, _, _) = self { return (400..<500).contains(status) }
        return self == .signedOut
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

/// How the phone reaches a paired computer (9.2): the same Wi-Fi, the
/// tailnet (or loopback in the simulator), or the relay as the fallback.
public enum InboxPath: String, Codable, Sendable {
    case wifi, tailnet, relay
}

/// One request at the device door, whatever carries it: a path relative to
/// `/api/inbox/device/`, its query, and the JSON body of a POST.
public struct DoorRequest: Sendable {
    public var method = "GET"
    public var path: String
    public var query: [URLQueryItem] = []
    public var body: Data?
    /// Through the relay, wait for the command's result. A `seen` does not:
    /// it answers `202 {}` once the relay holds it.
    public var waits = true
    /// A shorter wait than the session's 20 s, for an answer that has to fit a
    /// notification action's background time.
    public var timeout: TimeInterval?

    public init(method: String = "GET", path: String, query: [URLQueryItem] = [], body: Data? = nil, waits: Bool = true) {
        self.method = method
        self.path = path
        self.query = query
        self.body = body
        self.waits = waits
    }

    /// `/api/inbox/device/<path>?<query>`, as an up command names it (section 4).
    public var doorPath: String {
        var parts = URLComponents()
        parts.path = "/api/inbox/device/\(path)"
        if !query.isEmpty { parts.queryItems = query }
        return parts.percentEncodedPath + (parts.percentEncodedQuery.map { "?\($0)" } ?? "")
    }

    /// The command's `idempotency_key` (section 6), which is also its relay id.
    var idempotencyKey: String? {
        guard let body, let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else { return nil }
        return object["idempotency_key"] as? String
    }
}

/// The door's answer, as it left the Inbox: status, type and bytes.
public struct DoorAnswer: Sendable, Equatable {
    public var status: Int
    public var contentType: String?
    public var data: Data

    public init(status: Int, contentType: String?, data: Data) {
        self.status = status
        self.contentType = contentType
        self.data = data
    }
}

/// The device door, `/api/inbox/device/*`, as one paired phone calls it, on
/// one path: directly (the tailnet, loopback, or the Wi-Fi with its pinned
/// certificate) or through the relay, sealed end to end. Every call is the
/// same request on every path.
public struct InboxClient: Sendable {
    public let address: InboxAddress
    let token: String
    /// The LAN certificate's SHA-256: dial `https` and accept only that leaf (section 3).
    let pin: String?
    let relay: RelayChannel?

    /// A direct client: the tailnet or loopback address, or with `pin` the Wi-Fi listener.
    public init(address: InboxAddress, token: String, pin: String? = nil) {
        self.address = address
        self.token = token
        self.pin = pin
        self.relay = nil
    }

    /// A client whose requests go up through the relay as sealed commands.
    public init(relay: RelayChannel, address: InboxAddress, token: String) {
        self.address = address
        self.token = token
        self.pin = nil
        self.relay = relay
    }

    public var path: InboxPath { relay != nil ? .relay : pin != nil ? .wifi : .tailnet }

    static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config)
    }()

    /// The session this client dials with: the pinned one on the Wi-Fi.
    var urlSession: URLSession { pin.map(PinnedTrust.session) ?? Self.session }

    /// Where a direct request goes: always `https` on the Wi-Fi listener.
    var baseURL: URL {
        guard pin != nil else { return address.baseURL }
        var url = URLComponents()
        url.scheme = "https"
        url.percentEncodedHost = address.host
        url.port = address.port
        return url.url ?? address.baseURL
    }

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

    /// A fresh idempotency key: one per intent, kept by the caller across a change of path (section 6).
    public static func newKey() -> String { UUID().uuidString.lowercased() }

    // MARK: Pairing

    /// `POST pair`: redeem the QR's secret or the six digits for this phone's
    /// token (7.2, 7.3). With `pin`, over the Wi-Fi listener.
    public static func pair(at address: InboxAddress, pin: String? = nil, secret: String? = nil, code: String? = nil, name: String) async throws(InboxError) -> InboxPairResponse {
        struct Body: Encodable { var secret: String?; var code: String?; var name: String; var platform = "ios" }
        let door = InboxClient(address: address, token: "", pin: pin)
        var request = URLRequest(url: door.baseURL.appending(path: "/api/inbox/device/pair"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? encoder.encode(Body(secret: secret, code: code, name: name))
        let data = try await body(of: request, session: door.urlSession)
        do {
            return try decoder.decode(InboxPairResponse.self, from: data)
        } catch {
            throw .unreadable
        }
    }

    // MARK: Reads

    public func health() async throws(InboxError) -> InboxHealth {
        try await get("health")
    }

    /// Is the computer there on this direct path? `health` with a short wait,
    /// so a path that does not answer costs seconds, not the full timeout.
    public func probe() async throws(InboxError) {
        var request = urlRequest(for: self.request("health"))
        request.timeoutInterval = 3
        _ = try await Self.body(of: request, session: urlSession)
    }

    public func list(project: String? = nil) async throws(InboxError) -> InboxListModel {
        try await get("threads", query: project.map { [URLQueryItem(name: "project", value: $0)] } ?? [])
    }

    public func thread(_ id: String) async throws(InboxError) -> InboxThreadResponse {
        try await get("threads/\(id)")
    }

    // MARK: Commands (each carries an idempotency key, contract section 6)

    /// `POST threads/:id/seen`. Through the relay it does not wait for its result.
    public func seen(thread id: String, idempotencyKey: String = newKey()) async throws(InboxError) {
        struct Body: Encodable { var idempotencyKey: String }
        var request = request("threads/\(id)/seen")
        request.method = "POST"
        request.body = try? Self.encoder.encode(Body(idempotencyKey: idempotencyKey))
        request.waits = false
        let _: Ignored = try await send(request)
    }

    /// `POST messages/:id/picks`: save one question's answer at once, or clear it with nil.
    public func pick(message id: String, key: String, revision: Int, answer: QuestionAnswer?, idempotencyKey: String = newKey()) async throws(InboxError) -> InboxQuestionsResponse {
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
        struct Body: Encodable { var idempotencyKey: String; var questions: [Pick] }
        return try await post("messages/\(id)/picks", Body(idempotencyKey: idempotencyKey, questions: [Pick(key: key, revision: revision, answer: answer)]))
    }

    public struct SendQuestion: Codable, Hashable, Sendable {
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
    public struct ReplyBody: Codable, Hashable, Sendable {
        public var idempotencyKey: String
        public var words: String
        public var questions: [SendQuestion]
        /// Annotations as Plannotator's feedback text, with their ids (7.11); left out when nil.
        public var feedback: String?
        public var annotationIds: [String]?
        public init(idempotencyKey: String, words: String, questions: [SendQuestion], feedback: String? = nil, annotationIds: [String]? = nil) {
            self.idempotencyKey = idempotencyKey
            self.words = words
            self.questions = questions
            self.feedback = feedback
            self.annotationIds = feedback == nil ? nil : annotationIds
        }
    }

    /// `POST messages/:id/reply`: the person's Send. The key is the caller's, kept across retries.
    /// Annotations ride it as Plannotator's feedback text with their ids (7.11).
    public func reply(message id: String, idempotencyKey: String, words: String, questions: [SendQuestion]) async throws(InboxError) -> InboxQuestionsResponse {
        try await reply(message: id, idempotencyKey: idempotencyKey, words: words, questions: questions, feedback: nil, annotationIds: nil)
    }

    public func reply(message id: String, idempotencyKey: String, words: String, questions: [SendQuestion], feedback: String?, annotationIds: [String]?) async throws(InboxError) -> InboxQuestionsResponse {
        // Annotations ride the reply's own body (7.11); without them it is main's ReplyBody as it is.
        try await post("messages/\(id)/reply", ReplyBody(idempotencyKey: idempotencyKey, words: words, questions: questions, feedback: feedback, annotationIds: annotationIds))
    }

    /// A Send as one body (a held one asked again, the lock-screen answer with a short `timeout`).
    public func reply(message id: String, _ body: ReplyBody, timeout: TimeInterval? = nil) async throws(InboxError) -> InboxQuestionsResponse {
        var request = request("messages/\(id)/reply")
        request.method = "POST"
        request.body = try? Self.encoder.encode(body)
        request.timeout = timeout
        return try await send(request)
    }

    /// The first of these direct paths that answers `health`, in their order,
    /// all asked at once so one that does not answer costs only its short wait.
    /// The error is set when a path answered that this phone was removed.
    public static func firstReachable(_ clients: [InboxClient]) async -> (client: InboxClient?, unpaired: InboxError?) {
        let answers = await withTaskGroup(of: (Int, InboxError?).self) { group in
            for (index, client) in clients.enumerated() {
                group.addTask {
                    do throws(InboxError) {
                        try await client.probe()
                        return (index, nil)
                    } catch {
                        return (index, error)
                    }
                }
            }
            var answers: [Int: InboxError?] = [:]
            for await (index, error) in group { answers[index] = error }
            return answers
        }
        var unpaired: InboxError?
        for index in clients.indices {
            guard let answer = answers[index] else { continue }
            guard let error = answer else { return (clients[index], nil) }
            if error.isUnpaired { unpaired = error }
        }
        return (nil, unpaired)
    }

    public func resolve(message id: String, resolved: Bool, idempotencyKey: String = newKey()) async throws(InboxError) {
        struct Body: Encodable { var idempotencyKey: String; var resolved: Bool }
        let _: Ignored = try await post("messages/\(id)/resolve", Body(idempotencyKey: idempotencyKey, resolved: resolved))
    }

    public func delete(thread id: String, idempotencyKey: String = newKey()) async throws(InboxError) {
        struct Body: Encodable { var idempotencyKey: String }
        let _: Ignored = try await post("threads/\(id)/delete", Body(idempotencyKey: idempotencyKey))
    }

    /// `POST messages/:id/decision`: the card's switch (7.21). Done on the decision card is `keepDecision`.
    public func setDecisionRecording(message id: String, key: String, recording: Bool, idempotencyKey: String = newKey()) async throws(InboxError) -> InboxQuestion {
        struct Body: Encodable { var idempotencyKey: String; var key: String; var recording: Bool }
        struct Answer: Decodable { var question: InboxQuestion }
        let answer: Answer = try await post("messages/\(id)/decision", Body(idempotencyKey: idempotencyKey, key: key, recording: recording))
        return answer.question
    }

    /// `POST revoke`: "Remove this source" (7.25). Repeating it changes nothing.
    public func revoke() async throws(InboxError) {
        struct Body: Encodable {}
        let _: Ignored = try await post("revoke", Body())
    }

    // MARK: Plumbing

    struct Ignored: Decodable {}

    func request(_ path: String, query: [URLQueryItem] = []) -> DoorRequest {
        DoorRequest(path: path, query: query)
    }

    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws(InboxError) -> T {
        try await send(request(path, query: query))
    }

    func post<T: Decodable>(_ path: String, _ body: some Encodable, encoder: JSONEncoder = encoder, decoder: JSONDecoder = decoder) async throws(InboxError) -> T {
        var request = request(path)
        request.method = "POST"
        request.body = try? encoder.encode(body)
        return try await send(request, decoder: decoder)
    }

    /// One request on this client's path, decoded; an error body becomes `refused`.
    func send<T: Decodable>(_ request: DoorRequest, decoder: JSONDecoder = decoder) async throws(InboxError) -> T {
        let answer = try await exchange(request)
        guard (200..<300).contains(answer.status) else { throw Self.refusal(status: answer.status, data: answer.data) }
        do {
            return try decoder.decode(T.self, from: answer.data)
        } catch {
            throw .unreadable
        }
    }

    /// One request on this client's path, its answer as it came, any status.
    /// Directly it is an HTTP request with the bearer token; through the
    /// relay it is a command sealed under the up key, and the answer is the
    /// door's result item (section 4).
    public func exchange(_ request: DoorRequest) async throws(InboxError) -> DoorAnswer {
        if let relay { return try await relay.command(request) }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await urlSession.data(for: urlRequest(for: request))
        } catch {
            throw .unreachable
        }
        let http = response as? HTTPURLResponse
        return DoorAnswer(status: http?.statusCode ?? 0, contentType: http?.value(forHTTPHeaderField: "Content-Type"), data: data)
    }

    /// The HTTP request a direct path sends for a door request.
    func urlRequest(for door: DoorRequest) -> URLRequest {
        var url = baseURL.appending(path: "/api/inbox/device/\(door.path)")
        if !door.query.isEmpty { url.append(queryItems: door.query) }
        var request = URLRequest(url: url)
        if let timeout = door.timeout { request.timeoutInterval = timeout }
        request.httpMethod = door.method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body = door.body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        return request
    }

    /// An answer that is not a 2xx, as an error: the door's `{ error, code }` body,
    /// else unreachable for a 5xx (`tailscale serve` answers 502 with nothing behind it).
    public static func refusal(status: Int, data: Data) -> InboxError {
        if let body = try? decoder.decode(InboxErrorBody.self, from: data) {
            return .refused(status: status, code: body.code, message: body.error, triesLeft: body.triesLeft)
        }
        return status >= 500 || status == 0 ? .unreachable : .unreadable
    }

    static func send<T: Decodable>(_ request: URLRequest, decoder: JSONDecoder = decoder) async throws(InboxError) -> T {
        let data = try await body(of: request)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw .unreadable
        }
    }

    /// The answer's bytes after a 2xx; an error body (`{ error, code }`) becomes `refused`.
    static func body(of request: URLRequest, session: URLSession = session) async throws(InboxError) -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw .unreachable
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw refusal(status: status, data: data) }
        return data
    }
}
