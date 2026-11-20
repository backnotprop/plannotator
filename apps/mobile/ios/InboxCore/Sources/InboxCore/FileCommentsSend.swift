import Foundation
import InboxWire

/// Where one waiting comment stands for the next Send, as the list of comments says it.
public enum CommentStanding: Hashable, Sendable {
  /// It rides the next Send.
  case goes
  /// It rides the next Send with its quote and no line: the file is not the text it was made on any more (or that
  /// text is not on the phone), so no line of it is named (the window's "Unanchored").
  case unanchored
  /// It rides the next Send once its drawing has reached the computer, which goes first.
  case drawingWaits
  /// The computer did not keep it (with its reason, when it gave one): no Send carries it until it is saved.
  case notSaved(InboxSession.Notice?)
  /// Made in the window in a way the phone does not write: it goes with the reply sent on the computer.
  case window

  /// Whether the next Send carries it.
  public var rides: Bool {
    switch self {
    case .goes, .unanchored, .drawingWaits: return true
    case .notSaved, .window: return false
    }
  }
}

extension InboxSession {
  /// What a document comment's line is read from at Send.
  enum Anchor: Equatable {
    /// The text under this cache key, on the phone.
    case text(String)
    /// The text the line would be read from is the file as the computer has it, and the phone does not keep it:
    /// fetched at Send.
    case fetch
    /// Its place is lost: the text it was made on is not the file's any more, or not here to read.
    case lost
  }

  /// The text a comment's line is read from: the version as the computer has it now, as the window reads it at Send
  /// (packages/inbox/data/queries/feedbackTexts.ts), but only when that is the very text the person read when they
  /// made it here. After the agent changed the file, a block's id names another place in it, so no line is named
  /// at all rather than a wrong one. While the computer has not said how the file stands, the text the person read
  /// is the newest the phone knows.
  func anchor(_ comment: FileComment, _ item: AttachmentItem) -> Anchor {
    let version: AttachmentVersion = comment.version == FileComment.current ? .current : .sent
    let now = keptKey(item, version: version)
    let known = version == .sent || item.changedSinceSent != nil || item.current != nil
    guard let read = commentBook.readKeys[comment.id] else {
      // Made in the window: read as the window reads it.
      if let now { return .text(now) }
      return known ? .fetch : .lost
    }
    if known {
      if let now { return now == read ? .text(now) : .lost }
      return read == Self.cacheKey(item, version) ? .fetch : .lost
    }
    return bytes?.contains(read) == true ? .text(read) : .lost
  }

  func feedbackFile(_ item: AttachmentItem) -> FeedbackFile { FeedbackFile(id: item.id.rawValue, path: item.path, name: item.name, kind: item.kind.rawValue, inline: item.inline) }

  func text(_ key: String) -> String? { bytes?.kept(key).flatMap { try? String(contentsOf: $0, encoding: .utf8) } }

  private func splits(_ key: String) -> Bool {
    if let known = commentSplits[key] { return known }
    let splits = text(key).map(DocumentBlocks.matchesWindow) ?? false
    commentSplits[key] = splits
    return splits
  }

  /// The same comment with no block named: its quote alone finds the place.
  static func unanchored(_ comment: FileComment) -> FileComment {
    var copy = comment
    copy.annotation["blockId"] = .string("")
    return copy
  }

  /// Where a waiting comment stands for the next Send.
  public func commentStanding(_ comment: FileComment, in thread: ThreadID) -> CommentStanding {
    commentStanding(comment, items: attachments(thread))
  }

  func commentStanding(_ comment: FileComment, items: [AttachmentItem]) -> CommentStanding {
    if let refused = commentBook.refused[comment.id] { return .notSaved(refused) }
    // A comment the computer does not have, with no save on its way, would make the computer refuse the whole Send.
    let saving = held.contains { $0.kind == .annotation && $0.subject == comment.id }
    if !comment.saved, !saving { return .notSaved(nil) }
    guard let item = items.first(where: { $0.id == comment.attachment }) else { return .window }
    let file = feedbackFile(item)
    let waits = drawingWaits(comment)
    guard FileFeedback.needsBlocks(file: file, block: comment.blockId ?? "", comment: comment) else {
      guard FileFeedback.carries(comment, file: file, text: nil) else { return .window }
      return waits ? .drawingWaits : .goes
    }
    switch anchor(comment, item) {
    case .text(let key):
      // The text itself is not needed to decide: an empty one that splits as the window's stands in.
      guard splits(key) else { return .window }
      return FileFeedback.carries(comment, file: file, text: "") ? .goes : .window
    case .fetch:
      guard FileFeedback.carries(Self.unanchored(comment), file: file, text: nil) else { return .window }
      return client == nil ? .unanchored : .goes
    case .lost:
      return FileFeedback.carries(Self.unanchored(comment), file: file, text: nil) ? .unanchored : .window
    }
  }

  /// The comments the next Send carries: the waiting ones the computer has (or will, from a save ahead of the Send),
  /// that the phone writes exactly as the window would. The rest stay, and the list says why.
  public func commentsToSend(_ thread: ThreadID) -> [FileComment] {
    let items = attachments(thread)
    return comments(thread).filter { commentStanding($0, items: items).rides }
  }

  /// Before a Send: the text of each version a comment's line is read from, when the phone does not keep it and the
  /// computer answers (the window reads them at Send too).
  func fetchFeedbackTexts(_ thread: ThreadID) async {
    guard client != nil else { return }
    let items = attachments(thread)
    var asked: Set<String> = []
    for comment in comments(thread) {
      guard let item = items.first(where: { $0.id == comment.attachment }), FileFeedback.needsBlocks(file: feedbackFile(item), block: comment.blockId ?? "", comment: comment),
        anchor(comment, item) == .fetch
      else { continue }
      let version: AttachmentVersion = comment.version == FileComment.current ? .current : .sent
      guard asked.insert(Self.cacheKey(item, version)).inserted else { continue }
      _ = try? await fetchAttachment(item, version: version, progress: { _, _ in })
    }
  }

  /// The feedback text for those comments, as the window writes it, with each file version's text read from the
  /// phone's own copy. A comment whose place is lost goes with its quote and no line.
  func feedback(_ comments: [FileComment], thread: ThreadID) -> String {
    let items = attachments(thread)
    var texts: [String: String] = [:]
    var slotKeys: [String: String] = [:]
    var written: [FileComment] = []
    for comment in comments {
      guard let item = items.first(where: { $0.id == comment.attachment }), FileFeedback.needsBlocks(file: feedbackFile(item), block: comment.blockId ?? "", comment: comment) else {
        written.append(comment)
        continue
      }
      let slot = FileFeedback.textKey(comment.attachment, comment.version)
      guard case .text(let key) = anchor(comment, item), slotKeys[slot] ?? key == key, let text = texts[slot] ?? text(key) else {
        written.append(Self.unanchored(comment))
        continue
      }
      slotKeys[slot] = key
      texts[slot] = text
      written.append(comment)
    }
    let model = threads[thread]?.thread
    let root = model?.project.root ?? ""
    return FileFeedback.text(written, files: items.map(feedbackFile), texts: texts, projectRoot: root, prototypes: PrototypeNames.attachments(model?.messages ?? [], root: root))
  }
}

/// What the door's event stream says of comments (packages/server/inbox.ts `eventPayload`): a `record` whose kind is
/// `annotation` carries the comment's record, with its thread.
public enum CommentEvents {
  /// The thread whose comments a record's data says changed, or nil for any other record.
  public static func thread(of data: String) -> ThreadID? {
    guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(data.utf8)), case .object(let fields) = value, case .string("annotation")? = fields["kind"],
      case .object(let record)? = fields["annotation"], case .string(let thread)? = record["thread_id"], !thread.isEmpty
    else { return nil }
    return ThreadID(thread)
  }
}
