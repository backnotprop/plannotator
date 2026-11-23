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
      CameraPicker { data in Task { await session.attach(data, name: Self.name("photo", ext: "jpg"), type: "image/jpeg", to: place) } }
        .ignoresSafeArea()
    }
  }

  /// A picture from the library. A HEIC picture goes as a JPEG: every agent reads that.
  private func add(_ item: PhotosPickerItem) async {
    guard let data = try? await item.loadTransferable(type: Data.self) else { return }
    let type = item.supportedContentTypes.first ?? .data
    if type.conforms(to: .image), !type.conforms(to: .jpeg), !type.conforms(to: .png), let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.9) {
      await session.attach(jpeg, name: Self.name("photo", ext: "jpg"), type: "image/jpeg", to: place)
      return
    }
    let ext = type.preferredFilenameExtension ?? "bin"
    await session.attach(data, name: Self.name(type.conforms(to: .movie) ? "video" : "photo", ext: ext), type: type.preferredMIMEType ?? "application/octet-stream", to: place)
  }

  /// A file from Files, under its own name.
  private func add(_ url: URL) async {
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    guard let data = try? Data(contentsOf: url) else { return }
    let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    await session.attach(data, name: url.lastPathComponent, type: type, to: place)
  }

  /// A picture or film from the phone has no name of its own: when it was added.
  static func name(_ what: String, ext: String) -> String {
    let format = DateFormatter()
    format.locale = Locale(identifier: "en_US_POSIX")
    format.dateFormat = "yyyyMMdd-HHmmss"
    return "\(what)-\(format.string(from: Date())).\(ext)"
  }
}

/// The system's camera, for one photo.
struct CameraPicker: UIViewControllerRepresentable {
  let took: (Data) -> Void
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
      if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.9) { parent.took(data) }
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
    case .refused(let words): return (words, true)
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
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      // VoiceOver reads the name, then how it stands: a refused file's reason in full.
      .accessibilityElement(children: .ignore)
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
