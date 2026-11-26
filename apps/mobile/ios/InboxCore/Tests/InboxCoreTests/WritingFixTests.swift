import Foundation
import XCTest
@testable import InboxCore
import InboxStandIn
import InboxWire

/// What a reply or a new message carries when things go wrong on the way: an upload the computer swept, a Send taken
/// back or refused, a second press, a file too large, a refusal that is for now only, a way that carries no files.
@MainActor
final class WritingFixTests: XCTestCase {
  private func folder() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("inbox-writing-fix-tests-\(UUID().uuidString)", isDirectory: true)
  }

  private func picture(_ seed: UInt8 = 1) -> Data { Data((0..<64).map { UInt8($0) &+ seed }) }

  private func keys(_ calls: [DoorCall]) -> [String] {
    calls.compactMap { call in call.query.first { $0.name == "idempotency_key" }?.value }
  }

  private func to(_ session: InboxSession) throws -> ComposeTo {
    let group = try XCTUnwrap(session.sessions.projects.first)
    return ComposeTo(try XCTUnwrap(group.sessions.first), in: group)
  }

  // MARK: An upload the computer swept (H1)

  func testAFileKeptInADraftPastTheComputersSweepGoesUpAgainAndTheReplyGoes() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.docs)
    await session.attach(picture(), name: "shot.png", type: "image/png", to: .thread(StandInData.docs))
    let first = try XCTUnwrap(session.files(.thread(StandInData.docs)).first?.upload)
    // A day later the computer sweeps the upload: no draft on the computer names it (the draft is the phone's).
    await door.sweepUploads()

    let sent = await session.send(thread: StandInData.docs, words: "Here it is", files: session.files(.thread(StandInData.docs)))
    XCTAssertTrue(sent)
    let got1 = await door.thread(StandInData.docs)?.messages.last
    let written = try XCTUnwrap(got1)
    XCTAssertEqual(written.author.kind, .person)
    XCTAssertEqual(written.attachments?.map(\.name), ["shot.png"], "the file went up again and the reply carries it")
    let uploads = await door.uploadCalls
    XCTAssertEqual(uploads.count, 2)
    XCTAssertEqual(Set(keys(uploads)).count, 2, "the second upload has its own key: the first key only answers the swept upload again")
    let replies = await door.posts("/reply").map(body)
    XCTAssertEqual(replies.first?["uploads"], .array([.string(first)]))
    XCTAssertNotEqual(replies.last?["uploads"], .array([.string(first)]))
    XCTAssertNotEqual(replies.first?["idempotency_key"], replies.last?["idempotency_key"], "the refused key is spent")
    XCTAssertTrue(session.held.isEmpty)
    XCTAssertNil(session.notices[StandInData.docs], "the person is told nothing: nothing was lost")
    XCTAssertNil(session.draft(StandInData.docs))
  }

  func testANewMessageWhoseUploadWasSweptGoesUpAgainAndStartsItsThread() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.readSessions()
    let to = try to(session)
    session.changeCompose { $0.words = "The plan"; $0.to = to }
    await session.attach(picture(), name: "plan.png", type: "image/png", to: .compose)
    await door.sweepUploads()
    let outcome = await session.sendNew()
    guard case .sent(let thread, _) = outcome else { return XCTFail("sent: \(outcome)") }
    let got2 = await door.thread(thread)?.messages.first?.attachments?.map(\.name)
    XCTAssertEqual(got2, ["plan.png"])
    XCTAssertNil(session.composeDraft)
  }

  func testAnUploadSweptAgainAfterItWentUpAgainIsRefusedOnceNotForEver() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.docs)
    await session.attach(picture(), name: "shot.png", type: "image/png", to: .thread(StandInData.docs))
    await door.sweepUploads()
    // Every upload from now on is swept as soon as it is made: the Send is tried again once, then refused.
    await door.setOptions { $0.sweepsUploads = true }
    _ = await session.send(thread: StandInData.docs, words: "Here it is", files: session.files(.thread(StandInData.docs)))
    let replies = await door.posts("/reply")
    XCTAssertEqual(replies.count, 2, "sent again once, never in a loop")
    XCTAssertEqual(session.takeReturnedWords(StandInData.docs), "Here it is")
    XCTAssertEqual(session.files(.thread(StandInData.docs)).map(\.name), ["shot.png"], "the file is back in the draft")
  }

  func testARefusedReplysFilesGoUpAgainOnlyWhenTheComputerNoLongerHasThem() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.docs)
    await session.attach(picture(), name: "shot.png", type: "image/png", to: .thread(StandInData.docs))
    let first = try XCTUnwrap(session.files(.thread(StandInData.docs)).first?.upload)
    // Refused for another reason: the computer still keeps the upload, so nothing goes up again.
    await door.setOptions { $0.proxyRefusesReplies = 403 }
    _ = await session.send(thread: StandInData.docs, words: "Here it is", files: session.files(.thread(StandInData.docs)))
    XCTAssertEqual(session.files(.thread(StandInData.docs)).first?.upload, first)
    let once = await door.uploadCalls.count
    XCTAssertEqual(once, 1, "no second upload")
    // Refused because the upload is gone (swept, and swept again after going up once more): under a new key.
    await door.setOptions { $0.proxyRefusesReplies = nil; $0.sweepsUploads = true }
    await door.sweepUploads()
    _ = await session.send(thread: StandInData.docs, words: "Here it is", files: session.files(.thread(StandInData.docs)))
    let back = try XCTUnwrap(session.files(.thread(StandInData.docs)).first)
    XCTAssertNotNil(back.upload, "it went up again without the person asking")
    XCTAssertNotEqual(back.upload, first, "under a new key, so the computer answers a new upload, not the old one again")
  }

  func testANewMessageRefusedForAnEndedSessionKeepsItsUploads() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.readSessions()
    let to = try to(session)
    session.changeCompose { $0.words = "The plan"; $0.to = to }
    await session.attach(picture(), name: "plan.png", type: "image/png", to: .compose)
    let first = try XCTUnwrap(session.files(.compose).first?.upload)
    await door.setLiveSessions([])
    _ = await session.sendNew()
    XCTAssertNotNil(session.composeDraft?.notice, "refused, and said")
    XCTAssertEqual(session.files(.compose).first?.upload, first, "the computer keeps the upload: it is named again, not sent up again")
    let calls = await door.uploadCalls.count
    XCTAssertEqual(calls, 1)
  }

  // MARK: Nothing dropped on the way (M1)

  func testASendPulledBackBehindARefusedPickGivesBackItsFilesAndQuote() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    let asked = try XCTUnwrap(session.thread(StandInData.retry)?.thread.messages.last { $0.author.kind == .agent })
    let question = try XCTUnwrap(asked.questions?.first)
    let quoted = try XCTUnwrap(session.thread(StandInData.retry)?.thread.messages.first).id
    await session.attach(picture(), name: "shot.png", type: "image/png", to: .thread(StandInData.retry))
    session.setQuote(StandInData.retry, DraftQuote(of: quoted))
    await door.setOffline(true)
    await session.refresh()
    await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))
    let files = session.files(.thread(StandInData.retry))
    await session.send(thread: StandInData.retry, words: "Go ahead", files: files, quote: session.draft(StandInData.retry)?.quote)
    XCTAssertTrue(session.files(.thread(StandInData.retry)).isEmpty, "the Send holds them now")
    // Back, and the pick gives way to an answer made elsewhere: the Send behind it does not go.
    await door.setOffline(false)
    await door.setOptions { $0.racesPicks = 1 }
    await session.refresh()

    XCTAssertTrue(session.held.isEmpty)
    XCTAssertEqual(session.takeReturnedWords(StandInData.retry), "Go ahead")
    let draft = try XCTUnwrap(session.draft(StandInData.retry))
    XCTAssertEqual(draft.files?.map(\.id), files.map(\.id), "its files are back in the draft")
    XCTAssertEqual(draft.quote?.of, quoted, "and its quote")
    XCTAssertNotNil(session.fileBytes(try XCTUnwrap(draft.files?.first)), "with their bytes")
  }

  func testASendOfFilesAndAPickThatWasAlreadySentGoesWithItsFiles() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    let asked = try XCTUnwrap(session.thread(StandInData.retry)?.thread.messages.last { $0.author.kind == .agent })
    let question = try XCTUnwrap(asked.questions?.first)
    await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Everyone at once"], note: ""))
    // The laptop sends that answer while the phone still shows the question open.
    let other = DoorClient(transport: StandInTransport(door: door), token: session.computer.token, app: testApp)
    _ = try await other.reply(asked.id, body: DoorReplyBody(idempotencyKey: "laptop-send", words: "", questions: [DoorQuestionPick(key: question.key, revision: 1)]))
    await session.attach(picture(), name: "shot.png", type: "image/png", to: .thread(StandInData.retry))
    let files = session.files(.thread(StandInData.retry))
    XCTAssertNotNil(files.first?.upload)
    // Away, the person changes the pick and sends it with the file and no words.
    await door.setOffline(true)
    await session.refresh()
    let seen = try XCTUnwrap(session.thread(StandInData.retry)?.thread.messages.first { $0.id == asked.id }?.questions?.first)
    await session.pick(thread: StandInData.retry, message: asked.id, question: seen, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))
    await session.send(thread: StandInData.retry, words: "", files: files)
    XCTAssertTrue(session.files(.thread(StandInData.retry)).isEmpty, "the Send holds the file now")
    // Back: the pick is refused (its answer was already sent); the Send behind it still carries the file.
    await door.setOffline(false)
    await session.refresh()

    let replies = await door.posts("/reply").map(body)
    let mine = try XCTUnwrap(replies.last)
    XCTAssertEqual(mine["uploads"], .array([.string(try XCTUnwrap(files.first?.upload))]), "the file went, not dropped with the answer")
    XCTAssertNil(mine["questions"]?.items.first, "without the answer the laptop already sent")
    XCTAssertTrue(session.held.isEmpty)
  }

  // MARK: A second press (L5)

  func testASecondPressWithTheFilesTheFirstSendSpentSendsNothing() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.docs)
    await session.attach(picture(), name: "shot.png", type: "image/png", to: .thread(StandInData.docs))
    let files = session.files(.thread(StandInData.docs))
    // Two presses: the box was cleared by the first, but the second still holds the files it showed.
    let first = await session.send(thread: StandInData.docs, words: "Here it is", files: files)
    let second = await session.send(thread: StandInData.docs, words: "", files: files)
    XCTAssertTrue(first)
    XCTAssertFalse(second)
    let got3 = await door.posts("/reply").count
    XCTAssertEqual(got3, 1, "one reply, the file in it once")
    XCTAssertNil(session.notices[StandInData.docs])
  }

  // MARK: The ↩ rule (M3)

  /// A thread with two agents: Claude Code's question, then Codex's later message.
  private func twoAgents(_ door: StandInDoor) async throws -> InboxThread {
    let got4 = await door.thread(StandInData.docs)?.project
    let project = try XCTUnwrap(got4)
    let made = "2026-11-20T10:00:00.000Z"
    func message(_ n: Int, _ author: InboxAuthor, _ body: String) -> InboxMessageWire {
      InboxMessageWire(seq: Int64(900 + n), id: MessageID("msg_TWOAGENTS\(n)"), projectId: ProjectID(project.id), threadId: ThreadID("msg_TWOAGENTS0"), author: author, body: body, createdAt: made)
    }
    return InboxThread(
      threadId: ThreadID("msg_TWOAGENTS0"), project: project, subject: "Two agents",
      messages: [
        message(0, InboxAuthor(kind: .agent, host: "claude-code", session: "ses_CLAUDE"), "Should the export run nightly?"),
        message(1, InboxAuthor(kind: .agent, host: "codex", session: "ses_CODEX"), "The billing tables are migrated."),
      ])
  }

  func testQuotingAnOlderAgentsMessageSendsTheWordsToThatAgent() async throws {
    let door = StandInDoor()
    let thread = try await twoAgents(door)
    await door.add(thread)
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(thread.threadId)
    session.replyArrow(thread.threadId, at: MessageID("msg_TWOAGENTS0"))
    XCTAssertEqual(session.draft(thread.threadId)?.quote, DraftQuote(of: MessageID("msg_TWOAGENTS0")))
    _ = await session.send(thread: thread.threadId, words: "Yes, nightly.", quote: session.draft(thread.threadId)?.quote)
    let replies = await door.posts("/reply")
    XCTAssertEqual(replies.count, 1)
    XCTAssertEqual(replies.first?.path, "messages/msg_TWOAGENTS0/reply", "to Claude Code, whose message it quotes, not to Codex who wrote last")
    let got5 = await door.thread(thread.threadId)?.messages.last
    let written = try XCTUnwrap(got5)
    XCTAssertTrue(written.body.hasPrefix("Replying to your message from"), "the lead tells Claude Code it is its own message")
  }

  func testAPlainReplyArrowTakesAwayAQuoteInTheBox() async throws {
    let door = StandInDoor()
    let thread = try await twoAgents(door)
    await door.add(thread)
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(thread.threadId)
    session.replyArrow(thread.threadId, at: MessageID("msg_TWOAGENTS0"))
    XCTAssertNotNil(session.draft(thread.threadId)?.quote)
    // ↩ on the newest message: a plain Reply, so the quote goes.
    session.replyArrow(thread.threadId, at: MessageID("msg_TWOAGENTS1"))
    XCTAssertNil(session.draft(thread.threadId)?.quote)
    XCTAssertNil(session.draft(thread.threadId)?.aim, "with no quote on screen the reply is aimed at no one")
    XCTAssertNil(session.draft(thread.threadId), "and nothing is kept")
  }

  func testAPlainReplyArrowAimsAtNoOneSoTheWordsGoToTheAgentWhoWroteLast() async throws {
    let door = StandInDoor()
    let thread = try await twoAgents(door)
    await door.add(thread)
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(thread.threadId)
    // The person starts typing, then ↩ on Codex's message, the newest: a plain Reply, nothing on screen names Codex.
    session.keepDraft(thread.threadId, words: "Thanks.")
    session.replyArrow(thread.threadId, at: MessageID("msg_TWOAGENTS1"))
    XCTAssertNil(session.draft(thread.threadId)?.aim)
    // Later Claude Code writes, and the person sends their words.
    await door.agentWrites(thread: thread.threadId, body: "The export now runs nightly.")
    await session.refresh()
    await session.open(thread.threadId)
    let newest = try XCTUnwrap(session.thread(thread.threadId)?.thread.messages.last)
    XCTAssertEqual(newest.author.session, "ses_CLAUDE")
    _ = await session.send(thread: thread.threadId, words: "Thanks.", quote: session.draft(thread.threadId)?.quote)
    let replies = await door.posts("/reply")
    XCTAssertEqual(replies.map(\.path), ["messages/\(newest.id.rawValue)/reply"], "to Claude Code, who wrote last, as a plain reply goes")
  }

  func testAnArrowOnThePersonsOwnMessageLeavesNoAim() async throws {
    let door = StandInDoor()
    let thread = try await twoAgents(door)
    await door.add(thread)
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(thread.threadId)
    session.replyArrow(thread.threadId, at: MessageID("msg_TWOAGENTS0"))
    XCTAssertEqual(session.draft(thread.threadId)?.aim, "ses_CLAUDE", "a quote of Claude Code's message aims there")
    session.setQuote(thread.threadId, nil)
    XCTAssertNil(session.draft(thread.threadId), "the quote taken away takes the aim with it, and nothing is kept")
  }

  func testAQuoteWithFilesAndNoWordsStaysInTheDraft() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.docs)
    let quoted = try XCTUnwrap(session.thread(StandInData.docs)?.thread.messages.first).id
    session.setQuote(StandInData.docs, DraftQuote(of: quoted))
    await session.attach(picture(), name: "shot.png", type: "image/png", to: .thread(StandInData.docs))
    _ = await session.send(thread: StandInData.docs, words: "", files: session.files(.thread(StandInData.docs)), quote: session.draft(StandInData.docs)?.quote)
    let got6 = await door.posts("/reply").last
    let reply = try XCTUnwrap(got6)
    XCTAssertNil(body(reply)["quote"], "a quote rides the person's words only, as the Inbox keeps it")
    XCTAssertEqual(session.draft(StandInData.docs)?.quote?.of, quoted, "so it stays for the words that come")
  }

  // MARK: The stand-in's lead, as the store writes it (M5)

  func testTheStandInWritesNoLeadOnAReplyWithoutWordsAndNamesAnotherAgentByItsName() async throws {
    let door = StandInDoor()
    let thread = try await twoAgents(door)
    await door.add(thread)
    let client = DoorClient(transport: StandInTransport(door: door), token: await door.issueToken().token, app: testApp)
    // To Codex, quoting Claude Code's message: "Claude Code's message", never the raw host id.
    var reply = DoorReplyBody(idempotencyKey: "k1", words: "Noted.", questions: [])
    reply.quote = DoorReplyBodyQuote(of: "msg_TWOAGENTS0")
    _ = try await client.resend(method: .post, path: "messages/msg_TWOAGENTS1/reply", body: JSONEncoder().encode(reply))
    let got7 = await door.thread(thread.threadId)?.messages.last
    let quoting = try XCTUnwrap(got7)
    XCTAssertTrue(quoting.body.hasPrefix("Replying to Claude Code's message from "), quoting.body)
    XCTAssertTrue(quoting.body.contains("> Should the export run nightly?"))
    // No words: no quote and no lead.
    var empty = DoorReplyBody(idempotencyKey: "k2", words: "", questions: [])
    empty.quote = DoorReplyBodyQuote(of: "msg_TWOAGENTS0")
    empty.feedback = "A comment."
    _ = try? await client.resend(method: .post, path: "messages/msg_TWOAGENTS1/reply", body: JSONEncoder().encode(empty))
    let got8 = await door.thread(thread.threadId)?.messages.last
    let plain = try XCTUnwrap(got8)
    XCTAssertNil(plain.quote)
    XCTAssertFalse(plain.body.contains("Replying to"))
    // A quote of a message not in the thread is refused, and nothing is written.
    var stray = DoorReplyBody(idempotencyKey: "k3", words: "Hm.", questions: [])
    stray.quote = DoorReplyBodyQuote(of: "msg_NOTHERE")
    let before = await door.thread(thread.threadId)?.messages.count
    do {
      _ = try await client.resend(method: .post, path: "messages/msg_TWOAGENTS1/reply", body: JSONEncoder().encode(stray))
      XCTFail("refused")
    } catch let failure as DoorFailure {
      guard case .refused(422, let error) = failure else { return XCTFail("\(failure)") }
      XCTAssertEqual(error.field, "quote.of")
    }
    let got9 = await door.thread(thread.threadId)?.messages.count
    XCTAssertEqual(got9, before)
  }

  // MARK: A replayed new message (L1)

  func testANewMessageAnsweredByTheStoresReplayIsKnownAsSent() async throws {
    let decoded = try JSONDecoder().decode(
      DoorComposeAnswer.self,
      from: Data(#"{"thread_id":"msg_A","message":{"id":"msg_A","project_id":"prj_A","thread_id":"msg_A","author":{"kind":"person"},"body":"Hi","created_at":"2026-11-20T10:00:00.000Z"},"replayed":true}"#.utf8))
    XCTAssertEqual(decoded.threadId, ThreadID("msg_A"), "the store's replay names no project, and still reads")

    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.readSessions()
    let to = try to(session)
    session.changeCompose { $0.words = "Start on the export job"; $0.to = to }
    // Written, and answered 503: the door keeps no answer under that key, so the retry meets the store's replay.
    await door.failNextComposeAnswer()
    let outcome = await session.sendNew()
    XCTAssertEqual(outcome, .held)
    let held = try XCTUnwrap(session.held.first { $0.kind == .compose })
    await session.refresh()
    XCTAssertTrue(session.held.isEmpty)
    let got10 = await door.startedThreads.count
    XCTAssertEqual(got10, 1, "written once")
    let got11 = await door.startedThreads.first?.threadId
    XCTAssertEqual(session.draftBook.sent[held.thread], got11, "the phone knows where it went")
  }

  // MARK: Size (M2)

  func testAFileLargerThanTheInboxTakesIsRefusedOnThePhoneUnread() async throws {
    XCTAssertEqual(Words.uploadTooLarge, "Not attached: a file is at most \(DraftFiles.maxBytes / (1024 * 1024)) MB.", "the Inbox's limit and its words")
    let door = StandInDoor()
    let copy = LocalCopy(folder: folder())
    let session = await pairedSession(door: door, copy: copy)
    await session.start()
    let big = FileManager.default.temporaryDirectory.appendingPathComponent("inbox-big-\(UUID().uuidString).mov")
    XCTAssertTrue(FileManager.default.createFile(atPath: big.path, contents: nil))
    let handle = try FileHandle(forWritingTo: big)
    try handle.truncate(atOffset: UInt64(DraftFiles.maxBytes + 1))
    try handle.close()
    let file = await session.attach(fileAt: big, name: "film.mov", type: "video/quicktime", to: .compose)
    XCTAssertEqual(session.fileState(file), .refused(Words.uploadTooLarge))
    XCTAssertEqual(file.size, DraftFiles.maxBytes + 1)
    XCTAssertNil(session.fileBytes(file), "none of it was kept")
    let got12 = await door.uploadCalls.isEmpty
    XCTAssertTrue(got12, "none of it was sent")

    // One at the limit is copied, not read whole, and goes up from the copy.
    let small = FileManager.default.temporaryDirectory.appendingPathComponent("inbox-small-\(UUID().uuidString).txt")
    try Data("notes".utf8).write(to: small)
    let kept = await session.attach(fileAt: small, name: "notes.txt", type: "text/plain", to: .compose)
    XCTAssertEqual(session.fileBytes(kept), Data("notes".utf8))
    XCTAssertEqual(session.fileState(try XCTUnwrap(session.files(.compose).last)), .attached)
  }

  func testAFileThePhoneCouldNotReadShowsItsTileRefusedNeverNothing() async throws {
    XCTAssertEqual(Words.uploadNotReceived, "The file could not be received; try again.", "the Inbox's own words for a file it could not receive")
    let door = StandInDoor()
    let session = await pairedSession(door: door, copy: LocalCopy(folder: folder()))
    await session.start()
    await session.open(StandInData.docs)
    // A file whose size cannot be read (gone before it was read).
    let gone = FileManager.default.temporaryDirectory.appendingPathComponent("inbox-gone-\(UUID().uuidString).pdf")
    let unread = await session.attach(fileAt: gone, name: "report.pdf", type: "application/pdf", to: .thread(StandInData.docs))
    XCTAssertEqual(session.fileState(unread), .refused(Words.uploadNotReceived))
    // A file the library did not hand over.
    let lost = session.attachFailed(name: "photo-20261122-101500.jpg", type: "image/jpeg", to: .thread(StandInData.docs))
    XCTAssertEqual(session.fileState(lost), .refused(Words.uploadNotReceived))
    XCTAssertEqual(session.files(.thread(StandInData.docs)).map(\.name), ["report.pdf", "photo-20261122-101500.jpg"], "each shows a tile")
    let calls = await door.uploadCalls.isEmpty
    XCTAssertTrue(calls, "nothing to send up")
    XCTAssertFalse(DraftFiles.holdSend(session.files(.thread(StandInData.docs))), "a refused tile holds no Send up")
  }

  // MARK: A refusal for now (L3)

  func testAFileTheComputerCouldNotReceiveCanBeTriedAgain() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await door.refuseUploads("upload_refused", words: "The file could not be received; try again.", field: "body")
    let file = await session.attach(picture(), name: "a.png", type: "image/png", to: .compose)
    XCTAssertEqual(session.fileState(try XCTUnwrap(session.files(.compose).first)), .refusedForNow("The file could not be received; try again."))
    await door.refuseUploads(nil)
    await session.retryFile(file.id, in: .compose)
    XCTAssertEqual(session.fileState(try XCTUnwrap(session.files(.compose).first)), .attached)

    // The computer's disk full: for now too. A file refused for its name is not.
    await door.refuseUploads("upload_no_space", words: "Plannotator could not save the file: the disk is full.", field: "body")
    await session.attach(picture(2), name: "b.png", type: "image/png", to: .compose)
    XCTAssertEqual(session.fileState(try XCTUnwrap(session.files(.compose).last)), .refusedForNow("Plannotator could not save the file: the disk is full."))
    await door.refuseUploads("upload_refused")
    let secret = await session.attach(Data("SECRET=1".utf8), name: ".env", type: "text/plain", to: .compose)
    XCTAssertEqual(session.fileState(try XCTUnwrap(session.files(.compose).last)), .refused("Not attached: .env files often hold secrets."))
    await door.refuseUploads(nil)
    await session.retryFile(secret.id, in: .compose)
    XCTAssertEqual(session.fileState(try XCTUnwrap(session.files(.compose).last)), .refused("Not attached: .env files often hold secrets."), "no Try again for a file the Inbox will not take")
  }

  // MARK: A way that carries no files (L4)

  func testOnAWayThatCarriesNoFilesNoBytesCrossIt() async throws {
    let door = StandInDoor()
    let issued = await door.issueToken()
    let computer = PairedComputer(id: issued.device.rawValue, name: "Work Mac", token: issued.token, secret: "s", addresses: [])
    let session = InboxSession(computer: computer, app: testApp, copy: LocalCopy(folder: nil)) { _ in [NoFilesTransport(inner: StandInTransport(door: door))] }
    await session.start()
    await session.attach(picture(), name: "a.png", type: "image/png", to: .compose)
    XCTAssertEqual(session.fileState(try XCTUnwrap(session.files(.compose).first)), .needsNetwork)
    XCTAssertTrue(session.filesNeedNetwork(session.files(.compose)))
    let got13 = await door.uploadCalls.isEmpty
    XCTAssertTrue(got13, "the bytes never went over it")
  }

  // MARK: Typing (L7)

  func testTypingWritesTheDraftsOnceItPausesAndAtOnceWhenTheAppLeavesTheFront() async throws {
    final class Writes: @unchecked Sendable { var names: [String] = [] }
    let writes = Writes()
    var copy = LocalCopy(folder: folder())
    copy.watch = { name, _ in writes.names.append(name) }
    let session = await pairedSession(door: StandInDoor(), copy: copy)
    await session.start()
    writes.names = []
    for count in 1...20 { session.keepDraft(StandInData.docs, words: String(repeating: "a", count: count)) }
    for count in 1...20 { session.changeCompose { $0.words = String(repeating: "b", count: count) } }
    XCTAssertEqual(session.draft(StandInData.docs)?.words.count, 20, "the words are kept in memory at once")
    XCTAssertFalse(writes.names.contains("drafts.json"), "not written for every key")
    session.setInFront(false)
    XCTAssertEqual(writes.names.filter { $0 == "drafts.json" }.count, 1, "written once, at once, when the app leaves the front")
    XCTAssertEqual(copy.composeDraft()?.words.count, 20)
    XCTAssertEqual(copy.drafts().local[StandInData.docs]?.words.count, 20)
    // Typing, then a pause: written once by itself.
    writes.names = []
    session.keepDraft(StandInData.docs, words: "paused")
    try await Task.sleep(for: InboxSession.typingPause * 3)
    XCTAssertEqual(writes.names.filter { $0 == "drafts.json" }.count, 1)
    XCTAssertEqual(copy.drafts().local[StandInData.docs]?.words, "paused")
    session.stop()
  }

  // MARK: The app ends on the way

  func testAnUploadWhoseAnswerWasLostWhenTheAppEndedGoesUnderTheSameKeyAndIsKeptOnce() async throws {
    let door = StandInDoor()
    let copy = LocalCopy(folder: folder())
    let gate = Gate()
    var session = await pairedSession(door: door, copy: copy, gate: gate)
    await session.start()
    // It reaches the computer, and the app ends before the answer comes back.
    await gate.lose({ $0.path == "uploads" }, arrives: true)
    await session.attach(picture(), name: "shot.png", type: "image/png", to: .thread(StandInData.docs))
    XCTAssertNil(session.files(.thread(StandInData.docs)).first?.upload)
    session.stop()

    session = await pairedSession(door: door, copy: copy)
    await session.start()
    let file = try XCTUnwrap(session.files(.thread(StandInData.docs)).first)
    XCTAssertNotNil(file.upload, "it went up when the app opened again")
    let uploads = await door.uploadCalls
    XCTAssertEqual(Set(keys(uploads)).count, 1, "under the same key: the computer answers the upload it already has")
    XCTAssertEqual(session.fileBytes(file), picture())
  }

  func testAReplyWithAFileWhoseAnswerWasLostWhenTheAppEndedIsWrittenOnce() async throws {
    let door = StandInDoor()
    let copy = LocalCopy(folder: folder())
    let gate = Gate()
    var session = await pairedSession(door: door, copy: copy, gate: gate)
    await session.start()
    await session.open(StandInData.docs)
    await session.attach(picture(), name: "shot.png", type: "image/png", to: .thread(StandInData.docs))
    await gate.lose({ $0.path.hasSuffix("/reply") }, arrives: true)
    _ = await session.send(thread: StandInData.docs, words: "Here it is", files: session.files(.thread(StandInData.docs)))
    XCTAssertEqual(session.held.filter { $0.kind == .reply }.count, 1, "it may have arrived: it waits")
    session.stop()

    session = await pairedSession(door: door, copy: copy)
    await session.start()
    XCTAssertTrue(session.held.isEmpty)
    let mine = await door.thread(StandInData.docs)?.messages.filter { $0.author.kind == .person && $0.body == "Here it is" }
    XCTAssertEqual(mine?.count, 1, "written once")
    XCTAssertEqual(mine?.first?.attachments?.map(\.name), ["shot.png"])
    XCTAssertNil(session.draft(StandInData.docs))
  }

  // MARK: Unpair

  func testUnpairingErasesTheDraftsFilesAndTheNewMessage() async throws {
    let door = StandInDoor()
    let root = folder()
    let copy = LocalCopy(folder: root)
    let session = await pairedSession(door: door, copy: copy)
    await session.start()
    session.keepDraft(StandInData.docs, words: "Draft words")
    await session.attach(picture(), name: "shot.png", type: "image/png", to: .thread(StandInData.docs))
    session.changeCompose { $0.words = "A new message" }
    XCTAssertNotNil(copy.read("compose.json"))
    await session.removeThisPhone()
    XCTAssertFalse(FileManager.default.fileExists(atPath: root.path), "the drafts, their files' bytes and the new message are gone with the computer")
  }
}

/// A way to the computer that carries no files, as the relay does.
struct NoFilesTransport: DoorTransport {
  let inner: StandInTransport
  func send(_ call: DoorCall) async throws -> DoorAnswerBytes { try await inner.send(call) }
  var carriesFiles: Bool { false }
}
