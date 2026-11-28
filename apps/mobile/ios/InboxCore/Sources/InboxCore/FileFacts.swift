import Foundation
import InboxWire

/// What a file's tile and its viewer say of it, and how it is drawn: the window's own rules, held to the contract's
/// `files` suite (apps/mobile/contract/vectors/files.json, made from the window's functions).
public enum FileFacts {
  /// Whether a link written in an attached document may open: a site or a mail address, as the window's document
  /// links are (packages/ui/components/InlineMarkdown.tsx). Never another app's scheme, a file, or this app's own
  /// pairing link: a document an agent wrote must not be able to start any of those with one tap.
  public static func documentLinkOpens(_ url: URL) -> Bool { ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") }

  /// A text or code file larger than this is not drawn (packages/core/inbox-attachments.ts `INBOX_VIEW_MAX_BYTES`).
  public static let viewCap: Int64 = 16 * 1024 * 1024

  /// "412.6 MB", "3.1 KB", "512 B" (packages/core/inbox-format.ts `formatBytes`).
  public static func bytes(_ count: Int64) -> String {
    if count < 1024 { return "\(count) B" }
    let units = ["KB", "MB", "GB", "TB"]
    var unit: Int64 = 1024
    var index = 0
    while count / unit >= 1024, index < units.count - 1 {
      unit *= 1024
      index += 1
    }
    // One decimal, a half rounded up, in whole numbers: no rounding of a binary fraction is left to chance.
    let tenths = (count * 20 + unit) / (2 * unit)
    return "\(tenths / 10).\(tenths % 10) \(units[index])"
  }

  private static let mediaLabels: [String: String] = [
    "image/png": "PNG", "image/jpeg": "JPEG", "image/gif": "GIF", "image/webp": "WebP", "image/avif": "AVIF", "image/bmp": "BMP", "image/x-icon": "ICO", "image/svg+xml": "SVG",
    "video/mp4": "MP4", "video/quicktime": "MOV", "video/webm": "WebM",
    "audio/mpeg": "MP3", "audio/mp4": "M4A", "audio/wav": "WAV", "audio/ogg": "Ogg", "audio/flac": "FLAC", "audio/aac": "AAC", "audio/webm": "WebM",
  ]

  static func ext(_ name: String) -> String? { name.firstMatch(of: /\.([A-Za-z0-9]+)$/).map { String($0.1) } }

  /// The kind as a tile names it: "Markdown", "PNG image", "Code (.sql)" (`inboxAttachmentKindLabel`).
  public static func kind(_ kind: InboxAttachmentKind, name: String, mediaType: String? = nil) -> String {
    let ext = ext(name)
    func media(_ noun: String, _ alone: String) -> String {
      let label = mediaType.flatMap { mediaLabels[$0] } ?? ext?.uppercased()
      return label.map { "\($0) \(noun)" } ?? alone
    }
    switch AttachmentItem.known(kind) {
    case .markdown: return "Markdown"
    case .html: return "HTML"
    case .mermaid: return "Mermaid"
    case .graphviz: return "Graphviz"
    case .text: return ext.flatMap { $0.lowercased() != "txt" ? $0.uppercased() : nil } ?? "Text"
    case .code: return ext.map { "Code (.\($0.lowercased()))" } ?? "Code (\(name))"
    case .image: return media("image", "Image")
    case .video: return media("video", "Video")
    case .audio:
      // An Ogg holding Opus is named by its own extension when it says so.
      if ext?.lowercased() == "opus" { return "Opus audio" }
      return media("audio", "Audio")
    case .pdf: return "PDF"
    default: return ext.map { "\($0.uppercased()) file" } ?? "File"
    }
  }

  /// A moment as people read it: `m:ss`, `h:mm:ss` from one hour (`formatInboxVideoTime`).
  public static func moment(_ seconds: Double) -> String {
    let total = seconds.isFinite && seconds > 0 ? Int(seconds.rounded(.down)) : 0
    let h = total / 3600
    let m = (total % 3600) / 60
    let ss = String(format: "%02d", total % 60)
    return h > 0 ? "\(h):\(String(format: "%02d", m)):\(ss)" : "\(m):\(ss)"
  }

  static func number(_ value: Double) -> String { value == value.rounded() ? String(Int(value)) : String(value) }

  /// "7:41 · 1920 × 1080" (`inboxVideoMeta`).
  static func mediaLine(durationMs: Int64?, width: Double?, height: Double?) -> String {
    var parts: [String] = []
    if let durationMs, durationMs > 0 { parts.append(moment(Double(durationMs) / 1000)) }
    if let width, let height, width != 0, height != 0 { parts.append("\(number(width)) × \(number(height))") }
    return parts.joined(separator: " · ")
  }

  /// The line under a file's name on its tile: "1280 × 800, 79.0 KB" for a picture, "MP4 video · 7:41 · 1920 × 1080 ·
  /// 461.0 MB" for a video, "PDF, 2.3 MB" otherwise (packages/inbox/components/AttachmentTiles.tsx `sizeLine`).
  public static func detail(_ item: AttachmentItem) -> String {
    let size = bytes(item.current?.size ?? item.size)
    let label = kind(item.kind, name: item.name, mediaType: item.mediaType)
    if item.isTimed {
      return [label, mediaLine(durationMs: item.durationMs, width: item.width, height: item.height)].filter { !$0.isEmpty }.joined(separator: " · ") + " · \(size)"
    }
    if item.kind == .image, let width = item.width, let height = item.height, width != 0, height != 0 { return "\(number(width)) × \(number(height)), \(size)" }
    return "\(label), \(size)"
  }

  private static let codeViewText: Set<String> = ["log", "yaml", "yml", "json", "jsonc", "json5", "toml", "ini", "cfg", "conf", "properties", "csv", "tsv", "xml"]

  /// The kind a file is drawn as: its own, but data and log files, stored as text, are drawn as code
  /// (packages/inbox/attachments.ts `inboxViewKind`).
  public static func viewKind(_ kind: InboxAttachmentKind, name: String) -> InboxAttachmentKind {
    let kind = AttachmentItem.known(kind)
    guard kind == .text else { return kind }
    let lower = name.lowercased()
    if lower.hasSuffix(".env.example") { return .code }
    guard let ext = lower.firstMatch(of: /\.([a-z0-9]+)$/).map({ String($0.1) }) else { return kind }
    return codeViewText.contains(ext) ? .code : kind
  }

  /// How the phone shows a file.
  public enum Shown: String, Hashable, Sendable {
    /// A picture: whole on the screen, then pinched into.
    case picture
    /// A Markdown document, drawn block by block.
    case document
    /// Plain text, wrapped.
    case text
    /// Lines with their numbers. A diagram's source is read this way until diagrams are drawn.
    case code
    /// An HTML page, in a sandboxed web view.
    case page
    /// A video or a recording, in the system's player.
    case player
    case pdf
    /// A file the phone does not draw: its name, kind and size, and the share sheet.
    case card
  }

  /// `size`: the bytes of the version that opens.
  public static func shown(_ kind: InboxAttachmentKind, name: String, size: Int64) -> Shown {
    switch viewKind(kind, name: name) {
    case .image: return .picture
    case .video, .audio: return .player
    case .pdf: return .pdf
    case .file: return .card
    case .markdown: return size > viewCap ? .card : .document
    case .html: return size > viewCap ? .card : .page
    case .text: return size > viewCap ? .card : .text
    default: return size > viewCap ? .card : .code
    }
  }

  /// The files a cover steps through, in the thread's order, and where one of them is.
  public struct Steps: Hashable, Sendable {
    public var items: [AttachmentItem]
    public init(_ items: [AttachmentItem]) { self.items = items }
    public func index(of id: AttachmentID) -> Int? { items.firstIndex { $0.id == id } }
    /// "2 of 4", or nil for a file alone.
    public func place(_ id: AttachmentID) -> (at: Int, of: Int)? {
      guard items.count > 1, let index = index(of: id) else { return nil }
      return (index + 1, items.count)
    }
  }

  /// The name a file is given in a folder of its own on the phone, where the system's viewers and the share sheet
  /// read its kind from it: its own name, unless no file can have it ("", ".", "..", a slash, more than 255 bytes),
  /// then "file" with the name's own extension, or the name cut to fit before its extension.
  public static func localName(_ name: String) -> String {
    let name = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "\u{0}", with: "")
    let suffix = ext(name).flatMap { $0.utf8.count <= 32 ? ".\($0)" : nil } ?? ""
    if name.isEmpty || name == "." || name == ".." { return "file" }
    guard name.utf8.count > 255 else { return name }
    var base = String(name.dropLast(suffix.count))
    while !base.isEmpty, base.utf8.count + suffix.utf8.count > 255 { base.removeLast() }
    return base.isEmpty ? "file" + suffix : base + suffix
  }

  /// A code file's lines: a line break at the end of the file ends its last line, it does not start another.
  public static func lines(_ text: String) -> [Substring] {
    var lines = text.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false)
    if lines.count > 1, lines.last?.isEmpty == true { lines.removeLast() }
    return lines
  }
}

/// How a picture sits in the viewer: whole at first, however wide or tall it is, then pinched into.
public enum PictureFit {
  /// The scale at which all of a picture shows in a room. A picture smaller than the room is not blown up.
  public static func whole(width: Double, height: Double, roomWidth: Double, roomHeight: Double) -> Double {
    guard width > 0, height > 0, roomWidth > 0, roomHeight > 0 else { return 1 }
    return min(1, min(roomWidth / width, roomHeight / height))
  }

  /// How far in a pinch goes: eight times the picture's own points (the window's 800%), and never less than twice
  /// the whole view, so a small picture can still be looked into.
  public static func most(whole: Double) -> Double { max(8, whole * 2) }

  /// Where a double tap goes: in to twice the whole view from the whole view, back out from anywhere else. A very
  /// wide or very tall picture goes in until its short side fills the room, so its detail is read at once.
  public static func doubleTap(from scale: Double, whole: Double, width: Double, height: Double, roomWidth: Double, roomHeight: Double) -> Double {
    guard scale <= whole * 1.01 else { return whole }
    let fills = max(roomWidth / max(width, 1), roomHeight / max(height, 1))
    return min(most(whole: whole), max(whole * 2, min(fills, 1)))
  }
}
