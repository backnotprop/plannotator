import InboxWire
import SwiftUI

/// The product's colours, from the contract's generated catalog (Tokens.xcassets): light with a dark appearance.
enum Token {
  static let background = Color("background")
  static let foreground = Color("foreground")
  static let card = Color("card")
  static let muted = Color("muted")
  static let mutedForeground = Color("muted-foreground")
  static let primary = Color("primary")
  static let primaryForeground = Color("primary-foreground")
  static let secondary = Color("secondary")
  static let secondaryForeground = Color("secondary-foreground")
  static let border = Color("border")
  static let success = Color("success")
  static let warning = Color("warning")
  static let destructive = Color("destructive")
  static let codeBackground = Color("code-bg")
  static let input = Color("input")
  /// tokens.json `radius`.
  static let radius: CGFloat = 10
}

/// An agent's mark: its first letter on a quiet tile, until the door carries the agents' own pictures.
struct AgentMark: View {
  let name: String
  var size: CGFloat = 36
  @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

  var body: some View {
    let side = min(size * scale, size * 1.5)
    Text(String(name.trimmingCharacters(in: .whitespaces).prefix(1)).uppercased())
      .font(.system(size: side * 0.44, weight: .semibold, design: .rounded))
      .foregroundStyle(Token.foreground)
      .frame(width: side, height: side)
      .background(Token.muted, in: RoundedRectangle(cornerRadius: side * 0.26, style: .continuous))
      .accessibilityHidden(true)
  }
}

enum Names {
  /// An author's name as the window gives it (`inboxAgentName`): its own name, else its agent's, else "An agent".
  static func agent(_ author: InboxAuthor) -> String {
    guard author.kind == .agent else { return PhoneWords.you }
    if let name = author.name, !name.isEmpty { return name }
    if let host = author.host, !host.isEmpty { return Words.agents[host] ?? host }
    return PhoneWords.anAgent
  }
}
