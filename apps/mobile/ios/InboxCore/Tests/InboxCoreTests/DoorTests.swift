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
    XCTAssertEqual(sections.map(\.threads.count), [1, 1, 1, 1, 1, 1])
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
    XCTAssertEqual(read.model.sections.map(\.threads.count), [1, 1, 1, 1, 1, 1])
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
    XCTAssertNil(session.notices[StandInData.retry])

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

  func testARefusedPickShowsTheInboxsOwnWordsAndWhatTheComputerHasNow() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    let asked = try XCTUnwrap(session.thread(StandInData.retry)?.thread.messages.last)
    let question = try XCTUnwrap(asked.questions?.first)
    // Another device picked first: the phone's copy of the question is one revision behind.
    let other = DoorClient(transport: StandInTransport(door: door), token: session.computer.token, app: testApp)
    _ = try await other.picks(asked.id, body: QuestionAnswers.pickBody(key: question.key, revision: 0, answer: QuestionAnswers.choice(question, selected: ["Everyone at once"], note: ""), idempotencyKey: "other-device"))

    await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))
    XCTAssertEqual(session.notices[StandInData.retry], "This question changed. Read it again.")
    XCTAssertTrue(session.held.isEmpty, "a refusal is a definite answer: the key is spent")
    XCTAssertEqual(session.thread(StandInData.retry)?.thread.messages.last?.questions?.first?.answer?.selected, ["Everyone at once"], "the other device's pick shows")
  }

  func testAPhoneTheComputerRemovedIsToldSo() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    let client = DoorClient(transport: StandInTransport(door: door), token: session.computer.token, app: testApp)
    try await client.revoke()
    await session.refresh()
    XCTAssertEqual(session.standing, .removed)
  }
}
