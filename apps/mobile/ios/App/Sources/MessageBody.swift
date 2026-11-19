import InboxCore
import SwiftUI

/// A message's words for this first slice: paragraphs, headings, lists and code, drawn by the system's own
/// Markdown reading. Slice S2 replaces this with the block tree the computer sends (`message.blocks`, brief F4);
/// until then a `:::` block is never shown as source: a question and an action item draw as their cards, where
/// the agent wrote them (so an action item written before a question comes before it, as in the window), and
/// anything else as one line that says it is on the computer.
enum MessageBody {
  enum Block: Hashable {
    case text(String)
    case heading(String)
    case code(String)
    case elsewhere
    /// The message's question at this place, counted from 0 in the order the agent wrote them.
    case question(Int)
    /// A run of adjacent action items: one checklist, as in the window.
    case actions(first: Int, count: Int)
  }

  /// `questions` and `actions`: how many of each the message has as cards.
  static func blocks(_ body: String, questions: Int, actions: Int) -> [Block] {
    var askedSoFar = 0
    var todosSoFar = 0
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
          flush()
          // The block's own name, whole: `:::actions` is another block.
          let kind = String(name.prefix { $0.isLetter })
          if kind == "question", questions > 0 {
            if askedSoFar < questions { out.append(.question(askedSoFar)) }
            askedSoFar += 1
          } else if kind == "action", actions > 0 {
            if todosSoFar < actions {
              if case .actions(let first, let count)? = out.last { out[out.count - 1] = .actions(first: first, count: count + 1) } else { out.append(.actions(first: todosSoFar, count: 1)) }
            }
            todosSoFar += 1
          } else if out.last != .elsewhere {
            out.append(.elsewhere)
          }
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
    // A card the body has no block for is never lost: it comes after the words.
    if askedSoFar < questions { out.append(contentsOf: (askedSoFar..<questions).map { .question($0) }) }
    if todosSoFar < actions { out.append(.actions(first: todosSoFar, count: actions - todosSoFar)) }
    return out
  }

  static func attributed(_ text: String) -> AttributedString {
    (try? AttributedString(markdown: text, options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
  }
}

/// One block of words (the cards are drawn by the thread, which has their data).
struct MessageWords: View {
  let block: MessageBody.Block

  var body: some View {
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
    case .question, .actions:
      EmptyView()
    }
  }
}

/// Code as the window draws it on a phone (packages/ui/components/blocks/CodeBlock.tsx): a long line wraps, so
/// nothing is cut, and Copy sits in the top corner. A block that is drawn or aligned (a box diagram, columns)
/// keeps its layout instead (`codeBlockKeepsLayout`): it scrolls sideways, and where a line is cut the edge fades.
struct CodeBlock: View {
  let code: String
  /// A permission prompt's request: the same box, with no Copy (the window's has none).
  var copies = true
  @State private var copied = false
  @State private var textWidth: CGFloat = 0
  @State private var boxWidth: CGFloat = 0
  @State private var atEnd = false
  private var fades: Bool { textWidth > boxWidth + 1 && !atEnd }

  private var words: some View {
    Text(code)
      .font(.system(copies ? .callout : .footnote, design: .monospaced))
      .foregroundStyle(Token.foreground)
      .textSelection(.enabled)
  }

  var body: some View {
    Group {
      if CodeLayout.keeps(code) {
        ScrollView(.horizontal) {
          words
            .fixedSize()
            .padding(.horizontal, 14)
            // A slim band over the drawing holds Copy: the drawing's first rule starts under the button, never
            // through it.
            .padding(.top, copies ? 42 : 13)
            .padding(.bottom, 13)
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
        .animation(.easeOut(duration: 0.15), value: fades)
      } else {
        words
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.leading, 14)
          .padding(.vertical, 13)
          // The words never run under the button.
          .padding(.trailing, copies ? 44 : 14)
      }
    }
    .frame(minHeight: copies ? 44 : 0)
    .background(Token.codeBackground, in: RoundedRectangle(cornerRadius: Token.radius, style: .continuous))
    // Over a drawing that scrolls sideways, Copy is a chip of its own in the band above the drawing.
    .overlay(alignment: .topTrailing) { if copies { CopyButton(text: code, copied: $copied, ground: CodeLayout.keeps(code)) } }
  }
}

/// Copy, 44 points to touch, answering with a tick for two seconds.
struct CopyButton: View {
  let text: String
  @Binding var copied: Bool
  var ground = false

  var body: some View {
    Button {
      UIPasteboard.general.string = text
      copied = true
      Task {
        try? await Task.sleep(for: .seconds(2))
        copied = false
      }
    } label: {
      Image(systemName: copied ? "checkmark" : "square.on.square")
        .font(.footnote.weight(.medium))
        .foregroundStyle(copied ? Token.success : Token.mutedForeground)
        .frame(width: 32, height: 32)
        .background(ground ? Token.card : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay { if ground { RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Token.border, lineWidth: 0.5) } }
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .sensoryFeedback(.success, trigger: copied) { _, now in now }
    .accessibilityLabel(copied ? PhoneWords.copied : PhoneWords.copy)
  }
}
