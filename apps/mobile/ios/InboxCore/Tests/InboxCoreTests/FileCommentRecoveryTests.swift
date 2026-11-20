import Foundation
import XCTest
@testable import InboxCore
import InboxStandIn
import InboxWire

/// What keeps comments on files from blocking a Send or being lost: a refusal kept across closing the app, a Send
/// the computer refused for a comment it does not have, a drawing it would not keep, a removal while a save was in
/// doubt, a list read while a save landed, a comment whose file changed, and an outbox a newer build wrote.
@MainActor
final class FileCommentRecoveryTests: XCTestCase {
  private func folder() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("inbox-core-tests-\(UUID().uuidString)", isDirectory: true)
  }

  private let thread = StandInData.files

  private func seated(door: StandInDoor = StandInDoor(), copy: LocalCopy = LocalCopy(folder: nil), cache: URL? = nil, gate: Gate? = nil) async throws -> (StandInDoor, InboxSession) {
    if await door.thread(thread) == nil { await door.addFilesThread() }
    let session = await pairedSession(door: door, copy: copy, bytes: AttachmentCache(folder: cache ?? folder()), gate: gate)
    await session.start()
    await session.open(thread)
    await session.readAttachments(thread)
    for name in [StandInData.planName, StandInData.codeName] { _ = try await session.openAttachment(try file(session, name)) }
    return (door, session)
  }

  private func file(_ session: InboxSession, _ name: String) throws -> AttachmentItem {
    try XCTUnwrap(session.attachments(thread).first { $0.name == name }, name)
  }

  private func delivered(_ session: InboxSession) async {
    for _ in 0..<200 {
      await session.deliverHeld(thread: thread)
      if !session.held.contains(where: { $0.thread == thread.rawValue && $0.kind != .seen }) { return }
      try? await Task.sleep(for: .milliseconds(5))
    }
  }

  private func planComment(_ session: InboxSession, words: String = "Say which client.") throws -> FileComment {
    let plan = try file(session, StandInData.planName)
    return try XCTUnwrap(session.addComment(thread: thread, item: plan, version: .current, annotation: FileComments.words(block: "block-3", start: 4, quote: "client drops its socket", comment: words)))
  }

  /// The words of the thread's newest message, as the computer has them.
  private func lastWords(_ door: StandInDoor) async -> String? { await door.thread(thread)?.messages.last?.body }

  private func png(_ seed: UInt8) -> Data { Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] + Array(repeating: seed, count: 64)) }

  // MARK: A refusal is kept, and never blocks a Send

  func testARefusedCommentIsStillRefusedAfterTheAppClosesAndNoSendCarriesIt() async throws {
    let copy = LocalCopy(folder: folder())
    let cache = folder()
    let (door, session) = try await seated(copy: copy, cache: cache)
    await door.refuseComments(on: try file(session, StandInData.planName).id.rawValue)
    let made = try planComment(session)
    await delivered(session)
    XCTAssertNotNil(session.commentRefusal(made.id))
    session.stop()

    let again = await pairedSession(door: door, copy: copy, bytes: AttachmentCache(folder: cache))
    await again.start()
    await again.open(thread)
    XCTAssertNotNil(again.commentRefusal(made.id), "the reason is kept with the comment")
    XCTAssertEqual(again.commentStanding(try XCTUnwrap(again.comments(thread).first), in: thread), .notSaved(again.commentRefusal(made.id)))
    XCTAssertTrue(again.commentsToSend(thread).isEmpty)
    _ = await again.send(thread: thread, words: "Ship it.")
    await delivered(again)
    let words = await lastWords(door)
    XCTAssertEqual(words, "Ship it.", "the Send went, without the comment the computer does not have")
    XCTAssertEqual(again.comments(thread).map(\.id), [made.id], "and the comment is still the person's")
  }

  func testACommentTheComputerNeverGotAndThatHasNoSaveOnItsWayRidesNoSend() async throws {
    let (door, session) = try await seated()
    await door.setOffline(true)
    await session.refresh()
    let made = try planComment(session)
    // Its save is gone from the outbox with no answer kept (an older build lost a refusal this way).
    session.held.removeAll { $0.kind == .annotation }
    XCTAssertEqual(session.commentStanding(try XCTUnwrap(session.comments(thread).first), in: thread), .notSaved(nil))
    XCTAssertTrue(session.commentsToSend(thread).isEmpty)
    await door.setOffline(false)
    await session.refresh()
    _ = await session.send(thread: thread, words: "Ship it.")
    await delivered(session)
    let words = await lastWords(door)
    XCTAssertEqual(words, "Ship it.")
    // Changed, the same words or not, it is saved at last and rides the next Send.
    session.editComment(made.id, thread: thread, words: made.words)
    await delivered(session)
    let kept = await door.comment(made.id)
    XCTAssertNotNil(kept)
    XCTAssertEqual(session.commentsToSend(thread).map(\.id), [made.id])
  }

  func testASendRefusedForACommentTheWindowAlreadySentDropsItAndTheNextSendGoes() async throws {
    let (door, session) = try await seated()
    let made = try planComment(session)
    await delivered(session)
    // The window sends it with a reply of its own; the phone has not read the list since.
    await door.windowSendsComment(made.id)
    let went = await session.send(thread: thread, words: "One note.")
    XCTAssertTrue(went)
    await delivered(session)
    XCTAssertTrue(session.comments(thread).isEmpty, "the comment the window sent leaves the phone")
    XCTAssertEqual(session.takeReturnedWords(thread), "One note.", "the words are back in the reply field")
    _ = await session.send(thread: thread, words: "One note.")
    await delivered(session)
    let words = await lastWords(door)
    XCTAssertEqual(words, "One note.", "the next Send goes")
  }

  func testASendRefusedForACommentTheComputerDoesNotHaveHoldsThatCommentBackAndTheNextSendGoes() async throws {
    let (door, session) = try await seated()
    await door.setOffline(true)
    await session.refresh()
    let made = try planComment(session)
    // The phone believes the computer has it; the computer never got it.
    session.held.removeAll { $0.kind == .annotation }
    session.commentBook.kept[thread]?[0].saved = true
    await door.setOffline(false)
    await session.refresh()
    _ = await session.send(thread: thread, words: "One note.")
    await delivered(session)
    guard case .notSaved(let notice)? = session.comments(thread).first.map({ session.commentStanding($0, in: thread) }), case .refused(_, let code)? = notice else { return XCTFail("held back, with the reason") }
    XCTAssertEqual(code, "annotation_not_found")
    XCTAssertEqual(session.takeReturnedWords(thread), "One note.")
    _ = await session.send(thread: thread, words: "One note.")
    await delivered(session)
    let words = await lastWords(door)
    XCTAssertEqual(words, "One note.", "the next Send goes, without it")
    XCTAssertEqual(session.comments(thread).map(\.id), [made.id])
  }

  func testWhatTheWindowDoesWithACommentReachesThePhoneFromTheEventStream() async throws {
    let (door, session) = try await seated()
    let plan = try file(session, StandInData.planName)
    await door.windowComments(on: plan.id.rawValue, annotation: FileComments.words(id: "win-1", block: "block-0", start: 0, quote: "Retry plan", comment: "Name the release."))
    await session.readAttachments(thread)
    XCTAssertEqual(session.comments(thread).map(\.id), ["win-1"])
    await door.windowSendsComment("win-1")
    let data = #"{"seq":42,"kind":"annotation","id":"win-1","annotation":{"id":"win-1","thread_id":"\#(thread.rawValue)","sent_reply_id":"msg_WINDOWREPLY"}}"#
    XCTAssertEqual(CommentEvents.thread(of: data), thread)
    XCTAssertNil(CommentEvents.thread(of: #"{"seq":43,"kind":"message","id":"msg_1"}"#))
    session.reloadSoon(comments: CommentEvents.thread(of: data))
    for _ in 0..<100 where !session.comments(thread).isEmpty { try? await Task.sleep(for: .milliseconds(20)) }
    XCTAssertTrue(session.comments(thread).isEmpty, "a comment sent in the window leaves the phone without leaving the thread")
  }

  // MARK: A drawing

  private func pictureComment(_ door: StandInDoor, _ session: InboxSession, words: String = "Too red.", marks: [PictureMark]? = nil) async throws -> FileComment {
    _ = await door.addFile(thread: thread, message: StandInData.filesSecond, name: "flame.png", kind: .image, bytes: png(1), mediaType: "image/png", width: 8, height: 8)
    await session.readAttachments(thread)
    let item = try file(session, "flame.png")
    return try XCTUnwrap(session.addComment(thread: thread, item: item, version: .current, annotation: FileComments.picture(name: item.name, comment: words, markup: nil), drawing: png(9), marks: marks))
  }

  func testACommentIsNeverSavedNamingADrawingTheComputerWouldNotKeepAndAChangeTriesAgain() async throws {
    let (door, session) = try await seated()
    await door.setOptions { $0.refusesMarkups = "markup_too_large" }
    let made = try await pictureComment(door, session)
    await delivered(session)
    let saves = await door.posts("annotations")
    XCTAssertTrue(saves.isEmpty, "no comment names a picture that is not there")
    let none = await door.comment(made.id)
    XCTAssertNil(none)
    guard case .notSaved(.refused(_, let code)?)? = session.comments(thread).first.map({ session.commentStanding($0, in: thread) }) else { return XCTFail("the comment says it was not saved") }
    XCTAssertEqual(code, "markup_too_large")

    await door.setOptions { $0.refusesMarkups = nil }
    session.editComment(made.id, thread: thread, words: made.words)
    await delivered(session)
    let saved = await door.comment(made.id)
    let path = try XCTUnwrap(saved.flatMap { FileComment(id: $0.id, thread: thread, attachment: $0.attachmentId, version: $0.version, annotation: $0.annotation, createdAt: "").images.first?.path })
    XCTAssertFalse(path.hasPrefix(PendingDrawing.scheme), "the drawing went first, and the comment names where the computer kept it")
    let count = await door.markupCount
    XCTAssertEqual(count, 1)
  }

  func testADrawingThePathCannotCarryWaitsWithItsCommentAndGoesLater() async throws {
    let (door, session) = try await seated()
    await door.setOptions { $0.refusesMarkups = "relay_upload_unavailable" }
    let made = try await pictureComment(door, session)
    _ = await session.send(thread: thread, words: "See the drawing.")
    await delivered(session)
    XCTAssertEqual(session.held.filter { $0.kind != .seen }.map(\.kind), [.markup, .annotation, .reply], "it all waits, in order")
    XCTAssertTrue(session.drawingWaits(made))
    let saves = await door.posts("annotations")
    XCTAssertTrue(saves.isEmpty)
    XCTAssertNil(session.commentRefusal(made.id))

    await door.setOptions { $0.refusesMarkups = nil }
    await session.refresh()
    await delivered(session)
    let sent = await door.comment(made.id)
    XCTAssertNotNil(sent?.sentReplyId)
    let words = await lastWords(door)
    XCTAssertFalse(try XCTUnwrap(words).contains(PendingDrawing.scheme))
    let hash = try XCTUnwrap(PendingDrawing.hash(try XCTUnwrap(made.images.first).path))
    XCTAssertNil(session.drawing(hash), "the phone lets go of a drawing the computer has")
  }

  // MARK: Removing, reading

  func testRemovingACommentWhoseSaveWasNeverAnsweredRemovesItOnTheComputer() async throws {
    let gate = Gate()
    let (door, session) = try await seated(gate: gate)
    // The save reaches the computer; its answer is lost on the way back.
    await gate.lose({ $0.method == .post && $0.path == "annotations" }, arrives: true)
    let made = try planComment(session)
    for _ in 0..<100 where session.held.contains(where: { $0.kind == .annotation && $0.waited != true }) { try? await Task.sleep(for: .milliseconds(5)) }
    let arrived = await door.pendingComments(thread)
    XCTAssertEqual(arrived.map(\.id), [made.id])
    session.removeComment(made.id, thread: thread)
    await delivered(session)
    let gone = await door.pendingComments(thread)
    XCTAssertTrue(gone.isEmpty, "a removal followed the save that may have arrived")
  }

  func testUndoAfterRemoveBringsBackTheSameCommentAndItsDrawing() async throws {
    let door = StandInDoor()
    let (_, session) = try await seated(door: door)
    let first = try planComment(session, words: "First.")
    let drawn = try await pictureComment(door, session, marks: [PictureMark(kind: .pin, points: [4, 4], size: 2), PictureMark(kind: .stroke, points: [1, 1, 6, 6], size: 1)])
    // Removed and brought back while the computer is away: nothing has gone yet, and nothing is lost.
    await door.setOffline(true)
    await session.refresh()
    let hash = try XCTUnwrap(PendingDrawing.hash(try XCTUnwrap(drawn.images.first).path))
    let removed = try XCTUnwrap(session.removeComment(first.id, thread: thread))
    let removedDrawing = try XCTUnwrap(session.removeComment(drawn.id, thread: thread))
    XCTAssertNil(session.drawing(hash), "the drawing left with its comment")
    // Undone last first, as each toast's Undo is taken.
    let backDrawing = try XCTUnwrap(session.restoreComment(removedDrawing))
    let back = try XCTUnwrap(session.restoreComment(removed))
    XCTAssertEqual(session.comments(thread).map(\.words), ["First.", "Too red."], "each back in its place")
    XCTAssertEqual(back.annotation.filter { $0.key != "id" }, first.annotation.filter { $0.key != "id" }, "the same words and place")
    XCTAssertEqual(backDrawing.images, drawn.images)
    XCTAssertEqual(backDrawing.marks, drawn.marks, "and its marks")
    XCTAssertNotNil(session.drawing(hash), "and the drawing it names, to go before it")
    await door.setOffline(false)
    await session.refresh()
    await delivered(session)
    XCTAssertEqual(session.comments(thread).map(\.saved), [true, true], "both saved again")
    let onComputer = await door.pendingComments(thread)
    XCTAssertEqual(Set(onComputer.map(\.id)), Set([back.id, backDrawing.id]))
  }

  func testAListReadBeforeASaveLandedNeverDropsWhatTheSaveMade() async throws {
    let gate = Gate()
    let (door, session) = try await seated(gate: gate)
    await door.setOffline(true)
    await session.refresh()
    let made = try planComment(session)
    await door.setOffline(false)
    // The list is read, and its answer held on the way back while the save lands.
    await gate.stop { $0.method == .get && $0.path.hasSuffix("/attachments") }
    let read = Task { await session.readAttachments(thread) }
    await gate.reached()
    await delivered(session)
    XCTAssertEqual(session.comments(thread).first?.saved, true)
    await gate.open()
    _ = await read.value
    XCTAssertEqual(session.comments(thread).map(\.id), [made.id], "the older list does not undo the save")
    let kept = await door.pendingComments(thread)
    XCTAssertEqual(kept.map(\.id), [made.id])
  }

  // MARK: A file that changed

  func testACommentOnTextTheAgentChangedSinceGoesWithItsQuoteAndNoLine() async throws {
    let (door, session) = try await seated()
    let made = try planComment(session)
    await delivered(session)
    let plan = try file(session, StandInData.planName)
    // The agent adds a paragraph at the top: block-3 is another place now.
    await door.changeFile(plan.id.rawValue, to: Data("# Retry plan\n\nA new opening paragraph.\n\n\(StandInData.plan)".utf8))
    await session.readAttachments(thread)
    _ = try await session.openAttachment(try file(session, StandInData.planName), version: .current)
    XCTAssertEqual(session.commentStanding(try XCTUnwrap(session.comments(thread).first), in: thread), .unanchored)
    XCTAssertEqual(session.commentsToSend(thread).map(\.id), [made.id], "never dropped")
    _ = await session.send(thread: thread, words: "")
    await delivered(session)
    let replies = await door.posts("/reply")
    let feedback = try XCTUnwrap(body(try XCTUnwrap(replies.last))["feedback"]?.text)
    XCTAssertTrue(feedback.contains("### 1. Feedback on: \"client drops its socket\"\n> Say which client.\n"), feedback)
    XCTAssertFalse(feedback.contains("(line"), "no line of a text the person did not read")
  }

  func testACommentMadeOnACopyKeptWhileTheComputerWasAwayIsReadFromThatCopy() async throws {
    let (door, session) = try await seated()
    let plan = try file(session, StandInData.planName)
    // The phone kept a copy under the file's current hash; it names the text the person read.
    let key = InboxSession.cacheKey(plan, .current)
    let made = try XCTUnwrap(session.addComment(thread: thread, item: plan, version: .current, annotation: FileComments.words(block: "block-3", start: 4, quote: "client drops its socket", comment: "Which?"), readKey: key))
    XCTAssertEqual(session.commentBook.readKeys[made.id], key)
    await delivered(session)
    _ = await session.send(thread: thread, words: "")
    await delivered(session)
    let replies = await door.posts("/reply")
    let feedback = try XCTUnwrap(body(try XCTUnwrap(replies.last))["feedback"]?.text)
    XCTAssertTrue(feedback.contains("### 1. (line 7) Feedback on: \"client drops its socket\""), feedback)
  }

  // MARK: Housekeeping, and an older build's outbox

  func testAThreadTheComputerNoLongerHasTakesItsCommentsWithIt() async throws {
    let copy = LocalCopy(folder: folder())
    let (door, session) = try await seated(copy: copy)
    _ = try planComment(session)
    await delivered(session)
    await door.removeThread(thread)
    await session.open(thread)
    XCTAssertTrue(session.comments(thread).isEmpty)
    XCTAssertTrue(session.commentBook.readKeys.isEmpty)
    XCTAssertTrue(copy.comments().kept.isEmpty, "nor in the phone's copy")
  }

  func testAnOutboxWithAWriteThisBuildCannotReadKeepsTheRest() throws {
    let copy = LocalCopy(folder: folder())
    let write = HeldWrite(id: "k1", kind: .pick, thread: "t", message: "m", route: "POST messages/:id/picks", method: "POST", path: "messages/m/picks", body: Data("{}".utf8), madeAt: Date(timeIntervalSince1970: 0))
    var items = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode([write, write])) as? [[String: Any]])
    items[0]["kind"] = "aKindOfANewerBuild"
    items[0]["id"] = "k0"
    copy.write(try JSONSerialization.data(withJSONObject: items), to: "outbox.json")
    XCTAssertEqual(copy.outbox().map(\.id), ["k1"])
  }
}
