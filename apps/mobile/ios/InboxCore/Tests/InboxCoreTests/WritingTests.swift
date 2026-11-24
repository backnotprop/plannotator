import Foundation
import XCTest
@testable import InboxCore
import InboxStandIn
import InboxWire

/// Writing on the phone: a reply's draft with its files and quote, New message and its held Send, and attached files
/// going up to the computer.
@MainActor
final class WritingTests: XCTestCase {
  private func folder() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("inbox-writing-tests-\(UUID().uuidString)", isDirectory: true)
  }

  private func picture() -> Data { Data((0..<64).map { UInt8($0) }) }

  // MARK: The draft store

  func testADraftKeepsItsFilesAndQuoteAcrossTheAppBeingClosed() async throws {
    let door = StandInDoor()
    let copy = LocalCopy(folder: folder())
    var session = await pairedSession(door: door, copy: copy)
    await session.start()
    await session.open(StandInData.docs)
    let quoted = try XCTUnwrap(session.thread(StandInData.docs)?.thread.messages.first).id
    session.keepDraft(StandInData.docs, words: "See the screenshot")
    session.setQuote(StandInData.docs, DraftQuote(of: quoted))
    let file = await session.attach(picture(), name: "shot.png", type: "image/png", to: .thread(StandInData.docs))
    session.stop()

    // The app is closed and opened again: the same copy on the phone.
    session = await pairedSession(door: door, copy: copy)
    await session.start()
    let draft = try XCTUnwrap(session.draft(StandInData.docs))
    XCTAssertEqual(draft.words, "See the screenshot")
    XCTAssertEqual(draft.quote, DraftQuote(of: quoted))
    XCTAssertEqual(draft.files?.map(\.id), [file.id])
    XCTAssertNotNil(draft.files?.first?.upload, "the file went up to the computer when it was attached")
    XCTAssertEqual(session.fileBytes(try XCTUnwrap(draft.files?.first)), picture(), "the file's bytes are kept on the phone with the draft")
  }

  func testClearingTheWordsKeepsADraftThatStillHoldsAFile() async throws {
    let session = await pairedSession(door: StandInDoor())
    await session.start()
    session.keepDraft(StandInData.docs, words: "words")
    await session.attach(picture(), name: "a.png", type: "image/png", to: .thread(StandInData.docs))
    session.keepDraft(StandInData.docs, words: "")
    XCTAssertEqual(session.draft(StandInData.docs)?.files?.count, 1)
    let file = try XCTUnwrap(session.files(.thread(StandInData.docs)).first)
    session.removeFile(file.id, from: .thread(StandInData.docs))
    XCTAssertNil(session.draft(StandInData.docs), "a draft with no words, no file and no quote is not kept")
    XCTAssertNil(session.fileBytes(file), "a removed file's bytes leave the phone")
  }

  func testAReplyCarriesItsFilesAndQuoteAndSpendsThemFromTheDraft() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.docs)
    let messages = try XCTUnwrap(session.thread(StandInData.docs)?.thread.messages)
    let quoted = try XCTUnwrap(messages.first { $0.author.kind == .agent }).id
    session.setQuote(StandInData.docs, DraftQuote(of: quoted, words: "the review"))
    let file = await session.attach(picture(), name: "shot.png", type: "image/png", to: .thread(StandInData.docs))
    let upload = try XCTUnwrap(session.files(.thread(StandInData.docs)).first?.upload)
    await door.clearCalls()

    let sent = await session.send(thread: StandInData.docs, words: "Here it is", files: session.files(.thread(StandInData.docs)), quote: session.draft(StandInData.docs)?.quote)
    XCTAssertTrue(sent)
    let calls = await door.calls
    let reply = try XCTUnwrap(calls.filter { $0.method == .post && $0.path.hasSuffix("/reply") }.last)
    XCTAssertEqual(body(reply)["uploads"], .array([.string(upload)]))
    XCTAssertEqual(body(reply)["quote"]?["of"], .string(quoted.rawValue))
    XCTAssertEqual(body(reply)["quote"]?["words"], .string("the review"))
    XCTAssertNil(session.draft(StandInData.docs), "what the Send carried is spent")
    XCTAssertNil(session.fileBytes(file), "the computer has the file: the phone lets go of its copy")
    let docs = await door.thread(StandInData.docs)
    let written = try XCTUnwrap(docs?.messages.last)
    XCTAssertEqual(written.attachments?.map(\.name), ["shot.png"])
    XCTAssertEqual(written.quote?.of, quoted.rawValue)
  }

  func testARefusedReplyGivesItsFilesAndQuoteBack() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.docs)
    let quoted = try XCTUnwrap(session.thread(StandInData.docs)?.thread.messages.first).id
    session.setQuote(StandInData.docs, DraftQuote(of: quoted))
    await session.attach(picture(), name: "shot.png", type: "image/png", to: .thread(StandInData.docs))
    await door.setOptions { $0.proxyRefusesReplies = 403 }
    let files = session.files(.thread(StandInData.docs))
    _ = await session.send(thread: StandInData.docs, words: "Here it is", files: files, quote: session.draft(StandInData.docs)?.quote)
    XCTAssertEqual(session.takeReturnedWords(StandInData.docs), "Here it is")
    let back = try XCTUnwrap(session.draft(StandInData.docs))
    XCTAssertEqual(back.quote?.of, quoted)
    XCTAssertEqual(back.files?.map(\.id), files.map(\.id))
    XCTAssertEqual(back.files?.first?.upload, files.first?.upload, "the computer still keeps that upload: the next Send names it again")
    XCTAssertNotNil(session.fileBytes(try XCTUnwrap(back.files?.first)), "its bytes are still on the phone")
  }

  // MARK: The Send rules

  func testAFileNotOnTheComputerHoldsTheSendAndARefusedOneDoesNot() {
    let up = DraftFile(id: "a", name: "a.png", size: 1, type: "image/png", upload: "upl_A")
    let going = DraftFile(id: "b", name: "b.png", size: 1, type: "image/png")
    let refused = DraftFile(id: "c", name: ".env", size: 1, type: "text/plain", refused: "Not attached: .env files often hold secrets.")
    XCTAssertEqual(DraftFiles.uploads([up, refused]), ["upl_A"])
    XCTAssertNil(DraftFiles.uploads([up, going]))
    XCTAssertTrue(DraftFiles.holdSend([going]))
    XCTAssertFalse(DraftFiles.holdSend([refused]))

    let to = ComposeTo(host: "claude-code", session: "ses_api", project: "api-server")
    let now = Date()
    XCTAssertEqual(ComposeReadiness.of(nil, offered: true), .empty)
    XCTAssertEqual(ComposeReadiness.of(ComposeDraft(words: "Hi", editedAt: now), offered: true), .chooseAgent)
    XCTAssertEqual(ComposeReadiness.of(ComposeDraft(words: " ", to: to, editedAt: now), offered: true), .empty)
    XCTAssertEqual(ComposeReadiness.of(ComposeDraft(to: to, files: [refused], editedAt: now), offered: true), .empty, "a refused file alone is nothing to send")
    XCTAssertEqual(ComposeReadiness.of(ComposeDraft(words: "Hi", to: to, files: [going], editedAt: now), offered: true), .waitForFiles)
    XCTAssertEqual(ComposeReadiness.of(ComposeDraft(to: to, files: [up], editedAt: now), offered: true), .ready, "files alone are a message")
    XCTAssertEqual(ComposeReadiness.of(ComposeDraft(words: "Hi", to: to, editedAt: now), offered: false), .notOffered)
  }

  func testAReplyWithAFileStillGoingUpIsNotSent() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.docs)
    // Attached while the computer was away: in the draft, not on the computer yet.
    await door.setOffline(true)
    await session.attach(picture(), name: "a.png", type: "image/png", to: .thread(StandInData.docs))
    await door.setOffline(false)
    let going = session.files(.thread(StandInData.docs))
    XCTAssertNil(going.first?.upload)
    XCTAssertFalse(session.canSend(thread: StandInData.docs, words: "Hi", files: going))
    await door.clearCalls()
    let sent = await session.send(thread: StandInData.docs, words: "Hi", files: going)
    XCTAssertFalse(sent)
    let calls = await door.calls
    XCTAssertTrue(calls.filter { $0.path.hasSuffix("/reply") }.isEmpty)
    XCTAssertTrue(session.held.isEmpty, "nothing waits in the outbox")
  }

  func testANewMessageMadeWhileTheComputerIsAwayWaitsAndGoesOnceWhenItIsBack() async throws {
    let door = StandInDoor()
    let copy = LocalCopy(folder: folder())
    var session = await pairedSession(door: door, copy: copy)
    await session.start()
    await session.readSessions()
    let group = try XCTUnwrap(session.sessions.projects.first)
    let to = ComposeTo(try XCTUnwrap(group.sessions.first), in: group)
    await door.setOffline(true)
    session.changeCompose { $0.words = "Start on the export job"; $0.to = to }
    let outcome = await session.sendNew()
    XCTAssertEqual(outcome, .held)
    XCTAssertNil(session.composeDraft, "the words are in the outbox, not left in the draft")
    XCTAssertEqual(session.heldNewMessages().map(\.words), ["Start on the export job"])
    XCTAssertEqual(session.heldNewMessages().first?.to, to)
    session.stop()

    // Closed and opened again with the computer back: it goes, once.
    await door.setOffline(false)
    session = await pairedSession(door: door, copy: copy)
    await session.start()
    XCTAssertTrue(session.heldNewMessages().isEmpty)
    let started = await door.startedThreads
    XCTAssertEqual(started.count, 1)
    XCTAssertEqual(started.first?.messages.first?.body, "Start on the export job")
    XCTAssertEqual(started.first?.messages.first?.to?.session, to.session)
  }

  func testANewMessageToASessionThatEndedComesBackWithItsWordsAndFiles() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.readSessions()
    let group = try XCTUnwrap(session.sessions.projects.first)
    let to = ComposeTo(try XCTUnwrap(group.sessions.first), in: group)
    session.changeCompose { $0.words = "Ask about the export"; $0.to = to }
    await session.attach(picture(), name: "plan.png", type: "image/png", to: .compose)
    await door.setLiveSessions([])
    let outcome = await session.sendNew()
    XCTAssertEqual(outcome, .refused)
    let back = try XCTUnwrap(session.composeDraft)
    XCTAssertEqual(back.words, "Ask about the export")
    XCTAssertEqual(back.to, to)
    XCTAssertEqual(back.files.map(\.name), ["plan.png"])
    guard case .refused(_, let code)? = back.notice else { return XCTFail("the draft says why") }
    XCTAssertEqual(code, "session_not_live")
    XCTAssertTrue(session.held.isEmpty)
  }

  func testANewMessageWithAFileStartsAThreadThatCarriesIt() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.readSessions()
    let group = try XCTUnwrap(session.sessions.projects.first)
    let to = ComposeTo(try XCTUnwrap(group.sessions.first), in: group)
    session.changeCompose { $0.to = to }
    await session.attach(picture(), name: "plan.png", type: "image/png", to: .compose)
    XCTAssertEqual(session.composeReadiness(), .ready)
    let outcome = await session.sendNew()
    guard case .sent(let thread, let went) = outcome else { return XCTFail("sent: \(outcome)") }
    XCTAssertEqual(went, to)
    let made = await door.thread(thread)
    XCTAssertEqual(made?.messages.first?.attachments?.map(\.name), ["plan.png"])
    XCTAssertNil(session.composeDraft)
    XCTAssertTrue(session.list?.sections.flatMap(\.threads).contains { $0.threadId == thread } ?? false, "the new thread is in the list")
  }

  func testTheSessionsLastReadStayWhileTheComputerIsAway() async throws {
    let door = StandInDoor()
    let copy = LocalCopy(folder: folder())
    var session = await pairedSession(door: door, copy: copy)
    await session.start()
    await session.readSessions()
    guard case .live(let live) = session.sessions, !live.isEmpty else { return XCTFail("live sessions read") }
    session.stop()
    await door.setOffline(true)
    session = await pairedSession(door: door, copy: copy)
    await session.start()
    await session.readSessions()
    XCTAssertEqual(session.sessions, .kept(live))
  }

  // MARK: Attached files

  func testAFileAttachedWhileTheComputerIsAwayWaitsThenGoesUp() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await door.setOffline(true)
    let file = await session.attach(picture(), name: "a.png", type: "image/png", to: .thread(StandInData.docs))
    XCTAssertEqual(session.fileState(try XCTUnwrap(session.files(.thread(StandInData.docs)).first)), .waiting)
    XCTAssertFalse(session.canSend(thread: StandInData.docs, words: "", files: session.files(.thread(StandInData.docs))))
    await door.setOffline(false)
    await session.refresh()
    let now = try XCTUnwrap(session.files(.thread(StandInData.docs)).first { $0.id == file.id })
    XCTAssertEqual(session.fileState(now), .attached)
    XCTAssertEqual(now.kind, "image")
  }

  func testOnTheRelayAFileNeedsTheComputersNetwork() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await door.setOptions { $0.refusesMarkups = WireErrorCode.relayUploadUnavailable.rawValue }
    await session.attach(picture(), name: "a.png", type: "image/png", to: .compose)
    XCTAssertEqual(session.fileState(try XCTUnwrap(session.files(.compose).first)), .needsNetwork)
    await door.setOptions { $0.refusesMarkups = nil }
    await session.uploadWaiting(.compose)
    XCTAssertEqual(session.fileState(try XCTUnwrap(session.files(.compose).first)), .attached)
  }

  func testAFileTheInboxRefusesSaysWhyInItsWords() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await door.refuseUploads("upload_refused")
    await session.attach(Data("SECRET=1".utf8), name: ".env", type: "text/plain", to: .compose)
    XCTAssertEqual(session.fileState(try XCTUnwrap(session.files(.compose).first)), .refused("Not attached: .env files often hold secrets."))
  }
}
