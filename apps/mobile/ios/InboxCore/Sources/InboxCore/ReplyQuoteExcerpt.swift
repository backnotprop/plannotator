import Foundation

/// What a whole message is quoted as in a reply's lead (`inboxReplyQuoteExcerpt`, packages/core/inbox-reply-quote.ts):
/// its first words as plain text (code fences, question blocks, tables and markup left out; a person's reply, its own
/// words), cut at a word near 280 characters. Held to the product by vectors/quote.json `excerpts`.
extension ReplyQuoteRules {
  /// About how many characters of a whole message a quote carries (`INBOX_REPLY_QUOTE_EXCERPT_MAX`).
  static let excerptMax = 280

  public static func excerpt(person: Bool, body: String) -> String {
    let text = person ? replyWords(body) : body
    return Excerpt.cutAtWord(Excerpt.collapse(Excerpt.firstWords(text, max: excerptMax * 2)), excerptMax)
  }

  /// A person's reply without what the store wrote around their words (`replyWords`, packages/core/inbox-folding.ts):
  /// the answers and what follows them, the store's first line, and a quote's lead.
  static func replyWords(_ body: String) -> String {
    let lines = body.components(separatedBy: "\n").map { $0.hasSuffix("\r") ? String($0.dropLast()) : $0 }
    let at = lines.firstIndex { line in
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      return Excerpt.matches(Excerpt.answersHeading, trimmed) || Excerpt.matches(Excerpt.stillOpen, trimmed)
    }
    let kept = (at.map { Array(lines[..<$0]) } ?? lines).joined(separator: "\n")
    return withoutLead(Excerpt.replace(Excerpt.answeredFirst, in: kept, with: ""))
  }
}

/// The text rules `inboxReplyQuoteExcerpt` is made of (packages/core/inbox-folding.ts, inline-markdown.ts), in
/// UTF-16 as JavaScript counts.
enum Excerpt {
  static func regex(_ pattern: String) -> NSRegularExpression {
    // Literal patterns: they compile.
    try! NSRegularExpression(pattern: pattern)
  }

  static func matches(_ regex: NSRegularExpression, _ text: String) -> Bool {
    regex.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)) != nil
  }

  static func replace(_ regex: NSRegularExpression, in text: String, with template: String) -> String {
    regex.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
  }

  /// Runs of whitespace as one space, trimmed.
  static func collapse(_ text: String) -> String {
    replace(whitespace, in: text, with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
  }

  nonisolated(unsafe) static let whitespace = regex("\\s+")
  nonisolated(unsafe) static let answersHeading = regex("^#{1,6}\\s+Answers to your questions\\s*$")
  nonisolated(unsafe) static let stillOpen = regex(
    "^(?:(?:No questions? answered yet|No new answers in this reply); .* still open\\. Don't re-ask (?:it|them); the person will answer in the Inbox\\.|You have \\d+ other questions? open in this thread\\. (?:It stays|They stay) open; the person will answer (?:it|them) in the Inbox\\. Don't re-ask (?:it|them)\\.)$")
  nonisolated(unsafe) static let answeredFirst = regex("^\\s*(?:Answered \\d+ questions?(?:, skipped \\d+)?|Skipped \\d+ questions?)\\.\\s*")

  /// `cutAtWord`: cut at a word near `max` characters, with "…".
  static func cutAtWord(_ text: String, _ max: Int) -> String {
    let units = Array(text.utf16)
    guard units.count > max else { return text }
    let head = String(decoding: units.prefix(max + 1), as: UTF16.self)
    let space = head.utf16.lastIndex(of: 0x20).map { head.utf16.distance(from: head.utf16.startIndex, to: $0) } ?? -1
    let cut = Double(space) > Double(max) * 0.5 ? String(decoding: units.prefix(space), as: UTF16.self) : String(decoding: units.prefix(max), as: UTF16.self)
    return replace(trailingMarks, in: cut, with: "") + "…"
  }

  nonisolated(unsafe) static let trailingMarks = regex("[\\s,;:.]+$")

  /// `firstWords`: the first words of markdown as plain text, cut at a word near `max` characters.
  static func firstWords(_ markdown: String, max: Int) -> String {
    var lines: [String] = []
    var fence: String?
    var directive = 0
    for raw in markdown.components(separatedBy: "\n") {
      let line = (raw.hasSuffix("\r") ? String(raw.dropLast()) : raw).trimmingCharacters(in: .whitespaces)
      if let open = fence {
        if line.hasPrefix(open) { fence = nil }
        continue
      }
      if let opened = fenceOpen.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)), let range = Range(opened.range(at: 1), in: line) {
        fence = String(line[range])
        continue
      }
      if matches(directiveOpen, line) {
        directive += 1
        continue
      }
      if matches(directiveClose, line) {
        if directive > 0 { directive -= 1 }
        continue
      }
      if directive > 0 { continue }
      if line.hasPrefix("|") || matches(rule, line) || matches(htmlLine, line) { continue }
      lines.append(replace(quoteMark, in: replace(listMark, in: replace(headingMark, in: line, with: ""), with: ""), with: ""))
    }
    return cutAtWord(collapse(cleanInline(lines.joined(separator: " "))), max)
  }

  nonisolated(unsafe) static let fenceOpen = regex("^(`{3,}|~{3,})")
  nonisolated(unsafe) static let directiveOpen = regex("^:{3,}\\s*[A-Za-z]")
  nonisolated(unsafe) static let directiveClose = regex("^:{3,}\\s*$")
  nonisolated(unsafe) static let rule = regex("^[-*_]{3,}$")
  nonisolated(unsafe) static let htmlLine = regex("^</?[A-Za-z][^>]*>$")
  nonisolated(unsafe) static let headingMark = regex("^#{1,6}\\s+")
  nonisolated(unsafe) static let listMark = regex("^(?:[-*+]|\\d+[.)])\\s+(?:\\[[ xX]\\]\\s+)?")
  nonisolated(unsafe) static let quoteMark = regex("^>\\s?")

  /// `cleanInline`: inline markdown as plain words (code spans kept as their text, escapes as their character).
  static func cleanInline(_ text: String) -> String {
    var code: [String] = []
    var out = substitute(codeSpan, in: text) { match, string in
      let inner = Range(match.range(at: 2), in: string).map { String(string[$0]) } ?? ""
      code.append(inner.trimmingCharacters(in: .whitespacesAndNewlines))
      return "\u{0000}\(code.count - 1)\u{0000}"
    }
    var escaped: [String] = []
    out = substitute(escape, in: out) { match, string in
      escaped.append(Range(match.range(at: 1), in: string).map { String(string[$0]) } ?? "")
      return "\u{0001}\(escaped.count - 1)\u{0001}"
    }
    out = replace(link, in: replace(image, in: out, with: ""), with: "$1")
    // `[[target|label]]` reads as its label, `[[target]]` as its target.
    out = substitute(wikiLink, in: out) { match, string in
      (Range(match.range(at: 2), in: string) ?? Range(match.range(at: 1), in: string)).map { String(string[$0]) } ?? ""
    }
    out = replace(htmlTag, in: out, with: "")
    for pair in emphasis { out = replace(pair, in: out, with: "$1$2") }
    out = substitute(escapedMark, in: out) { match, string in
      Range(match.range(at: 1), in: string).flatMap { Int(string[$0]) }.flatMap { escaped.indices.contains($0) ? escaped[$0] : nil } ?? ""
    }
    return substitute(codeMark, in: out) { match, string in
      Range(match.range(at: 1), in: string).flatMap { Int(string[$0]) }.flatMap { code.indices.contains($0) ? code[$0] : nil } ?? ""
    }
  }

  static func substitute(_ regex: NSRegularExpression, in text: String, _ make: (NSTextCheckingResult, String) -> String) -> String {
    let found = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
    var out = ""
    var last = text.startIndex
    for match in found {
      guard let range = Range(match.range, in: text) else { continue }
      out += text[last..<range.lowerBound]
      out += make(match, text)
      last = range.upperBound
    }
    return out + text[last...]
  }

  static let destination = "\\((?:[^()]|\\([^()]*\\))*\\)"
  nonisolated(unsafe) static let codeSpan = regex("(`+)([^`]|[^`][\\s\\S]*?[^`])\\1(?!`)")
  nonisolated(unsafe) static let escape = regex("\\\\([\\\\*_`\\[\\]~!.()\\-#>+|{}&$])")
  nonisolated(unsafe) static let image = regex("!\\[[^\\]\\[]*\\]" + destination)
  nonisolated(unsafe) static let link = regex("\\[((?:[^\\]\\[]|\\[[^\\]\\[]*\\])*)\\]" + destination)
  nonisolated(unsafe) static let wikiLink = regex("\\[\\[([^\\]\\[|]*)(?:\\|([^\\]\\[]*))?\\]\\]")
  nonisolated(unsafe) static let htmlTag = regex("</?[A-Za-z][^<>]*>")
  nonisolated(unsafe) static let escapedMark = regex("\\u0001(\\d+)\\u0001")
  nonisolated(unsafe) static let codeMark = regex("\\u0000(\\d+)\\u0000")
  nonisolated(unsafe) static let emphasis: [NSRegularExpression] = ["\\*\\*", "__", "~~", "\\*", "_"].map { mark in
    regex("(^|[^\\w*~])\(mark)(?=\\S)([\\s\\S]*?\\S)\(mark)(?=$|\\s|[,;:!?)\\]\"'’]|\\.(?!\\w))")
  }
}
