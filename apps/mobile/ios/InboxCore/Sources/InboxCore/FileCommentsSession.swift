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
  /// Comments a list read must not drop (a refused Send's own, until it is known which the computer has).
  var keepThrough: Set<String> = []
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
  /// Comments the person pressed Send for while their drawing could not reach the computer: each goes by itself,
  /// once, in a Send of its own, when its drawing is there. Kept across closing the app.
  var owed: Set<String> = []
  /// The message each of those answers: the one the person's words went to (or would have gone to) when they pressed
  /// Send. Its agent gets the comment, whoever writes after. None for one marked by an older build: the end of the
  /// thread then.
  var owedTo: [String: MessageID] = [:]

  /// Mark these comments to go by themselves, to the agent of `message`.
  mutating func owe(_ ids: some Sequence<String>, to message: MessageID?) {
    for id in ids {
      owed.insert(id)
      owedTo[id] = message
    }
  }
}

private struct KeptComments: Codable {
  var kept: [String: [FileComment]]
  var removed: [String]
  var readKeys: [String: String]
  /// Absent in a copy from before refusals were kept.
  var refused: [String: InboxSession.Notice]?
  /// Absent in a copy from before a drawing's comment could go by itself.
  var owed: [String]?
  /// The message each owed comment answers. Absent in a copy from before it was kept: such a comment goes to the end
  /// of the thread.
  var owedTo: [String: String]?
}

extension LocalCopy {
  func saveComments(_ book: CommentBook) {
    let kept = KeptComments(kept: Dictionary(uniqueKeysWithValues: book.kept.map { ($0.key.rawValue, $0.value) }), removed: book.removed.sorted(), readKeys: book.readKeys, refused: book.refused, owed: book.owed.sorted(),
      owedTo: Dictionary(uniqueKeysWithValues: book.owedTo.filter { book.owed.contains($0.key) }.map { ($0.key, $0.value.rawValue) }))
    if let data = try? JSONEncoder().encode(kept) { write(data, to: "comments.json") }
  }

  func comments() -> CommentBook {
    guard let data = read("comments.json"), let kept = try? JSONDecoder().decode(KeptComments.self, from: data) else { return CommentBook() }
    var book = CommentBook(kept: Dictionary(uniqueKeysWithValues: kept.kept.map { (ThreadID($0.key), $0.value) }), removed: Set(kept.removed), refused: kept.refused ?? [:], readKeys: kept.readKeys)
    book.owed = Set(kept.owed ?? [])
    book.owedTo = Dictionary(uniqueKeysWithValues: (kept.owedTo ?? [:]).filter { book.owed.contains($0.key) }.map { ($0.key, MessageID($0.value)) })
    return book
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

  /// The comments a reply that waits carries, in the order made: the reply shows a line for each.
  public func heldCommentList(_ write: HeldWrite) -> [FileComment] {
    guard write.kind == .reply, let ids = (try? JSONDecoder().decode(DoorReplyBody.self, from: write.body))?.annotationIds else { return [] }
    let wanted = Set(ids)
    return (commentBook.kept[ThreadID(write.thread)] ?? []).filter { wanted.contains($0.id) }
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

  /// Returns the save's key.
  @discardableResult
  private func holdSave(_ comment: FileComment) -> String {
    // A save of the same comment that has not left yet is replaced by this one: the computer gets the last words.
    // One that may have reached the computer passes that on, so a removal made later still goes after it.
    let replaced = held.filter { $0.kind == .annotation && $0.subject == comment.id && !book.inFlight.contains($0.id) }
    let mayHave = replaced.contains { book.inDoubt.contains($0.id) || $0.mayHaveArrived == true }
    held.removeAll { write in replaced.contains { $0.id == write.id } }
    let key = UUID().uuidString
    enqueue(kind: .annotation, thread: comment.thread, message: nil, request: Door.postAnnotations(), body: saveBody(comment, key: key), key: key, subject: comment.id)
    if mayHave, let index = held.firstIndex(where: { $0.id == key }) {
      held[index].mayHaveArrived = true
      saveOutbox()
    }
    return key
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

  /// What became of a change to a comment's words.
  public enum CommentEdit: Sendable, Equatable {
    /// The new words are kept (or the comment, left with no words, is removed).
    case changed
    /// The words are the same: nothing to keep.
    case unchanged
    /// The comment already went, in a Send on its way or delivered: the new words cannot go with it.
    case alreadyWent
  }

  /// Change a waiting comment's words. Empty words remove it, unless it is a drawing (which then says so itself).
  /// A comment the computer did not keep is tried again, the same words or not; a drawing it never got goes first.
  /// A comment a Send that waits carries (one that went by itself while its editor was open) is changed in that Send
  /// too, its new save ahead of it; one whose Send has left is not changed.
  @discardableResult
  public func editComment(_ id: String, thread: ThreadID, words: String) -> CommentEdit {
    guard let index = commentBook.kept[thread]?.firstIndex(where: { $0.id == id }) else { return .alreadyWent }
    let carrier = held.first { $0.kind == .reply && $0.thread == thread.rawValue && ((try? JSONDecoder().decode(DoorReplyBody.self, from: $0.body))?.annotationIds ?? []).contains(id) }
    // On its way, or sent with no answer (the computer may have it): the words it carries are the ones that go.
    if let carrier, book.inFlight.contains(carrier.id) || book.inDoubt.contains(carrier.id) || carrier.mayHaveArrived == true { return .alreadyWent }
    let comment = commentBook.kept[thread]![index]
    let text = words.trimmingCharacters(in: .whitespacesAndNewlines)
    if text.isEmpty, comment.images.isEmpty {
      // Taken out of the Send that carries it first; a Send that carried nothing else is not made.
      if let carrier, strip(carrier.id, of: [id]) == .wouldEmpty {
        held.removeAll { $0.id == carrier.id }
        saveOutbox()
      }
      removeComment(id, thread: thread)
      return .changed
    }
    let changed = comment.with(words: text.isEmpty ? Words.markupOnly : text)
    let retry = commentBook.refused[id] != nil || (!comment.saved && !held.contains { $0.kind == .annotation && $0.subject == id })
    guard changed != comment || retry else { return .unchanged }
    // A drawing the computer never kept goes again before the comment that names it; one whose bytes are gone
    // cannot, and the comment stays refused rather than name a picture that is not there.
    for image in changed.images {
      guard let hash = PendingDrawing.hash(image.path) else { continue }
      guard drawing(hash) != nil else {
        commentBook.kept[thread]![index] = changed
        keepComments()
        return .changed
      }
      holdDrawing(hash, thread: thread)
    }
    commentBook.kept[thread]![index] = changed
    commentBook.refused[id] = nil
    let save = holdSave(changed)
    if let carrier {
      // The new words reach the computer before the Send that names the comment, and the Send carries them.
      if let at = held.firstIndex(where: { $0.id == save }), let before = held.firstIndex(where: { $0.id == carrier.id }), at > before {
        held.insert(held.remove(at: at), at: before)
        saveOutbox()
      }
      rewriteFeedback(carrier.id, thread: thread)
    }
    keepComments()
    Task { await pump(thread.rawValue, readsList: false) }
    return .changed
  }

  /// The person opened a comment's editor (or closed it, with nil). A comment that goes by itself never leaves while
  /// its words are being changed: it goes once the editor closes, saved or not.
  public func setEditing(_ id: String?, thread: ThreadID) {
    guard editingComment != id else { return }
    let closed = editingComment != nil && id == nil
    editingComment = id
    if closed { Task { await pump(thread.rawValue, readsList: false) } }
  }

  /// A comment just removed, with what its Undo brings back: its place in the list, the text it was read on and
  /// the drawing the computer may not have yet.
  public struct RemovedComment: Sendable, Equatable {
    public let comment: FileComment
    let index: Int
    let readKey: String?
    let drawings: [String: Data]
    /// It was to go by itself once its drawing reached the computer; brought back, it still does, to the same agent.
    var owed = false
    var owedTo: MessageID?
  }

  /// Remove a waiting comment: here at once, and on the computer if it ever got there (or may have).
  @discardableResult
  public func removeComment(_ id: String, thread: ThreadID) -> RemovedComment? {
    guard let index = commentBook.kept[thread]?.firstIndex(where: { $0.id == id }), !riding(thread).contains(id) else { return nil }
    let comment = commentBook.kept[thread]![index]
    var drawings: [String: Data] = [:]
    for image in comment.images { if let hash = PendingDrawing.hash(image.path), let bytes = drawing(hash) { drawings[hash] = bytes } }
    let removed = RemovedComment(comment: comment, index: index, readKey: commentBook.readKeys[id], drawings: drawings, owed: commentBook.owed.contains(id), owedTo: commentBook.owedTo[id])
    commentBook.kept[thread]?.removeAll { $0.id == id }
    commentBook.refused[id] = nil
    // Removed before it went by itself: it never goes.
    commentBook.owed.remove(id)
    commentBook.readKeys[id] = nil
    // A save that was sent and never answered may have arrived: the removal goes all the same, after it. Only a
    // save that never left at all is simply dropped.
    // A save that may have reached the computer (on its way, sent with no answer, or sent before the app last ended)
    // is never dropped: it goes first, as it is (its key unchanged, so it cannot make a second comment), then the
    // removal. Only a save that never left is simply dropped.
    let mayHave = { (write: HeldWrite) in self.book.inFlight.contains(write.id) || self.book.inDoubt.contains(write.id) || write.mayHaveArrived == true }
    let tried = held.contains { $0.kind == .annotation && $0.subject == id && mayHave($0) }
    held.removeAll { $0.kind == .annotation && $0.subject == id && !mayHave($0) }
    let left = held.contains { $0.kind == .annotation && $0.subject == id }
    let keptSaves = held.filter { $0.kind == .annotation && $0.subject == id }
    for image in comment.images {
      guard let hash = PendingDrawing.hash(image.path), !(commentBook.kept[thread] ?? []).contains(where: { $0.images.contains(image) }),
        !keptSaves.contains(where: { PendingDrawing.hashes(in: $0.body).contains(hash) })
      else { continue }
      // Its own upload is retired, and only that: one on its way lets its bytes go when it ends.
      let flying = held.contains { $0.kind == .markup && $0.subject == hash && book.inFlight.contains($0.id) }
      for write in held where write.kind == .markup && write.subject == hash && !book.inFlight.contains(write.id) { parkedDrawings[write.id] = nil }
      held.removeAll { $0.kind == .markup && $0.subject == hash && !book.inFlight.contains($0.id) }
      if !flying { forgetDrawing(hash) }
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
    return removed
  }

  /// Undo a removal: the same comment (its words, its place in the file, its marks, its drawing) back where it was
  /// in the list, saved again as a new comment, since the computer may already be removing the old one.
  @discardableResult
  public func restoreComment(_ removed: RemovedComment) -> FileComment? {
    let old = removed.comment
    var comment = old
    comment.id = FileComments.newID()
    comment.annotation["id"] = .string(comment.id)
    comment.saved = false
    for (hash, bytes) in removed.drawings {
      commentBook.drawings[hash] = bytes
      copy.write(bytes, to: LocalCopy.drawingName(hash))
      holdDrawing(hash, thread: old.thread)
    }
    var list = commentBook.kept[old.thread] ?? []
    list.insert(comment, at: min(removed.index, list.count))
    commentBook.kept[old.thread] = list
    commentBook.readKeys[comment.id] = removed.readKey
    if removed.owed { commentBook.owe([comment.id], to: removed.owedTo) }
    holdSave(comment)
    keepComments()
    Task { await pump(old.thread.rawValue, readsList: false) }
    return comment
  }

  /// Whether a comment on the phone, or a write that waits, still names this drawing.
  func drawingNamed(_ hash: String) -> Bool {
    let path = PendingDrawing.path(hash)
    if commentBook.kept.values.joined().contains(where: { $0.images.contains { $0.path == path } }) { return true }
    return held.contains { ($0.kind == .annotation || $0.kind == .reply) && PendingDrawing.hashes(in: $0.body).contains(hash) }
  }

  // MARK: A drawing a way cannot carry

  /// A write held back by a drawing this way refused to carry: the drawing itself and its comment's save. A Send is
  /// never held back: such a comment leaves it, for the list (`releaseHeldBackComments`).
  func heldBack(_ write: HeldWrite) -> Bool {
    switch write.kind {
    // Still held back while away: which way comes next is not known yet.
    case .markup: return parkedDrawings[write.id].map { parked in pathIndex == nil || parked == pathIndex } ?? false
    case .annotation: return PendingDrawing.hashes(in: write.body).contains(where: drawingHeldBack)
    default: return false
    }
  }

  /// A Send with no words, no answer and no action: what it carries is its comments.
  static func onlyComments(_ body: DoorReplyBody) -> Bool { (body.words ?? "").isEmpty && (body.questions ?? []).isEmpty && (body.actions ?? []).isEmpty }

  /// Whether every write of this thread that waits is held back by a drawing (nothing to retry until another way).
  func onlyHeldBack(_ thread: String? = nil) -> Bool {
    let waiting = held.filter { thread == nil || $0.thread == thread }
    return !waiting.isEmpty && waiting.allSatisfy(heldBack)
  }

  func drawingHeldBack(_ hash: String) -> Bool { held.contains { $0.kind == .markup && $0.subject == hash && heldBack($0) } }

  /// Whether this comment waits for its drawing to find a way to the computer.
  func commentHeldBack(_ comment: FileComment) -> Bool {
    comment.images.contains { PendingDrawing.hash($0.path).map(drawingHeldBack) ?? false }
      || held.contains { $0.kind == .annotation && $0.subject == comment.id && heldBack($0) }
  }

  /// A Send that waits and carries a comment whose drawing cannot reach the computer now goes without it: the comment
  /// is back in the list, marked, and goes by itself once its drawing is there (`owed`). A Send that carried nothing
  /// else is not made at all. True when the Send changed or left.
  @discardableResult
  func releaseHeldBackComments(_ reply: HeldWrite) -> Bool {
    guard reply.kind == .reply, !book.inFlight.contains(reply.id), let ids = (try? JSONDecoder().decode(DoorReplyBody.self, from: reply.body))?.annotationIds, !ids.isEmpty else { return false }
    let kept = commentBook.kept[ThreadID(reply.thread)] ?? []
    let blocked = Set(ids.filter { id in kept.first(where: { $0.id == id }).map(drawingWaits) ?? false })
    guard !blocked.isEmpty else { return false }
    // The mark is kept before the Send changes, to the agent this Send answers: an app that ends in between finds the
    // Send still carrying them and lets go of them again. Kept after, an end in between would lose the mark.
    commentBook.owe(blocked, to: reply.message.map { MessageID($0) })
    keepComments()
    switch strip(reply.id, of: blocked) {
    case .unchanged:
      commentBook.owed.subtract(blocked)
      keepComments()
      return false
    case .stripped: break
    case .wouldEmpty:
      held.removeAll { $0.id == reply.id }
      saveOutbox()
    }
    return true
  }

  /// Every Send of this thread that waits lets go of the comments whose drawing cannot reach the computer now.
  func releaseHeldBackSends(_ thread: String) {
    for reply in held where reply.kind == .reply && reply.thread == thread { releaseHeldBackComments(reply) }
  }

  /// Whether a write still on the phone is one the person sees as waiting to send ("Will send"): not a look at a
  /// thread, and not a drawing (or its comment's save) that waits for the computer's own network. Nothing is queued
  /// for those: their comments are in the list, marked.
  public func willSend(_ write: HeldWrite) -> Bool {
    switch write.kind {
    case .seen: return false
    case .markup, .annotation:
      if heldBack(write) { return false }
      let named = commentsNamed(by: write)
      let kept = commentBook.kept[ThreadID(write.thread)] ?? []
      let comments = kept.filter { named.contains($0.id) }
      return comments.isEmpty || !comments.allSatisfy(drawingWaits)
    default: return true
    }
  }

  /// The comments the thread's strip, a file's tile and the cover count: the ones the next Send carries, and the
  /// ones whose drawing waits for the computer's own network (they are in the list, marked, until they go).
  public func commentsCounted(_ thread: ThreadID) -> [FileComment] {
    let items = attachments(thread)
    return comments(thread).filter { comment in
      let standing = commentStanding(comment, items: items)
      return standing.rides || standing == .drawingWaits
    }
  }

  // MARK: A comment that goes by itself

  /// Whether a comment names a drawing the computer does not have yet.
  static func drawingPending(_ comment: FileComment) -> Bool { comment.images.contains { PendingDrawing.hash($0.path) != nil } }

  /// The comments the person sent while their drawing could not reach the computer, that still wait for it: the
  /// thread says so.
  public func commentsNeedingNetwork(_ thread: ThreadID) -> [FileComment] {
    comments(thread).filter { commentBook.owed.contains($0.id) && drawingWaits($0) }
  }

  /// The comments a Send cannot carry now because their drawing cannot reach the computer, and that do not go by
  /// themselves yet: a Send makes them go by themselves.
  func commentsToOwe(_ thread: ThreadID) -> [FileComment] {
    let items = attachments(thread)
    return comments(thread).filter { !commentBook.owed.contains($0.id) && commentStanding($0, items: items) == .drawingWaits }
  }

  /// Whether a comment that goes by itself still waits on a drawing: its own, or one of another comment that goes by
  /// itself to the same agent (they go together, in one Send).
  func owedDrawingPending(_ comment: FileComment) -> Bool {
    if Self.drawingPending(comment) { return true }
    let to = commentBook.owedTo[comment.id]
    return (commentBook.kept[comment.thread] ?? []).contains { other in
      other.id != comment.id && commentBook.owed.contains(other.id) && commentBook.owedTo[other.id] == to && Self.drawingPending(other)
    }
  }

  /// The comments that go by themselves and can now: every drawing of theirs is on the computer. Those for one agent
  /// go together, in one Send of their own with no words, to the agent the person's words went to when they pressed
  /// Send (that agent's latest message now, as a Send to it would answer), whoever wrote after. They leave `owed` in the
  /// same step (the Send is in the outbox first, so a relaunch in between never sends them twice: a comment a Send
  /// carries is not here). One whose words are being changed waits for its editor to close. Once their drawings are
  /// there, comments that cannot go by themselves now (the thread is handed on or archived, this Inbox takes no reply)
  /// are no longer owed: they are plain comments, for the person's next Send, never sent later by themselves.
  func sendOwed(_ thread: ThreadID) {
    guard !commentBook.owed.isEmpty else { return }
    // One that left (sent, removed) or rides a Send already is no longer owed.
    let riding = riding(thread)
    let everywhere = Set(commentBook.kept.values.joined().map(\.id))
    let gone = commentBook.owed.filter { !everywhere.contains($0) || riding.contains($0) }
    if !gone.isEmpty {
      commentBook.owed.subtract(gone)
      keepComments()
    }
    guard standing == .ok, let model = self.thread(thread) else { return }
    let owedHere = comments(thread).filter { commentBook.owed.contains($0.id) }
    guard !owedHere.isEmpty else { return }
    // By the message each was marked for: those wait for one another.
    var marked: [MessageID?: [FileComment]] = [:]
    var order: [MessageID?] = []
    for comment in owedHere {
      let to = commentBook.owedTo[comment.id]
      if marked[to] == nil { order.append(to) }
      marked[to, default: []].append(comment)
    }
    let last = SendPlan.targets(in: model.thread).last?.message
    let canSend = (offers(DoorRoutes.postMessageReply) || skew == nil) && !SendPlan.needsComputer(model.thread) && model.thread.resolvedAt == nil
    let items = attachments(thread)
    var settled: [String] = []
    // The reply each group goes in: one per agent message it answers now.
    var sends: [MessageID: [FileComment]] = [:]
    var sendOrder: [MessageID] = []
    for to in order {
      let group = marked[to] ?? []
      guard !group.contains(where: Self.drawingPending), !group.contains(where: { $0.id == editingComment }) else { continue }
      settled.append(contentsOf: group.map(\.id))
      let ready = group.filter { commentStanding($0, items: items).rides }
      guard canSend, let target = to.flatMap({ SendPlan.latest(sessionOf: $0, in: model.thread) }) ?? last, !ready.isEmpty else { continue }
      if sends[target] == nil { sendOrder.append(target) }
      sends[target, default: []].append(contentsOf: ready)
    }
    guard !settled.isEmpty else { return }
    for target in sendOrder {
      let ready = sends[target] ?? []
      let key = UUID().uuidString
      var body = DoorReplyBody(idempotencyKey: key, words: "", questions: [], withThread: true)
      body.feedback = feedback(ready, thread: thread)
      body.annotationIds = ready.map(\.id)
      enqueue(kind: .reply, thread: thread, message: target, request: Door.postMessageReply(message: target), body: (try? JSONEncoder().encode(body)) ?? Data("{}".utf8), key: key)
    }
    commentBook.owed.subtract(settled)
    keepComments()
  }

  /// The comments a refused save or drawing is about.
  func commentsNamed(by write: HeldWrite) -> Set<String> {
    switch write.kind {
    case .annotation: return Set([write.subject].compactMap { $0 })
    case .markup:
      let path = write.subject.map(PendingDrawing.path) ?? ""
      return Set((commentBook.kept[ThreadID(write.thread)] ?? []).filter { $0.images.contains { $0.path == path } }.map(\.id))
    default: return []
    }
  }

  /// The Sends made after `write` go without these comments (they stay for a later Send). Returns the Sends that
  /// would be left with nothing at all: those are not changed here (they are the person's, and are told about).
  func releaseSends(after write: HeldWrite, without ids: Set<String>) -> [String] {
    guard !ids.isEmpty, let start = held.firstIndex(where: { $0.id == write.id }) else { return [] }
    let later = held[(start + 1)...].filter { $0.thread == write.thread && $0.kind == .reply }.map(\.id)
    return later.filter { strip($0, of: ids) == .wouldEmpty }
  }

  enum Stripped { case unchanged, stripped, wouldEmpty }

  /// Take comments out of a Send that waits: its feedback is written again for the rest. A Send that would be left
  /// with no words, no answer and no comment is never emptied: it is left as it is (`wouldEmpty`).
  @discardableResult
  func strip(_ reply: String, of ids: Set<String>) -> Stripped {
    guard let index = held.firstIndex(where: { $0.id == reply }), !book.inFlight.contains(reply), var body = try? JSONDecoder().decode(DoorReplyBody.self, from: held[index].body),
      let carried = body.annotationIds, carried.contains(where: ids.contains)
    else { return .unchanged }
    let thread = ThreadID(held[index].thread)
    let left = carried.filter { !ids.contains($0) }
    if left.isEmpty, Self.onlyComments(body) { return .wouldEmpty }
    let kept = commentBook.kept[thread] ?? []
    body.annotationIds = left.isEmpty ? nil : left
    body.feedback = left.isEmpty ? nil : feedback(left.compactMap { id in kept.first { $0.id == id } }, thread: thread)
    held[index].body = (try? JSONEncoder().encode(body)) ?? held[index].body
    saveOutbox()
    return .stripped
  }

  /// A drawing no comment names any more, or one the computer has: its bytes leave the phone.
  func forgetDrawing(_ hash: String) {
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
      commentBook.owed.remove(comment.id)
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
    kept.removeAll { $0.saved && !there.contains($0.id) && !waiting.contains($0.id) && !riding.contains($0.id) && !newer($0.id) && !commentBook.keepThrough.contains($0.id) }
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
    // Sent or removed in the window: it does not go by itself from here.
    commentBook.owed = commentBook.owed.filter { everywhere.contains($0) }
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

  /// Whether a comment waits for its drawing, which the way to the computer cannot carry now: it rides no Send until
  /// the drawing has arrived.
  /// One that goes by itself waits until its drawing is there, whatever the way: it rides no Send the person makes.
  /// One that goes with others to the same agent waits for their drawings too.
  public func drawingWaits(_ comment: FileComment) -> Bool {
    commentHeldBack(comment) || (commentBook.owed.contains(comment.id) && owedDrawingPending(comment))
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
        // Not saved: it does not go by itself; the person sees why, and sends it after a change.
        commentBook.owed.remove(id)
      }
    case .markup:
      let waiting = write.subject.map(PendingDrawing.path) ?? ""
      for comment in commentBook.kept[thread] ?? [] where comment.images.contains(where: { $0.path == waiting }) {
        commentBook.refused[comment.id] = notice
        commentBook.owed.remove(comment.id)
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
    commentBook.owed.subtract(ids)
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
    // The phone's own comments of that Send are kept through the read, whatever the list says: their words are not
    // lost, and one the computer does not list is held back as not saved.
    let own = Set(ids.filter { commentBook.readKeys[$0] != nil })
    commentBook.keepThrough.formUnion(own)
    defer { commentBook.keepThrough.subtract(own) }
    guard let listed = await readAttachments(thread) else { return }
    for id in ids where !listed.contains(id) {
      guard let index = commentBook.kept[thread]?.firstIndex(where: { $0.id == id }), !held.contains(where: { $0.kind == .annotation && $0.subject == id }) else { continue }
      commentBook.kept[thread]![index].saved = false
      if commentBook.refused[id] == nil { commentBook.refused[id] = notice }
    }
    keepComments()
  }
}
