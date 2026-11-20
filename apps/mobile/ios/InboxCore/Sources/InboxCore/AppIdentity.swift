import Foundation
import InboxWire

/// The app as it names itself to the door on every request: `ios 0.1.0 contract 1`
/// (packages/core/inbox-door-version.ts, `formatInboxAppHeader`).
public struct AppIdentity: Hashable, Sendable {
  /// The request header an app names itself in (`INBOX_APP_HEADER`). The door never forwards it.
  public static let headerName = "X-Plannotator-App"

  public var platform: String
  public var version: String
  public var contract: Int

  public init(platform: String = "ios", version: String, contract: Int = wireContract) {
    self.platform = platform
    self.version = version
    self.contract = contract
  }

  public var headerValue: String { "\(platform) \(version) contract \(contract)" }

  /// What the door makes of a header value, or nil when it is not in the form (read as no header).
  public static func parse(_ value: String?) -> AppIdentity? {
    guard let value else { return nil }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    let pattern = /^([a-z][a-z0-9-]{0,31}) ([0-9A-Za-z][0-9A-Za-z.+-]{0,31}) contract (0|[1-9][0-9]{0,5})$/
    guard let match = try? pattern.wholeMatch(in: trimmed), let contract = Int(match.3) else { return nil }
    return AppIdentity(platform: String(match.1), version: String(match.2), contract: contract)
  }
}
