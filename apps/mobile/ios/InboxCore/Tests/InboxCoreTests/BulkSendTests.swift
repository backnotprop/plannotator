import Foundation
import Observation
import XCTest
@testable import InboxCore
import InboxStandIn
import InboxWire

/// Sending an act on several rows: what happens when the computer stops answering partway, how often the outbox
/// is saved and the list redrawn, what a refused row does to the one Undo, and stopping the session meanwhile.
@MainActor
final class BulkSendTests: XCTestCase {
  private func folder() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("inbox-core-tests-\(UUID().uuidString)", isDirectory: true)
  }

  private func seeded(_ count: Int) async -> (StandInDoor, [ThreadID]) {
    let door = StandInDoor()
    let threads = StandInData.manyThreads(now: Date(), count: count)
    for thread in threads { await door.add(thread) }
    return (door, threads.map(\.threadId))
  }

  private func archived(_ door: StandInDoor, _ ids: [ThreadID]) async -> Int {
    var count = 0
    for id in ids where await door.rowState(id).resolvedAt != nil { count += 1 }
    return count
  }

  /// The computer goes away after a few writes of fifty: nothing more is tried (no probe per row left), the rest
  /// wait in the outbox, and they go when it is back.
  func testAComputerThatGoesAwayMidBatchIsNotAskedAgainRowByRow() async throws {
    let (door, ids) = await seeded(50)
    let copy = LocalCopy(folder: folder())
    let drop = DropAfter(door: door, writes: 5)
    let issued = await door.issueToken()
    let computer = PairedComputer(id: issued.device.rawValue, name: "Work Mac", token: issued.token, secret: "s", addresses: [])
    let session = InboxSession(computer: computer, app: testApp, copy: copy) { _ in [DroppingTransport(inner: StandInTransport(door: door), drop: drop)] }
    await session.start()
    await door.clearCalls()

    let outcome = session.holdMany(.archive, on: ids)
    await session.sendMany(outcome.made)

    XCTAssertEqual(session.reach, .away)
    let calls = await door.calls
    let probes = calls.filter { $0.path == "health" }.count
    XCTAssertEqual(probes, 0, "the computer is not asked again for each row left")
    let tried = calls.filter { $0.path.hasSuffix("/resolve") }.count
    let landed = await archived(door, ids)
    XCTAssertGreaterThanOrEqual(landed, 5)
    XCTAssertLessThan(landed, 50, "it went away partway")
    // Each sender meets the closed door at most once: then they all stop.
    XCTAssertLessThanOrEqual(tried - landed, InboxSession.atOnce, "tried \(tried - landed) writes after it went away")
    let waiting = session.held.filter { $0.kind == .state }
    XCTAssertEqual(waiting.count, 50 - landed, "the rest stay held")
    XCTAssertEqual(copy.outbox().filter { $0.kind == .state }.count, waiting.count, "and saved so")

    // Back: what waited goes.
    await door.setOffline(false)
    await session.refresh()
    let all = await archived(door, ids)
    XCTAssertEqual(all, 50)
    XCTAssertTrue(session.held.filter { $0.kind == .state }.isEmpty)
    session.stop()
  }

  /// Two hundred rows sent: the outbox is saved a bounded number of times (once when held, once when the batch
  /// ends), not once for each write that lands, and the list is redrawn a bounded number of times.
  func testTwoHundredRowsSaveTheOutboxAndRedrawTheListAFewTimes() async throws {
    let (door, ids) = await seeded(200)
    let saves = Counter()
    var copy = LocalCopy(folder: folder())
    copy.watch = { name, _ in if name == "outbox.json" { saves.add() } }
    let session = await pairedSession(door: door, copy: copy)
    await session.start()

    saves.reset()
    let outcome = session.holdMany(.archive, on: ids)
    XCTAssertEqual(saves.value, 1, "held with one save")
    let redraws = Redraws()
    redraws.watch(session)
    await session.sendMany(outcome.made)
    let archivedNow = await archived(door, ids)
    XCTAssertEqual(archivedNow, 200)
    XCTAssertTrue(session.held.filter { $0.kind == .state }.isEmpty)
    XCTAssertLessThanOrEqual(saves.value, 3, "saved \(saves.value) times for 200 rows")
    XCTAssertTrue(copy.outbox().filter { $0.kind == .state }.isEmpty, "the last save holds none of them")
    XCTAssertLessThanOrEqual(redraws.count, 6, "the list was redrawn \(redraws.count) times for 200 rows")
    // A single act still saves at once.
    saves.reset()
    session.holdAct(.unarchive, on: ids[0])
    XCTAssertEqual(saves.value, 1)
  }

  /// Three rows archived, one refused: the refused row leaves the one Undo, and Undo takes back only the two the
  /// computer took.
  func testARefusedRowLeavesTheOneUndoAndUndoSendsNoReverseOfIt() async throws {
    let door = StandInDoor()
    await door.setOptions { $0.proxyRefusesArchive = [StandInData.checkout.rawValue] }
    let session = await pairedSession(door: door)
    await session.start()
    let threads = [StandInData.retry, StandInData.checkout, StandInData.docs]

    let outcome = await session.actMany(.archive, on: threads)
    XCTAssertEqual(outcome.refused, [StandInData.checkout])
    XCTAssertEqual(Set(outcome.made), [StandInData.retry, StandInData.docs])
    let undo = try XCTUnwrap(session.bulkUndoOffer)
    XCTAssertEqual(undo.count, 2, "the refused row is not in the Undo")
    XCTAssertEqual(undo.threads, Set(threads), "the toast still knows every row it was made on")

    await door.clearCalls()
    let undone = await session.undoMany(try XCTUnwrap(outcome.undo))
    XCTAssertTrue(undone)
    let sent = await door.posts("/resolve")
    XCTAssertEqual(Set(sent.map(\.path)), ["messages/\(StandInData.retry.rawValue)/resolve", "messages/\(StandInData.docs.rawValue)/resolve"])
    for thread in [StandInData.retry, StandInData.docs] {
      let kept = await door.rowState(thread)
      XCTAssertNil(kept.resolvedAt)
    }
  }

  /// The session stops while a batch is on its way: the senders end after the writes already sent, and the rest
  /// wait in the outbox.
  func testStoppingTheSessionEndsTheSendersOfABatch() async throws {
    let (door, ids) = await seeded(20)
    let gate = Gate()
    let session = await pairedSession(door: door, gate: gate)
    await session.start()
    await door.clearCalls()
    await gate.stop { $0.method == .post && $0.path.hasSuffix("/resolve") }

    let outcome = session.holdMany(.archive, on: ids)
    let sending = Task { await session.sendMany(outcome.made) }
    await gate.reached()
    session.stop()
    await gate.open()
    await sending.value

    let tried = await door.posts("/resolve").count
    XCTAssertLessThanOrEqual(tried, InboxSession.atOnce, "no sender went on after stop: \(tried)")
    XCTAssertEqual(session.held.filter { $0.kind == .state }.count, 20 - tried)
  }
}

/// Counts what a `@Sendable` closure is told.
final class Counter: @unchecked Sendable {
  private let lock = NSLock()
  private var n = 0
  func add() { lock.withLock { n += 1 } }
  func reset() { lock.withLock { n = 0 } }
  var value: Int { lock.withLock { n } }
}

/// How many times what draws the list would draw again: each change is counted once and watched again on the
/// next turn, as a screen draws once per change it sees.
@MainActor
final class Redraws {
  var count = 0
  func watch(_ session: InboxSession) {
    withObservationTracking {
      _ = session.listView()
      _ = session.held
    } onChange: {
      Task { @MainActor [weak self] in
        guard let self else { return }
        self.count += 1
        self.watch(session)
      }
    }
  }
}

/// Takes the computer away after so many archive writes landed.
actor DropAfter {
  let door: StandInDoor
  private var left: Int
  init(door: StandInDoor, writes: Int) {
    self.door = door
    left = writes
  }
  func passed(_ call: DoorCall, _ answer: DoorAnswerBytes) async {
    guard call.method == .post, call.path.hasSuffix("/resolve"), answer.status == 200, left > 0 else { return }
    left -= 1
    if left == 0 { await door.setOffline(true) }
  }
}

struct DroppingTransport: DoorTransport {
  let inner: StandInTransport
  let drop: DropAfter
  func send(_ call: DoorCall) async throws -> DoorAnswerBytes {
    let answer = try await inner.send(call)
    await drop.passed(call, answer)
    return answer
  }
  func events(_ call: DoorCall) async throws -> AsyncThrowingStream<Data, Error>? { try await inner.events(call) }
}
