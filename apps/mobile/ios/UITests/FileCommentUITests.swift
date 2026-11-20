import XCTest

/// Commenting on a thread's files (FLOWS 7): words of a document, lines of code, marks on a picture, a pin on a
/// page; the comments listed, changed and removed before they are sent; and the reply that carries them. On the
/// stand-in computer; pictures as in FileUITests.
final class FileCommentUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  private static let thread = "msg_STANDIN0000000000000060"

  @MainActor
  private func launch(stage: String = "files", more: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-standIn", "YES", "-AppleLanguages", "(en)", "-stage", stage, "-open", Self.thread, "-resetFolds", "YES"] + more
    app.launch()
    XCTAssertTrue(app.buttons["file/canary.html"].waitForExistence(timeout: 40))
    return app
  }

  @MainActor
  private func shot(_ name: String) {
    guard let folder = ProcessInfo.processInfo.environment["SHOTS_DIR"], !folder.isEmpty else { return }
    let look = ProcessInfo.processInfo.environment["SHOTS_LOOK"] ?? "light"
    usleep(700_000)
    try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: folder).appendingPathComponent("\(name)-\(look).png"))
  }

  @MainActor
  private func tile(_ app: XCUIApplication, _ name: String, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
    let found = app.buttons["file/\(name)"]
    var tries = 0
    while !(found.exists && found.isHittable), tries < 8 {
      app.swipeDown(velocity: .slow)
      tries += 1
    }
    XCTAssertTrue(found.exists && found.isHittable, name, file: file, line: line)
    return found
  }

  /// The words of a document that hold `text`.
  @MainActor
  private func words(_ app: XCUIApplication, _ text: String) -> XCUIElement {
    app.textViews.containing(NSPredicate(format: "value CONTAINS %@", text)).firstMatch
  }

  /// Write a comment in the field at the foot and keep it.
  @MainActor
  private func keep(_ app: XCUIApplication, _ text: String, file: StaticString = #filePath, line: UInt = #line) {
    let field = app.textViews["comment-field"].exists ? app.textViews["comment-field"] : app.textFields["comment-field"]
    XCTAssertTrue(field.waitForExistence(timeout: 5), "the comment field", file: file, line: line)
    field.tap()
    field.typeText(text)
  }

  @MainActor
  private func count(_ app: XCUIApplication, _ words: String, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label == %@", words)).firstMatch.waitForExistence(timeout: 5), words, file: file, line: line)
  }

  // MARK: A document

  @MainActor
  func testWordsOfADocumentAreCommentedOnAndRideTheReply() {
    let app = launch()
    tile(app, "retry-plan.md").tap()
    let paragraph = words(app, "The client drops its socket")
    XCTAssertTrue(paragraph.waitForExistence(timeout: 20))
    // No comment yet: nothing stands at the foot of a document.
    XCTAssertFalse(app.buttons["comment-keep"].exists)

    // A long press picks a word, with the system's handles and menu; Comment is first in it.
    paragraph.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.1)).press(forDuration: 1.1)
    let comment = app.menuItems["Comment"]
    XCTAssertTrue(comment.waitForExistence(timeout: 5))
    XCTAssertTrue(app.menuItems["Copy"].exists, "the system's own actions stay")
    XCTAssertLessThan(comment.frame.minX, app.menuItems["Copy"].frame.minX, "Comment comes first")
    shot("01-document-selection-menu")
    comment.tap()

    // The field rises over the keyboard, with the words picked across its top.
    let quote = app.staticTexts["comment-quote"]
    XCTAssertTrue(quote.waitForExistence(timeout: 5))
    XCTAssertFalse(quote.label.isEmpty)
    XCTAssertFalse(app.buttons["comment-keep"].isEnabled, "nothing to keep until there are words")
    keep(app, "Say which client: the phone's or the desktop's.")
    XCTAssertTrue(app.buttons["comment-keep"].isEnabled)
    let keyboard = app.keyboards.firstMatch
    XCTAssertLessThanOrEqual(app.buttons["comment-keep"].frame.maxY, keyboard.frame.minY + 1, "the field stands over the keyboard")
    shot("02-document-comment-field")
    app.buttons["comment-keep"].tap()

    // Kept: the bar counts it, and the field is gone.
    count(app, "1 comment")
    XCTAssertFalse(app.staticTexts["comment-quote"].exists)
    shot("03-document-commented")

    // Done: the thread's reply field says a comment rides the next Send, and Send has something to send.
    app.buttons["Done"].tap()
    XCTAssertTrue(app.buttons["thread-comments"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.buttons["thread-comments"].label, "1 comment")
    XCTAssertTrue(app.buttons["Send"].isEnabled)
    shot("04-thread-comment-rides")
    app.buttons["Send"].tap()

    // Sent: the reply holds the window's feedback text, and nothing waits.
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Feedback on the attached files'")).firstMatch.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Say which client'")).firstMatch.exists)
    XCTAssertFalse(app.buttons["thread-comments"].exists)
  }

  // MARK: Code

  @MainActor
  func testALineOfCodeAndARunOfLinesTakeACommentThatIsChangedAndRemoved() {
    let app = launch()
    tile(app, "client.ts").tap()
    let third = app.descendants(matching: .any).matching(identifier: "line/3").firstMatch
    XCTAssertTrue(third.waitForExistence(timeout: 20))
    third.tap()
    let quote = app.staticTexts["comment-quote"]
    XCTAssertTrue(quote.waitForExistence(timeout: 5))
    XCTAssertTrue(quote.label.hasPrefix("3 "), quote.label)
    XCTAssertTrue(quote.label.contains("const CAP_MS"))
    // Another line while the comment is being written: the run from the one to the other.
    app.descendants(matching: .any).matching(identifier: "line/4").firstMatch.tap()
    XCTAssertTrue(quote.label.hasPrefix("3–4 "), quote.label)
    keep(app, "Lower both on a metered connection?")
    shot("05-code-lines-comment-field")
    app.buttons["comment-keep"].tap()
    count(app, "1 comment")
    shot("06-code-commented")

    // A touch on a commented line opens its comment, to change its words.
    app.descendants(matching: .any).matching(identifier: "line/4").firstMatch.tap()
    let field = app.textViews["comment-field"].exists ? app.textViews["comment-field"] : app.textFields["comment-field"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    XCTAssertEqual(field.value as? String, "Lower both on a metered connection?")
    field.tap()
    field.typeText(" On cellular.")
    app.buttons["comment-keep"].tap()

    // The list: the comment with its lines, under its file's name; a swipe removes it.
    app.buttons["file-comments"].firstMatch.tap()
    let row = app.buttons.matching(NSPredicate(format: "label CONTAINS 'On cellular.'")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    XCTAssertTrue(row.label.contains("3–4"), row.label)
    XCTAssertTrue(app.staticTexts["client.ts"].exists)
    shot("07-comments-list")
    row.swipeLeft()
    XCTAssertTrue(app.buttons["Remove"].waitForExistence(timeout: 5))
    app.buttons["Remove"].tap()
    // Nothing waits: the list closes, and the bar counts nothing.
    XCTAssertTrue(app.scrollViews["file-code"].waitForExistence(timeout: 5))
    usleep(600_000)
    XCTAssertFalse(app.buttons["file-comments"].exists)
  }

  // MARK: A picture

  @MainActor
  func testAPictureIsPinnedAndDrawnOnAndTheMarksStayOnItsPixelsWhenLookedInto() {
    let app = launch()
    tile(app, "reconnect-flamegraph.png").tap()
    let picture = app.images.matching(identifier: "file-picture").firstMatch
    XCTAssertTrue(picture.waitForExistence(timeout: 20))
    // The field is at the foot of a picture from the start (a comment can be on the whole of it), with the pencil.
    XCTAssertTrue(app.buttons["picture-mark"].waitForExistence(timeout: 5))
    shot("08-picture-foot")
    app.buttons["picture-mark"].tap()

    // A touch pins a spot; a drag draws a line. Neither moves the picture or steps to the next file.
    picture.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.5)).tap()
    let marks = app.descendants(matching: .any).matching(identifier: "picture-marks").firstMatch
    XCTAssertTrue(marks.waitForExistence(timeout: 5))
    XCTAssertEqual(marks.value as? String, "1")
    picture.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.3)).press(forDuration: 0.05, thenDragTo: picture.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.7)))
    XCTAssertEqual(marks.value as? String, "2")
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'reconnect-flamegraph.png'")).firstMatch.exists || app.navigationBars.firstMatch.exists, "still on the picture")
    // The last mark is taken back, and drawn again.
    app.buttons["picture-undo"].tap()
    XCTAssertEqual(marks.value as? String, "1")
    picture.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.3)).press(forDuration: 0.05, thenDragTo: picture.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.7)))
    XCTAssertEqual(marks.value as? String, "2")
    shot("09-picture-marked-whole")

    // The marks are on the picture's own pixels: looked into (two fingers, the one finger draws), they are the
    // picture's size and in its place still.
    XCTAssertEqual(marks.frame.width, picture.frame.width, accuracy: 1)
    let whole = picture.frame.width
    picture.pinch(withScale: 3, velocity: 2)
    usleep(700_000)
    XCTAssertGreaterThan(picture.frame.width, whole * 1.5, "two fingers look into the picture while marking")
    XCTAssertEqual(marks.frame.width, picture.frame.width, accuracy: 1)
    XCTAssertEqual(marks.frame.minX, picture.frame.minX, accuracy: 1)
    XCTAssertEqual(marks.frame.minY, picture.frame.minY, accuracy: 1)
    shot("10-picture-marked-looked-into")

    // The comment: the drawing with words.
    keep(app, "The wide bar here is the retry loop.")
    shot("11-picture-comment-field")
    app.buttons["comment-keep"].tap()
    count(app, "1 comment")
    XCTAssertEqual(marks.value as? String, "2", "the kept comment's marks stay on the picture")
    XCTAssertFalse(app.buttons["picture-undo"].exists, "nothing is drawn and not yet kept")
    shot("12-picture-commented")
  }

  // MARK: A page

  @MainActor
  func testAPageTakesAPinWhileCommentingAndItsOwnTouchesOtherwise() {
    let app = launch()
    tile(app, "canary.html").tap()
    let page = app.webViews["file-page"]
    XCTAssertTrue(page.waitForExistence(timeout: 20))
    let refresh = page.buttons["Refresh"]
    XCTAssertTrue(refresh.waitForExistence(timeout: 10))
    let mode = app.segmentedControls["page-mode"]
    XCTAssertTrue(mode.waitForExistence(timeout: 5))
    shot("13-page-use")

    // Comment: a touch on the page's button pins it, and the button is not pressed.
    // The page runs under the foot, and its own end scrolls clear of it: its last button is not under the switch.
    page.swipeUp()
    usleep(800_000)
    XCTAssertLessThanOrEqual(refresh.frame.maxY, mode.frame.minY, "the page's end rests over the foot")
    mode.buttons["Comment"].tap()
    usleep(400_000)
    refresh.tap()
    let quote = app.staticTexts["comment-quote"]
    XCTAssertTrue(quote.waitForExistence(timeout: 5))
    XCTAssertEqual(quote.label, "Refresh")
    XCTAssertFalse(page.buttons["Refreshed"].exists, "the page did not take the touch")
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "page-pin").firstMatch.exists, "the spot is pinned as it is written about")
    keep(app, "This does nothing on a phone.")
    shot("14-page-pin-comment-field")
    app.buttons["comment-keep"].tap()
    count(app, "1 comment")
    let pin = app.buttons.matching(identifier: "page-pin").firstMatch
    XCTAssertTrue(pin.waitForExistence(timeout: 5))
    XCTAssertEqual(pin.label, "This does nothing on a phone.")
    shot("15-page-pinned")

    // The pin is on its spot of the page: it moves with the page.
    let before = pin.frame.midY
    page.swipeDown(velocity: .slow)
    usleep(800_000)
    XCTAssertGreaterThan(pin.frame.midY, before + 20, "the pin moved with the page")
    page.swipeUp()
    usleep(800_000)

    // Use the page: its button is its own again.
    mode.buttons["Use the page"].tap()
    usleep(400_000)
    refresh.tap()
    XCTAssertTrue(page.buttons["Refreshed"].waitForExistence(timeout: 5))
  }

  // MARK: The list, and away

  @MainActor
  func testWaitingCommentsAreListedFromTheThreadAndEachOpensWhereItIs() {
    let app = launch(stage: "files,commented")
    let strip = app.buttons["thread-comments"]
    XCTAssertTrue(strip.waitForExistence(timeout: 20))
    XCTAssertEqual(strip.label, "3 comments")
    shot("16-thread-three-comments")
    strip.tap()
    // File by file, in the order made.
    XCTAssertTrue(app.staticTexts["retry-plan.md"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["client.ts"].exists)
    let onCode = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Lower both on a metered connection?'")).firstMatch
    XCTAssertTrue(onCode.exists)
    shot("17-thread-comments-list")

    // A touch opens the comment's file, at the comment.
    onCode.tap()
    XCTAssertTrue(app.scrollViews["file-code"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "line/3").firstMatch.waitForExistence(timeout: 5))
    count(app, "3 comments")
    shot("18-code-opened-at-comment")

    // From the file, the same list; Edit the comment opens its words in the field, on its own file.
    app.buttons["file-comments"].firstMatch.tap()
    let onPlan = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Say which client'")).firstMatch
    XCTAssertTrue(onPlan.waitForExistence(timeout: 5))
    onPlan.swipeLeft()
    XCTAssertTrue(app.buttons["Edit the comment"].waitForExistence(timeout: 5))
    shot("19-comment-row-actions")
    app.buttons["Edit the comment"].tap()
    XCTAssertTrue(app.scrollViews["file-document"].waitForExistence(timeout: 10))
    let field = app.textViews["comment-field"].exists ? app.textViews["comment-field"] : app.textFields["comment-field"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    XCTAssertEqual(field.value as? String, "Say which client: the phone's or the desktop's.")
    XCTAssertEqual(app.staticTexts["comment-quote"].label, "client drops its socket")
    shot("20-document-edit-comment")
  }

  @MainActor
  func testACommentMadeWithTheComputerAwayIsKeptAndWaitsWithItsReply() {
    let app = launch(stage: "files,fileskept,away")
    tile(app, "retry-plan.md").tap()
    let paragraph = words(app, "The client drops its socket")
    XCTAssertTrue(paragraph.waitForExistence(timeout: 20))
    paragraph.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.1)).press(forDuration: 1.1)
    XCTAssertTrue(app.menuItems["Comment"].waitForExistence(timeout: 5))
    app.menuItems["Comment"].tap()
    keep(app, "Which client?")
    app.buttons["comment-keep"].tap()
    count(app, "1 comment")
    shot("21-away-document-commented")
    app.buttons["Done"].tap()
    XCTAssertTrue(app.buttons["thread-comments"].waitForExistence(timeout: 10))
    app.buttons["Send"].tap()
    // It waits on the phone, with the comment in it; nothing more waits to be sent.
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Will send when'")).firstMatch.waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["thread-comments"].exists)
    shot("22-away-reply-waits")
  }
}
