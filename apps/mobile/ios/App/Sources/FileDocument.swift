import InboxCore
import SwiftUI

/// A file made of words: a Markdown document drawn block by block, plain text, or code with its line numbers. The
/// file is read and cut into rows off the main thread, once for each version opened (`TextRows`, `DocumentRows`),
/// so a large file scrolls as smoothly as a small one.
struct WordsPage: View {
  let url: URL
  let item: AttachmentItem
  let shown: FileFacts.Shown

  enum Read: Sendable {
    case document(DocumentRows)
    case text(TextRows)
    case code(TextRows)
  }

  @State private var read: Read?
  @State private var unreadable = false

  var body: some View {
    Group {
      switch read {
      case .document(let document)?: DocumentView(document: document)
      case .text(let rows)?: PlainTextView(rows: rows)
      case .code(let rows)?: CodeLinesView(rows: rows)
      case nil:
        if unreadable { Standing(symbol: "doc", words: PhoneWords.fileNotShown(item.name)) } else { Waiting() }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Token.background)
    .task(id: url) {
      let shown = shown
      let name = item.name
      let made = await Task.detached { () -> Read? in
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        switch shown {
        case .document: return .document(DocumentRows(text: text, name: name))
        case .text: return .text(TextRows.plain(text))
        default: return .code(TextRows.code(text))
        }
      }.value
      read = made
      unreadable = made == nil
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
/// by the window's id for it, which is what a comment on words will be anchored to. A very long block is drawn in
/// parts, and a long table a row at a time, each a row of the lazy stack (`DocumentRows`).
struct DocumentView: View {
  let document: DocumentRows

  var body: some View {
    let rows = document.rows
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(0..<rows.count, id: \.self) { index in
          row(rows[index])
            .padding(.top, index == 0 ? 0 : gap(rows[index - 1], rows[index]))
            .id(name(index))
        }
      }
      .padding(.horizontal, Space.page)
      .padding(.top, Space.card)
      .padding(.bottom, Space.section)
    }
    .scrollEdgeEffectStyle(.soft, for: .top)
    .accessibilityIdentifier("file-document")
  }

  /// A block's first row is named by the block's id; its other rows after it.
  private func name(_ index: Int) -> String {
    let block = document.blocks[document.rows[index].block].id
    return index > 0 && document.rows[index - 1].block == document.rows[index].block ? "\(block)/\(index)" : block
  }

  @ViewBuilder private func row(_ row: DocumentRows.Row) -> some View {
    let block = document.blocks[row.block]
    switch row {
    case .block(let index):
      if let table = document.tables[index] { DocumentTable(table: table) } else { DocumentBlockView(block: block, number: document.numbers[block.id]) }
    case .piece(_, let words, let first):
      DocumentBlockView(block: block, number: document.numbers[block.id], part: words, first: first)
    case .tableHead(let index):
      VStack(spacing: 0) {
        TableLine(cells: document.tables[index]?.head ?? [], columns: document.tables[index]?.columns ?? 0, strong: true)
        Divider().overlay(Token.foreground.opacity(0.3))
      }
    case .tableRow(let index, let at):
      VStack(spacing: 0) {
        if at > 0 { Hairline() }
        TableLine(cells: document.tables[index]?.rows[at] ?? [], columns: document.tables[index]?.columns ?? 0, strong: false)
      }
    }
  }

  /// The air between two rows: a heading opens a section, a list's items stay together, a block's own parts and a
  /// table's rows sit close.
  private func gap(_ before: DocumentRows.Row, _ row: DocumentRows.Row) -> CGFloat {
    if before.block == row.block {
      if case .piece = row { return Space.close }
      return 0
    }
    let before = document.blocks[before.block]
    let block = document.blocks[row.block]
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
  /// A part of a long block's words, and whether it is the block's first (which draws the list's mark or the
  /// alert's name); nil: the whole block.
  var part: String?
  var first = true
  @ScaledMetric(relativeTo: .body) private var markWidth: CGFloat = 22

  private var content: String { part ?? block.content }

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
      Text(MessageBody.attributed(content))
        .font(DocumentRole.heading(block.level ?? 1))
        .foregroundStyle(Token.foreground)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityAddTraits(.isHeader)
    case .paragraph:
      words(Self.flowed(content))
    case .listItem:
      HStack(alignment: .firstTextBaseline, spacing: Space.close) {
        mark.frame(minWidth: markWidth, alignment: .trailing).opacity(first ? 1 : 0)
        paragraphs(content, ink: block.checked == true ? Token.mutedForeground : Token.foreground)
      }
      .padding(.leading, CGFloat(min(block.level ?? 0, 4)) * (markWidth + Space.close))
      .accessibilityElement(children: .combine)
      // A task is read as a box that is ticked or not, in the system's own words for one.
      .accessibilityAddTraits(block.checked == nil ? [] : block.checked == true ? [.isToggle, .isSelected] : [.isToggle])
    case .blockquote:
      // A quote steps in and steps down: no bar beside it.
      VStack(alignment: .leading, spacing: Space.tight) {
        if first, let kind = block.alertKind { Text(PhoneWords.alert(kind)).font(TextRole.name).foregroundStyle(Self.alertRole(kind).ink) }
        paragraphs(content, ink: block.alertKind == nil ? Token.mutedForeground : Token.foreground)
      }
      .padding(.leading, Space.card)
    case .code:
      // A part of a long block has no Copy of its own (it would copy only the part): More's Copy file has it all.
      CodeBlock(code: content, copies: part == nil)
    case .hr:
      Hairline()
    case .table:
      DocumentTable(table: DocumentRows.Table(content: content))
    case .directive:
      paragraphs(content)
    }
  }

  @ViewBuilder private var mark: some View {
    if let checked = block.checked {
      Image(systemName: checked ? "checkmark.square.fill" : "square").font(TextRole.body).foregroundStyle(checked ? Token.primary : Token.mutedForeground).accessibilityHidden(true)
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

/// A table: its columns as wide as their words need, up to a cap; wider than the page, it scrolls sideways. Only a
/// short table is drawn this way (`DocumentRows.tableCap`); a long one is a row at a time (`TableLine`).
struct DocumentTable: View {
  let head: [String]
  let rows: [[String]]

  init(table: DocumentRows.Table) {
    head = table.head
    rows = table.rows
  }

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

/// One row of a long table: its columns share the page's width alike, the same in every row, so the rows line up
/// without being laid out together.
struct TableLine: View {
  let cells: [String]
  let columns: Int
  let strong: Bool

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Space.step) {
      ForEach(0..<max(columns, 1), id: \.self) { column in
        Text(MessageBody.attributed(column < cells.count ? cells[column] : ""))
          .font(strong ? TextRole.name : TextRole.secondary)
          .foregroundStyle(Token.foreground)
          .textSelection(.enabled)
          .multilineTextAlignment(.leading)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .padding(.vertical, Space.close)
    .accessibilityElement(children: .combine)
  }
}

/// Plain text: its paragraphs as written, wrapped to the page; a long one in parts (`TextRows.plain`).
struct PlainTextView: View {
  let rows: TextRows

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(0..<rows.rows.count, id: \.self) { index in
          let row = rows.rows[index]
          Text(rows.text(row))
            .font(TextRole.body)
            .lineSpacing(TextRole.bodyLeading)
            .foregroundStyle(Token.foreground)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, index == 0 ? 0 : row.first ? Space.snug : TextRole.bodyLeading)
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
/// nothing scrolls sideways, and a very long one (a minified bundle) in pieces under its number. A line's first row
/// is found by its number (`TextRows.row(ofLine:)`): what a comment on a line will be on.
struct CodeLinesView: View {
  let rows: TextRows
  @ScaledMetric(relativeTo: .footnote) private var digit: CGFloat = 8

  var body: some View {
    let gutter = max(Size.gutter, CGFloat(String(rows.lines).count) * digit)
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(0..<rows.rows.count, id: \.self) { index in
          let row = rows.rows[index]
          let words = rows.text(row)
          HStack(alignment: .firstTextBaseline, spacing: Space.step) {
            Text(row.first ? "\(row.line)" : " ")
              .font(TextRole.code(.caption))
              .monospacedDigit()
              .foregroundStyle(Token.mutedForeground.opacity(0.8))
              .frame(width: gutter, alignment: .trailing)
              .accessibilityHidden(true)
            Text(words.isEmpty ? " " : words)
              .font(TextRole.code(.footnote))
              .foregroundStyle(Token.foreground)
              .textSelection(.enabled)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
          .padding(.top, index > 0 && row.first ? TextRole.codeLeading : 0)
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
