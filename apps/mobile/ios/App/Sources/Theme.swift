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
  static let destructiveForeground = Color("destructive-foreground")
  static let popover = Color("popover")
  static let ring = Color("ring")
  static let codeBackground = Color("code-bg")
  static let input = Color("input")
  /// tokens.json `radius`.
  static let radius: CGFloat = 10
}

/// An agent's mark: the product's own icon for it (AgentMarks.xcassets, copied from the product's icon files by
/// scripts/mobile/agent-marks.ts), else its letter. The faces a person chooses for their agents arrive with the
/// door's agent-faces routes (slice S6).
struct AgentMark: View {
  let author: InboxAuthor
  var size: CGFloat = 36
  /// The tile under the mark (another ground when the row itself rests on this one).
  var ground: Color = Token.muted
  @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

  var body: some View {
    let side = min(size * scale, size * 1.5)
    let shape = RoundedRectangle(cornerRadius: side * 0.26, style: .continuous)
    Group {
      // The catalog itself says which agents have a mark: no second list to keep in step.
      if let host = author.host, let mark = UIImage(named: "agent-\(host)") {
        Image(uiImage: mark)
          .resizable()
          .scaledToFit()
          .padding(side * 0.18)
      } else {
        Text(String(Names.agent(author).trimmingCharacters(in: .whitespaces).prefix(1)).uppercased())
          .font(.system(size: side * 0.44, weight: .semibold, design: .rounded))
          .foregroundStyle(Token.foreground)
      }
    }
    .frame(width: side, height: side)
    .background(ground, in: shape)
    .clipShape(shape)
    .accessibilityHidden(true)
  }
}

/// Runs of words with their own weight or colour, as one line of text.
func run(_ parts: Text...) -> Text {
  parts.dropFirst().reduce(parts.first ?? Text(verbatim: "")) { Text("\($0)\($1)") }
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
