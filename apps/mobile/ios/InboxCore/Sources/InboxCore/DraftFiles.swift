import Foundation
import InboxWire

/// A file the person attached to a reply or a new message, before it is sent. Its bytes are kept in the phone's copy
/// (so a draft survives the app being closed) and go up to the computer at once through `POST uploads`, as the
/// window's tiles do; a Send names the upload the computer answered.
public struct DraftFile: Codable, Hashable, Sendable, Identifiable {
  /// The phone's own name for it: the name its bytes are kept under.
  public var id: String
  /// The key of this attempt to send it up (`POST uploads`). The door answers a key it knows with what it answered
  /// first, forever, so each attempt has its own: `again` makes a new one. Nil: the first attempt, under `id`.
  public var uploadKey: String?
  public var name: String
  public var size: Int64
  /// Its media type, as the picker said it.
  public var type: String
  /// The computer's `upl_` id, once it has the file.
  public var upload: String?
  /// The kind the computer gave it (`InboxAttachmentKind`), once it has it.
  public var kind: String?
  /// The Inbox's own words when it did not take the file ("Not attached: …"): the file goes with no Send.
  public var refused: String?
  /// True when that refusal was for now only (the computer could not receive it, or had no room): Try again.
  public var mayRetry: Bool?

  public init(id: String = UUID().uuidString, name: String, size: Int64, type: String, upload: String? = nil, kind: String? = nil, refused: String? = nil, mayRetry: Bool? = nil) {
    self.id = id
    self.mayRetry = mayRetry
    self.name = name
    self.size = size
    self.type = type
    self.upload = upload
    self.kind = kind
    self.refused = refused
  }

  /// The idempotency key its next `POST uploads` goes with.
  var key: String { uploadKey ?? id }

  /// The same file, to go up again under a new key (the computer may no longer keep the upload: it sweeps one no
  /// Send named within a day, and the old key would only answer that upload's id again).
  var again: DraftFile {
    var copy = self
    copy.upload = nil
    copy.kind = nil
    copy.refused = nil
    copy.mayRetry = nil
    copy.uploadKey = UUID().uuidString
    return copy
  }

  public var isPicture: Bool { type.hasPrefix("image/") }
}

/// Where a draft's files belong: a thread's reply, or the new message being written.
public enum DraftPlace: Hashable, Sendable {
  case thread(ThreadID)
  case compose
}

/// How one attached file stands, as its tile says it.
public enum DraftFileState: Hashable, Sendable {
  /// On its way to the computer now.
  case uploading
  /// The computer has it: it goes with the next Send.
  case attached
  /// It waits for the computer: it goes up when the computer answers.
  case waiting
  /// The way in use (the relay) carries no files: it goes up once the phone is on the computer's network.
  case needsNetwork
  /// The Inbox did not take it, in its own words: it goes with no Send.
  case refused(String)
  /// The computer could not take it just now, in its words: Try again sends it up again.
  case refusedForNow(String)
}

/// The Send rule for files (the window's: "Wait for the files to finish uploading."): a Send goes only once every
/// file it would carry is on the computer. A file the Inbox refused is not carried and holds nothing up.
public enum DraftFiles {
  /// The uploads a Send names, in the order attached; nil while any file is not on the computer yet.
  public static func uploads(_ files: [DraftFile]) -> [String]? {
    let carried = files.filter { $0.refused == nil }
    guard carried.allSatisfy({ $0.upload != nil }) else { return nil }
    return carried.compactMap(\.upload)
  }

  /// Whether the files hold the Send up.
  public static func holdSend(_ files: [DraftFile]) -> Bool { uploads(files) == nil }

  /// What a Send of these files carries: the files themselves (for a hand-back), without the refused ones.
  static func carried(_ files: [DraftFile]) -> [DraftFile] { files.filter { $0.refused == nil } }

  static func bytesName(_ id: String) -> String { "draft-file-\(LocalCopy.name(id))" }

  /// The largest file the Inbox takes (`INBOX_UPLOAD_MAX_BYTES`, packages/core/inbox-types.ts): a larger one is
  /// refused on the phone, in the Inbox's own words, before any of it is read.
  public static let maxBytes: Int64 = 100 * 1024 * 1024

  /// Refusals that are for now only (packages/shared/inbox/uploads.ts): the file could not be received, or the
  /// computer has no room. A refusal of the file itself (by its name, or its size) is not.
  static func forNow(_ error: DoorError) -> Bool {
    error.code == "upload_no_space" || (error.code == "upload_refused" && error.field != "name")
  }

}

extension InboxSession {
  // MARK: Attached files

  /// The files of a draft, in the order attached.
  public func files(_ place: DraftPlace) -> [DraftFile] {
    switch place {
    case .thread(let id): return draftBook.local[id]?.files ?? []
    case .compose: return draftBook.compose?.files ?? []
    }
  }

  public func fileState(_ file: DraftFile) -> DraftFileState {
    if let refused = file.refused { return file.mayRetry == true ? .refusedForNow(refused) : .refused(refused) }
    if file.upload != nil { return .attached }
    if draftBook.uploading.contains(file.id) { return .uploading }
    if draftBook.needsNetwork.contains(file.id) { return .needsNetwork }
    return .waiting
  }

  /// Whether a file of these waits for the computer's own network (the way in use carries no files): what holds
  /// the Send is that, not an upload under way.
  public func filesNeedNetwork(_ files: [DraftFile]) -> Bool { files.contains { fileState($0) == .needsNetwork } }

  /// The kept bytes of an attached file (a picture's tile draws them).
  public func fileBytes(_ file: DraftFile) -> Data? { bytes(file.id) }

  /// A file's bytes are kept in the phone's copy; with no copy (the demo), in memory while the app runs.
  func keepBytes(_ data: Data, _ id: String) {
    if copy.folder == nil { draftBook.memory[id] = data } else { copy.write(data, to: DraftFiles.bytesName(id)) }
  }

  /// A file's bytes, mapped from the copy rather than read whole into memory.
  func bytes(_ id: String) -> Data? { copy.folder == nil ? draftBook.memory[id] : copy.read(DraftFiles.bytesName(id), mapped: true) }

  func dropBytes(_ id: String) {
    draftBook.memory[id] = nil
    copy.remove(DraftFiles.bytesName(id))
  }

  /// Attach a file: its bytes are kept at once, the tile shows, and it goes up to the computer.
  @discardableResult
  public func attach(_ data: Data, name: String, type: String, to place: DraftPlace) async -> DraftFile {
    let file = DraftFile(name: name.isEmpty ? "file" : name, size: Int64(data.count), type: type)
    guard file.size <= DraftFiles.maxBytes else { return refuse(file, Words.uploadTooLarge, in: place) }
    keepBytes(data, file.id)
    changeFiles(place) { $0.append(file) }
    await upload(file.id, in: place)
    return file
  }

  /// Attach a file the phone has on disk (Files, or a picture or film the library handed over as a file): its size
  /// is read first, and one larger than the Inbox takes is refused at once, in the Inbox's words, with none of it
  /// read. Otherwise it is copied into the phone's copy (never held whole in memory) and goes up from there. One the
  /// phone could not read is never dropped in silence: its tile says so.
  @discardableResult
  public func attach(fileAt url: URL, name: String, type: String, to place: DraftPlace) async -> DraftFile {
    let named = name.isEmpty ? "file" : name
    guard let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize.map(Int64.init) else { return attachFailed(name: named, type: type, to: place) }
    let file = DraftFile(name: named, size: size, type: type)
    guard size <= DraftFiles.maxBytes else { return refuse(file, Words.uploadTooLarge, in: place) }
    guard keepBytes(from: url, file.id) else { return attachFailed(name: named, type: type, to: place) }
    changeFiles(place) { $0.append(file) }
    await upload(file.id, in: place)
    return file
  }

  /// A file the person picked that the phone could not read (the library did not hand it over, or it could not be
  /// copied): its tile says so in the Inbox's words for a file it could not receive, and the person attaches it again.
  /// Nothing of it is kept, so there is nothing to send up again from the tile.
  @discardableResult
  public func attachFailed(name: String, type: String, to place: DraftPlace) -> DraftFile {
    refuse(DraftFile(name: name.isEmpty ? "file" : name, size: 0, type: type), Words.uploadNotReceived, in: place)
  }

  /// A file refused on the phone: its tile says why, and nothing of it is kept or sent.
  private func refuse(_ file: DraftFile, _ words: String, in place: DraftPlace) -> DraftFile {
    var refused = file
    refused.refused = words
    changeFiles(place) { $0.append(refused) }
    return refused
  }

  /// Copy a file's bytes into the phone's copy (with no copy, the demo, they are read into memory).
  func keepBytes(from url: URL, _ id: String) -> Bool {
    guard copy.folder != nil else {
      guard let data = try? Data(contentsOf: url, options: .alwaysMapped) else { return false }
      draftBook.memory[id] = Data(data)
      return true
    }
    return copy.copyFile(url, to: DraftFiles.bytesName(id))
  }

  /// A file the computer could not take just now (it could not receive it, or had no room): it goes up again.
  public func retryFile(_ id: String, in place: DraftPlace) async {
    changeFiles(place) { files in
      guard let index = files.firstIndex(where: { $0.id == id }), files[index].mayRetry == true else { return }
      files[index] = files[index].again
    }
    await upload(id, in: place)
  }

  /// Take a file out of a draft. Its bytes on the phone go with it.
  public func removeFile(_ id: String, from place: DraftPlace) {
    changeFiles(place) { $0.removeAll { $0.id == id } }
    draftBook.needsNetwork.remove(id)
    if !held.contains(where: { ($0.files ?? []).contains { $0.id == id } }) { dropBytes(id) }
  }

  func changeFiles(_ place: DraftPlace, _ change: (inout [DraftFile]) -> Void) {
    switch place {
    case .thread(let id):
      changeDraft(id) { draft in
        var files = draft.files ?? []
        change(&files)
        draft.files = files
      }
    case .compose:
      var draft = draftBook.compose ?? ComposeDraft(editedAt: clock.now())
      change(&draft.files)
      keepCompose(draft)
    }
  }

  /// The files bytes were sent with are on the computer now: the phone lets go of its copy.
  func releaseBytes(_ files: [DraftFile]) {
    for file in files { dropBytes(file.id) }
  }

  /// Every attached file not on the computer yet goes up now (when the computer answers again).
  func uploadWaitingFiles() async {
    let places: [DraftPlace] = draftBook.local.keys.map { .thread($0) } + [.compose]
    for place in places { await uploadWaiting(place) }
  }

  /// A draft's files not on the computer yet go up now (its screen opened).
  public func uploadWaiting(_ place: DraftPlace) async {
    for file in files(place) where file.upload == nil && file.refused == nil { await upload(file.id, in: place) }
  }

  /// Send one file's bytes to the computer (`POST uploads`, the attempt's key and the name in the query).
  func upload(_ id: String, in place: DraftPlace) async {
    guard let file = files(place).first(where: { $0.id == id }), file.upload == nil, file.refused == nil, !draftBook.uploading.contains(id) else { return }
    if client == nil { _ = await connect() }
    guard let client, offers(DoorRoutes.postUploads) else { return }
    // A way that carries no files (the relay): the bytes never cross it only to be refused at the computer.
    guard client.transport.carriesFiles else {
      draftBook.needsNetwork.insert(id)
      return
    }
    guard let data = bytes(id) else { return }
    draftBook.uploading.insert(id)
    defer { draftBook.uploading.remove(id) }
    switch await sendUp(file, data, with: client) {
    case .kept(let upload, let kind):
      draftBook.needsNetwork.remove(id)
      // Removed while it was on its way: the computer sweeps an upload no Send names.
      changeFiles(place) { files in
        guard let index = files.firstIndex(where: { $0.id == id }) else { return }
        files[index].upload = upload
        files[index].kind = kind
      }
    case .needsNetwork:
      draftBook.needsNetwork.insert(id)
    case .refused(let words, let forNow):
      changeFiles(place) { files in
        guard let index = files.firstIndex(where: { $0.id == id }) else { return }
        files[index].refused = words
        files[index].mayRetry = forNow ? true : nil
      }
    case .noAnswer:
      break
    }
  }

  enum SentUp {
    case kept(upload: String, kind: String)
    case needsNetwork
    case refused(String, forNow: Bool)
    case noAnswer
  }

  /// One `POST uploads` under the file's key.
  func sendUp(_ file: DraftFile, _ data: Data, with client: DoorClient) async -> SentUp {
    do {
      let answer = try await client.sendBytes(
        path: Door.postUploads().path,
        query: [URLQueryItem(name: "name", value: file.name), URLQueryItem(name: "idempotency_key", value: file.key)],
        body: data, type: file.type.isEmpty ? "application/octet-stream" : file.type)
      let kept = try JSONDecoder().decode(DoorUploadAnswer.self, from: answer.body)
      return .kept(upload: kept.upload.uploadId.rawValue, kind: kept.upload.kind.rawValue)
    } catch let failure as DoorFailure {
      guard case .refused(_, let error) = failure else {
        note(failure)
        return .noAnswer
      }
      if error.code == WireErrorCode.relayUploadUnavailable.rawValue { return .needsNetwork }
      // The computer's disk is full (a 507): said on the tile, with Try again, rather than waited on in silence.
      guard failure.isDefinite || DraftFiles.forNow(error) else { return .noAnswer }
      return .refused(error.error, forNow: DraftFiles.forNow(error))
    } catch {
      return .noAnswer
    }
  }

  /// A Send the computer refused because an upload it named is gone (swept after a day, unnamed by any draft on the
  /// computer): each of its files goes up again under a new key, and the Send is made again, once, naming them. The
  /// person sees nothing of it. False when a file could not go up: the Send is refused as usual then.
  func sendFilesAgain(_ write: HeldWrite) async -> Bool {
    guard write.reuploaded != true, let files = write.files, !files.isEmpty, let client, client.transport.carriesFiles,
      case .object(var body)? = try? JSONDecoder().decode(JSONValue.self, from: write.body)
    else { return false }
    var again: [DraftFile] = []
    for file in files {
      var next = file.again
      guard let data = bytes(file.id), case .kept(let upload, let kind) = await sendUp(next, data, with: client) else { return false }
      next.upload = upload
      next.kind = kind
      again.append(next)
    }
    guard let index = held.firstIndex(where: { $0.id == write.id }) else { return false }
    let key = UUID().uuidString
    body["uploads"] = .array(again.compactMap(\.upload).map { .string($0) })
    body["idempotency_key"] = .string(key)
    held[index].id = key
    held[index].body = (try? JSONEncoder().encode(JSONValue.object(body))) ?? write.body
    held[index].files = again
    held[index].reuploaded = true
    saveOutbox()
    return true
  }
}
