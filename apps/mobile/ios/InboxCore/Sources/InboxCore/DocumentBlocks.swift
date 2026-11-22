import Foundation

/// One block of a Markdown file, as the window splits it (packages/ui/utils/parser.ts `parseMarkdownToBlocks`): the
/// same blocks in the same order with the same ids, so a place in a document on the phone is the same place in the
/// window. Held to the contract's `documents` suite (apps/mobile/contract/vectors/documents.json).
public struct DocumentBlock: Hashable, Sendable, Identifiable {
  public enum Kind: String, Hashable, Sendable {
    case paragraph, heading, blockquote, code, hr, table, directive
    case listItem = "list-item"
  }

  /// `block-0`, `block-1`, …: the window's id for the block.
  public var id: String
  public var kind: Kind
  public var content: String
  /// A heading's level (1 to 6), a list item's depth (0 at the edge).
  public var level: Int?
  public var language: String?
  /// A task box: ticked, not ticked, or no box.
  public var checked: Bool?
  public var ordered: Bool
  /// The number an ordered item was written with.
  public var orderedStart: Int?
  /// `note`, `tip`, `warning`, `caution`, `important`: a quote that is an alert.
  public var alertKind: String?
  public var directiveKind: String?
  /// The line of the file the block starts on, from 1.
  public var startLine: Int

  init(id: Int, _ kind: Kind, _ content: String, line: Int, level: Int? = nil) {
    self.id = "block-\(id)"
    self.kind = kind
    self.content = content
    self.level = level
    ordered = false
    startLine = line
  }
}

public enum DocumentBlocks {
  /// The parts of the window's parser the phone does not have yet: display math, raw HTML blocks and link
  /// reference definitions. A file with one of them still reads (those lines are paragraphs), but its block ids
  /// are not the window's from there on, so nothing may be anchored to them.
  public static func matchesWindow(_ text: String) -> Bool {
    for line in text.components(separatedBy: "\n") {
      let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.hasPrefix("$$") || trimmed.hasPrefix("\\[") { return false }
      if trimmed.firstMatch(of: /^<\/?[A-Za-z!]/) != nil { return false }
      if trimmed.firstMatch(of: /^\[[^\]]+\]:\s*\S/) != nil { return false }
    }
    return true
  }

  /// The block a line of the file is in: the last one that starts at or before it.
  public static func block(onLine line: Int, in blocks: [DocumentBlock]) -> DocumentBlock? {
    guard line >= 1 else { return nil }
    return blocks.last { $0.startLine <= line }
  }

  /// A Markdown file's front matter is not part of what is read (`.md` and `.mdx`, as the window decides it).
  public static func stripsFrontmatter(name: String) -> Bool { name.firstMatch(of: /\.mdx?$/.ignoresCase()) != nil }

  /// The text after the front matter and the line it starts on (packages/core/markdown-structure.ts
  /// `splitFrontmatter`). Counted in UTF-16 units, as the window counts.
  static func afterFrontmatter(_ markdown: String) -> (content: String, startLine: Int) {
    let trimmed = trimStart(markdown) as NSString
    guard trimmed.hasPrefix("---"), trimmed.length > 3 else { return (markdown, 1) }
    let end = trimmed.range(of: "\n---", options: [], range: NSRange(location: 3, length: trimmed.length - 3))
    guard end.location != NSNotFound else { return (markdown, 1) }
    let rest = trimmed.substring(from: end.location + 4)
    let after = trimStart(rest)
    let consumed = ((markdown as NSString).length - trimmed.length) + end.location + 4 + ((rest as NSString).length - (after as NSString).length)
    let before = (markdown as NSString).substring(to: consumed)
    return (after, before.components(separatedBy: "\n").count)
  }

  private static func trimStart(_ text: String) -> String {
    var scalars = Substring(text).unicodeScalars
    while let first = scalars.first, CharacterSet.whitespacesAndNewlines.contains(first) { scalars.removeFirst() }
    return String(scalars)
  }

  private static func trimEnd(_ text: String) -> String {
    var scalars = Substring(text).unicodeScalars
    while let last = scalars.last, CharacterSet.whitespacesAndNewlines.contains(last) { scalars.removeLast() }
    return String(scalars)
  }

  private static func trim(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

  /// How many of `character` a string starts with.
  private static func run(_ text: String, of character: Character) -> Int { text.prefix { $0 == character }.count }

  private static func leadingSpace(_ line: String) -> String {
    String(String.UnicodeScalarView(line.unicodeScalars.prefix { CharacterSet.whitespacesAndNewlines.contains($0) }))
  }

  public static func parse(_ markdown: String, frontmatter: Bool = true) -> [DocumentBlock] {
    let (text, firstLine) = frontmatter ? afterFrontmatter(markdown) : (markdown, 1)
    let lines = text.components(separatedBy: "\n")
    var blocks: [DocumentBlock] = []
    var next = 0
    var buffer: [String] = []
    var bufferLine = firstLine
    var lastBlank = false

    func flush() {
      guard !buffer.isEmpty else { return }
      blocks.append(DocumentBlock(id: next, .paragraph, buffer.joined(separator: "\n"), line: bufferLine, level: 0))
      next += 1
      buffer = []
    }
    func add(_ block: DocumentBlock) {
      blocks.append(block)
      next += 1
    }

    var i = 0
    while i < lines.count {
      defer { i += 1 }
      let line = lines[i]
      let trimmed = trim(line)
      let number = i + firstLine
      let wasBlank = lastBlank
      lastBlank = false

      // A heading: one to six `#`, then a space or the line's end.
      if let heading = trimmed.firstMatch(of: /^(#{1,6})(?:\s|$)/) {
        flush()
        let words = trimStart(String(trimmed.drop { $0 == "#" }))
        add(DocumentBlock(id: next, .heading, words, line: number, level: heading.1.count))
        continue
      }

      if trimmed == "---" || trimmed == "***" {
        flush()
        add(DocumentBlock(id: next, .hr, "", line: number))
        continue
      }

      // A list item: each is a block of its own.
      if let item = trimmed.firstMatch(of: /^(\*|-|(\d+)\.)\s/) {
        flush()
        let spaces = leadingSpace(line).replacingOccurrences(of: "\t", with: "  ").unicodeScalars.count
        var content = String(trimmed[item.range.upperBound...])
        var block = DocumentBlock(id: next, .listItem, "", line: number, level: spaces / 2)
        if let digits = item.2 {
          block.ordered = true
          block.orderedStart = Int(digits)
        }
        if let box = content.firstMatch(of: /^\[([ xX])\]\s*/) {
          block.checked = box.1.lowercased() == "x"
          content = String(content[box.range.upperBound...])
        }
        block.content = content
        add(block)
        continue
      }

      // A run of `>` lines is one quote. A blank line ends it.
      if trimmed.hasPrefix(">") {
        flush()
        var end = i
        while end + 1 < lines.count, trim(lines[end + 1]).hasPrefix(">") { end += 1 }
        let run = Array(lines[i...end])
        i = end
        func inner(_ raw: String) -> String {
          guard let mark = raw.firstMatch(of: /^\s*>[ \t]?/) else { return trimEnd(raw) }
          return trimEnd(String(raw[mark.range.upperBound...]))
        }
        let first = trimStart(String(trimmed.dropFirst()))
        if let alert = first.firstMatch(of: /^\[!(NOTE|TIP|WARNING|CAUTION|IMPORTANT)\]\s*$/.ignoresCase()) {
          var body = ""
          for raw in run.dropFirst() {
            let stripped = inner(raw)
            body = body.isEmpty ? stripped : body + "\n" + stripped
          }
          var block = DocumentBlock(id: next, .blockquote, body, line: number)
          block.alertKind = alert.1.lowercased()
          add(block)
          continue
        }
        let words = run.map(inner)
        var start = 0
        while start < words.count - 1, words[start].isEmpty { start += 1 }
        var last = words.count - 1
        while last > start, words[last].isEmpty { last -= 1 }
        add(DocumentBlock(id: next, .blockquote, words[start...last].joined(separator: "\n"), line: number + start))
        continue
      }

      // A fenced code block: it closes on a fence at least as long as the one that opened it.
      if trimmed.hasPrefix("```") {
        flush()
        let fence = run(trimmed, of: "`")
        let language = trim(String(trimmed.dropFirst(fence)))
        var close = i + 1
        while close < lines.count, run(String(lines[close].drop { $0 == " " || $0 == "\t" }), of: "`") < fence { close += 1 }
        var block = DocumentBlock(id: next, .code, lines[min(i + 1, lines.count)..<close].joined(separator: "\n"), line: number)
        block.language = language.isEmpty ? nil : language
        add(block)
        i = close
        continue
      }

      // A table: the lines that start with `|`, as written.
      if trimmed.hasPrefix("|") {
        flush()
        var rows = [line]
        while i + 1 < lines.count, trim(lines[i + 1]).hasPrefix("|") {
          i += 1
          rows.append(lines[i])
        }
        add(DocumentBlock(id: next, .table, rows.joined(separator: "\n"), line: number))
        continue
      }

      // `:::kind` opens a block, the first bare `:::` closes it.
      if let directive = trimmed.firstMatch(of: /^:::\s*([a-zA-Z][a-zA-Z0-9-]*)\s*$/) {
        flush()
        var close = i + 1
        while close < lines.count, trim(lines[close]) != ":::" { close += 1 }
        var block = DocumentBlock(id: next, .directive, lines[min(i + 1, lines.count)..<close].joined(separator: "\n"), line: number)
        block.directiveKind = directive.1.lowercased()
        add(block)
        i = close
        continue
      }

      if trimmed.isEmpty {
        flush()
        lastBlank = true
        continue
      }

      // An indented line after a list item is more of that item.
      if buffer.isEmpty, let last = blocks.last, last.kind == .listItem {
        let indent = leadingSpace(line).unicodeScalars.count
        if indent >= (wasBlank ? 2 : 1) {
          blocks[blocks.count - 1].content += (wasBlank ? "\n\n" : "\n") + trimmed
          continue
        }
      }

      if buffer.isEmpty { bufferLine = number }
      buffer.append(line)
    }
    flush()
    return blocks
  }

  /// The number each list item shows, or nil for a bullet (packages/ui/utils/parser.ts `computeListIndices`): a
  /// run of ordered items at one depth counts on from the first one's own number.
  public static func listNumbers(_ blocks: [DocumentBlock]) -> [String: Int] {
    var counters: [Int] = []
    var orderedAt: [Bool] = []
    var numbers: [String: Int] = [:]
    for block in blocks {
      guard block.kind == .listItem else {
        counters = []
        orderedAt = []
        continue
      }
      let level = block.level ?? 0
      if counters.count > level + 1 {
        counters = Array(counters.prefix(level + 1))
        orderedAt = Array(orderedAt.prefix(level + 1))
      }
      while counters.count <= level {
        counters.append(0)
        orderedAt.append(false)
      }
      if block.ordered {
        counters[level] = orderedAt[level] ? counters[level] + 1 : block.orderedStart ?? 1
        orderedAt[level] = true
        numbers[block.id] = counters[level]
      } else {
        orderedAt[level] = false
      }
    }
    return numbers
  }

  /// A table's cells: its heading row, then its rows. The line of dashes under the heading is not a row.
  public static func table(_ content: String) -> (head: [String], rows: [[String]]) {
    func cells(_ line: String) -> [String] {
      var inner = trim(line)
      if inner.hasPrefix("|") { inner.removeFirst() }
      if inner.hasSuffix("|"), !inner.hasSuffix("\\|") { inner.removeLast() }
      var out: [String] = []
      var cell = ""
      var escaped = false
      var code = false
      for character in inner {
        if escaped {
          cell.append(character)
          escaped = false
        } else if character == "\\" {
          escaped = true
          cell.append(character)
        } else if character == "`" {
          code.toggle()
          cell.append(character)
        } else if character == "|", !code {
          out.append(trim(cell).replacingOccurrences(of: "\\|", with: "|"))
          cell = ""
        } else {
          cell.append(character)
        }
      }
      out.append(trim(cell).replacingOccurrences(of: "\\|", with: "|"))
      return out
    }
    let lines = content.components(separatedBy: "\n").filter { !trim($0).isEmpty }
    guard let first = lines.first else { return ([], []) }
    let body = lines.dropFirst().filter { line in !cells(line).allSatisfy { $0.wholeMatch(of: /:?-+:?/) != nil } }
    return (cells(first), body.map(cells))
  }
}
