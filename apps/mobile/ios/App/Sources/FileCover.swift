import InboxCore
import InboxWire
import SwiftUI

/// One file's bytes for its viewer: fetched through the session (from the phone's own copy when it has one), then
/// given the file's own name, since the system's viewers and the share sheet read a file's kind from its name.
@MainActor
@Observable
final class FileLoad {
  enum Phase: Equatable {
    case waiting
    case ready(URL)
    /// Not kept on the phone, and the computer does not answer.
    case away
    case failed(String)
  }

  private(set) var phase: Phase = .waiting
  /// How much of a large file has come, 0 to 1, once the computer has said how large it is.
  private(set) var progress: Double?
  /// The version the person asked for; nil is the one the file opens with.
  var asked: AttachmentVersion?
  @ObservationIgnored private var held: (item: AttachmentItem, version: AttachmentVersion, folder: URL)?

  func shows(_ item: AttachmentItem) -> AttachmentVersion { asked ?? item.opens }

  func open(_ item: AttachmentItem, session: InboxSession) async {
    let version = shows(item)
    if let held, held.version == version, held.item.id == item.id, case .ready = phase { return }
    close(session)
    phase = .waiting
    progress = nil
    do {
      let kept = try await session.openAttachment(item, version: version) { [weak self] got, total in
        guard let total, total > 0 else { return }
        Task { @MainActor in self?.progress = Double(got) / Double(total) }
      }
      let folder = FileManager.default.temporaryDirectory.appendingPathComponent("open-files/\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      let named = folder.appendingPathComponent(item.name.replacingOccurrences(of: "/", with: "_"))
      // A second name for the same bytes: nothing is copied.
      do { try FileManager.default.linkItem(at: kept, to: named) } catch { try FileManager.default.copyItem(at: kept, to: named) }
      held = (item, version, folder)
      phase = .ready(named)
    } catch AttachmentError.notKept {
      phase = .away
    } catch AttachmentError.fetch(.tooLarge) {
      phase = .failed(PhoneWords.fileTooLarge(item.name))
    } catch AttachmentError.unavailable(let words) {
      phase = .failed(words)
    } catch is CancellationError {
      phase = .waiting
    } catch {
      phase = .failed(PhoneWords.fileNotShown(item.name))
    }
  }

  func close(_ session: InboxSession) {
    guard let held else { return }
    session.attachmentClosed(held.item, version: held.version)
    try? FileManager.default.removeItem(at: held.folder)
    self.held = nil
  }

  var url: URL? {
    if case .ready(let url) = phase { return url }
    return nil
  }
}

/// The loads of the files a cover has shown, so the bar's menu acts on the file that is on screen.
@MainActor
@Observable
final class FileShelf {
  /// Not observed: a load is made the first time its page is drawn, and each load says its own changes.
  @ObservationIgnored private var loads: [AttachmentID: FileLoad] = [:]

  func load(_ id: AttachmentID) -> FileLoad {
    if let load = loads[id] { return load }
    let load = FileLoad()
    loads[id] = load
    return load
  }

  func closeAll(_ session: InboxSession) { loads.values.forEach { $0.close(session) } }
}

/// A file, full screen over its thread (FLOWS 7): Done, the file's name and its place among the thread's files, and
/// More. A swipe sideways steps to the next file.
///
/// Laid out for what comes next (comments and marks): the viewer fills the screen under the system's bar and nothing
/// of this slice stands at the foot, which is where a tool bar and a comment field go (`floatingBar()`); each viewer
/// already names its places the way the window does (a document's blocks by the window's ids, a code file's lines by
/// number, a picture's points in its own pixels).
struct FileCover: View {
  let session: InboxSession
  let thread: ThreadID
  let start: AttachmentID
  /// The file on screen (the one the cover opened on, until the first step).
  @State private var shown: AttachmentID?
  private var at: AttachmentID { shown ?? start }
  @State private var shelf = FileShelf()
  /// The bars are put away: a touch on a picture hides them and brings them back.
  @State private var bare = false
  @State private var copied = false
  @Environment(\.dismiss) private var dismiss

  private var items: [AttachmentItem] { session.attachments(thread).filter { !$0.inline } }

  var body: some View {
    let items = items
    let steps = FileFacts.Steps(items)
    let current = items.first { $0.id == at }
    let onDark = current.map { Self.onDark($0) } ?? false
    NavigationStack {
      // The files side by side, a screen each: a drag steps from one to the next and rests on a whole file. The
      // pages reach under the bars (a picture looked into passes under them); each is told how much the bars
      // cover, and keeps what it shows at rest clear of them.
      GeometryReader { geometry in
        let bars = geometry.safeAreaInsets
        ScrollView(.horizontal) {
          LazyHStack(spacing: 0) {
            ForEach(items) { item in
              FilePage(session: session, item: item, load: shelf.load(item.id), bars: bars, bare: $bare) { dismiss() }
                .containerRelativeFrame([.horizontal, .vertical])
                .id(item.id)
            }
          }
          .scrollTargetLayout()
        }
        .ignoresSafeArea()
      }
      .scrollTargetBehavior(.paging)
      .scrollPosition(id: $shown)
      .scrollIndicators(.hidden)
      .background((onDark ? Color.black : Token.background).ignoresSafeArea())
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button(PhoneWords.done) { dismiss() }
        }
        ToolbarItem(placement: .principal) {
          VStack(spacing: Space.hair) {
            Text(current?.name ?? "").font(TextRole.name).foregroundStyle(onDark ? Color.white : Token.foreground).lineLimit(1).truncationMode(.middle)
            if let place = steps.place(at) {
              Text(PhoneWords.filePlace(place.at, of: place.of)).font(TextRole.caption).monospacedDigit().foregroundStyle(onDark ? Color.white.opacity(0.7) : Token.mutedForeground)
            }
          }
          .accessibilityElement(children: .combine)
          .accessibilityAddTraits(.isHeader)
          .accessibilityShowsLargeContentViewer { Text(current?.name ?? "") }
        }
        if let current, let url = shelf.load(current.id).url {
          ToolbarItem(placement: .topBarTrailing) {
            Menu {
              ShareLink(item: url) { Label(PhoneWords.share, systemImage: "square.and.arrow.up") }
              if current.kind == .image {
                Button { UIPasteboard.general.image = UIImage(contentsOfFile: url.path) } label: { Label(PhoneWords.copyImage, systemImage: "square.on.square") }
              } else if current.isText {
                Button { UIPasteboard.general.string = try? String(contentsOf: url, encoding: .utf8) } label: { Label(PhoneWords.copyFile, systemImage: "square.on.square") }
              }
            } label: {
              Image(systemName: "ellipsis")
            }
            .accessibilityLabel(PhoneWords.more)
            .accessibilityIdentifier("file-more")
          }
        }
      }
      .toolbarVisibility(bare && onDark ? .hidden : .visible, for: .navigationBar)
      .toolbarColorScheme(onDark ? .dark : nil, for: .navigationBar)
    }
    .statusBarHidden(bare && onDark)
    .motion(.fade, value: bare)
    .onChange(of: shown) { _, _ in bare = false }
    .onAppear { if shown == nil { shown = start } }
    // How each file stands now (changed since sent, gone), asked once the cover is up.
    .task { await session.readAttachments(thread) }
    .onDisappear { shelf.closeAll(session) }
  }

  /// A picture, a video and a recording are shown on black, whatever the phone's appearance.
  static func onDark(_ item: AttachmentItem) -> Bool { [.picture, .player].contains(FileFacts.shown(item.kind, name: item.name, size: item.size)) }
}

/// One file in the cover: its viewer once its bytes are here, and until then where it stands.
struct FilePage: View {
  let session: InboxSession
  let item: AttachmentItem
  let load: FileLoad
  /// How much of the screen the bars cover, at each edge.
  let bars: EdgeInsets
  @Binding var bare: Bool
  let close: () -> Void

  var body: some View {
    let version = load.shows(item)
    let size = version == .sent ? item.size : item.current?.size ?? item.size
    let shown = FileFacts.shown(item.kind, name: item.name, size: size)
    let onDark = FileCover.onDark(item)
    Group {
      switch load.phase {
      case .waiting:
        if let progress = load.progress, progress < 1 {
          ProgressView(value: progress).frame(width: 160).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          Waiting()
        }
      case .away:
        Standing(symbol: "wifi.slash", words: PhoneWords.awayNoCopy(session.computer.name), action: PhoneWords.tryAgain) { Task { await load.open(item, session: session) } }
      case .failed(let words):
        Standing(symbol: "doc", words: words, action: PhoneWords.tryAgain) { Task { await load.open(item, session: session) } }
      case .ready(let url):
        viewer(shown, url)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .environment(\.colorScheme, onDark ? .dark : colorScheme)
    .safeAreaInset(edge: .top, spacing: 0) {
      if !(bare && onDark) { VersionLine(item: item, load: load) }
    }
    // A picture fills the screen and keeps clear of the bars itself; every other page starts under the title bar.
    .safeAreaPadding(.top, bars.top)
    .safeAreaPadding(.bottom, bars.bottom)
    .task(id: "\(version.rawValue)/\(item.current?.sha256 ?? "")") { await load.open(item, session: session) }
  }

  @Environment(\.colorScheme) private var colorScheme

  @ViewBuilder private func viewer(_ shown: FileFacts.Shown, _ url: URL) -> some View {
    switch shown {
    case .picture: PicturePage(url: url, item: item, bars: bars, bare: $bare, close: close)
    case .document, .text, .code: WordsPage(url: url, item: item, shown: shown)
    case .page: WebPage(url: url, name: item.name).ignoresSafeArea(edges: .bottom)
    case .player: PlayerPage(url: url, item: item)
    case .pdf: PDFPage(url: url).accessibilityIdentifier("file-pdf")
    case .card: FileCard(session: session, item: item, url: url)
    }
  }
}

/// The note over a file that is not what was sent: what is on screen, and the way to the other version.
struct VersionLine: View {
  let item: AttachmentItem
  let load: FileLoad

  private var words: (line: String, link: String?, to: AttachmentVersion)? {
    if let unavailable = item.unavailable { return (unavailable.code == .attachmentMissing ? PhoneWords.fileGone : PhoneWords.fileOtherKind, nil, .sent) }
    guard item.changedSinceSent == true else { return nil }
    return load.shows(item) == .sent ? (PhoneWords.fileShowingSent, PhoneWords.viewCurrent, .current) : (PhoneWords.fileChanged, PhoneWords.viewSent, .sent)
  }

  var body: some View {
    if let words {
      VStack(spacing: 0) {
        HStack(alignment: .firstTextBaseline, spacing: Space.close) {
          Image(systemName: "clock.arrow.circlepath").font(TextRole.meta).foregroundStyle(Token.mutedForeground).accessibilityHidden(true)
          Text(words.line).font(TextRole.secondary).foregroundStyle(Token.foreground).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
          if let link = words.link {
            Button(link) { load.asked = words.to }
              .font(TextRole.link)
              .foregroundStyle(Token.primary)
              .buttonStyle(PressStyle())
              .frame(minHeight: Space.touch)
              .contentShape(Rectangle())
          }
        }
        .padding(.horizontal, Space.page)
        .padding(.vertical, words.link == nil ? Space.near : 0)
        Hairline()
      }
      .background(Token.background)
    }
  }
}

/// A file the phone does not draw (a zip, a text file past 16 MB, a picture in a format the phone cannot read): what
/// it is, and the share sheet, which is how a phone saves a file or hands it to another app.
struct FileCard: View {
  let session: InboxSession
  let item: AttachmentItem
  let url: URL

  var body: some View {
    VStack(spacing: Space.card) {
      Image(systemName: FileGlyph.symbol(item)).font(.system(size: 34, weight: .regular)).foregroundStyle(Token.mutedForeground).thumbnail(Media.thumb).accessibilityHidden(true)
      VStack(spacing: Space.tight) {
        Text(item.name).font(TextRole.heading).foregroundStyle(Token.foreground).multilineTextAlignment(.center)
        Text(FileFacts.detail(item)).font(TextRole.secondary).monospacedDigit().foregroundStyle(Token.mutedForeground).multilineTextAlignment(.center)
      }
      ShareLink(item: url) { Text(PhoneWords.share).actionGround(.filled, height: Size.wideButton) }
        .buttonStyle(PressStyle())
        .padding(.top, Space.close)
    }
    .padding(.horizontal, Space.section)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Token.background)
  }
}
