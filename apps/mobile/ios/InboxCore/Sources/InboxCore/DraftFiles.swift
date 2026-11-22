import Foundation
import InboxWire

/// A file the person attached to a reply or a new message, before it is sent. Its bytes are kept in the phone's copy
/// (so a draft survives the app being closed) and go up to the computer at once through `POST uploads`, as the
/// window's tiles do; a Send names the upload the computer answered.
public struct DraftFile: Codable, Hashable, Sendable, Identifiable {
  /// The phone's own name for it: the name its bytes are kept under, and the upload's idempotency key.
  public var id: String
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

  public init(id: String = UUID().uuidString, name: String, size: Int64, type: String, upload: String? = nil, kind: String? = nil, refused: String? = nil) {
    self.id = id
    self.name = name
    self.size = size
    self.type = type
    self.upload = upload
    self.kind = kind
    self.refused = refused
  }

  /// The same file, to go up again (a refused Send may name an upload the computer no longer keeps).
  var again: DraftFile {
    var copy = self
    copy.upload = nil
    copy.kind = nil
    return copy
  }

  var isPicture: Bool { type.hasPrefix("image/") }
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
    if let refused = file.refused { return .refused(refused) }
    if file.upload != nil { return .attached }
    if draftBook.uploading.contains(file.id) { return .uploading }
    if draftBook.needsNetwork.contains(file.id) { return .needsNetwork }
    return .waiting
  }

  /// The kept bytes of an attached file (a picture's tile draws them).
  public func fileBytes(_ file: DraftFile) -> Data? { bytes(file.id) }

  /// A file's bytes are kept in the phone's copy; with no copy (the demo), in memory while the app runs.
  func keepBytes(_ data: Data, _ id: String) {
    if copy.folder == nil { draftBook.memory[id] = data } else { copy.write(data, to: DraftFiles.bytesName(id)) }
  }

  func bytes(_ id: String) -> Data? { copy.folder == nil ? draftBook.memory[id] : copy.read(DraftFiles.bytesName(id)) }

  func dropBytes(_ id: String) {
    draftBook.memory[id] = nil
    copy.remove(DraftFiles.bytesName(id))
  }

  /// Attach a file: its bytes are kept at once, the tile shows, and it goes up to the computer.
  @discardableResult
  public func attach(_ data: Data, name: String, type: String, to place: DraftPlace) async -> DraftFile {
    let file = DraftFile(name: name.isEmpty ? "file" : name, size: Int64(data.count), type: type)
    keepBytes(data, file.id)
    changeFiles(place) { $0.append(file) }
    await upload(file.id, in: place)
    return file
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

  /// Send one file's bytes to the computer (`POST uploads`, the key and the name in the query).
  func upload(_ id: String, in place: DraftPlace) async {
    guard let file = files(place).first(where: { $0.id == id }), file.upload == nil, file.refused == nil, !draftBook.uploading.contains(id) else { return }
    if client == nil { _ = await connect() }
    guard let client, offers(DoorRoutes.postUploads), let data = bytes(id) else { return }
    draftBook.uploading.insert(id)
    defer { draftBook.uploading.remove(id) }
    do {
      let answer = try await client.sendBytes(
        path: Door.postUploads().path,
        query: [URLQueryItem(name: "name", value: file.name), URLQueryItem(name: "idempotency_key", value: id)],
        body: data, type: file.type.isEmpty ? "application/octet-stream" : file.type)
      let kept = try JSONDecoder().decode(DoorUploadAnswer.self, from: answer.body)
      draftBook.needsNetwork.remove(id)
      // Removed while it was on its way: the computer sweeps an upload no Send names.
      changeFiles(place) { files in
        guard let index = files.firstIndex(where: { $0.id == id }) else { return }
        files[index].upload = kept.upload.uploadId.rawValue
        files[index].kind = kept.upload.kind.rawValue
      }
    } catch let failure as DoorFailure {
      guard case .refused(_, let error) = failure else {
        note(failure)
        return
      }
      if error.code == WireErrorCode.relayUploadUnavailable.rawValue {
        draftBook.needsNetwork.insert(id)
        return
      }
      guard failure.isDefinite else { return }
      changeFiles(place) { files in
        guard let index = files.firstIndex(where: { $0.id == id }) else { return }
        files[index].refused = error.error
      }
    } catch {}
  }
}
