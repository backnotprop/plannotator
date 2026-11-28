import Foundation
import XCTest
@testable import InboxCore
import InboxStandIn
import InboxWire

/// Comments on a thread's files: kept on the phone and on the computer, changed and removed before sending, carried
/// by the next Send as the window's feedback text, kept while the computer is away and across closing the app.
@MainActor
final class FileCommentTests: XCTestCase {
  private func folder() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("inbox-core-tests-\(UUID().uuidString)", isDirectory: true)
  }

  private let thread = StandInData.files

  /// A phone on the files thread, its files listed and the plan read (so its text is on the phone).
  private func seated(door: StandInDoor = StandInDoor(), copy: LocalCopy = LocalCopy(folder: nil), cache: URL? = nil) async throws -> (StandInDoor, InboxSession) {
    if await door.thread(thread) == nil { await door.addFilesThread() }
    let session = await pairedSession(door: door, copy: copy, bytes: AttachmentCache(folder: cache ?? folder()))
    await session.start()
    await session.open(thread)
    await session.readAttachments(thread)
    for name in [StandInData.planName, StandInData.codeName] {
      let item = try file(session, name)
      _ = try await session.openAttachment(item)
    }
    return (door, session)
  }

  private func file(_ session: InboxSession, _ name: String) throws -> AttachmentItem {
    try XCTUnwrap(session.attachments(thread).first { $0.name == name }, name)
  }

  /// Wait until nothing of the thread waits on the phone (or a second has passed).
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

  // MARK: Kept, sent

  func testACommentIsKeptOnTheComputerAndRidesTheNextSendAsTheWindowsFeedback() async throws {
    let (door, session) = try await seated()
    let onPlan = try planComment(session)
    let code = try file(session, StandInData.codeName)
    let onCode = try XCTUnwrap(session.addComment(thread: thread, item: code, version: .current, annotation: FileComments.lines(lineStart: 3, lineEnd: 3, code: "const CAP_MS = 60_000", comment: "Lower on a metered connection?")))
    XCTAssertEqual(session.comments(thread).map(\.id), [onPlan.id, onCode.id], "on the phone at once")
    await delivered(session)

    // The computer has both, exactly as made: the window shows them on the same words and lines.
    let kept = await door.pendingComments(thread)
    XCTAssertEqual(kept.map(\.id), [onPlan.id, onCode.id])
    XCTAssertEqual(kept[0].annotation, onPlan.annotation)
    XCTAssertEqual(kept[0].attachmentId, onPlan.attachment)
    XCTAssertEqual(kept[0].version, "current")
    XCTAssertEqual(kept[1].annotation["inboxCode"], onCode.annotation["inboxCode"])
    XCTAssertEqual(session.comments(thread).map(\.saved), [true, true])

    // Send: the words, then the window's feedback text, and the comments named so the computer marks them sent.
    XCTAssertTrue(session.canSend(thread: thread, words: ""), "comments alone are something to send")
    let sent = await session.send(thread: thread, words: "Two notes on the plan.")
    XCTAssertTrue(sent)
    await delivered(session)
    let read1 = await door.posts("/reply")
    let reply = body(try XCTUnwrap(read1.last))
    XCTAssertEqual(reply["annotation_ids"]?.strings, [onPlan.id, onCode.id])
    let feedback = try XCTUnwrap(reply["feedback"]?.text)
    XCTAssertEqual(
      feedback,
      """
      # Feedback on the attached files

      The following feedback is on the files you attached, one section per file and version.

      ## \(StandInData.planName)

      I've reviewed this document and have 1 piece of feedback:

      ### 1. (line 7) Feedback on: "client drops its socket"
      > Say which client.

      ## \(StandInData.codeName)

      I've reviewed this document and have 1 piece of feedback:

      ### 1. (line 3) Feedback on: "const CAP_MS = 60_000"
      > Lower on a metered connection?

      ---
      """)
    let read2 = await door.thread(thread)
    let written = try XCTUnwrap(read2?.messages.last)
    XCTAssertEqual(written.body, "Two notes on the plan.\n\n\(feedback)")
    let read3 = await door.comment(onPlan.id)
    XCTAssertNotNil(read3?.sentReplyId)
    XCTAssertTrue(session.comments(thread).isEmpty, "sent: nothing waits")
    XCTAssertFalse(session.canSend(thread: thread, words: ""))
  }

  func testACommentIsChangedAndRemovedBeforeSending() async throws {
    let (door, session) = try await seated()
    let first = try planComment(session)
    let second = try planComment(session, words: "And say when.")
    await delivered(session)

    session.editComment(first.id, thread: thread, words: "  Say which client: the phone's.  ")
    XCTAssertEqual(session.comments(thread).first?.words, "Say which client: the phone's.")
    await delivered(session)
    let read4 = await door.comment(first.id)
    let changed = try XCTUnwrap(read4)
    XCTAssertEqual(changed.annotation["text"]?.text, "Say which client: the phone's.")
    let read5 = await door.pendingComments(thread)
    XCTAssertEqual(read5.count, 2, "an edit is the same comment")

    session.removeComment(second.id, thread: thread)
    XCTAssertEqual(session.comments(thread).map(\.id), [first.id])
    await delivered(session)
    let read6 = await door.comment(second.id)
    XCTAssertNotNil(read6?.removedAt)

    // Words emptied: the comment goes, as if removed.
    session.editComment(first.id, thread: thread, words: "   ")
    await delivered(session)
    XCTAssertTrue(session.comments(thread).isEmpty)
    let read7 = await door.pendingComments(thread)
    XCTAssertTrue(read7.isEmpty)

    // Nothing waits: a Send carries no feedback.
    _ = await session.send(thread: thread, words: "Looks right.")
    await delivered(session)
    let read8 = await door.posts("/reply")
    let reply = body(try XCTUnwrap(read8.last))
    XCTAssertNil(reply["feedback"])
    XCTAssertNil(reply["annotation_ids"])
  }

  func testCommentsSurviveLeavingTheFileAndClosingTheApp() async throws {
    let copy = LocalCopy(folder: folder())
    let cache = folder()
    let (door, session) = try await seated(copy: copy, cache: cache)
    await door.setOffline(true)
    await session.refresh()
    let made = try planComment(session)
    session.stop()

    // The app opens again with the computer still away: the comment is there, unsent.
    let again = await pairedSession(door: door, copy: copy, bytes: AttachmentCache(folder: cache))
    await again.start()
    XCTAssertEqual(again.comments(thread).map(\.id), [made.id])
    XCTAssertEqual(again.comments(thread).first?.words, "Say which client.")
    XCTAssertFalse(again.comments(thread)[0].saved)
    let read9 = await door.pendingComments(thread)
    XCTAssertTrue(read9.isEmpty)

    // The computer is back: it gets the comment, once.
    await door.setOffline(false)
    await again.refresh()
    await delivered(again)
    let read10 = await door.pendingComments(thread)
    XCTAssertEqual(read10.map(\.id), [made.id])
    let read11 = await door.posts("annotations")
    XCTAssertEqual(read11.count, 1)
  }

  // MARK: The computer away

  func testCommentsMadeWhileTheComputerIsAwayWaitAndGoWhenItIsBack() async throws {
    let (door, session) = try await seated()
    await door.setOffline(true)
    await session.refresh()
    let made = try planComment(session)
    // Changed twice while it waits: the computer gets the last words only.
    session.editComment(made.id, thread: thread, words: "Say which client: the phone's.")
    session.editComment(made.id, thread: thread, words: "Say which client: the phone's or the desktop's.")
    XCTAssertEqual(session.held.filter { $0.kind == .annotation }.count, 1)
    XCTAssertEqual(session.comments(thread).map(\.words), ["Say which client: the phone's or the desktop's."])

    // Sent while away: the comment leaves the list with the Send that carries it, and waits behind its own save.
    _ = await session.send(thread: thread, words: "One note.")
    XCTAssertEqual(session.held.filter { $0.kind != .seen }.map(\.kind), [.annotation, .reply])
    XCTAssertTrue(session.comments(thread).isEmpty)
    // Taken back: the comment is the person's again, still unsent.
    let reply = try XCTUnwrap(session.heldReplies(thread).first)
    XCTAssertEqual(session.cancelHeld(reply.id), .cancelled)
    XCTAssertEqual(session.comments(thread).map(\.id), [made.id])

    _ = await session.send(thread: thread, words: "One note.")
    await door.setOffline(false)
    await session.refresh()
    await delivered(session)
    let read12 = await door.comment(made.id)
    let saved = try XCTUnwrap(read12)
    XCTAssertEqual(saved.annotation["text"]?.text, "Say which client: the phone's or the desktop's.")
    XCTAssertNotNil(saved.sentReplyId, "the Send that waited carried it")
    let read13 = await door.posts("/reply")
    let sent = body(try XCTUnwrap(read13.last))
    XCTAssertEqual(sent["annotation_ids"]?.strings, [made.id])
    XCTAssertTrue(sent["feedback"]?.text?.contains("> Say which client: the phone's or the desktop's.") == true)
    XCTAssertTrue(session.comments(thread).isEmpty)
  }

  func testACommentRemovedBeforeItEverLeftSendsNothing() async throws {
    let (door, session) = try await seated()
    await door.setOffline(true)
    await session.refresh()
    let made = try planComment(session)
    session.removeComment(made.id, thread: thread)
    XCTAssertTrue(session.comments(thread).isEmpty)
    XCTAssertFalse(session.held.contains { $0.kind == .annotation || $0.kind == .annotationRemove })
    await door.setOffline(false)
    await session.refresh()
    await delivered(session)
    let read14 = await door.posts("annotations")
    XCTAssertTrue(read14.isEmpty)
    let read15 = await door.comment(made.id)
    XCTAssertNil(read15)
  }

  // MARK: A drawing

  /// Bytes that start as a PNG does (the computer reads only that much of a drawing here).
  private func png(_ seed: UInt8) -> Data { Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] + Array(repeating: seed, count: 64)) }

  func testADrawingIsKeptBeforeItsCommentAndTheFeedbackNamesWhereTheComputerKeptIt() async throws {
    let door = StandInDoor()
    await door.addFilesThread()
    let picture = await door.addFile(thread: thread, message: StandInData.filesSecond, name: "flame.png", kind: .image, bytes: png(1), mediaType: "image/png", width: 8, height: 8)
    let (_, session) = try await seated(door: door)
    let item = try file(session, "flame.png")
    await door.setOffline(true)
    await session.refresh()

    let drawing = png(9)
    let made = try XCTUnwrap(session.addComment(thread: thread, item: item, version: .current, annotation: FileComments.picture(name: item.name, comment: "", markup: nil), drawing: drawing))
    XCTAssertEqual(made.words, Words.markupOnly, "a drawing with no words says so itself")
    let waiting = try XCTUnwrap(made.images.first)
    let hash = try XCTUnwrap(PendingDrawing.hash(waiting.path))
    XCTAssertEqual(session.drawing(hash), drawing, "the phone shows the drawing while it waits")
    _ = await session.send(thread: thread, words: "See the drawing.")
    XCTAssertEqual(session.held.filter { $0.kind != .seen }.map(\.kind), [.markup, .annotation, .reply])

    await door.setOffline(false)
    await door.clearCalls()
    await session.refresh()
    await delivered(session)
    // In order: the drawing, the comment that names it, the reply that carries the comment.
    let posts = await door.calls.filter { $0.method == .post && !$0.path.hasSuffix("/seen") }.map(\.path)
    XCTAssertEqual(posts, ["markups", "annotations", "messages/\(StandInData.filesSecond.rawValue)/reply"])
    let name = "\(hash).png"
    let read16 = await door.markup(name)
    XCTAssertEqual(read16, drawing)
    let there = StandInDoor.markupPath(name)
    let read17 = await door.comment(made.id)
    let saved = try XCTUnwrap(read17)
    XCTAssertEqual(saved.annotation["images"], .array([.object(["path": .string(there), "name": .string(name)])]), "the comment names the drawing where the computer kept it")
    XCTAssertEqual(saved.annotation["text"]?.text, Words.markupOnly)
    let read18 = await door.posts("/reply")
    let feedback = try XCTUnwrap(body(try XCTUnwrap(read18.last))["feedback"]?.text)
    XCTAssertTrue(feedback.contains("### 1. Feedback on: \"flame.png\"\n> See the marked-up image.\n**Attached images:**\n- [\(name)] `\(there)`\n"), feedback)
    XCTAssertFalse(feedback.contains(PendingDrawing.scheme))
    _ = picture
  }

  // MARK: The window's comments, and refusals

  func testCommentsMadeInTheWindowShowOnThePhoneAndTheOnesItCannotWriteStayForTheWindow() async throws {
    let (door, session) = try await seated()
    let plan = try file(session, StandInData.planName)
    await door.windowComments(on: plan.id.rawValue, annotation: FileComments.words(id: "win-1", block: "block-0", start: 0, quote: "Retry plan", comment: "Name the release."))
    var label = FileComments.words(id: "win-2", block: "block-0", start: 6, quote: "plan", comment: "Looks good")
    label["isQuickLabel"] = .bool(true)
    await door.windowComments(on: plan.id.rawValue, annotation: label)
    await session.readAttachments(thread)
    XCTAssertEqual(session.comments(thread).map(\.id), ["win-1", "win-2"], "both show")
    XCTAssertEqual(session.commentsToSend(thread).map(\.id), ["win-1"], "a quick label is written by the window's own Send")

    _ = await session.send(thread: thread, words: "")
    await delivered(session)
    let read19 = await door.posts("/reply")
    let reply = body(try XCTUnwrap(read19.last))
    XCTAssertEqual(reply["annotation_ids"]?.strings, ["win-1"])
    let read20 = await door.pendingComments(thread)
    XCTAssertEqual(read20.map(\.id), ["win-2"], "the label still waits on the computer")

    // The window sends it: it leaves the phone at the next read.
    await door.windowSendsComment("win-2")
    await session.readAttachments(thread)
    XCTAssertTrue(session.comments(thread).isEmpty)
  }

  func testAPhoneCommentIsNotLostToAReadThatRacesItsSave() async throws {
    let (door, session) = try await seated()
    await door.setOffline(true)
    await session.refresh()
    let made = try planComment(session)
    await door.setOffline(false)
    // The computer answers a read before the save has gone: its list has no such comment yet.
    session.takeComments(thread, from: [])
    XCTAssertEqual(session.comments(thread).map(\.id), [made.id])
    await session.refresh()
    await delivered(session)
    let read21 = await door.pendingComments(thread)
    XCTAssertEqual(read21.map(\.id), [made.id])
  }

  func testACommentTheComputerRefusesStaysWithItsReasonAndTheSendGoesWithoutIt() async throws {
    let (door, session) = try await seated()
    let plan = try file(session, StandInData.planName)
    await door.setOffline(true)
    await session.refresh()
    let made = try planComment(session)
    _ = await session.send(thread: thread, words: "One note.")
    await door.refuseComments(on: plan.id.rawValue)
    await door.setOffline(false)
    await session.refresh()
    await delivered(session)

    // The person's words go; the comment the computer would not keep stays here, and rides no Send until it is saved.
    let read22 = await door.posts("/reply").map(body)
    XCTAssertEqual(read22.count, 1)
    XCTAssertEqual(read22.first?["words"]?.text, "One note.")
    XCTAssertNil(read22.first?["annotation_ids"]?.items.first, "without the comment")
    XCTAssertNil(session.takeReturnedWords(thread), "nothing came back to the reply field")
    XCTAssertEqual(session.comments(thread).map(\.id), [made.id], "the comment is still here")
    guard case .refused(_, let code)? = session.commentRefusal(made.id) else { return XCTFail("the reason is kept") }
    XCTAssertEqual(code, "annotation_not_allowed")
    XCTAssertTrue(session.commentsToSend(thread).isEmpty, "and no Send names a comment the computer does not have")
  }

  func testAnInboxThatListsNoCommentsStillListsItsFilesAndOneWithoutTheRouteTakesNone() async throws {
    var options = StandInDoor.Options()
    options.omitsComments = true
    let (_, session) = try await seated(door: StandInDoor(options: options))
    XCTAssertEqual(session.attachments(thread).count, 6)
    XCTAssertTrue(session.takesComments(try file(session, StandInData.planName), in: thread))
    XCTAssertFalse(session.takesComments(try file(session, "stand-up.wav"), in: thread), "a recording's comments are at moments: not in this slice")

    var older = StandInDoor.Options()
    older.withoutRoutes = [DoorRoutes.postAnnotations.name]
    let (_, old) = try await seated(door: StandInDoor(options: older))
    let plan = try file(old, StandInData.planName)
    XCTAssertFalse(old.takesComments(plan, in: thread))
    XCTAssertNil(old.addComment(thread: thread, item: plan, version: .current, annotation: FileComments.words(block: "block-0", start: 0, quote: "Retry", comment: "?")))
  }

  // MARK: Places

  func testACodeCommentQuotesTheFilesOwnLinesHoweverTheyAreCutForTheScreen() {
    let long = String(repeating: "abcdefghij", count: 450)
    let rows = TextRows.code("first\n\(long)\nthird\n")
    XCTAssertGreaterThan(rows.rows.count, 3, "the long line is drawn in pieces")
    XCTAssertEqual(rows.source(lines: 2...2), long, "and quoted whole")
    XCTAssertEqual(rows.source(lines: 1...3), "first\n\(long)\nthird")
    XCTAssertEqual(rows.source(lines: 3...3), "third")
    XCTAssertEqual(rows.source(lines: 9...9), "")
  }

  func testAPlaceInPlainTextIsTheWindowsBlockOnThatLine() {
    let text = "---\ntitle: not front matter here\n---\nBody of the notes.\n\nA second paragraph\nruns on.\n"
    let rows = TextRows.plain(text)
    let blocks = DocumentBlocks.parse(text, frontmatter: false)
    // The second paragraph starts on the file's sixth line; "runs on." is a line further.
    let second = rows.rows[rows.rows.count - 1]
    XCTAssertEqual(rows.sourceLine(of: second), 6)
    XCTAssertEqual(DocumentBlocks.block(onLine: 6, in: blocks)?.content, "A second paragraph\nruns on.")
    XCTAssertEqual(DocumentBlocks.block(onLine: 7, in: blocks)?.id, DocumentBlocks.block(onLine: 6, in: blocks)?.id)
    XCTAssertEqual(DocumentBlocks.block(onLine: 2, in: blocks)?.content, "title: not front matter here")
    XCTAssertNil(DocumentBlocks.block(onLine: 0, in: blocks))
  }
}
