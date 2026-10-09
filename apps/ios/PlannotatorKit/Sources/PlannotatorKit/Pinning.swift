import CryptoKit
import Foundation
import Security
import Synchronization

/// The Wi-Fi listener's certificate check (contract section 3): the leaf
/// certificate's SHA-256 equals the fingerprint the QR carried, and nothing
/// else is checked: no host name, no chain, no dates. The pin is the check.
final class PinnedTrust: NSObject, URLSessionDelegate, Sendable {
    let fingerprint: String

    init(fingerprint: String) {
        self.fingerprint = fingerprint.lowercased()
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else { return (.cancelAuthenticationChallenge, nil) }
        guard let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first,
              Self.sha256(SecCertificateCopyData(leaf) as Data) == fingerprint else { return (.cancelAuthenticationChallenge, nil) }
        return (.useCredential, URLCredential(trust: trust))
    }

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// One session per fingerprint, kept for the app's life (a session holds its delegate).
    static func session(_ fingerprint: String) -> URLSession {
        sessions.withLock { sessions in
            if let session = sessions[fingerprint] { return session }
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 20
            config.waitsForConnectivity = false
            config.requestCachePolicy = .reloadIgnoringLocalCacheData
            let session = URLSession(configuration: config, delegate: PinnedTrust(fingerprint: fingerprint), delegateQueue: nil)
            sessions[fingerprint] = session
            return session
        }
    }

    private static let sessions = Mutex<[String: URLSession]>([:])
}
