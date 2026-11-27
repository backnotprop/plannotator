import CryptoKit
import Foundation
import XCTest
@testable import InboxCore
import InboxStandIn
import InboxWire

/// Reply drafts kept on the phone, a held reply taken back, and attachments: listed, fetched in parts, resumed,
/// checked, kept in a budget and erased with the computer.
@MainActor
final class DraftAndFileTests: XCTestCase {
  private func folder() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("inbox-core-tests-\(UUID().uuidString)", isDirectory: true)
  }

  // MARK: Drafts

  func testADraftSurvivesLeavingTheThreadAndClosingTheApp() async throws {
    let door = StandInDoor()
    let copy = LocalCopy(folder: folder())
    var session = await pairedSession(door: door, copy: copy)
    await session.start()
    session.keepDraft(StandInData.docs, words: "Ship the docs after the review")
    session.stop()
    session = await pairedSession(door: door, copy: copy)
    await session.start()
    XCTAssertEqual(session.draft(StandInData.docs)?.words, "Ship the docs after the review")
    let opening = await session.openDraft(StandInData.docs)
    XCTAssertEqual(opening.words, "Ship the docs after the review")
    XCTAssertNil(opening.other)
    // Sent: the draft is spent.
    await session.open(StandInData.docs)
    let sent = await session.send(thread: StandInData.docs, words: opening.words)
    XCTAssertTrue(sent)
    XCTAssertNil(session.draft(StandInData.docs))
  }

  func testTheComputersDraftOpensOnThePhoneAndSendingItClearsItThere() async throws {
    let door = StandInDoor()
    await door.setDraft(StandInData.docs, body: "Started this at my desk")
    let session = await pairedSession(door: door)
    await session.start()
    let opening = await session.openDraft(StandInData.docs)
    XCTAssertEqual(opening.words, "Started this at my desk")
    let base = try XCTUnwrap(opening.clearDraft)
    XCTAssertEqual(session.computerDraft(StandInData.docs)?.body, "Started this at my desk")
    // Typed on: still the same draft, so no conflict when it opens again.
    session.keepDraft(StandInData.docs, words: "Started this at my desk, finished on the train")
    let again = await session.openDraft(StandInData.docs)
    XCTAssertEqual(again.words, "Started this at my desk, finished on the train")
    XCTAssertNil(again.other)
    await session.open(StandInData.docs)
    _ = await session.send(thread: StandInData.docs, words: again.words, clearDraft: again.clearDraft)
    let replies = await door.posts("/reply")
    let reply = try XCTUnwrap(replies.last)
    XCTAssertEqual(body(reply)["clear_draft"]?.text, base)
  }

  func testWhenBothChangedTheNewerWinsAndTheOtherIsOffered() throws {
    let older = Date(timeIntervalSince1970: 1_800_000_000)
    let draft = InboxReplyDraft(v: 1, threadId: StandInData.docs, body: "From the desk", createdAt: "2027-01-15T08:00:00.000Z", updatedAt: SnoozeRules.iso(older.addingTimeInterval(60)))
    let mine = LocalDraft(words: "From the phone", editedAt: older)
    let computerNewer = DraftOpening.of(local: mine, computer: draft)
    XCTAssertEqual(computerNewer.words, "From the desk")
    XCTAssertEqual(computerNewer.otherWords, "From the phone")
    XCTAssertEqual(computerNewer.other, .fromThisPhone)
    let phoneNewer = DraftOpening.of(local: LocalDraft(words: "From the phone", editedAt: older.addingTimeInterval(120)), computer: draft)
    XCTAssertEqual(phoneNewer.words, "From the phone")
    XCTAssertEqual(phoneNewer.otherWords, "From the desk")
    XCTAssertEqual(phoneNewer.other, .fromComputer)
    XCTAssertNil(phoneNewer.clearDraft, "the computer's words were not used: its draft stays")
    XCTAssertEqual(DraftOpening.of(local: nil, computer: nil).words, "")
  }

  func testRemovingTheComputerErasesTheDrafts() async throws {
    let door = StandInDoor()
    let copy = LocalCopy(folder: folder())
    var session = await pairedSession(door: door, copy: copy)
    await session.start()
    session.keepDraft(StandInData.docs, words: "Private words")
    await session.removeThisPhone()
    XCTAssertNil(session.draft(StandInData.docs))
    session = await pairedSession(door: door, copy: copy)
    await session.start()
    XCTAssertNil(session.draft(StandInData.docs))
  }

  // MARK: Taking back a held reply

  func testAHeldReplyCanBeTakenBackBeforeItGoes() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.docs)
    await door.setOffline(true)
    _ = await session.send(thread: StandInData.docs, words: "On second thought, wait")
    let write = try XCTUnwrap(session.heldReplies(StandInData.docs).first)
    XCTAssertEqual(session.cancelHeld(write.id), .cancelled)
    XCTAssertFalse(session.hasHeldReply(StandInData.docs))
    XCTAssertEqual(session.takeReturnedWords(StandInData.docs), "On second thought, wait")
    XCTAssertEqual(session.cancelHeld(write.id), .notHeld)
    await door.clearCalls()
    await door.setOffline(false)
    await session.refresh()
    let replies = await door.posts("/reply")
    XCTAssertTrue(replies.isEmpty)
  }

  func testAReplyOnItsWayCannotBeTakenBack() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.docs)
    await door.setOffline(true)
    _ = await session.send(thread: StandInData.docs, words: "Going")
    let write = try XCTUnwrap(session.heldReplies(StandInData.docs).first)
    session.book.inFlight.insert(write.id)
    XCTAssertEqual(session.cancelHeld(write.id), .onItsWay)
    XCTAssertTrue(session.hasHeldReply(StandInData.docs))
  }

  // MARK: Attachments

  private func bytes(_ count: Int, seed: UInt8 = 7) -> Data {
    var data = Data(capacity: count)
    for index in 0..<count {
      let value: Int = index &* 31 &+ Int(seed)
      data.append(UInt8(truncatingIfNeeded: value))
    }
    return data
  }

  private func withFile(_ data: Data, kind: InboxAttachmentKind = .file, name: String = "rollout-notes.pdf", budget: Int64 = AttachmentCache.defaultBudget, gate: Gate? = nil) async throws
    -> (door: StandInDoor, session: InboxSession, item: AttachmentItem, cache: AttachmentCache)
  {
    let door = StandInDoor()
    _ = await door.addFile(thread: StandInData.docs, name: name, kind: kind, bytes: data)
    let cache = AttachmentCache(folder: folder(), budget: budget)
    let session = await pairedSession(door: door, bytes: cache, gate: gate)
    await session.start()
    await session.open(StandInData.docs)
    await session.readAttachments(StandInData.docs)
    let item = try XCTUnwrap(session.attachments(StandInData.docs).first { $0.name == name })
    return (door, session, item, cache)
  }

  func testAThreadsFilesAreListedWithWhatChangedSinceSent() async throws {
    let (door, session, item, _) = try await withFile(bytes(300), kind: .pdf)
    XCTAssertEqual(item.kind, .pdf)
    XCTAssertEqual(item.size, 300)
    XCTAssertEqual(item.changedSinceSent, false)
    XCTAssertFalse(item.takesComments)
    await door.changeFile(item.id.rawValue, to: bytes(320, seed: 9))
    await session.readAttachments(StandInData.docs)
    let changed = try XCTUnwrap(session.attachments(StandInData.docs).first { $0.id == item.id })
    XCTAssertEqual(changed.changedSinceSent, true)
    XCTAssertEqual(changed.current?.size, 320)
    await door.changeFile(item.id.rawValue, to: nil)
    await session.readAttachments(StandInData.docs)
    let gone = try XCTUnwrap(session.attachments(StandInData.docs).first { $0.id == item.id })
    XCTAssertEqual(gone.unavailable?.code, .attachmentMissing)
    XCTAssertEqual(gone.opens, .sent, "the version it sent still opens")
  }

  func testAFileComesInRangedPartsWithProgressAndIsCheckedAndKept() async throws {
    let data = bytes(10_000)
    let (door, session, item, cache) = try await withFile(data)
    await door.setPartCap(4_000)
    let seen = Progress()
    let url = try await session.openAttachment(item, progress: { received, total in seen.add(received, total) })
    XCTAssertEqual(try Data(contentsOf: url), data)
    XCTAssertEqual(seen.steps.map(\.0), [4_000, 8_000, 10_000])
    XCTAssertEqual(seen.steps.last?.1, 10_000)
    let ranges = await door.calls.filter { $0.path.hasSuffix("/download") }.map { $0.headers["Range"] }
    XCTAssertEqual(ranges, ["bytes=0-8388607", "bytes=4000-8392607", "bytes=8000-8396607"])
    XCTAssertTrue(cache.used >= 10_000)

    // Kept: it opens with the computer away.
    await door.setOffline(true)
    XCTAssertEqual(session.availability(item), .kept(url))
    let again = try await session.openAttachment(item)
    XCTAssertEqual(again, url)
  }

  func testAFetchThatStoppedResumesWhereItStopped() async throws {
    let data = bytes(10_000)
    let (door, session, item, _) = try await withFile(data)
    await door.setPartCap(3_000)
    await door.failBytes(after: 2)
    do {
      _ = try await session.openAttachment(item)
      XCTFail("the computer stopped answering")
    } catch {}
    await door.failBytes(after: nil)
    await door.clearCalls()
    let url = try await session.openAttachment(item)
    XCTAssertEqual(try Data(contentsOf: url), data)
    let calls = await door.calls.filter { $0.path.hasSuffix("/download") }
    XCTAssertEqual(calls.first?.headers["Range"], "bytes=6000-8394607", "from where it stopped")
    XCTAssertFalse(calls.contains { $0.headers["Range"]?.hasPrefix("bytes=0-") == true }, "the parts kept are kept")
  }

  func testAFileThatChangedBetweenPartsEndsTheFetchAtOnceNeverWhole() async throws {
    let gate = Gate()
    let (door, session, item, cache) = try await withFile(bytes(10_000), gate: gate)
    await door.setPartCap(3_000)
    await door.failBytes(after: 2)
    _ = try? await session.openAttachment(item)
    // The agent rendered the file again before the phone asked for the rest.
    await door.failBytes(after: nil)
    await door.changeFile(item.id.rawValue, to: bytes(10_000, seed: 5))
    await door.clearCalls()
    let before = await gate.answers.count
    do {
      _ = try await session.openAttachment(item)
      XCTFail("not the version the phone was told of")
    } catch AttachmentError.fetch(.changed) {}
    // A whole answer has no cap: the phone never asks in a way the door answers with one. The version it was told of
    // is gone, so nothing more is fetched.
    let answers = await gate.answers.dropFirst(before).filter { $0.path.hasSuffix("/download") }.map(\.status)
    XCTAssertEqual(answers, [206])
    let calls = await door.calls.filter { $0.path.hasSuffix("/download") }
    XCTAssertTrue(calls.allSatisfy { $0.headers["If-Range"] == nil })
    XCTAssertNil(cache.partial(InboxSession.cacheKey(item, item.opens)), "the parts of the old version are dropped")
    XCTAssertEqual(cache.used, 0, "nothing kept")
  }

  func testAFileThatKeepsChangingStartsAgainOnceThenStops() async throws {
    let (door, session, sent, _) = try await withFile(bytes(9_000))
    await door.setPartCap(3_000)
    // A file whose hash the phone does not know (as it is now, not yet listed): it may start again, once.
    var item = sent
    item.current = nil
    item.changedSinceSent = true
    XCTAssertEqual(item.opens, .current)
    await door.keepChanging(item.id.rawValue, times: 50)
    await door.clearCalls()
    do {
      _ = try await session.openAttachment(item)
      XCTFail("it never holds still")
    } catch AttachmentError.fetch(.changed) {}
    let ranges = await door.calls.filter { $0.path.hasSuffix("/download") }.map { $0.headers["Range"] ?? "" }
    XCTAssertEqual(ranges, ["bytes=0-8388607", "bytes=3000-8391607", "bytes=0-8388607", "bytes=3000-8391607"], "one start again, then the fetch ends")
  }

  func testErasingTheCacheDuringAFetchKeepsNothingOfIt() async throws {
    let gate = Gate()
    let (door, session, item, cache) = try await withFile(bytes(9_000), gate: gate)
    await door.setPartCap(3_000)
    await gate.stop { $0.path.hasSuffix("/download") }
    let fetch = Task { @MainActor in try await session.openAttachment(item) }
    await gate.reached()
    // The computer is removed while a part is on its way.
    cache.erase()
    await gate.open()
    _ = try? await fetch.value
    // Nor its index: asking for a file, or making room, writes nothing.
    XCTAssertNil(cache.file(InboxSession.cacheKey(item, item.opens)))
    cache.budget = 1
    XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(cache.folder).path), "no byte of a removed computer comes back")
    XCTAssertEqual(cache.used, 0)
  }

  func testCancellingAFetchStopsItAndTheNextOneResumes() async throws {
    let data = bytes(9_000)
    let (door, session, item, _) = try await withFile(data)
    await door.setPartCap(3_000)
    let box = TaskBox()
    let task = Task { @MainActor in try await session.openAttachment(item, progress: { _, _ in box.cancel() }) }
    box.task = task
    do {
      _ = try await task.value
      XCTFail("cancelled")
    } catch is CancellationError {}
    let parts = await door.calls.filter { $0.path.hasSuffix("/download") }.count
    XCTAssertEqual(parts, 1, "no part asked for after the cancel")
    await door.clearCalls()
    let url = try await session.openAttachment(item)
    XCTAssertEqual(try Data(contentsOf: url), data)
    let first = await door.calls.first { $0.path.hasSuffix("/download") }
    XCTAssertEqual(first?.headers["Range"], "bytes=3000-8391607")
  }

  func testAFileLargerThanTheCapIsNotFetched() async throws {
    let (door, session, item, _) = try await withFile(bytes(5_000), budget: 4_000)
    await door.clearCalls()
    do {
      _ = try await session.openAttachment(item)
      XCTFail("too large")
    } catch AttachmentError.fetch(.tooLarge(let size, let cap)) {
      XCTAssertEqual(size, 5_000)
      XCTAssertEqual(cap, 4_000)
    }
    let reads = await door.calls.filter { $0.path.hasPrefix("attachments/") }
    XCTAssertTrue(reads.isEmpty)
  }

  func testBytesThatAreNotTheOnesNamedAreRefused() async throws {
    let (door, session, item, cache) = try await withFile(bytes(2_000), kind: .image, name: "screenshot.png")
    // The file changed on the computer after the phone was told its hash.
    await door.changeFile(item.id.rawValue, to: bytes(2_000, seed: 3))
    do {
      _ = try await session.openAttachment(item, version: .current)
      XCTFail("damaged")
    } catch AttachmentError.fetch(.damaged) {}
    XCTAssertEqual(cache.used, 0, "nothing kept")
    // The version it sent is still the one named.
    let url = try await session.openAttachment(item, version: .sent)
    XCTAssertEqual(try Data(contentsOf: url), bytes(2_000))
    let sent = await door.calls.last { $0.path.hasSuffix("/image") }
    XCTAssertEqual(sent?.query.first { $0.name == "version" }?.value, "sent")
  }

  func testAFileNotKeptSaysSoWhileTheComputerIsAway() async throws {
    let (door, session, item, _) = try await withFile(bytes(1_000))
    await door.setOffline(true)
    session.stop()
    await session.refresh()
    do {
      _ = try await session.openAttachment(item)
      XCTFail("not kept")
    } catch AttachmentError.notKept {}
  }

  func testTheCacheKeepsItsBudgetLeastRecentlyOpenedFirst() throws {
    let cache = AttachmentCache(folder: folder(), budget: 10)
    let start = Date(timeIntervalSince1970: 1_800_000_000)
    cache.store("a", data: Data(count: 4), now: start)
    cache.store("b", data: Data(count: 4), now: start.addingTimeInterval(1))
    XCTAssertNotNil(cache.file("a", now: start.addingTimeInterval(2)), "opened: a is now the most recent")
    cache.store("c", data: Data(count: 4), now: start.addingTimeInterval(3))
    XCTAssertTrue(cache.contains("a"))
    XCTAssertFalse(cache.contains("b"), "the least recently opened went")
    XCTAssertTrue(cache.contains("c"))
    XCTAssertEqual(cache.used, 8)
    // The index survives a relaunch.
    let reopened = AttachmentCache(folder: cache.folder, budget: 10)
    XCTAssertTrue(reopened.contains("a"))
    cache.budget = 4
    XCTAssertEqual(cache.used, 4)
    XCTAssertTrue(cache.contains("c"))
  }

  func testAFileOpenInAViewerStaysAndStoppedPartsCountAgainstTheBudget() async throws {
    let (_, session, item, cache) = try await withFile(bytes(4_000), budget: 10_000)
    let start = Date(timeIntervalSince1970: 1_800_000_000)
    let url = try await session.openAttachment(item)
    let index = try XCTUnwrap(cache.folder).appendingPathComponent("index.json")
    let written = try FileManager.default.attributesOfItem(atPath: index.path)[.modificationDate] as? Date
    // Asking whether a file is kept, as a list row does, writes nothing.
    for _ in 0..<3 { XCTAssertEqual(session.availability(item), .kept(url)) }
    XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: index.path)[.modificationDate] as? Date, written)

    // Open in a viewer: a newer file makes room with something else.
    cache.store("newer", data: Data(count: 7_000), now: start.addingTimeInterval(100))
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), "never pulled from under the viewer")
    // Closed with the item as read again since, which now opens another version: still the one opened.
    var refreshed = item
    refreshed.changedSinceSent = nil
    XCTAssertNotEqual(refreshed.opens, item.opens)
    session.attachmentClosed(refreshed)
    cache.store("newest", data: Data(count: 7_000), now: start.addingTimeInterval(200))
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path), "closed: it can go")

    // The part of a fetch that stopped counts, and goes first.
    let part = cache.partialURL("stopped")
    try Data(count: 5_000).write(to: part)
    cache.store("small", data: Data(count: 1_000), now: start.addingTimeInterval(300))
    XCTAssertFalse(FileManager.default.fileExists(atPath: part.path))
    XCTAssertTrue(cache.contains("newest"))
  }

  func testRemovingTheComputerErasesItsFiles() async throws {
    let (_, session, item, cache) = try await withFile(bytes(500))
    let url = try await session.openAttachment(item)
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
    await session.removeThisPhone()
    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    XCTAssertEqual(cache.used, 0)
    XCTAssertFalse(FileManager.default.fileExists(atPath: try XCTUnwrap(cache.folder).path))
  }
}

private final class Progress: @unchecked Sendable {
  private let lock = NSLock()
  private var kept: [(Int64, Int64?)] = []
  func add(_ received: Int64, _ total: Int64?) { lock.withLock { kept.append((received, total)) } }
  var steps: [(Int64, Int64?)] { lock.withLock { kept } }
}

private final class TaskBox: @unchecked Sendable {
  var task: Task<URL, Error>?
  func cancel() { task?.cancel() }
}
