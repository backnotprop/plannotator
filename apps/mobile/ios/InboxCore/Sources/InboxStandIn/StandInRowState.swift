import CryptoKit
import Foundation
import InboxCore
import InboxWire

/// A thread's state the stand-in keeps beside its messages: what the real Inbox keeps in its own files.
public struct StandInRowState: Hashable, Sendable {
  public var resolvedAt: String?
  public var readAt: String?
  public var pinnedAt: String?
  public var snoozed: InboxRowSnooze?
  public var priority: InboxRowPriority?
  public var priorityOffAt: String?
  public init() {}
}

/// A file a message carries on the stand-in computer.
public struct StandInFile: Sendable {
  public var record: InboxAttachment
  public var message: MessageID
  public var thread: ThreadID
  /// The bytes as sent, and as they are now (nil: the file is gone).
  public var sent: Data
  public var current: Data?
  public init(record: InboxAttachment, message: MessageID, thread: ThreadID, sent: Data, current: Data?) {
    self.record = record
    self.message = message
    self.thread = thread
    self.sent = sent
    self.current = current
  }
}

struct StandInState {
  var rows: [ThreadID: StandInRowState] = [:]
  var pins: [ThreadID] = []
  var drafts: [ThreadID: InboxReplyDraft] = [:]
  var files: [String: StandInFile] = [:]
  /// The most bytes one ranged answer carries (the door's 8 MiB, smaller in tests).
  var partCap = 8 * 1024 * 1024
  /// Byte reads that stop after this many answers, as a lost connection would (nil: never).
  var failBytesAfter: Int?
  var byteReads = 0
  /// Files that change after each byte read, as a log an agent appends to does, this many times more.
  var churn: [String: Int] = [:]
  /// A file that changes right after the computer next says how a thread's files stand: the agent edits it after
  /// the phone last asked.
  var changeAfterRead: (id: String, bytes: Data?)?
  /// The person's comments (`annotations.jsonl`): every record ever saved, by annotation id.
  var annotations: [String: InboxAnnotationRecord] = [:]
  /// Drawings kept (`inbox/markups/<sha256>.png`), by file name.
  var markups: [String: Data] = [:]
  /// Saves of a comment answered `422 annotation_not_allowed`, by attachment id (a file that takes none).
  var refusesComments: Set<String> = []
}

extension StandInDoor {
  // MARK: For the tests and the demo

  /// Change a thread's kept state as another device or the window would.
  public func changeState(_ id: ThreadID, _ edit: @Sendable (inout StandInRowState) -> Void) {
    var row = state.rows[id] ?? StandInRowState()
    edit(&row)
    state.rows[id] = row
    if row.pinnedAt != nil, !state.pins.contains(id) { state.pins.append(id) }
    if row.pinnedAt == nil { state.pins.removeAll { $0 == id } }
  }
  public func rowState(_ id: ThreadID) -> StandInRowState { state.rows[id] ?? StandInRowState() }
  public var pins: [ThreadID] { state.pins }

  /// The window's draft for a thread, as if typed there.
  public func setDraft(_ id: ThreadID, body: String?, at: Date = Date()) {
    guard let body else { state.drafts[id] = nil; return }
    let stamp = StandInData.iso(at)
    state.drafts[id] = InboxReplyDraft(v: 1, threadId: id, body: body, createdAt: state.drafts[id]?.createdAt ?? stamp, updatedAt: stamp)
  }
  public func draft(_ id: ThreadID) -> InboxReplyDraft? { state.drafts[id] }

  /// A file on a message (the thread's newest from an agent, when none is named): in the message's record, and its
  /// bytes on the computer.
  public func addFile(thread id: ThreadID, message: MessageID? = nil, name: String, kind: InboxAttachmentKind, bytes: Data, mediaType: String? = nil, width: Double? = nil, height: Double? = nil, durationMs: Int64? = nil) -> InboxAttachment {
    counter += 1
    let attachment = InboxAttachment(
      id: "att_STANDIN\(counter)", path: "\(threads.first { $0.threadId == id }?.project.root ?? "/work")/\(name)", name: name, kind: kind, sentSha256: Self.sha(bytes), size: Int64(bytes.count), sentAt: StandInData.iso(Date()),
      sentMtime: StandInData.iso(Date()), mediaType: mediaType, width: width, height: height, durationMs: durationMs)
    guard let t = threads.firstIndex(where: { $0.threadId == id }), let m = threads[t].messages.lastIndex(where: { candidate in message.map { $0 == candidate.id } ?? (candidate.author.kind == .agent) }) else { return attachment }
    threads[t].messages[m].attachments = (threads[t].messages[m].attachments ?? []) + [attachment]
    state.files[attachment.id] = StandInFile(record: attachment, message: threads[t].messages[m].id, thread: id, sent: bytes, current: bytes)
    return attachment
  }
  /// The file changes on the computer after it was sent (nil: it is deleted).
  public func changeFile(_ id: String, to bytes: Data?) { state.files[id]?.current = bytes }
  /// The file changes on the computer right after the next answer about the thread's files.
  public func changeFileAfterNextRead(_ id: String, to bytes: Data?) { state.changeAfterRead = (id, bytes) }
  /// The file changes after each of the next `times` byte reads.
  public func keepChanging(_ id: String, times: Int) { state.churn[id] = times }
  public func setPartCap(_ bytes: Int) { state.partCap = bytes }
  public func failBytes(after answers: Int?) {
    state.failBytesAfter = answers
    state.byteReads = 0
  }

  static func sha(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

  // MARK: The list, dressed with the kept state

  func dressed(_ row: InboxListRow) -> InboxListRow {
    guard let kept = state.rows[row.threadId] else { return row }
    var row = row
    row.resolvedAt = kept.resolvedAt
    row.readAt = kept.readAt
    row.pinnedAt = kept.pinnedAt
    row.snoozed = kept.snoozed
    row.priority = kept.priority
    if kept.resolvedAt != nil {
      // The Inbox's GET threads keeps an archived thread in Quiet, read.
      row.section = .quiet
      row.unread = false
    } else if kept.readAt != nil, [.stopped, .holding, .waiting].contains(row.section), !unread.contains(row.threadId) {
      // A Mark read set its questions aside (a stand-in for the Inbox's own rule).
      row.section = .quiet
    }
    return row
  }

  func dressed(_ model: ListModel) -> ListModel {
    var model = model
    for index in model.sections.indices { model.sections[index].threads = model.sections[index].threads.map(dressed) }
    let rows = model.sections.flatMap(\.threads)
    model.pins = state.pins.compactMap { id in rows.first { $0.threadId == id } }
    return model
  }

  func listRow(_ id: ThreadID) -> InboxListRow? {
    threads.first { $0.threadId == id }.map { dressed(StandInData.row(of: $0, unread: unread.contains(id))) }
  }

  // MARK: Reads

  func getMore(_ call: DoorCall, _ parts: [String]) -> DoorAnswerBytes? {
    let parts = parts.map { $0.removingPercentEncoding ?? $0 }
    if parts == ["threads", "archived"] {
      let query = Dictionary(call.query.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { $1 })
      let offset = Int(query["offset"] ?? "") ?? 0
      let limit = Int(query["limit"] ?? "") ?? 20
      let all = ListRules.archivedRows(threads.compactMap { listRow($0.threadId) })
      let page = Array(all.dropFirst(offset).prefix(limit))
      return encode(200, ArchivedModel(serverSession: session, cursor: seq, projects: [], total: Int64(all.count), offset: Int64(offset), limit: Int64(limit), threads: page))
    }
    if parts.count == 3, parts[0] == "threads", parts[2] == "draft" {
      let id = ThreadID(parts[1])
      guard threads.contains(where: { $0.threadId == id }) else { return refuse(404, "thread_not_found", "No thread \(id.rawValue).") }
      return encode(200, DoorThreadDraftAnswer(serverSession: session, draft: state.drafts[id]))
    }
    if parts.count == 3, parts[0] == "threads", parts[2] == "attachments" {
      let id = ThreadID(parts[1])
      guard threads.contains(where: { $0.threadId == id }) else { return refuse(404, "thread_not_found", "No thread \(id.rawValue).") }
      let states = state.files.values.filter { $0.thread == id }.sorted { $0.record.id < $1.record.id }.map(attachmentState)
      if let change = state.changeAfterRead {
        state.changeAfterRead = nil
        state.files[change.id]?.current = change.bytes
      }
      return encode(200, DoorThreadAttachmentsAnswer(serverSession: session, attachments: states, inlineImages: [], annotations: options.omitsComments ? nil : pendingComments(id)))
    }
    if parts.count == 3, parts[0] == "attachments", ["image", "video", "audio", "download"].contains(parts[2]) {
      return bytes(call, file: parts[1], ranged: parts[2] != "image")
    }
    return nil
  }

  func attachmentState(_ file: StandInFile) -> InboxAttachmentState {
    let r = file.record
    let current = file.current.map { InboxAttachmentStateCurrent(sha256: Self.sha($0), size: Int64($0.count), mtime: r.sentMtime) }
    return InboxAttachmentState(
      messageId: file.message, current: current, changedSinceSent: current.map { $0.sha256 != r.sentSha256 } ?? false,
      unavailable: file.current == nil ? InboxAttachmentStateUnavailable(code: .attachmentMissing, message: "\(r.name) is no longer on the computer.") : nil,
      id: r.id, path: r.path, name: r.name, kind: r.kind, sentSha256: r.sentSha256, size: r.size, sentAt: r.sentAt, sentMtime: r.sentMtime, mediaType: r.mediaType, width: r.width, height: r.height, durationMs: r.durationMs)
  }

  /// The byte routes: the version asked for, whole, or the part a Range names (at most `partCap`), as
  /// packages/server/inbox-byte-range.ts answers: 206 with Content-Range, 416 past the end, If-Range kept.
  func bytes(_ call: DoorCall, file id: String, ranged: Bool) -> DoorAnswerBytes {
    let answer = answerBytes(call, file: id, ranged: ranged)
    if let left = state.churn[id], left > 0, var changed = state.files[id]?.current, !changed.isEmpty {
      state.churn[id] = left - 1
      changed[0] = changed[0] &+ 1
      state.files[id]?.current = changed
    }
    return answer
  }

  private func answerBytes(_ call: DoorCall, file id: String, ranged: Bool) -> DoorAnswerBytes {
    guard let file = state.files[id] else { return refuse(404, "attachment_not_found", "No attachment \(id).") }
    state.byteReads += 1
    if let fail = state.failBytesAfter, state.byteReads > fail { return refuse(503, "machine_unreachable", "The computer stopped answering.") }
    let sent = call.query.contains { $0.name == "version" && $0.value == "sent" }
    guard let data = sent ? file.sent : file.current else { return refuse(404, "attachment_missing", "\(file.record.name) is no longer on the computer.") }
    let etag = "\"\(Self.sha(data))\""
    let headers = Dictionary(call.headers.map { ($0.key.lowercased(), $0.value) }, uniquingKeysWith: { $1 })
    var base = ["content-type": file.record.mediaType ?? "application/octet-stream", "etag": etag, "cache-control": "no-store"]
    if ranged { base["accept-ranges"] = "bytes" }
    guard ranged, let range = headers["range"], headers["if-range"].map({ $0 == etag }) ?? true,
      let match = range.wholeMatch(of: /bytes=(\d+)-(\d*)/), let start = Int(match.1)
    else { return DoorAnswerBytes(status: 200, headers: base, body: data) }
    guard start < data.count else {
      base["content-range"] = "bytes */\(data.count)"
      return DoorAnswerBytes(status: 416, headers: base, body: Data())
    }
    let asked = Int(match.2).map { min($0, data.count - 1) } ?? data.count - 1
    let end = min(asked, start + state.partCap - 1)
    base["content-range"] = "bytes \(start)-\(end)/\(data.count)"
    return DoorAnswerBytes(status: 206, headers: base, body: data.subdata(in: start..<(end + 1)))
  }

  // MARK: Writes

  /// The thread-state routes, with the Inbox's refusals (packages/server/inbox.ts and packages/shared/inbox/store.ts).
  func postMore(_ parts: [String], _ fields: [String: JSONValue]) -> DoorAnswerBytes? {
    let now = StandInData.iso(Date())
    if parts == ["pins"] {
      if case .array(let order)? = fields["order"] {
        let named = order.compactMap { value -> ThreadID? in if case .string(let id) = value { return ThreadID(id) }; return nil }.filter(state.pins.contains)
        state.pins = named + state.pins.filter { !named.contains($0) }
      } else if case .object(let restore)? = fields["restore"], case .string(let id)? = restore["thread_id"], case .number(let index)? = restore["index"], case .string(let at)? = restore["pinned_at"] {
        let thread = ThreadID(id)
        if !state.pins.contains(thread) { state.pins.insert(thread, at: min(max(Int(index), 0), state.pins.count)) }
        state.rows[thread, default: StandInRowState()].pinnedAt = at
      } else {
        return refuse(422, "validation_error", "order or restore: one is required.", field: "order")
      }
      return json(200, ["pins": .array(state.pins.map { .string($0.rawValue) })])
    }
    if parts == ["annotations"] { return saveComment(fields) }
    guard parts.count == 3 else { return nil }
    if parts[0] == "annotations", parts[2] == "remove" { return removeComment(parts[1]) }
    let id = ThreadID(parts[1])
    if parts[0] == "messages", parts[2] == "resolve" {
      // The thread's root message carries the thread's id.
      guard threads.contains(where: { $0.threadId == id }) else { return refuse(404, "message_not_found", "No message \(id.rawValue).") }
      guard case .bool(let resolved)? = fields["resolved"] else { return refuse(422, "validation_error", "resolved: true or false.", field: "resolved") }
      var kept = state.rows[id] ?? StandInRowState()
      if resolved {
        if kept.resolvedAt == nil { kept.resolvedAt = now }
        kept.snoozed = nil
        if kept.priority != nil { kept.priorityOffAt = now }
        kept.priority = nil
        unread.remove(id)
      } else {
        kept.resolvedAt = nil
      }
      state.rows[id] = kept
      return json(200, ["ok": .bool(true)])
    }
    guard parts[0] == "threads", threads.contains(where: { $0.threadId == id }) else { return parts[0] == "threads" ? refuse(404, "thread_not_found", "No thread \(id.rawValue).") : nil }
    var kept = state.rows[id] ?? StandInRowState()
    let archivedRefusal = refuse(409, "thread_resolved", "This thread is archived; unarchive it first.")
    let answer: DoorAnswerBytes
    switch parts[2] {
    case "read":
      if kept.resolvedAt != nil { return archivedRefusal }
      kept.readAt = now
      kept.snoozed = nil
      unread.remove(id)
      state.rows[id] = kept
      return encode(200, ["thread": listRow(id)])
    case "unread":
      kept.readAt = nil
      state.rows[id] = kept
      return encode(200, ["thread": listRow(id)])
    case "mark-unread":
      let wrote = !unread.contains(id)
      unread.insert(id)
      return encode(200, DoorMarkUnreadAnswer(thread: listRow(id)!, wrote: wrote, throughSeq: seq))
    case "pin":
      guard case .bool(let pinned)? = fields["pinned"] else { return refuse(422, "validation_error", "pinned: true or false.", field: "pinned") }
      kept.pinnedAt = pinned ? (kept.pinnedAt ?? now) : nil
      if pinned, !state.pins.contains(id) { state.pins.append(id) }
      if !pinned { state.pins.removeAll { $0 == id } }
      state.rows[id] = kept
      answer = json(200, ["pins": .array(state.pins.map { .string($0.rawValue) })])
    case "snooze":
      if case .string(let until)? = fields["until"] {
        if kept.resolvedAt != nil { return archivedRefusal }
        switch SnoozeRules.refusal(until, now: Date()) {
        case .invalid?: return refuse(422, "validation_error", "until: an ISO time.", field: "until")
        case .past?: return refuse(409, "snooze_past", "That time has passed.")
        case .far?: return refuse(422, "validation_error", "until: at most 366 days ahead.", field: "until")
        case nil: break
        }
        var at = now
        if case .string(let given)? = fields["at"] { at = given }
        kept.snoozed = InboxRowSnooze(until: until, at: at)
      } else {
        kept.snoozed = nil
      }
      state.rows[id] = kept
      answer = encode(200, DoorSnoozeAnswer(snoozed: kept.snoozed))
    case "priority":
      let before = DoorPriorityBefore(at: kept.priority?.at, offAt: kept.priorityOffAt)
      if case .object(let restore)? = fields["restore"] {
        if case .string(let at)? = restore["at"] { kept.priority = InboxRowPriority(person: true, at: at) } else { kept.priority = nil }
        if case .string(let off)? = restore["off_at"] { kept.priorityOffAt = off } else { kept.priorityOffAt = nil }
      } else if case .bool(let on)? = fields["priority"] {
        if on, kept.resolvedAt != nil { return archivedRefusal }
        if on, kept.priority == nil { kept.priority = InboxRowPriority(person: true, at: now) }
        if !on, kept.priority != nil {
          kept.priority = nil
          kept.priorityOffAt = now
        }
      } else {
        return refuse(422, "validation_error", "priority or restore: one is required.", field: "priority")
      }
      state.rows[id] = kept
      answer = encode(200, DoorPriorityAnswer(before: before))
    default:
      return nil
    }
    return answer
  }
}
