import InboxCore
import InboxWire
import SwiftUI

/// One file's bytes for its viewer: fetched through the session (from the phone's own copy when it has one), then
/// given the file's own name, since the system's viewers and the share sheet read a file's kind from its name.
///
/// Opens can overlap (a version asked while another comes, a changed file's new hash): only the latest one lands,
/// and every other lets go of what it took.
@MainActor
@Observable
final class FileLoad {
  enum Phase: Equatable {
    case waiting
    case ready(URL)
    /// Not kept on the phone, and the computer does not answer.
    case away
    /// Larger than the phone fetches: trying again cannot help.
    case tooLarge
    case failed(String)
  }

  private(set) var phase: Phase = .waiting
  /// How much of a large file has come, 0 to 1, once the computer has said how large it is.
  private(set) var progress: Double?
  /// The version the person asked for; nil is the one the file opens with.
  var asked: AttachmentVersion?
  /// What is on screen: the bytes' cache key, the hold on them, and the folder that gives them the file's name.
  @ObservationIgnored private var held: (key: String, hold: AttachmentHold?, folder: URL)?
  /// Moves with each open and each close: an open that comes back after a newer one began lands nothing.
  @ObservationIgnored private var generation = 0

  /// The file and the version that open: the one asked for, else the one the file opens with; but a file the
  /// computer has not spoken of since the app started, whose sent version this phone does not keep, opens as this
  /// phone last read it while the computer is away (`lastKept`: it says it changed since sent).
  func target(_ item: AttachmentItem, session: InboxSession) -> (item: AttachmentItem, version: AttachmentVersion) {
    let opening = session.opening(item, asked: asked)
    return (opening.item, opening.version)
  }

  func open(_ item: AttachmentItem, session: InboxSession) async {
    let (target, version) = target(item, session: session)
    let key = InboxSession.cacheKey(target, version)
    // The same bytes are on screen already (a changed file has another key: its hash is in it).
    if let held, held.key == key, case .ready = phase { return }
    close(session)
    let mine = generation
    phase = .waiting
    progress = nil
    let opened: (url: URL, hold: AttachmentHold?)
    do {
      opened = try await session.openHeld(target, version: version) { [weak self] got, total in
        guard let total, total > 0 else { return }
        Task { @MainActor in if self?.generation == mine { self?.progress = Double(got) / Double(total) } }
      }
    } catch {
      guard mine == generation else { return }
      switch error {
      case AttachmentError.notKept: phase = .away
      case AttachmentError.fetch(.tooLarge): phase = .tooLarge
      case AttachmentError.unavailable(let words): phase = .failed(words)
      case is CancellationError: phase = .waiting
      default: phase = .failed(PhoneWords.fileNotShown(item.name))
      }
      return
    }
    guard mine == generation else {
      opened.hold.map(session.release)
      return
    }
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("open-files/\(UUID().uuidString)", isDirectory: true)
    let named = folder.appendingPathComponent(FileFacts.localName(item.name))
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      // A second name for the same bytes: nothing is copied.
      do { try FileManager.default.linkItem(at: opened.url, to: named) } catch { try FileManager.default.copyItem(at: opened.url, to: named) }
    } catch {
      opened.hold.map(session.release)
      try? FileManager.default.removeItem(at: folder)
      phase = .failed(PhoneWords.fileNotShown(item.name))
      return
    }
    held = (key, opened.hold, folder)
    phase = .ready(named)
  }

  func close(_ session: InboxSession) {
    generation += 1
    guard let held else { return }
    held.hold.map(session.release)
    try? FileManager.default.removeItem(at: held.folder)
    self.held = nil
  }

  var url: URL? {
    if case .ready(let url) = phase { return url }
    return nil
  }

  /// The cache key of the bytes on screen: what a comment made on them was read on.
  var key: String? { held?.key }
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
  /// A comment the cover opens at (from the thread's list of comments), and whether to change its words at once.
  var seek: FileComment?
  var edits = false
  /// The file on screen (the one the cover opened on, until the first step).
  @State private var shown: AttachmentID?
  private var at: AttachmentID { shown ?? start }
  @State private var shelf = FileShelf()
  /// The bars are put away: a touch on a picture hides them and brings them back.
  @State private var bare = false
  @State private var copied = false
  /// The comment being written, the marks drawn, the comment asked for.
  @State private var desk = CommentDesk()
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
        ScrollViewReader { pages in
        ScrollView(.horizontal) {
          LazyHStack(spacing: 0) {
            ForEach(items) { item in
              FilePage(session: session, thread: thread, item: item, load: shelf.load(item.id), bars: bars, current: item.id == at, bare: $bare, desk: desk) { dismiss() }
                .containerRelativeFrame([.horizontal, .vertical])
                .id(item.id)
            }
          }
          .scrollTargetLayout()
        }
        .ignoresSafeArea()
        // While a picture takes the finger, a drag draws: it never steps to the next file.
        .scrollDisabled(desk.marking)
        // Back to a comment: its file comes on screen (said to the scroller itself: the cover may have been opened
        // on that file a moment ago, before its pages were laid out), and its viewer shows where it is.
        .onChange(of: desk.sought) { _, sought in
          guard let comment = sought?.comment else { return }
          let file = comment.attachment
          // A comment made on the version that was sent opens on that version, and one on the file as it is now on
          // that one.
          if let item = items.first(where: { $0.id == file }) {
            let load = shelf.load(file)
            let wanted: AttachmentVersion = comment.version == FileComment.current ? .current : .sent
            if load.target(item, session: session).version != wanted { load.asked = wanted }
          }
          shown = file
          pages.scrollTo(file, anchor: .leading)
        }
        }
      }
      // The comment field stands at the foot, over the keyboard when it is up; each page is told how much it covers.
      .safeAreaInset(edge: .bottom, spacing: 0) {
        if let current, !(bare && onDark), session.takesComments(current, in: thread) {
          let load = shelf.load(current.id)
          let shown = FileFacts.shown(current.kind, name: current.name, size: load.url.map(Self.size(of:)) ?? current.size)
          if load.url != nil, [.picture, .document, .text, .code, .page].contains(shown) {
            CommentFoot(session: session, thread: thread, item: current, version: load.target(current, session: session).version, shown: shown, desk: desk, readKey: load.key)
              .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { desk.foot = $0 }
          }
        }
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
        // The number is what the next Send carries and what waits for the computer's network; the list also shows the
        // comments that stay, and why.
        let waiting = session.commentsCounted(thread).count
        if !session.comments(thread).isEmpty {
          // What waits for the next Send, whichever file it is on: a touch lists it.
          ToolbarItem(placement: .topBarTrailing) {
            Button {
              desk.listOpen = true
            } label: {
              HStack(spacing: Space.tight) {
                Image(systemName: "text.bubble")
                Text("\(waiting)").font(TextRole.link).monospacedDigit()
              }
            }
            .accessibilityLabel(CountWords.comments(waiting))
            .accessibilityIdentifier("file-comments")
          }
        }
        if let current, let url = shelf.load(current.id).url {
          ToolbarItem(placement: .topBarTrailing) {
            Menu {
              if let whole = wholeComment(current, url: url) {
                Button { desk.begin(CommentDesk.Draft(file: current.id, version: shelf.load(current.id).target(current, session: session).version, target: .whole)) } label: {
                  Label(whole, systemImage: "text.bubble")
                }
              }
              ShareLink(item: url) { Label(PhoneWords.share, systemImage: "square.and.arrow.up") }
              if current.kind == .image {
                Button { Task { await Copy.picture(url) } } label: { Label(PhoneWords.copyImage, systemImage: "square.on.square") }
              } else if current.isText, FileFacts.shown(current.kind, name: current.name, size: Self.size(of: url)) != .card {
                // Past 16 MB a text file is not words to paste: Share hands the file on.
                Button { Task { await Copy.words(url) } } label: { Label(PhoneWords.copyFile, systemImage: "square.on.square") }
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
    // The two-finger scrub closes the file, as Done does.
    .accessibilityAction(.escape) { dismiss() }
    .statusBarHidden(bare && onDark)
    .motion(.fade, value: bare)
    .onChange(of: shown) { old, now in
      bare = false
      // Another file: what was being written on the last one waits for the person's return to it.
      desk.step(from: old ?? start, to: now ?? start)
      desk.marking = false
    }
    .commentToast(desk.toasts, lift: desk.foot)
    // A comment that goes by itself waits while its words are being changed here.
    .onChange(of: desk.editing?.id, initial: true) { _, id in session.setEditing(id, thread: thread) }
    .sheet(isPresented: $desk.listOpen) {
      CommentsSheet(session: session, thread: thread, current: at, toasts: desk.toasts) { comment in
        // After the sheet is down, so the viewer is on screen to move.
        Task { @MainActor in
          try? await Task.sleep(for: .milliseconds(350))
          desk.seek(comment)
        }
      } edit: { comment in
        Task { @MainActor in
          try? await Task.sleep(for: .milliseconds(350))
          desk.seek(comment)
          desk.edit(comment)
        }
      }
    }
    .onAppear {
      guard shown == nil else { return }
      shown = start
      if let seek {
        // Once the file is drawn.
        Task { @MainActor in
          try? await Task.sleep(for: .milliseconds(700))
          desk.seek(seek)
          if edits { desk.edit(seek) }
        }
      }
    }
    // How each file stands now (changed since sent, gone), asked once the cover is up.
    .task { await session.readAttachments(thread) }
    .onDisappear {
      shelf.closeAll(session)
      session.setEditing(nil, thread: thread)
    }
  }

  /// The More menu's way to comment on the whole file, in the window's words: a document's or a code file's
  /// Global comment (packages/ui/components/Viewer.tsx), a page's own comment (HtmlPageComment.tsx).
  private func wholeComment(_ item: AttachmentItem, url: URL) -> String? {
    guard session.takesComments(item, in: thread) else { return nil }
    switch FileFacts.shown(item.kind, name: item.name, size: Self.size(of: url)) {
    case .document, .text, .code: return PhoneWords.globalComment
    case .page: return PhoneWords.commentOnPage
    default: return nil
    }
  }

  /// The size of the bytes on screen.
  static func size(of url: URL) -> Int64 { (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize).flatMap { $0 }.map(Int64.init) ?? 0 }

  /// A picture, a video and a recording are shown on black, whatever the phone's appearance.
  static func onDark(_ item: AttachmentItem) -> Bool { [.picture, .player].contains(FileFacts.shown(item.kind, name: item.name, size: item.size)) }
}

/// One file in the cover: its viewer once its bytes are here, and until then where it stands.
struct FilePage: View {
  let session: InboxSession
  let thread: ThreadID
  let item: AttachmentItem
  let load: FileLoad
  /// How much of the screen the bars cover, at each edge.
  let bars: EdgeInsets
  /// The page on screen (the cover lays out the ones beside it too).
  let current: Bool
  @Binding var bare: Bool
  let desk: CommentDesk
  let close: () -> Void

  var body: some View {
    let (shownItem, version) = load.target(item, session: session)
    let size = version == .sent ? item.size : shownItem.current?.size ?? item.size
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
      case .tooLarge:
        Standing(symbol: "doc", words: PhoneWords.fileTooLarge(item.name))
      case .failed(let words):
        Standing(symbol: "doc", words: words, action: PhoneWords.tryAgain) { Task { await load.open(item, session: session) } }
      case .ready(let url):
        viewer(shown, url, CommentContext(session: session, thread: thread, item: item, version: version, desk: desk))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .environment(\.colorScheme, onDark ? .dark : colorScheme)
    .safeAreaInset(edge: .top, spacing: 0) {
      if !(bare && onDark) { VersionLine(item: shownItem, version: version, load: load, keptCopy: session.opening(item, asked: load.asked).keptCopy ? PhoneWords.away(session.computer.name) : nil) }
    }
    // A picture fills the screen and keeps clear of the bars itself; every other page starts under the title bar.
    .safeAreaPadding(.top, bars.top)
    .safeAreaPadding(.bottom, bars.bottom)
    // Opened again when another version is asked or the file's hash moves (the agent changed it).
    .task(id: InboxSession.cacheKey(shownItem, version)) { await load.open(item, session: session) }
  }

  @Environment(\.colorScheme) private var colorScheme

  @ViewBuilder private func viewer(_ shown: FileFacts.Shown, _ url: URL, _ context: CommentContext) -> some View {
    switch shown {
    case .picture: PicturePage(session: session, url: url, item: item, bars: bars, bare: $bare, context: context, current: current, close: close)
    case .document, .text, .code: WordsPage(url: url, item: item, shown: shown, context: context)
    // The page runs to the foot of the screen under the comment field, which floats over it; the keyboard still
    // takes its room, so what is being commented on stays in view.
    case .page: PinnedPage(url: url, name: item.name, context: context, foot: desk.foot).ignoresSafeArea(.container, edges: .bottom)
    case .player: PlayerPage(session: session, item: item, url: url, current: current)
    case .pdf: PDFPage(url: url).accessibilityIdentifier("file-pdf")
    case .card: FileCard(session: session, item: item, url: url)
    }
  }
}

/// The note over a file that is not what was sent: what is on screen, and the way to the other version.
struct VersionLine: View {
  /// The file as it is on screen (`FileLoad.target`) and the version shown.
  let item: AttachmentItem
  let version: AttachmentVersion
  let load: FileLoad
  /// The words for a copy this phone kept, shown while the computer is away: nothing says it is the file as it is
  /// now, and the sent version is not here to offer.
  var keptCopy: String?

  private var words: (line: String, link: String?, to: AttachmentVersion)? {
    if let keptCopy { return (keptCopy, nil, .current) }
    if let unavailable = item.unavailable { return (unavailable.code == .attachmentMissing ? PhoneWords.fileGone : PhoneWords.fileOtherKind, nil, .sent) }
    guard item.changedSinceSent == true || load.asked == .sent else { return nil }
    return version == .sent ? (PhoneWords.fileShowingSent, PhoneWords.viewCurrent, .current) : (PhoneWords.fileChanged, PhoneWords.viewSent, .sent)
  }

  var body: some View {
    if let words {
      VStack(spacing: 0) {
        HStack(alignment: .firstTextBaseline, spacing: Space.close) {
          Image(systemName: keptCopy == nil ? "clock.arrow.circlepath" : "wifi.slash").font(TextRole.meta).foregroundStyle(Token.mutedForeground).accessibilityHidden(true)
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

/// A file the phone does not draw (a zip, a text file past 16 MB, a picture or a recording the phone cannot read): what
/// it is, and the share sheet, which is how a phone saves a file or hands it to another app.
struct FileCard: View {
  let session: InboxSession
  let item: AttachmentItem
  let url: URL
  /// Why a file of a kind the phone draws is not drawn ("… does not show here.").
  var note: String?

  var body: some View {
    VStack(spacing: Space.card) {
      Image(systemName: FileGlyph.symbol(item)).font(.system(size: 34, weight: .regular)).foregroundStyle(Token.mutedForeground).thumbnail(Media.thumb).accessibilityHidden(true)
      VStack(spacing: Space.tight) {
        Text(item.name).font(TextRole.heading).foregroundStyle(Token.foreground).multilineTextAlignment(.center)
        Text(FileFacts.detail(item)).font(TextRole.secondary).monospacedDigit().foregroundStyle(Token.mutedForeground).multilineTextAlignment(.center)
        if let note { Text(note).font(TextRole.secondary).foregroundStyle(Token.mutedForeground).multilineTextAlignment(.center) }
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
