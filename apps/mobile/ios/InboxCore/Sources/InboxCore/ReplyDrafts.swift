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

  public init(words: String, editedAt: Date, base: String? = nil) {
    self.words = words
    self.editedAt = editedAt
    self.base = base
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
  /// The computer's draft as last read, per thread (nil entry: read, and there was none).
  var computer: [ThreadID: InboxReplyDraft?] = [:]
  /// The computer's draft the open reply box started from.
  var base: [ThreadID: String] = [:]
}

private struct KeptDrafts: Codable {
  var local: [String: LocalDraft]
  var computer: [String: InboxReplyDraft]
}

extension LocalCopy {
  func saveDrafts(local: [ThreadID: LocalDraft], computer: [ThreadID: InboxReplyDraft?]) {
    let kept = KeptDrafts(
      local: Dictionary(uniqueKeysWithValues: local.map { ($0.key.rawValue, $0.value) }),
      computer: Dictionary(uniqueKeysWithValues: computer.compactMap { key, value in value.map { (key.rawValue, $0) } }))
    if let data = try? JSONEncoder().encode(kept) { write(data, to: "drafts.json") }
  }

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
  }

  private func keepDrafts() { copy.saveDrafts(local: draftBook.local, computer: draftBook.computer) }

  /// The words kept on the phone for a thread.
  public func draft(_ thread: ThreadID) -> LocalDraft? { draftBook.local[thread] }

  /// The computer's reply draft for a thread as last read (the window's), if it has one.
  public func computerDraft(_ thread: ThreadID) -> InboxReplyDraft? { draftBook.computer[thread] ?? nil }

  /// Keep what the person typed, at once. Empty words remove the draft.
  public func keepDraft(_ thread: ThreadID, words: String, now: Date = Date()) {
    if words.isEmpty {
      draftBook.local[thread] = nil
    } else {
      draftBook.local[thread] = LocalDraft(words: words, editedAt: now, base: draftBook.base[thread])
    }
    keepDrafts()
  }

  /// The words are sent (or put in the outbox): the thread's draft on the phone is spent.
  func forgetDraft(_ thread: ThreadID) {
    guard draftBook.local[thread] != nil || draftBook.base[thread] != nil else { return }
    draftBook.local[thread] = nil
    draftBook.base[thread] = nil
    keepDrafts()
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
    if let words = write.words, !words.isEmpty {
      returned[thread] = [returned[thread], words].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
      keepGivenBack()
    }
    return .cancelled
  }
}
