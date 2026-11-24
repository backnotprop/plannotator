import Foundation
import InboxWire

/// A reply's words kept on the phone for one thread: they survive leaving the thread and closing the app, and are
/// erased with the computer.
public struct LocalDraft: Codable, Hashable, Sendable {
  public var words: String
  /// When the person last typed them (the phone's clock).
  public var editedAt: Date
  /// The computer's draft these words started from (its `updated_at`), when they did.
  public var base: String?
  /// Files attached to the reply, kept on the phone with the words (DraftFiles.swift).
  public var files: [DraftFile]?
  /// The message the reply quotes.
  public var quote: DraftQuote?
  /// The agent session ↩ aimed the reply at (`SendPlan.targets(in:aim:)`). Kept only while the draft holds a quote:
  /// the quote line is what shows the person where the words go, so with no quote there is no aim.
  public var aim: String?
  /// The agents the person tagged with `@` (Tags.swift), in the order picked. A tag whose `@` token the words no
  /// longer hold is dropped as the person types (`TagRules.standing`); a Send of the words spends them all.
  public var tags: [DraftTag]?

  public init(words: String, editedAt: Date, base: String? = nil, files: [DraftFile]? = nil, quote: DraftQuote? = nil, aim: String? = nil, tags: [DraftTag]? = nil) {
    self.words = words
    self.editedAt = editedAt
    self.base = base
    self.files = files
    self.quote = quote
    self.aim = aim
    self.tags = tags
  }

  /// Nothing the person made is in it: it is not kept.
  public var isEmpty: Bool { words.isEmpty && (files ?? []).isEmpty && quote == nil && (tags ?? []).isEmpty }
}

/// The message a reply quotes (the window's `quote`, approval "inbox-reply-quote"): the whole message, or the words
/// selected in it.
public struct DraftQuote: Codable, Hashable, Sendable {
  public var of: MessageID
  public var words: String?

  public init(of: MessageID, words: String? = nil) {
    self.of = of
    self.words = words
  }
}

/// What a thread's reply box starts with when it opens.
public struct DraftOpening: Hashable, Sendable {
  public enum Other: Hashable, Sendable {
    /// The phone's own words lost to a newer draft from the computer ("Your words from this phone", SPEC 1.7).
    case fromThisPhone
    /// The computer's draft lost to newer words typed on this phone.
    case fromComputer
  }

  /// The words in the box.
  public var words: String
  /// The computer's draft the words came from: hand it to `send(clearDraft:)`, so sending them clears it there too.
  public var clearDraft: String?
  /// The other side's words when both changed: offered to paste, never dropped.
  public var otherWords: String?
  public var other: Other?

  public init(words: String, clearDraft: String? = nil, otherWords: String? = nil, other: Other? = nil) {
    self.words = words
    self.clearDraft = clearDraft
    self.otherWords = otherWords
    self.other = other
  }

  /// Which words a reply box starts with: the phone's and the computer's, the newer in the box and the other offered.
  /// Words that started from the computer's draft and kept its `updated_at` are a continuation of it, not a conflict.
  public static func of(local: LocalDraft?, computer: InboxReplyDraft?) -> DraftOpening {
    let mine = local.flatMap { $0.words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
    let theirs = computer.flatMap { $0.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
    switch (mine, theirs) {
    case (nil, nil): return DraftOpening(words: local?.words ?? "")
    case (nil, let draft?): return DraftOpening(words: draft.body, clearDraft: draft.updatedAt)
    case (let words?, nil): return DraftOpening(words: words.words)
    case (let words?, let draft?):
      if words.words == draft.body || words.base == draft.updatedAt { return DraftOpening(words: words.words, clearDraft: draft.updatedAt) }
      if let changed = SnoozeRules.date(draft.updatedAt), changed > words.editedAt {
        return DraftOpening(words: draft.body, clearDraft: draft.updatedAt, otherWords: words.words, other: .fromThisPhone)
      }
      return DraftOpening(words: words.words, otherWords: draft.body, other: .fromComputer)
    }
  }
}

/// Where the phone keeps drafts. Saving to the computer is a seam: the door forwards `GET threads/:id/draft` only
/// (contract 7.62, packages/server/inbox-devices.ts; `POST threads/:id/draft` and `draft/delete` are not on it), so
/// the phone shows the computer's draft and keeps its own words here. When the door takes the writes (brief F5a,
/// with the window's compare-and-set on `base` and `409 draft_conflict`), `DraftSync.savesToComputer` turns true and
/// the session saves to the computer as it types.
public enum DraftSync {
  /// Whether this Inbox takes a phone's draft writes. TODO(contract): the generated route, once the door lists it.
  public static func savesToComputer(_ skew: DoorSkew?) -> Bool { false }
}

struct DraftBook {
  var local: [ThreadID: LocalDraft] = [:]
  /// The new message being written (Compose.swift).
  var compose: ComposeDraft?
  /// The live agent sessions as last read, for New message's To.
  var sessions: SessionsRead = .unread
  /// Files on their way to the computer now, and files the way in use cannot carry (the relay takes no uploads).
  var uploading: Set<String> = []
  var needsNetwork: Set<String> = []
  /// New messages the computer wrote, by the stand-in thread of the Send that made them, until that Send reads it.
  var sent: [String: ThreadID] = [:]
  /// Attached files' bytes when the phone keeps no copy (the demo).
  var memory: [String: Data] = [:]
  /// The computer's draft as last read, per thread (nil entry: read, and there was none).
  var computer: [ThreadID: InboxReplyDraft?] = [:]
  /// The computer's draft the open reply box started from.
  var base: [ThreadID: String] = [:]
  /// A write of the drafts that waits for the typing to pause.
  var soon: Task<Void, Never>?
  /// Who each thread's reply can tag with `@`, as last read (`GET threads/:id/taggable`), and when.
  var taggable: [ThreadID: (at: Date, answer: DoorTaggableAnswer)] = [:]
  /// Take back tries with no answer yet, by message (TakeBack.swift): the next try reuses each one's key.
  var takingBack: [MessageID: TakeBackAttempt] = [:]
}

private struct KeptDrafts: Codable {
  var local: [String: LocalDraft]
  var computer: [String: InboxReplyDraft]
}

extension LocalCopy {
  func saveDrafts(local: [ThreadID: LocalDraft], computer: [ThreadID: InboxReplyDraft?], compose: ComposeDraft? = nil) {
    let kept = KeptDrafts(
      local: Dictionary(uniqueKeysWithValues: local.map { ($0.key.rawValue, $0.value) }),
      computer: Dictionary(uniqueKeysWithValues: computer.compactMap { key, value in value.map { (key.rawValue, $0) } }))
    if let data = try? JSONEncoder().encode(kept) { write(data, to: "drafts.json") }
    if let data = try? JSONEncoder().encode(compose) { write(data, to: "compose.json") }
  }

  func composeDraft() -> ComposeDraft? { read("compose.json").flatMap { try? JSONDecoder().decode(ComposeDraft?.self, from: $0) } ?? nil }

  func drafts() -> (local: [ThreadID: LocalDraft], computer: [ThreadID: InboxReplyDraft]) {
    guard let data = read("drafts.json"), let kept = try? JSONDecoder().decode(KeptDrafts.self, from: data) else { return ([:], [:]) }
    return (Dictionary(uniqueKeysWithValues: kept.local.map { (ThreadID($0.key), $0.value) }), Dictionary(uniqueKeysWithValues: kept.computer.map { (ThreadID($0.key), $0.value) }))
  }
}

/// What came of taking back a reply that waits on the phone.
public enum CancelOutcome: Hashable, Sendable {
  /// Taken back: nothing is sent, and its words are handed back to the reply box.
  case cancelled
  /// It is on its way to the computer now: too late to take back here.
  case onItsWay
  /// No such reply waits.
  case notHeld
}

extension InboxSession {
  // MARK: Drafts

  func loadDrafts() {
    let kept = copy.drafts()
    draftBook.local = kept.local
    draftBook.computer = kept.computer.mapValues { Optional($0) }
    draftBook.compose = copy.composeDraft()
    if let sessions = copy.keptSessions() { draftBook.sessions = .kept(sessions) }
  }

  func keepDrafts() {
    draftBook.soon?.cancel()
    draftBook.soon = nil
    copy.saveDrafts(local: draftBook.local, computer: draftBook.computer, compose: draftBook.compose)
  }

  /// How long typing pauses before its words are written to the phone's copy.
  static let typingPause: Duration = .milliseconds(400)

  /// Keep the drafts once the typing pauses: a keystroke changes them in memory at once, and the copy is written
  /// after a short pause, not once for every key. Leaving the front, and stopping, write at once.
  func keepDraftsSoon() {
    draftBook.soon?.cancel()
    draftBook.soon = Task { [weak self] in
      try? await Task.sleep(for: Self.typingPause)
      guard !Task.isCancelled, let self else { return }
      self.keepDrafts()
    }
  }

  /// Write a pending keep of the drafts now (there is none: nothing is written).
  public func keepDraftsNow() { if draftBook.soon != nil { keepDrafts() } }

  /// The words kept on the phone for a thread.
  public func draft(_ thread: ThreadID) -> LocalDraft? { draftBook.local[thread] }

  /// The computer's reply draft for a thread as last read (the window's), if it has one.
  public func computerDraft(_ thread: ThreadID) -> InboxReplyDraft? { draftBook.computer[thread] ?? nil }

  /// Keep what the person typed, at once, with the files and quote already in the draft. A draft left with no
  /// words, no file and no quote is not kept.
  public func keepDraft(_ thread: ThreadID, words: String, now: Date = Date()) {
    if let kept = draftBook.local[thread], kept.words == words { return }
    if words.isEmpty, draftBook.local[thread] == nil { return }
    changeDraft(thread, now: now, typing: true) { draft in
      draft.words = words
      // A tag whose `@` the words lost is dropped for good, as in the window (`useMentionAutocomplete`): typing the
      // same `@` again by hand does not bring it back. Not on an empty box: Send empties it before the Send reads
      // the tags, and spends them itself (`forgetDraft`); a box emptied by hand drops them at its next words.
      if let tags = draft.tags, !words.isEmpty { draft.tags = TagRules.standing(tags, words: words) }
    }
  }

  /// Change a thread's draft on the phone and keep it at once (`typing`: once the typing pauses).
  func changeDraft(_ thread: ThreadID, now: Date? = nil, typing: Bool = false, _ change: (inout LocalDraft) -> Void) {
    var draft = draftBook.local[thread] ?? LocalDraft(words: "", editedAt: now ?? clock.now())
    change(&draft)
    if let now { draft.editedAt = now }
    draft.base = draftBook.base[thread]
    if draft.files?.isEmpty == true { draft.files = nil }
    if draft.tags?.isEmpty == true { draft.tags = nil }
    // An aim lives only with the quote it came with: nothing on screen would say where the words go without it.
    if draft.quote == nil { draft.aim = nil }
    draftBook.local[thread] = draft.isEmpty ? nil : draft
    if typing { keepDraftsSoon() } else { keepDrafts() }
  }

  /// Quote a message in the thread's reply (nil takes the quote away). The phone names no recipient in the reply
  /// box, so taking the quote away takes away the aim it came with too: the words go where a plain reply goes.
  public func setQuote(_ thread: ThreadID, _ quote: DraftQuote?) {
    changeDraft(thread) { draft in
      draft.quote = quote
      if quote == nil { draft.aim = nil }
    }
  }

  /// ↩ on a message (the window's `arrowReply`): the quote it leaves, and, when it leaves one, the agent the reply is
  /// aimed at. A plain Reply (no quote left) aims at no one: the words go where a plain reply goes. `words`: the
  /// words selected in that message, if any.
  public func replyArrow(_ thread: ThreadID, at message: MessageID, words: String? = nil) {
    guard let messages = self.thread(thread)?.thread.messages else { return }
    let arrow = ReplyQuoteRules.arrow(messages, at: message, words: words, quoted: draftBook.local[thread]?.quote != nil)
    changeDraft(thread) { draft in
      if let quote = arrow.quote { draft.quote = quote }
      draft.aim = draft.quote == nil ? nil : arrow.aim
    }
  }

  /// What a Send carried is spent: the words, the quote and the files it took. Words typed after them stay.
  func forgetDraft(_ thread: ThreadID, words sent: String, files: [DraftFile], quoted: Bool) {
    guard var draft = draftBook.local[thread] else {
      draftBook.base[thread] = nil
      return
    }
    if draft.words.trimmingCharacters(in: .whitespacesAndNewlines) == sent { draft.words = "" }
    if quoted { draft.quote = nil }
    if !sent.isEmpty { draft.aim = nil }
    if draft.words.isEmpty { draft.tags = nil }
    let gone = Set(files.map(\.id))
    draft.files = draft.files?.filter { !gone.contains($0.id) }
    draftBook.base[thread] = nil
    changeDraft(thread) { $0 = draft }
  }

  /// A Send that will not go (refused, or taken back): its files and quote go back into the draft (its words go back
  /// through `returned`). `fresh`: the computer no longer has the uploads it named (`upload_not_found`), so each file
  /// goes up again, under a new key, before the next Send.
  func returnToDraft(_ write: HeldWrite, fresh: Bool) {
    // The agents the words tagged come back with them.
    let tags = ((try? JSONDecoder().decode(DoorReplyBody.self, from: write.body))?.tags ?? []).map { DraftTag(session: $0.session, host: $0.host, label: $0.label ?? TagRules.agentName($0.host)) }
    guard write.kind == .reply, (write.files ?? []).isEmpty == false || write.quote != nil || !tags.isEmpty else { return }
    changeDraft(ThreadID(write.thread)) { draft in
      draft.tags = tags + (draft.tags ?? [])
      let have = Set((draft.files ?? []).map(\.id))
      draft.files = (write.files ?? []).filter { !have.contains($0.id) }.map { fresh ? $0.again : $0 } + (draft.files ?? [])
      if draft.quote == nil { draft.quote = write.quote }
    }
  }

  /// Read the computer's draft for a thread (`GET threads/:id/draft`) when it answers; the last one read otherwise.
  public func readComputerDraft(_ thread: ThreadID) async {
    if client == nil { _ = await connect() }
    guard let client, offers(DoorRoutes.getThreadDraft) else { return }
    do {
      let read = try await client.get(Door.getThreadDraft(thread: thread), as: DoorThreadDraftAnswer.self)
      draftBook.computer[thread] = .some(read.draft)
      keepDrafts()
    } catch {}
  }

  /// What the thread's reply box starts with: the computer's draft is read first when it answers, so a draft written
  /// in the window shows here, and the phone's own words are never lost to it.
  public func openDraft(_ thread: ThreadID) async -> DraftOpening {
    await readComputerDraft(thread)
    let opening = DraftOpening.of(local: draftBook.local[thread], computer: draftBook.computer[thread] ?? nil)
    draftBook.base[thread] = opening.clearDraft
    if let base = opening.clearDraft, var local = draftBook.local[thread], local.words == opening.words {
      local.base = base
      draftBook.local[thread] = local
      keepDrafts()
    }
    return opening
  }

  // MARK: Taking back a held reply

  /// Take back a reply that waits on the phone (`HeldWrite.id`). Its words go back to the reply box; the answers it
  /// carried stay picked, not sent.
  @discardableResult
  public func cancelHeld(_ id: String) -> CancelOutcome {
    guard let write = held.first(where: { $0.id == id }), write.kind == .reply else { return .notHeld }
    if book.inFlight.contains(id) { return .onItsWay }
    settle(id)
    let thread = ThreadID(write.thread)
    // Its files, quote and tags go back to the draft with its words.
    returnToDraft(write, fresh: false)
    if let words = write.words, !words.isEmpty {
      returned[thread] = [returned[thread], words].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
      keepGivenBack()
    }
    return .cancelled
  }
}
