import CryptoKit
import Foundation

// The Workspaces doors the phone uses, as the live contract serves them
// (`<origin>/v1/openapi.yaml`): the sign-in door's phone return, the
// notifications, one comment with its questions, the answers door, the
// change channels and the device door. A normal `humanSession`: the cookies
// live in this app's own cookie store (never Safari's), every response may
// rotate them, and a mutation echoes the `csrf` cookie as `X-CSRF-Token`.

/// `GET /v1/me`: who is signed in, and the teams whose channels the app follows.
public struct WorkspacesMe: Codable, Hashable, Sendable {
    public struct Membership: Codable, Hashable, Sendable {
        public var orgId: String
        public var name: String?
    }
    public var userId: String
    public var name: String?
    public var email: String?
    public var memberships: [Membership]
}

/// One sign-in from the app: the values only this app knows, made fresh each time.
///
/// The app opens `loginURL` in the system browser sheet; the door seals the
/// return, `state` and the S256 challenge, sends the person through AuthKit and
/// answers the return with `state` and a single-use ticket. Only a return that
/// carries this sign-in's `state` is redeemed, with the verifier only this app
/// holds; any other return link is dropped.
public struct WorkspacesSignIn: Sendable, Equatable {
    public let state: String
    public let verifier: String
    public let nonce: String

    public init() {
        state = Self.random()
        verifier = Self.random()
        nonce = Self.random()
    }

    public var challenge: String { Self.base64url(Data(SHA256.hash(data: Data(verifier.utf8)))) }

    /// `https://<origin>/auth/mobile/return/<nonce>`: the return a signed build claims
    /// through its associated domain.
    public func mobileReturn(origin: URL) -> URL { origin.appending(path: "auth/mobile/return/\(nonce)") }

    /// The sign-in door's loopback return, which the simulator build listens on.
    public func loopbackReturn(port: UInt16) -> String { "http://127.0.0.1:\(port)/desktop/callback/\(nonce)" }

    public func loginURL(origin: URL, returnTo: String) -> URL {
        var parts = URLComponents(url: origin.appending(path: "auth/desktop/login"), resolvingAgainstBaseURL: false)!
        parts.percentEncodedQueryItems = [
            ("redirect_uri", returnTo), ("state", state), ("code_challenge", challenge), ("code_challenge_method", "S256"),
        ].map { URLQueryItem(name: $0.0, value: $0.1.addingPercentEncoding(withAllowedCharacters: Self.unreserved)) }
        return parts.url!
    }

    /// The ticket a return carries when it answers this sign-in; nil for any
    /// other link (another `state`, a denial, no ticket), which is dropped.
    public func ticket(from url: URL) -> String? {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func one(_ name: String) -> String? {
            let values = items.filter { $0.name == name }
            return values.count == 1 ? values[0].value : nil
        }
        guard one("state") == state, one("error") == nil, let ticket = one("ticket"), !ticket.isEmpty else { return nil }
        return ticket
    }

    static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    static func random() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return base64url(Data(bytes))
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

/// The Workspaces API as one signed-in phone calls it.
public struct WorkspacesClient: Sendable {
    public let origin: URL

    public init(origin: URL) {
        self.origin = origin
    }

    /// The app's own cookie store: the shared store of this app's container,
    /// which Safari and the sign-in sheet (ephemeral) never read.
    static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.httpCookieStorage = .shared
        config.httpCookieAcceptPolicy = .always
        config.httpShouldSetCookies = true
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

    // MARK: Signing in and out (the desktop door's phone arm)

    /// `POST /auth/desktop/session`: the return's ticket and this sign-in's verifier
    /// for the normal session cookies (the 204 sets them).
    public func redeem(ticket: String, verifier: String) async throws(InboxError) {
        struct Body: Encodable { var ticket: String; var codeVerifier: String }
        var request = request("POST", "auth/desktop/session", body: try? Self.encoder.encode(Body(ticket: ticket, codeVerifier: verifier)))
        request.setValue("1", forHTTPHeaderField: "X-Workspaces-Desktop")
        _ = try await Self.perform(request, sessionCall: false)
    }

    /// `POST /auth/desktop/logout`: ends this session at WorkOS (its devices go with it),
    /// then the app forgets its cookies whatever the answer.
    public func logout() async throws(InboxError) {
        defer { forgetCookies() }
        var request = request("POST", "auth/desktop/logout")
        request.setValue("1", forHTTPHeaderField: "X-Workspaces-Desktop")
        _ = try await Self.perform(request)
    }

    public func forgetCookies() {
        let store = HTTPCookieStorage.shared
        for cookie in store.cookies(for: origin) ?? [] { store.deleteCookie(cookie) }
    }

    public var hasSession: Bool { (HTTPCookieStorage.shared.cookies(for: origin) ?? []).contains { $0.name == "session" } }

    // MARK: Reads and writes

    public func me() async throws(InboxError) -> WorkspacesMe {
        try await get("v1/me")
    }

    /// `PUT /v1/me/devices/{deviceId}`: this install gets a push when a row that needs the person is written.
    public func registerDevice(id: String, token: String, environment: String) async throws(InboxError) {
        struct Body: Encodable { var platform = "ios"; var apnsToken: String; var apnsEnvironment: String }
        let _: Ignored = try await send("PUT", "v1/me/devices/\(id)", Body(apnsToken: token, apnsEnvironment: environment))
    }

    /// `POST /v1/ws-ticket` for one change channel (`personal:<user id>` or a team).
    func ticket(channel: String) async throws(InboxError) -> (ticket: String, channel: String) {
        struct Body: Encodable { var scope = "org"; var orgId: String }
        struct Answer: Decodable { var ticket: String; var channel: String? }
        // The door's own field names are camelCase here (`orgId`).
        var request = request("POST", "v1/ws-ticket", body: try? JSONEncoder().encode(Body(orgId: channel)))
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let answer: Answer = try Self.decode(try await Self.perform(request))
        return (answer.ticket, answer.channel ?? channel)
    }

    /// The change channel's socket, opened with a ticket (the colon in a channel name stays as it is).
    func socket(channel: String, ticket: String) -> URLSessionWebSocketTask {
        var parts = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        parts.scheme = "wss"
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_:")
        parts.percentEncodedPath = "/parties/org-channel-do/" + (channel.addingPercentEncoding(withAllowedCharacters: allowed) ?? channel)
        parts.percentEncodedQueryItems = [URLQueryItem(name: "ticket", value: ticket.addingPercentEncoding(withAllowedCharacters: WorkspacesSignIn.unreserved))]
        return Self.session.webSocketTask(with: parts.url!)
    }

    /// A document's text as it is now (`Accept: text/markdown`).
    public func documentText(workspace: String, document: String) async throws(InboxError) -> String {
        var request = request("GET", "v1/workspaces/\(workspace)/documents/\(document)")
        request.setValue("text/markdown", forHTTPHeaderField: "Accept")
        return String(decoding: try await Self.perform(request), as: UTF8.self)
    }

    // MARK: Plumbing

    struct Ignored: Decodable {}

    func request(_ method: String, _ path: String, query: [URLQueryItem] = [], body: Data? = nil) -> URLRequest {
        var url = origin.appending(path: path)
        if !query.isEmpty { url.append(queryItems: query) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if method != "GET", let csrf = HTTPCookieStorage.shared.cookies(for: origin)?.first(where: { $0.name == "csrf" }) {
            request.setValue(csrf.value, forHTTPHeaderField: "X-CSRF-Token")
        }
        return request
    }

    func get<T: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws(InboxError) -> T {
        try Self.decode(try await Self.perform(request("GET", path, query: query)))
    }

    func send<T: Decodable>(_ method: String, _ path: String, _ body: some Encodable, idempotencyKey: String? = nil) async throws(InboxError) -> T {
        var request = request(method, path, body: try? Self.encoder.encode(body))
        if let idempotencyKey { request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        return try Self.decode(try await Self.perform(request))
    }

    static func decode<T: Decodable>(_ data: Data) throws(InboxError) -> T {
        if T.self == Ignored.self { return Ignored() as! T }
        do { return try decoder.decode(T.self, from: data) } catch { throw .unreadable }
    }

    /// One request. A 401 on a session call means the session ended; a door's
    /// own refusal keeps its code and words; no answer is "can't be reached".
    static func perform(_ request: URLRequest, sessionCall: Bool = true) async throws(InboxError) -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw .workspacesUnreachable
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(status) { return data }
        if status == 401, sessionCall { throw .signedOut }
        struct Body: Decodable { struct Detail: Decodable { var code: String; var message: String? }; var error: Detail }
        if status < 500, let body = try? decoder.decode(Body.self, from: data) {
            throw .refused(status: status, code: body.error.code, message: body.error.message ?? "Workspaces refused this.", triesLeft: nil)
        }
        throw status >= 500 || status == 0 ? .workspacesUnreachable : .unreadable
    }
}
