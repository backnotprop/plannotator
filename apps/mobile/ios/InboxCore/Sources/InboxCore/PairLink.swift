import Foundation

/// The link the computer's window shows as a QR code:
/// `plannotator://pair?v=1&name=…&tailnet=…&lan=…&fp=…&secret=…&code=…`
/// (packages/server/inbox-devices.ts, `makeOffer`).
public struct PairLink: Hashable, Sendable {
  public enum Failure: Error, Equatable {
    /// Not a pairing link at all.
    case notAPairLink
    /// A `v` this app does not know: the app is older than the Inbox that made the link.
    case newerVersion
    /// The link names no address the phone could reach.
    case noAddress
  }

  public var name: String
  /// `host:port`, HTTPS with the system's trust.
  public var tailnet: String?
  /// `ip:port`, HTTPS with the certificate pinned by `fingerprint`.
  public var lan: String?
  /// SHA-256 of the Wi-Fi listener's certificate, 64 lowercase hex.
  public var fingerprint: String?
  public var secret: String
  public var code: String?

  public init(name: String, tailnet: String? = nil, lan: String? = nil, fingerprint: String? = nil, secret: String, code: String? = nil) {
    self.name = name
    self.tailnet = tailnet
    self.lan = lan
    self.fingerprint = fingerprint
    self.secret = secret
    self.code = code
  }

  public init(_ text: String) throws(Failure) {
    guard let parts = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
      parts.scheme?.lowercased() == "plannotator", parts.host?.lowercased() == "pair"
    else { throw .notAPairLink }
    var fields: [String: String] = [:]
    for item in parts.queryItems ?? [] where fields[item.name] == nil { fields[item.name] = item.value ?? "" }
    guard let version = fields["v"] else { throw .notAPairLink }
    guard version == "1" else { throw .newerVersion }
    guard let secret = fields["secret"], !secret.isEmpty else { throw .notAPairLink }
    let nonEmpty = { (key: String) -> String? in fields[key].flatMap { $0.isEmpty ? nil : $0 } }
    let fingerprint = nonEmpty("fp")?.lowercased()
    // The Wi-Fi address is only usable with its fingerprint: without one there is nothing to pin.
    let lan = fingerprint.flatMap { PairLink.isFingerprint($0) ? nonEmpty("lan") : nil }
    let tailnet = nonEmpty("tailnet")
    guard lan != nil || tailnet != nil else { throw .noAddress }
    self.init(name: nonEmpty("name") ?? "", tailnet: tailnet, lan: lan, fingerprint: lan == nil ? nil : fingerprint, secret: secret, code: nonEmpty("code"))
  }

  static func isFingerprint(_ value: String) -> Bool {
    value.count == 64 && value.allSatisfy { $0.isHexDigit }
  }
}

/// One way to a computer's door.
public enum DoorAddress: Hashable, Sendable, Codable {
  /// The Wi-Fi listener: an IP address, its certificate pinned by SHA-256 and nothing else checked.
  case wifi(hostPort: String, fingerprint: String)
  /// The tailnet listener: ordinary system trust.
  case tailnet(hostPort: String)

  public var hostPort: String {
    switch self {
    case .wifi(let hostPort, _), .tailnet(let hostPort): return hostPort
    }
  }

  public var baseURL: URL? { URL(string: "https://\(hostPort)") }
}

extension PairLink {
  /// The addresses to redeem the secret at, in the order the contract gives: the Wi-Fi first, then the tailnet.
  public var addresses: [DoorAddress] {
    var out: [DoorAddress] = []
    if let lan, let fingerprint { out.append(.wifi(hostPort: lan, fingerprint: fingerprint)) }
    if let tailnet { out.append(.tailnet(hostPort: tailnet)) }
    return out
  }
}
