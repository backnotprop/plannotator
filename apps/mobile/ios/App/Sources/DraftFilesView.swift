import InboxCore
import InboxWire
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The paperclip of a reply or a new message (the window's "Attach files"): the photo library, the camera when the
/// phone has one, and Files. Each file shows as a tile at once and goes up to the computer.
struct AttachButton: View {
  let session: InboxSession
  let place: DraftPlace
  @State private var picking = false
  @State private var photos: [PhotosPickerItem] = []
  @State private var camera = false
  @State private var importing = false

  var body: some View {
    Menu {
      Button { picking = true } label: { Label(PhoneWords.photoLibrary, systemImage: "photo.on.rectangle") }
      if UIImagePickerController.isSourceTypeAvailable(.camera) {
        Button { camera = true } label: { Label(PhoneWords.takePhoto, systemImage: "camera") }
      }
      Button { importing = true } label: { Label(PhoneWords.chooseFiles, systemImage: "folder") }
    } label: {
      Image(systemName: "paperclip")
        .font(TextRole.label)
        .foregroundStyle(Token.mutedForeground)
        .touchTarget()
    }
    .accessibilityLabel(PhoneWords.attachFiles)
    .accessibilityIdentifier("attach")
    .barSized()
    .photosPicker(isPresented: $picking, selection: $photos, maxSelectionCount: 10, matching: .any(of: [.images, .videos]))
    .onChange(of: photos) { _, items in
      guard !items.isEmpty else { return }
      photos = []
      Task { for item in items { await add(item) } }
    }
    .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
      guard case .success(let urls) = result else { return }
      Task { for url in urls { await add(url) } }
    }
    .fullScreenCover(isPresented: $camera) {
      CameraPicker { data in
        Task {
          let named = name("photo", ext: "jpg")
          guard let data else { return told(session.attachFailed(name: named, type: "image/jpeg", to: place)) }
          told(await session.attach(data, name: named, type: "image/jpeg", to: place))
        }
      }
        .ignoresSafeArea()
    }
  }

  /// A picture or film from the library, handed over as a file: its size is read before any of it is, and it is
  /// copied, never held whole in memory. A HEIC picture goes as a JPEG: every agent reads that.
  private func add(_ item: PhotosPickerItem) async {
    let type = item.supportedContentTypes.first ?? .data
    let kind = type.conforms(to: .movie) ? "video" : "photo"
    let mime = type.preferredMIMEType ?? "application/octet-stream"
    guard let picked = try? await item.loadTransferable(type: PickedFile.self) else {
      return told(session.attachFailed(name: name(kind, ext: type.preferredFilenameExtension ?? "bin"), type: mime, to: place))
    }
    defer { picked.discard() }
    let size = (try? picked.url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize.map(Int64.init) ?? 0
    if type.conforms(to: .image), !type.conforms(to: .jpeg), !type.conforms(to: .png), size <= DraftFiles.maxBytes,
      let data = try? Data(contentsOf: picked.url), let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.9) {
      told(await session.attach(jpeg, name: name("photo", ext: "jpg"), type: "image/jpeg", to: place))
      return
    }
    let ext = type.preferredFilenameExtension ?? "bin"
    told(await session.attach(fileAt: picked.url, name: name(kind, ext: ext), type: mime, to: place))
  }

  /// A file from Files, under its own name: its size is read first, and it is copied rather than read into memory.
  private func add(_ url: URL) async {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    told(await session.attach(fileAt: url, name: url.lastPathComponent, type: type, to: place))
  }

  /// A file refused on the phone as it was attached (too large, or not read) shows its tile already refused, so the
  /// tile's own change never fires: VoiceOver hears it here, in the tile's words. One refused later by the computer
  /// is heard from its tile.
  private func told(_ file: DraftFile) {
    guard let words = file.refused else { return }
    AccessibilityNotification.Announcement("\(file.name), \(words)").post()
  }

  /// A picture or film from the phone has no name of its own: when it was added. Two added in the same second get
  /// "-2", "-3" after it, so no two files in a draft share a name.
  private func name(_ what: String, ext: String) -> String {
    Self.name(what, ext: ext, taken: Set(session.files(place).map(\.name)))
  }

  static func name(_ what: String, ext: String, taken: Set<String> = [], now: Date = Date()) -> String {
    let format = DateFormatter()
    format.locale = Locale(identifier: "en_US_POSIX")
    format.dateFormat = "yyyyMMdd-HHmmss"
    let stem = "\(what)-\(format.string(from: now))"
    var made = "\(stem).\(ext)"
    var count = 2
    while taken.contains(made) {
      made = "\(stem)-\(count).\(ext)"
      count += 1
    }
    return made
  }
}

/// A file the photo library hands over: a copy in the app's temporary folder, read from there and then let go.
struct PickedFile: Transferable {
  let url: URL

  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(importedContentType: .item) { received in
      let folder = FileManager.default.temporaryDirectory.appendingPathComponent("picked-\(UUID().uuidString)", isDirectory: true)
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      let copy = folder.appendingPathComponent(received.file.lastPathComponent)
      try FileManager.default.copyItem(at: received.file, to: copy)
      return PickedFile(url: copy)
    }
  }

  /// The temporary copy goes once the draft keeps its own.
  func discard() { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
}

/// The system's camera, for one photo.
struct CameraPicker: UIViewControllerRepresentable {
  /// The photo's bytes; nil when the camera handed over none the phone could read.
  let took: (Data?) -> Void
  @Environment(\.dismiss) private var dismiss

  func makeUIViewController(context: Context) -> UIImagePickerController {
    let picker = UIImagePickerController()
    picker.sourceType = .camera
    picker.delegate = context.coordinator
    return picker
  }

  func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    let parent: CameraPicker
    init(_ parent: CameraPicker) { self.parent = parent }

    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
      parent.took((info[.originalImage] as? UIImage)?.jpegData(compressionQuality: 0.9))
      parent.dismiss()
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
  }
}

/// A draft's files, one tile each, in a row that scrolls sideways: what each is, how it stands, and × to remove it.
struct DraftTiles: View {
  let session: InboxSession
  let place: DraftPlace
  /// The widest a tile is in the reply box (the window's 280 px chip).
  static let boxWidth: CGFloat = 280
  @ScaledMetric(relativeTo: .body) private var scrollHeight: CGFloat = 190

  var body: some View {
    let files = session.files(place)
    if !files.isEmpty {
      // One tile a row, as the window's reply box and New message show them at a phone's width (a chip that wraps,
      // at most 280 px wide, in the box; the whole width in New message): every tile's state reads in full, a refused
      // file's reason with it. Past three tiles the column scrolls, so the words keep their room.
      let column = VStack(alignment: .leading, spacing: Space.close) {
        ForEach(files) { file in
          DraftTile(session: session, file: file, place: place)
            .frame(maxWidth: place == .compose ? .infinity : Self.boxWidth, alignment: .leading)
        }
      }
      .padding(.horizontal, Space.step)
      .padding(.vertical, Space.close)
      .frame(maxWidth: .infinity, alignment: .leading)
      Group {
        if files.count > 3 {
          ScrollView(.vertical) { column }.frame(height: scrollHeight).scrollIndicators(.automatic)
        } else {
          column
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("draft-files")
    }
  }
}

struct DraftTile: View {
  let session: InboxSession
  let file: DraftFile
  let place: DraftPlace
  @State private var thumb: UIImage?
  @ScaledMetric(relativeTo: .body) private var side: CGFloat = 40

  /// The line under the name: how the file stands, in the window's words.
  private var line: (words: String, trouble: Bool) {
    switch session.fileState(file) {
    case .uploading: return (PhoneWords.uploading, false)
    case .attached: return ("\(FileFacts.kind(InboxAttachmentKind(rawValue: file.kind ?? "other"), name: file.name, mediaType: file.type)), \(FileFacts.bytes(file.size))", false)
    case .waiting: return (FileFacts.bytes(file.size), false)
    case .needsNetwork: return (PhoneWords.needsNetwork, false)
    case .refused(let words), .refusedForNow(let words): return (words, true)
    }
  }

  /// The computer could not take it just now: Try again sends it up again.
  private var mayRetry: Bool { if case .refusedForNow = session.fileState(file) { true } else { false } }

  /// What VoiceOver hears when the tile changes: the name and how it stands, once it is on the computer or refused
  /// (the window's refusal is an alert; the tile's own words, nothing new).
  private func tell(_ state: DraftFileState) {
    switch state {
    case .attached, .refused, .refusedForNow: AccessibilityNotification.Announcement("\(file.name), \(line.words)").post()
    case .uploading, .waiting, .needsNetwork: break
    }
  }

  var body: some View {
    let line = line
    HStack(spacing: Space.close) {
      Group {
        if let thumb {
          Image(uiImage: thumb).resizable().scaledToFill()
        } else {
          Image(systemName: file.type.hasPrefix("video/") ? "film" : "doc").font(TextRole.label).foregroundStyle(Token.mutedForeground)
        }
      }
      .frame(width: side, height: side)
      .background(Token.foreground.opacity(0.06))
      .clipShape(RoundedRectangle(cornerRadius: Radius.thumb, style: .continuous))
      .overlay {
        if session.fileState(file) == .uploading { ProgressView().controlSize(.small) }
      }
      .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Space.hair) {
        Text(file.name).font(TextRole.secondary).foregroundStyle(Token.foreground).lineLimit(1).truncationMode(.middle)
        Text(line.words).font(TextRole.caption).foregroundStyle(line.trouble ? Role.stop.ink : Token.mutedForeground)
          .fixedSize(horizontal: false, vertical: true)
        if mayRetry {
          Button(PhoneWords.tryAgain) { Task { await session.retryFile(file.id, in: place) } }
            .font(TextRole.caption.weight(.semibold))
            .foregroundStyle(Token.primary)
            .buttonStyle(PressStyle())
            .frame(minHeight: Space.touch, alignment: .leading)
            .accessibilityIdentifier("draft-file-retry")
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      // VoiceOver reads the name, then how it stands: a refused file's reason in full. Try again is its own button.
      .accessibilityElement(children: mayRetry ? .contain : .ignore)
      .accessibilityLabel("\(file.name), \(line.words)")
      .accessibilityIdentifier("draft-file-state")
      Button {
        withAnimation(Motion.fade.animation(still: false)) { session.removeFile(file.id, from: place) }
      } label: {
        Image(systemName: "xmark").font(TextRole.glyph).foregroundStyle(Token.mutedForeground).touchTarget()
      }
      .buttonStyle(PressStyle())
      .accessibilityLabel(PhoneWords.removeFile(file.name))
    }
    .padding(.leading, Space.close)
    .background(Token.foreground.opacity(0.05), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
    .barSized()
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("draft-file")
    .onChange(of: session.fileState(file)) { _, now in tell(now) }
    .task(id: file.id) {
      guard file.isPicture, let data = session.fileBytes(file) else { return }
      thumb = await Task.detached { UIImage(data: data)?.preparingThumbnail(of: CGSize(width: 120, height: 120)) }.value
    }
  }
}

/// The message a reply quotes, one quiet line over the words with × to take it away (the window's quote line).
struct QuoteLine: View {
  let thread: InboxThread
  let quote: DraftQuote
  let remove: () -> Void

  var body: some View {
    let message = thread.messages.first { $0.id == quote.of }
    let who = message.map { $0.author.kind == .person ? PhoneWords.you : Names.agent($0.author) } ?? ""
    let text = quote.words.map { "“\($0)”" } ?? (message?.body ?? "")
    HStack(spacing: Space.close) {
      Image(systemName: "arrowshape.turn.up.left").font(TextRole.meta).foregroundStyle(Token.mutedForeground).accessibilityHidden(true)
      if let message, message.author.kind == .agent { AgentMark(author: message.author, size: 16).accessibilityHidden(true) }
      Text(text.split(whereSeparator: \.isWhitespace).joined(separator: " "))
        .font(TextRole.secondary)
        .foregroundStyle(Token.mutedForeground)
        .lineLimit(1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel(PhoneWords.replyingTo(who, time: message.map { TimeWords().when($0.createdAt) } ?? "", words: quote.words != nil))
      Button(action: remove) {
        Image(systemName: "xmark").font(TextRole.glyph).foregroundStyle(Token.mutedForeground).touchTarget()
      }
      .buttonStyle(PressStyle())
      .accessibilityLabel(PhoneWords.removeQuote)
    }
    .padding(.leading, Space.card)
    .barSized()
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("quote-line")
  }
}

/// A sent reply's quote line (the window's `SentQuoteLine`): ↩, the quoted message's mark and its words, on one row; a
/// touch goes to that message. Nothing when the message is not in the thread.
struct SentQuoteLine: View {
  let thread: InboxThread
  let quote: InboxReplyQuote
  let go: (MessageID) -> Void

  var body: some View {
    if let message = thread.messages.first(where: { $0.id.rawValue == quote.of }) {
      let who = message.author.kind == .person ? PhoneWords.you : Names.agent(message.author)
      let text = quote.words.map { "“\($0)”" } ?? ReplyQuoteRules.withoutLead(message.body)
      Button { go(message.id) } label: {
        HStack(spacing: Space.close) {
          Image(systemName: "arrowshape.turn.up.left").font(TextRole.meta).foregroundStyle(Token.mutedForeground)
          if message.author.kind == .agent { AgentMark(author: message.author, size: 16) }
          Text(text.split(whereSeparator: \.isWhitespace).joined(separator: " "))
            .font(TextRole.secondary)
            .foregroundStyle(Token.mutedForeground)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: Space.touch)
        .contentShape(Rectangle())
      }
      .buttonStyle(PressStyle())
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(PhoneWords.replyingTo(who, time: TimeWords().when(message.createdAt), words: quote.words != nil))
      .accessibilityHint(PhoneWords.goToMessage)
      .accessibilityAddTraits(.isButton)
      .accessibilityIdentifier("sent-quote")
      .padding(.vertical, -Space.close)
    }
  }
}
