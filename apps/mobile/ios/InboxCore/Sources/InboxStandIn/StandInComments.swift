import CryptoKit
import Foundation
import InboxCore
import InboxWire

/// The stand-in computer's comments on files and its kept drawings, with the Inbox's own refusals
/// (packages/shared/inbox/store.ts `saveAnnotation`, `removeAnnotation`, `pendingAnnotations`;
/// packages/shared/inbox/markups.ts `writeInboxMarkup`).
extension StandInDoor {
  /// Where the stand-in keeps a drawing: a path as an Inbox's would read, with nobody's name in it.
  public static func markupPath(_ name: String) -> String { "/home/person/.plannotator/inbox/markups/\(name)" }

  // MARK: For the tests and the demo

  /// The comments that wait for a Send in a thread, oldest first.
  public func pendingComments(_ thread: ThreadID) -> [InboxAnnotationRecord] {
    state.annotations.values.filter { $0.threadId == thread && $0.removedAt == nil && $0.sentReplyId == nil }.sorted { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }
  }

  /// Every comment record the stand-in ever kept, by id.
  public func comment(_ id: String) -> InboxAnnotationRecord? { state.annotations[id] }

  /// A comment made in the window, on a file of the thread.
  @discardableResult
  public func windowComments(on attachment: String, version: String = "current", annotation: [String: JSONValue]) -> DoorAnswerBytes {
    saveComment(["attachment_id": .string(attachment), "version": .string(version), "annotation": .object(annotation)])
  }

  /// The window removes a comment, or sends it with a reply of its own.
  public func windowRemovesComment(_ id: String) { state.annotations[id]?.removedAt = StandInData.iso(Date()) }
  public func windowSendsComment(_ id: String) { state.annotations[id]?.sentReplyId = "msg_WINDOWREPLY" }
  /// The computer no longer has a comment at all (its store was reset): a Send naming it is refused `annotation_not_found`.
  public func forgetComment(_ id: String) { state.annotations[id] = nil }

  /// The file takes no comments (as a PDF does): a save is answered `422 annotation_not_allowed`.
  public func refuseComments(on attachment: String) { state.refusesComments.insert(attachment) }

  /// A drawing the stand-in keeps, by its file name.
  public func markup(_ name: String) -> Data? { state.markups[name] }
  public var markupCount: Int { state.markups.count }

  // MARK: The routes

  func saveComment(_ fields: [String: JSONValue]) -> DoorAnswerBytes {
    guard case .string(let attachment)? = fields["attachment_id"], let file = state.files[attachment] else { return refuse(404, "attachment_not_found", "No attachment.") }
    if state.refusesComments.contains(attachment) || [.pdf, .file].contains(file.record.kind) {
      return refuse(422, "annotation_not_allowed", "annotation: \(file.record.name) is offered as a download; it takes no annotations.", field: "attachment_id")
    }
    guard case .string(let version)? = fields["version"], version == "current" || version == file.record.sentSha256 else {
      return refuse(422, "validation_error", "version: not a version of this attachment.", field: "version")
    }
    guard case .object(let annotation)? = fields["annotation"] else { return refuse(422, "validation_error", "annotation: an object.", field: "annotation") }
    guard case .string(let id)? = annotation["id"], id.wholeMatch(of: /[A-Za-z0-9_.:-]{1,200}/) != nil else { return refuse(422, "validation_error", "annotation.id: a short id.", field: "annotation.id") }
    if (state.rows[file.thread]?.resolvedAt) != nil { return refuse(409, "thread_resolved", "This thread is resolved; reopen it to annotate.") }
    let existing = state.annotations[id]
    if let existing, existing.path != file.record.path || existing.version != version || existing.threadId != file.thread {
      return refuse(422, "validation_error", "annotation.id: already used on another file or version.", field: "annotation.id")
    }
    if let existing, existing.sentReplyId != nil || existing.removedAt != nil { return refuse(409, "annotation_closed", "This annotation was already sent or removed.") }
    seq += 1
    // The clock moves a millisecond with each record, so records made in one instant keep the order made.
    let at = StandInData.iso(Date(timeIntervalSince1970: (Date().timeIntervalSince1970 * 1000).rounded() / 1000 + Double(state.annotations.count) / 1000))
    var kept = annotation
    kept["exportLocation"] = nil
    let project = threads.first { $0.threadId == file.thread }?.messages.first?.projectId ?? ProjectID("")
    let record = InboxAnnotationRecord(
      id: id, projectId: project, threadId: file.thread, messageId: existing?.messageId ?? file.message, attachmentId: existing?.attachmentId ?? AttachmentID(attachment), path: file.record.path, version: version,
      annotation: kept, createdAt: existing?.createdAt ?? at, updatedAt: at)
    state.annotations[id] = record
    return encode(200, DoorAnnotationAnswer(annotation: record))
  }

  func removeComment(_ id: String) -> DoorAnswerBytes {
    guard var record = state.annotations[id] else { return refuse(404, "annotation_not_found", "No annotation \(id).") }
    if record.removedAt == nil {
      if record.sentReplyId != nil { return refuse(409, "annotation_closed", "This annotation was already sent.") }
      record.removedAt = StandInData.iso(Date())
      record.updatedAt = record.removedAt ?? record.updatedAt
      state.annotations[id] = record
    }
    return encode(200, DoorAnnotationAnswer(annotation: record))
  }

  /// `POST markups`: the drawing's own bytes, its key in the query. Kept once, by its hash.
  func keepDrawing(_ call: DoorCall) -> DoorAnswerBytes {
    if let code = options.refusesMarkups { return refuse(413, code, code == "relay_upload_unavailable" ? "Files and drawings are sent over the Wi-Fi or the tailnet, not the relay." : "The drawing is too large.") }
    guard let key = call.query.first(where: { $0.name == "idempotency_key" })?.value, !key.isEmpty else {
      return refuse(422, "validation_error", "idempotency_key: a key is required.", field: "idempotency_key")
    }
    guard let body = call.body, body.starts(with: [0x89, 0x50, 0x4E, 0x47]) else { return refuse(422, "validation_error", "The body must be a PNG, JPEG or WebP image.") }
    let name = "\(SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()).png"
    state.markups[name] = body
    return encode(200, DoorMarkupAnswer(path: Self.markupPath(name), name: name, url: "/api/inbox/markups/\(name)"))
  }
}
