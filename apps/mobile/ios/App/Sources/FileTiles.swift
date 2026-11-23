import ImageIO
import InboxCore
import InboxWire
import SwiftUI

/// The file a tile opens: which one, in which thread.
struct FileOpen: Identifiable, Hashable {
  let thread: ThreadID
  let file: AttachmentID
  /// A comment to open at, and whether its words are to be changed at once.
  var seek: FileComment?
  var edits = false
  var id: String { file.rawValue }
}

private struct OpenFileKey: EnvironmentKey { static let defaultValue: @MainActor @Sendable (AttachmentItem) -> Void = { _ in } }
extension EnvironmentValues {
  /// Open one of the thread's files over the thread.
  var openFile: @MainActor @Sendable (AttachmentItem) -> Void {
    get { self[OpenFileKey.self] }
    set { self[OpenFileKey.self] = newValue }
  }
}

/// The mark for a kind of file, where there is no picture of it.
enum FileGlyph {
  static func symbol(_ item: AttachmentItem) -> String {
    switch FileFacts.viewKind(item.kind, name: item.name) {
    case .markdown: return "doc.richtext"
    case .text: return "doc.text"
    case .html: return "macwindow"
    case .image: return "photo"
    case .video: return "play.rectangle"
    case .audio: return "waveform"
    case .pdf: return "doc"
    case .mermaid, .graphviz: return "point.3.connected.trianglepath.dotted"
    case .file: return "shippingbox"
    default: return "chevron.left.forwardslash.chevron.right"
    }
  }
}

/// The files a message carries, under its words: one row each, parted by hairlines, the whole row to touch
/// (flow check thread-08). A picture shows itself small; any other file shows its kind's mark.
struct FileTiles: View {
  let session: InboxSession
  let items: [AttachmentItem]
  /// The thread they are in: a tile counts the comments on its file that ride the next Send or wait for the
  /// computer's network.
  var thread: ThreadID?
  @Environment(\.openFile) private var open

  var body: some View {
    let riding = thread.map { session.commentsCounted($0) } ?? []
    VStack(spacing: 0) {
      ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
        if index > 0 { Hairline().padding(.leading, Media.rowThumb + Space.step) }
        Button {
          open(item)
        } label: {
          FileTile(session: session, item: item, comments: riding.filter { $0.attachment == item.id }.count)
        }
        .buttonStyle(RowStyle(inset: Space.close))
        .accessibilityIdentifier("file/\(item.name)")
      }
    }
  }
}

struct FileTile: View {
  let session: InboxSession
  let item: AttachmentItem
  /// The comments on the file that ride the next Send.
  var comments = 0

  /// The file's facts, then its comments ("12 KB, 2 comments"), as the window's tile caption.
  static func caption(_ item: AttachmentItem, comments: Int) -> String {
    let facts = FileFacts.detail(item)
    return comments > 0 ? "\(facts), \(CountWords.comments(comments))" : facts
  }

  /// What changed about the file since it was sent, in the window's tile words
  /// (packages/inbox/components/ArtifactsView.tsx `artifactChanged`).
  private var changed: String? {
    if let unavailable = item.unavailable { return unavailable.code == .attachmentMissing ? PhoneWords.fileNoLongerOnDisk : PhoneWords.fileChangedType }
    return item.changedSinceSent == true ? PhoneWords.fileChanged : nil
  }

  var body: some View {
    HStack(alignment: .center, spacing: Space.step) {
      FileThumb(session: session, item: item)
      VStack(alignment: .leading, spacing: Space.hair) {
        Text(item.name).font(TextRole.label).foregroundStyle(Token.foreground).lineLimit(2).truncationMode(.middle).multilineTextAlignment(.leading)
        Text(Self.caption(item, comments: comments)).font(TextRole.meta).monospacedDigit().foregroundStyle(Token.mutedForeground).lineLimit(2).multilineTextAlignment(.leading)
        if let changed { RoleLine(words: changed, role: .hold).font(TextRole.meta) }
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, Space.close)
    .frame(minHeight: Space.touch)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }
}

/// A file's small picture: the picture itself for an image the phone has or can fetch, the kind's mark otherwise.
struct FileThumb: View {
  let session: InboxSession
  let item: AttachmentItem
  var side: CGFloat = Media.rowThumb
  @State private var picture: UIImage?
  @Environment(\.displayScale) private var scale

  /// The largest picture fetched only to show it small.
  private static let thumbCap: Int64 = 12 * 1024 * 1024

  var body: some View {
    Group {
      if let picture {
        Image(uiImage: picture).resizable().scaledToFill()
      } else {
        Image(systemName: FileGlyph.symbol(item)).font(.system(size: side * 0.4, weight: .regular)).foregroundStyle(Token.mutedForeground)
      }
    }
    .thumbnail(side)
    .accessibilityHidden(true)
    .task(id: "\(item.id.rawValue)/\(item.current?.sha256 ?? item.sentSha256)") {
      guard item.kind == .image, (item.current?.size ?? item.size) <= Self.thumbCap else { return }
      guard case .notKept = session.availability(item) else { return await load() }
    }
  }

  private func load() async {
    guard let opened = try? await session.openHeld(item) else { return }
    let pixels = side * scale * 2
    picture = await Task.detached { Pictures.small(opened.url, pixels: pixels) }.value
    // Its own hold: never the cover's, which may hold the same file.
    opened.hold.map(session.release)
  }
}

/// Reading pictures off the phone's files: always through ImageIO's downsampling, off the main thread, and never
/// more pixels than a phone holds for one page (the pages beside it are alive too).
enum Pictures {
  /// The most pixels the viewer decodes for one picture: 16 million (64 MB), drawn down to fit when larger.
  static let viewerPixels: Double = 16_000_000
  /// The most pixels a tile's picture is made of.
  static let thumbPixels: Double = 1_000_000
  /// A file that says it is larger than this (a side over 50,000, or 250 million pixels) is not decoded at all: a
  /// picture made to exhaust a phone, or a broken header.
  static let refusedSide: Double = 50_000
  static let refusedPixels: Double = 250_000_000

  /// A picture's own size in pixels, turned as its file says it is held. Nil when the file is no picture the phone
  /// reads, or says it is of a size that is refused.
  nonisolated static func size(_ source: CGImageSource) -> CGSize? {
    guard CGImageSourceGetCount(source) > 0, let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else { return nil }
    let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue ?? 0
    let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue ?? 0
    guard width > 0, height > 0, width <= refusedSide, height <= refusedSide, width * height <= refusedPixels else { return nil }
    let turned = ((properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1) >= 5
    return turned ? CGSize(width: height, height: width) : CGSize(width: width, height: height)
  }

  /// Decoded here, at most `longSide` pixels on its long side: the thumbnail maker reads a large file down as it
  /// decodes it, and turns a photo the way its file says it is held.
  nonisolated private static func decoded(_ source: CGImageSource, longSide: Double) -> CGImage? {
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: max(1, longSide.rounded(.up)),
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
  }

  /// The long side that keeps a picture of `size` within `pixels`.
  nonisolated static func longSide(_ size: CGSize, within pixels: Double) -> Double {
    let scale = min(1, (pixels / (size.width * size.height)).squareRoot())
    return max(size.width, size.height) * scale
  }

  /// A picture made small for a tile: its short side `pixels` across (it fills a square), within `thumbPixels`.
  nonisolated static func small(_ url: URL, pixels: CGFloat) -> UIImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let size = size(source) else { return nil }
    let short = min(size.width, size.height)
    let wanted = max(size.width, size.height) * min(1, Double(pixels) / short)
    return decoded(source, longSide: min(wanted, longSide(size, within: thumbPixels))).map { UIImage(cgImage: $0) }
  }

  /// A picture for the viewer, and its own size in pixels: the viewer lays it out at that size in points (a pixel is
  /// a point: a place on it is a place in the file), drawing a larger picture from fewer pixels.
  nonisolated static func whole(_ url: URL) -> (image: UIImage, pixels: CGSize)? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let size = size(source), let image = decoded(source, longSide: longSide(size, within: viewerPixels)) else { return nil }
    return (UIImage(cgImage: image, scale: 1, orientation: .up), size)
  }

  /// The picture file's own type, for the pasteboard (`public.png`).
  nonisolated static func type(_ url: URL) -> String? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    return CGImageSourceGetType(source) as String?
  }
}

/// More's copies, read off the main thread.
enum Copy {
  /// The picture's own bytes, as its own type: nothing is decoded.
  static func picture(_ url: URL) async {
    let read = await Task.detached { (data: try? Data(contentsOf: url, options: .mappedIfSafe), type: Pictures.type(url)) }.value
    if let data = read.data, let type = read.type {
      UIPasteboard.general.setData(data, forPasteboardType: type)
    } else if let file = NSItemProvider(contentsOf: url) {
      UIPasteboard.general.itemProviders = [file]
    }
  }

  /// The file's words; a file that is not UTF-8 text is copied as the file itself.
  static func words(_ url: URL) async {
    let words = await Task.detached { try? String(contentsOf: url, encoding: .utf8) }.value
    if let words {
      UIPasteboard.general.string = words
    } else if let file = NSItemProvider(contentsOf: url) {
      UIPasteboard.general.itemProviders = [file]
    }
  }
}
