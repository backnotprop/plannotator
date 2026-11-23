import Foundation
import InboxWire

/// What the session knows of attachments.
struct FileBook {
  /// What the computer last said of each thread's files (`GET threads/:id/attachments`).
  var states: [ThreadID: [InboxAttachmentState]] = [:]
  /// Files open in a viewer, by file, in the order opened: the version and the cache key each holds.
  var open: [AttachmentID: [(version: AttachmentVersion, key: String)]] = [:]
}

/// One viewer's hold on a file's bytes, from `openHeld`: while it is held, room is never made with those bytes.
/// Released once, with `release`, whatever version the file opens in by then.
public struct AttachmentHold: Hashable, Sendable {
  public let file: AttachmentID
  public let version: AttachmentVersion
  let key: String
}

/// Whether a file's bytes can be opened now.
public enum AttachmentAvailability: Hashable, Sendable {
  /// Kept on the phone: it opens with or without the computer.
  case kept(URL)
  /// Not kept, and the computer answers: it can be fetched.
  case fetchable
  /// Not kept, and the computer is away: it opens once the computer answers.
  case notKept
}

/// Why a file did not open.
public enum AttachmentError: Error, Hashable, Sendable {
  /// Not kept on the phone, and the computer is away.
  case notKept
  /// This Inbox does not offer the route.
  case notOffered
  /// The file cannot be opened in this version (`unavailable`: missing, or changed type).
  case unavailable(String)
  case fetch(ByteFetchError)
}

extension InboxSession {
  /// The largest file the phone fetches. A decision of this slice (the window has no cap of its own; the computer
  /// caps an answer, not a file): no file larger than the cache's own budget, and never more than 200 MB on a phone.
  public static let fileCap: Int64 = 200 * 1_000_000

  /// A thread's files, each with what the computer said of it when last asked.
  public func attachments(_ thread: ThreadID) -> [AttachmentItem] {
    guard let model = threads[thread] else {
      return (files.states[thread] ?? []).map(AttachmentItem.init(state:))
    }
    return AttachmentItem.list(model.thread, states: files.states[thread])
  }

  /// The files attached to one message (not the pictures its words show), each with what the computer said of it
  /// when last asked: the tiles under the message.
  public func attachments(of message: InboxMessageWire, in thread: ThreadID) -> [AttachmentItem] {
    guard let records = message.attachments, !records.isEmpty else { return [] }
    let states = files.states[thread] ?? []
    return records.map { record in
      var item = AttachmentItem(record: record, message: message.id, inline: false)
      if let state = states.first(where: { $0.id == record.id }) { item.take(state) }
      return item
    }
  }

  /// Ask the computer how each of a thread's files stands now (changed since sent, missing), and which comments
  /// on them wait for a Send. Returns the ids of the comments it listed, when it listed them.
  @discardableResult
  public func readAttachments(_ thread: ThreadID) async -> Set<String>? {
    if case .listed(let ids) = await readComments(thread) { return ids }
    return nil
  }

  /// What a read of a thread's files said about its comments.
  enum CommentsRead {
    /// The comments it listed.
    case listed(Set<String>)
    /// It answered, with no list to read: an older Inbox, or comments this app cannot read. Asking again changes
    /// nothing.
    case unlisted
    /// No answer: worth asking again.
    case failed
  }

  func readComments(_ thread: ThreadID) async -> CommentsRead {
    if client == nil { _ = await connect() }
    guard let client else { return .failed }
    guard offers(DoorRoutes.getThreadAttachments) else { return .unlisted }
    // What the computer answers about a comment from here on is newer than this list.
    let started = commentBook.landSeq
    guard let answer = try? await client.call(Door.getThreadAttachments(thread: thread)) else { return .failed }
    if let read = try? JSONDecoder().decode(DoorThreadAttachmentsAnswer.self, from: answer.body) {
      files.states[thread] = read.attachments + (read.inlineImages ?? [])
      // The comments that wait for a Send, the window's among them (an older Inbox's door lists none).
      guard let waiting = read.annotations else { return .unlisted }
      takeComments(thread, from: waiting, started: started)
      return .listed(Set(waiting.map(\.id)))
    } else if case .object(var fields)? = try? JSONDecoder().decode(JSONValue.self, from: answer.body) {
      // A comment this app cannot read never hides the files: they are read without the comments.
      fields["annotations"] = nil
      if let read = try? JSONDecoder().decode(DoorThreadAttachmentsAnswer.self, from: JSONEncoder().encode(JSONValue.object(fields))) { files.states[thread] = read.attachments + (read.inlineImages ?? []) }
    }
    return .unlisted
  }

  /// The route a file's bytes come from, and whether it takes a Range. A picture comes whole (its ETag is its
  /// hash); a video, a sound and any other file come in parts.
  static func byteRoute(_ item: AttachmentItem) -> DoorRequest {
    switch item.kind {
    case .image: return Door.getAttachmentImage(attachment: item.id)
    case .video: return Door.getAttachmentVideo(attachment: item.id)
    case .audio: return Door.getAttachmentAudio(attachment: item.id)
    default: return Door.getAttachmentDownload(attachment: item.id)
    }
  }

  /// The cache's key for one version of a file: its id and the hash of those bytes, so a changed file is a new entry.
  /// Two opens of a file show the same bytes only when their keys are the same.
  public static func cacheKey(_ item: AttachmentItem, _ version: AttachmentVersion) -> String {
    switch version {
    case .sent: return "\(item.id.rawValue)@\(item.sentSha256)"
    case .current: return "\(item.id.rawValue)@\(item.current?.sha256 ?? (item.changedSinceSent == false ? item.sentSha256 : "current"))"
    }
  }

  /// Whether a file opens now: kept on the phone, fetchable, or neither until the computer answers. Asking writes
  /// nothing and does not count as opening the file.
  public func availability(_ item: AttachmentItem, version: AttachmentVersion? = nil) -> AttachmentAvailability {
    if let key = keptKey(item, version: version ?? item.opens), let kept = bytes?.kept(key) { return .kept(kept) }
    return client != nil && standing == .ok ? .fetchable : .notKept
  }

  /// The cache key a file opens from, when it is kept: its own, or, for the current version of a file that did not
  /// change, the version it sent (the same bytes).
  func keptKey(_ item: AttachmentItem, version: AttachmentVersion) -> String? {
    let own = Self.cacheKey(item, version)
    if bytes?.contains(own) == true { return own }
    if version == .current, item.changedSinceSent != true, bytes?.contains(Self.cacheKey(item, .sent)) == true { return Self.cacheKey(item, .sent) }
    return nil
  }

  /// A file's bytes as a file on the phone: from the cache when kept, else fetched through the door into it, checked
  /// against the hash the computer named. Cancelling the calling task stops the fetch; the next one resumes it.
  /// The file stays kept while it is open: call `attachmentClosed` when the viewer closes.
  public func openAttachment(_ item: AttachmentItem, version: AttachmentVersion? = nil, progress: @Sendable @escaping (Int64, Int64?) -> Void = { _, _ in }) async throws -> URL {
    try await openHeld(item, version: version, progress: progress).url
  }

  /// `openAttachment`, with the hold it took: a viewer that may open a file twice at once (a version asked while
  /// another comes) releases exactly its own with `release`.
  public func openHeld(_ item: AttachmentItem, version: AttachmentVersion? = nil, progress: @Sendable @escaping (Int64, Int64?) -> Void = { _, _ in }) async throws -> (url: URL, hold: AttachmentHold?) {
    let version = version ?? item.opens
    let url = try await fetchAttachment(item, version: version, progress: progress)
    guard let bytes, let key = keptKey(item, version: version) else { return (url, nil) }
    bytes.hold(key)
    files.open[item.id, default: []].append((version, key))
    return (url, AttachmentHold(file: item.id, version: version, key: key))
  }

  /// Release one hold from `openHeld`.
  public func release(_ hold: AttachmentHold) {
    guard var opened = files.open[hold.file], let index = opened.lastIndex(where: { $0.version == hold.version && $0.key == hold.key }) else { return }
    opened.remove(at: index)
    bytes?.release(hold.key)
    files.open[hold.file] = opened.isEmpty ? nil : opened
  }

  /// The file as this phone last read it, when the computer has not said how it stands since the app started (so
  /// it opens as sent) and the phone keeps no sent copy but does keep a later version: the item with that version
  /// as its current one, changed since sent. A file read before a relaunch then opens with the computer away, and
  /// says it is not the sent version.
  public func lastKept(_ item: AttachmentItem) -> AttachmentItem? {
    guard item.changedSinceSent == nil, item.unavailable == nil, let bytes, keptKey(item, version: .sent) == nil else { return nil }
    let prefix = "\(item.id.rawValue)@"
    let sent = Self.cacheKey(item, .sent)
    guard let last = bytes.entries(prefix: prefix).filter({ $0.key != sent }).max(by: { $0.opened < $1.opened }) else { return nil }
    var kept = item
    kept.changedSinceSent = true
    kept.current = InboxAttachmentStateCurrent(sha256: String(last.key.dropFirst(prefix.count)), size: last.size, mtime: "")
    return kept
  }

  /// What a file opens as: the version asked for, else the one the file opens with; but a file whose sent version
  /// this phone does not keep, which the computer has not spoken of since the app started, opens as this phone last
  /// read it (`lastKept`). `keptCopy` says so: that copy is neither the sent version nor known to be the file as it
  /// is now, so the viewer says only that the computer is away, and offers no other version.
  public func opening(_ item: AttachmentItem, asked: AttachmentVersion?) -> (item: AttachmentItem, version: AttachmentVersion, keptCopy: Bool) {
    if asked != .sent, item.changedSinceSent == nil, availability(item, version: .sent) == .notKept, let kept = lastKept(item) { return (kept, .current, true) }
    return (item, asked ?? item.opens, false)
  }

  /// The viewer of a file opened with `openAttachment` closed: room can be made with it again. `version`: the one
  /// opened, when the file is open in two; else the one opened last (a refreshed item may open another version now).
  public func attachmentClosed(_ item: AttachmentItem, version: AttachmentVersion? = nil) {
    guard var opened = files.open[item.id], !opened.isEmpty else { return }
    let index: Int = version.flatMap { asked in opened.lastIndex { $0.version == asked } } ?? opened.count - 1
    bytes?.release(opened.remove(at: index).key)
    files.open[item.id] = opened.isEmpty ? nil : opened
  }

  func fetchAttachment(_ item: AttachmentItem, version: AttachmentVersion, progress: @Sendable @escaping (Int64, Int64?) -> Void) async throws -> URL {
    // Opened: it goes last when room is made.
    if let key = keptKey(item, version: version), let kept = bytes?.file(key) { return kept }
    if version == .current, let unavailable = item.unavailable { throw AttachmentError.unavailable(unavailable.message) }
    if client == nil { _ = await connect() }
    guard let client, let bytes else { throw AttachmentError.notKept }
    let request = Self.byteRoute(item)
    guard offers(request.route) else { throw AttachmentError.notOffered }
    let size = version == .sent ? item.size : item.current?.size ?? item.size
    let sha = version == .sent ? item.sentSha256 : item.current?.sha256 ?? (item.changedSinceSent == false ? item.sentSha256 : nil)
    let fetch = ByteFetch(client: client, cache: bytes)
    do {
      return try await fetch.fetch(
        request, query: version == .sent ? [URLQueryItem(name: "version", value: "sent")] : [], key: Self.cacheKey(item, version), size: size, sha256: sha,
        cap: min(Self.fileCap, bytes.budget), ranged: request.route.range, progress: progress)
    } catch let error as ByteFetchError {
      throw AttachmentError.fetch(error)
    } catch let failure as DoorFailure {
      if case .unreachable = failure { throw AttachmentError.notKept }
      throw failure
    }
  }
}
