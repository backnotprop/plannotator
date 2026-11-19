import Foundation
import XCTest
@testable import InboxCore
import InboxStandIn
import InboxWire

/// The app against a door: pairing, the list, a thread, an answer, the version handshake, a computer that is away.
/// The door is the stand-in (InboxStandIn), which answers in Wire.swift's shapes and keeps the door's rules.
@MainActor
final class DoorTests: XCTestCase {
  // proves: pair-02, pair-07
  func testPairingRedeemsTheSecretAndAWrongCodeSaysHowManyTriesAreLeft() async throws {
    let door = StandInDoor()
    let secret = await door.options.secret
    let client = DoorClient(transport: StandInTransport(door: door), token: nil, app: testApp)
    do {
      _ = try await client.pair(code: "000000", deviceName: "iPhone")
      XCTFail("a wrong code must be refused")
    } catch let failure as DoorFailure {
      guard case .refused(let status, let error) = failure else { return XCTFail("\(failure)") }
      XCTAssertEqual(status, 401)
      XCTAssertEqual(WireErrorCode(rawValue: error.code), .pairingCodeWrong)
      XCTAssertEqual(error.triesLeft, 4)
      XCTAssertEqual(error.error, "That code is not the one on your computer.")
    }
    let answer = try await client.pair(secret: secret, deviceName: "iPhone")
    XCTAssertTrue(answer.token.hasPrefix("tok_"))
    XCTAssertEqual(answer.computer.name, "Work Mac")
    let calls = await door.calls
    // Pairing carries no token and no idempotency key; it names the platform and the app.
    XCTAssertNil(calls.last?.headers["Authorization"])
    XCTAssertEqual(body(calls.last!), .object(["secret": .string(secret), "name": .string("iPhone"), "platform": .string("ios")]))
    XCTAssertEqual(calls.last?.headers[AppIdentity.headerName], "ios 0.1.0 contract \(wireContract)")
    // The token it got opens the door.
    let paired = DoorClient(transport: StandInTransport(door: door), token: answer.token, app: testApp)
    let list = try await paired.threads()
    XCTAssertEqual(list.unreadableRows, 0)
  }

  // proves: list-01
  func testTheListShowsTheComputersSectionsInItsOrderWithTheProductsNames() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    XCTAssertEqual(session.reach, .here)
    let sections = try XCTUnwrap(session.list?.sections)
    XCTAssertEqual(sections.map(\.id), [.stopped, .holding, .waiting, .new, .sent, .quiet])
    XCTAssertEqual(sections.map(\.label), ["Stopped on you", "Holding up work", "Waiting on you", "New since you looked", "Sent", "Quiet"])
    XCTAssertEqual(sections.map(\.threads.count), [1, 1, 2, 1, 1, 1])
    // Every request named the app and carried the token; none carried an Origin.
    for call in await door.calls {
      XCTAssertEqual(call.headers[AppIdentity.headerName], testApp.headerValue)
      XCTAssertEqual(call.headers["Authorization"], "Bearer \(session.computer.token)")
      XCTAssertNil(call.headers["Origin"])
    }
  }

  func testOneRowTheAppCannotReadIsLeftOutAndTheRestOfTheListStays() async throws {
    let good = try JSONEncoder().encode(StandInData.list(threads: StandInData.threads(now: Date()), unread: StandInData.unread, session: "s", cursor: 1, version: "1"))
    var root = try XCTUnwrap(JSONSerialization.jsonObject(with: good) as? [String: Any])
    var sections = try XCTUnwrap(root["sections"] as? [[String: Any]])
    var rows = try XCTUnwrap(sections[0]["threads"] as? [[String: Any]])
    rows.append(["thread_id": "msg_BROKEN", "section": 7])
    sections[0]["threads"] = rows
    root["sections"] = sections
    let read = try DoorClient.readList(JSONSerialization.data(withJSONObject: root))
    XCTAssertEqual(read.unreadableRows, 1)
    XCTAssertEqual(read.model.sections.map(\.threads.count), [1, 1, 2, 1, 1, 1])
  }

  // proves: answer-04, answer-06, answer-07, answer-08
  func testAnsweringSavesThePickAtOnceAndSendPostsOneReplyWithIt() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    let asked = try XCTUnwrap(session.thread(StandInData.retry)?.thread.messages.last)
    let question = try XCTUnwrap(asked.questions?.first)

    // Opening the thread told the computer how far the person saw.
    let seen = await door.posts("/seen")
    XCTAssertEqual(seen.count, 1)
    XCTAssertEqual(body(seen[0])["through_seq"], .number(Double(try XCTUnwrap(asked.seq))))

    await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))
    var now = try XCTUnwrap(session.thread(StandInData.retry)?.thread.messages.last?.questions?.first)
    XCTAssertEqual(now.state, .picked)
    XCTAssertEqual(now.revision, 1)

    // A second tap on another row moves the pick, at the revision the first one made.
    await session.pick(thread: StandInData.retry, message: asked.id, question: now, answer: QuestionAnswers.choice(now, selected: ["Everyone at once"], note: ""))
    now = try XCTUnwrap(session.thread(StandInData.retry)?.thread.messages.last?.questions?.first)
    XCTAssertEqual(now.answer?.selected, ["Everyone at once"])
    let picks = await door.posts("/picks")
    XCTAssertEqual(picks.map { body($0)["questions"]?.items.first?["revision"] }, [.number(0), .number(1)])
    XCTAssertEqual(picks.map { body($0)["unsent_only"] }, [.bool(true), .bool(true)])
    XCTAssertNil(session.refusal(message: asked.id, key: question.key))

    XCTAssertTrue(session.canSend(thread: StandInData.retry, words: ""))
    let sent = await session.send(thread: StandInData.retry, words: " Go ahead ")
    XCTAssertTrue(sent)
    let replies = await door.posts("/reply")
    XCTAssertEqual(replies.count, 1)
    XCTAssertEqual(replies[0].path, "messages/\(asked.id.rawValue)/reply")
    XCTAssertEqual(body(replies[0])["words"], .string("Go ahead"))
    XCTAssertEqual(body(replies[0])["questions"], .array([.object(["key": .string("q_rollout"), "revision": .number(2)])]))
    XCTAssertNil(body(replies[0])["skip"], "a Send never skips on its own")

    // The reply's own thread read replaced the copy: the question is sent, the person's message is there.
    let after = try XCTUnwrap(session.thread(StandInData.retry)?.thread)
    XCTAssertEqual(after.messages.last?.author.kind, .person)
    XCTAssertEqual(after.messages.compactMap { $0.questions?.first?.state }, [.sent])
    XCTAssertEqual(session.list?.sections.first { $0.id == .sent }?.threads.map(\.threadId).contains(StandInData.retry), true)

    // Every write carried its own key.
    let writes = await door.calls.filter { $0.method == .post }
    let keys = writes.compactMap { body($0)["idempotency_key"]?.text }
    XCTAssertEqual(keys.count, writes.count)
    XCTAssertEqual(Set(keys).count, keys.count)
  }

  // proves: answer-11
  func testASkippedQuestionGoesAsItsOwnSavedAnswerAndAnOpenOneStaysOpen() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.checkout)
    let asked = try XCTUnwrap(session.thread(StandInData.checkout)?.thread.messages.last)
    let layouts = try XCTUnwrap(asked.questions?.first { $0.key == "q_layouts" })
    await session.pick(thread: StandInData.checkout, message: asked.id, question: layouts, answer: QuestionAnswers.skip(layouts, note: ""))
    await session.send(thread: StandInData.checkout, words: "")
    let states = try XCTUnwrap(session.thread(StandInData.checkout)?.thread.messages.first?.questions).map { "\($0.key):\($0.state.rawValue)" }
    XCTAssertEqual(states, ["q_layouts:sent", "q_button:open"])
    let reply = await door.posts("/reply")
    XCTAssertEqual(body(reply[0])["questions"]?.items.count, 1)
  }

  // proves: pair-08
  func testAnInboxThatNeedsANewerAppIsToldToThePersonAndNothingElseIsAsked() async throws {
    var options = StandInDoor.Options()
    options.minAppContract = wireContract + 1
    options.contract = wireContract + 1
    let door = StandInDoor(options: options)
    let session = await pairedSession(door: door)
    await session.start()
    XCTAssertEqual(session.standing, .appNeedsUpdate)
    XCTAssertNil(session.list)
    let paths = await door.calls.map(\.path)
    XCTAssertEqual(paths, ["health"], "below the floor the app asks health and nothing else")

    // And the 426 itself, should a call be made anyway, is read as the same thing.
    let client = DoorClient(transport: StandInTransport(door: door), token: session.computer.token, app: testApp)
    do {
      _ = try await client.threads()
      XCTFail("the door refuses an app below its floor")
    } catch let failure as DoorFailure {
      guard case .appNeedsUpdate(let floor) = failure else { return XCTFail("\(failure)") }
      XCTAssertEqual(floor, wireContract + 1)
    }
  }

  func testWhatTheDoorDoesNotListIsNotOfferedAndNeverCalled() async throws {
    var options = StandInDoor.Options()
    options.withoutRoutes = [DoorRoutes.postMessagePicks.name, DoorRoutes.postThreadSeen.name]
    let door = StandInDoor(options: options)
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    XCTAssertFalse(session.canAnswer())
    let asked = try XCTUnwrap(session.thread(StandInData.retry)?.thread.messages.last)
    let question = try XCTUnwrap(asked.questions?.first)
    await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Everyone at once"], note: ""))
    let posts = await door.calls.filter { $0.method == .post }
    XCTAssertEqual(posts.count, 0, "no POST meets a 404 that would be kept under its key")
    XCTAssertTrue(session.held.isEmpty)
  }

  func testAnInboxFromBeforeTheHandshakeStillWorks() async throws {
    var options = StandInDoor.Options()
    options.answersDoor = false
    let door = StandInDoor(options: options)
    let session = await pairedSession(door: door)
    await session.start()
    XCTAssertEqual(session.standing, .ok)
    XCTAssertEqual(session.list?.sections.count, 6)
    XCTAssertTrue(session.canAnswer())
  }

  func testAPickMadeWhileTheComputerIsAwayStaysPickedAndGoesOnceUnderOneKey() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("inbox-core-tests-\(UUID().uuidString)", isDirectory: true)
    let door = StandInDoor()
    let issued = await door.issueToken()
    let computer = PairedComputer(id: issued.device.rawValue, name: "Work Mac", token: issued.token, secret: "s", addresses: [])
    let connector: DoorConnector = { _ in [StandInTransport(door: door)] }
    var session = InboxSession(computer: computer, app: testApp, copy: LocalCopy(folder: folder), connector: connector)
    await session.start()
    await session.open(StandInData.retry)
    let asked = try XCTUnwrap(session.thread(StandInData.retry)?.thread.messages.last)
    let question = try XCTUnwrap(asked.questions?.first)

    await door.setOffline(true)
    await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))
    XCTAssertEqual(session.reach, .away)
    XCTAssertEqual(session.held.map(\.kind), [.pick])
    XCTAssertEqual(session.thread(StandInData.retry)?.thread.messages.last?.questions?.first?.state, .picked, "a held pick stays picked")
    let key = try XCTUnwrap(session.held.first?.id)

    // The app is closed and opened again: the copy and the held write are still there, under the same key.
    session.stop()
    session = InboxSession(computer: computer, app: testApp, copy: LocalCopy(folder: folder), connector: connector)
    await session.start()
    XCTAssertEqual(session.reach, .away)
    XCTAssertEqual(session.list?.sections.count, 6, "the list is readable from the copy while the computer is away")
    XCTAssertEqual(session.held.map(\.id), [key])

    await door.setOffline(false)
    await session.refresh()
    XCTAssertTrue(session.held.isEmpty)
    XCTAssertEqual(session.reach, .here)
    let stored = await door.thread(StandInData.retry)?.messages.last?.questions?.first
    XCTAssertEqual(stored?.answer?.selected, ["Staged, 10% first"])
    XCTAssertEqual(stored?.revision, 1, "applied once")
    let keys = await door.posts("/picks").compactMap { body($0)["idempotency_key"]?.text }
    XCTAssertEqual(Set(keys), [key], "every try of the pick carried the key it was made with")
    LocalCopy(folder: folder).erase()
  }

  func testAPhoneTheComputerRemovedIsToldSo() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    let client = DoorClient(transport: StandInTransport(door: door), token: session.computer.token, app: testApp)
    try await client.revoke()
    await session.refresh()
    XCTAssertEqual(session.standing, .removed)
    XCTAssertNil(session.list, "nothing of that computer stays on the phone")
  }

  // MARK: Held writes (review of #3694)

  private func retryThread(_ session: InboxSession) throws -> (InboxMessageWire, InboxQuestion) {
    let asked = try XCTUnwrap(session.thread(StandInData.retry)?.thread.messages.last { $0.author.kind == .agent })
    return (asked, try XCTUnwrap(asked.questions?.first))
  }

  func testAPickThenASendMadeWhileAwayBothArriveAndTheWordsAreNotLost() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    await door.setOffline(true)
    let (asked, question) = try retryThread(session)
    await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))
    let sent = await session.send(thread: StandInData.retry, words: "Go ahead")
    XCTAssertTrue(sent)
    XCTAssertEqual(session.held.map(\.kind), [.pick, .reply])
    XCTAssertTrue(session.hasHeldReply(StandInData.retry))

    await door.setOffline(false)
    await session.refresh()
    XCTAssertTrue(session.held.isEmpty)
    XCTAssertNil(session.notices[StandInData.retry])
    XCTAssertNil(session.returned[StandInData.retry])
    let stored = await door.thread(StandInData.retry)
    XCTAssertEqual(stored?.messages.last?.body, "Go ahead")
    XCTAssertEqual(stored?.messages.compactMap { $0.questions?.first }.map(\.state), [.sent])
    // The reply named the revision the held pick made, not the one the phone had when Send was pressed.
    let reply = await door.posts("/reply")
    XCTAssertEqual(body(reply[0])["questions"]?.items.first?["revision"], .number(1))
  }

  func testTwoPicksOnOneQuestionWhileAwayEndOnTheSecond() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    await door.setOffline(true)
    var (asked, question) = try retryThread(session)
    await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))
    (asked, question) = try retryThread(session)
    XCTAssertEqual(question.answer?.selected, ["Staged, 10% first"], "the held pick shows")
    await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Everyone at once"], note: ""))
    XCTAssertTrue(session.isHeldPick(message: asked.id, key: question.key))

    await door.setOffline(false)
    await session.refresh()
    XCTAssertTrue(session.held.isEmpty)
    XCTAssertNil(session.refusal(message: asked.id, key: question.key))
    let stored = await door.thread(StandInData.retry)?.messages.last?.questions?.first
    XCTAssertEqual(stored?.answer?.selected, ["Everyone at once"])
    XCTAssertEqual(stored?.revision, 2)
  }

  func testAWriteMadeWhileAnotherOfItsThreadIsOnItsWayIsSentRightAfterIt() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.checkout)
    let asked = try XCTUnwrap(session.thread(StandInData.checkout)?.thread.messages.last)
    let layouts = try XCTUnwrap(asked.questions?.first { $0.key == "q_layouts" })
    let button = try XCTUnwrap(asked.questions?.first { $0.key == "q_button" })
    // Two cards of one message, tapped one right after the other: both in the outbox before either is sent.
    session.hold(pick: QuestionAnswers.choice(layouts, selected: ["One page"], note: ""), thread: StandInData.checkout, message: asked.id, question: layouts)
    session.hold(pick: QuestionAnswers.text(button, text: "Pay now", note: ""), thread: StandInData.checkout, message: asked.id, question: button)
    async let first: Void = session.deliverHeld(thread: StandInData.checkout)
    async let second: Void = session.deliverHeld(thread: StandInData.checkout)
    _ = await (first, second)
    XCTAssertTrue(session.held.isEmpty, "nothing is stranded behind the first write")
    XCTAssertEqual(session.reach, .here)
    let stored = await door.thread(StandInData.checkout)?.messages.last?.questions
    XCTAssertEqual(stored?.map(\.state), [.picked, .picked])
  }

  func testWhatWaitsIsSentWhenTheComputerComesBackWithoutThePersonDoingAnything() async throws {
    let door = StandInDoor()
    let issued = await door.issueToken()
    let computer = PairedComputer(id: issued.device.rawValue, name: "Work Mac", token: issued.token, secret: "s", addresses: [])
    let session = InboxSession(computer: computer, app: testApp, retryEvery: .milliseconds(40)) { _ in [StandInTransport(door: door)] }
    await session.start()
    await session.open(StandInData.retry)
    await door.setOffline(true)
    let (asked, question) = try retryThread(session)
    await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))
    XCTAssertEqual(session.held.count, 1)
    await door.setOffline(false)
    for _ in 0..<100 where !session.held.isEmpty { try await Task.sleep(for: .milliseconds(20)) }
    XCTAssertTrue(session.held.isEmpty)
    XCTAssertEqual(session.reach, .here)
    session.stop()
  }

  func testARefusedSendGivesTheWordsBackAndSaysWhy() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    let (asked, question) = try retryThread(session)
    await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))
    // Another device moves the pick: the phone's copy of the question is now one revision behind.
    let now = try retryThread(session).1
    let other = DoorClient(transport: StandInTransport(door: door), token: session.computer.token, app: testApp)
    _ = try await other.picks(asked.id, body: QuestionAnswers.pickBody(key: now.key, revision: now.revision, answer: QuestionAnswers.choice(now, selected: ["Everyone at once"], note: ""), idempotencyKey: "other-device"))

    await session.send(thread: StandInData.retry, words: "Go ahead")
    // Why it was not sent is kept by its code; the screen says it in the app's own words, never the Inbox's.
    guard case .refused(_, code: "question_revision_conflict")? = session.notices[StandInData.retry] else { return XCTFail("the Send was refused because the answer changed elsewhere") }
    XCTAssertTrue(session.held.isEmpty)
    XCTAssertEqual(session.takeReturnedWords(StandInData.retry), "Go ahead")
    XCTAssertNil(session.takeReturnedWords(StandInData.retry), "handed back once")
    let stored = await door.thread(StandInData.retry)
    XCTAssertEqual(stored?.messages.last?.author.kind, .agent, "nothing was written")
    // The thread now shows what the computer has; a second Send goes.
    XCTAssertEqual(try retryThread(session).1.answer?.selected, ["Everyone at once"])
    await session.send(thread: StandInData.retry, words: "Go ahead")
    XCTAssertNil(session.notices[StandInData.retry])
    let after = await door.thread(StandInData.retry)
    XCTAssertEqual(after?.messages.last?.body, "Go ahead")
  }

  func testARefusalThatIsNotTheInboxsIsStillARefusalAndNeverBlocksTheThread() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.docs)
    await door.setOptions { $0.proxyRefusesReplies = 413 }
    await session.send(thread: StandInData.docs, words: "Thanks, merge it.")
    XCTAssertEqual(session.notices[StandInData.docs], .unreadable(status: 413))
    XCTAssertEqual(session.takeReturnedWords(StandInData.docs), "Thanks, merge it.")
    XCTAssertTrue(session.held.isEmpty, "it is not retried for ever")
    await door.setOptions { $0.proxyRefusesReplies = nil }
    await session.send(thread: StandInData.docs, words: "Thanks, merge it.")
    let stored = await door.thread(StandInData.docs)
    XCTAssertEqual(stored?.messages.last?.body, "Thanks, merge it.")
  }

  // MARK: Second review

  func testASecondSendWhileTheFirstWaitsCarriesOnlyItsOwnWords() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    await door.setOffline(true)
    let (asked, question) = try retryThread(session)
    await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))
    await session.send(thread: StandInData.retry, words: "Go ahead")
    // The card is settled while its answer waits in a Send: nothing more to pick, nothing to send twice.
    XCTAssertEqual(try retryThread(session).1.state, .sent)
    XCTAssertTrue(session.isHeldSend(message: asked.id, key: question.key))
    XCTAssertFalse(session.canSend(thread: StandInData.retry, words: ""))
    let second = await session.send(thread: StandInData.retry, words: "And tell me when it is done")
    XCTAssertTrue(second)

    await door.setOffline(false)
    await session.refresh()
    XCTAssertTrue(session.held.isEmpty)
    XCTAssertNil(session.notices[StandInData.retry])
    XCTAssertNil(session.returned[StandInData.retry])
    let replies = await door.posts("/reply")
    XCTAssertEqual(replies.map { body($0)["questions"]?.items.count }, [1, 0])
    let stored = await door.thread(StandInData.retry)
    XCTAssertEqual(stored?.messages.suffix(2).map(\.body), ["Go ahead", "And tell me when it is done"])
  }

  func testTheStandInRefusesWhatTheInboxRefuses() async throws {
    let door = StandInDoor()
    let issued = await door.issueToken()
    let client = DoorClient(transport: StandInTransport(door: door), token: issued.token, app: testApp)
    func code(_ work: () async throws -> Void) async -> String? {
      do { try await work() } catch let failure as DoorFailure {
        if case .refused(_, let error) = failure { return error.code }
      } catch {}
      return nil
    }
    let read = try await client.thread(StandInData.retry)
    let asked = try XCTUnwrap(read.thread.messages.last)
    let question = try XCTUnwrap(asked.questions?.first)
    let choice = QuestionAnswers.choice(question, selected: ["Everyone at once"], note: "")
    // A reply that names a question with nothing picked.
    var refused = await code { _ = try await client.reply(asked.id, body: DoorReplyBody(idempotencyKey: "r0", words: "x", questions: [DoorQuestionPick(key: question.key, revision: 0)])) }
    XCTAssertEqual(refused, "validation_error")
    _ = try await client.picks(asked.id, body: QuestionAnswers.pickBody(key: question.key, revision: 0, answer: choice, idempotencyKey: "p1"))
    _ = try await client.reply(asked.id, body: DoorReplyBody(idempotencyKey: "r1", words: "", questions: [DoorQuestionPick(key: question.key, revision: 1)]))
    // A second reply that names the question the first already sent: the whole reply is refused.
    refused = await code { _ = try await client.reply(asked.id, body: DoorReplyBody(idempotencyKey: "r2", words: "more words", questions: [DoorQuestionPick(key: question.key, revision: 1)])) }
    XCTAssertEqual(refused, "question_already_sent")
    // A pick that may not reopen a sent question.
    refused = await code { _ = try await client.picks(asked.id, body: QuestionAnswers.pickBody(key: question.key, revision: 1, answer: choice, unsentOnly: true, idempotencyKey: "p2")) }
    XCTAssertEqual(refused, "question_already_sent")
    // A reply with neither words nor an answer; a look with a seq that is no whole number.
    refused = await code { _ = try await client.reply(asked.id, body: DoorReplyBody(idempotencyKey: "r3", words: " ")) }
    XCTAssertEqual(refused, "validation_error")
    refused = await code { try await client.seen(StandInData.retry, throughSeq: -1, idempotencyKey: "s1") }
    XCTAssertEqual(refused, "validation_error")

    // An action item is not a question; a question a Mark read set aside; an archived thread.
    let onboarding = try await client.thread(StandInData.onboarding)
    let mixed = try XCTUnwrap(onboarding.thread.messages.last)
    let tone = try XCTUnwrap(mixed.questions?.first)
    refused = await code { _ = try await client.picks(mixed.id, body: QuestionAnswers.pickBody(key: "a-0a1b2c3d", revision: 0, answer: QuestionAnswers.choice(tone, selected: ["Plain"], note: ""), idempotencyKey: "p3")) }
    XCTAssertEqual(refused, "validation_error")
    await door.change(StandInData.onboarding) { $0.messages[0].questions?[0].setAsideAt = "2026-11-18T10:00:00.000Z" }
    refused = await code { _ = try await client.picks(mixed.id, body: QuestionAnswers.pickBody(key: tone.key, revision: 0, answer: QuestionAnswers.choice(tone, selected: ["Plain"], note: ""), idempotencyKey: "p4")) }
    XCTAssertEqual(refused, "question_set_aside")
    await door.change(StandInData.docs) { $0.resolvedAt = "2026-11-18T10:00:00.000Z" }
    refused = await code { _ = try await client.reply(MessageID(StandInData.docs.rawValue), body: DoorReplyBody(idempotencyKey: "r4", words: "thanks")) }
    XCTAssertEqual(refused, "thread_resolved")
  }

  func testWordsARefusalGaveBackSurviveARestart() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("inbox-core-tests-\(UUID().uuidString)", isDirectory: true)
    let door = StandInDoor()
    let issued = await door.issueToken()
    let computer = PairedComputer(id: issued.device.rawValue, name: "Work Mac", token: issued.token, secret: "s", addresses: [])
    let connector: DoorConnector = { _ in [StandInTransport(door: door)] }
    var session = InboxSession(computer: computer, app: testApp, copy: LocalCopy(folder: folder), connector: connector)
    await session.start()
    await session.open(StandInData.docs)
    await door.setOptions { $0.proxyRefusesReplies = 413 }
    await session.send(thread: StandInData.docs, words: "Thanks, merge it.")
    session.stop()
    // The app is closed before the thread is opened again.
    session = InboxSession(computer: computer, app: testApp, copy: LocalCopy(folder: folder), connector: connector)
    await session.start()
    XCTAssertEqual(session.notices[StandInData.docs], .unreadable(status: 413))
    XCTAssertEqual(session.takeReturnedWords(StandInData.docs), "Thanks, merge it.")
    session.stop()
    session = InboxSession(computer: computer, app: testApp, copy: LocalCopy(folder: folder), connector: connector)
    await session.start()
    XCTAssertNil(session.returned[StandInData.docs], "taken once, for good")
    LocalCopy(folder: folder).erase()
  }

  func testRemovingAComputerLeavesNothingOfItEvenWithAWriteOnItsWay() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("inbox-core-tests-\(UUID().uuidString)", isDirectory: true)
    let door = StandInDoor()
    let issued = await door.issueToken()
    let computer = PairedComputer(id: issued.device.rawValue, name: "Work Mac", token: issued.token, secret: "s", addresses: [])
    let session = InboxSession(computer: computer, app: testApp, copy: LocalCopy(folder: folder)) { _ in [StandInTransport(door: door)] }
    await session.start()
    await session.open(StandInData.retry)
    XCTAssertTrue(FileManager.default.fileExists(atPath: folder.path))
    let (asked, question) = try retryThread(session)
    // The pick reaches the computer, and its answer is held on the way back: a write still on its way.
    await door.holdPickAnswers()
    session.hold(pick: QuestionAnswers.choice(question, selected: ["Everyone at once"], note: ""), thread: StandInData.retry, message: asked.id, question: question)
    let write = Task { await session.deliverHeld(thread: StandInData.retry) }
    for _ in 0..<200 {
      if await door.posts("/picks").count == 1 { break }
      try await Task.sleep(for: .milliseconds(5))
    }
    let arrived = await door.posts("/picks").count
    XCTAssertEqual(arrived, 1)
    await session.removeThisPhone()
    XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
    // Now the answer comes back, after the removal: it must write nothing of that computer.
    await door.release()
    await write.value
    XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path), "a late answer brought the erased copy back")
    XCTAssertTrue(session.held.isEmpty)
  }

  func testA401ThatDoesNotSayThePhoneWasRemovedIsTriedAgainAndErasesNothing() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("inbox-core-tests-\(UUID().uuidString)", isDirectory: true)
    let door = StandInDoor()
    let issued = await door.issueToken()
    let computer = PairedComputer(id: issued.device.rawValue, name: "Work Mac", token: issued.token, secret: "s", addresses: [])
    let session = InboxSession(computer: computer, app: testApp, copy: LocalCopy(folder: folder)) { _ in [StandInTransport(door: door)] }
    await session.start()
    await session.open(StandInData.docs)
    // Something between the phone and the computer strips the token: the door answers 401 device_token_missing.
    await door.setOptions { $0.stripsToken = true }
    await session.send(thread: StandInData.docs, words: "Thanks, merge it.")
    XCTAssertEqual(session.standing, .ok, "not a removal")
    XCTAssertEqual(session.held.map(\.kind), [.reply], "the Send waits, with its key")
    XCTAssertNotNil(session.list)
    XCTAssertTrue(FileManager.default.fileExists(atPath: folder.path), "the copy is kept")
    await session.refresh()
    XCTAssertEqual(session.standing, .ok)
    await door.setOptions { $0.stripsToken = false }
    await session.refresh()
    XCTAssertTrue(session.held.isEmpty)
    let stored = await door.thread(StandInData.docs)
    XCTAssertEqual(stored?.messages.last?.body, "Thanks, merge it.")
    session.stop()
    LocalCopy(folder: folder).erase()
  }

  func testOnlyAConnectionThatWasNeverMadeMayBeTriedAgainWhenPairing() {
    // A pairing secret is redeemed once: the request is sent again only when it cannot have arrived.
    XCTAssertFalse(DoorFailure.mayHaveArrived(URLError(.cannotConnectToHost)))
    XCTAssertFalse(DoorFailure.mayHaveArrived(URLError(.notConnectedToInternet)))
    XCTAssertTrue(DoorFailure.mayHaveArrived(URLError(.timedOut)))
    XCTAssertTrue(DoorFailure.mayHaveArrived(URLError(.networkConnectionLost)))
  }

  func testATooManyRequestsAnswerIsTriedAgainNotGivenBack() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.docs)
    await door.setOptions { $0.proxyRefusesReplies = 429 }
    await session.send(thread: StandInData.docs, words: "Thanks, merge it.")
    XCTAssertEqual(session.held.map(\.kind), [.reply], "it waits, with its key")
    XCTAssertNil(session.returned[StandInData.docs])
    await door.setOptions { $0.proxyRefusesReplies = nil }
    await session.refresh()
    XCTAssertTrue(session.held.isEmpty)
    let stored = await door.thread(StandInData.docs)
    XCTAssertEqual(stored?.messages.last?.body, "Thanks, merge it.")
    session.stop()
  }

  func testWithNoWordsTheAgentThatAskedNothingGetsNoEmptyReply() async throws {
    // Two agents in one thread: the first asked, the second wrote last. Send with no words answers the first only.
    let door = StandInDoor()
    await door.change(StandInData.retry) { thread in
      var later = thread.messages[0]
      later.id = MessageID("msg_STANDINLATER")
      later.author = InboxAuthor(kind: .agent, host: "codex", session: "ses_other")
      later.questions = nil
      later.seq = 950
      later.body = "I am on the tests meanwhile."
      thread.messages.append(later)
    }
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    let asked = try XCTUnwrap(session.thread(StandInData.retry)?.thread.messages.first { $0.questions != nil })
    let question = try XCTUnwrap(asked.questions?.first)
    await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Everyone at once"], note: ""))
    await session.send(thread: StandInData.retry, words: "")
    XCTAssertNil(session.notices[StandInData.retry], "no reply was made that the Inbox refuses")
    var replies = await door.posts("/reply")
    XCTAssertEqual(replies.map(\.path), ["messages/\(asked.id.rawValue)/reply"])
    // With words, they go to the agent that wrote last.
    await session.send(thread: StandInData.retry, words: "Thanks both")
    replies = await door.posts("/reply")
    XCTAssertEqual(replies.last?.path, "messages/msg_STANDINLATER/reply")
    XCTAssertEqual(body(replies.last!)["words"], .string("Thanks both"))
  }
}
