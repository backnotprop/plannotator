import Foundation
import InboxWire

/// One comment of the person's on a file, kept until it rides a Send: Plannotator's annotation, as the window's
/// viewers make it (packages/ui/types.ts `Annotation`), with the file and the version it is on.
public struct FileComment: Codable, Hashable, Sendable, Identifiable {
  /// `INBOX_ANNOTATION_CURRENT`: the file as it is on the computer now. Any other version is the sent one's sha256.
  public static let current = "current"
  /// The type of a comment on the whole file (the window's `GLOBAL_COMMENT`).
  public static let whole = "GLOBAL_COMMENT"

  /// The annotation's own id.
  public var id: String
  public var thread: ThreadID
  public var attachment: AttachmentID
  public var version: String
  public var annotation: [String: JSONValue]
  /// When it was made (the computer's stamp once it has the comment): the order of the list.
  public var createdAt: String
  /// The computer has it (it answered the save, or the comment was read from it).
  public var saved: Bool
  /// What the person drew on a picture for this comment, in the picture's own pixels. The phone's own: the
  /// computer gets the drawing flattened onto the picture, as the window sends it, never these.
  public var marks: [PictureMark]?

  public init(id: String, thread: ThreadID, attachment: AttachmentID, version: String, annotation: [String: JSONValue], createdAt: String, saved: Bool = false) {
    self.id = id
    self.thread = thread
    self.attachment = attachment
    self.version = version
    self.annotation = annotation
    self.createdAt = createdAt
    self.saved = saved
  }

  private func string(_ key: String) -> String? {
    if case .string(let text)? = annotation[key] { return text }
    return nil
  }

  /// The person's words.
  public var words: String { string("text") ?? "" }
  /// What the comment is on: the words selected, a line's start, a picture's name, an element's words.
  public var quote: String { string("originalText") ?? "" }
  public var blockId: String? { string("blockId") }
  public var type: String { string("type") ?? "" }
  public var startOffset: Double {
    if case .number(let number)? = annotation["startOffset"] { return number }
    return 0
  }

  /// The lines a code comment is on (`codeRangeOf`), or nil for any other comment.
  public var codeRange: CodeRange? {
    guard case .object(let range)? = annotation["inboxCode"], case .number(let start)? = range["lineStart"], case .number(let end)? = range["lineEnd"] else { return nil }
    guard start == start.rounded(), end == end.rounded(), start >= 1, end >= start, start < 1e9, end < 1e9 else { return nil }
    var code = ""
    if case .string(let text)? = range["code"] { code = text }
    return CodeRange(lineStart: Int(start), lineEnd: Int(end), code: code)
  }

  public struct CodeRange: Hashable, Sendable {
    public var lineStart: Int
    public var lineEnd: Int
    public var code: String
  }

  public struct Picture: Hashable, Sendable {
    public var path: String
    public var name: String
  }

  /// The pictures a comment carries: on a picture, the person's drawing over it.
  public var images: [Picture] {
    guard case .array(let list)? = annotation["images"] else { return [] }
    return list.compactMap { image in
      guard case .object(let entry) = image, case .string(let path)? = entry["path"], case .string(let name)? = entry["name"] else { return nil }
      return Picture(path: path, name: name)
    }
  }

  /// A comment that is only a drawing (`isWordlessMarkup`, packages/inbox/markup.ts): its words are the stand-in.
  public var isWordlessMarkup: Bool {
    guard !images.isEmpty else { return false }
    let text = words.trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty || text == Words.markupOnly
  }

  /// The element a pin is on, as the page named it (`elementContext.tag`).
  public var elementTag: String? {
    guard case .object(let context)? = annotation["elementContext"], case .string(let tag)? = context["tag"] else { return nil }
    return tag
  }

  /// Where a pin was dropped on its page, in the page's own points (the phone's own field: the window finds a pin
  /// again by its `htmlAnchor`).
  public var pinPoint: (x: Double, y: Double)? {
    guard case .object(let anchor)? = annotation["htmlAnchor"], case .object(let point)? = anchor["point"], case .number(let x)? = point["x"], case .number(let y)? = point["y"] else { return nil }
    return (x, y)
  }

  /// The same comment with other words.
  public func with(words: String) -> FileComment {
    var copy = self
    copy.annotation["text"] = .string(words)
    return copy
  }
}

/// A mark the person made on a picture: a pin on a spot, or a line drawn. Its points are places in the picture's own
/// pixels, so it stays on the same part of the picture however the picture is looked into.
public struct PictureMark: Codable, Hashable, Sendable {
  public enum Kind: String, Codable, Sendable { case pin, stroke }

  public var kind: Kind
  /// x and y in turn: a pin's one point, a stroke's points in the order drawn.
  public var points: [Double]
  /// A stroke's width, a pin's radius, in the picture's pixels.
  public var size: Double

  public init(kind: Kind, points: [Double], size: Double) {
    self.kind = kind
    self.points = points
    self.size = size
  }

  /// A stroke's width in the picture's pixels, drawn while the picture is shown at `zoom` points per pixel: about
  /// three and a half points under the finger, and never so thin that it is lost when the picture is whole
  /// (a five-hundredth of its longer side).
  public static func strokeSize(zoom: Double, longest: Double) -> Double { max(3.5 / max(zoom, 0.0001), longest / 500) }

  /// A pin's radius in the picture's pixels, by the same rule: thirteen points under the finger, and at least a
  /// seventieth of the picture's longer side.
  public static func pinSize(zoom: Double, longest: Double) -> Double { max(13 / max(zoom, 0.0001), longest / 70) }

  /// The part of the picture a set of marks covers, with their own size about them: where to look to see them.
  public static func bounds(_ marks: [PictureMark]) -> (x: Double, y: Double, width: Double, height: Double)? {
    var low: (Double, Double)?
    var high = (0.0, 0.0)
    for mark in marks {
      var index = 0
      while index + 1 < mark.points.count {
        let (x, y) = (mark.points[index], mark.points[index + 1])
        if let was = low {
          low = (min(was.0, x - mark.size), min(was.1, y - mark.size))
          high = (max(high.0, x + mark.size), max(high.1, y + mark.size))
        } else {
          low = (x - mark.size, y - mark.size)
          high = (x + mark.size, y + mark.size)
        }
        index += 2
      }
    }
    guard let low else { return nil }
    return (low.0, low.1, high.0 - low.0, high.1 - low.1)
  }
}

/// The comments the window's viewers make, made the same way on the phone. The code and picture makers are held to
/// the window's own (`codeCommentAnnotation`, `imageCommentAnnotation`) by the contract's `feedback` suite.
public enum FileComments {
  /// `CODE_EXCERPT_MAX_CHARS`: the most of a comment's lines kept whole, in UTF-16 units.
  public static let excerptMax = 4096

  /// A new annotation id (`isInboxAnnotationId`: letters, digits and `_.:-`).
  public static func newID() -> String { "ann-\(UUID().uuidString.lowercased())" }

  static func stamp(_ now: Date) -> JSONValue { .number((now.timeIntervalSince1970 * 1000).rounded()) }

  /// `sliceText` (packages/core/text-cut.ts): the longest start of at most `max` UTF-16 units that ends between
  /// two characters as a person reads them.
  static func slice(_ text: String, _ max: Int) -> String {
    guard max > 0 else { return "" }
    if text.utf16.count <= max { return text }
    var end = text.startIndex
    var used = 0
    for index in text.indices {
      let next = text.index(after: index)
      let size = text[index..<next].utf16.count
      if used + size > max { break }
      used += size
      end = next
    }
    return String(text[..<end])
  }

  /// `cutText`: `text` when it fits, else its start and "…", together at most `max`.
  static func cut(_ text: String, _ max: Int) -> String { text.utf16.count <= max ? text : "\(slice(text, max - 1))…" }

  /// `codeHash` (packages/inbox/attachments.ts): FNV-1a over UTF-16 units, 64 bits as two halves.
  public static func hash(_ text: String) -> String {
    var a: UInt32 = 0x811c_9dc5
    var b: UInt32 = 0x0100_0193 ^ 0x9e37_79b9
    for unit in text.utf16 {
      a = (a ^ UInt32(unit)) &* 0x0100_0193
      // `(b >>> 15)` in JavaScript is of the 32-bit value read without a sign.
      b = ((b ^ UInt32(unit)) &* 0x0100_0193) ^ (b >> 15)
    }
    return String(format: "%08x%08x", a, b)
  }

  private static func base(id: String, block: String, start: Int, end: Int, type: String = "COMMENT", words: String, quote: String, now: Date) -> [String: JSONValue] {
    ["id": .string(id), "blockId": .string(block), "startOffset": .number(Double(start)), "endOffset": .number(Double(end)), "type": .string(type), "text": .string(words), "originalText": .string(quote), "createdA": stamp(now)]
  }

  /// Words selected in a document. `block`: the window's id for the block they are in, or "" when the phone does
  /// not split this file as the window does (then the feedback names no line: the quote finds the place).
  /// `start`: where they begin, for the order of the feedback.
  public static func words(id: String = newID(), block: String, start: Int, quote: String, comment: String, now: Date = Date()) -> [String: JSONValue] {
    base(id: id, block: block, start: start, end: start + quote.utf16.count, words: comment, quote: quote, now: now)
  }

  /// A comment on the whole file: a document's or a code file's Global comment, a page's own comment
  /// (packages/ui/components/Viewer.tsx, packages/inbox/components/HtmlPageComment.tsx: `GLOBAL_COMMENT`).
  public static func whole(id: String = newID(), comment: String, now: Date = Date()) -> [String: JSONValue] {
    base(id: id, block: "", start: 0, end: 0, type: "GLOBAL_COMMENT", words: comment, quote: "", now: now)
  }

  /// The run of lines a touch on `line` makes of the run being commented on: the line alone when there is none,
  /// the run stretched to the line when it is outside it, and the line alone again when it is inside (a way to
  /// start over without leaving the comment).
  public static func run(_ now: ClosedRange<Int>?, touched line: Int) -> ClosedRange<Int> {
    guard let now, !now.contains(line) else { return line...line }
    return min(now.lowerBound, line)...max(now.upperBound, line)
  }

  /// A comment on a line of code or a run of lines (`codeCommentAnnotation`). `code`: those lines as they read.
  public static func lines(id: String = newID(), lineStart: Int, lineEnd: Int, code: String, comment: String, now: Date = Date()) -> [String: JSONValue] {
    let lines = code.components(separatedBy: "\n")
    let first = lines.map { FileFeedback.trim($0) }.first { !$0.isEmpty } ?? ""
    var annotation = base(id: id, block: "code-L\(lineStart)-\(lineEnd)", start: 0, end: 0, words: comment, quote: "\(cut(first, 120))\(lines.count > 1 ? " …" : "")", now: now)
    var range: [String: JSONValue] = ["lineStart": .number(Double(lineStart)), "lineEnd": .number(Double(lineEnd))]
    if code.utf16.count > excerptMax {
      range["code"] = .string(cut(code, excerptMax))
      range["length"] = .number(Double(code.utf16.count))
      range["hash"] = .string(hash(code))
    } else {
      range["code"] = .string(code)
    }
    annotation["inboxCode"] = .object(range)
    return annotation
  }

  /// A comment on a picture (`imageCommentAnnotation`), with the person's drawing over it when they drew: the
  /// words are the stand-in when there is only a drawing (`markupWords`).
  public static func picture(id: String = newID(), name: String, comment: String, markup: FileComment.Picture?, now: Date = Date()) -> [String: JSONValue] {
    let trimmed = FileFeedback.trim(comment)
    var annotation = base(id: id, block: "image", start: 0, end: 0, words: trimmed.isEmpty && markup != nil ? Words.markupOnly : trimmed, quote: name, now: now)
    if let markup { annotation["images"] = .array([.object(["path": .string(markup.path), "name": .string(markup.name)])]) }
    return annotation
  }

  /// A pin on an element of a page (the window's pinpoint: packages/ui/types.ts `elementContext`, `htmlAnchor`).
  /// `element`: what the page's pin script read of the element. `order`: its place among the page's pins.
  public static func pin(id: String = newID(), element: PinnedElement, order: Int, comment: String, now: Date = Date()) -> [String: JSONValue] {
    var annotation = base(id: id, block: "", start: order, end: order, words: comment, quote: element.quote, now: now)
    annotation["elementContext"] = .object(element.context)
    var anchor: [String: JSONValue] = ["selector": .string(element.selector), "tagName": .string(element.tag.uppercased()), "point": .object(["x": .number(element.x), "y": .number(element.y)])]
    if !element.text.isEmpty { anchor["text"] = .string(cut(element.text, 400)) }
    annotation["htmlAnchor"] = .object(anchor)
    return annotation
  }
}

/// What the pin script read of the element under a tap (FilePins.swift), cut to the window's own bounds for an
/// element (packages/core/html-anchor.ts: a tag of 32, a path of 512, words of 300, a selector of 1024).
public struct PinnedElement: Hashable, Sendable {
  public var tag: String
  /// The element's own words, on one line.
  public var text: String
  public var selector: String
  /// Where the tap was, in the page's own points from its top left.
  public var x: Double
  public var y: Double
  public var context: [String: JSONValue]

  /// The words the comment quotes: the element's own, or `[element: <what it is>]` for one with none, which the
  /// feedback then names by its tag (the window's placeholder for a text-less element).
  public var quote: String {
    if !text.isEmpty { return FileComments.cut(text, 300) }
    if case .string(let name)? = context["name"], !name.isEmpty { return "[element: \(name.replacingOccurrences(of: "]", with: ""))]" }
    return "[element: \(tag)]"
  }

  /// Read what the script answered: an object with `tag`, `text`, `selector`, `x`, `y` and the context's own
  /// fields. Anything else is not an element (nil), and every string is cut to its bound: the page wrote them.
  public init?(_ answer: JSONValue) {
    guard case .object(let fields) = answer, case .string(let rawTag)? = fields["tag"], rawTag.wholeMatch(of: /[a-z][a-z0-9-]{0,31}/) != nil else { return nil }
    guard case .number(let x)? = fields["x"], case .number(let y)? = fields["y"], x.isFinite, y.isFinite else { return nil }
    func words(_ key: String, _ max: Int) -> String? {
      guard case .string(let text)? = fields[key] else { return nil }
      let line = FileFeedback.collapse(text)
      return line.isEmpty ? nil : FileComments.cut(line, max)
    }
    tag = rawTag
    text = words("text", 300) ?? ""
    selector = words("selector", 1024) ?? rawTag
    self.x = x
    self.y = y
    var context: [String: JSONValue] = ["tag": .string(rawTag)]
    if !text.isEmpty { context["text"] = .string(text) }
    for (key, max) in [("id", 100), ("path", 512), ("role", 32), ("name", 120), ("heading", 130), ("landmark", 80)] {
      if let value = words(key, max) { context[key] = .string(value) }
    }
    if case .object(let rect)? = fields["rect"] {
      let sides = ["x", "y", "w", "h", "vw", "vh"].compactMap { key -> (String, JSONValue)? in
        guard case .number(let value)? = rect[key], value.isFinite else { return nil }
        return (key, .number((value * 10).rounded() / 10))
      }
      if sides.count == 6 { context["rect"] = .object(Dictionary(uniqueKeysWithValues: sides)) }
    }
    self.context = context
  }
}
