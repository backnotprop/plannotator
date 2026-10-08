import AuthenticationServices
import Network
import PlannotatorKit
import UIKit

/// The Workspaces account this phone is signed in to. The session itself is the
/// cookies in the app's own store; this is what the screens show about it.
struct WorkspacesAccount: Codable, Hashable {
    static let sourceId = "workspaces"

    /// The Workspaces this build talks to: the `WORKSPACES_ORIGIN` build setting
    /// (Debug and TestFlight builds set it; the App Store build leaves it empty,
    /// and then the app has no Workspaces source at all).
    static let origin: URL? = (Bundle.main.object(forInfoDictionaryKey: "WorkspacesOrigin") as? String)
        .flatMap { $0.isEmpty ? nil : URL(string: $0) }

    var origin: URL
    var userId: String
    var name: String?
    var teams: [String]
    /// This install's push device id (`dev_` and a ULID), minted once.
    var deviceId: String

    /// "Plannotator team", "2 teams", or "Personal".
    var teamLine: String {
        switch teams.count {
        case 0: "Personal"
        case 1: teams[0]
        default: "\(teams.count) teams"
        }
    }

    static func newDeviceId() -> String {
        // A ULID: 48 bits of milliseconds, then 80 random bits, as 26 characters of
        // Crockford's base32 (the 130 bits start with two zero bits).
        let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        var bytes = [UInt8](repeating: 0, count: 16)
        let ms = UInt64(Date.now.timeIntervalSince1970 * 1000)
        for i in 0..<6 { bytes[i] = UInt8(truncatingIfNeeded: ms >> UInt64(8 * (5 - i))) }
        bytes.withUnsafeMutableBytes { _ = SecRandomCopyBytes(kSecRandomDefault, 10, $0.baseAddress! + 6) }
        var chars: [Character] = []
        var buffer: UInt32 = 0
        var bits = 2
        for byte in bytes {
            buffer = (buffer << 8) | UInt32(byte)
            bits += 8
            while bits >= 5 {
                chars.append(alphabet[Int((buffer >> UInt32(bits - 5)) & 31)])
                bits -= 5
            }
        }
        return "dev_" + String(chars)
    }
}

/// One sign-in in the system browser sheet (1.4), on the sign-in door's phone arm.
///
/// A signed build returns through `https://<origin>/auth/mobile/return/<nonce>`,
/// which the app claims through its associated domain. The simulator has no
/// associated domain, so a simulator build returns through the door's loopback
/// shape instead: a listener on 127.0.0.1 that hands the return to the sheet's
/// custom scheme. Either way only a return carrying this sign-in's `state` is
/// redeemed; any other return link is dropped.
@MainActor
final class WorkspacesSignInFlow: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var pending: WorkspacesSignIn?
    private var sheet: ASWebAuthenticationSession?
    private var loopback: LoopbackReturn?
    private var returned: ((URL?) -> Void)?

    /// Signs in; answers who, or nil when the person closed the sheet.
    func run(origin: URL) async throws(InboxError) -> WorkspacesMe? {
        let signIn = WorkspacesSignIn()
        pending = signIn
        defer {
            pending = nil
            sheet = nil
            loopback?.stop()
            loopback = nil
        }
        let returnTo: String
        let callback: ASWebAuthenticationSession.Callback
        #if targetEnvironment(simulator)
        let listener: LoopbackReturn
        do {
            listener = try await LoopbackReturn.start(path: "/desktop/callback/\(signIn.nonce)")
        } catch {
            throw .refused(status: 0, code: "sign_in_unavailable", message: "Sign-in could not start on this phone.", triesLeft: nil)
        }
        loopback = listener
        returnTo = signIn.loopbackReturn(port: listener.port)
        callback = .customScheme("plannotator")
        #else
        returnTo = signIn.mobileReturn(origin: origin).absoluteString
        callback = .https(host: origin.host() ?? "", path: "/auth/mobile/return/\(signIn.nonce)")
        #endif
        let url: URL? = await withCheckedContinuation { continuation in
            returned = { url in
                self.returned = nil
                continuation.resume(returning: url)
            }
            let sheet = ASWebAuthenticationSession(url: signIn.loginURL(origin: origin, returnTo: returnTo), callback: callback) { url, _ in
                Task { @MainActor in self.returned?(url) }
            }
            // Its own cookie jar: nothing from Safari, nothing left behind, no consent alert.
            sheet.prefersEphemeralWebBrowserSession = true
            sheet.presentationContextProvider = self
            self.sheet = sheet
            if !sheet.start() { returned?(nil) }
        }
        guard let url else { return nil }
        guard let ticket = signIn.ticket(from: url) else {
            throw .refused(status: 0, code: "sign_in_denied", message: "Sign-in did not finish. Try again.", triesLeft: nil)
        }
        let client = WorkspacesClient(origin: origin)
        try await client.redeem(ticket: ticket, verifier: signIn.verifier)
        return try await client.me()
    }

    /// A return link opened from outside the sheet (a universal link, or the
    /// custom scheme). It finishes the sign-in in progress only when it carries
    /// that sign-in's `state`; anything else is dropped.
    func receive(_ url: URL) {
        guard let pending, pending.ticket(from: url) != nil else { return }
        sheet?.cancel()
        returned?(url)
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? UIWindow()
    }

    /// The shapes a sign-in return arrives in from outside the sheet.
    static func isReturn(_ url: URL) -> Bool {
        if url.scheme == "plannotator" { return url.host() == "signin" }
        return url.scheme == "https" && url.path().hasPrefix("/auth/mobile/return/")
    }
}

/// The simulator's return: a one-request listener on 127.0.0.1 for the door's
/// loopback path. It answers that one path with a redirect to the sheet's
/// custom scheme, carrying the return's query as it came; any other request
/// gets a 404. It closes when the sign-in ends.
nonisolated final class LoopbackReturn: @unchecked Sendable {
    private let listener: NWListener
    let port: UInt16

    private init(listener: NWListener, port: UInt16) {
        self.listener = listener
        self.port = port
    }

    static func start(path: String) async throws -> LoopbackReturn {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        let queue = DispatchQueue(label: "ai.plannotator.signin-return")
        listener.newConnectionHandler = { connection in
            connection.start(queue: queue)
            connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { data, _, _, _ in
                let head = String(decoding: data ?? Data(), as: UTF8.self).split(separator: "\r\n").first ?? ""
                let parts = head.split(separator: " ")
                var answer = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                if parts.count == 3, parts[0] == "GET" {
                    let target = String(parts[1])
                    let query = target.firstIndex(of: "?").map { String(target[$0...]) } ?? ""
                    if target.prefix(upTo: target.firstIndex(of: "?") ?? target.endIndex) == path {
                        answer = "HTTP/1.1 302 Found\r\nLocation: plannotator://signin\(query)\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    }
                }
                connection.send(content: Data(answer.utf8), completion: .contentProcessed { _ in connection.cancel() })
            }
        }
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            let once = Once()
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready: once.run { continuation.resume(returning: listener.port?.rawValue ?? 0) }
                case .failed(let error): once.run { continuation.resume(throwing: error) }
                default: break
                }
            }
            listener.start(queue: queue)
        }
        return LoopbackReturn(listener: listener, port: port)
    }

    func stop() { listener.cancel() }

    private nonisolated final class Once: @unchecked Sendable {
        private var done = false
        private let lock = NSLock()
        func run(_ body: () -> Void) {
            lock.lock()
            defer { lock.unlock() }
            guard !done else { return }
            done = true
            body()
        }
    }
}

// MARK: Push for Workspaces (W2's device door)

extension Notification.Name {
    static let pushToken = Notification.Name("ai.plannotator.pushToken")
}

/// Hands the app the APNs token iOS gives it.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .pushToken, object: deviceToken)
    }
}
