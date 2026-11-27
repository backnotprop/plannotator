import InboxCore
import SwiftUI

/// A file made of words: a Markdown document drawn block by block, plain text, or code with its line numbers. The
/// file is read and cut into rows off the main thread, once for each version opened (`TextRows`, `DocumentRows`),
/// so a large file scrolls as smoothly as a small one.
struct WordsPage: View {
  let url: URL
  let item: AttachmentItem
  let shown: FileFacts.Shown
  let context: CommentContext

  enum Read: Sendable {
    /// `splits`: the phone splits this file into the window's own blocks, so a comment can name one
    /// (`DocumentBlocks.matchesWindow`). Where it does not, a comment names no block: its words find the place.
    case document(DocumentRows, splits: Bool)
    /// Plain text is drawn by its paragraphs; a comment names the window's block on the line its words start on.
    case text(TextRows, blocks: [DocumentBlock], splits: Bool)
    case code(TextRows)
  }

  @State private var read: Read?
  @State private var unreadable = false

  var body: some View {
    Group {
      switch read {
      case .document(let document, let splits)?: DocumentView(document: document, splits: splits, context: context)
      case .text(let rows, let blocks, let splits)?: PlainTextView(rows: rows, blocks: blocks, splits: splits, context: context)
      case .code(let rows)?: CodeLinesView(rows: rows, context: context)
      case nil:
        if unreadable { Standing(symbol: "doc", words: PhoneWords.fileNotShown(item.name)) } else { Waiting() }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Token.background)
    // A link in a document opens a site or a mail address, as in the window: never another app, never this one's
    // own pairing link.
    .environment(\.openURL, OpenURLAction { SelectableWords.opens($0) ? .systemAction : .discarded })
    .task(id: url) {
      let shown = shown
      let name = item.name
      let made = await Task.detached { () -> Read? in
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        switch shown {
        case .document: return .document(DocumentRows(text: text, name: name), splits: DocumentBlocks.matchesWindow(text))
        case .text: return .text(TextRows.plain(text), blocks: DocumentBlocks.parse(text, frontmatter: DocumentBlocks.stripsFrontmatter(name: name)), splits: DocumentBlocks.matchesWindow(text))
        default: return .code(TextRows.code(text))
        }
      }.value
      read = made
      unreadable = made == nil
    }
  }
}

/// A Markdown document, drawn natively from the window's own blocks (`DocumentBlocks`): each block is a view named
/// by the window's id for it, which is what a comment on words will be anchored to. A very long block is drawn in
/// parts, and a long table a row at a time, each a row of the lazy stack (`DocumentRows`).
struct DocumentView: View {
  let document: DocumentRows
  let splits: Bool
  let context: CommentContext

  var body: some View {
    let rows = document.rows
    let comments = context.comments
    ScrollViewReader { reader in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(0..<rows.count, id: \.self) { index in
            row(rows[index], index: index, comments: comments)
              .padding(.top, index == 0 ? 0 : gap(rows[index - 1], rows[index]))
              .id(name(index))
          }
        }
        .padding(.horizontal, Space.page)
        .padding(.top, Space.card)
        .padding(.bottom, Space.section)
      }
      .scrollEdgeEffectStyle(.soft, for: .top)
      .scrollDismissesKeyboard(.interactively)
      .accessibilityIdentifier("file-document")
      // A comment is being written on words here: they come up to where the keyboard and the field do not cover them.
      .onChange(of: context.desk.draft) { _, draft in
        guard let draft, draft.file == context.item.id, case .words(let block, let start, _) = draft.target else { return }
        let at = rows.firstIndex { splits ? document.blocks[$0.block].id == block : start / Self.blockStride == $0.block }
        if let at { withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : .easeInOut(duration: 0.25)) { reader.scrollTo(name(at), anchor: Self.overKeyboard) } }
      }
      // Back to a comment: its block comes to the middle of the page.
      .onChange(of: context.desk.sought) { _, sought in
        guard let comment = sought?.comment, comment.attachment == context.item.id, let at = rows.firstIndex(where: { holds(comment, block: $0.block) }) else { return }
        withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : .easeInOut(duration: 0.25)) { reader.scrollTo(name(at), anchor: .center) }
      }
    }
  }

  /// Where on the page a thing being commented on rests while the keyboard is up: a fifth of the way down.
  static let overKeyboard = UnitPoint(x: 0.5, y: 0.2)

  /// A comment made where the phone does not share the window's blocks names none: it keeps its block's place in
  /// the file in the millions of where it starts, so the feedback still reads in the file's order.
  static let blockStride = 1_000_000
  /// A long block's parts, and a list item's paragraphs, each start a hundred thousand on.
  static let partStride = 100_000

  private func holds(_ comment: FileComment, block index: Int) -> Bool {
    splits ? comment.blockId == document.blocks[index].id : (comment.blockId ?? "").isEmpty && Int(comment.startOffset) / Self.blockStride == index
  }

  /// Where a block's words start for a comment's `startOffset`, and the block it names.
  private func place(_ index: Int, part: Int) -> WordsPlace {
    WordsPlace(block: splits ? document.blocks[index].id : "", base: (splits ? 0 : index * Self.blockStride) + part * Self.partStride)
  }

  /// A block's first row is named by the block's id; its other rows after it.
  private func name(_ index: Int) -> String {
    let block = document.blocks[document.rows[index].block].id
    return index > 0 && document.rows[index - 1].block == document.rows[index].block ? "\(block)/\(index)" : block
  }

  @ViewBuilder private func row(_ row: DocumentRows.Row, index at: Int, comments: [FileComment]) -> some View {
    let block = document.blocks[row.block]
    let here = comments.filter { holds($0, block: row.block) }
    switch row {
    case .block(let index):
      if let table = document.tables[index] {
        DocumentTable(table: table)
      } else {
        DocumentBlockView(block: block, number: document.numbers[block.id], place: place(index, part: 0), comments: here, context: context)
      }
    case .piece(let index, let words, let first):
      // A part's place among its block's parts: the rows before it of the same block.
      let part = document.rows[..<at].reversed().prefix { $0.block == index }.count
      DocumentBlockView(block: block, number: document.numbers[block.id], part: words, first: first, place: place(index, part: part * 10), comments: here, context: context)
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

/// Where a run of drawn words stands for a comment: the window's block it names ("" for none), and what its first
/// letter counts as in the comment's `startOffset`.
struct WordsPlace {
  var block: String
  var base: Int
}

struct DocumentBlockView: View {
  let block: DocumentBlock
  let number: Int?
  /// A part of a long block's words, and whether it is the block's first (which draws the list's mark or the
  /// alert's name); nil: the whole block.
  var part: String?
  var first = true
  var place = WordsPlace(block: "", base: 0)
  /// The comments on this block.
  var comments: [FileComment] = []
  var context: CommentContext?
  @ScaledMetric(relativeTo: .body) private var markWidth: CGFloat = 22
  @Environment(\.dynamicTypeSize) private var typeSize

  private var content: String { part ?? block.content }

  /// A paragraph's lines are one run of words; a line that ends in two spaces breaks.
  static func flowed(_ content: String) -> String {
    let lines = content.replacingOccurrences(of: "\r", with: "").components(separatedBy: "\n")
    return lines.enumerated().reduce(into: "") { out, line in
      out += line.element.trimmingCharacters(in: .whitespaces)
      if line.offset < lines.count - 1 { out += line.element.hasSuffix("  ") ? "\n" : " " }
    }
  }

  /// Words to read, select and comment on. `paragraph`: which of the block's paragraphs these are.
  private func words(_ content: String, style: UIFont.TextStyle = .body, weight: UIFont.Weight? = nil, ink: Color = Token.foreground, leading: CGFloat = TextRole.bodyLeading, paragraph: Int = 0, state: String? = nil) -> some View {
    let drawn = WordsInk.attributed(content, style: style, weight: weight, ink: ink, leading: leading, size: typeSize)
    let base = place.base + paragraph * DocumentView.partStride / 100
    return SelectableWords(
      words: drawn, comments: context?.takes ?? false, marked: WordsInk.marks(comments, in: drawn, base: base), writing: context?.writing(block: place.block, base: base, in: drawn), state: state,
      comment: { start, quote in context?.begin(.words(block: place.block, start: base + start, quote: quote)) },
      opened: { context?.desk.edit($0) }
    )
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// Words that hold paragraphs of their own (a list item, a quote, a `:::` block): each drawn in turn.
  private func paragraphs(_ content: String, ink: Color = Token.foreground) -> some View {
    VStack(alignment: .leading, spacing: Space.close) {
      ForEach(Array(content.components(separatedBy: "\n\n").enumerated()), id: \.offset) { index, part in
        // A task is read with whether it is ticked, as a state after its words: it is not a switch here, and
        // nothing says to toggle what cannot be toggled.
        words(Self.flowed(part), ink: ink, paragraph: index, state: index == 0 && first ? block.checked.map { $0 ? PhoneWords.taskTicked : PhoneWords.taskOpen } : nil)
      }
    }
  }

  /// The steps of a document's type: a title, a section, a part, then the rest. Same faces as a message's words, a
  /// step or two larger, since a document is read at length.
  private var headingFace: (style: UIFont.TextStyle, weight: UIFont.Weight) {
    switch block.level ?? 1 {
    case 1: return (.title2, .bold)
    case 2: return (.title3, .semibold)
    case 3: return (.headline, .semibold)
    default: return (.subheadline, .semibold)
    }
  }

  var body: some View {
    switch block.kind {
    case .heading:
      words(content, style: headingFace.style, weight: headingFace.weight, leading: 0)
        .accessibilityAddTraits(.isHeader)
    case .paragraph:
      words(Self.flowed(content))
    case .listItem:
      HStack(alignment: .firstTextBaseline, spacing: Space.close) {
        mark.frame(minWidth: markWidth, alignment: .trailing).opacity(first ? 1 : 0)
        paragraphs(content, ink: block.checked == true ? Token.mutedForeground : Token.foreground)
      }
      .padding(.leading, CGFloat(min(block.level ?? 0, 4)) * (markWidth + Space.close))
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

/// Plain text: its paragraphs as written, wrapped to the page; a long one in parts (`TextRows.plain`). Words selected
/// are commented on as in a document: the comment names the window's block on the line the words start on.
struct PlainTextView: View {
  let rows: TextRows
  let blocks: [DocumentBlock]
  let splits: Bool
  let context: CommentContext
  @Environment(\.dynamicTypeSize) private var typeSize

  /// The block a selection in a row starts in, and where in the file's order it stands.
  private func place(_ row: TextRows.Row, index: Int, text: String, start: Int) -> (block: String, start: Int) {
    let before = (text as NSString).substring(to: min(start, (text as NSString).length))
    let line = rows.sourceLine(of: row) + before.components(separatedBy: "\n").count - 1
    let order = index * DocumentView.partStride + start
    guard splits, let block = DocumentBlocks.block(onLine: line, in: blocks) else { return ("", order) }
    return (block.id, order)
  }

  var body: some View {
    let comments = context.comments
    ScrollViewReader { reader in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(0..<rows.rows.count, id: \.self) { index in
            let row = rows.rows[index]
            let text = rows.text(row)
            let drawn = WordsInk.attributed(text, mono: false, size: typeSize, plain: true)
            // A comment is found again by its words, in the row it was made in.
            let here = comments.filter { Int($0.startOffset) / DocumentView.partStride == index }
            SelectableWords(
              words: drawn, comments: context.takes, marked: WordsInk.marks(here, in: drawn, base: index * DocumentView.partStride),
              writing: context.writing(block: place(row, index: index, text: text, start: 0).block, base: index * DocumentView.partStride, in: drawn),
              comment: { start, quote in
                let at = place(row, index: index, text: text, start: start)
                context.begin(.words(block: at.block, start: at.start, quote: quote))
              },
              opened: { context.desk.edit($0) }
            )
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, index == 0 ? 0 : row.first ? Space.snug : TextRole.bodyLeading)
            .id(index)
          }
        }
        .padding(.horizontal, Space.page)
        .padding(.top, Space.card)
        .padding(.bottom, Space.section)
      }
      .scrollEdgeEffectStyle(.soft, for: .top)
      .scrollDismissesKeyboard(.interactively)
      .accessibilityIdentifier("file-text")
      .onChange(of: context.desk.draft) { _, draft in
        guard let draft, draft.file == context.item.id, case .words(_, let start, _) = draft.target else { return }
        withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : .easeInOut(duration: 0.25)) { reader.scrollTo(start / DocumentView.partStride, anchor: DocumentView.overKeyboard) }
      }
      .onChange(of: context.desk.sought) { _, sought in
        guard let comment = sought?.comment, comment.attachment == context.item.id else { return }
        withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : .easeInOut(duration: 0.25)) { reader.scrollTo(Int(comment.startOffset) / DocumentView.partStride, anchor: .center) }
      }
    }
  }
}

/// Code, a log or a data file: each line with its number, a long line wrapped under itself so nothing is cut and
/// nothing scrolls sideways, and a very long one (a minified bundle) in pieces under its number.
///
/// A touch on a line starts a comment on it; while that comment is being written, a touch on another line takes
/// the run of lines from the one to the other, and a touch inside the run starts again from that line. A comment
/// is on the file's own lines (`TextRows.source`), however a long one is cut for the screen. Lines already
/// commented on carry a tint; a touch on one opens its comment.
struct CodeLinesView: View {
  let rows: TextRows
  let context: CommentContext
  @ScaledMetric(relativeTo: .footnote) private var digit: CGFloat = 8

  private func touched(_ line: Int, comments: [FileComment]) {
    let writing = context.desk.lines(in: context.item.id)
    // A line with a comment opens it, unless a run is being taken across it.
    if writing == nil, let kept = comments.last(where: { $0.codeRange.map { ($0.lineStart...$0.lineEnd).contains(line) } ?? false }) { return context.desk.edit(kept) }
    let run = FileComments.run(writing, touched: line)
    UISelectionFeedbackGenerator().selectionChanged()
    context.begin(.lines(run, code: rows.source(lines: run)))
  }

  var body: some View {
    let gutter = max(Size.gutter, CGFloat(String(rows.lines).count) * digit)
    let comments = context.comments
    let takes = context.takes
    let writing = context.desk.lines(in: context.item.id)
    let commented = comments.compactMap { $0.codeRange.map { $0.lineStart...$0.lineEnd } }
    ScrollViewReader { reader in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(0..<rows.rows.count, id: \.self) { index in
            let row = rows.rows[index]
            let words = rows.text(row)
            let chosen = writing?.contains(row.line) == true
            let kept = commented.contains { $0.contains(row.line) }
            HStack(alignment: .firstTextBaseline, spacing: Space.step) {
              Text(row.first ? "\(row.line)" : " ")
                .font(TextRole.code(.caption))
                .monospacedDigit()
                .foregroundStyle(chosen || kept ? Token.primary : Token.mutedForeground.opacity(0.8))
                .frame(width: gutter, alignment: .trailing)
                .accessibilityHidden(true)
              Text(words.isEmpty ? " " : words)
                .font(TextRole.code(.footnote))
                .foregroundStyle(Token.foreground)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.top, index > 0 && row.first ? TextRole.codeLeading : 0)
            .padding(.leading, Space.close)
            .padding(.trailing, Space.card)
            // The lines being commented on, and the ones already commented on: a ground, edge to edge.
            .background(chosen ? Color(uiColor: SelectableWords.tint(0.22, dark: 0.4)) : kept ? Color(uiColor: SelectableWords.tint(0.1, dark: 0.2)) : Color.clear)
            .contentShape(Rectangle())
            .onTapGesture { if takes { touched(row.line, comments: comments) } }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(chosen ? [.isSelected] : [])
            .accessibilityAction(named: PhoneWords.comment) { if takes { touched(row.line, comments: comments) } }
            .accessibilityIdentifier(row.first ? "line/\(row.line)" : "")
            .id(index)
          }
        }
        .padding(.top, Space.step)
        .padding(.bottom, Space.section)
      }
      .scrollEdgeEffectStyle(.soft, for: .top)
      .scrollDismissesKeyboard(.interactively)
      .accessibilityIdentifier("file-code")
      // The first line of a run being commented on comes up to where the keyboard does not cover it; stretching the
      // run moves nothing.
      .onChange(of: writing?.lowerBound) { was, line in
        guard was == nil, let line, let at = rows.row(ofLine: line) else { return }
        withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : .easeInOut(duration: 0.25)) { reader.scrollTo(at, anchor: DocumentView.overKeyboard) }
      }
      .onChange(of: context.desk.sought) { _, sought in
        guard let comment = sought?.comment, comment.attachment == context.item.id, let line = comment.codeRange?.lineStart, let at = rows.row(ofLine: line) else { return }
        withAnimation(UIAccessibility.isReduceMotionEnabled ? nil : .easeInOut(duration: 0.25)) { reader.scrollTo(at, anchor: .center) }
      }
    }
  }
}
