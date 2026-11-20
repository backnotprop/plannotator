import CryptoKit
import Foundation
import InboxWire

/// The person's comments on a thread's files that wait for a Send.
///
/// A comment is kept on the phone the moment it is made and saved to the computer through the outbox
/// (`POST annotations`), so it shows in the window too, survives leaving the file and closing the app, and is made,
/// changed and removed with the computer away. A Send carries the ones still waiting as the window's feedback text
/// (`FileFeedback`) with their ids; they leave the list while that Send waits, come back if it is refused or taken
/// back, and are gone once the computer has it.
struct CommentBook {
  /// Every comment not yet sent, by thread, in the order made.
  var kept: [ThreadID: [FileComment]] = [:]
  /// Removed here; the computer has not answered the removal yet, so a read of its list does not bring them back.
  var removed: Set<String> = []
  /// Why the computer would not keep a comment, by comment. Kept across closing the app: a refused comment never
  /// rides a Send the computer would refuse whole.
  var refused: [String: InboxSession.Notice] = [:]
  /// Drawings not on the computer yet, by the hash that names them (also kept in the phone's copy).
  var drawings: [String: Data] = [:]
  /// The cache key of the text a comment was made on, by comment: the lines the person read.
  var readKeys: [String: String] = [:]
  /// Moves with each answer the computer gave about a comment (a save, a removal, a Send, a refusal).
  var landSeq = 0
  /// Where `landSeq` stood when each comment's last answer landed: a list the computer read before that answer
  /// does not know of it, and never undoes it.
  var landedAt: [String: Int] = [:]
  /// Where `landSeq` stood when the newest list of each thread's comments taken was asked for: an older list that
  /// answers later is not taken over it.
  var readFrom: [ThreadID: Int] = [:]
}

private struct KeptComments: Codable {
  var kept: [String: [FileComment]]
  var removed: [String]
  var readKeys: [String: String]
  /// Absent in a copy from before refusals were kept.
  var refused: [String: InboxSession.Notice]?
}

extension LocalCopy {
  func saveComments(_ book: CommentBook) {
    let kept = KeptComments(kept: Dictionary(uniqueKeysWithValues: book.kept.map { ($0.key.rawValue, $0.value) }), removed: book.removed.sorted(), readKeys: book.readKeys, refused: book.refused)
    if let data = try? JSONEncoder().encode(kept) { write(data, to: "comments.json") }
  }

  func comments() -> CommentBook {
    guard let data = read("comments.json"), let kept = try? JSONDecoder().decode(KeptComments.self, from: data) else { return CommentBook() }
    return CommentBook(kept: Dictionary(uniqueKeysWithValues: kept.kept.map { (ThreadID($0.key), $0.value) }), removed: Set(kept.removed), refused: kept.refused ?? [:], readKeys: kept.readKeys)
  }

  static func drawingName(_ hash: String) -> String { "drawing-\(hash).png" }
}

/// A drawing the computer does not have yet is named by its own hash under this scheme, in the comment and in a
/// Send that waits; the computer's answer puts the path it kept it at in their place.
public enum PendingDrawing {
  public static let scheme = "plannotator-drawing:"
  public static func path(_ hash: String) -> String { "\(scheme)\(hash).png" }
  /// The hash of a drawing that still waits, from its place-holding path.
  public static func hash(_ path: String) -> String? { path.hasPrefix(scheme) ? String(path.dropFirst(scheme.count).dropLast(4)) : nil }
  /// The hashes of the drawings a write's body still names by their place-holding path.
  static func hashes(in body: Data) -> Set<String> {
    let text = String(decoding: body, as: UTF8.self)
    var found: Set<String> = []
    var rest = Substring(text)
    while let start = rest.range(of: scheme) {
      let after = rest[start.upperBound...]
      let hash = after.prefix { $0.isHexDigit }
      if !hash.isEmpty { found.insert(String(hash)) }
      rest = after.dropFirst(hash.count)
    }
    return found
  }
}

extension InboxSession {
  // MARK: Reading

  func loadComments() { commentBook = copy.comments() }

  func keepComments() { copy.saveComments(commentBook) }

  /// The ids a Send that waits already carries.
  func riding(_ thread: ThreadID) -> Set<String> {
    var ids: Set<String> = []
    for write in held where write.kind == .reply && write.thread == thread.rawValue {
      ids.formUnion((try? JSONDecoder().decode(DoorReplyBody.self, from: write.body))?.annotationIds ?? [])
    }
    return ids
  }

  /// How many comments on files a reply that waits carries.
  public func heldComments(_ write: HeldWrite) -> Int {
    guard write.kind == .reply else { return 0 }
    return (try? JSONDecoder().decode(DoorReplyBody.self, from: write.body))?.annotationIds?.count ?? 0
  }

  /// A thread's comments that wait for a Send, in the order made.
  public func comments(_ thread: ThreadID) -> [FileComment] {
    let riding = riding(thread)
    return (commentBook.kept[thread] ?? []).filter { !riding.contains($0.id) }
  }

  /// The comments on one file (any version of it), in the order made.
  public func comments(_ thread: ThreadID, on file: AttachmentID) -> [FileComment] { comments(thread).filter { $0.attachment == file } }

  /// Why the computer would not keep a comment (it stays on the phone, and no Send carries it).
  public func commentRefusal(_ id: String) -> Notice? { commentBook.refused[id] }

  /// Whether a file takes comments here: its kind does, this Inbox offers the route, and the phone can write its
  /// comments as the window would. A page that a question shows as a prototype is commented on in the window's
  /// prototype view, by a flow the phone does not have: its comments are made in the window.
  public func takesComments(_ item: AttachmentItem, in thread: ThreadID) -> Bool {
    guard standing == .ok, skew == nil || offers(DoorRoutes.postAnnotations), !item.inline, FileFeedback.kinds.contains(item.kind.rawValue) else { return false }
    if let model = threads[thread] {
      if model.thread.resolvedAt != nil { return false }
      if item.kind == .html, model.thread.messages.contains(where: { ($0.questions ?? []).contains { $0.prototype != nil || $0.choices.contains { $0.prototype != nil } } }) { return false }
    }
    return true
  }

  /// A picture takes a drawing only where this Inbox keeps drawings.
  public func takesDrawings() -> Bool { skew == nil || offers(DoorRoutes.postMarkups) }

  /// The version name a comment on a file's version carries: `current`, or the sent version's hash.
  public static func commentVersion(_ item: AttachmentItem, _ version: AttachmentVersion) -> String { version == .sent ? item.sentSha256 : FileComment.current }

  // MARK: Making, changing, removing

  private static func stamp(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }

  private func saveBody(_ comment: FileComment, key: String) -> Data {
    (try? JSONEncoder().encode(DoorAnnotationBody(idempotencyKey: key, attachmentId: comment.attachment, version: comment.version, annotation: comment.annotation))) ?? Data("{}".utf8)
  }

  private func holdSave(_ comment: FileComment) {
    // A save of the same comment that has not left yet is replaced by this one: the computer gets the last words.
    held.removeAll { $0.kind == .annotation && $0.subject == comment.id && !book.inFlight.contains($0.id) }
    let key = UUID().uuidString
    enqueue(kind: .annotation, thread: comment.thread, message: nil, request: Door.postAnnotations(), body: saveBody(comment, key: key), key: key, subject: comment.id)
  }

  /// A drawing on its way to the computer, unless one is already (the same drawing is kept once, by its hash).
  private func holdDrawing(_ hash: String, thread: ThreadID) {
    guard !held.contains(where: { $0.kind == .markup && $0.subject == hash }) else { return }
    let key = UUID().uuidString
    enqueue(kind: .markup, thread: thread, message: nil, request: Door.postMarkups(), body: Data(), key: key, subject: hash)
  }

  /// Keep a new comment: on the phone at once, and on its way to the computer. `annotation` is one of
  /// `FileComments`' makers'. `drawing`: a picture comment's drawing over the picture, as a PNG; the annotation is
  /// then made here, since its picture is named by the drawing's hash until the computer has kept it.
  /// `readKey`: the cache key of the bytes the person read, when the viewer shows a copy other than the one the item
  /// names (a copy kept while the computer is away).
  @discardableResult
  public func addComment(thread: ThreadID, item: AttachmentItem, version: AttachmentVersion, annotation: [String: JSONValue], drawing: Data? = nil, marks: [PictureMark]? = nil, readKey: String? = nil) -> FileComment? {
    guard takesComments(item, in: thread), case .string(let id)? = annotation["id"] else { return nil }
    var annotation = annotation
    if let drawing {
      let hash = SHA256.hash(data: drawing).map { String(format: "%02x", $0) }.joined()
      commentBook.drawings[hash] = drawing
      copy.write(drawing, to: LocalCopy.drawingName(hash))
      // The computer names a drawing by its hash (packages/shared/inbox/markups.ts `writeInboxMarkup`).
      annotation["images"] = .array([.object(["path": .string(PendingDrawing.path(hash)), "name": .string("\(hash).png")])])
      // A drawing with no words says so itself (`markupWords`).
      if case .string(let words)? = annotation["text"], words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { annotation["text"] = .string(Words.markupOnly) }
      holdDrawing(hash, thread: thread)
    }
    var comment = FileComment(id: id, thread: thread, attachment: item.id, version: Self.commentVersion(item, version), annotation: annotation, createdAt: Self.stamp(clock.now()))
    comment.marks = marks
    commentBook.kept[thread, default: []].append(comment)
    commentBook.readKeys[id] = readKey ?? keptKey(item, version: version) ?? Self.cacheKey(item, version)
    holdSave(comment)
    keepComments()
    Task { await pump(thread.rawValue, readsList: false) }
    return comment
  }

  /// Change a waiting comment's words. Empty words remove it, unless it is a drawing (which then says so itself).
  /// A comment the computer did not keep is tried again, the same words or not; a drawing it never got goes first.
  public func editComment(_ id: String, thread: ThreadID, words: String) {
    guard let index = commentBook.kept[thread]?.firstIndex(where: { $0.id == id }), !riding(thread).contains(id) else { return }
    let comment = commentBook.kept[thread]![index]
    let text = words.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty, comment.images.isEmpty { return removeComment(id, thread: thread) }
    let changed = comment.with(words: text.isEmpty ? Words.markupOnly : text)
    let retry = commentBook.refused[id] != nil || (!comment.saved && !held.contains { $0.kind == .annotation && $0.subject == id })
    guard changed != comment || retry else { return }
    // A drawing the computer never kept goes again before the comment that names it; one whose bytes are gone
    // cannot, and the comment stays refused rather than name a picture that is not there.
    for image in changed.images {
      guard let hash = PendingDrawing.hash(image.path) else { continue }
      guard drawing(hash) != nil else {
        commentBook.kept[thread]![index] = changed
        keepComments()
        return
      }
      holdDrawing(hash, thread: thread)
    }
    commentBook.kept[thread]![index] = changed
    commentBook.refused[id] = nil
    holdSave(changed)
    keepComments()
    Task { await pump(thread.rawValue, readsList: false) }
  }

  /// Remove a waiting comment: here at once, and on the computer if it ever got there (or may have).
  public func removeComment(_ id: String, thread: ThreadID) {
    guard let comment = commentBook.kept[thread]?.first(where: { $0.id == id }), !riding(thread).contains(id) else { return }
    commentBook.kept[thread]?.removeAll { $0.id == id }
    commentBook.refused[id] = nil
    commentBook.readKeys[id] = nil
    // A save that was sent and never answered may have arrived: the removal goes all the same, after it. Only a
    // save that never left at all is simply dropped.
    let tried = held.contains { $0.kind == .annotation && $0.subject == id && (book.inFlight.contains($0.id) || book.inDoubt.contains($0.id) || $0.mayHaveArrived == true) }
    held.removeAll { $0.kind == .annotation && $0.subject == id && !book.inFlight.contains($0.id) }
    let left = held.contains { $0.kind == .annotation && $0.subject == id }
    for image in comment.images {
      guard let hash = PendingDrawing.hash(image.path), !(commentBook.kept[thread] ?? []).contains(where: { $0.images.contains(image) }) else { continue }
      held.removeAll { $0.kind == .markup && $0.subject == hash && !book.inFlight.contains($0.id) }
      forgetDrawing(hash)
    }
    if comment.saved || left || tried {
      commentBook.removed.insert(id)
      let key = UUID().uuidString
      let body = (try? JSONEncoder().encode(DoorAnnotationRemoveBody(idempotencyKey: key))) ?? Data("{}".utf8)
      enqueue(kind: .annotationRemove, thread: thread, message: nil, request: Door.postAnnotationRemove(annotation: AnnotationID(id)), body: body, key: key, subject: id)
    }
    saveOutbox()
    keepComments()
    Task { await pump(thread.rawValue, readsList: false) }
  }

  /// A drawing no comment names any more, or one the computer has: its bytes leave the phone.
  private func forgetDrawing(_ hash: String) {
    commentBook.drawings[hash] = nil
    copy.remove(LocalCopy.drawingName(hash))
  }

  /// A thread the computer no longer has: nothing of its comments stays on the phone.
  func forgetComments(_ thread: ThreadID) {
    guard let gone = commentBook.kept[thread] else { return }
    for comment in gone {
      commentBook.readKeys[comment.id] = nil
      commentBook.refused[comment.id] = nil
      commentBook.removed.remove(comment.id)
      for image in comment.images { if let hash = PendingDrawing.hash(image.path) { forgetDrawing(hash) } }
    }
    commentBook.kept[thread] = nil
    keepComments()
  }

  // MARK: What the computer says

  /// An answer about a comment landed: a list read before it does not undo it.
  private func landed(_ id: String) {
    commentBook.landSeq += 1
    commentBook.landedAt[id] = commentBook.landSeq
  }

  /// The computer's list of a thread's waiting comments was read: the ones made in the window show here, and the
  /// ones sent or removed there leave. What the phone still has on its way to the computer is the phone's, and so
  /// is anything the computer answered after this list was asked for (`started`: `commentBook.landSeq` then).
  func takeComments(_ thread: ThreadID, from records: [InboxAnnotationRecord], started: Int? = nil) {
    let started = started ?? commentBook.landSeq
    // A list asked for before the newest one taken says less than it.
    if let newest = commentBook.readFrom[thread], newest > started { return }
    commentBook.readFrom[thread] = started
    let newer = { (id: String) in (self.commentBook.landedAt[id] ?? Int.min) > started }
    let onFiles = records.filter { $0.guide == nil && $0.message == nil && $0.live == nil && !$0.attachmentId.rawValue.isEmpty }
    let waiting = Set(held.filter { $0.thread == thread.rawValue && ($0.kind == .annotation || $0.kind == .annotationRemove) }.compactMap(\.subject))
    let riding = riding(thread)
    var kept = commentBook.kept[thread] ?? []
    let there = Set(onFiles.map(\.id))
    // Sent or removed elsewhere: a comment the computer had and no longer lists.
    kept.removeAll { $0.saved && !there.contains($0.id) && !waiting.contains($0.id) && !riding.contains($0.id) && !newer($0.id) }
    for record in onFiles where !commentBook.removed.contains(record.id) && !newer(record.id) {
      var read = FileComment(id: record.id, thread: thread, attachment: record.attachmentId, version: record.version, annotation: record.annotation, createdAt: record.createdAt, saved: true)
      if let index = kept.firstIndex(where: { $0.id == record.id }) {
        // What was drawn stays with the comment: only the phone has it.
        read.marks = kept[index].marks
        if !waiting.contains(record.id) { kept[index] = read } else { kept[index].saved = true }
        commentBook.refused[record.id] = nil
      } else {
        kept.append(read)
      }
    }
    kept.sort { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
    commentBook.removed = commentBook.removed.filter { there.contains($0) || waiting.contains($0) }
    if kept != (commentBook.kept[thread] ?? []) { commentBook.kept[thread] = kept.isEmpty ? nil : kept }
    // The text a comment that left was made on is no longer anyone's.
    let everywhere = Set(commentBook.kept.values.joined().map(\.id))
    commentBook.readKeys = commentBook.readKeys.filter { everywhere.contains($0.key) }
    keepComments()
  }

  /// A comment's save was answered: the computer has it, with its own stamp.
  func commentSaved(_ write: HeldWrite, _ answer: DoorAnswerBytes) {
    let thread = ThreadID(write.thread)
    guard let id = write.subject, let index = commentBook.kept[thread]?.firstIndex(where: { $0.id == id }) else { return }
    landed(id)
    commentBook.kept[thread]![index].saved = true
    commentBook.refused[id] = nil
    if let record = (try? JSONDecoder().decode(DoorAnnotationAnswer.self, from: answer.body))?.annotation { commentBook.kept[thread]![index].createdAt = record.createdAt }
    keepComments()
  }

  func commentRemoved(_ write: HeldWrite) {
    guard let id = write.subject else { return }
    landed(id)
    commentBook.removed.remove(id)
    keepComments()
  }

  /// The computer kept a drawing: its path there takes the place of the hash that named it, in the comment and in
  /// every write that still waits (the comment's save, a Send's feedback text). The phone's own copy is let go.
  func drawingKept(_ write: HeldWrite, _ answer: DoorAnswerBytes) {
    guard let hash = write.subject, let kept = try? JSONDecoder().decode(DoorMarkupAnswer.self, from: answer.body) else { return }
    let waiting = PendingDrawing.path(hash)
    func swap(_ value: JSONValue) -> JSONValue {
      switch value {
      case .string(let text): return .string(text.replacingOccurrences(of: waiting, with: kept.path))
      case .array(let items): return .array(items.map(swap))
      case .object(let fields): return .object(fields.mapValues(swap))
      default: return value
      }
    }
    for index in held.indices where held[index].thread == write.thread && (held[index].kind == .annotation || held[index].kind == .reply) {
      guard let body = try? JSONDecoder().decode(JSONValue.self, from: held[index].body), let swapped = try? JSONEncoder().encode(swap(body)) else { continue }
      held[index].body = swapped
    }
    saveOutbox()
    let thread = ThreadID(write.thread)
    for index in (commentBook.kept[thread] ?? []).indices {
      guard case .object(let fields) = swap(.object(commentBook.kept[thread]![index].annotation)) else { continue }
      commentBook.kept[thread]![index].annotation = fields
    }
    forgetDrawing(hash)
    keepComments()
  }

  /// A drawing's bytes while it waits: for the upload, and for the comment's own picture on the phone.
  public func drawing(_ hash: String) -> Data? { commentBook.drawings[hash] ?? copy.read(LocalCopy.drawingName(hash)) }

  /// Whether a comment's drawing still waits to reach the computer (it goes first, then the comment).
  public func drawingWaits(_ comment: FileComment) -> Bool {
    comment.images.contains { image in PendingDrawing.hash(image.path).map { hash in held.contains { $0.kind == .markup && $0.subject == hash } } ?? false }
  }

  /// The computer will never keep this comment (or this drawing): it stays on the phone with the reason, and no
  /// Send goes on without it. A comment whose drawing the computer did not keep is not saved without it: the save
  /// that waits behind the drawing is dropped (the window keeps such a drawing in the comment box, unsaved).
  func commentRefused(_ write: HeldWrite, _ notice: Notice) {
    let thread = ThreadID(write.thread)
    switch write.kind {
    case .annotation:
      if let id = write.subject {
        landed(id)
        commentBook.refused[id] = notice
      }
    case .markup:
      let waiting = write.subject.map(PendingDrawing.path) ?? ""
      for comment in commentBook.kept[thread] ?? [] where comment.images.contains(where: { $0.path == waiting }) {
        commentBook.refused[comment.id] = notice
        held.removeAll { $0.kind == .annotation && $0.subject == comment.id && !book.inFlight.contains($0.id) }
      }
      saveOutbox()
    case .annotationRemove:
      // Already sent or gone there: nothing waits to be removed.
      if let id = write.subject {
        landed(id)
        commentBook.removed.remove(id)
      }
    default: break
    }
    keepComments()
  }

  /// A write that names a drawing the computer has not kept, with nothing ahead of it that will keep it: it never
  /// goes, since it would name a picture that is not there.
  func namesMissingDrawing(_ write: HeldWrite) -> Bool {
    guard write.kind == .annotation || write.kind == .reply else { return false }
    let hashes = PendingDrawing.hashes(in: write.body)
    guard !hashes.isEmpty, let at = held.firstIndex(where: { $0.id == write.id }) else { return false }
    return hashes.contains { hash in !held[..<at].contains { $0.kind == .markup && $0.subject == hash } }
  }

  /// A Send landed: the comments it carried are sent.
  func commentsSent(_ write: HeldWrite) {
    guard let ids = (try? JSONDecoder().decode(DoorReplyBody.self, from: write.body))?.annotationIds, !ids.isEmpty else { return }
    let thread = ThreadID(write.thread)
    for id in ids { landed(id) }
    commentBook.kept[thread]?.removeAll { ids.contains($0.id) }
    if commentBook.kept[thread]?.isEmpty == true { commentBook.kept[thread] = nil }
    for id in ids { commentBook.readKeys[id] = nil }
    keepComments()
  }

  /// A Send was refused because a comment it named is not waiting on the computer (`annotation_not_found`: it never
  /// got there; `annotation_closed`: it was sent or removed in the window). The comment the refusal names (its field,
  /// `annotation_ids[N]`) is dealt with at once: one the window closed leaves, one the computer never had stays
  /// with the reason and rides no Send until it is saved. The person's words come back as for any refusal.
  func replyNamedGoneComment(_ write: HeldWrite, code: String, field: String?, notice: Notice) {
    guard let ids = (try? JSONDecoder().decode(DoorReplyBody.self, from: write.body))?.annotationIds, !ids.isEmpty else { return }
    let thread = ThreadID(write.thread)
    var named: [String] = []
    if let field, let match = field.wholeMatch(of: /annotation_ids\[(\d+)\]/), let index = Int(match.1), ids.indices.contains(index) { named = [ids[index]] }
    for id in named {
      landed(id)
      if code == "annotation_closed" {
        commentBook.kept[thread]?.removeAll { $0.id == id }
        commentBook.readKeys[id] = nil
        commentBook.refused[id] = nil
      } else if let index = commentBook.kept[thread]?.firstIndex(where: { $0.id == id }) {
        commentBook.kept[thread]![index].saved = false
        commentBook.refused[id] = notice
      }
    }
    if commentBook.kept[thread]?.isEmpty == true { commentBook.kept[thread] = nil }
    keepComments()
  }

  /// After such a refusal the computer's list is read again, and any comment of the refused Send that the computer
  /// does not list and the phone has no save on its way for is held back as not saved: the next Send goes without it,
  /// whatever the refusal named.
  func rereadAfterRefusedSend(_ write: HeldWrite, notice: Notice) async {
    guard let ids = (try? JSONDecoder().decode(DoorReplyBody.self, from: write.body))?.annotationIds, !ids.isEmpty else { return }
    let thread = ThreadID(write.thread)
    guard let listed = await readAttachments(thread) else { return }
    for id in ids where !listed.contains(id) {
      guard let index = commentBook.kept[thread]?.firstIndex(where: { $0.id == id }), !held.contains(where: { $0.kind == .annotation && $0.subject == id }) else { continue }
      commentBook.kept[thread]![index].saved = false
      if commentBook.refused[id] == nil { commentBook.refused[id] = notice }
    }
    keepComments()
  }
}
