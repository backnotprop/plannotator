import XCTest

/// Acting on a row, walked as a person would, on the stand-in computer: the swipes, the row's menu, snooze in each
/// place it is offered, stars, several rows at once, the Archived list, and the toast with its Undo.
/// Nothing here reaches a real Inbox. With SHOTS_DIR set (TEST_RUNNER_SHOTS_DIR on the command line) each state is
/// also saved as a picture, named with SHOTS_LOOK ("light" or "dark").
final class RowActionUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  // MARK: Helpers

  @MainActor
  private func launch(stage: String = "none", open: String? = nil, more: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    // Every group at its default: no fold kept from another run.
    app.launchArguments = ["-standIn", "YES", "-AppleLanguages", "(en)", "-stage", stage, "-resetFolds", "YES"] + (open.map { ["-open", $0] } ?? []) + more
    app.launch()
    if open == nil { XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 15)) }
    return app
  }

  @MainActor
  private func row(_ app: XCUIApplication, _ title: String) -> XCUIElement {
    app.buttons.containing(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
  }

  @MainActor
  private func header(_ app: XCUIApplication, _ name: String) -> XCUIElement {
    app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "\(name), ")).firstMatch
  }

  @MainActor
  private func text(_ app: XCUIApplication, _ words: String) -> XCUIElement {
    app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
  }

  /// A short swipe that leaves the row open on its action.
  @MainActor
  private func open(_ element: XCUIElement, toThe left: Bool) {
    let from = element.coordinate(withNormalizedOffset: CGVector(dx: left ? 0.7 : 0.3, dy: 0.5))
    let to = element.coordinate(withNormalizedOffset: CGVector(dx: left ? 0.4 : 0.6, dy: 0.5))
    from.press(forDuration: 0.1, thenDragTo: to, withVelocity: .slow, thenHoldForDuration: 0.2)
  }

  @MainActor
  private func shot(_ name: String) {
    guard let folder = ProcessInfo.processInfo.environment["SHOTS_DIR"], !folder.isEmpty else { return }
    let look = ProcessInfo.processInfo.environment["SHOTS_LOOK"] ?? "light"
    // Let a menu or a toast finish arriving.
    usleep(600_000)
    try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name)-\(look).png"))
  }

  // MARK: Swipes

  // proves: list-07, list-11
  @MainActor
  func testSwipeLeftArchivesAndUndoPutsTheRowBack() {
    let app = launch()
    let docs = row(app, "Onboarding copy")
    XCTAssertTrue(docs.waitForExistence(timeout: 10))
    shot("01-list")
    open(docs, toThe: true)
    let archive = app.buttons["Archive"]
    XCTAssertTrue(archive.waitForExistence(timeout: 5))
    shot("02-swipe-left-archive")
    archive.tap()

    // The row leaves; the one toast says so and offers Undo.
    XCTAssertTrue(text(app, "Archived").waitForExistence(timeout: 5))
    XCTAssertTrue(text(app, "Onboarding copy").exists, "the toast names the row")
    shot("03-archived-toast")
    XCTAssertFalse(row(app, "Onboarding copy, Gemini CLI").exists, "out of the list")
    XCTAssertTrue(header(app, "Waiting on you").label.hasPrefix("Waiting on you, 1"))
    app.buttons["Undo"].tap()
    XCTAssertTrue(row(app, "Onboarding copy, Gemini CLI").waitForExistence(timeout: 5))
    XCTAssertTrue(header(app, "Waiting on you").label.hasPrefix("Waiting on you, 2"))
    XCTAssertFalse(app.buttons["Undo"].exists, "used once")
  }

  // proves: list-07, list-12
  @MainActor
  func testSwipeRightMarksReadAndWarnsBeforeSettingQuestionsAside() {
    let app = launch()
    let docs = row(app, "Docs search is slow")
    XCTAssertTrue(docs.waitForExistence(timeout: 10))
    open(docs, toThe: false)
    let quiet = app.buttons["Mark read, move to Quiet"]
    XCTAssertTrue(quiet.waitForExistence(timeout: 5))
    shot("04-swipe-right-quiet")
    quiet.tap()
    XCTAssertTrue(text(app, "Moved to Quiet").waitForExistence(timeout: 5))
    shot("05-moved-to-quiet-toast")
    // Quiet is closed until the person opens it: the row is inside.
    XCTAssertFalse(row(app, "Docs search is slow").exists)
    header(app, "Quiet").tap()
    XCTAssertTrue(row(app, "Docs search is slow").waitForExistence(timeout: 5))

    // A row with open questions: the warning asks first, in the window's words, and Cancel changes nothing.
    let checkout = row(app, "Checkout redesign")
    open(checkout, toThe: false)
    app.buttons["Mark read, move to Quiet"].tap()
    let warning = app.alerts["Set aside 2 open questions?"]
    XCTAssertTrue(warning.waitForExistence(timeout: 5))
    XCTAssertTrue(warning.staticTexts["Mark read closes them unanswered and tells the agent not to wait on them."].exists)
    shot("06-set-aside-warning")
    warning.buttons["Cancel"].tap()
    XCTAssertTrue(header(app, "Waiting on you").waitForExistence(timeout: 5))
    XCTAssertTrue(row(app, "Checkout redesign").exists)

    // A read row offers Mark unread on the same swipe.
    let read = row(app, "Docs search is slow")
    open(read, toThe: false)
    XCTAssertTrue(app.buttons["Mark unread"].waitForExistence(timeout: 5))
    shot("07-swipe-right-mark-unread")
    app.buttons["Mark unread"].tap()
    XCTAssertTrue(text(app, "Marked unread").waitForExistence(timeout: 5))
    shot("08-marked-unread-toast")
    XCTAssertTrue(header(app, "New since you looked").waitForExistence(timeout: 5))
  }

  // MARK: The row's menu and snooze

  // proves: list-08, list-11
  @MainActor
  func testHoldOpensTheMenuAndSnoozeMovesTheRowToTheFoldedBand() {
    let app = launch()
    let retry = row(app, "Retry logic for the relay client")
    XCTAssertTrue(retry.waitForExistence(timeout: 10))
    retry.press(forDuration: 1.0)
    // The window's items, in the window's order.
    let items = ["Select", "Star thread", "Add to Priority", "Copy link", "Copy thread ID", "Snooze", "Mark read", "Archive"]
    for item in items { XCTAssertTrue(app.buttons[item].waitForExistence(timeout: 5), item) }
    let tops = items.map { app.buttons[$0].frame.minY }
    XCTAssertEqual(tops, tops.sorted(), "in the window's order")
    shot("09-row-menu")

    app.buttons["Snooze"].tap()
    for choice in ["Tomorrow", "In 3 days", "Next week", "Pick a time…"] { XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", choice)).firstMatch.waitForExistence(timeout: 5), choice) }
    shot("10-row-menu-snooze-times")
    app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Tomorrow")).firstMatch.tap()

    XCTAssertTrue(text(app, "Snoozed").waitForExistence(timeout: 5))
    XCTAssertTrue(text(app, "8:00 AM").exists, "the toast says when it comes back")
    shot("11-snoozed-toast")
    // The band is under the list, folded; a blocker inside keeps its warning.
    XCTAssertFalse(header(app, "Holding up work").exists)
    app.swipeUp()
    let band = header(app, "Snoozed")
    XCTAssertTrue(band.waitForExistence(timeout: 5))
    XCTAssertTrue(band.label.contains("A snoozed thread is holding up work"), band.label)
    XCTAssertFalse(row(app, "Retry logic for the relay client").exists, "folded")
    band.tap()
    let snoozed = row(app, "Retry logic for the relay client")
    XCTAssertTrue(snoozed.waitForExistence(timeout: 5))
    XCTAssertTrue(snoozed.label.contains("Snoozed until"), snoozed.label)
    shot("12-snoozed-band-open")

  }

  @MainActor
  func testPickATimeSnoozesToTheDayAndHalfHourPicked() {
    let app = launch()
    let retry = row(app, "Retry logic for the relay client")
    XCTAssertTrue(retry.waitForExistence(timeout: 10))
    retry.press(forDuration: 1.0)
    app.buttons["Snooze"].tap()
    app.buttons["Pick a time…"].tap()
    XCTAssertTrue(app.navigationBars["Pick a time"].waitForExistence(timeout: 5))
    XCTAssertEqual(app.pickerWheels.count, 2, "a day and a time")
    // Where the window's opens: two days out, 3:00 PM.
    XCTAssertEqual(app.pickerWheels.element(boundBy: 1).value as? String, "3:00 PM")
    shot("13-pick-a-time")
    app.pickerWheels.element(boundBy: 0).adjust(toPickerWheelValue: "Tomorrow")
    app.buttons["Snooze"].tap()
    XCTAssertTrue(text(app, "Snoozed").waitForExistence(timeout: 5))
    XCTAssertTrue(text(app, "3:00 PM").exists)
    shot("14-pick-a-time-snoozed")
    XCTAssertFalse(header(app, "Holding up work").exists, "in the Snoozed band now")
    // Undo puts it back where it was.
    app.buttons["Undo"].tap()
    XCTAssertTrue(header(app, "Holding up work").waitForExistence(timeout: 5))
    XCTAssertFalse(header(app, "Snoozed").exists)
  }

  // MARK: Stars

  @MainActor
  func testAStarredThreadSitsAboveTheListAndItsStarUnstarsIt() {
    let app = launch()
    let retry = row(app, "Retry logic for the relay client")
    XCTAssertTrue(retry.waitForExistence(timeout: 10))
    retry.press(forDuration: 1.0)
    app.buttons["Star thread"].tap()
    let pill = app.buttons["Starred, Retry logic for the relay client"]
    XCTAssertTrue(pill.waitForExistence(timeout: 5))
    XCTAssertTrue(row(app, "Holding up work: 1 question").label.contains("Starred"))
    shot("15-starred")

    pill.press(forDuration: 1.0)
    for item in ["Unstar thread", "Move up", "Move down", "Copy link"] { XCTAssertTrue(app.buttons[item].waitForExistence(timeout: 5), item) }
    shot("16-starred-menu")
    app.buttons["Unstar thread"].tap()
    XCTAssertTrue(text(app, "Unstarred").waitForExistence(timeout: 5))
    XCTAssertTrue(text(app, "Still in Holding up work").exists)
    shot("17-unstarred-toast")
    XCTAssertFalse(pill.exists)
    app.buttons["Undo"].tap()
    XCTAssertTrue(pill.waitForExistence(timeout: 5))
  }

  // MARK: Several rows

  @MainActor
  func testSelectPicksSeveralRowsAndOneUndoTakesThemAllBack() {
    let app = launch()
    let retry = row(app, "Retry logic for the relay client")
    XCTAssertTrue(retry.waitForExistence(timeout: 10))
    retry.press(forDuration: 1.0)
    app.buttons["Select"].tap()
    XCTAssertTrue(app.staticTexts["1 selected"].waitForExistence(timeout: 5))
    row(app, "Checkout redesign").tap()
    row(app, "Docs search is slow").tap()
    XCTAssertTrue(app.staticTexts["3 selected"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Select all"].exists)
    shot("18-selecting")

    app.buttons["More"].tap()
    for item in ["Mark read", "Star threads", "Add to Priority"] { XCTAssertTrue(app.buttons[item].waitForExistence(timeout: 5), item) }
    XCTAssertFalse(app.buttons["Unstar threads"].exists, "none of them is starred")
    shot("19-selecting-more")
    // Close the menu.
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()

    app.buttons["Archive"].tap()
    XCTAssertTrue(text(app, "Archived 3").waitForExistence(timeout: 5))
    shot("20-archived-three-toast")
    XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 5), "picking is over")
    XCTAssertFalse(row(app, "Checkout redesign").exists)
    app.buttons["Undo"].tap()
    XCTAssertTrue(row(app, "Checkout redesign").waitForExistence(timeout: 5))
    XCTAssertTrue(row(app, "Retry logic for the relay client").exists)
  }

  @MainActor
  func testSelectAllThenDoneLeavesEveryRowAsItWas() {
    let app = launch()
    let retry = row(app, "Retry logic for the relay client")
    XCTAssertTrue(retry.waitForExistence(timeout: 10))
    retry.press(forDuration: 1.0)
    app.buttons["Select"].tap()
    app.buttons["Select all"].tap()
    // Every row of the open groups (Quiet is closed).
    XCTAssertTrue(app.staticTexts["6 selected"].waitForExistence(timeout: 5))
    app.buttons["Select all"].tap()
    XCTAssertTrue(app.staticTexts["Tap threads to select them"].waitForExistence(timeout: 5))
    shot("21-selecting-none")
    app.buttons["Done"].tap()
    XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 5))
    XCTAssertTrue(row(app, "Retry logic for the relay client").exists)
  }

  // MARK: The thread's More menu

  @MainActor
  func testTheThreadsMenuSnoozesAndItsLineUnsnoozes() {
    let app = launch()
    row(app, "Retry logic for the relay client").tap()
    let more = app.buttons["More"]
    XCTAssertTrue(more.waitForExistence(timeout: 10))
    more.tap()
    for item in ["Mark read", "Snooze", "Star thread", "Add to Priority", "Copy link", "Copy thread ID", "Archive thread"] { XCTAssertTrue(app.buttons[item].waitForExistence(timeout: 5), item) }
    shot("22-thread-menu")
    app.buttons["Snooze"].tap()
    app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Tomorrow")).firstMatch.tap()
    let line = text(app, "Snoozed until")
    XCTAssertTrue(line.waitForExistence(timeout: 5))
    shot("23-thread-snoozed")
    // The line's own Unsnooze (the toast's Undo is beside it; this is the line's).
    app.buttons["Unsnooze"].firstMatch.tap()
    XCTAssertTrue(text(app, "Unsnoozed").waitForExistence(timeout: 5))
    XCTAssertFalse(line.exists)
    shot("24-thread-unsnoozed-toast")

    // Archive from the thread: it stays open, its foot says what archiving means and offers the way back.
    more.tap()
    app.buttons["Archive thread"].tap()
    XCTAssertTrue(text(app, "starts a new thread.").waitForExistence(timeout: 5))
    shot("25-thread-archived")
    app.buttons["Unarchive"].tap()
    XCTAssertTrue(text(app, "Back in your Inbox").waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Send"].waitForExistence(timeout: 5), "the reply field is back")
  }

  @MainActor
  func testMarkUnreadFromAThreadClosesItAndTheRowIsBoldInNew() {
    let app = launch()
    app.swipeUp()
    header(app, "Quiet").tap()
    let bumps = row(app, "Weekly dependency bumps")
    XCTAssertTrue(bumps.waitForExistence(timeout: 10))
    bumps.tap()
    let more = app.buttons["More"]
    XCTAssertTrue(more.waitForExistence(timeout: 10))
    more.tap()
    app.buttons["Mark unread"].tap()
    XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10), "the thread closed")
    XCTAssertTrue(text(app, "back in New").waitForExistence(timeout: 5))
    XCTAssertTrue(row(app, "Weekly dependency bumps").label.hasPrefix("Unread"))
  }

  // MARK: Archived

  @MainActor
  func testTheArchivedListUnarchivesByASwipeWithUndo() {
    let app = launch(stage: "archivedrow")
    app.swipeUp()
    let door = app.buttons["Archived"]
    XCTAssertTrue(door.waitForExistence(timeout: 10))
    shot("26-archived-door")
    door.tap()
    XCTAssertTrue(app.navigationBars["Archived"].waitForExistence(timeout: 5))
    let docs = row(app, "Docs search is slow")
    XCTAssertTrue(docs.waitForExistence(timeout: 5))
    XCTAssertTrue(row(app, "Weekly dependency bumps").exists)
    shot("27-archived-list")
    open(docs, toThe: true)
    XCTAssertTrue(app.buttons["Unarchive"].waitForExistence(timeout: 5))
    shot("28-archived-swipe")
    app.buttons["Unarchive"].tap()
    XCTAssertTrue(text(app, "Back in your Inbox").waitForExistence(timeout: 5))
    XCTAssertFalse(row(app, "Docs search is slow").exists)
    shot("29-unarchived-toast")
    app.buttons["Undo"].tap()
    XCTAssertTrue(row(app, "Docs search is slow").waitForExistence(timeout: 5))
  }

  // MARK: While the computer is away

  @MainActor
  func testAnActMadeWhileTheComputerIsAwayIsDrawnAndWaits() {
    let app = launch(stage: "away")
    let retry = row(app, "Retry logic for the relay client")
    XCTAssertTrue(retry.waitForExistence(timeout: 10))
    retry.press(forDuration: 1.0)
    app.buttons["Star thread"].tap()
    // Drawn at once: the star is above the list, and the row says it will send.
    XCTAssertTrue(app.buttons["Starred, Retry logic for the relay client"].waitForExistence(timeout: 5))
    XCTAssertTrue(row(app, "Retry logic for the relay client, Claude Code").label.contains("Will send"))
    XCTAssertTrue(text(app, "Will send when Work Mac is back.").exists)
    shot("30-away-held")
  }

  // MARK: Folds

  @MainActor
  func testAGroupClosesAndOpensByItsHeader() {
    let app = launch()
    let waiting = header(app, "Waiting on you")
    XCTAssertTrue(waiting.waitForExistence(timeout: 10))
    XCTAssertTrue(row(app, "Checkout redesign").exists)
    waiting.tap()
    XCTAssertFalse(row(app, "Checkout redesign").waitForExistence(timeout: 1))
    // A closed Stopped keeps its warning, so a blocker never hides behind the fold.
    header(app, "Stopped on you").tap()
    XCTAssertTrue(header(app, "Stopped on you").label.contains("A closed thread is stopped on you"))
    shot("31-groups-closed")
    waiting.tap()
    XCTAssertTrue(row(app, "Checkout redesign").waitForExistence(timeout: 5))
  }

  @MainActor
  func testTheSnoozedBandIsFoldedUnderTheListWithWhenEachRowComesBack() {
    let app = launch(stage: "snoozedrow")
    let band = header(app, "Snoozed")
    XCTAssertTrue(band.waitForExistence(timeout: 10))
    XCTAssertTrue(band.label.hasPrefix("Snoozed, 2"), band.label)
    XCTAssertTrue(band.label.contains("A snoozed thread is stopped on you"), band.label)
    XCTAssertFalse(row(app, "Migrate billing tables").exists, "folded")
    shot("32-snoozed-band-folded")
    band.tap()
    let billing = row(app, "Migrate billing tables")
    XCTAssertTrue(billing.waitForExistence(timeout: 5))
    XCTAssertTrue(billing.label.contains("Snoozed until"), billing.label)
    XCTAssertTrue(billing.label.contains("8:00 AM"), billing.label)
    shot("33-snoozed-band-rows")
    // A snoozed row's menu offers Unsnooze beside Snooze.
    billing.press(forDuration: 1.0)
    XCTAssertTrue(app.buttons["Unsnooze"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Snooze"].exists)
    shot("34-snoozed-row-menu")
    app.buttons["Unsnooze"].tap()
    XCTAssertTrue(text(app, "Unsnoozed").waitForExistence(timeout: 5))
    XCTAssertTrue(header(app, "Stopped on you").waitForExistence(timeout: 5))
    XCTAssertTrue(header(app, "Snoozed").label.hasPrefix("Snoozed, 1"))
  }
}
