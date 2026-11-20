import InboxCore
import SwiftUI

/// A file made of words: a Markdown document drawn block by block, plain text, or code with its line numbers.
struct WordsPage: View {
  let url: URL
  let item: AttachmentItem
  let shown: FileFacts.Shown
  @State private var text: String?
  @State private var unreadable = false

  var body: some View {
    Group {
      if let text {
        switch shown {
        case .document: DocumentView(text: text, name: item.name)
        case .text: PlainTextView(text: text)
        default: CodeLinesView(text: text)
        }
      } else if unreadable {
        Standing(symbol: "doc", words: PhoneWords.fileNotShown(item.name))
      } else {
        Waiting()
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Token.background)
    .task(id: url) {
      let read = await Task.detached { try? String(contentsOf: url, encoding: .utf8) }.value
      text = read
      unreadable = read == nil
    }
  }
}

/// The steps of a document's type: a title, a section, a part, then the rest. Same faces as a message's words, a
/// step or two larger, since a document is read at length.
private enum DocumentRole {
  static func heading(_ level: Int) -> Font {
    switch level {
    case 1: return .title2.weight(.bold)
    case 2: return TextRole.prompt
    case 3: return TextRole.heading
    default: return TextRole.name
    }
  }
}

/// A Markdown document, drawn natively from the window's own blocks (`DocumentBlocks`): each block is a view named
/// by the window's id for it, which is what a comment on words will be anchored to.
struct DocumentView: View {
  let blocks: [DocumentBlock]
  let numbers: [String: Int]

  init(text: String, name: String) {
    blocks = DocumentBlocks.parse(text, frontmatter: DocumentBlocks.stripsFrontmatter(name: name))
    numbers = DocumentBlocks.listNumbers(blocks)
  }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(Array(blocks.enumerated()), id: \.element.id) { index, block in
          DocumentBlockView(block: block, number: numbers[block.id])
            .padding(.top, index == 0 ? 0 : gap(blocks[index - 1], block))
            .id(block.id)
        }
      }
      .padding(.horizontal, Space.page)
      .padding(.top, Space.card)
      .padding(.bottom, Space.section)
    }
    .scrollEdgeEffectStyle(.soft, for: .top)
    .accessibilityIdentifier("file-document")
  }

  /// The air between two blocks: a heading opens a section, a list's items stay together.
  private func gap(_ before: DocumentBlock, _ block: DocumentBlock) -> CGFloat {
    if block.kind == .heading { return (block.level ?? 1) <= 2 ? Space.section + Space.tight : Space.section }
    if before.kind == .heading { return Space.near }
    if before.kind == .listItem, block.kind == .listItem { return Space.trim }
    if block.kind == .hr || before.kind == .hr { return Space.section }
    return Space.snug
  }
}

struct DocumentBlockView: View {
  let block: DocumentBlock
  let number: Int?
  @ScaledMetric(relativeTo: .body) private var markWidth: CGFloat = 22

  /// A paragraph's lines are one run of words; a line that ends in two spaces breaks.
  static func flowed(_ content: String) -> String {
    let lines = content.replacingOccurrences(of: "\r", with: "").components(separatedBy: "\n")
    return lines.enumerated().reduce(into: "") { out, line in
      out += line.element.trimmingCharacters(in: .whitespaces)
      if line.offset < lines.count - 1 { out += line.element.hasSuffix("  ") ? "\n" : " " }
    }
  }

  private func words(_ content: String, _ font: Font = TextRole.body, ink: Color = Token.foreground) -> some View {
    Text(MessageBody.attributed(content))
      .font(font)
      .lineSpacing(TextRole.bodyLeading)
      .foregroundStyle(ink)
      .textSelection(.enabled)
      .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// Words that hold paragraphs of their own (a list item, a quote, a `:::` block): each drawn in turn.
  private func paragraphs(_ content: String, ink: Color = Token.foreground) -> some View {
    VStack(alignment: .leading, spacing: Space.close) {
      ForEach(Array(content.components(separatedBy: "\n\n").enumerated()), id: \.offset) { _, part in words(Self.flowed(part), ink: ink) }
    }
  }

  var body: some View {
    switch block.kind {
    case .heading:
      Text(MessageBody.attributed(block.content))
        .font(DocumentRole.heading(block.level ?? 1))
        .foregroundStyle(Token.foreground)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityAddTraits(.isHeader)
    case .paragraph:
      words(Self.flowed(block.content))
    case .listItem:
      HStack(alignment: .firstTextBaseline, spacing: Space.close) {
        mark.frame(minWidth: markWidth, alignment: .trailing)
        paragraphs(block.content, ink: block.checked == true ? Token.mutedForeground : Token.foreground)
      }
      .padding(.leading, CGFloat(min(block.level ?? 0, 4)) * (markWidth + Space.close))
      .accessibilityElement(children: .combine)
    case .blockquote:
      // A quote steps in and steps down: no bar beside it.
      VStack(alignment: .leading, spacing: Space.tight) {
        if let kind = block.alertKind { Text(PhoneWords.alert(kind)).font(TextRole.name).foregroundStyle(Self.alertRole(kind).ink) }
        paragraphs(block.content, ink: block.alertKind == nil ? Token.mutedForeground : Token.foreground)
      }
      .padding(.leading, Space.card)
    case .code:
      CodeBlock(code: block.content)
    case .hr:
      Hairline()
    case .table:
      DocumentTable(content: block.content)
    case .directive:
      paragraphs(block.content)
    }
  }

  @ViewBuilder private var mark: some View {
    if let checked = block.checked {
      Image(systemName: checked ? "checkmark.square.fill" : "square").font(TextRole.body).foregroundStyle(checked ? Token.primary : Token.mutedForeground).accessibilityLabel(checked ? PhoneWords.done : "").accessibilityHidden(!checked)
    } else if let number {
      Text("\(number).").font(TextRole.body).monospacedDigit().foregroundStyle(Token.mutedForeground)
    } else {
      Text("•").font(TextRole.body).foregroundStyle(Token.mutedForeground)
    }
  }

  static func alertRole(_ kind: String) -> Role {
    switch kind {
    case "warning", "important": return .hold
    case "caution": return .stop
    case "tip": return .done
    default: return .act
    }
  }
}

/// A table: its columns as wide as their words need, up to a cap; wider than the page, it scrolls sideways.
struct DocumentTable: View {
  let head: [String]
  let rows: [[String]]

  init(content: String) { (head, rows) = DocumentBlocks.table(content) }

  private func cell(_ words: String, strong: Bool) -> some View {
    Text(MessageBody.attributed(words))
      .font(strong ? TextRole.name : TextRole.secondary)
      .foregroundStyle(Token.foreground)
      .textSelection(.enabled)
      .multilineTextAlignment(.leading)
      .frame(maxWidth: 240, alignment: .leading)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.vertical, Space.close)
  }

  private var grid: some View {
    Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: Space.section, verticalSpacing: 0) {
      GridRow { ForEach(Array(head.enumerated()), id: \.offset) { _, words in cell(words, strong: true) } }
      Divider().overlay(Token.foreground.opacity(0.3))
      ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
        if index > 0 { Hairline() }
        GridRow { ForEach(0..<max(head.count, row.count), id: \.self) { column in cell(column < row.count ? row[column] : "", strong: false) } }
      }
    }
  }

  var body: some View {
    // A table that fits the page is part of the page: only a wider one scrolls, so a swipe across a small table
    // still steps to the next file.
    ViewThatFits(in: .horizontal) {
      grid
      ScrollView(.horizontal) { grid }.scrollIndicators(.visible)
    }
  }
}

/// Plain text: its paragraphs as written, wrapped to the page.
struct PlainTextView: View {
  let parts: [String]

  init(text: String) { parts = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n\n").filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: Space.snug) {
        ForEach(Array(parts.enumerated()), id: \.offset) { _, part in
          Text(part.trimmingCharacters(in: .newlines))
            .font(TextRole.body)
            .lineSpacing(TextRole.bodyLeading)
            .foregroundStyle(Token.foreground)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .padding(.horizontal, Space.page)
      .padding(.top, Space.card)
      .padding(.bottom, Space.section)
    }
    .scrollEdgeEffectStyle(.soft, for: .top)
    .accessibilityIdentifier("file-text")
  }
}

/// Code, a log or a data file: each line with its number, a long line wrapped under itself so nothing is cut and
/// nothing scrolls sideways. A line is a row of its own, named by its number: what a comment on a line will be on.
struct CodeLinesView: View {
  let lines: [Substring]
  @ScaledMetric(relativeTo: .footnote) private var digit: CGFloat = 8

  init(text: String) { lines = FileFacts.lines(text) }

  var body: some View {
    let gutter = max(Size.gutter, CGFloat(String(lines.count).count) * digit)
    ScrollView {
      LazyVStack(alignment: .leading, spacing: TextRole.codeLeading) {
        ForEach(lines.indices, id: \.self) { index in
          HStack(alignment: .firstTextBaseline, spacing: Space.step) {
            Text("\(index + 1)")
              .font(TextRole.code(.caption))
              .monospacedDigit()
              .foregroundStyle(Token.mutedForeground.opacity(0.8))
              .frame(width: gutter, alignment: .trailing)
              .accessibilityHidden(true)
            Text(lines[index].isEmpty ? " " : String(lines[index]))
              .font(TextRole.code(.footnote))
              .foregroundStyle(Token.foreground)
              .textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .id(index + 1)
        }
      }
      .padding(.leading, Space.close)
      .padding(.trailing, Space.card)
      .padding(.top, Space.step)
      .padding(.bottom, Space.section)
    }
    .scrollEdgeEffectStyle(.soft, for: .top)
    .accessibilityIdentifier("file-code")
  }
}
