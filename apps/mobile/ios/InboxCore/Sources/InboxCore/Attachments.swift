import CryptoKit
import Foundation
import InboxWire

/// One file a message carries, as the phone lists it: the record it was sent with, and, once the computer was asked
/// (`GET threads/:id/attachments`), the file as it is now.
public struct AttachmentItem: Hashable, Sendable, Identifiable {
  public var id: AttachmentID
  public var message: MessageID
  /// An unknown kind is a file (packages/core/inbox-attachments.ts `inboxAttachmentKindOf`).
  public var kind: InboxAttachmentKind
  public var name: String
  /// Where the file is on the computer: the feedback names it by this, inside its project.
  public var path: String = ""
  /// The size it was sent at.
  public var size: Int64
  public var sentSha256: String
  public var sentAt: String
  public var mediaType: String?
  /// A picture's or a video's own size in pixels, and a video's or a recording's length, when the computer read them.
  public var width: Double?
  public var height: Double?
  public var durationMs: Int64?
  /// A picture the message's words show (`ref`), not a file attached beside them.
  public var inline: Bool
  /// The file on the computer now differs from what was sent. Nil until the computer was asked.
  public var changedSinceSent: Bool?
  /// The file on the computer now, or nil when it cannot be opened (`unavailable` says why) or was not asked.
  public var current: InboxAttachmentStateCurrent?
  public var unavailable: InboxAttachmentStateUnavailable?

  /// Read as words through `view` (markdown, text, html, code, diagrams); the others are bytes.
  public var isText: Bool { ![.image, .video, .audio, .pdf, .file].contains(kind) }
  /// Video and audio: comments at moments.
  public var isTimed: Bool { kind == .video || kind == .audio }
  /// Everything but a PDF or another file takes comments.
  public var takesComments: Bool { kind != .pdf && kind != .file }

  /// Which version opens first: the current file, as the window opens it; the sent version when the current one
  /// cannot be opened, or until the computer was asked how the file stands (the sent version is the one whose hash
  /// the phone knows, so it is checked, and it opens from the cache with the computer away).
  public var opens: AttachmentVersion { unavailable == nil && changedSinceSent != nil ? .current : .sent }

  init(record: InboxAttachment, message: MessageID, inline: Bool) {
    id = AttachmentID(record.id)
    self.message = message
    kind = Self.known(record.kind)
    name = record.name
    path = record.path
    size = record.size
    sentSha256 = record.sentSha256
    sentAt = record.sentAt
    mediaType = record.mediaType
    width = record.width
    height = record.height
    durationMs = record.durationMs
    self.inline = inline
  }

  init(state: InboxAttachmentState) {
    id = AttachmentID(state.id)
    message = state.messageId
    kind = Self.known(state.kind)
    name = state.name
    path = state.path
    size = state.size
    sentSha256 = state.sentSha256
    sentAt = state.sentAt
    mediaType = state.mediaType
    width = state.width
    height = state.height
    durationMs = state.durationMs
    inline = state.ref != nil
    take(state)
  }

  mutating func take(_ state: InboxAttachmentState) {
    changedSinceSent = state.changedSinceSent
    current = state.current
    unavailable = state.unavailable
  }

  static func known(_ kind: InboxAttachmentKind) -> InboxAttachmentKind {
    if case .unknown = kind { return .file }
    return kind
  }

  /// A thread's files, message by message in the thread's order, each message's attached files before the pictures
  /// its words show; with what the computer said of each when it was asked.
  public static func list(_ thread: InboxThread, states: [InboxAttachmentState]? = nil) -> [AttachmentItem] {
    var items: [AttachmentItem] = []
    for message in thread.messages {
      for record in message.attachments ?? [] { items.append(AttachmentItem(record: record, message: message.id, inline: false)) }
      for image in message.inlineImages ?? [] {
        guard let data = try? JSONEncoder().encode(image), let record = try? JSONDecoder().decode(InboxAttachment.self, from: data) else { continue }
        items.append(AttachmentItem(record: record, message: message.id, inline: true))
      }
    }
    guard let states else { return items }
    let byID = Dictionary(states.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    for index in items.indices { if let state = byID[items[index].id.rawValue] { items[index].take(state) } }
    // A file the computer lists that the copy of the thread does not have yet.
    for state in states where !items.contains(where: { $0.id.rawValue == state.id }) { items.append(AttachmentItem(state: state)) }
    return items
  }
}

/// Which bytes of a file: as it is on the computer now, or as it was sent (`?version=`).
public enum AttachmentVersion: String, Hashable, Sendable { case current, sent }

/// The bytes of attachments kept on the phone: one folder per computer in the caches folder, least recently opened
/// out first past the budget (SPEC 1.5: default 500 MB, the person may set it). Erased with the computer.
public final class AttachmentCache: @unchecked Sendable {
  public static let defaultBudget: Int64 = 500 * 1_000_000

  struct Entry: Codable, Hashable {
    var file: String
    var size: Int64
    var opened: Date
  }

  struct Partial: Codable, Hashable {
    var etag: String?
    var total: Int64?
    var received: Int64
  }

  public let folder: URL?
  public var budget: Int64 {
    get { lock.withLock { limit } }
    set { lock.withLock { limit = newValue }; evict(keeping: nil) }
  }

  private let lock = NSLock()
  private var limit: Int64
  private var index: [String: Entry]
  /// Moves on each erase: a fetch begun before it writes nothing after it (the bytes of a removed computer).
  private var generation = 0
  /// Held for each write of bytes and for an erase, so no write lands in the middle of one.
  private let writing = NSLock()
  /// Keys open in a viewer or being fetched, with how many hold each: never evicted.
  private var inUse: [String: Int] = [:]

  public init(folder: URL?, budget: Int64 = AttachmentCache.defaultBudget) {
    self.folder = folder
    limit = budget
    index = folder.flatMap { try? Data(contentsOf: $0.appendingPathComponent("index.json")) }.flatMap { try? JSONDecoder().decode([String: Entry].self, from: $0) } ?? [:]
  }

  public static func folder(caches: URL, computer id: String) -> URL {
    caches.appendingPathComponent("attachments", isDirectory: true).appendingPathComponent(LocalCopy.name(id), isDirectory: true)
  }

  /// Erase the bytes of computers this phone is no longer paired with.
  public static func sweep(caches: URL, keeping ids: [String]) {
    let root = caches.appendingPathComponent("attachments", isDirectory: true)
    let keep = Set(ids.map(LocalCopy.name))
    for item in (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? [] where !keep.contains(item.lastPathComponent) {
      try? FileManager.default.removeItem(at: item)
    }
  }

  static func fileName(_ key: String) -> String { SHA256.hash(data: Data(key.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined() }

  /// Bytes in the cache now.
  public var used: Int64 { lock.withLock { index.values.reduce(0) { $0 + $1.size } } }

  public func contains(_ key: String) -> Bool { lock.withLock { index[key] != nil } }

  /// The kept files whose keys start with `prefix` (one file's versions: `att_…@`), as they stand.
  public func entries(prefix: String) -> [(key: String, size: Int64, opened: Date)] {
    guard let folder else { return [] }
    let found = lock.withLock { index.filter { $0.key.hasPrefix(prefix) } }
    return found.filter { FileManager.default.fileExists(atPath: folder.appendingPathComponent($0.value.file).path) }.map { ($0.key, $0.value.size, $0.value.opened) }
  }

  /// The kept file for a key, as it stands: nothing written and not marked opened (a row asking whether a file is
  /// kept has not opened it).
  public func kept(_ key: String) -> URL? {
    guard let folder, let entry = lock.withLock({ index[key] }) else { return nil }
    let url = folder.appendingPathComponent(entry.file)
    return FileManager.default.fileExists(atPath: url.path) ? url : nil
  }

  /// Keep a key's file while it is open in a viewer or being fetched: room is never made with it. Each `hold` ends
  /// with one `release`.
  public func hold(_ key: String) { lock.withLock { inUse[key, default: 0] += 1 } }
  public func release(_ key: String) {
    lock.withLock {
      let left = (inUse[key] ?? 0) - 1
      inUse[key] = left > 0 ? left : nil
    }
  }

  /// The erase a write began under: a write under an earlier one does nothing.
  var current: Int { lock.withLock { generation } }

  /// Do one write of bytes, unless the cache was erased since `since`. False when it was.
  func write(since: Int, _ body: () throws -> Void) rethrows -> Bool {
    try writing.withLock {
      guard current == since else { return false }
      try body()
      return true
    }
  }

  /// The kept file for a key, marked opened now (it goes last when room is made).
  public func file(_ key: String, now: Date = Date()) -> URL? {
    guard let folder else { return nil }
    let found: URL? = lock.withLock {
      guard var entry = index[key] else { return nil }
      let url = folder.appendingPathComponent(entry.file)
      guard FileManager.default.fileExists(atPath: url.path) else {
        index[key] = nil
        return nil
      }
      entry.opened = now
      index[key] = entry
      return url
    }
    if found != nil { saveIndex() }
    return found
  }

  private func prepare() {
    guard let folder else { return }
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    var target = folder
    try? target.setResourceValues(values)
  }

  /// Write the index into the folder. Never makes the folder: one that is gone was erased, and a write of bytes makes
  /// it again.
  private func saveIndex() {
    guard let folder else { return }
    writing.withLock {
      guard FileManager.default.fileExists(atPath: folder.path) else { return }
      let data: Data? = lock.withLock { try? JSONEncoder().encode(index) }
      try? data?.write(to: folder.appendingPathComponent("index.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
  }

  /// Keep bytes under a key, then make room.
  @discardableResult
  public func store(_ key: String, data: Data, now: Date = Date()) -> URL? { store(key, data: data, now: now, since: current) }

  func store(_ key: String, data: Data, now: Date = Date(), since: Int) -> URL? {
    guard let folder else { return nil }
    let name = Self.fileName(key)
    let url = folder.appendingPathComponent(name)
    let wrote = (try? write(since: since) {
      prepare()
      try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      lock.withLock { index[key] = Entry(file: name, size: Int64(data.count), opened: now) }
    }) ?? false
    guard wrote else { return nil }
    evict(keeping: key)
    saveIndex()
    return url
  }

  /// A finished partial file becomes the kept file. Nil when it could not, or the cache was erased since `since`.
  func commit(_ key: String, now: Date = Date(), since: Int) -> URL? {
    guard let folder else { return nil }
    let name = Self.fileName(key)
    let url = folder.appendingPathComponent(name)
    let part = partialURL(key)
    let wrote = (try? write(since: since) {
      try? FileManager.default.removeItem(at: url)
      try FileManager.default.moveItem(at: part, to: url)
      try? FileManager.default.removeItem(at: partialMetaURL(key))
      let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value ?? 0
      lock.withLock { index[key] = Entry(file: name, size: size, opened: now) }
    }) ?? false
    guard wrote else { return nil }
    evict(keeping: key)
    saveIndex()
    return url
  }

  /// Make room until the cache fits its budget: first the parts of fetches that stopped (oldest first), then the least
  /// recently opened file. Never `keeping` (the file just kept), a file open in a viewer, or a fetch under way.
  func evict(keeping key: String?) {
    guard let folder else { return }
    let busy: Set<String> = lock.withLock {
      var keys: [String] = Array(inUse.keys)
      if let key { keys.append(key) }
      return Set(keys.map(Self.fileName))
    }
    let parts = ((try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey])) ?? [])
      .filter { $0.pathExtension == "part" }
      .map { url -> (url: URL, size: Int64, changed: Date) in
        let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
        return (url, Int64(values?.fileSize ?? 0), values?.contentModificationDate ?? .distantPast)
      }
    var drop: [URL] = []
    lock.withLock {
      var total = index.values.reduce(0) { $0 + $1.size } + parts.reduce(0) { $0 + $1.size }
      for part in parts.sorted(by: { $0.changed < $1.changed }) where total > limit && !busy.contains(part.url.deletingPathExtension().lastPathComponent) {
        total -= part.size
        drop += [part.url, part.url.appendingPathExtension("json")]
      }
      for (name, entry) in index.sorted(by: { $0.value.opened < $1.value.opened }) where total > limit && name != key && inUse[name] == nil {
        total -= entry.size
        drop.append(folder.appendingPathComponent(entry.file))
        index[name] = nil
      }
    }
    for file in drop { try? FileManager.default.removeItem(at: file) }
    if !drop.isEmpty { saveIndex() }
  }

  // MARK: Partial files, for a fetch that resumes where it stopped

  func partialURL(_ key: String) -> URL { (folder ?? FileManager.default.temporaryDirectory).appendingPathComponent(Self.fileName(key) + ".part") }
  private func partialMetaURL(_ key: String) -> URL { (folder ?? FileManager.default.temporaryDirectory).appendingPathComponent(Self.fileName(key) + ".part.json") }

  func partial(_ key: String) -> Partial? {
    guard let data = try? Data(contentsOf: partialMetaURL(key)), let meta = try? JSONDecoder().decode(Partial.self, from: data) else { return nil }
    let size = (try? FileManager.default.attributesOfItem(atPath: partialURL(key).path)[.size] as? NSNumber)?.int64Value ?? -1
    return size == meta.received ? meta : nil
  }

  func savePartial(_ key: String, _ meta: Partial, since: Int) {
    _ = write(since: since) {
      prepare()
      if let data = try? JSONEncoder().encode(meta) { try? data.write(to: partialMetaURL(key), options: .atomic) }
    }
  }

  func dropPartial(_ key: String) {
    try? FileManager.default.removeItem(at: partialURL(key))
    try? FileManager.default.removeItem(at: partialMetaURL(key))
  }

  /// Remove the computer: every byte kept for it goes, and a fetch under way keeps nothing.
  public func erase() {
    writing.withLock {
      lock.withLock {
        index = [:]
        generation += 1
      }
      if let folder { try? FileManager.default.removeItem(at: folder) }
    }
  }
}

/// Why bytes did not come.
public enum ByteFetchError: Error, Hashable, Sendable {
  /// Bigger than the phone takes (`size`, when known, against `cap`).
  case tooLarge(size: Int64, cap: Int64)
  /// The file changed on the computer while it came: the version the phone was told of is gone. Read the thread's
  /// files again (`readAttachments`), then open the version the computer has now.
  case changed
  /// The bytes are not the ones the computer named (their SHA-256 differs).
  case damaged
  /// The computer refused, in its words.
  case refused(status: Int, code: String, words: String)
  /// An answer the phone could not read.
  case unreadable(status: Int)
}

/// Fetches one file's bytes through the door into the cache: in parts of at most 8 MiB where the route takes a
/// Range (the door's cap on a 206, packages/server/inbox-byte-range.ts), so a fetch reports progress, stops when its
/// task is cancelled and resumes from where it stopped (each part's ETag keeps the parts of one version); whole
/// otherwise.
public struct ByteFetch: Sendable {
  public static let part: Int64 = 8 * 1024 * 1024

  public let client: DoorClient
  public let cache: AttachmentCache

  public init(client: DoorClient, cache: AttachmentCache) {
    self.client = client
    self.cache = cache
  }

  /// Fetch `request` into the cache under `key`. `size`: the size the computer named, checked against `cap` before
  /// anything is fetched; `sha256`: the hash the bytes must have, when the wire names one.
  public func fetch(_ request: DoorRequest, query: [URLQueryItem] = [], key: String, size: Int64?, sha256: String?, cap: Int64, ranged: Bool,
    progress: @Sendable (Int64, Int64?) -> Void = { _, _ in }) async throws -> URL {
    if let kept = cache.file(key) { return kept }
    if let size, size > cap { throw ByteFetchError.tooLarge(size: size, cap: cap) }
    try Task.checkCancellation()
    // Bytes of a computer removed while they came are never kept.
    let since = cache.current
    cache.hold(key)
    defer { cache.release(key) }
    func erased() throws { if cache.current != since { throw CancellationError() } }
    if !ranged {
      let answer = try await client.bytes(request, query: query)
      guard Int64(answer.body.count) <= cap else { throw ByteFetchError.tooLarge(size: Int64(answer.body.count), cap: cap) }
      try Self.check(answer.body, sha256)
      progress(Int64(answer.body.count), Int64(answer.body.count))
      guard let url = cache.store(key, data: answer.body, since: since) else {
        try erased()
        throw ByteFetchError.unreadable(status: answer.status)
      }
      return url
    }
    var meta = cache.partial(key) ?? AttachmentCache.Partial(etag: nil, total: nil, received: 0)
    if meta.received == 0 { cache.dropPartial(key) }
    // A hash the bytes must have: a file that changed can never match it.
    let named: Bool = sha256.map { !$0.hasPrefix("stat:") } ?? false
    // The file starts again at most once: a file that keeps changing (a log, a video still rendering) ends the fetch.
    var restarted = false
    func again(_ failure: ByteFetchError) throws {
      cache.dropPartial(key)
      if restarted { throw failure }
      restarted = true
      meta = AttachmentCache.Partial(etag: nil, total: nil, received: 0)
    }
    while meta.total.map({ meta.received < $0 }) ?? true {
      try Task.checkCancellation()
      // No If-Range: the door answers a mismatch with the whole file, uncapped. Each part names its version (ETag)
      // instead, and a part of another version starts the file again, still in parts.
      let headers = ["Range": "bytes=\(meta.received)-\(meta.received + Self.part - 1)"]
      let answer = try await client.bytes(request, query: query, headers: headers)
      switch answer.status {
      case 206:
        guard let range = Self.contentRange(answer.headers["content-range"]) else { throw ByteFetchError.unreadable(status: 206) }
        if range.total > cap { throw ByteFetchError.tooLarge(size: range.total, cap: cap) }
        let etag: String? = answer.headers["etag"]
        var changed = false
        if meta.received > 0, let kept = meta.etag, let etag, etag != kept { changed = true }
        if changed {
          // Another version than the parts kept.
          if named {
            cache.dropPartial(key)
            throw ByteFetchError.changed
          }
          try again(.changed)
          continue
        }
        // Not where this fetch stopped, or the parts kept are gone (made room for): start the file again.
        let partKept: Bool = meta.received == 0 || cache.partial(key)?.received == meta.received
        guard range.start == meta.received, partKept else {
          try again(.unreadable(status: 206))
          continue
        }
        guard try append(answer.body, to: key, fresh: meta.received == 0, since: since) else { throw CancellationError() }
        meta = AttachmentCache.Partial(etag: answer.headers["etag"] ?? meta.etag, total: range.total, received: meta.received + Int64(answer.body.count))
      case 200:
        // The whole file: the door took no Range.
        guard Int64(answer.body.count) <= cap else { throw ByteFetchError.tooLarge(size: Int64(answer.body.count), cap: cap) }
        guard try append(answer.body, to: key, fresh: true, since: since) else { throw CancellationError() }
        meta = AttachmentCache.Partial(etag: answer.headers["etag"], total: Int64(answer.body.count), received: Int64(answer.body.count))
      case 416:
        // Past the end: what the phone had is not this file. Start again.
        if meta.received == 0 {
          cache.dropPartial(key)
          throw ByteFetchError.unreadable(status: 416)
        }
        try again(.unreadable(status: 416))
        continue
      default:
        throw ByteFetchError.unreadable(status: answer.status)
      }
      cache.savePartial(key, meta, since: since)
      try erased()
      progress(meta.received, meta.total)
      if answer.body.isEmpty, meta.total.map({ meta.received < $0 }) ?? true { throw ByteFetchError.unreadable(status: answer.status) }
    }
    if let sha256 {
      let data = (try? Data(contentsOf: cache.partialURL(key), options: .mappedIfSafe)) ?? Data()
      do { try Self.check(data, sha256) } catch {
        cache.dropPartial(key)
        throw error
      }
    }
    guard let url = cache.commit(key, since: since) else {
      try erased()
      throw ByteFetchError.unreadable(status: 200)
    }
    return url
  }

  /// False when the cache was erased since the fetch began: nothing is written.
  private func append(_ data: Data, to key: String, fresh: Bool, since: Int) throws -> Bool {
    let url = cache.partialURL(key)
    return try cache.write(since: since) {
      if let folder = cache.folder { try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true) }
      if fresh {
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return
      }
      // The parts before this one are gone: never a file missing its first bytes.
      guard FileManager.default.fileExists(atPath: url.path) else { throw ByteFetchError.unreadable(status: 206) }
      let handle = try FileHandle(forWritingTo: url)
      defer { try? handle.close() }
      try handle.seekToEnd()
      try handle.write(contentsOf: data)
    }
  }

  static func check(_ data: Data, _ sha256: String?) throws {
    guard let sha256, !sha256.hasPrefix("stat:") else { return }
    let found = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    if found != sha256.lowercased() { throw ByteFetchError.damaged }
  }

  /// `bytes a-b/total`.
  static func contentRange(_ header: String?) -> (start: Int64, end: Int64, total: Int64)? {
    guard let header, let match = header.wholeMatch(of: /bytes (\d+)-(\d+)\/(\d+)/), let start = Int64(match.1), let end = Int64(match.2), let total = Int64(match.3) else { return nil }
    return (start, end, total)
  }
}

extension DoorClient {
  /// A byte read: the answer as it came (200, 206, 416), with the Range headers the door forwards (packages/server/
  /// inbox-devices.ts: Range, If-Range and If-None-Match on a GET). Any other status is a refusal.
  func bytes(_ request: DoorRequest, query: [URLQueryItem] = [], headers extra: [String: String] = [:]) async throws -> DoorAnswerBytes {
    var headers = headers(for: request, body: false)
    headers["Accept"] = "*/*"
    for (name, value) in extra { headers[name] = value }
    let call = DoorCall(method: request.route.method, path: request.path, query: query, headers: headers)
    let answer: DoorAnswerBytes
    do { answer = try await transport.send(call) } catch let failure as DoorFailure { throw failure } catch let cancel as CancellationError { throw cancel } catch {
      if (error as? URLError)?.code == .cancelled { throw CancellationError() }
      throw DoorFailure.unreachable((error as NSError).localizedDescription, mayHaveArrived: DoorFailure.mayHaveArrived(error))
    }
    if (200..<300).contains(answer.status) || answer.status == 416 { return answer }
    throw DoorFailure.from(status: answer.status, headers: answer.headers, body: answer.body)
  }
}
