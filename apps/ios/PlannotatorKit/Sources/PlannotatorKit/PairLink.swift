import Foundation

/// The `plannotator://pair` link the computer draws as a QR code (contract section 1).
public struct PairLink: Equatable, Sendable {
    public var name: String
    public var tailnet: InboxAddress?
    public var lan: InboxAddress?
    public var fingerprint: String?
    public var secret: String
    public var code: String

    public enum Failure: Error, Equatable {
        /// Not a pairing link at all.
        case notALink
        /// A link from a newer Inbox: `v` this app does not know.
        case newerVersion
    }

    public static func parse(_ text: String) -> Result<PairLink, Failure> {
        // A `+` in the query is a space, as URLSearchParams writes it ("MacBook+Pro");
        // a literal plus arrives as %2B.
        guard let components = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "+", with: "%20")),
              components.scheme == "plannotator", components.host == "pair" else { return .failure(.notALink) }
        var query: [String: String] = [:]
        for item in components.queryItems ?? [] { query[item.name] = item.value }
        guard let v = query["v"] else { return .failure(.notALink) }
        guard v == "1" else { return .failure(.newerVersion) }
        guard let secret = query["secret"], !secret.isEmpty, let code = query["code"], code.count == 6,
              code.allSatisfy(\.isASCII), code.allSatisfy(\.isNumber) else { return .failure(.notALink) }
        return .success(PairLink(
            name: query["name"].flatMap { $0.isEmpty ? nil : $0 } ?? "Your computer",
            tailnet: query["tailnet"].flatMap(InboxAddress.init),
            lan: query["lan"].flatMap(InboxAddress.init),
            fingerprint: query["fp"],
            secret: secret,
            code: code
        ))
    }
}
