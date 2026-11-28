import XCTest

/// More of acting on rows, on the stand-in computer: the title while picking, a refusal inside an act on several
/// rows, the thread's line over a page the person moved, and the row's spoken actions. With SHOTS_DIR set
/// (TEST_RUNNER_SHOTS_DIR on the command line) each state is also saved as a picture, named with SHOTS_LOOK.
final class RowActionMoreUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  @MainActor
  private func launch(stage: String = "none", open: String? = nil, more: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
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

  @MainActor
  private func shot(_ name: String) {
    guard let folder = ProcessInfo.processInfo.environment["SHOTS_DIR"], !folder.isEmpty else { return }
    let look = ProcessInfo.processInfo.environment["SHOTS_LOOK"] ?? "light"
    usleep(600_000)
    try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name)-\(look).png"))
  }

  // MARK: Picking

  /// While picking, the large title says how many are picked, in the place "Inbox" stood: no empty band, and
  /// nothing on the page moves as picking starts or ends.
  @MainActor
  func testThePicksCountIsTheLargeTitleAndNothingMoves() {
    let app = launch()
    let retry = row(app, "Retry logic for the relay client")
    XCTAssertTrue(retry.waitForExistence(timeout: 10))
    let first = header(app, "Stopped on you")
    let top = first.frame.minY
    let inbox = app.navigationBars["Inbox"].staticTexts["Inbox"]
    let titleFrame = inbox.frame
    retry.press(forDuration: 1.0)
    app.buttons["Select"].tap()
    let title = app.navigationBars.staticTexts["1 selected"]
    XCTAssertTrue(title.waitForExistence(timeout: 5), "the count is the title")
    XCTAssertEqual(title.frame.minY, titleFrame.minY, accuracy: 2, "where the large title stood")
    XCTAssertGreaterThan(title.frame.height, 30, "large, not a small line in the bar")
    XCTAssertEqual(first.frame.minY, top, accuracy: 1, "the list did not move")
    row(app, "Checkout redesign").tap()
    row(app, "Docs search is slow").tap()
    XCTAssertTrue(app.navigationBars.staticTexts["3 selected"].waitForExistence(timeout: 5))
    shot("43-select-mode")
    app.buttons["Done"].tap()
    XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 5))
    sleep(1)
    XCTAssertEqual(first.frame.minY, top, accuracy: 1, "nor after Done")
  }

  // MARK: A refusal inside an act on several rows

  /// Three rows archived, one refused by something between the phone and the computer: the toast says so and keeps
  /// its Undo, and Undo brings back the two that were archived.
  @MainActor
  func testABulkArchiveWithOneRefusedKeepsItsUndo() {
    let app = launch(stage: "archiverefused")
    let retry = row(app, "Retry logic for the relay client")
    XCTAssertTrue(retry.waitForExistence(timeout: 10))
    retry.press(forDuration: 1.0)
    app.buttons["Select"].tap()
    row(app, "Checkout redesign").tap()
    row(app, "Onboarding copy").tap()
    XCTAssertTrue(app.navigationBars.staticTexts["3 selected"].waitForExistence(timeout: 5))
    app.buttons["Archive"].tap()
    XCTAssertTrue(text(app, "Archived 2").waitForExistence(timeout: 5), "the toast counts what was taken")
    XCTAssertTrue(text(app, "1 not archived").exists)
    XCTAssertFalse(text(app, "did not change").exists, "one line: the count, never the reason")
    XCTAssertTrue(app.buttons["Undo"].exists, "the Undo stays")
    shot("44-bulk-archive-one-refused")
    // The refused row is back in the list; the two taken are not.
    XCTAssertTrue(row(app, "Checkout redesign").waitForExistence(timeout: 5))
    XCTAssertFalse(row(app, "Onboarding copy").exists)
    app.buttons["Undo"].tap()
    XCTAssertTrue(row(app, "Onboarding copy").waitForExistence(timeout: 5))
    XCTAssertTrue(row(app, "Retry logic for the relay client").exists)
  }

  // MARK: The thread's line over a page the person moved

  /// Read up the middle of a long thread, then snooze it: the words first on screen are still there, moved down by
  /// the line's height and not under it; Unsnooze takes the line away and the words go back where they were.
  @MainActor
  func testTheThreadsLineKeepsAMovedPageInPlace() {
    let app = launch(stage: "long", open: "msg_STANDIN0000000000000009")
    let more = app.buttons["More"]
    XCTAssertTrue(more.waitForExistence(timeout: 15))
    sleep(2)
    for _ in 0..<3 { app.swipeDown(velocity: .slow) }
    sleep(2)
    let bar = app.navigationBars.firstMatch.frame
    let page = app.scrollViews.firstMatch
    // The first words whole on screen under the title bar.
    guard let first = page.staticTexts.allElementsBoundByIndex.first(where: { $0.frame.minY > bar.maxY + 8 && $0.frame.minY < bar.maxY + 300 && !$0.label.isEmpty }) else {
      return XCTFail("no words on screen")
    }
    let words = first.label
    let rested = first.frame.minY
    shot("45-thread-moved-before-line")

    more.tap()
    app.buttons["Snooze"].tap()
    app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Tomorrow")).firstMatch.tap()
    let line = text(app, "Snoozed until")
    XCTAssertTrue(line.waitForExistence(timeout: 5))
    sleep(1)
    // The line's whole band: from the title bar to under its Unsnooze button and hairline.
    let bottom = max(line.frame.maxY, app.buttons["Unsnooze"].firstMatch.frame.maxY)
    let height = bottom - bar.maxY
    let moved = page.staticTexts.matching(NSPredicate(format: "label == %@", words)).allElementsBoundByIndex.map(\.frame.minY)
    XCTAssertTrue(moved.contains { abs($0 - rested - height) <= 3 }, "moved down by the line (\(height)): was \(rested), now \(moved)")
    XCTAssertTrue(moved.contains { $0 >= bottom - 1 }, "not under the line")
    shot("46-thread-moved-with-line")

    app.buttons["Unsnooze"].firstMatch.tap()
    XCTAssertTrue(text(app, "Unsnoozed").waitForExistence(timeout: 5))
    XCTAssertFalse(line.exists)
    sleep(1)
    let back = page.staticTexts.matching(NSPredicate(format: "label == %@", words)).allElementsBoundByIndex.map(\.frame.minY)
    XCTAssertTrue(back.contains { abs($0 - rested) <= 2 }, "back where it was: \(rested), now \(back)")
  }

  // MARK: The row's spoken actions

  /// The element VoiceOver lands on for a row (the row read as one) carries the menu's items as its actions:
  /// read from the tree VoiceOver reads, since XCUITest cannot list an element's actions.
  @MainActor
  func testTheRowsCombinedElementCarriesItsSpokenActions() {
    var app = launch(more: ["-a11yProbe", "Retry logic for the relay client"])
    XCTAssertTrue(row(app, "Retry logic for the relay client").waitForExistence(timeout: 10))
    let probe = app.buttons["a11y-probe"]
    XCTAssertTrue(probe.waitForExistence(timeout: 5))
    probe.tap()
    let said = probe.label
    for action in ["Star thread", "Add to Priority", "Copy link", "Copy thread ID", "Snooze, Tomorrow", "Snooze, Pick a time", "Select"] {
      XCTAssertTrue(said.contains(action), "\(action) in \(said)")
    }
    XCTAssertFalse(said.contains("Move back"), "an unread row has nothing to move back")
    app.terminate()

    // A read row in Quiet: Move back too, as its menu offers it.
    app = launch(stage: "readrow", more: ["-a11yProbe", "Flaky upload test"])
    app.swipeUp()
    header(app, "Quiet").tap()
    XCTAssertTrue(row(app, "Flaky upload test").waitForExistence(timeout: 5))
    let again = app.buttons["a11y-probe"]
    again.tap()
    XCTAssertTrue(again.label.contains("Move back"), again.label)
  }
}
