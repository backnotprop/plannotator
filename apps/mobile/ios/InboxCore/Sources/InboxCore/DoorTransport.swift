import CryptoKit
import Foundation
import InboxWire

/// One request to a door, before any transport has shaped it.
public struct DoorCall: Sendable {
  public var method: DoorMethod
  /// Relative to `Door.prefix`.
  public var path: String
  public var query: [URLQueryItem]
  public var headers: [String: String]
  public var body: Data?

  public init(method: DoorMethod, path: String, query: [URLQueryItem] = [], headers: [String: String] = [:], body: Data? = nil) {
    self.method = method
    self.path = path
    self.query = query
    self.headers = headers
    self.body = body
  }
}

public struct DoorAnswerBytes: Sendable {
  public var status: Int
  /// Header names in lower case.
  public var headers: [String: String]
  public var body: Data

  public init(status: Int, headers: [String: String] = [:], body: Data) {
    self.status = status
    self.headers = headers
    self.body = body
  }
}

/// A way to a door: HTTPS on the Wi-Fi or the tailnet, or a door in memory.
public protocol DoorTransport: Sendable {
  func send(_ call: DoorCall) async throws -> DoorAnswerBytes
  /// The event stream's bytes, or nil when this way has none.
  func events(_ call: DoorCall) async throws -> AsyncThrowingStream<Data, Error>?
}

extension DoorTransport {
  public func events(_ call: DoorCall) async throws -> AsyncThrowingStream<Data, Error>? { nil }
}

/// HTTPS to one address. The Wi-Fi listener's certificate is self-signed: the leaf's SHA-256 must equal the
/// fingerprint from the QR code, and nothing else is checked (no host name, chain or dates), as the contract says.
public final class HTTPTransport: NSObject, DoorTransport, URLSessionDelegate, @unchecked Sendable {
  public let address: DoorAddress
  private let base: URL
  private let timeout: TimeInterval
  private var session: URLSession!

  public init?(address: DoorAddress, timeout: TimeInterval = 20, protocols: [AnyClass] = []) {
    guard let base = address.baseURL else { return nil }
    self.address = address
    self.base = base
    self.timeout = timeout
    super.init()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.waitsForConnectivity = false
    if !protocols.isEmpty { configuration.protocolClasses = protocols }
    session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
  }

  deinit { session?.invalidateAndCancel() }

  func request(for call: DoorCall, timeout: TimeInterval) throws -> URLRequest {
    guard var parts = URLComponents(url: base, resolvingAgainstBaseURL: false) else { throw URLError(.badURL) }
    parts.percentEncodedPath = Door.prefix + call.path
    if !call.query.isEmpty { parts.queryItems = call.query }
    guard let url = parts.url else { throw URLError(.badURL) }
    var request = URLRequest(url: url, timeoutInterval: timeout)
    request.httpMethod = call.method.rawValue
    for (name, value) in call.headers { request.setValue(value, forHTTPHeaderField: name) }
    request.httpBody = call.body
    return request
  }

  static func headers(of response: HTTPURLResponse) -> [String: String] {
    var out: [String: String] = [:]
    for (name, value) in response.allHeaderFields {
      if let name = name as? String, let value = value as? String { out[name.lowercased()] = value }
    }
    return out
  }

  public func send(_ call: DoorCall) async throws -> DoorAnswerBytes {
    let (data, response) = try await session.data(for: request(for: call, timeout: timeout))
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    return DoorAnswerBytes(status: http.statusCode, headers: Self.headers(of: http), body: data)
  }

  public func events(_ call: DoorCall) async throws -> AsyncThrowingStream<Data, Error>? {
    // The stream pings every 15 s: a silence four times that long is a dead connection.
    let request = try request(for: call, timeout: 60)
    let (bytes, response) = try await session.bytes(for: request)
    guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
    guard http.statusCode == 200 else {
      var body = Data()
      for try await byte in bytes.prefix(64 * 1024) { body.append(byte) }
      throw DoorFailure.from(status: http.statusCode, headers: Self.headers(of: http), body: body)
    }
    return AsyncThrowingStream { continuation in
      let task = Task {
        do {
          var chunk = Data()
          for try await byte in bytes {
            chunk.append(byte)
            if byte == 0x0A {
              continuation.yield(chunk)
              chunk = Data()
            }
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }
      }
      continuation.onTermination = { _ in task.cancel() }
    }
  }

  public func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust, let trust = challenge.protectionSpace.serverTrust else {
      return (.performDefaultHandling, nil)
    }
    guard case .wifi(_, let fingerprint) = address else { return (.performDefaultHandling, nil) }
    guard let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first else { return (.cancelAuthenticationChallenge, nil) }
    let found = CertificatePin.fingerprint(ofDER: SecCertificateCopyData(leaf) as Data)
    return found == fingerprint.lowercased() ? (.useCredential, URLCredential(trust: trust)) : (.cancelAuthenticationChallenge, nil)
  }
}

public enum CertificatePin {
  /// SHA-256 of a certificate's DER bytes, 64 lowercase hex: what the QR code's `fp` holds.
  public static func fingerprint(ofDER der: Data) -> String {
    SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
  }
}
