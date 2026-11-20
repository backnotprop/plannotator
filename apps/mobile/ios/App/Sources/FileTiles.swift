import ImageIO
import InboxCore
import InboxWire
import SwiftUI

/// The file a tile opens: which one, in which thread.
struct FileOpen: Identifiable, Hashable {
  let thread: ThreadID
  let file: AttachmentID
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
  @Environment(\.openFile) private var open

  var body: some View {
    VStack(spacing: 0) {
      ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
        if index > 0 { Hairline().padding(.leading, Media.rowThumb + Space.step) }
        Button {
          open(item)
        } label: {
          FileTile(session: session, item: item)
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
        Text(FileFacts.detail(item)).font(TextRole.meta).monospacedDigit().foregroundStyle(Token.mutedForeground).lineLimit(2).multilineTextAlignment(.leading)
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
    guard let url = try? await session.openAttachment(item) else { return }
    let pixels = side * scale * 2
    picture = await Task.detached { Pictures.small(url, pixels: pixels) }.value
    session.attachmentClosed(item)
  }
}

/// Reading pictures off the phone's files.
enum Pictures {
  /// A picture made small for a tile, without reading it whole.
  nonisolated static func small(_ url: URL, pixels: CGFloat) -> UIImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else { return nil }
    let options: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceThumbnailMaxPixelSize: pixels]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map { UIImage(cgImage: $0) }
  }

  /// A picture for the viewer, at its own size in points (a pixel is a point: its numbers are the file's), read down
  /// only when it is larger than a phone can hold in memory.
  nonisolated static func whole(_ url: URL) -> UIImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), CGImageSourceGetCount(source) > 0 else { return nil }
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    let width = (properties?[kCGImagePropertyPixelWidth] as? CGFloat) ?? 0
    let height = (properties?[kCGImagePropertyPixelHeight] as? CGFloat) ?? 0
    // Through the thumbnail maker at the picture's own size: it turns a photo the way its file says it is held.
    guard let image = small(url, pixels: min(max(width, height, 1), 8192)) else { return nil }
    return UIImage(cgImage: image.cgImage!, scale: 1, orientation: .up)
  }
}
