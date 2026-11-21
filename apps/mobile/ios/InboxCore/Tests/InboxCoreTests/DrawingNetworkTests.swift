import Foundation
import XCTest
@testable import InboxCore
import InboxStandIn
import InboxWire

/// A drawing reaches the computer only on its own network (the relay carries no drawing). Away from it, a Send of
/// drawing comments queues nothing: the comments stay in the list, marked, the thread says so, and each goes by
/// itself, once, when its drawing has gone.
@MainActor
final class DrawingNetworkTests: XCTestCase {
  private let retry = StandInData.retry

  private func folder() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("inbox-core-tests-\(UUID().uuidString)", isDirectory: true)
  }

  private func png(_ seed: UInt8) -> Data { Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] + Array(repeating: seed, count: 64)) }

  /// The retry thread with a picture, reached through the relay only (the direct way is down).
  private func relayed(_ ways: Ways, door: StandInDoor = StandInDoor(), copy: LocalCopy = LocalCopy(folder: nil), cache: URL? = nil, addFile: Bool = true) async throws -> (StandInDoor, InboxSession, AttachmentItem) {
    if addFile { _ = await door.addFile(thread: retry, name: "flame.png", kind: .image, bytes: png(1), mediaType: "image/png", width: 8, height: 8) }
    let session = await twoWaySession(door: door, ways: ways, copy: copy, bytes: AttachmentCache(folder: cache ?? folder()), retryEvery: .milliseconds(100))
    await session.start()
    await session.open(retry)
    await session.readAttachments(retry)
    let picture = try XCTUnwrap(session.attachments(retry).first { $0.name == "flame.png" })
    return (door, session, picture)
  }

  private func settled(_ session: InboxSession) async {
    for _ in 0..<60 {
      await session.deliverHeld(thread: retry)
      try? await Task.sleep(for: .milliseconds(5))
    }
  }

  private func drawingComment(_ session: InboxSession, _ picture: AttachmentItem, words: String = "Crop the top.", seed: UInt8 = 9) throws -> FileComment {
    try XCTUnwrap(session.addComment(thread: retry, item: picture, version: .current, annotation: FileComments.picture(name: picture.name, comment: words, markup: nil), drawing: png(seed)))
  }

  /// The Sends the computer got that carry this comment.
  private func sendsCarrying(_ door: StandInDoor, _ id: String) async -> [JSONValue] {
    await door.posts("/reply").map(body).filter { ($0["annotation_ids"]?.items ?? []).contains { $0.text == id } }
  }

  /// Away from the network: a drawing comment made there, its drawing refused by the relay.
  private func waiting(_ ways: Ways, copy: LocalCopy = LocalCopy(folder: nil), cache: URL? = nil) async throws -> (StandInDoor, InboxSession, FileComment) {
    let (door, session, picture) = try await relayed(ways, copy: copy, cache: cache)
    let made = try drawingComment(session, picture)
    await settled(session)
    XCTAssertEqual(ways.drawingsOnRelay, 1)
    XCTAssertEqual(session.commentStanding(made, in: retry), .drawingWaits)
    return (door, session, made)
  }

  func testASendOfOnlyDrawingCommentsAwayFromTheNetworkQueuesNothingAndMarksThem() async throws {
    let ways = Ways()
    let (door, session, made) = try await waiting(ways)
    XCTAssertTrue(session.canSend(thread: retry, words: ""), "Send can be pressed for them")
    XCTAssertTrue(session.commentsNeedingNetwork(retry).isEmpty, "the thread says nothing before Send")

    let sent = await session.send(thread: retry, words: "")
    XCTAssertTrue(sent)
    await settled(session)
    XCTAssertFalse(session.held.contains { $0.kind == .reply }, "nothing is queued")
    XCTAssertTrue(session.heldReplies(retry).isEmpty, "no waiting message in the thread")
    let replies = await door.posts("/reply")
    XCTAssertTrue(replies.isEmpty, "nothing went")
    XCTAssertEqual(session.comments(retry).map(\.id), [made.id], "the comment stays in the list")
    XCTAssertEqual(session.commentStanding(made, in: retry), .drawingWaits, "marked")
    XCTAssertEqual(session.commentsNeedingNetwork(retry).map(\.id), [made.id], "and the thread says so")
    XCTAssertFalse(session.canSend(thread: retry, words: ""), "Send has nothing more to do")
    // It is still the person's to change.
    session.editComment(made.id, thread: retry, words: "Crop the top half.")
    XCTAssertEqual(session.comments(retry).first?.words, "Crop the top half.")
  }

  func testWordsMakeSendWorkAgainAndGoNowWhileTheDrawingStaysBehind() async throws {
    let ways = Ways()
    let (door, session, made) = try await waiting(ways)
    _ = await session.send(thread: retry, words: "")
    XCTAssertFalse(session.canSend(thread: retry, words: ""))
    XCTAssertTrue(session.canSend(thread: retry, words: "Ship it."), "words make Send work again")

    _ = await session.send(thread: retry, words: "Ship it.")
    await settled(session)
    let replies = await door.posts("/reply").map(body)
    XCTAssertEqual(replies.count, 1, "the words went now")
    XCTAssertEqual(replies.first?["words"]?.text, "Ship it.")
    XCTAssertNil(replies.first?["annotation_ids"]?.items.first, "without the drawing comment")
    XCTAssertEqual(session.commentsNeedingNetwork(retry).map(\.id), [made.id], "which stays behind, marked")
  }

  func testAnotherCommentMakesSendWorkAgainAndGoesNowWhileTheDrawingStaysBehind() async throws {
    let ways = Ways()
    let (door, session, made) = try await waiting(ways)
    _ = await session.send(thread: retry, words: "")
    let picture = try XCTUnwrap(session.attachments(retry).first { $0.name == "flame.png" })
    let words = try XCTUnwrap(session.addComment(thread: retry, item: picture, version: .current, annotation: FileComments.picture(name: picture.name, comment: "Label the axis.", markup: nil)))
    await settled(session)
    XCTAssertTrue(session.canSend(thread: retry, words: ""), "a comment the relay carries makes Send work again")
    _ = await session.send(thread: retry, words: "")
    await settled(session)
    let replies = await door.posts("/reply").map(body)
    XCTAssertEqual(replies.count, 1)
    XCTAssertEqual(replies.first?["annotation_ids"]?.items.compactMap(\.text), [words.id], "only the comment that can go")
    XCTAssertEqual(session.commentsNeedingNetwork(retry).map(\.id), [made.id])
  }

  func testTheDrawingCommentGoesByItselfOnceWhenTheDirectWayReturns() async throws {
    let ways = Ways()
    let (door, session, made) = try await waiting(ways)
    _ = await session.send(thread: retry, words: "")
    _ = await session.send(thread: retry, words: "Ship it.")
    await settled(session)
    let before = await door.thread(retry)?.messages.count ?? 0

    ways.direct = true
    await session.refresh()
    await settled(session)
    let markups = await door.posts("markups")
    XCTAssertEqual(markups.count, 1, "the drawing went over the direct way")
    let carrying = await sendsCarrying(door, made.id)
    XCTAssertEqual(carrying.count, 1, "the comment went by itself")
    XCTAssertEqual(carrying.first?["words"]?.text ?? "", "", "in a Send of its own, with no words")
    XCTAssertFalse((carrying.first?["feedback"]?.text ?? "").contains(PendingDrawing.scheme), "naming the drawing where the computer kept it")
    XCTAssertTrue(session.comments(retry).isEmpty, "it left the list")
    XCTAssertTrue(session.commentsNeedingNetwork(retry).isEmpty, "and the thread line")
    // It lands at the end of the thread, as the person's, to the agent the words answered.
    let messages = await door.thread(retry)?.messages ?? []
    XCTAssertEqual(messages.count, before + 1)
    XCTAssertEqual(messages.last?.author.kind, .person)

    // The way flaps: nothing goes twice.
    ways.direct = false
    await session.refresh()
    await settled(session)
    ways.direct = true
    await session.refresh()
    await settled(session)
    let again = await sendsCarrying(door, made.id)
    XCTAssertEqual(again.count, 1, "sent exactly once")
    let replies = await door.posts("/reply")
    XCTAssertEqual(replies.count, 2, "the words, then the comment")
  }

  func testADrawingCommentRemovedBeforeItGoesNeverGoes() async throws {
    let ways = Ways()
    let (door, session, made) = try await waiting(ways)
    _ = await session.send(thread: retry, words: "")
    XCTAssertNotNil(session.removeComment(made.id, thread: retry))
    XCTAssertTrue(session.comments(retry).isEmpty)
    XCTAssertTrue(session.commentsNeedingNetwork(retry).isEmpty, "the thread line goes with it")

    ways.direct = true
    await session.refresh()
    await settled(session)
    let replies = await door.posts("/reply")
    XCTAssertTrue(replies.isEmpty, "no Send carried it")
    let markups = await door.posts("markups")
    XCTAssertTrue(markups.isEmpty, "its drawing never went")
    let there = await door.pendingComments(retry)
    XCTAssertTrue(there.isEmpty, "nor the comment")
    XCTAssertTrue(session.comments(retry).isEmpty, "and it does not come back")
  }

  func testUndoOfARemovalBringsBackACommentThatStillGoesByItself() async throws {
    let ways = Ways()
    let (door, session, made) = try await waiting(ways)
    _ = await session.send(thread: retry, words: "")
    let removed = try XCTUnwrap(session.removeComment(made.id, thread: retry))
    let back = try XCTUnwrap(session.restoreComment(removed))
    await settled(session)
    XCTAssertEqual(session.commentsNeedingNetwork(retry).map(\.id), [back.id])
    ways.direct = true
    await session.refresh()
    await settled(session)
    let carrying = await sendsCarrying(door, back.id)
    XCTAssertEqual(carrying.count, 1)
  }

  func testAfterARelaunchTheCommentIsStillMarkedAndGoesOnceWhenTheDirectWayReturns() async throws {
    let ways = Ways()
    let copy = LocalCopy(folder: folder())
    let cache = folder()
    let (door, session, made) = try await waiting(ways, copy: copy, cache: cache)
    _ = await session.send(thread: retry, words: "")
    session.stop()

    // Opened again, still away from the network.
    let (_, reopened, _) = try await relayed(ways, door: door, copy: copy, cache: cache, addFile: false)
    await settled(reopened)
    XCTAssertEqual(reopened.comments(retry).map(\.id), [made.id])
    XCTAssertEqual(reopened.commentStanding(made, in: retry), .drawingWaits, "still marked")
    XCTAssertEqual(reopened.commentsNeedingNetwork(retry).map(\.id), [made.id], "and the thread still says so")
    XCTAssertFalse(reopened.held.contains { $0.kind == .reply }, "nothing queued")
    reopened.stop()

    // Opened again on the computer's network.
    ways.direct = true
    let (_, home, _) = try await relayed(ways, door: door, copy: copy, cache: cache, addFile: false)
    await settled(home)
    let carrying = await sendsCarrying(door, made.id)
    XCTAssertEqual(carrying.count, 1, "it went by itself")
    home.stop()

    // And once more: nothing goes again.
    let (_, last, _) = try await relayed(ways, door: door, copy: copy, cache: cache, addFile: false)
    await settled(last)
    let again = await sendsCarrying(door, made.id)
    XCTAssertEqual(again.count, 1, "exactly once")
    XCTAssertTrue(last.comments(retry).isEmpty)
  }

  func testASendOfOnlyDrawingCommentsMadeWithTheComputerAwayLeavesTheQueueWhenOnlyTheRelayAnswers() async throws {
    let ways = Ways()
    let (door, session, picture) = try await relayed(ways)
    // Made and sent with the computer away: the phone cannot tell which way will answer, so the Send waits.
    await door.setOffline(true)
    await session.refresh()
    let made = try drawingComment(session, picture)
    let queued = await session.send(thread: retry, words: "")
    XCTAssertTrue(queued)
    XCTAssertEqual(session.heldReplies(retry).count, 1)
    // Back through the relay only: the Send leaves the queue; the comment is back in the list, marked.
    await door.setOffline(false)
    await session.refresh()
    await settled(session)
    XCTAssertEqual(ways.drawingsOnRelay, 1)
    XCTAssertTrue(session.heldReplies(retry).isEmpty, "no Send waits on the drawing")
    let none = await door.posts("/reply")
    XCTAssertTrue(none.isEmpty)
    XCTAssertEqual(session.commentsNeedingNetwork(retry).map(\.id), [made.id])
    XCTAssertFalse(session.canSend(thread: retry, words: ""))
    // Nothing is asked again on this way.
    for _ in 0..<60 where session.retry != nil { try? await Task.sleep(for: .milliseconds(10)) }
    XCTAssertNil(session.retry, "nothing is asked again on this way")
    // The direct way: it goes by itself, once.
    ways.direct = true
    await session.refresh()
    await settled(session)
    let carrying = await sendsCarrying(door, made.id)
    XCTAssertEqual(carrying.count, 1)
    XCTAssertTrue(session.comments(retry).isEmpty)
  }

  func testACommentThatWentByItselfIsNeverSentTwiceAfterALostAnswerAndARelaunch() async throws {
    let ways = Ways()
    let copy = LocalCopy(folder: folder())
    let cache = folder()
    let door = StandInDoor()
    _ = await door.addFile(thread: retry, name: "flame.png", kind: .image, bytes: png(1), mediaType: "image/png", width: 8, height: 8)
    let lose = LoseOnce()
    let issued = await door.issueToken()
    let computer = PairedComputer(id: issued.device.rawValue, name: "Work Mac", token: issued.token, secret: "s", addresses: [])
    func session() -> InboxSession {
      InboxSession(computer: computer, app: testApp, copy: copy, retryEvery: .milliseconds(100), bytes: AttachmentCache(folder: cache)) { _ in
        let inner = StandInTransport(door: door)
        return [LosingWay(inner: DirectWay(inner: inner, ways: ways), lose: lose), RelayWay(inner: inner, ways: ways)]
      }
    }
    let first = session()
    await first.start()
    await first.open(retry)
    await first.readAttachments(retry)
    let picture = try XCTUnwrap(first.attachments(retry).first { $0.name == "flame.png" })
    let made = try drawingComment(first, picture)
    await settled(first)
    _ = await first.send(thread: retry, words: "")
    let before = await door.thread(retry)?.messages.filter { $0.author.kind == .person }.count ?? 0

    // Back on the network: the comment's own Send reaches the computer, and its answer is lost on the way back.
    ways.direct = true
    await first.refresh()
    for _ in 0..<200 where !lose.spent { try? await Task.sleep(for: .milliseconds(5)) }
    XCTAssertTrue(lose.spent)
    let waiting = try XCTUnwrap(first.held.first { $0.kind == .reply })
    first.stop()

    // The app ends there. Opened again, as if it ended before it noted the comment had gone in a Send of its own.
    let again = session()
    await again.start()
    again.commentBook.owed.insert(made.id)
    await again.open(retry)
    await again.readAttachments(retry)
    for _ in 0..<60 {
      await again.deliverHeld(thread: retry)
      try? await Task.sleep(for: .milliseconds(5))
    }
    let posted = await sendsCarrying(door, made.id)
    XCTAssertEqual(Set(posted.compactMap { $0["idempotency_key"]?.text }), [waiting.id], "only the one Send, tried again under its own key")
    let messages = await door.thread(retry)?.messages.filter { $0.author.kind == .person } ?? []
    XCTAssertEqual(messages.count, before + 1, "one message on the computer")
    XCTAssertTrue(again.comments(retry).isEmpty)
    XCTAssertTrue(again.commentBook.owed.isEmpty)
  }

  /// What the person sees as waiting to send in a thread ("Will send" on its row, the away line).
  private func willSend(_ session: InboxSession) -> [HeldWrite] { session.held.filter { $0.thread == retry.rawValue && session.willSend($0) } }

  func testTheWaitingDrawingIsCountedAndNothingSaysWillSendForIt() async throws {
    let ways = Ways()
    let copy = LocalCopy(folder: folder())
    let cache = folder()
    let (door, session, made) = try await waiting(ways, copy: copy, cache: cache)
    XCTAssertEqual(session.commentsCounted(retry).map(\.id), [made.id], "counted before Send")
    _ = await session.send(thread: retry, words: "")
    XCTAssertEqual(session.commentsCounted(retry).map(\.id), [made.id], "and after: it is in the list until it goes")
    XCTAssertTrue(session.commentsToSend(retry).isEmpty, "though no Send carries it")
    XCTAssertFalse(session.held.filter { $0.thread == retry.rawValue && $0.kind != .seen }.isEmpty, "its drawing and save are on the phone")
    XCTAssertTrue(willSend(session).isEmpty, "but nothing is queued to send")

    // The computer away altogether: still nothing to say "Will send" for.
    await door.setOffline(true)
    await session.refresh()
    XCTAssertTrue(willSend(session).isEmpty)
    session.stop()

    // Opened again with the computer away: the relay's refusal is not known yet, and still nothing says it.
    let (_, reopened, _) = try await relayed(ways, door: door, copy: copy, cache: cache, addFile: false)
    XCTAssertTrue(willSend(reopened).isEmpty)
    XCTAssertEqual(reopened.commentsCounted(retry).map(\.id), [made.id])
    // A Send of words made now is truly queued: that one says it.
    _ = await reopened.send(thread: retry, words: "Ship it.")
    XCTAssertEqual(willSend(reopened).map(\.kind), [.reply])
  }

  func testADrawingRefusedForGoodDoesNotGoByItselfAfterAChange() async throws {
    let ways = Ways()
    ways.direct = true
    let door = StandInDoor()
    await door.setOptions { $0.refusesMarkups = "markup_too_large" }
    let (_, session, picture) = try await relayed(ways, door: door)
    let made = try drawingComment(session, picture)
    await settled(session)
    XCTAssertNotNil(session.commentRefusal(made.id), "not saved: the person is told on the comment")
    XCTAssertTrue(session.commentsToOwe(retry).isEmpty, "a Send does not make it go by itself")
    XCTAssertTrue(session.commentsNeedingNetwork(retry).isEmpty)
  }

  // MARK: Who gets it, and when

  /// Agent A's message (Claude, which wrote last in the retry thread).
  private let askA = MessageID("msg_STANDIN0000000000000033")
  private var toA: String { "messages/\(askA.rawValue)/reply" }

  /// The Sends the computer got that carry this comment, as sent.
  private func calls(_ door: StandInDoor, carrying id: String) async -> [DoorCall] {
    await door.posts("/reply").filter { (body($0)["annotation_ids"]?.items ?? []).contains { $0.text == id } }
  }

  /// Agent B, another session, writes in the thread after A.
  private func agentBWrites(_ door: StandInDoor) async {
    await door.change(retry) { thread in
      var later = thread.messages[0]
      later.id = MessageID("msg_STANDINAGENTB")
      later.author = InboxAuthor(kind: .agent, host: "codex", session: "ses_other")
      later.questions = nil
      later.seq = 9_000
      later.body = "I am on the tests meanwhile."
      thread.messages.append(later)
    }
  }

  /// Back on the computer's network.
  private func home(_ ways: Ways, _ session: InboxSession) async {
    ways.direct = true
    await session.refresh()
    await settled(session)
  }

  /// The computer does not answer on any way.
  private func fullyAway(_ door: StandInDoor, _ session: InboxSession) async {
    await door.setOffline(true)
    await session.refresh()
  }

  func testTheCommentGoesByItselfToTheAgentTheWordsWentToWhenAnotherAgentWroteAfter() async throws {
    let ways = Ways()
    let (door, session, made) = try await waiting(ways)
    _ = await session.send(thread: retry, words: "Ship it.")
    await settled(session)
    let words = await door.posts("/reply")
    XCTAssertEqual(words.map(\.path), [toA], "the words went to A")
    await agentBWrites(door)
    // Still away from the network, the phone reads B's message.
    await session.refresh()
    await settled(session)
    XCTAssertEqual(session.thread(retry)?.thread.messages.last?.id.rawValue, "msg_STANDINAGENTB")

    await home(ways, session)
    let carrying = await calls(door, carrying: made.id)
    XCTAssertEqual(carrying.map(\.path), [toA], "to A, whom the words answered, not to B who wrote after")
  }

  func testACommentMarkedByASendOfNoWordsGoesToTheAgentTheWordsWouldHaveAnswered() async throws {
    let ways = Ways()
    let (door, session, made) = try await waiting(ways)
    _ = await session.send(thread: retry, words: "")
    await agentBWrites(door)
    await session.refresh()
    await settled(session)
    await home(ways, session)
    let carrying = await calls(door, carrying: made.id)
    XCTAssertEqual(carrying.map(\.path), [toA])
  }

  func testACommentMarkedByAnOlderBuildStillGoesByItselfToTheEndOfTheThread() async throws {
    let ways = Ways()
    let copy = LocalCopy(folder: folder())
    let cache = folder()
    let (door, session, made) = try await waiting(ways, copy: copy, cache: cache)
    _ = await session.send(thread: retry, words: "")
    session.stop()
    // A copy written before the agent was kept with the mark.
    let file = try XCTUnwrap(copy.folder).appendingPathComponent("comments.json")
    guard case .object(var fields) = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: file)) else { return XCTFail("not an object") }
    XCTAssertNotNil(fields["owedTo"])
    fields["owedTo"] = nil
    try JSONEncoder().encode(JSONValue.object(fields)).write(to: file)
    await agentBWrites(door)

    let (_, reopened, _) = try await relayed(ways, door: door, copy: copy, cache: cache, addFile: false)
    await settled(reopened)
    XCTAssertEqual(reopened.commentsNeedingNetwork(retry).map(\.id), [made.id], "it is still marked")
    await home(ways, reopened)
    let carrying = await calls(door, carrying: made.id)
    XCTAssertEqual(carrying.map(\.path), ["messages/msg_STANDINAGENTB/reply"], "to the agent the words answer now, as before")
  }

  func testFullyAwayAQueuedSendsWordsGoByTheRelayAndItsDrawingCommentGoesLaterToTheSameAgent() async throws {
    let ways = Ways()
    let (door, session, picture) = try await relayed(ways)
    await fullyAway(door, session)
    let made = try drawingComment(session, picture)
    _ = await session.send(thread: retry, words: "Ship it.")
    XCTAssertEqual(session.heldReplies(retry).count, 1)
    XCTAssertTrue(session.riding(retry).contains(made.id), "fully away, which way answers next is not known: the Send carries it")
    await agentBWrites(door)

    // The relay only: the words go now, to A, without the comment, which is marked.
    await door.setOffline(false)
    await session.refresh()
    await settled(session)
    let replies = await door.posts("/reply")
    XCTAssertEqual(replies.map(\.path), [toA])
    XCTAssertEqual(body(replies[0])["words"]?.text, "Ship it.")
    XCTAssertNil(body(replies[0])["annotation_ids"]?.items.first, "without the drawing comment")
    XCTAssertEqual(session.commentsNeedingNetwork(retry).map(\.id), [made.id], "which stays in the list, marked")
    XCTAssertEqual(session.commentStanding(made, in: retry), .drawingWaits)

    // B wrote after; the comment still goes to the agent that Send answered.
    await home(ways, session)
    let carrying = await calls(door, carrying: made.id)
    XCTAssertEqual(carrying.map(\.path), [toA])
    XCTAssertTrue(session.comments(retry).isEmpty)
  }

  func testFullyAwayWithItsDrawingAlreadyRefusedASendMarksTheCommentAndQueuesNothingForIt() async throws {
    let ways = Ways()
    let (door, session, made) = try await waiting(ways)
    await fullyAway(door, session)
    XCTAssertNil(session.pathIndex, "no way answers")
    XCTAssertFalse(session.parkedDrawings.isEmpty, "the relay's refusal is still known")
    _ = await session.send(thread: retry, words: "Ship it.")
    let queued = try XCTUnwrap(session.held.first { $0.kind == .reply })
    XCTAssertNil((try? JSONDecoder().decode(DoorReplyBody.self, from: queued.body))?.annotationIds, "the queued Send does not carry it")
    XCTAssertEqual(session.commentsNeedingNetwork(retry).map(\.id), [made.id], "it is marked")

    await door.setOffline(false)
    await session.refresh()
    await settled(session)
    let words = await door.posts("/reply")
    XCTAssertEqual(words.count, 1)
    await home(ways, session)
    let carrying = await calls(door, carrying: made.id)
    XCTAssertEqual(carrying.map(\.path), [toA], "it goes once, by itself")
  }

  func testAnAppEndedBetweenMarkingTheCommentAndLettingGoOfItStillMarksItAndSendsItOnce() async throws {
    let ways = Ways()
    let first = folder()
    let cache = folder()
    let writes = Writes()
    var copy = LocalCopy(folder: first)
    copy.watch = { name, data in writes.note(name, data) }
    let (door, session, picture) = try await relayed(ways, copy: copy, cache: cache)
    await fullyAway(door, session)
    let made = try drawingComment(session, picture)
    _ = await session.send(thread: retry, words: "Ship it.")
    let reply = try XCTUnwrap(session.held.first { $0.kind == .reply })
    XCTAssertTrue(session.riding(retry).contains(made.id))
    // The relay refused the drawing: the queued Send lets go of its comment.
    let markup = try XCTUnwrap(session.held.first { $0.kind == .markup })
    session.parkedDrawings[markup.id] = 1
    var before: [String: Data] = [:]
    for name in ["comments.json", "outbox.json"] { before[name] = try Data(contentsOf: first.appendingPathComponent(name)) }
    writes.start()
    XCTAssertTrue(session.releaseHeldBackComments(reply))
    let during = writes.stop()
    session.stop()
    XCTAssertEqual(Set(during.map(\.name)), ["comments.json", "outbox.json"])

    // The app ends right after the first of those writes: the copy as it stood then.
    let second = folder()
    try FileManager.default.createDirectory(at: second, withIntermediateDirectories: true)
    for name in try FileManager.default.contentsOfDirectory(atPath: first.path) {
      try FileManager.default.copyItem(at: first.appendingPathComponent(name), to: second.appendingPathComponent(name))
    }
    for write in during { try XCTUnwrap(before[write.name]).write(to: second.appendingPathComponent(write.name)) }
    try during[0].data.write(to: second.appendingPathComponent(during[0].name))

    // Opened again, through the relay only.
    await door.setOffline(false)
    let (_, reopened, _) = try await relayed(ways, door: door, copy: LocalCopy(folder: second), cache: cache, addFile: false)
    await settled(reopened)
    XCTAssertEqual(reopened.commentsNeedingNetwork(retry).map(\.id), [made.id], "still marked")
    let words = await door.posts("/reply")
    XCTAssertEqual(words.map { body($0)["words"]?.text }, ["Ship it."])
    XCTAssertNil(body(words[0])["annotation_ids"]?.items.first, "the words went without it")

    await home(ways, reopened)
    let carrying = await calls(door, carrying: made.id)
    XCTAssertEqual(carrying.map(\.path), [toA], "it went once, by itself")
    XCTAssertTrue(reopened.comments(retry).isEmpty)
  }

  func testTwoWaitingDrawingsGoTogetherInOneSendOfTheirOwn() async throws {
    let ways = Ways()
    let door = StandInDoor()
    _ = await door.addFile(thread: retry, name: "smoke.png", kind: .image, bytes: png(2), mediaType: "image/png", width: 8, height: 8)
    let (_, session, flame) = try await relayed(ways, door: door)
    let smoke = try XCTUnwrap(session.attachments(retry).first { $0.name == "smoke.png" })
    let one = try drawingComment(session, flame)
    let two = try drawingComment(session, smoke, words: "Less grey.", seed: 7)
    await settled(session)
    XCTAssertEqual(ways.drawingsOnRelay, 2)
    _ = await session.send(thread: retry, words: "")
    XCTAssertEqual(Set(session.commentsNeedingNetwork(retry).map(\.id)), [one.id, two.id])

    await home(ways, session)
    let markups = await door.posts("markups")
    XCTAssertEqual(markups.count, 2)
    let replies = await door.posts("/reply")
    XCTAssertEqual(replies.count, 1, "one Send of their own")
    XCTAssertEqual(replies.first?.path, toA)
    XCTAssertEqual(Set(replies.first.map { body($0)["annotation_ids"]?.items.compactMap(\.text) ?? [] } ?? []), [one.id, two.id], "carrying both")
    XCTAssertTrue(session.comments(retry).isEmpty)
  }

  func testACommentWhoseEditorIsOpenWaitsAndGoesWithItsNewWordsOnceTheEditorCloses() async throws {
    let ways = Ways()
    let (door, session, made) = try await waiting(ways)
    _ = await session.send(thread: retry, words: "")
    session.setEditing(made.id, thread: retry)
    await home(ways, session)
    let markups = await door.posts("markups")
    XCTAssertEqual(markups.count, 1, "its drawing went")
    var carrying = await calls(door, carrying: made.id)
    XCTAssertTrue(carrying.isEmpty, "not while its words are being changed")
    XCTAssertEqual(session.comments(retry).map(\.id), [made.id])

    XCTAssertEqual(session.editComment(made.id, thread: retry, words: "Crop the top half."), .changed)
    session.setEditing(nil, thread: retry)
    await settled(session)
    carrying = await calls(door, carrying: made.id)
    XCTAssertEqual(carrying.map(\.path), [toA], "it goes once the editor closes")
    XCTAssertTrue(body(carrying[0])["feedback"]?.text?.contains("Crop the top half.") == true, "with the new words")
    let there = await door.comment(made.id)
    XCTAssertEqual(there?.annotation["text"]?.text, "Crop the top half.")
  }

  func testACommentWhoseEditorClosesUnchangedGoesThen() async throws {
    let ways = Ways()
    let (door, session, made) = try await waiting(ways)
    _ = await session.send(thread: retry, words: "")
    session.setEditing(made.id, thread: retry)
    await home(ways, session)
    var carrying = await calls(door, carrying: made.id)
    XCTAssertTrue(carrying.isEmpty)
    XCTAssertEqual(session.editComment(made.id, thread: retry, words: made.words), .unchanged, "no change is no success")
    session.setEditing(nil, thread: retry)
    await settled(session)
    carrying = await calls(door, carrying: made.id)
    XCTAssertEqual(carrying.count, 1)
  }

  /// Fully away, a comment with no drawing made and sent: the Send waits, carrying it.
  private func queuedComment() async throws -> (StandInDoor, InboxSession, FileComment, HeldWrite) {
    let ways = Ways()
    let (door, session, picture) = try await relayed(ways)
    await fullyAway(door, session)
    let made = try XCTUnwrap(session.addComment(thread: retry, item: picture, version: .current, annotation: FileComments.picture(name: picture.name, comment: "Label the axis.", markup: nil)))
    _ = await session.send(thread: retry, words: "")
    let reply = try XCTUnwrap(session.held.first { $0.kind == .reply })
    XCTAssertTrue(session.riding(retry).contains(made.id))
    return (door, session, made, reply)
  }

  func testAnEditToACommentAWaitingSendCarriesChangesThatSendAndItsSaveGoesFirst() async throws {
    let (door, session, made, reply) = try await queuedComment()
    XCTAssertEqual(session.editComment(made.id, thread: retry, words: "Label both axes."), .changed)
    let saves = session.held.filter { $0.kind == .annotation && $0.subject == made.id }
    XCTAssertEqual(saves.count, 1, "one save, with the new words")
    let order = session.held.map(\.id)
    XCTAssertLessThan(try XCTUnwrap(order.firstIndex(of: saves[0].id)), try XCTUnwrap(order.firstIndex(of: reply.id)), "ahead of the Send")
    let feedback = (try? JSONDecoder().decode(DoorReplyBody.self, from: try XCTUnwrap(session.held.first { $0.id == reply.id }).body))?.feedback ?? ""
    XCTAssertTrue(feedback.contains("Label both axes."), feedback)

    await door.setOffline(false)
    await session.refresh()
    await settled(session)
    let sent = await calls(door, carrying: made.id)
    XCTAssertEqual(sent.count, 1)
    let words = body(sent[0])["feedback"]?.text ?? ""
    XCTAssertTrue(words.contains("Label both axes."), words)
    XCTAssertFalse(words.contains("Label the axis."), words)
    let there = await door.comment(made.id)
    XCTAssertEqual(there?.annotation["text"]?.text, "Label both axes.")
  }

  func testAnEditToACommentWhoseSendHasLeftIsNotKept() async throws {
    let (door, session, made, reply) = try await queuedComment()
    // On its way.
    session.book.inFlight.insert(reply.id)
    XCTAssertEqual(session.editComment(made.id, thread: retry, words: "Label both axes."), .alreadyWent)
    XCTAssertEqual(session.held.first { $0.id == reply.id }?.body, reply.body, "the Send is as it was")
    XCTAssertEqual(session.commentBook.kept[retry]?.first { $0.id == made.id }?.words, "Label the axis.", "and so is the comment")
    session.book.inFlight.remove(reply.id)
    // Delivered.
    await door.setOffline(false)
    await session.refresh()
    await settled(session)
    let sent = await calls(door, carrying: made.id)
    XCTAssertEqual(sent.count, 1)
    XCTAssertEqual(session.editComment(made.id, thread: retry, words: "Label both axes."), .alreadyWent)
  }

  func testAChangeMadeInTheEditorAfterTheCommentWentChangesNothingAnywhere() async throws {
    let ways = Ways()
    let (door, session, picture) = try await relayed(ways)
    let made = try XCTUnwrap(session.addComment(thread: retry, item: picture, version: .current, annotation: FileComments.picture(name: picture.name, comment: "Label the axis.", markup: nil)))
    await settled(session)
    // Its editor is open when a Send carries it (the person sent from another screen).
    session.setEditing(made.id, thread: retry)
    _ = await session.send(thread: retry, words: "")
    await settled(session)
    let sent = await calls(door, carrying: made.id)
    XCTAssertEqual(sent.count, 1)
    let outbox = session.held

    XCTAssertEqual(session.editComment(made.id, thread: retry, words: "Label both axes."), .alreadyWent, "the editor is told it was not kept")
    XCTAssertEqual(session.held, outbox, "nothing new is queued")
    session.setEditing(nil, thread: retry)
    await settled(session)
    let after = await calls(door, carrying: made.id)
    XCTAssertEqual(after.count, 1, "nothing goes again")
    let there = await door.comment(made.id)
    XCTAssertEqual(there?.annotation["text"]?.text, "Label the axis.", "the computer has the words that went")
    XCTAssertTrue(session.comments(retry).isEmpty)
  }

  func testADrawingThatLandsWhileTheThreadIsHandedOnMakesAPlainCommentThatNeverGoesByItself() async throws {
    let ways = Ways()
    let (door, session, made) = try await waiting(ways)
    _ = await session.send(thread: retry, words: "")
    // The thread is handed to another session on the computer.
    await door.change(retry) { thread in
      var handed = thread.messages[1]
      handed.id = MessageID("msg_STANDINHANDOFF")
      handed.seq = 9_001
      handed.body = "Over to Codex."
      handed.handoff = InboxHandoff(at: "2026-11-18T10:00:00.000Z")
      handed.to = InboxAddressee(host: "codex", session: "ses_other")
      thread.messages.append(handed)
    }
    await session.refresh()
    await settled(session)
    XCTAssertTrue(SendPlan.needsComputer(try XCTUnwrap(session.thread(retry)).thread))

    await home(ways, session)
    let markups = await door.posts("markups")
    XCTAssertEqual(markups.count, 1, "its drawing went")
    var carrying = await calls(door, carrying: made.id)
    XCTAssertTrue(carrying.isEmpty, "a handed-on thread is answered on the computer")
    XCTAssertFalse(session.commentBook.owed.contains(made.id), "it no longer goes by itself")
    XCTAssertTrue(session.commentsNeedingNetwork(retry).isEmpty, "nor says it needs the network")
    let plain = try XCTUnwrap(session.comments(retry).first { $0.id == made.id })
    XCTAssertEqual(session.commentStanding(plain, in: retry), .goes, "a plain comment, for the next Send")

    // The hand-off is undone later: the comment does not go by itself then.
    await door.change(retry) { thread in
      if let index = thread.messages.firstIndex(where: { $0.id.rawValue == "msg_STANDINHANDOFF" }) { thread.messages[index].handoff?.undoneAt = "2026-11-18T10:05:00.000Z" }
    }
    await session.refresh()
    await settled(session)
    carrying = await calls(door, carrying: made.id)
    XCTAssertTrue(carrying.isEmpty, "never later, by itself")
    // It rides the person's next Send.
    _ = await session.send(thread: retry, words: "Back to you.")
    await settled(session)
    carrying = await calls(door, carrying: made.id)
    XCTAssertEqual(carrying.count, 1)
    XCTAssertEqual(carrying.first.map { body($0)["words"]?.text }, "Back to you.")
  }

  func testAThreadArchivedWhileACommentWaitsKeepsTheCommentAndLosesNothing() async throws {
    let ways = Ways()
    let (door, session, made) = try await waiting(ways)
    _ = await session.send(thread: retry, words: "")
    // Archived on the computer.
    await door.change(retry) { $0.resolvedAt = "2026-11-18T10:00:00.000Z" }
    await door.changeState(retry) { $0.resolvedAt = "2026-11-18T10:00:00.000Z" }
    await session.refresh()
    await settled(session)

    await home(ways, session)
    let replies = await door.posts("/reply")
    XCTAssertTrue(replies.isEmpty, "nothing is sent into an archived thread by itself")
    let kept = try XCTUnwrap(session.comments(retry).first { $0.id == made.id }, "the comment is still in the list")
    XCTAssertEqual(kept.words, made.words, "with its words")
    XCTAssertFalse(kept.images.isEmpty, "and its drawing")
    XCTAssertFalse(session.commentBook.owed.contains(made.id), "it does not go by itself later")
  }
}

/// The files a copy writes, in order, while recording.
final class Writes: @unchecked Sendable {
  private let lock = NSLock()
  private var on = false
  private var seen: [(name: String, data: Data)] = []
  func start() { lock.withLock { on = true; seen = [] } }
  func stop() -> [(name: String, data: Data)] { lock.withLock { on = false; return seen } }
  func note(_ name: String, _ data: Data) { lock.withLock { if on { seen.append((name, data)) } } }
}

/// Loses the answer to the first Send after the computer took it.
final class LoseOnce: @unchecked Sendable {
  private let lock = NSLock()
  private var done = false
  var spent: Bool { lock.withLock { done } }
  func take() -> Bool { lock.withLock { defer { done = true }; return !done } }
}

struct LosingWay: DoorTransport {
  let inner: DirectWay
  let lose: LoseOnce
  func send(_ call: DoorCall) async throws -> DoorAnswerBytes {
    let answer = try await inner.send(call)
    if call.method == .post, call.path.hasSuffix("/reply"), lose.take() { throw URLError(.networkConnectionLost) }
    return answer
  }
  func events(_ call: DoorCall) async throws -> AsyncThrowingStream<Data, Error>? { try await inner.events(call) }
}
