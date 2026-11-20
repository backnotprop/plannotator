import XCTest

/// The list and its row actions under the worst rows: the longest names, no words, emoji, right-to-left names, a
/// count past a thousand, a thousand rows, and the largest text size. Nothing may leave the screen or be cut off
/// where it can be touched. On the stand-in computer; pictures as in RowActionUITests.
final class RowBreakUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  private static let largest = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]

  @MainActor
  private func launch(stage: String, more: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-standIn", "YES", "-AppleLanguages", "(en)", "-stage", stage, "-resetFolds", "YES"] + more
    app.launch()
    XCTAssertTrue(app.navigationBars.firstMatch.waitForExistence(timeout: 30))
    return app
  }

  @MainActor
  private func row(_ app: XCUIApplication, _ title: String) -> XCUIElement {
    app.buttons.containing(NSPredicate(format: "label CONTAINS %@", title)).firstMatch
  }

  /// Bring a row onto the screen (the list builds its rows as it scrolls).
  @MainActor
  private func reach(_ app: XCUIApplication, _ title: String, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
    let found = row(app, title)
    var tries = 0
    while !(found.exists && found.isHittable), tries < 30 {
      app.swipeUp(velocity: .slow)
      tries += 1
    }
    XCTAssertTrue(found.exists && found.isHittable, title, file: file, line: line)
    return found
  }

  @MainActor
  private func top(_ app: XCUIApplication) {
    for _ in 0..<6 { app.swipeDown(velocity: .fast) }
  }

  @MainActor
  private func shot(_ name: String) {
    guard let folder = ProcessInfo.processInfo.environment["SHOTS_DIR"], !folder.isEmpty else { return }
    let look = ProcessInfo.processInfo.environment["SHOTS_LOOK"] ?? "light"
    usleep(600_000)
    try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name)-\(look).png"))
  }

  /// Inside the screen, left and right.
  @MainActor
  private func assertOnScreen(_ element: XCUIElement, _ what: String, in app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) {
    let screen = app.windows.firstMatch.frame
    XCTAssertGreaterThanOrEqual(element.frame.minX, screen.minX - 0.5, "\(what) starts on the screen", file: file, line: line)
    XCTAssertLessThanOrEqual(element.frame.maxX, screen.maxX + 0.5, "\(what) ends on the screen", file: file, line: line)
  }

  @MainActor
  private func walkWorstRows(_ app: XCUIApplication, _ prefix: String, menus: Bool) {
    // Every worst row is drawn, each inside the screen.
    for title in ["Migrate every billing table", "No words yet", "Launch checklist", "ترحيل جداول الفواتير", "A thousand questions", "Supercalifragilistic"] {
      top(app)
      assertOnScreen(reach(app, title), title, in: app)
    }
    top(app)
    _ = reach(app, "Migrate every billing table")
    shot("\(prefix)-01-list")

    // The longest row: its swipe and its menu still work, and the toast keeps Undo on the screen.
    let long = row(app, "Migrate every billing table")
    if menus {
      long.press(forDuration: 1.0)
      XCTAssertTrue(app.buttons["Star thread"].waitForExistence(timeout: 5))
      assertOnScreen(app.buttons["Star thread"], "the menu", in: app)
      shot("\(prefix)-02-menu")
      app.buttons["Star thread"].tap()
    }
    // A swipe to the left archives it.
    let again = reach(app, "Migrate every billing table, ")
    if menus { XCTAssertTrue(again.label.contains("Starred"), again.label) }
    // A swipe that fell short rests open on the button; one that missed the row is made again.
    let archive = app.buttons["Archive"]
    let undo = app.buttons["Undo"]
    for _ in 0..<3 where !undo.exists {
      row(app, "Migrate every billing table, ").swipeLeft(velocity: .fast)
      if archive.waitForExistence(timeout: 2) { archive.tap() }
      _ = undo.waitForExistence(timeout: 2)
    }
    XCTAssertTrue(undo.waitForExistence(timeout: 5))
    assertOnScreen(undo, "Undo", in: app)
    assertOnScreen(app.buttons["Dismiss"], "Dismiss", in: app)
    XCTAssertTrue(undo.isHittable)
    shot("\(prefix)-03-toast")
    undo.tap()
    XCTAssertFalse(undo.waitForExistence(timeout: 2), "used once")

    // A count past a thousand: the warning names it with its thousands apart.
    guard menus else { return }
    top(app)
    let many = reach(app, "A thousand questions")
    many.press(forDuration: 1.0)
    app.buttons["Mark read"].tap()
    let warning = app.alerts["Set aside 1,284 open questions?"]
    XCTAssertTrue(warning.waitForExistence(timeout: 5))
    shot("\(prefix)-04-warning")
    warning.buttons["Cancel"].tap()
  }

  @MainActor
  func testWorstRowsAtTheDefaultTextSize() {
    let app = launch(stage: "worst")
    walkWorstRows(app, "break", menus: true)
    app.swipeUp()
    shot("break-05-list-rest")
  }

  @MainActor
  func testWorstRowsAtTheLargestTextSize() {
    let app = launch(stage: "worst", more: Self.largest)
    // At this size the system's menu scrolls: the swipes are walked here, the menu at the default size.
    walkWorstRows(app, "break-largest", menus: false)
    app.swipeUp()
    shot("break-largest-05-list-rest")
  }

  @MainActor
  func testPickingAndSnoozingAtTheLargestTextSize() {
    let app = launch(stage: "starred,snoozedrow", more: Self.largest)
    shot("break-largest-06-starred")
    let retry = row(app, "Retry logic for the relay client")
    XCTAssertTrue(retry.waitForExistence(timeout: 10))
    retry.press(forDuration: 1.0)
    XCTAssertTrue(app.buttons["Snooze"].waitForExistence(timeout: 5))
    app.buttons["Snooze"].tap()
    XCTAssertTrue(app.buttons["Pick a time…"].waitForExistence(timeout: 5))
    shot("break-largest-07-snooze-times")
    app.buttons["Pick a time…"].tap()
    let go = app.buttons["Snooze"]
    XCTAssertTrue(app.pickerWheels.firstMatch.waitForExistence(timeout: 5))
    XCTAssertTrue(go.isHittable, "the sheet's button is on the screen at the largest size")
    shot("break-largest-08-pick-a-time")
    go.tap()
    let undo = app.buttons["Undo"]
    XCTAssertTrue(undo.waitForExistence(timeout: 5))
    assertOnScreen(undo, "Undo", in: app)
    shot("break-largest-09-snoozed-toast")

    // Picking: the bar's words and its actions stay on the screen.
    let checkout = row(app, "Checkout redesign")
    checkout.press(forDuration: 1.0)
    app.buttons["Select"].tap()
    XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 5))
    assertOnScreen(app.buttons["Done"], "Done", in: app)
    assertOnScreen(app.buttons["Archive"], "Archive", in: app)
    assertOnScreen(app.buttons["More"], "More", in: app)
    shot("break-largest-10-selecting")
  }

  @MainActor
  func testAThousandRowsScrollPickAndArchive() {
    let app = launch(stage: "thousand")
    // Their group says how many, with the thousands apart.
    let quiet = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "New since you looked, 1,00")).firstMatch
    XCTAssertTrue(quiet.waitForExistence(timeout: 30), "the group counts a thousand rows")
    shot("break-thousand-01-list")
    // Fling through them: the list stays up.
    for _ in 0..<6 { app.swipeUp(velocity: .fast) }
    XCTAssertTrue(app.navigationBars.firstMatch.exists)
    shot("break-thousand-02-scrolled")

    // Pick every row and archive them at once: one toast counts them, one Undo.
    top(app)
    let any = row(app, "Checkout redesign")
    XCTAssertTrue(any.waitForExistence(timeout: 5))
    any.press(forDuration: 1.0)
    app.buttons["Select"].tap()
    app.buttons["Select all"].tap()
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "1,00")).firstMatch.waitForExistence(timeout: 10))
    shot("break-thousand-03-all-picked")
    app.buttons["Archive"].tap()
    let toast = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Archived 1,00")).firstMatch
    XCTAssertTrue(toast.waitForExistence(timeout: 60), "one toast for all of them")
    XCTAssertTrue(app.buttons["Undo"].isHittable)
    shot("break-thousand-04-archived-toast")
  }
}
