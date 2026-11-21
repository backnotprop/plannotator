import Foundation

/// A file of words cut into rows that a lazy list draws one at a time, made off the main thread, once per file.
///
/// Each row is bounded: no row holds more than `piece` bytes of the file, so a 3 MB one-line JSON or a minified
/// bundle is many short rows, not one text of megabytes (the window wraps such a line instead of scrolling it,
/// packages/inbox/attachments.ts `CODE_WRAP_LINE_CHARS`; on the phone every line wraps). Code is a row per line, a
/// long line cut into pieces under it; plain text is a row per paragraph, a long paragraph cut the same way.
public struct TextRows: Sendable {
  /// The most UTF-8 bytes one row holds.
  public static let piece = 2_000

  public struct Row: Hashable, Sendable {
    /// The line (code) or the paragraph (plain text) the row is part of, from 1.
    public var line: Int { Int(number) }
    /// The first row of its line or paragraph: where a line's number is drawn, and where a paragraph's gap is.
    public let first: Bool
    let number: UInt32
    let start: UInt32
    let end: UInt32
  }

  public let rows: [Row]
  /// How many lines (code) or paragraphs (plain text) the file has.
  public let lines: Int
  private let bytes: [UInt8]

  public func text(_ row: Row) -> String { String(decoding: bytes[Int(row.start)..<Int(row.end)], as: UTF8.self) }

  /// The first row of a line, by its number (from 1).
  public func row(ofLine line: Int) -> Int? {
    var low = 0
    var high = rows.count
    while low < high {
      let middle = (low + high) / 2
      if rows[middle].line < line { low = middle + 1 } else { high = middle }
    }
    return low < rows.count && rows[low].line == line ? low : nil
  }

  /// Code, a log or a data file: a row per line, as an editor counts them (`FileFacts.lines`).
  public static func code(_ text: String) -> TextRows {
    let bytes = Array(text.utf8)
    var rows: [Row] = []
    var number: UInt32 = 0
    var start = 0
    let count = bytes.count
    while start <= count {
      var end = start
      while end < count, bytes[end] != 0x0A { end += 1 }
      // A line break at the end of the file ends its last line, it does not start another.
      if end == count, start == count, number > 0 { break }
      number += 1
      var last = end
      if last > start, bytes[last - 1] == 0x0D { last -= 1 }
      cut(bytes, start, last, number: number, breaks: codeBreaks, into: &rows)
      start = end + 1
    }
    return TextRows(rows: rows, lines: Int(number), bytes: bytes)
  }

  /// Plain text: a row per paragraph (parted by a blank line), as written.
  public static func plain(_ text: String) -> TextRows {
    let bytes = Array((text.contains("\r\n") ? text.replacingOccurrences(of: "\r\n", with: "\n") : text).utf8)
    var rows: [Row] = []
    var number: UInt32 = 0
    let count = bytes.count
    var start = 0
    func isSpace(_ byte: UInt8) -> Bool { byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D }
    while start < count {
      // The paragraph runs to the next "\n\n".
      var end = start
      while end < count, !(bytes[end] == 0x0A && end + 1 < count && bytes[end + 1] == 0x0A) { end += 1 }
      var from = start
      var to = end
      while from < to, bytes[from] == 0x0A { from += 1 }
      while to > from, bytes[to - 1] == 0x0A { to -= 1 }
      if (from..<to).contains(where: { !isSpace(bytes[$0]) }) {
        number += 1
        cut(bytes, from, to, number: number, breaks: [0x0A, 0x20, 0x09], into: &rows)
      }
      start = end + 1
    }
    return TextRows(rows: rows, lines: Int(number), bytes: bytes)
  }

  /// Where a long line of code is best cut: after a space or a mark that ends a statement or a part.
  private static let codeBreaks: Set<UInt8> = [0x20, 0x09, 0x3B, 0x2C, 0x7B, 0x7D, 0x28, 0x29, 0x5B, 0x5D, 0x3E]

  /// One line (or paragraph) as rows of at most `piece` bytes: cut after the last break in the piece's second
  /// half, else at the last whole character.
  private static func cut(_ bytes: [UInt8], _ start: Int, _ end: Int, number: UInt32, breaks: Set<UInt8>, into rows: inout [Row]) {
    var from = start
    var first = true
    repeat {
      var to = end
      if end - from > piece {
        to = from + piece
        var at = to
        while at > from + piece / 2, !breaks.contains(bytes[at - 1]) { at -= 1 }
        if at > from + piece / 2 { to = at } else { while to > from + 1, bytes[to] & 0xC0 == 0x80 { to -= 1 } }
      }
      var shown = to
      // A paragraph cut at a line break: the break is where the rows part.
      if to < end, bytes[to - 1] == 0x0A { shown -= 1 }
      rows.append(Row(first: first, number: number, start: UInt32(from), end: UInt32(shown)))
      first = false
      from = to
    } while from < end
  }

  init(rows: [Row], lines: Int, bytes: [UInt8]) {
    self.rows = rows
    self.lines = lines
    self.bytes = bytes
  }
}

/// A Markdown document as the rows a lazy list draws: a row per block (the window's blocks, by their ids), except
/// that a block of more than `blockCap` bytes is several rows of its words, and a table of more than `tableCap`
/// rows is a row per table row. Made off the main thread, once per file.
public struct DocumentRows: Sendable {
  public static let blockCap = 16_000
  public static let tableCap = 200

  public struct Table: Hashable, Sendable {
    public let head: [String]
    public let rows: [[String]]
    public var columns: Int { max(head.count, rows.map(\.count).max() ?? 0) }

    public init(head: [String], rows: [[String]]) {
      self.head = head
      self.rows = rows
    }

    /// A table block's cells (`DocumentBlocks.table`).
    public init(content: String) {
      let read = DocumentBlocks.table(content)
      self.init(head: read.head, rows: read.rows)
    }
  }

  public enum Row: Hashable, Sendable {
    /// A block, drawn whole.
    case block(Int)
    /// A part of a long block's words; the first part draws what stands before them (a list's mark, a heading).
    case piece(block: Int, words: String, first: Bool)
    /// A long table, a row at a time: its heading row, then each row.
    case tableHead(block: Int)
    case tableRow(block: Int, row: Int)

    public var block: Int {
      switch self {
      case .block(let index), .piece(let index, _, _), .tableHead(let index), .tableRow(let index, _): return index
      }
    }
  }

  public let blocks: [DocumentBlock]
  public let numbers: [String: Int]
  public let tables: [Int: Table]
  public let rows: [Row]

  public init(text: String, name: String) {
    let blocks = DocumentBlocks.parse(text, frontmatter: DocumentBlocks.stripsFrontmatter(name: name))
    self.blocks = blocks
    numbers = DocumentBlocks.listNumbers(blocks)
    var tables: [Int: Table] = [:]
    var rows: [Row] = []
    for (index, block) in blocks.enumerated() {
      switch block.kind {
      case .table:
        let table = Table(content: block.content)
        tables[index] = table
        if table.rows.count > Self.tableCap {
          rows.append(.tableHead(block: index))
          rows += table.rows.indices.map { .tableRow(block: index, row: $0) }
        } else {
          rows.append(.block(index))
        }
      case .hr:
        rows.append(.block(index))
      default:
        guard block.content.utf8.count > Self.blockCap else {
          rows.append(.block(index))
          continue
        }
        let parts = Self.parts(block.content)
        rows += parts.enumerated().map { .piece(block: index, words: $0.element, first: $0.offset == 0) }
      }
    }
    self.tables = tables
    self.rows = rows
  }

  /// A long block's words in parts of at most `blockCap` bytes, each ending at a line break where one is near.
  static func parts(_ content: String) -> [String] {
    let bytes = Array(content.utf8)
    var parts: [String] = []
    var from = 0
    while from < bytes.count {
      var to = min(bytes.count, from + blockCap)
      if to < bytes.count {
        var at = to
        while at > from + blockCap / 2, bytes[at - 1] != 0x0A { at -= 1 }
        if at > from + blockCap / 2 {
          to = at
        } else {
          at = to
          while at > from + blockCap / 2, bytes[at - 1] != 0x20 { at -= 1 }
          if at > from + blockCap / 2 { to = at } else { while to > from + 1, bytes[to] & 0xC0 == 0x80 { to -= 1 } }
        }
      }
      var end = to
      while end > from, bytes[end - 1] == 0x0A { end -= 1 }
      if end > from { parts.append(String(decoding: bytes[from..<end], as: UTF8.self)) }
      from = to
    }
    return parts
  }
}
