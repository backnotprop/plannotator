import Foundation

/// A message body as the phone draws it natively: markdown blocks, split at
/// the question blocks (`:::question`, `:::question-multi`, `:::question-text`),
/// which the thread draws as native question cards from the question records.
///
/// The splitter follows core's `findQuestionBlocks` where it matters for the
/// split: a `:::` opener inside a code fence or display math is not a question,
/// and a directive runs to the next line that is only `:::`. Blocks the phone
/// does not draw natively (a table, a diagram fence, display math, raw HTML)
/// come out as `.rich` and are drawn as a row.
public enum MessageBlock: Hashable, Sendable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case list([ListItem])
    case quote(String)
    case code(language: String?, text: String)
    case rule
    /// The n-th question block of the body (0-based), in body order.
    case question(index: Int)
    case rich(RichKind)

    public enum RichKind: String, Hashable, Sendable {
        case table, diagram, math, html
    }

    public struct ListItem: Hashable, Sendable {
        /// "•" for a bullet, "1." for a numbered item.
        public var marker: String
        public var depth: Int
        public var text: String
    }

    static let questionKinds: Set<String> = ["question", "question-multi", "question-text"]
    static let diagramLanguages: Set<String> = ["mermaid", "dot", "graphviz"]

    public static func parse(_ markdown: String) -> [MessageBlock] {
        let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var blocks: [MessageBlock] = []
        var questions = 0
        var paragraph: [String] = []
        var i = 0

        func flushParagraph() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: " "))) }
            paragraph = []
        }

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty {
                flushParagraph()
                i += 1
                continue
            }

            // Code fences: a diagram fence is rich, any other is code.
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flushParagraph()
                let fence = String(trimmed.prefix(3))
                let language = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces).lowercased()
                var body: [String] = []
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
                    body.append(lines[i])
                    i += 1
                }
                i += 1
                if diagramLanguages.contains(language) {
                    blocks.append(.rich(.diagram))
                } else {
                    blocks.append(.code(language: language.isEmpty ? nil : language, text: body.joined(separator: "\n")))
                }
                continue
            }

            // Display math.
            if trimmed.hasPrefix("$$") || trimmed.hasPrefix("\\[") {
                flushParagraph()
                let close = trimmed.hasPrefix("$$") ? "$$" : "\\]"
                let rest = trimmed.dropFirst(2)
                if !rest.contains(close) {
                    i += 1
                    while i < lines.count, !lines[i].contains(close) { i += 1 }
                }
                i += 1
                blocks.append(.rich(.math))
                continue
            }

            // Directives: a question block becomes a card; any other is read as a quote.
            if let kind = directiveKind(trimmed) {
                flushParagraph()
                var body: [String] = []
                i += 1
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces) != ":::" {
                    body.append(lines[i])
                    i += 1
                }
                i += 1
                if questionKinds.contains(kind) {
                    blocks.append(.question(index: questions))
                    questions += 1
                } else {
                    let text = body.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: " ")
                    if !text.isEmpty { blocks.append(.quote(text)) }
                }
                continue
            }

            if let heading = heading(trimmed) {
                flushParagraph()
                blocks.append(heading)
                i += 1
                continue
            }

            if isRule(trimmed) {
                flushParagraph()
                blocks.append(.rule)
                i += 1
                continue
            }

            // A table: a pipe row followed by its separator row.
            if trimmed.hasPrefix("|"), i + 1 < lines.count, isTableSeparator(lines[i + 1]) {
                flushParagraph()
                while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") { i += 1 }
                blocks.append(.rich(.table))
                continue
            }

            // Raw HTML runs to the next blank line.
            if paragraph.isEmpty, isHTMLStart(trimmed) {
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).isEmpty { i += 1 }
                blocks.append(.rich(.html))
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph()
                var quoted: [String] = []
                while i < lines.count {
                    let t = lines[i].trimmingCharacters(in: .whitespaces)
                    guard t.hasPrefix(">") else { break }
                    quoted.append(String(t.dropFirst()).trimmingCharacters(in: .whitespaces))
                    i += 1
                }
                blocks.append(.quote(quoted.filter { !$0.isEmpty }.joined(separator: " ")))
                continue
            }

            if listItem(line) != nil {
                flushParagraph()
                var items: [ListItem] = []
                while i < lines.count {
                    if let item = listItem(lines[i]) {
                        items.append(item)
                    } else if !items.isEmpty, lines[i].hasPrefix("  "), !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                        items[items.count - 1].text += " " + lines[i].trimmingCharacters(in: .whitespaces)
                    } else {
                        break
                    }
                    i += 1
                }
                blocks.append(.list(items))
                continue
            }

            paragraph.append(trimmed)
            i += 1
        }
        flushParagraph()
        return blocks
    }

    static func directiveKind(_ trimmed: String) -> String? {
        guard trimmed.hasPrefix(":::") else { return nil }
        let name = trimmed.dropFirst(3).trimmingCharacters(in: .whitespaces)
        guard let first = name.first, first.isASCII, first.isLetter,
              name.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }) else { return nil }
        return name.lowercased()
    }

    static func heading(_ trimmed: String) -> MessageBlock? {
        let hashes = trimmed.prefix(while: { $0 == "#" }).count
        guard (1...6).contains(hashes) else { return nil }
        let rest = trimmed.dropFirst(hashes)
        guard rest.isEmpty || rest.first == " " else { return nil }
        let text = rest.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"\s+#+$"#, with: "", options: .regularExpression)
        return .heading(level: hashes, text: text)
    }

    static func isRule(_ trimmed: String) -> Bool {
        let compact = trimmed.replacingOccurrences(of: " ", with: "")
        guard compact.count >= 3, let first = compact.first, "-*_".contains(first) else { return false }
        return compact.allSatisfy { $0 == first }
    }

    static func isTableSeparator(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        return t.hasPrefix("|") && t.contains("-") && t.allSatisfy { "|-: ".contains($0) }
    }

    static func isHTMLStart(_ trimmed: String) -> Bool {
        guard trimmed.hasPrefix("<"), trimmed.count > 1 else { return false }
        let next = trimmed[trimmed.index(after: trimmed.startIndex)]
        return next.isLetter || next == "!" || next == "/"
    }

    static func listItem(_ line: String) -> ListItem? {
        let indent = line.prefix(while: { $0 == " " }).count
        let rest = line.dropFirst(indent)
        if let first = rest.first, "-*+".contains(first), rest.dropFirst().first == " " {
            let text = rest.dropFirst(2).trimmingCharacters(in: .whitespaces)
            return ListItem(marker: "•", depth: indent / 2, text: text)
        }
        let digits = rest.prefix(while: \.isNumber)
        guard !digits.isEmpty, digits.count <= 9 else { return nil }
        let after = rest.dropFirst(digits.count)
        guard let mark = after.first, mark == "." || mark == ")", after.dropFirst().first == " " else { return nil }
        return ListItem(marker: "\(digits).", depth: indent / 2, text: after.dropFirst(2).trimmingCharacters(in: .whitespaces))
    }
}
