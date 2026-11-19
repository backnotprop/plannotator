import Foundation
import InboxWire

/// What the session knows of attachments.
struct FileBook {
  /// What the computer last said of each thread's files (`GET threads/:id/attachments`).
  var states: [ThreadID: [InboxAttachmentState]] = [:]
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

  /// Ask the computer how each of a thread's files stands now (changed since sent, missing).
  public func readAttachments(_ thread: ThreadID) async {
    if client == nil { _ = await connect() }
    guard let client, offers(DoorRoutes.getThreadAttachments) else { return }
    if let read = try? await client.get(Door.getThreadAttachments(thread: thread), as: DoorThreadAttachmentsAnswer.self) {
      files.states[thread] = read.attachments + (read.inlineImages ?? [])
    }
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
  static func cacheKey(_ item: AttachmentItem, _ version: AttachmentVersion) -> String {
    switch version {
    case .sent: return "\(item.id.rawValue)@\(item.sentSha256)"
    case .current: return "\(item.id.rawValue)@\(item.current?.sha256 ?? (item.changedSinceSent == false ? item.sentSha256 : "current"))"
    }
  }

  /// Whether a file opens now: kept on the phone, fetchable, or neither until the computer answers.
  public func availability(_ item: AttachmentItem, version: AttachmentVersion? = nil) -> AttachmentAvailability {
    let version = version ?? item.opens
    if let kept = bytes?.file(Self.cacheKey(item, version)) { return .kept(kept) }
    // The sent version of a file kept as the current one with the same bytes.
    if version == .current, item.changedSinceSent != true, let kept = bytes?.file(Self.cacheKey(item, .sent)) { return .kept(kept) }
    return client != nil && standing == .ok ? .fetchable : .notKept
  }

  /// A file's bytes as a file on the phone: from the cache when kept, else fetched through the door into it, checked
  /// against the hash the computer named. Cancelling the calling task stops the fetch; the next one resumes it.
  public func openAttachment(_ item: AttachmentItem, version: AttachmentVersion? = nil, progress: @Sendable @escaping (Int64, Int64?) -> Void = { _, _ in }) async throws -> URL {
    let version = version ?? item.opens
    if case .kept(let url) = availability(item, version: version) { return url }
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
