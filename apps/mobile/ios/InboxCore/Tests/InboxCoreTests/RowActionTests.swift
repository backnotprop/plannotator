import Foundation
import XCTest
@testable import InboxCore
import InboxStandIn
import InboxWire

/// What the list says and does after a row action: the window's own toast words (apps/mobile/contract/vectors/
/// acts.json and rows.json), one action on several rows with one Undo, and the groups' folds.
@MainActor
final class RowActionTests: XCTestCase {
  private func rows() throws -> [InboxListRow] {
    try Contract.json("fixtures/rows.json").at("rows").items.map { try $0.without("note").decoded(InboxListRow.self) }
  }

  private func check(_ mine: ToastWords, _ theirs: JSONValue, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertEqual(mine.lead, theirs["lead"]?.text, "lead, \(what)", file: file, line: line)
    XCTAssertEqual(mine.phoneLead, theirs["phoneLead"]?.text, "phone lead, \(what)", file: file, line: line)
    XCTAssertEqual(mine.detail, theirs["detail"]?.text, "detail, \(what)", file: file, line: line)
    XCTAssertEqual(mine.phoneDetail, theirs["phoneDetail"]?.text, "phone detail, \(what)", file: file, line: line)
    if let warn = theirs["warn"]?.flag { XCTAssertEqual(mine.warn, warn, "warn, \(what)", file: file, line: line) }
    if let speech = theirs["speech"]?.text { XCTAssertEqual(mine.speech, speech, "speech, \(what)", file: file, line: line) }
  }

  // MARK: The window's words

  func testMarkReadAndMarkUnreadSayWhatTheWindowSaysAtEachPlace() throws {
    let rows = try rows()
    for expected in try Contract.json("vectors/acts.json").at("rows").items {
      let id = try expected.at("thread_id").str()
      let row = try XCTUnwrap(rows.first { $0.threadId.rawValue == id })
      for place in [ActionWords.Place.open, .held, .list] {
        check(ActionWords.markedRead(row, place: place), try expected.at("mark_read").at(place.rawValue), "\(id) \(place.rawValue)")
      }
      check(ActionWords.markedUnread(row, moved: false), try expected.at("mark_unread").at("stays"), "\(id) unread")
      check(ActionWords.markedUnread(row, moved: true), try expected.at("mark_unread").at("moved"), "\(id) unread, moved")
      let warning = ActionWords.setAsideWarning(ActionWords.SetAside([row]), bulk: false)
      XCTAssertEqual(warning.title, try expected.at("set_aside").at("title").str(), id)
      XCTAssertEqual(warning.body, try expected.at("set_aside").at("body").str(), id)
    }
  }

  func testTheSetAsideWarningCountsAndNamesWhatItCloses() throws {
    for expected in try Contract.json("vectors/acts.json").at("set_aside").items {
      let count = ActionWords.SetAside(questions: try expected.at("count").at("questions").int(), actions: try expected.at("count").at("actions").int(), threads: try expected.at("count").at("threads").int())
      for (bulk, key) in [(false, "one"), (true, "bulk")] {
        let mine = ActionWords.setAsideWarning(count, bulk: bulk)
        XCTAssertEqual(mine.title, try expected.at(key).at("title").str())
        XCTAssertEqual(mine.body, try expected.at(key).at("body").str())
        XCTAssertEqual(mine.go, try expected.at(key).at("go").str())
      }
    }
    // Nothing waits: no warning.
    XCTAssertFalse(ActionWords.SetAside(questions: 0, actions: 0, threads: 0).warns)
  }

  func testABulkActionsOneToastCountsMadeHeldAndRefused() throws {
    for expected in try Contract.json("vectors/acts.json").at("bulk").items {
      let action = try XCTUnwrap(BulkAction(rawValue: try expected.at("action").str()))
      let mine = ActionWords.bulk(
        action, made: try expected.at("made").int(), held: try expected.at("held").int(), heldOn: try expected.at("held_on").strings, refused: try expected.at("refused").int(),
        refusal: expected["refusal"]?.text, detail: expected["detail"]?.text)
      guard let theirs = expected["toast"], theirs != .null else {
        XCTAssertNil(mine, "nothing made: no toast")
        continue
      }
      let toast = try XCTUnwrap(mine, "\(expected)")
      // The window's words; a phone's own words for refused rows are below.
      XCTAssertEqual(toast.lead, theirs["lead"]?.text, "lead, \(action.rawValue)")
      XCTAssertEqual(toast.phoneLead, theirs["phoneLead"]?.text, "phone lead, \(action.rawValue)")
      XCTAssertEqual(toast.detail, theirs["detail"]?.text, "detail, \(action.rawValue)")
      if try expected.at("refused").int() == 0 { XCTAssertNil(toast.phoneDetail, "\(action.rawValue)") }
      XCTAssertEqual(toast.mark.rawValue, try theirs.at("icon").str(), "\(action.rawValue)")
      XCTAssertEqual(toast.wraps, theirs["wrap"]?.flag ?? false)
    }
  }

  /// A phone counts the refused rows of a bulk action in the action's own word, with no reason: one short line
  /// beside its Undo, and VoiceOver hears the same.
  func testABulkActionOnAPhoneCountsRefusedRowsWithoutTheReason() throws {
    let archived = try XCTUnwrap(ActionWords.bulk(.archive, made: 2, refused: 1, refusal: ActionWords.unreachable))
    XCTAssertEqual("\(archived.shownLead) · \(archived.shownDetail ?? "")", "Archived 2 · 1 not archived")
    XCTAssertEqual(archived.spoken, "Archived 2 threads. 1 not archived.")
    let expected: [(BulkAction, String)] = [
      (.archive, "Archived 2 · 1 not archived"),
      (.snooze, "Snoozed 2 · 1 not snoozed"),
      (.read, "Marked 2 read · 1 not marked read"),
      (.unread, "Marked 2 unread · 1 not marked unread"),
      (.star, "Starred 2 · 1 not starred"),
      (.unstar, "Unstarred 2 · 1 not unstarred"),
      (.priorityAdd, "Added 2 to Priority · 1 not added"),
      (.priorityRemove, "Removed 2 from Priority · 1 not removed"),
    ]
    for (action, line) in expected {
      let toast = try XCTUnwrap(ActionWords.bulk(action, made: 2, refused: 1, refusal: "This thread is archived."))
      XCTAssertEqual("\(toast.shownLead) · \(toast.shownDetail ?? "")", line, action.rawValue)
      XCTAssertFalse(toast.spoken.contains("This thread") || toast.spoken.contains("did not change"), "no reason, \(action.rawValue)")
    }
    // What a snooze says first and what waits for a computer stay before the refused count.
    let snoozed = try XCTUnwrap(ActionWords.bulk(.snooze, made: 2, held: 1, heldOn: ["Work Mac"], refused: 1, refusal: ActionWords.timePassed, detail: "Wed 8:00 AM"))
    XCTAssertEqual(snoozed.shownDetail, "Wed 8:00 AM · 1 when Work Mac is back · 1 not snoozed")
    XCTAssertEqual(snoozed.spoken, "Snoozed 2 threads. Wed 8:00 AM. 1 when Work Mac is back. 1 not snoozed.")
    // Nothing made: no bulk toast (the single action's error toast says it).
    XCTAssertNil(ActionWords.bulk(.archive, made: 0, refused: 2, refusal: ActionWords.unreachable))
  }

  func testAgentNamesAreCutAsTheWindowCutsThemAndLinksAreTheWindows() throws {
    let vector = try Contract.json("vectors/acts.json")
    for expected in try vector.at("names").items {
      XCTAssertEqual(ActionWords.shortName(try expected.at("name").str()), try expected.at("short").str())
    }
    // A device that is not the computer copies the address it reaches the computer by.
    for expected in try vector.at("links").items where expected["via"]?.text != "local" {
      XCTAssertEqual(ActionWords.threadLink(ThreadID(try expected.at("thread_id").str()), origin: try expected.at("origin").str()), try expected.at("link").str())
    }
    XCTAssertEqual(ActionWords.unreachable, try vector.at("unreachable").str())
    let tailnet = PairedComputer(id: "d", name: "Work Mac", token: "t", secret: "s", addresses: [.wifi(hostPort: "192.0.2.10:8443", fingerprint: "ab"), .tailnet(hostPort: "desk.example.ts.net:8443")])
    XCTAssertEqual(ActionWords.origin(of: tailnet), "https://desk.example.ts.net:8443")
    XCTAssertNil(ActionWords.origin(of: PairedComputer(id: "d", name: "Demo", token: "t", secret: "s", addresses: [])))
  }

  func testUnstarAndPrioritySayWhereTheRowStillIs() throws {
    let rows = try rows()
    let now = try XCTUnwrap(TimeWords.date(try Contract.json("fixtures/rows.json").at("now").str()))
    for expected in try Contract.json("vectors/rows.json").at("rows").items {
      let id = try expected.at("thread_id").str()
      let row = ListRules.asOf(try XCTUnwrap(rows.first { $0.threadId.rawValue == id }), now: now)
      XCTAssertEqual(ActionWords.unpinnedWhere(row), try expected.at("unpinned_where").str(), id)
      XCTAssertEqual(ActionWords.priorityBackIn(row), expected["priority_back_in"]?.text, id)
    }
    XCTAssertEqual(ActionWords.unpinnedWhere(nil), "Still in the Inbox")
  }

  // MARK: Several rows at once

  func testOneActionOnSeveralRowsIsOneUndo() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    let threads = [StandInData.docs, StandInData.bumps, StandInData.upload]

    let outcome = await session.actMany(.archive, on: threads)
    XCTAssertEqual(outcome.made, threads)
    XCTAssertEqual(outcome.held, 0)
    XCTAssertTrue(outcome.refused.isEmpty)
    let posted = await door.posts("/resolve")
    XCTAssertEqual(posted.count, 3)
    var view = try XCTUnwrap(session.listView())
    for thread in threads { XCTAssertEqual(view.group(of: thread), .archived) }
    // One Undo for all three; no single Undo is left beside it.
    let undo = try XCTUnwrap(outcome.undo)
    XCTAssertEqual(undo.count, 3)
    XCTAssertEqual(session.bulkUndoOffer?.id, undo.id)
    XCTAssertNil(session.undoOffer)

    let undone = await session.undoMany(undo)
    XCTAssertTrue(undone)
    view = try XCTUnwrap(session.listView())
    for thread in threads {
      XCTAssertNotEqual(view.group(of: thread), .archived)
      let kept = await door.rowState(thread)
      XCTAssertNil(kept.resolvedAt)
    }
    // Used once.
    let again = await session.undoMany(undo)
    XCTAssertFalse(again)
  }

  func testSeveralRowsActedOnWhileTheComputerIsAwayWaitAndUndoSendsNothing() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await door.setOffline(true)
    let threads = [StandInData.docs, StandInData.bumps]
    let until = SnoozeRules.iso(Date().addingTimeInterval(3 * 3600))

    let outcome = await session.actMany(.snooze, until: until, on: threads)
    XCTAssertEqual(outcome.made, threads)
    XCTAssertEqual(outcome.held, 2, "both wait on the phone")
    let band = try XCTUnwrap(session.listView()?.groups.first { $0.id == .snoozed })
    XCTAssertEqual(Set(band.threads.map(\.threadId)), Set(threads), "drawn while they wait")

    let undone = await session.undoMany(try XCTUnwrap(outcome.undo))
    XCTAssertTrue(undone)
    XCTAssertTrue(session.held.filter { $0.kind == .state }.isEmpty, "taken back before they left the phone")
    // Calls tried while it was away do not count.
    await door.clearCalls()
    await door.setOffline(false)
    await session.refresh()
    let sent = await door.posts("/snooze")
    XCTAssertTrue(sent.isEmpty)
  }

  func testStarringSeveralRowsIsUndoneByUnstarringThem() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    let threads = [StandInData.docs, StandInData.bumps]
    let outcome = await session.actMany(.star, on: threads)
    XCTAssertEqual(outcome.made, threads)
    var pins = await door.pins
    // Both starred. Their order is the order the computer took them in: they are sent a few at a time, at once.
    XCTAssertEqual(Set(pins), Set(threads))
    XCTAssertEqual(pins.count, threads.count)
    let undone = await session.undoMany(try XCTUnwrap(outcome.undo))
    XCTAssertTrue(undone)
    pins = await door.pins
    XCTAssertTrue(pins.isEmpty)
  }

  func testABulkUndoIsOfferedForSevenSeconds() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    let outcome = await session.actMany(.archive, on: [StandInData.docs])
    let undo = try XCTUnwrap(outcome.undo)
    let late = await session.undoMany(undo, now: undo.expires.addingTimeInterval(0.1))
    XCTAssertFalse(late)
    let kept = await door.rowState(StandInData.docs)
    XCTAssertNotNil(kept.resolvedAt, "still archived")
  }

  func testEachBulkActionTakesOnlyTheRowsItsMenuItemWould() throws {
    let rows = try rows()
    let now = try XCTUnwrap(TimeWords.date(try Contract.json("fixtures/rows.json").at("now").str()))
    var model = ListModel(serverSession: "s", version: "1", cursor: 1, projects: [], sections: ListRules.sections(rows))
    model.pins = rows.filter { $0.pinnedAt != nil }
    let view = ListView.of(model, now: now)
    let standing = rows.map { ListRules.asOf($0, now: now) }
    let starred = Set(view.pins.map(\.threadId))
    func targets(_ action: BulkAction) -> Set<String> {
      Set(BulkAction.targets(standing, action, drawn: { view.group(of: $0.threadId) }, starred: starred).map(\.threadId.rawValue))
    }
    // The same rows whose own menu offers the item (the menu's cases are the window's, vectors/rows.json).
    func offered(_ item: RowOffers.Action) -> Set<String> {
      Set(standing.filter { RowOffers.menu($0, drawn: view.group(of: $0.threadId), pinned: starred.contains($0.threadId)).contains(item) }.map(\.threadId.rawValue))
    }
    XCTAssertEqual(targets(.archive), offered(.archive))
    XCTAssertEqual(targets(.snooze), offered(.snooze))
    XCTAssertEqual(targets(.read), offered(.read))
    XCTAssertEqual(targets(.unread), offered(.markUnread))
    XCTAssertEqual(targets(.star), offered(.pin))
    XCTAssertEqual(targets(.unstar), offered(.unpin))
    XCTAssertEqual(targets(.priorityAdd), offered(.priorityAdd))
    XCTAssertEqual(targets(.priorityRemove), offered(.priorityRemove))
    XCTAssertFalse(targets(.archive).isEmpty)
    XCTAssertFalse(targets(.unstar).isEmpty)
  }

  // MARK: The groups' folds

  func testQuietAndSnoozedStartClosedAndEveryGroupFoldsByItsHeader() {
    let loaded = Date(timeIntervalSince1970: 1_800_000_000)
    var folds = ListFolds(nil, loaded: loaded)
    XCTAssertFalse(folds.isOpen(.quiet))
    XCTAssertFalse(folds.isOpen(.snoozed))
    for id in [InboxListGroupId.priority, .stopped, .holding, .waiting, .new, .sent] { XCTAssertTrue(folds.isOpen(id), id.rawValue) }
    XCTAssertEqual(folds.raw, "")

    folds.toggle(.quiet)
    XCTAssertTrue(folds.isOpen(.quiet))
    folds.toggle(.waiting, now: Date(timeIntervalSince1970: 1_800_000_100))
    XCTAssertFalse(folds.isOpen(.waiting))
    // The window's own form, so the choice reads the same on both.
    XCTAssertEqual(folds.raw, "waiting:1800000100000,quiet:open")
    // Kept across a launch.
    let again = ListFolds(folds.raw, loaded: loaded)
    XCTAssertTrue(again.isOpen(.quiet))
    XCTAssertEqual(again.state(.waiting), .closed(since: 1_800_000_100_000))
    // A group open by default opened again loses its entry; the Snoozed band comes back folded.
    folds.toggle(.waiting)
    folds.toggle(.snoozed)
    XCTAssertEqual(folds.raw, "quiet:open,snoozed:open")
    folds.reset(.snoozed)
    XCTAssertFalse(folds.isOpen(.snoozed))
    // Anything that is not a choice is ignored.
    XCTAssertEqual(ListFolds("nonsense,quiet:maybe,:open,sent:12x,new:17", loaded: loaded).raw, "new:17")
  }

  func testAClosedGroupSaysWhenSomethingNewOrABlockerIsInside() throws {
    let rows = try rows()
    let now = try XCTUnwrap(TimeWords.date(try Contract.json("fixtures/rows.json").at("now").str()))
    let view = ListView.of(ListModel(serverSession: "s", version: "1", cursor: 1, projects: [], sections: ListRules.sections(rows)), now: now)
    func group(_ id: InboxListGroupId) throws -> InboxListSection { try XCTUnwrap(view.groups.first { $0.id == id }) }
    var folds = ListFolds(nil, loaded: now)

    // Open: nothing is hidden, so nothing is said.
    XCTAssertNil(folds.blocker(try group(.stopped)))
    XCTAssertFalse(folds.hasNews(try group(.new)))

    // Closed long before its rows' news: the count goes bold, and a blocker never hides behind the fold.
    folds.toggle(.new, now: Date(timeIntervalSince1970: 0))
    XCTAssertTrue(folds.hasNews(try group(.new)))
    folds.toggle(.stopped, now: now)
    XCTAssertEqual(folds.blocker(try group(.stopped)), "A closed thread is stopped on you")
    folds.toggle(.holding, now: now)
    XCTAssertEqual(folds.blocker(try group(.holding)), "A closed thread is holding up work")
    // Closed after its rows' news: nothing new since.
    folds.toggle(.new)
    folds.toggle(.new, now: now.addingTimeInterval(86_400))
    XCTAssertFalse(folds.hasNews(try group(.new)))
    // Quiet holds no blocker.
    XCTAssertNil(folds.blocker(try group(.quiet)))
  }
}

extension RowActionTests {
  /// The Archived group is read less often than the list: a thread unarchived since is gone from it at once and
  /// stays gone, and one archived since joins it.
  func testTheArchivedGroupFollowsTheListBetweenItsOwnReads() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.act(.archive, on: StandInData.docs)
    await session.readArchived()
    XCTAssertEqual(session.archivedRows().map(\.threadId), [StandInData.docs])

    await session.act(.unarchive, on: StandInData.docs)
    await session.refresh()
    XCTAssertTrue(session.archivedRows().isEmpty, "unarchived: not in the group, though the group was not read again")

    await session.act(.archive, on: StandInData.bumps)
    await session.refresh()
    XCTAssertEqual(session.archivedRows().map(\.threadId), [StandInData.bumps])
  }
}

extension RowActionTests {
  /// A thousand rows archived at once: every one goes, the list is drawn without them, and one Undo is offered.
  func testAThousandRowsAreArchivedAtOnce() async throws {
    let door = StandInDoor()
    let threads = StandInData.manyThreads(now: Date(), count: 1000)
    for thread in threads { await door.add(thread) }
    let session = await pairedSession(door: door)
    await session.start()
    let ids = threads.map(\.threadId)
    let started = Date()
    let outcome = await session.actMany(.archive, on: ids)
    let took = Date().timeIntervalSince(started)
    XCTAssertEqual(outcome.made.count, 1000)
    XCTAssertEqual(outcome.undo?.count, 1000)
    let view = try XCTUnwrap(session.listView())
    XCTAssertFalse(view.groups.flatMap(\.threads).contains { ids.contains($0.threadId) })
    XCTAssertEqual(session.archivedRows().count, 1000)
    // Drawn in one pass over the list: far from the minutes a pass per act took.
    XCTAssertLessThan(took, 30, "took \(took) s")
    print("archived 1000 rows in \(took) s")
  }
}

extension RowActionTests {
  /// Fifty rows archived while the computer is away: every row leaves at once and the Undo is there before
  /// anything is sent; nothing is tried against a computer that does not answer; an act made meanwhile keeps its
  /// own Undo.
  func testFiftyRowsActedOnWhileAwayAreDrawnAtOnceAndNothingIsTried() async throws {
    let door = StandInDoor()
    let threads = StandInData.manyThreads(now: Date(), count: 50)
    for thread in threads { await door.add(thread) }
    let copy = LocalCopy(folder: FileManager.default.temporaryDirectory.appendingPathComponent("inbox-core-tests-\(UUID().uuidString)", isDirectory: true))
    let session = await pairedSession(door: door, copy: copy)
    await session.start()
    await door.setOffline(true)
    await session.refresh()
    XCTAssertEqual(session.reach, .away)
    await door.clearCalls()
    let ids = threads.map(\.threadId)

    // Held, not awaited: the rows are out of the list and the Undo is on offer when this returns.
    let outcome = session.holdMany(.archive, on: ids)
    XCTAssertEqual(outcome.made.count, 50)
    XCTAssertEqual(outcome.held, 50, "all of them wait for the computer")
    XCTAssertEqual(outcome.undo?.count, 50)
    let view = try XCTUnwrap(session.listView())
    XCTAssertFalse(view.groups.flatMap(\.threads).contains { ids.contains($0.threadId) }, "every row left at once")
    XCTAssertEqual(session.held.filter { $0.kind == .state }.count, 50)
    // In the outbox on disk, so a relaunch keeps them.
    XCTAssertEqual(copy.outbox().filter { $0.kind == .state }.count, 50)

    // A swipe made while the batch waits has its own Undo, and keeps it.
    let key = try XCTUnwrap(session.holdAct(.archive, on: StandInData.docs))
    let own = try XCTUnwrap(session.undoOffer)
    XCTAssertEqual(own.id, key)
    await session.sendMany(outcome.made)
    XCTAssertEqual(session.undoOffer?.id, key, "the batch did not take the swipe's Undo")
    let tried = await door.calls
    XCTAssertTrue(tried.isEmpty, "nothing is tried while the computer does not answer: \(tried.map(\.path))")

    // Undo takes all fifty back at once, and nothing was ever sent.
    let undone = await session.undoMany(try XCTUnwrap(outcome.undo))
    XCTAssertTrue(undone)
    XCTAssertEqual(session.held.filter { $0.kind == .state }.map(\.id), [key], "only the swipe still waits")
    XCTAssertEqual(copy.outbox().filter { $0.kind == .state }.count, 1)
    let back = try XCTUnwrap(session.listView())
    XCTAssertEqual(back.groups.flatMap(\.threads).filter { ids.contains($0.threadId) }.count, 50)
  }

  /// The Archived group pages as the window's does: twenty, then twenty more, however many the list carries.
  func testTheArchivedGroupShowsTwentyThenTwentyMore() async throws {
    let door = StandInDoor()
    let threads = StandInData.manyThreads(now: Date(), count: 25)
    for thread in threads { await door.add(thread) }
    let session = await pairedSession(door: door)
    await session.start()
    await session.actMany(.archive, on: threads.map(\.threadId))
    await session.readArchived()
    XCTAssertEqual(session.archivedRows().count, 25)
    XCTAssertEqual(session.archivedPage().count, 20)
    XCTAssertTrue(session.archivedHasMore)
    await session.readArchived(more: true)
    XCTAssertEqual(session.archivedPage().count, 25)
    XCTAssertFalse(session.archivedHasMore)
  }

  /// An act is held and its Undo is on offer before anything is sent: a toast shown then can never outlive it.
  func testAnActIsHeldWithItsUndoBeforeItIsSent() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await door.clearCalls()
    let key = try XCTUnwrap(session.holdAct(.archive, on: StandInData.docs))
    XCTAssertEqual(session.undoOffer?.id, key)
    XCTAssertEqual(session.listView()?.group(of: StandInData.docs), .archived, "drawn at once")
    let sent = await door.posts("/resolve")
    XCTAssertTrue(sent.isEmpty, "not sent yet")
    let outcome = await session.deliverAct(key, on: StandInData.docs)
    XCTAssertEqual(outcome, .done)
    // A screen reader's toast stays longer, and so does its Undo.
    session.undoSeconds = 30
    session.holdAct(.unarchive, on: StandInData.docs)
    let offer = try XCTUnwrap(session.undoOffer)
    XCTAssertGreaterThan(offer.expires.timeIntervalSinceNow, 20)
  }
}

extension RowActionTests {
  /// Whom a reply goes to in a thread a script started (the window's `rowRecipientName`, which the thread's lines
  /// name on the phone): the session that took it over, even after the script posted again; the script only where
  /// the reply is its own (`delivery.script`); a script's thread no session took over, Script.
  func testAScriptsThreadNamesWhomTheReplyGoesToAsTheWindowDoes() throws {
    var row = try XCTUnwrap(try rows().first)
    row.author = InboxAuthor(kind: .agent)
    row.participants = nil
    row.delivery = nil
    XCTAssertEqual(ActionWords.rowRecipient(row), "Script")
    // A Claude Code session took it over; the script posted again after it (its row is still the script's).
    row.participants = [InboxParticipant(host: "claude-code", session: "ses_1", name: "Claude Code")]
    XCTAssertEqual(ActionWords.rowRecipient(row), "Claude Code")
    row.delivery = InboxRowDelivery(kind: .reply, state: .saved, reason: .reads, sendNow: false, messageId: MessageID("msg_3"), host: "claude-code", name: "Claude Code")
    XCTAssertEqual(ActionWords.rowRecipient(row), "Claude Code")
    // The person answered the script's own post: that reply is the script's.
    row.delivery = InboxRowDelivery(kind: .reply, state: .saved, reason: .reads, sendNow: false, messageId: MessageID("msg_3"), script: true)
    XCTAssertEqual(ActionWords.rowRecipient(row), "Script")
    // An agent's own row: its agent, whatever the delivery says.
    row.author = InboxAuthor(kind: .agent, host: "claude-code", session: "ses_1", name: "Claude Code")
    row.delivery = InboxRowDelivery(kind: .reply, state: .saved, reason: .reads, sendNow: false, messageId: MessageID("msg_3"), host: "pi")
    XCTAssertEqual(ActionWords.rowRecipient(row), "Claude Code")
  }
}
