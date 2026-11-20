import Foundation
import InboxWire

/// A file as the feedback names it.
public struct FeedbackFile: Hashable, Sendable {
  public var id: String
  /// Where it is on the computer.
  public var path: String
  public var name: String
  /// The kind the computer stored (`markdown`, `text`, `code`, `image`, `html`, …).
  public var kind: String
  /// A picture a message's words show, not a file attached beside them.
  public var inline: Bool

  public init(id: String, path: String, name: String, kind: String, inline: Bool = false) {
    self.id = id
    self.path = path
    self.name = name
    self.kind = kind
    self.inline = inline
  }
}

/// The text a Send carries for the person's comments on attached files: "# Feedback on the attached files", one
/// section per file and version, each comment with its line, its quote and its words.
///
/// The window builds this text in the browser (packages/inbox/attachments.ts `attachmentFeedback`, over
/// packages/ui/utils/parser.ts `exportLinkedDocAnnotations`), and nothing on the computer builds it for a phone.
/// The phone builds it here, so a Send made while the computer is away already holds its final words. It is held to
/// the window's, byte for byte, by the contract's `feedback` suite (apps/mobile/contract/vectors/feedback.json,
/// made by running the window's own functions): a change to the window's text turns that suite red, never the
/// agent's reading.
///
/// It writes only what `carries` says it can write exactly as the window does. Any other comment stays on the
/// computer for the window's own Send.
public enum FileFeedback {
  /// The kinds whose comments the phone writes: a document, plain text, code, a picture and a page.
  static let kinds: Set<String> = ["markdown", "text", "code", "image", "html"]

  /// The fields of an annotation that change what the window writes in ways this does not: a quick label, a reply
  /// to another comment, a region of a picture inside a document, a diagram's part, a moment, an answer to a
  /// question in the file, a running app's page, several elements, a tag of an agent, a comment made in a diff.
  static let foreign = ["isQuickLabel", "inReplyTo", "imageRegion", "diagramAnchor", "inboxVideo", "questionAnswer", "pageUrl", "htmlAdditionalTargets", "mentions", "diffContext", "source", "exportLocation"]

  /// Whether this writes a comment exactly as the window would. `text`: the text of the file's version the comment
  /// is on, when the phone has it (a comment in a document names its block, whose line is read from the text).
  public static func carries(_ comment: FileComment, file: FeedbackFile?, text: String?) -> Bool {
    guard let file, !file.inline, kinds.contains(file.kind) else { return false }
    let fields = comment.annotation
    for key in foreign where present(fields[key]) { return false }
    guard case .string(let type)? = fields["type"], ["COMMENT", "DELETION", "GLOBAL_COMMENT"].contains(type) else { return false }
    guard case .string? = fields["text"], case .string? = fields["originalText"], case .number? = fields["startOffset"] else { return false }
    if let images = fields["images"], present(images) {
      // A drawing kept on the computer goes by its path. A picture or a file added to a comment is an upload that
      // rides the reply as an attachment: the window's Send does that.
      guard case .array(let list) = images else { return false }
      for image in list {
        guard case .object(let entry) = image, case .string(let path)? = entry["path"], case .string? = entry["name"], !present(entry["kind"]), !isCommentPicture(path) else { return false }
      }
    }
    switch fields["blockId"] {
    case .string(let block)?:
      // A place in a document: only where the phone splits the file into the window's own blocks.
      if needsBlocks(file: file, block: block, comment: comment) {
        guard let text, DocumentBlocks.matchesWindow(text) else { return false }
      }
    default: return false
    }
    return true
  }

  /// A comment that names a block of a document, so its line comes from the file's text.
  static func needsBlocks(file: FeedbackFile, block: String, comment: FileComment) -> Bool {
    (file.kind == "markdown" || file.kind == "text") && !block.isEmpty && comment.codeRange == nil
  }

  private static func present(_ value: JSONValue?) -> Bool {
    switch value {
    case nil, .null?, .bool(false)?: return false
    case .string(let text)?: return !text.isEmpty
    case .array(let items)?: return !items.isEmpty
    default: return true
    }
  }

  /// `inboxCommentPicture` (packages/core/inbox-attachments.ts): a picture added to a comment, `upl_…/<file>`.
  static func isCommentPicture(_ path: String) -> Bool { path.firstMatch(of: /^upl_[A-Za-z0-9]+\//.matchingSemantics(.unicodeScalar)) != nil }

  /// `attachmentLabel` (packages/inbox/attachments.ts): the file's path in its project, else where it is.
  public static func label(_ file: FeedbackFile, projectRoot: String) -> String {
    var root = Substring(projectRoot)
    while let last = root.last, last == "/" || last == "\\" { root.removeLast() }
    if file.path.hasPrefix("\(root)/") || file.path.hasPrefix("\(root)\\") { return String(file.path.dropFirst(root.count + 1)) }
    return file.path.isEmpty ? file.name : file.path
  }

  private struct Block {
    var id: String
    var startLine: Int
    var endLine: Int
  }

  /// `blockEndLine` (packages/ui/utils/parser.ts): the last line a block covers.
  static func endLine(_ block: DocumentBlock) -> Int {
    if block.content.isEmpty { return block.startLine }
    // Counted as JavaScript splits: at every line feed, a CRLF's too.
    let lines = block.content.unicodeScalars.filter { $0 == "\n" }.count + 1
    if block.kind == .code || block.kind == .directive { return block.startLine + lines + 1 }
    if block.alertKind != nil { return block.startLine + lines }
    return block.startLine + lines - 1
  }

  /// The text for `comments` (in the order made), or "" when there are none. Every comment given must be one
  /// `carries` accepts. `texts`: each file version's text, keyed by `textKey`. `prototypes`: what names a page a
  /// question shows as a prototype, by file (`PrototypeNames`): its section is filed under it.
  public static func text(_ comments: [FileComment], files: [FeedbackFile], texts: [String: String], projectRoot: String, prototypes: [String: String] = [:]) -> String {
    struct Group {
      var label: String
      var comments: [FileComment] = []
      var blocks: [Block] = []
    }
    var groups: [Group] = []
    for comment in comments {
      guard let file = files.first(where: { $0.id == comment.attachment.rawValue }) else { continue }
      let named = "\(label(file, projectRoot: projectRoot))\(comment.version == FileComment.current ? "" : Words.feedbackSentYours)"
      let label = prototypes[file.id].map { "\($0): \(named)" } ?? named
      let at: Int
      if let found = groups.firstIndex(where: { $0.label == label }) {
        at = found
      } else {
        var group = Group(label: label)
        // A document's blocks, by the window's ids (code names its own lines; a picture and a page have none).
        if file.kind == "markdown" || file.kind == "text", let text = texts[textKey(comment.attachment, comment.version)] {
          group.blocks = DocumentBlocks.parse(text, frontmatter: DocumentBlocks.stripsFrontmatter(name: file.name)).map { Block(id: $0.id, startLine: $0.startLine, endLine: endLine($0)) }
        }
        groups.append(group)
        at = groups.count - 1
      }
      groups[at].comments.append(comment)
    }
    guard !groups.isEmpty else { return "" }
    var out = "# \(Words.feedbackFilesTitle)\n\n\(Words.feedbackFilesIntro)\n\n"
    for index in groups.indices {
      // One block per line comment's lines, after the document's own (`codeCommentBlocks`).
      for comment in groups[index].comments {
        guard let range = comment.codeRange, let block = comment.blockId, !groups[index].blocks.contains(where: { $0.id == block }) else { continue }
        groups[index].blocks.append(Block(id: block, startLine: range.lineStart, endLine: range.lineEnd))
      }
      let group = groups[index]
      let place = Dictionary(group.blocks.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
      // The document's order: by block, then by where in it; comments on no block keep the order made.
      let sorted = group.comments.enumerated().sorted { a, b in
        let blockA = place[a.element.blockId ?? ""] ?? -1
        let blockB = place[b.element.blockId ?? ""] ?? -1
        if blockA != blockB { return blockA < blockB }
        if a.element.startOffset != b.element.startOffset { return a.element.startOffset < b.element.startOffset }
        return a.offset < b.offset
      }.map(\.element)
      out += "## \(group.label)\n\n"
      out += "I've reviewed this document and have \(sorted.count) piece\(sorted.count == 1 ? "" : "s") of feedback:\n\n"
      for (number, comment) in sorted.enumerated() { out += entry(comment, number: number + 1, blocks: group.blocks) }
    }
    return out + "---"
  }

  public static func textKey(_ attachment: AttachmentID, _ version: String) -> String { "\(attachment.rawValue)|\(version)" }

  /// One comment (`renderAnnotationEntries`, at the level of a file's section).
  private static func entry(_ comment: FileComment, number: Int, blocks: [Block]) -> String {
    var out = "### \(number). "
    if comment.type != "GLOBAL_COMMENT", let id = comment.blockId, !id.isEmpty, let block = blocks.first(where: { $0.id == id }) {
      out += block.endLine <= block.startLine ? "(line \(block.startLine)) " : "(lines \(block.startLine)–\(block.endLine)) "
    }
    if comment.type == "DELETION" {
      out += "Remove this\n```\n\(comment.quote)\n```\n> I don't want this in the document.\n"
    } else if comment.type == "GLOBAL_COMMENT" {
      // On the whole file (a document's Global comment, a page's own comment): no line, no quote.
      out += "General feedback about the document\n> \(comment.words)\n"
    } else {
      out += "\(element(comment).map { "Feedback on \($0)" } ?? "Feedback on: \"\(comment.quote)\"")\n> \(comment.words)\n"
    }
    out += elementBlock(comment)
    let images = comment.images
    if !images.isEmpty { out += "**Attached images:**\n" + images.map { "- [\($0.name)] `\($0.path)`\n" }.joined() }
    return out + "\n"
  }

  // MARK: A page's element (packages/ui/utils/parser.ts `elementContextExportBlock`)

  /// `safeInline`: a page's own words on one line, with no run of backticks, cut to `max` (counted as the window
  /// counts, in UTF-16 units).
  static func safeInline(_ value: JSONValue?, _ max: Int = 200) -> String {
    guard case .string(let text)? = value else { return "" }
    let collapsed = collapse(text)
    let defused = collapsed.replacing(/`+/.matchingSemantics(.unicodeScalar), with: "'") as NSString
    return defused.length > max ? "\(defused.substring(to: max))…" : defused as String
  }

  /// What JavaScript's `\s` matches.
  static func isSpace(_ scalar: Unicode.Scalar) -> Bool {
    switch scalar.value {
    case 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF: return true
    default: return false
    }
  }

  /// Runs of white space as one space, none at the ends.
  static func collapse(_ text: String) -> String {
    var out = String.UnicodeScalarView()
    var gap = false
    for scalar in text.unicodeScalars {
      if isSpace(scalar) {
        gap = !out.isEmpty
      } else {
        if gap { out.append(" ") }
        gap = false
        out.append(scalar)
      }
    }
    return String(out)
  }

  private static func truthy(_ value: JSONValue?) -> Bool {
    switch value {
    case nil, .null?, .bool(false)?: return false
    case .string(let text)?: return !text.isEmpty
    case .number(let number)?: return number != 0 && !number.isNaN
    default: return true
    }
  }

  private static func context(_ comment: FileComment) -> [String: JSONValue]? {
    guard case .object(let context)? = comment.annotation["elementContext"], case .string? = context["tag"] else { return nil }
    return context
  }

  /// "the <nav> element — "Primary"": an element with no words of its own, named by what it is (`elementSubject`).
  private static func element(_ comment: FileComment) -> String? {
    guard let context = context(comment), trim(comment.quote).wholeMatch(of: /\[element: [^\]]*\]/.matchingSemantics(.unicodeScalar)) != nil else { return nil }
    let tag = safeInline(context["tag"], 32)
    let name = truthy(context["name"]) ? safeInline(context["name"], 120) : ""
    let file = sourceFile(context)
    return "the <\(tag)> element\(name.isEmpty ? "" : " — \"\(name)\"")\(!file.isEmpty && file != name ? " (\(file))" : "")"
  }

  static func trim(_ text: String) -> String {
    var scalars = Substring(text).unicodeScalars
    while let first = scalars.first, isSpace(first) { scalars.removeFirst() }
    while let last = scalars.last, isSpace(last) { scalars.removeLast() }
    return String(scalars)
  }

  /// The file a picture or a film on the page shows (`elementSourceFileName`).
  private static func sourceFile(_ context: [String: JSONValue]) -> String {
    if case .string(let named)? = context["sourceName"], !trim(named).isEmpty { return safeInline(.string(named), 60) }
    guard case .array(let attrs)? = context["attrs"] else { return "" }
    for pair in attrs {
      guard case .array(let both) = pair, both.count >= 2, case .string("src") = both[0], case .string(let raw) = both[1] else { continue }
      let value = trim(raw)
      if String(String.UnicodeScalarView(value.unicodeScalars.prefix(5))).lowercased() == "data:" {
        let kind = String(String.UnicodeScalarView(value.unicodeScalars.dropFirst(5).prefix { $0 != ";" && $0 != "," }))
        return safeInline(.string("data:\(kind.isEmpty ? "unknown" : kind)"), 60)
      }
      let path = value.replacing(/\?…$/.matchingSemantics(.unicodeScalar), with: "").replacing(/\/+$/.matchingSemantics(.unicodeScalar), with: "")
      let name = String(String.UnicodeScalarView(path.unicodeScalars.reversed().prefix { $0 != "/" }.reversed()))
      return safeInline(.string(name.isEmpty ? path : name), 60)
    }
    return ""
  }

  /// A number as JavaScript prints it in a template.
  static func number(_ value: Double) -> String {
    if value == value.rounded(), abs(value) < 1e15 { return String(Int64(value)) }
    return "\(value)"
  }

  private static func elementBlock(_ comment: FileComment) -> String {
    guard let context = context(comment) else { return "" }
    let fields = comment.annotation
    var block = ""
    if case .string(let raw)? = context["outline"], !trim(raw).isEmpty {
      block += "\n````html\n\(trim(raw.replacing(/`{3,}/.matchingSemantics(.unicodeScalar), with: "'''")))\n````\n"
    } else {
      block += "\n"
    }
    if case .object(let anchor)? = fields["htmlAnchor"], case .string(let selector)? = anchor["selector"], !selector.isEmpty { block += "- **selector** `\(safeInline(.string(selector), 300))`\n" }
    if truthy(context["path"]) { block += "- **path** `\(safeInline(context["path"], 512))`\n" }
    var identity: [String] = []
    if truthy(context["role"]) { identity.append("**role** \(safeInline(context["role"], 32))") }
    if truthy(context["name"]) { identity.append("**name** \"\(safeInline(context["name"], 120))\"") }
    if truthy(context["component"]) { identity.append("**component** `\(safeInline(context["component"], 100))`") }
    if !identity.isEmpty { block += "- \(identity.joined(separator: " · "))\n" }
    if case .array(let attrs)? = context["attrs"], !attrs.isEmpty {
      let pairs = attrs.compactMap { pair -> String? in
        guard case .array(let both) = pair, both.count == 2 else { return nil }
        return "\(safeInline(both[0], 40))=\"\(safeInline(both[1], 120))\""
      }.joined(separator: " ")
      if !pairs.isEmpty { block += "- **attrs** `\(pairs.replacingOccurrences(of: "`", with: "'", options: .literal))`\n" }
    }
    if truthy(context["text"]) { block += "- **text** \"\(safeInline(context["text"], 300))\"\n" }
    if case .object(let rect)? = context["rect"] {
      let sides = ["x", "y", "w", "h", "vw", "vh"].compactMap { key -> Double? in
        if case .number(let value)? = rect[key], value.isFinite { return value }
        return nil
      }
      if sides.count == 6 { block += "- **box** \(number(sides[0])),\(number(sides[1])) \(number(sides[2]))×\(number(sides[3])) (viewport \(number(sides[4]))×\(number(sides[5])))\n" }
    }
    var near: [String] = []
    if truthy(context["landmark"]) { near.append(safeInline(context["landmark"], 80)) }
    if truthy(context["heading"]) { near.append("heading \(safeInline(context["heading"], 130))") }
    if !near.isEmpty { block += "- **near** \(near.joined(separator: " · "))\n" }
    return block
  }
}
