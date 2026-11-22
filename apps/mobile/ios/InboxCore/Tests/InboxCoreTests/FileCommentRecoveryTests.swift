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

  func testACommentEventWhoseReadDidNotLandIsReadOnTheNextPass() async throws {
    let (door, session) = try await seated()
    let plan = try file(session, StandInData.planName)
    await door.windowComments(on: plan.id.rawValue, annotation: FileComments.words(id: "win-1", block: "block-0", start: 0, quote: "Retry plan", comment: "Name the release."))
    await session.readAttachments(thread)
    await door.windowSendsComment("win-1")
    // The event comes while the computer does not answer: the read of the thread's comments does not land.
    await door.setOffline(true)
    session.reloadSoon(comments: thread)
    try? await Task.sleep(for: .milliseconds(600))
    XCTAssertTrue(session.commentsChanged.contains(thread), "kept for the next pass")
    // The next pass, for any other reason, reads it.
    await door.setOffline(false)
    session.reloadSoon()
    for _ in 0..<100 where !session.comments(thread).isEmpty { try? await Task.sleep(for: .milliseconds(20)) }
    XCTAssertTrue(session.comments(thread).isEmpty)
  }

  func testAnInboxThatListsNoCommentsIsNotAskedAgainOnEveryPass() async throws {
    let (door, session) = try await seated()
    await door.setOptions { $0.omitsComments = true }
    session.reloadSoon(comments: thread)
    try? await Task.sleep(for: .milliseconds(900))
    XCTAssertFalse(session.commentsChanged.contains(thread), "an answer with no list is an answer")
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

  /// The retry thread, with a picture in it: it asks a question, so a pick can be made beside a drawing.
  private func relayed(_ ways: Ways) async throws -> (StandInDoor, InboxSession, AttachmentItem) {
    let door = StandInDoor()
    _ = await door.addFile(thread: StandInData.retry, name: "flame.png", kind: .image, bytes: png(1), mediaType: "image/png", width: 8, height: 8)
    let session = await twoWaySession(door: door, ways: ways, bytes: AttachmentCache(folder: folder()), retryEvery: .milliseconds(100))
    await session.start()
    await session.open(StandInData.retry)
    await session.readAttachments(StandInData.retry)
    let picture = try XCTUnwrap(session.attachments(StandInData.retry).first { $0.name == "flame.png" })
    return (door, session, picture)
  }

  private func settled(_ session: InboxSession, _ id: ThreadID) async {
    for _ in 0..<60 {
      await session.deliverHeld(thread: id)
      try? await Task.sleep(for: .milliseconds(5))
    }
  }

  func testADrawingTheRelayCannotCarryHoldsBackOnlyItselfAndItsComment() async throws {
    let ways = Ways()
    let (door, session, picture) = try await relayed(ways)
    let retry = StandInData.retry
    let made = try XCTUnwrap(session.addComment(thread: retry, item: picture, version: .current, annotation: FileComments.picture(name: picture.name, comment: "Crop the top.", markup: nil), drawing: png(9)))
    await settled(session, retry)
    XCTAssertEqual(ways.drawingsOnRelay, 1)
    XCTAssertTrue(session.drawingWaits(made), "the list says it waits")
    XCTAssertTrue(session.commentsToSend(retry).isEmpty, "a comment whose drawing waits rides no Send")

    // Meanwhile a pick and a Send go at once, without the comment.
    let asked = try XCTUnwrap(session.thread(retry)?.thread.messages.last { $0.author.kind == .agent })
    let question = try XCTUnwrap(asked.questions?.first)
    await session.pick(thread: retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: [question.choices[0].label], note: ""))
    await settled(session, retry)
    let picks = await door.posts("/picks")
    XCTAssertEqual(picks.count, 1, "the pick went")
    _ = await session.send(thread: retry, words: "Ship it.")
    await settled(session, retry)
    let replies = await door.posts("/reply").map(body)
    XCTAssertEqual(replies.count, 1, "the Send went")
    XCTAssertEqual(replies.first?["words"]?.text, "Ship it.")
    XCTAssertNil(replies.first?["annotation_ids"]?.items.first, "without the comment")
    XCTAssertEqual(session.comments(retry).map(\.id), [made.id], "which stays in the list")
    // The relay is not asked again for the drawing while it is the way.
    await session.refresh()
    await settled(session, retry)
    XCTAssertEqual(ways.drawingsOnRelay, 1, "not tried again on the same way")

    // A direct way: the drawing goes, then its comment, by itself (the Send was pressed while it waited).
    ways.direct = true
    await session.refresh()
    await settled(session, retry)
    XCTAssertFalse(session.drawingWaits(made))
    let markups = await door.posts("markups")
    XCTAssertEqual(markups.count, 1, "carried by the direct way")
    let last = await door.posts("/reply").map(body).last
    XCTAssertEqual(last?["annotation_ids"]?.items.first?.text, made.id)
    XCTAssertFalse((last?["feedback"]?.text ?? "").contains(PendingDrawing.scheme))
    XCTAssertTrue(session.comments(retry).isEmpty)
  }

  func testASendOfOnlyCommentsADrawingRefusedForGoodEmptiesIsToldAboutAndItsCommentStays() async throws {
    let copy = LocalCopy(folder: folder())
    let cache = folder()
    let (door, session) = try await seated(copy: copy, cache: cache)
    _ = await door.addFile(thread: thread, message: StandInData.filesSecond, name: "flame.png", kind: .image, bytes: png(1), mediaType: "image/png", width: 8, height: 8)
    await session.readAttachments(thread)
    let item = try file(session, "flame.png")
    await door.setOffline(true)
    await session.refresh()
    let made = try XCTUnwrap(session.addComment(thread: thread, item: item, version: .current, annotation: FileComments.picture(name: item.name, comment: "Too red.", markup: nil), drawing: png(9)))
    let queued = await session.send(thread: thread, words: "")
    XCTAssertTrue(queued)
    await door.setOptions { $0.refusesMarkups = "markup_too_large" }
    await door.setOffline(false)
    await session.refresh()
    await delivered(session)
    let replies = await door.posts("/reply")
    XCTAssertTrue(replies.isEmpty)
    XCTAssertNotNil(session.notices[thread], "the person is told")
    XCTAssertEqual(session.comments(thread).map(\.id), [made.id], "the comment stays, with its reason")
    XCTAssertNotNil(session.commentRefusal(made.id))
    // Told after the app opens again too, until it is read.
    session.stop()
    let again = await pairedSession(door: door, copy: copy, bytes: AttachmentCache(folder: cache))
    await again.start()
    XCTAssertEqual(again.notices[thread], session.notices[thread], "the notice is kept")
    XCTAssertNil(again.takeReturnedWords(thread), "and no empty words come back to the reply field")
    again.clearNotice(thread)
    let third = await pairedSession(door: door, copy: copy, bytes: AttachmentCache(folder: cache))
    await third.start()
    XCTAssertNil(third.notices[thread], "read, it is gone")
  }

  func testADrawingWaitingForAnotherWayGoesWhenTheDirectWayComesBackWithNoRefresh() async throws {
    let ways = Ways()
    let (door, session, picture) = try await relayed(ways)
    let retry = StandInData.retry
    XCTAssertNil(session.pathSearch, "no timer while nothing waits for another way")
    session.pathSearchEvery = .milliseconds(100)
    let made = try XCTUnwrap(session.addComment(thread: retry, item: picture, version: .current, annotation: FileComments.picture(name: picture.name, comment: "Crop the top.", markup: nil), drawing: png(9)))
    await settled(session, retry)
    XCTAssertEqual(ways.drawingsOnRelay, 1)
    XCTAssertNotNil(session.pathSearch, "a slow look for a better way while the drawing waits")
    // The phone is back on the computer's network; nothing else happens (no refresh, no reconnect).
    ways.direct = true
    for _ in 0..<200 where session.drawingWaits(made) { try? await Task.sleep(for: .milliseconds(10)) }
    XCTAssertFalse(session.drawingWaits(made), "the drawing found the direct way")
    let markups = await door.posts("markups")
    XCTAssertEqual(markups.count, 1)
    for _ in 0..<100 where session.pathSearch != nil { try? await Task.sleep(for: .milliseconds(10)) }
    XCTAssertNil(session.pathSearch, "and the look stops")
    // Out of the front, it never starts.
    session.setInFront(false)
    XCTAssertNil(session.pathSearch)
  }

  func testWithADrawingWaitingTheDirectWayIsTakenEvenWhenTheRelayAnswersFirst() async throws {
    let ways = Ways()
    let (door, session, picture) = try await relayed(ways)
    let retry = StandInData.retry
    let made = try XCTUnwrap(session.addComment(thread: retry, item: picture, version: .current, annotation: FileComments.picture(name: picture.name, comment: "Crop the top.", markup: nil), drawing: png(9)))
    await settled(session, retry)
    XCTAssertTrue(session.drawingWaits(made))
    ways.relayFirst = true
    ways.direct = true
    await session.refresh()
    await settled(session, retry)
    XCTAssertFalse(session.drawingWaits(made))
    let markups = await door.posts("markups")
    XCTAssertEqual(markups.count, 1, "carried by the direct way, though the relay answered first")
  }

  func testASendQueuedWithACommentWhoseDrawingTheRelayRefusesGoesWithoutIt() async throws {
    let ways = Ways()
    let (door, session, picture) = try await relayed(ways)
    let retry = StandInData.retry
    // Made and sent with the computer away: the Send carries the comment.
    await door.setOffline(true)
    await session.refresh()
    let made = try XCTUnwrap(session.addComment(thread: retry, item: picture, version: .current, annotation: FileComments.picture(name: picture.name, comment: "Crop the top.", markup: nil), drawing: png(9)))
    _ = await session.send(thread: retry, words: "Ship it.")
    XCTAssertEqual(session.heldComments(try XCTUnwrap(session.held.first { $0.kind == .reply })), 1)
    // Back through the relay only: the drawing cannot go, and the Send goes without its comment.
    await door.setOffline(false)
    await session.refresh()
    await settled(session, retry)
    let replies = await door.posts("/reply").map(body)
    XCTAssertEqual(replies.count, 1)
    XCTAssertEqual(replies.first?["words"]?.text, "Ship it.")
    XCTAssertNil(replies.first?["annotation_ids"]?.items.first)
    XCTAssertEqual(session.comments(retry).map(\.id), [made.id], "the comment stays, for the next Send")
    XCTAssertTrue(session.drawingWaits(made))
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

  func testRemovingACommentWhoseSaveWasLostOnTheWaySendsThatSaveFirstThenTheRemoval() async throws {
    let gate = Gate()
    let (door, session) = try await seated(gate: gate)
    // The save is lost before the computer took it: the phone cannot know that.
    await gate.lose({ $0.method == .post && $0.path == "annotations" }, arrives: false)
    let made = try planComment(session)
    for _ in 0..<100 where session.held.contains(where: { $0.kind == .annotation && $0.mayHaveArrived != true }) { try? await Task.sleep(for: .milliseconds(5)) }
    let save = try XCTUnwrap(session.held.first { $0.kind == .annotation })
    session.removeComment(made.id, thread: thread)
    XCTAssertEqual(session.held.filter { $0.kind != .seen }.map(\.kind), [.annotation, .annotationRemove], "the save is not dropped: it goes first")
    XCTAssertEqual(session.held.first { $0.kind == .annotation }?.id, save.id, "with its own key, so it cannot make a second comment")
    await delivered(session)
    let calls = await door.calls.filter { $0.method == .post && $0.path.hasPrefix("annotations") }.map(\.path)
    XCTAssertEqual(calls.suffix(2), ["annotations", "annotations/\(made.id)/remove"], "in order")
    let left = await door.pendingComments(thread)
    XCTAssertTrue(left.isEmpty, "and the comment is gone from the computer")
  }

  func testAnEditAfterASaveWithNoAnswerThenARemovalStillRemovesItOnTheComputer() async throws {
    let gate = Gate()
    let (door, session) = try await seated(gate: gate)
    // The save reaches the computer; its answer is lost.
    await gate.lose({ $0.method == .post && $0.path == "annotations" }, arrives: true)
    let made = try planComment(session)
    for _ in 0..<100 where session.held.contains(where: { $0.kind == .annotation && $0.mayHaveArrived != true }) { try? await Task.sleep(for: .milliseconds(5)) }
    // Edited with the computer away, then removed.
    await door.setOffline(true)
    await session.refresh()
    session.editComment(made.id, thread: thread, words: "Say which one.")
    XCTAssertEqual(session.held.first { $0.kind == .annotation }?.mayHaveArrived, true, "the new save passes the mark on")
    session.removeComment(made.id, thread: thread)
    XCTAssertTrue(session.held.contains { $0.kind == .annotationRemove }, "the removal is queued")
    await door.setOffline(false)
    await session.refresh()
    await delivered(session)
    let left = await door.pendingComments(thread)
    XCTAssertTrue(left.isEmpty, "the comment does not come back")
  }

  func testASaveTheAppEndedDuringKeepsItsMarkThroughATryThatNeverLeft() async throws {
    let copy = LocalCopy(folder: folder())
    let cache = folder()
    let gate = Gate()
    let (door, session) = try await seated(copy: copy, cache: cache, gate: gate)
    await gate.stop { $0.method == .post && $0.path == "annotations" }
    let made = try planComment(session)
    await gate.reached()
    session.stop()

    // Opened again: its first try at the save cannot reach the computer.
    let again = Gate()
    await again.cannotConnect(times: 1000) { $0.method == .post && $0.path == "annotations" }
    let reopened = await pairedSession(door: door, copy: copy, bytes: AttachmentCache(folder: cache), gate: again)
    await reopened.start()
    await reopened.open(thread)
    let tried = await again.unreachedCalls
    XCTAssertGreaterThan(tried, 0, "the save was tried, and did not leave")
    XCTAssertEqual(reopened.held.first { $0.kind == .annotation }?.mayHaveArrived, true, "a try that never left does not clear what an earlier one may have done")
    reopened.removeComment(made.id, thread: thread)
    XCTAssertTrue(reopened.held.contains { $0.kind == .annotationRemove })
    await again.cannotConnect(times: 0) { _ in false }
    for _ in 0..<200 where reopened.held.contains(where: { $0.thread == thread.rawValue && $0.kind != .seen }) {
      await reopened.deliverHeld(thread: thread)
      try? await Task.sleep(for: .milliseconds(5))
    }
    let left = await door.pendingComments(thread)
    XCTAssertTrue(left.isEmpty, "the comment does not come back")
    await gate.open()
  }

  func testASaveTheAppEndedDuringIsFollowedByARemovalMadeAfterTheAppOpensAgain() async throws {
    let copy = LocalCopy(folder: folder())
    let cache = folder()
    let gate = Gate()
    let (door, session) = try await seated(copy: copy, cache: cache, gate: gate)
    // The save reaches the computer, and the app ends before its answer.
    await gate.stop { $0.method == .post && $0.path == "annotations" }
    let made = try planComment(session)
    await gate.reached()
    session.stop()

    XCTAssertEqual(copy.outbox().first { $0.kind == .annotation }?.mayHaveArrived, true, "kept as possibly arrived before it left")

    // Opened again with the computer away: the comment is removed before anything goes.
    await door.setOffline(true)
    let again = await pairedSession(door: door, copy: copy, bytes: AttachmentCache(folder: cache))
    await again.start()
    await again.open(thread)
    again.removeComment(made.id, thread: thread)
    await door.setOffline(false)
    await again.refresh()
    for _ in 0..<200 where again.held.contains(where: { $0.thread == thread.rawValue && $0.kind != .seen }) {
      await again.deliverHeld(thread: thread)
      try? await Task.sleep(for: .milliseconds(5))
    }
    let left = await door.pendingComments(thread)
    XCTAssertTrue(left.isEmpty, "the removal followed the save")
    await gate.open()
  }

  func testRemovingADrawingCommentDuringItsUploadRetiresOnlyThatUpload() async throws {
    let gate = Gate()
    let (door, session) = try await seated(gate: gate)
    await gate.stop { $0.method == .post && $0.path == "markups" }
    let made = try await pictureComment(door, session)
    await gate.reached()
    // Removed while its drawing is on its way; then a Send.
    session.removeComment(made.id, thread: thread)
    _ = await session.send(thread: thread, words: "Ship it.")
    // The upload's answer is lost, and it is tried again.
    await gate.open(thenLose: true)
    await delivered(session)
    let words = await lastWords(door)
    XCTAssertEqual(words, "Ship it.", "the Send went")
    XCTAssertNil(session.takeReturnedWords(thread), "and was never pulled back")
    XCTAssertTrue(session.held.filter { $0.kind != .seen }.isEmpty)
    let hash = try XCTUnwrap(PendingDrawing.hash(try XCTUnwrap(made.images.first).path))
    XCTAssertNil(session.drawing(hash), "the drawing's bytes left the phone")
  }

  func testASendIsKeptBeforeItsCommentsTextsAreReadAndGoesWithoutThemWhenTheyDoNotCome() async throws {
    let gate = Gate()
    let door = StandInDoor()
    await door.addFilesThread()
    let copy = LocalCopy(folder: folder())
    let session = await pairedSession(door: door, copy: copy, bytes: AttachmentCache(folder: folder()), gate: gate)
    session.feedbackTextWait = .milliseconds(300)
    await session.start()
    await session.open(thread)
    await session.readAttachments(thread)
    let plan = try file(session, StandInData.planName)
    // A comment made in the window on a file whose text the phone does not have: its line is read at Send.
    await door.windowComments(on: plan.id.rawValue, annotation: FileComments.words(id: "win-1", block: "block-3", start: 4, quote: "client drops its socket", comment: "Which client?"))
    await session.readAttachments(thread)
    XCTAssertEqual(session.commentsToSend(thread).map(\.id), ["win-1"])
    XCTAssertTrue(session.needsFeedbackTexts(thread), "its line is read from a text the phone does not have")
    // The text does not come.
    await gate.stop { $0.method == .get && $0.path.hasPrefix("attachments/") }
    let sent = Task { await session.send(thread: thread, words: "Ship it.") }
    for _ in 0..<200 where !session.held.contains(where: { $0.kind == .reply }) { try? await Task.sleep(for: .milliseconds(5)) }
    // While the text is asked for, the words are already kept, on the phone's disk.
    XCTAssertEqual(session.held.first { $0.kind == .reply }?.words, "Ship it.")
    XCTAssertEqual(copy.outbox().first { $0.kind == .reply }?.words, "Ship it.")
    // Past the wait, the Send goes; the text comes only after.
    try? await Task.sleep(for: .milliseconds(700))
    await gate.open()
    _ = await sent.value
    await delivered(session)
    let words = await lastWords(door)
    XCTAssertTrue(try XCTUnwrap(words).hasPrefix("Ship it."))
    XCTAssertTrue(try XCTUnwrap(words).contains("Which client?"), "the comment went, with no line")
    XCTAssertFalse(try XCTUnwrap(words).contains("(line"))
  }

  func testAPhoneCommentTheComputerNoLongerListsAfterARefusedSendKeepsItsWords() async throws {
    let (door, session) = try await seated()
    let sent = try planComment(session, words: "Sent in the window.")
    let lost = try planComment(session, words: "Keep these words.")
    await delivered(session)
    XCTAssertEqual(session.comments(thread).map(\.saved), [true, true])
    // The window sent the first; the computer lost the second (its store was reset). The Send naming both is
    // refused for the first.
    await door.windowSendsComment(sent.id)
    await door.forgetComment(lost.id)
    _ = await session.send(thread: thread, words: "Ship it.")
    await delivered(session)
    XCTAssertNil(session.comments(thread).first { $0.id == sent.id }, "the comment the window sent leaves the phone")
    let kept = try XCTUnwrap(session.comments(thread).first { $0.id == lost.id }, "the phone's words are not lost")
    XCTAssertEqual(kept.words, "Keep these words.")
    guard case .notSaved = session.commentStanding(kept, in: thread) else { return XCTFail("it says it was not saved") }
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
