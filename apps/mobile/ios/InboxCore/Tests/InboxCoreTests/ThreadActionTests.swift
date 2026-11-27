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

  func testOppositeActsThatWaitedEndAsTappedLast() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await door.setOffline(true)
    let archived = StandInData.docs, starred = StandInData.bumps
    // Archived, then unarchived from Archived; starred, then unstarred: all while the computer was away.
    await session.act(.archive, on: archived)
    await session.act(.unarchive, on: archived)
    await session.act(.star, on: starred)
    await session.act(.unstar, on: starred)
    await door.clearCalls()
    await door.setOffline(false)
    await session.refresh()

    XCTAssertTrue(session.held.isEmpty)
    let archive = await door.rowState(archived), star = await door.rowState(starred)
    XCTAssertNil(archive.resolvedAt, "unarchived, as tapped last")
    XCTAssertNil(star.pinnedAt, "unstarred, as tapped last")
    XCTAssertNotEqual(session.listView()?.group(of: archived), .archived)
    XCTAssertFalse(session.listView()!.pins.contains { $0.threadId == starred })
    XCTAssertNil(session.actionNotice(archived))
    XCTAssertNil(session.actionNotice(starred))
  }

  func testUndoWhileAWaitedActIsCheckedSendsNothing() async throws {
    let door = StandInDoor()
    let gate = Gate()
    let thread = StandInData.docs
    let session = await pairedSession(door: door, gate: gate)
    await session.start()
    await door.setOffline(true)
    await session.act(.archive, on: thread)
    let offer = try XCTUnwrap(session.undoOffer)
    await door.clearCalls()
    await door.setOffline(false)
    // The computer answers again; the list the waited archive is checked against is on its way.
    await gate.stop { $0.method == .get && $0.path == "threads" }
    let back = Task { @MainActor in await session.refresh() }
    await gate.reached()
    let undone = await session.undo(offer)
    XCTAssertTrue(undone)
    await gate.open()
    await back.value

    let resolves = await door.posts("/resolve")
    XCTAssertTrue(resolves.isEmpty, "taken back: never sent")
    let kept = await door.rowState(thread)
    XCTAssertNil(kept.resolvedAt)
    XCTAssertNotEqual(session.listView()?.group(of: thread), .archived)
  }

  func testUndoOfAnActWhoseAnswerWasLostEndsAsTheComputerHadItBefore() async throws {
    let door = StandInDoor()
    let gate = Gate()
    let session = await pairedSession(door: door, gate: gate)
    await session.start()
    let resolve: @Sendable (DoorCall) -> Bool = { $0.method == .post && $0.path.hasSuffix("/resolve") }

    // The computer took the archive, and the connection went before its answer came.
    let took = StandInData.docs
    await gate.lose(resolve, arrives: true)
    await session.act(.archive, on: took)
    var kept = await door.rowState(took)
    XCTAssertNotNil(kept.resolvedAt)
    var undone = await session.undo(try XCTUnwrap(session.undoOffer))
    XCTAssertTrue(undone)
    kept = await door.rowState(took)
    XCTAssertNil(kept.resolvedAt, "the archive the computer took is taken back")
    XCTAssertTrue(session.held.isEmpty)

    // The connection went before the archive reached the computer: nothing to take back, and nothing more is sent.
    let lost = StandInData.bumps
    await gate.lose(resolve, arrives: false)
    await session.act(.archive, on: lost)
    await door.clearCalls()
    undone = await session.undo(try XCTUnwrap(session.undoOffer))
    XCTAssertTrue(undone)
    let resolves = await door.posts("/resolve")
    XCTAssertTrue(resolves.isEmpty)
    kept = await door.rowState(lost)
    XCTAssertNil(kept.resolvedAt)
    XCTAssertTrue(session.held.isEmpty)
    XCTAssertNotEqual(session.listView()?.group(of: lost), .archived)
  }

  func testUndoWhileAWaitedActIsCheckedSaysNothingGaveWay() async throws {
    let door = StandInDoor()
    let gate = Gate()
    let thread = StandInData.docs
    let session = await pairedSession(door: door, gate: gate)
    await session.start()
    await door.setOffline(true)
    await session.act(.archive, on: thread)
    let offer = try XCTUnwrap(session.undoOffer)
    // An agent wrote meanwhile: the archive would give way, but the person takes it back first.
    await door.agentWrites(thread: thread, body: "One more thing before you go.")
    await door.clearCalls()
    await door.setOffline(false)
    await gate.stop { $0.method == .get && $0.path == "threads" }
    let back = Task { @MainActor in await session.refresh() }
    await gate.reached()
    let undone = await session.undo(offer)
    XCTAssertTrue(undone)
    await gate.open()
    await back.value

    XCTAssertNil(session.actionNotice(thread), "taken back, so nothing gave way")
    let resolves = await door.posts("/resolve")
    XCTAssertTrue(resolves.isEmpty)
  }

  func testUndoOfAnActWhoseAnswerWasLostNeverLeavesTheOutboxWithNeither() async throws {
    let door = StandInDoor()
    let gate = Gate()
    let thread = StandInData.docs
    let outboxes = Outboxes()
    var copy = LocalCopy(folder: folder())
    copy.watch = { name, data in
      if name == "outbox.json", let writes = try? JSONDecoder().decode([HeldWrite].self, from: data) { outboxes.add(writes) }
    }
    let session = await pairedSession(door: door, copy: copy, gate: gate)
    await session.start()
    await gate.lose({ $0.method == .post && $0.path.hasSuffix("/resolve") }, arrives: true)
    await session.act(.archive, on: thread)
    let offer = try XCTUnwrap(session.undoOffer)
    outboxes.clear()
    let undone = await session.undo(offer)
    XCTAssertTrue(undone)
    // The phone could stop between any two writes of its outbox: the first one Undo makes already holds the reverse.
    let first = try XCTUnwrap(outboxes.all.first)
    XCTAssertTrue(first.contains { $0.act == .unarchive }, "the reverse is kept before the archive is let go")
    let kept = await door.rowState(thread)
    XCTAssertNil(kept.resolvedAt)
  }

  func testUndoOfALostArchiveThatNeverArrivedSendsNoneOfItsReverses() async throws {
    let door = StandInDoor()
    let gate = Gate()
    let thread = StandInData.bumps
    await door.changeState(thread) { $0.priority = InboxRowPriority(person: true, at: "2026-11-18T07:00:00.000Z") }
    let session = await pairedSession(door: door, gate: gate)
    await session.start()
    await gate.lose({ $0.method == .post && $0.path.hasSuffix("/resolve") }, arrives: false)
    await session.act(.archive, on: thread)
    // Meanwhile Priority was turned off in the window.
    await door.changeState(thread) { $0.priority = nil }
    await door.clearCalls()
    let undone = await session.undo(try XCTUnwrap(session.undoOffer))
    XCTAssertTrue(undone)

    let priorities = await door.posts("/priority"), resolves = await door.posts("/resolve")
    XCTAssertTrue(priorities.isEmpty, "the archive never arrived: its Priority is not put back over the window's change")
    XCTAssertTrue(resolves.isEmpty)
    let kept = await door.rowState(thread)
    XCTAssertNil(kept.priority)
    XCTAssertTrue(session.held.isEmpty)
  }

  func testAWaitedActIsJudgedByTheComputersStampsNotThePhonesClock() async throws {
    let door = StandInDoor()
    let starred = StandInData.bumps, archived = StandInData.billing
    await door.changeState(starred) { $0.pinnedAt = "2026-11-01T09:00:00.000Z" }
    // The computer's clock runs an hour ahead of the phone's.
    let ahead = SnoozeRules.iso(Date().addingTimeInterval(3600))
    await door.changeState(archived) { $0.resolvedAt = ahead }
    let session = await pairedSession(door: door)
    await session.start()
    await door.setOffline(true)
    await session.act(.unstar, on: starred)
    await session.act(.unarchive, on: archived)
    // Meanwhile the window starred it again, stamped by a clock behind the phone's.
    await door.changeState(starred) { $0.pinnedAt = "2026-11-02T09:00:00.000Z" }
    await door.clearCalls()
    await door.setOffline(false)
    await session.refresh()

    let star = await door.rowState(starred), archive = await door.rowState(archived)
    XCTAssertEqual(star.pinnedAt, "2026-11-02T09:00:00.000Z", "never sent over the newer star")
    XCTAssertEqual(session.actionNotice(starred), .gaveWay)
    XCTAssertNil(archive.resolvedAt, "nothing changed it after the tap: the unarchive goes")
    XCTAssertNil(session.actionNotice(archived))
  }

  func testAWaitedArchiveGivesWayToAnAgentThatWroteAfterTheTap() async throws {
    let door = StandInDoor()
    let thread = StandInData.docs
    let session = await pairedSession(door: door)
    await session.start()
    await door.setOffline(true)
    await session.act(.archive, on: thread)
    await door.agentWrites(thread: thread, body: "One more thing before you go.")
    await door.clearCalls()
    await door.setOffline(false)
    await session.refresh()

    let resolves = await door.posts("/resolve")
    XCTAssertTrue(resolves.isEmpty, "never buried in Archived")
    XCTAssertEqual(session.actionNotice(thread), .gaveWay)
    XCTAssertTrue(session.held.isEmpty)
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
    let clock = HandClock(Date())
    let issued = await door.issueToken()
    let computer = PairedComputer(id: issued.device.rawValue, name: "Work Mac", token: issued.token, secret: "s", addresses: [])
    let session = InboxSession(computer: computer, app: testApp, clock: clock.sessionClock) { _ in [StandInTransport(door: door)] }
    await session.start()
    await session.act(.snooze(until: SnoozeRules.iso(clock.now.addingTimeInterval(3600)), at: nil), on: thread)
    XCTAssertEqual(session.listView()?.group(of: thread), .snoozed)
    let reads = await door.calls.filter { $0.path == "threads" }.count
    let wake = try XCTUnwrap(session.book.wake, "a timer waits for the snooze's end")

    // The timer's task must be asleep on the clock before the clock moves: moved first, it would sleep from the new
    // time and never wake (the test then hung, now and then).
    while clock.sleepers == 0 { await Task.yield() }
    clock.move(by: 3601)
    await wake.value
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
    var row = try Contract.json("fixtures/rows.json").at("rows").items[13].without("note").decoded(InboxListRow.self)
    row.pinnedAt = nil
    row.snoozed = nil
    row.resolvedAt = nil
    row.lastAgentAt = nil
    row.lastAuthor = .person
    row.readAt = nil
    let unstarred = ShownState(shown: row, computer: row)
    XCTAssertEqual(StateConflict.decide(.star, shown: unstarred, row: row), .send)
    XCTAssertEqual(StateConflict.decide(.unstar, shown: unstarred, row: row), .already)

    // Starred at the tap: the computer's star still the one the person saw, or a newer one.
    var starred = row
    starred.pinnedAt = "2026-11-18T11:00:00.000Z"
    let seenStar = ShownState(shown: starred, computer: starred)
    XCTAssertEqual(StateConflict.decide(.unstar, shown: seenStar, row: starred), .send, "the star the person saw")
    var restarred = starred
    restarred.pinnedAt = "2026-11-18T10:00:00.000Z"
    XCTAssertEqual(StateConflict.decide(.unstar, shown: seenStar, row: restarred), .giveWay, "starred again elsewhere, whatever its clock said")
    // A star the phone drew itself (not read back yet) has no stamp of the computer's to compare.
    let drawnStar = ShownState(shown: starred, computer: row)
    XCTAssertNil(drawnStar.pinnedAt)
    XCTAssertEqual(StateConflict.decide(.unstar, shown: drawnStar, row: restarred), .send)

    // Snoozes compare by their end.
    var snoozed = row
    snoozed.snoozed = InboxRowSnooze(until: "2026-11-20T08:00:00.000Z", at: "2026-11-18T12:30:00.000Z")
    XCTAssertEqual(StateConflict.decide(.snooze(until: "2026-11-19T08:00:00.000Z", at: nil), shown: unstarred, row: snoozed), .giveWay, "snoozed elsewhere meanwhile")
    XCTAssertEqual(StateConflict.decide(.snooze(until: "2026-11-20T08:00:00.000Z", at: nil), shown: unstarred, row: snoozed), .already)
    XCTAssertEqual(StateConflict.decide(.unsnooze, shown: unstarred, row: snoozed), .giveWay)
    XCTAssertEqual(StateConflict.decide(.unsnooze, shown: ShownState(shown: snoozed, computer: snoozed), row: snoozed), .send)

    // Archive.
    var archived = row
    archived.resolvedAt = "2026-11-18T12:10:00.000Z"
    XCTAssertEqual(StateConflict.decide(.archive, shown: unstarred, row: archived), .already)
    let seenArchive = ShownState(shown: archived, computer: archived)
    XCTAssertEqual(StateConflict.decide(.unarchive, shown: seenArchive, row: archived), .send)
    var rearchived = archived
    rearchived.resolvedAt = "2026-11-18T09:00:00.000Z"
    XCTAssertEqual(StateConflict.decide(.unarchive, shown: seenArchive, row: rearchived), .giveWay, "archived again elsewhere")
    XCTAssertEqual(StateConflict.decide(.unarchive, shown: seenArchive, row: row), .already)

    // Archive and Mark read never go over what an agent wrote after the tap.
    var asked = row
    asked.lastAuthor = .agent
    asked.lastAgentAt = "2026-11-18T08:05:00.000Z"
    XCTAssertEqual(StateConflict.decide(.read, shown: unstarred, row: asked), .giveWay)
    XCTAssertEqual(StateConflict.decide(.archive, shown: unstarred, row: asked), .giveWay)
    let seenAsk = ShownState(shown: asked, computer: asked)
    XCTAssertEqual(StateConflict.decide(.read, shown: seenAsk, row: asked), .send, "the person saw it")
    XCTAssertEqual(StateConflict.decide(.archive, shown: seenAsk, row: asked), .send)
    var read = asked
    read.readAt = "2026-11-18T08:06:00.000Z"
    read.unread = false
    read.unseen = 0
    XCTAssertEqual(StateConflict.decide(.read, shown: seenAsk, row: read), .already, "read elsewhere")

    XCTAssertEqual(StateConflict.decide(.archive, shown: unstarred, row: nil), .send, "a thread the list lacks: the computer answers")
  }
}

/// A clock the test moves by hand: a wait ends when the clock is moved past it, never by the time a run takes.
final class HandClock: @unchecked Sendable {
  private let lock = NSLock()
  private var time: Date
  private var waits: [(until: Date, waiter: CheckedContinuation<Void, Never>)] = []

  init(_ start: Date) { time = start }

  var now: Date { lock.withLock { time } }
  /// How many sleeps wait on the clock now.
  var sleepers: Int { lock.withLock { waits.count } }

  func move(by seconds: TimeInterval) {
    let due: [CheckedContinuation<Void, Never>] = lock.withLock {
      time = time.addingTimeInterval(seconds)
      let due = waits.filter { $0.until <= time }.map(\.waiter)
      waits.removeAll { $0.until <= time }
      return due
    }
    for waiter in due { waiter.resume() }
  }

  func sleep(_ seconds: TimeInterval) async {
    await withCheckedContinuation { waiter in
      let now: Bool = lock.withLock {
        let until = time.addingTimeInterval(seconds)
        if until <= time { return true }
        waits.append((until, waiter))
        return false
      }
      if now { waiter.resume() }
    }
  }

  var sessionClock: SessionClock { SessionClock(now: { [self] in now }, sleep: { [self] in await sleep($0) }) }
}

/// Every outbox the phone wrote, in order.
final class Outboxes: @unchecked Sendable {
  private let lock = NSLock()
  private var kept: [[HeldWrite]] = []
  func add(_ writes: [HeldWrite]) { lock.withLock { kept.append(writes) } }
  func clear() { lock.withLock { kept = [] } }
  var all: [[HeldWrite]] { lock.withLock { kept } }
}
