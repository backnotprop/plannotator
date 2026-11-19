import SwiftUI

/// A message's words for this first slice: paragraphs, headings, lists and code, drawn by the system's own
/// Markdown reading. Slice S2 replaces this with the block tree the computer sends (`message.blocks`, brief F4);
/// until then a `:::` block is never shown as source: a question draws as its card, and anything else as one
/// line that says it is on the computer.
enum MessageBody {
  enum Block: Hashable {
    case text(String)
    case heading(String)
    case code(String)
    case elsewhere
  }

  static func blocks(_ body: String, hasCards: Bool) -> [Block] {
    var open: [String] = []
    var out: [Block] = []
    var paragraph: [String] = []
    var code: [String]?
    var directive: String?
    func flush() {
      if !paragraph.isEmpty { out.append(.text(paragraph.joined(separator: "\n"))) }
      paragraph = []
    }
    for raw in body.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false) {
      let line = String(raw)
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if code != nil {
        if trimmed.hasPrefix("```") {
          out.append(.code(code!.joined(separator: "\n")))
          code = nil
        } else {
          code!.append(line)
        }
        continue
      }
      if let name = directive {
        if trimmed == ":::" {
          let drawnAsCard = hasCards && (name.hasPrefix("question") || name.hasPrefix("action"))
          if !drawnAsCard, out.last != .elsewhere { out.append(.elsewhere) }
          directive = nil
          open = []
        } else {
          open.append(line)
        }
        continue
      }
      if trimmed.hasPrefix("```") {
        flush()
        code = []
      } else if trimmed.hasPrefix(":::"), trimmed.count > 3 {
        flush()
        directive = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces).lowercased()
      } else if trimmed.isEmpty {
        flush()
      } else if let heading = trimmed.firstMatch(of: /^#{1,6}\s+(.+)$/) {
        flush()
        out.append(.heading(String(heading.1)))
      } else if let item = line.firstMatch(of: /^(\s*)[-*+]\s+(?!\[[ xX]\]\s)(.+)$/) {
        paragraph.append("\(item.1)•  \(item.2)")
      } else {
        paragraph.append(line)
      }
    }
    if let code { out.append(.code(code.joined(separator: "\n"))) }
    // A block that never closes hides nothing: its lines are the message's words.
    if directive != nil {
      let rest = open.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
      if !rest.isEmpty { paragraph.append(rest) }
    }
    flush()
    return out
  }

  static func attributed(_ text: String) -> AttributedString {
    (try? AttributedString(markdown: text, options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
  }
}

struct MessageBodyView: View {
  let text: String
  let hasCards: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ForEach(Array(MessageBody.blocks(text, hasCards: hasCards).enumerated()), id: \.offset) { _, block in
        switch block {
        case .text(let text):
          Text(MessageBody.attributed(text))
            .font(.body)
            .foregroundStyle(Token.foreground)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        case .heading(let text):
          Text(MessageBody.attributed(text))
            .font(.headline)
            .foregroundStyle(Token.foreground)
            .accessibilityAddTraits(.isHeader)
        case .code(let code):
          CodeBlock(code: code)
        case .elsewhere:
          Label(PhoneWords.moreOnComputer, systemImage: "desktopcomputer")
            .font(.subheadline)
            .foregroundStyle(Token.mutedForeground)
        }
      }
    }
  }
}

/// Code, scrolling sideways when a line is longer than the page, as the window's code block does
/// (packages/ui/components/blocks/CodeBlock.tsx:75, `overflow-x-auto`). Where a line is cut, the edge fades out,
/// so it reads as "there is more this way"; at the end of the scroll the fade goes.
struct CodeBlock: View {
  let code: String
  @State private var textWidth: CGFloat = 0
  @State private var boxWidth: CGFloat = 0
  @State private var atEnd = false
  private var fades: Bool { textWidth > boxWidth + 1 && !atEnd }

  var body: some View {
    ScrollView(.horizontal) {
      Text(code)
        .font(.system(.callout, design: .monospaced))
        .foregroundStyle(Token.foreground)
        .textSelection(.enabled)
        .padding(14)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { textWidth = $0 }
    }
    .scrollIndicators(.visible)
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { boxWidth = $0 }
    .onScrollGeometryChange(for: Bool.self) { $0.contentOffset.x + $0.containerSize.width >= $0.contentSize.width - 2 } action: { _, now in atEnd = now }
    .mask {
      HStack(spacing: 0) {
        Color.black
        LinearGradient(colors: [.black, .black.opacity(fades ? 0 : 1)], startPoint: .leading, endPoint: .trailing).frame(width: 56)
      }
    }
    .background(Token.codeBackground, in: RoundedRectangle(cornerRadius: Token.radius, style: .continuous))
    .animation(.easeOut(duration: 0.15), value: fades)
  }
}
