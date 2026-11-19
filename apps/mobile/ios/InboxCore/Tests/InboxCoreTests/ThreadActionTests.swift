import Foundation
import XCTest
@testable import InboxCore
import InboxStandIn
import InboxWire

/// Thread and row actions: drawn at once, held while the computer is away, given way to a newer change made
/// elsewhere, refused aloud, undone as the window undoes them.
@MainActor
final class ThreadActionTests: XCTestCase {
  private func folder() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("inbox-core-tests-\(UUID().uuidString)", isDirectory: true)
  }

  private func soon(_ seconds: TimeInterval) -> String { SnoozeRules.iso(Date().addingTimeInterval(seconds)) }

  func testArchiveIsDrawnAtOnceSentAndListedInArchived() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    let thread = StandInData.docs
    XCTAssertNotNil(session.listView()?.group(of: thread))

    let outcome = await session.act(.archive, on: thread)
    XCTAssertEqual(outcome, .done)
    let sent = await door.posts("/resolve")
    XCTAssertEqual(sent.count, 1)
    XCTAssertEqual(sent.first?.path, "messages/\(thread.rawValue)/resolve")
    XCTAssertEqual(body(sent[0])["resolved"], .bool(true))
    let view = try XCTUnwrap(session.listView())
    XCTAssertNil(view.groups.first { $0.threads.contains { $0.threadId == thread } }, "out of the list")
    XCTAssertEqual(view.group(of: thread), .archived)
    XCTAssertTrue(session.archivedRows().contains { $0.threadId == thread })
    let kept = await door.rowState(thread)
    XCTAssertNotNil(kept.resolvedAt)
    XCTAssertEqual(session.undoOffer?.kind, .archived)

    await session.readArchived()
    XCTAssertEqual(session.archivedRows().map(\.threadId), [thread])
    let asked = await door.calls.last { $0.path == "threads/archived" }
    XCTAssertEqual(asked?.query.first { $0.name == "limit" }?.value, "20")
  }

  func testActsWaitWhileTheComputerIsAwaySurviveARelaunchAndGoInOrder() async throws {
    let door = StandInDoor()
    let copy = LocalCopy(folder: folder())
    var session = await pairedSession(door: door, copy: copy)
    await session.start()
    await door.setOffline(true)
    let thread = StandInData.bumps
    let until = soon(3 * 3600)

    let outcome1 = await session.act(.star, on: thread)
    XCTAssertEqual(outcome1, .waits)
    let outcome2 = await session.act(.snooze(until: until, at: nil), on: thread)
    XCTAssertEqual(outcome2, .waits)
    XCTAssertEqual(session.held.filter { $0.kind == .state }.count, 2)
    // Drawn while they wait: starred, and in the Snoozed band.
    var view = try XCTUnwrap(session.listView())
    XCTAssertTrue(view.pins.contains { $0.threadId == thread })
    XCTAssertEqual(view.group(of: thread), .snoozed)

    // The app is closed and opened again: the acts are still on the phone, and still drawn.
    session.stop()
    session = await pairedSession(door: door, copy: copy)
    await session.start()
    XCTAssertEqual(session.held.filter { $0.kind == .state }.map(\.act), [.star, .snooze(until: until, at: nil)])
    view = try XCTUnwrap(session.listView())
    XCTAssertEqual(view.group(of: thread), .snoozed)

    // Calls tried while it was away do not count.
    await door.clearCalls()
    await door.setOffline(false)
    await session.refresh()
    XCTAssertTrue(session.held.isEmpty)
    let pins = await door.posts("/pin"), snoozes = await door.posts("/snooze")
    XCTAssertEqual(pins.count, 1)
    XCTAssertEqual(snoozes.count, 1)
    let order = await door.calls.filter { $0.method == .post }.map(\.path)
    XCTAssertLessThan(try XCTUnwrap(order.firstIndex { $0.hasSuffix("/pin") }), try XCTUnwrap(order.firstIndex { $0.hasSuffix("/snooze") }))
    let kept = await door.rowState(thread)
    XCTAssertNotNil(kept.pinnedAt)
    XCTAssertEqual(kept.snoozed?.until, until)
    XCTAssertEqual(session.listView()?.group(of: thread), .snoozed, "the computer's own row now")
  }

  func testAWaitedActGivesWayToANewerChangeMadeElsewhere() async throws {
    let door = StandInDoor()
    let thread = StandInData.bumps
    await door.changeState(thread) { $0.pinnedAt = "2026-11-01T09:00:00.000Z" }
    let session = await pairedSession(door: door)
    await session.start()
    await door.setOffline(true)
    let outcome3 = await session.act(.unstar, on: thread)
    XCTAssertEqual(outcome3, .waits)
    XCTAssertFalse(session.listView()!.pins.contains { $0.threadId == thread })

    // Meanwhile the window starred it again, after the tap.
    let later = SnoozeRules.iso(Date().addingTimeInterval(5))
    await door.changeState(thread) { $0.pinnedAt = later }
    // Calls tried while it was away do not count.
    await door.clearCalls()
    await door.setOffline(false)
    await session.refresh()

    let unstars = await door.posts("/pin")
    XCTAssertTrue(unstars.isEmpty, "never sent over the newer star")
    XCTAssertTrue(session.held.isEmpty)
    XCTAssertEqual(session.actionNotice(thread), .gaveWay)
    XCTAssertTrue(session.listView()!.pins.contains { $0.threadId == thread })
  }

  func testAWaitedActTheComputerAlreadyShowsIsNotSent() async throws {
    let door = StandInDoor()
    let thread = StandInData.docs
    let session = await pairedSession(door: door)
    await session.start()
    await door.setOffline(true)
    let outcome4 = await session.act(.archive, on: thread)
    XCTAssertEqual(outcome4, .waits)
    await door.changeState(thread) { $0.resolvedAt = SnoozeRules.iso(Date()) }
    // Calls tried while it was away do not count.
    await door.clearCalls()
    await door.setOffline(false)
    await session.refresh()
    let resolves = await door.posts("/resolve")
    XCTAssertTrue(resolves.isEmpty)
    XCTAssertTrue(session.held.isEmpty)
    XCTAssertNil(session.actionNotice(thread))
  }

  func testUndoBeforeTheActLeavesThePhoneSendsNothing() async throws {
    let door = StandInDoor()
    let thread = StandInData.docs
    let session = await pairedSession(door: door)
    await session.start()
    await door.setOffline(true)
    await session.act(.archive, on: thread)
    let offer = try XCTUnwrap(session.undoOffer)
    let undone = await session.undo(offer)
    XCTAssertTrue(undone)
    XCTAssertTrue(session.held.isEmpty)
    XCTAssertNotEqual(session.listView()?.group(of: thread), .archived)
    // Calls tried while it was away do not count.
    await door.clearCalls()
    await door.setOffline(false)
    await session.refresh()
    let resolves = await door.posts("/resolve")
    XCTAssertTrue(resolves.isEmpty)
  }

  func testUndoOfArchivePutsBackTheThreadItsSnoozeAndItsPriority() async throws {
    let door = StandInDoor()
    let thread = StandInData.bumps
    let until = soon(6 * 3600)
    await door.changeState(thread) {
      $0.snoozed = InboxRowSnooze(until: until, at: "2026-11-18T08:00:00.000Z")
      $0.priority = InboxRowPriority(person: true, at: "2026-11-18T07:00:00.000Z")
    }
    let session = await pairedSession(door: door)
    await session.start()
    await session.act(.archive, on: thread)
    var kept = await door.rowState(thread)
    XCTAssertNotNil(kept.resolvedAt)
    XCTAssertNil(kept.snoozed, "an archive ends the snooze")
    XCTAssertNil(kept.priority, "and the priority")

    let offer = try XCTUnwrap(session.undoOffer)
    XCTAssertEqual(offer.kind, .archived)
    let undone = await session.undo(offer)
    XCTAssertTrue(undone)
    kept = await door.rowState(thread)
    XCTAssertNil(kept.resolvedAt)
    XCTAssertEqual(kept.snoozed, InboxRowSnooze(until: until, at: "2026-11-18T08:00:00.000Z"), "the snooze back, with its own time")
    XCTAssertEqual(kept.priority?.at, "2026-11-18T07:00:00.000Z")
    let resolves = await door.posts("/resolve")
    XCTAssertEqual(resolves.map { body($0)["resolved"] }, [.bool(true), .bool(false)])
  }

  func testUndoIsOfferedForSevenSecondsAndOnlyForTheLastAct() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.act(.read, on: StandInData.docs)
    let first = try XCTUnwrap(session.undoOffer)
    XCTAssertEqual(first.expires.timeIntervalSince(Date()), 7, accuracy: 1)
    let undone = await session.undo(first, now: first.expires.addingTimeInterval(0.1))
    XCTAssertFalse(undone, "past its seven seconds")
    await session.act(.archive, on: StandInData.bumps)
    let replaced = await session.undo(first)
    XCTAssertFalse(replaced, "another act replaced it")
    // Star has no Undo in the window: it offers none, and leaves the one on offer.
    await session.act(.star, on: StandInData.billing)
    XCTAssertEqual(session.undoOffer?.kind, .archived)
  }

  func testMarkUnreadsUndoMarksSeenThroughTheSeqItAnswered() async throws {
    let door = StandInDoor()
    let thread = StandInData.bumps
    let session = await pairedSession(door: door)
    await session.start()
    await session.act(.markUnread, on: thread)
    let offer = try XCTUnwrap(session.undoOffer)
    XCTAssertEqual(offer.kind, .markedUnread)
    let undone = await session.undo(offer)
    XCTAssertTrue(undone)
    let seen = await door.posts("/seen").last
    XCTAssertNotNil(body(try XCTUnwrap(seen))["through_seq"]?.whole)
  }

  func testPrioritysUndoPutsBackWhatTheWriteFound() async throws {
    let door = StandInDoor()
    let thread = StandInData.bumps
    await door.changeState(thread) { $0.priorityOffAt = "2026-11-17T10:00:00.000Z" }
    let session = await pairedSession(door: door)
    await session.start()
    await session.act(.priority(true), on: thread)
    XCTAssertEqual(session.listView()?.group(of: thread), .priority)
    let offer = try XCTUnwrap(session.undoOffer)
    XCTAssertEqual(offer.kind, .priorityAdded)
    let undone = await session.undo(offer)
    XCTAssertTrue(undone)
    let priorities = await door.posts("/priority")
    let last = try XCTUnwrap(priorities.last)
    XCTAssertEqual(body(last)["restore"]?["off_at"]?.text, "2026-11-17T10:00:00.000Z")
    XCTAssertEqual(body(last)["restore"]?["at"], .null)
    let kept = await door.rowState(thread)
    XCTAssertNil(kept.priority)
    XCTAssertEqual(kept.priorityOffAt, "2026-11-17T10:00:00.000Z")
  }

  func testUnstarsUndoPutsTheStarBackInItsPlace() async throws {
    let door = StandInDoor()
    for (index, thread) in [StandInData.billing, StandInData.bumps, StandInData.docs].enumerated() {
      await door.changeState(thread) { $0.pinnedAt = "2026-11-1\(index)T09:00:00.000Z" }
    }
    let session = await pairedSession(door: door)
    await session.start()
    await session.act(.unstar, on: StandInData.bumps)
    XCTAssertEqual(session.listView()?.pins.map(\.threadId), [StandInData.billing, StandInData.docs])
    let offer = try XCTUnwrap(session.undoOffer)
    let undone = await session.undo(offer)
    XCTAssertTrue(undone)
    let pins = await door.pins
    XCTAssertEqual(pins, [StandInData.billing, StandInData.bumps, StandInData.docs])
    let restores = await door.posts("pins")
    let restore = try XCTUnwrap(restores.last)
    XCTAssertEqual(body(restore)["restore"]?["index"]?.whole, 1)
    XCTAssertEqual(body(restore)["restore"]?["pinned_at"]?.text, "2026-11-11T09:00:00.000Z")
  }

  func testAnActTheComputerRefusesIsToldAndTheRowGoesBack() async throws {
    let door = StandInDoor()
    let thread = StandInData.bumps
    await door.changeState(thread) { $0.resolvedAt = "2026-11-17T09:00:00.000Z" }
    let session = await pairedSession(door: door)
    await session.start()
    let outcome = await session.act(.snooze(until: soon(3600), at: nil), on: thread)
    XCTAssertEqual(outcome, .refused)
    XCTAssertEqual(session.actionNotice(thread), .refused("This thread is archived; unarchive it first.", code: "thread_resolved"))
    XCTAssertNil(session.row(thread)?.snoozed)
    XCTAssertTrue(session.held.isEmpty)
    XCTAssertNil(session.undoOffer)
  }

  func testAnInboxThatDoesNotListTheRouteIsNeverCalled() async throws {
    var options = StandInDoor.Options()
    options.withoutRoutes = ["POST threads/:id/snooze"]
    let door = StandInDoor(options: options)
    let session = await pairedSession(door: door)
    await session.start()
    XCTAssertFalse(session.canAct(.unsnooze))
    let outcome5 = await session.act(.snooze(until: soon(3600), at: nil), on: StandInData.bumps)
    XCTAssertEqual(outcome5, .notOffered)
    let snoozes = await door.posts("/snooze")
    XCTAssertTrue(snoozes.isEmpty)
    XCTAssertTrue(session.held.isEmpty)
  }

  func testASnoozeEndsWhileTheAppIsOpen() async throws {
    let door = StandInDoor()
    let thread = StandInData.bumps
    let session = await pairedSession(door: door)
    await session.start()
    await session.act(.snooze(until: soon(0.6), at: nil), on: thread)
    XCTAssertEqual(session.listView()?.group(of: thread), .snoozed)
    let reads = await door.calls.filter { $0.path == "threads" }.count
    try await Task.sleep(for: .milliseconds(1200))
    // Its time is over: back in its own section, bold, and the list was read again.
    let view = try XCTUnwrap(session.listView())
    XCTAssertNotEqual(view.group(of: thread), .snoozed)
    XCTAssertEqual(view.row(thread)?.unread, true)
    XCTAssertNotNil(view.row(thread)?.snoozeBack)
    let after = await door.calls.filter { $0.path == "threads" }.count
    XCTAssertGreaterThan(after, reads)
    session.stop()
  }

  func testASnoozeThatEndedWhileTheAppWasClosedIsBackWhenItOpens() async throws {
    let door = StandInDoor()
    let thread = StandInData.bumps
    let copy = LocalCopy(folder: folder())
    var session = await pairedSession(door: door, copy: copy)
    await session.start()
    await session.act(.snooze(until: soon(3600), at: nil), on: thread)
    XCTAssertEqual(session.listView()?.group(of: thread), .snoozed)
    session.stop()

    // Opened again two hours later, with the computer away: drawn from the copy, by the phone's clock.
    await door.setOffline(true)
    session = await pairedSession(door: door, copy: copy)
    await session.start()
    let later = Date().addingTimeInterval(2 * 3600)
    let view = try XCTUnwrap(session.listView(now: later))
    XCTAssertNotEqual(view.group(of: thread), .snoozed)
    XCTAssertEqual(view.row(thread)?.unread, true)
    XCTAssertEqual(session.listView(now: Date())?.group(of: thread), .snoozed, "and still snoozed now")
  }

  func testStateConflictRules() throws {
    let tap = try XCTUnwrap(SnoozeRules.date("2026-11-18T12:00:00.000Z"))
    var row = try Contract.json("fixtures/rows.json").at("rows").items[13].without("note").decoded(InboxListRow.self)
    row.pinnedAt = nil
    XCTAssertEqual(StateConflict.decide(.star, row: row, tapped: tap), .send)
    XCTAssertEqual(StateConflict.decide(.unstar, row: row, tapped: tap), .already)
    row.pinnedAt = "2026-11-18T11:00:00.000Z"
    XCTAssertEqual(StateConflict.decide(.unstar, row: row, tapped: tap), .send, "starred before the tap")
    row.pinnedAt = "2026-11-18T12:00:01.000Z"
    XCTAssertEqual(StateConflict.decide(.unstar, row: row, tapped: tap), .giveWay, "starred again after it")
    row.snoozed = InboxRowSnooze(until: "2026-11-20T08:00:00.000Z", at: "2026-11-18T12:30:00.000Z")
    XCTAssertEqual(StateConflict.decide(.snooze(until: "2026-11-19T08:00:00.000Z", at: nil), row: row, tapped: tap), .giveWay)
    XCTAssertEqual(StateConflict.decide(.snooze(until: "2026-11-20T08:00:00.000Z", at: nil), row: row, tapped: tap), .already)
    XCTAssertEqual(StateConflict.decide(.unsnooze, row: row, tapped: tap), .giveWay)
    row.resolvedAt = "2026-11-18T12:10:00.000Z"
    XCTAssertEqual(StateConflict.decide(.archive, row: row, tapped: tap), .already)
    XCTAssertEqual(StateConflict.decide(.unarchive, row: row, tapped: tap), .giveWay, "archived elsewhere after the tap")
    // Mark read never closes questions an agent asked after the person looked.
    row.resolvedAt = nil
    row.lastAuthor = .agent
    row.lastAgentAt = "2026-11-18T12:05:00.000Z"
    XCTAssertEqual(StateConflict.decide(.read, row: row, tapped: tap), .giveWay)
    row.lastAgentAt = "2026-11-18T11:05:00.000Z"
    XCTAssertEqual(StateConflict.decide(.read, row: row, tapped: tap), .send)
    XCTAssertEqual(StateConflict.decide(.archive, row: nil, tapped: tap), .send, "a thread the list lacks: the computer answers")
  }
}
