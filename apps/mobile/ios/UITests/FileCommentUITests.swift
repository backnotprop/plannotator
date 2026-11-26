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
  func testVoiceOversCommentActionPinsTheMiddleOfThePageTheFirstTime() {
    let app = launch(more: ["-voiceActions", "YES"])
    // Another page is laid out beside this one first: the action is this page's.
    tile(app, "canary.html").tap()
    let page = app.webViews["file-page"]
    XCTAssertTrue(page.waitForExistence(timeout: 20))
    XCTAssertTrue(page.buttons["Refresh"].waitForExistence(timeout: 10))
    XCTAssertEqual(app.segmentedControls["page-mode"].buttons["Use the page"].isSelected, true)
    // Once, with Comment off: it turns Comment on and pins the middle of the page.
    app.buttons["voice-comment"].tap()
    let quote = app.staticTexts["comment-quote"]
    XCTAssertTrue(quote.waitForExistence(timeout: 5), "the first activation pinned something")
    XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "page-pin").firstMatch.exists)
  }

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
    let commented = app.descendants(matching: .any).matching(identifier: "line/3").firstMatch
    XCTAssertTrue(commented.waitForExistence(timeout: 5))
    usleep(900_000)
    // The file under the title is the one on screen: the code, with the commented line in view.
    let screen = app.windows.firstMatch.frame
    XCTAssertTrue(screen.contains(CGPoint(x: commented.frame.midX, y: commented.frame.midY)), "the comment's file is the one on screen: \(commented.frame)")
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'const CAP_MS'")).firstMatch.isHittable)
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
    XCTAssertTrue(words(app, "The client drops its socket").isHittable, "the plan is the file on screen")
    shot("20-document-edit-comment")
  }

  @MainActor
  func testAChangeToACommentThatAlreadyWentIsNotKeptAndTheEditorSaysSo() {
    // The comments go in a Send while the person changes one's words (`sentwhileediting`).
    let app = launch(stage: "files,commented,sentwhileediting")
    let strip = app.buttons["thread-comments"]
    XCTAssertTrue(strip.waitForExistence(timeout: 20))
    strip.tap()
    let onPlan = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Say which client'")).firstMatch
    XCTAssertTrue(onPlan.waitForExistence(timeout: 5))
    onPlan.swipeLeft()
    XCTAssertTrue(app.buttons["Edit the comment"].waitForExistence(timeout: 5))
    app.buttons["Edit the comment"].tap()
    let field = app.textViews["comment-field"].exists ? app.textViews["comment-field"] : app.textFields["comment-field"]
    XCTAssertTrue(field.waitForExistence(timeout: 10))
    // The Send went: no comment waits any more.
    let listed = app.buttons["file-comments"]
    let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: listed)
    wait(for: [gone], timeout: 20)

    field.tap()
    field.typeText(" Both.")
    app.buttons["comment-keep"].tap()
    let line = app.descendants(matching: .any).matching(identifier: "comment-already-sent").firstMatch
    XCTAssertTrue(line.waitForExistence(timeout: 5), "the editor says the change was not kept")
    XCTAssertEqual(line.label, "Not saved. This comment was already sent.")
    XCTAssertEqual(field.value as? String, "Say which client: the phone's or the desktop's. Both.", "the words stay")
    XCTAssertTrue(app.staticTexts["comment-quote"].exists, "the editor stays open")
    shot("r6-01-editor-already-sent")

    // Changing the words again takes the line away.
    field.tap()
    field.typeText("!")
    XCTAssertFalse(line.waitForExistence(timeout: 1))
    // Kept again: still not kept, and said again; closing the editor takes it away.
    app.buttons["comment-keep"].tap()
    XCTAssertTrue(line.waitForExistence(timeout: 5))
    app.buttons["Cancel"].firstMatch.tap()
    XCTAssertFalse(line.waitForExistence(timeout: 1))
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

  // MARK: A drawing away from the computer's network

  @MainActor
  func testASendOfOnlyADrawingAwayFromTheNetworkQueuesNothingAndWordsMakeSendWorkAgain() {
    let app = launch(stage: "files,drawingonly")
    let strip = app.buttons["thread-comments"]
    XCTAssertTrue(strip.waitForExistence(timeout: 20))
    XCTAssertEqual(strip.label, "1 comment", "the drawing is counted")
    let send = app.buttons["Send"]
    XCTAssertTrue(send.isEnabled, "Send can be pressed for the drawing")
    XCTAssertFalse(app.staticTexts["thread-needs-network"].exists, "the thread says nothing before Send")
    send.tap()
    // Nothing is queued: no waiting message, and the thread says why the drawing stays.
    let line = app.staticTexts["thread-needs-network"]
    XCTAssertTrue(line.waitForExistence(timeout: 10))
    XCTAssertEqual(line.label, "1 comment needs your computer's network")
    XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Will send when'")).firstMatch.exists, "nothing waits in the outbox")
    XCTAssertFalse(send.isEnabled, "Send has nothing more to do")
    XCTAssertEqual(strip.label, "1 comment", "still in the list, and counted: the line and the strip agree")
    shot("r5b-02-thread-line")

    // The comment is still in the list, marked, and still the person's to change.
    strip.tap()
    let row = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Is this gap the handshake?'")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    XCTAssertTrue(row.label.contains("Needs your computer's network"), row.label)
    XCTAssertFalse(row.label.contains("Will send"), row.label)
    shot("r5b-01-list-marked")
    app.navigationBars["1 comment"].buttons["Done"].tap()

    // Words make Send work again; they go now, and the drawing stays behind, marked.
    let field = app.textViews["Reply"].exists ? app.textViews["Reply"] : app.textFields["Reply"]
    XCTAssertTrue(field.waitForExistence(timeout: 5))
    field.tap()
    field.typeText("Ship it, the gap is the handshake.")
    XCTAssertTrue(send.isEnabled, "words make Send work again")
    shot("r5b-03-words-send-ready")
    send.tap()
    XCTAssertTrue(app.staticTexts["Ship it, the gap is the handshake."].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["thread-needs-network"].waitForExistence(timeout: 5), "the drawing stays behind")
    XCTAssertEqual(strip.label, "1 comment", "in the list, counted")
    shot("r5b-04-words-sent-drawing-stays")

    // Still the person's to change there: a long press offers Edit and Remove.
    strip.tap()
    let listed = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Is this gap the handshake?'")).firstMatch
    XCTAssertTrue(listed.waitForExistence(timeout: 5))
    XCTAssertTrue(listed.label.contains("Needs your computer's network"), listed.label)
    listed.press(forDuration: 1.0)
    XCTAssertTrue(app.buttons["Edit the comment"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Remove"].exists)
    shot("r5b-05-list-edit-remove")
    app.buttons["Remove"].tap()
    // Removed, it leaves the list, the strip and the line.
    XCTAssertFalse(app.staticTexts["thread-needs-network"].waitForExistence(timeout: 3))
  }

  @MainActor
  func testAThreadWhoseOnlyWorkIsAWaitingDrawingSaysNoWillSend() {
    let app = launch(stage: "files,drawingonly,drawingsent")
    XCTAssertTrue(app.staticTexts["thread-needs-network"].waitForExistence(timeout: 20))
    app.navigationBars.buttons.element(boundBy: 0).tap()
    let row = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Relay retries: plan and evidence")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 10))
    XCTAssertFalse(row.label.contains("Will send"), row.label)
    XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Will send'")).firstMatch.exists)
    shot("r5b-06-list-row-no-will-send")
  }

  @MainActor
  func testWithTheComputerAwayAWaitingDrawingAloneSaysNoWillSend() {
    let app = launch(stage: "files,drawingonly,drawingsent,away")
    XCTAssertTrue(app.staticTexts["thread-needs-network"].waitForExistence(timeout: 20))
    app.navigationBars.buttons.element(boundBy: 0).tap()
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH \"Can't reach Work Mac\"")).firstMatch.waitForExistence(timeout: 10), "the computer is away")
    XCTAssertFalse(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Will send'")).firstMatch.exists, "but nothing is queued to send")
    shot("r5b-07-away-no-will-send")
  }

  @MainActor
  func testADrawingThatWentByItselfIsTheYouMessageWithItsComment() {
    let app = launch(stage: "files,drawingonly,drawingsent,drawingback")
    // Gone from the list and the line; it is the person's message at the end of the thread.
    XCTAssertTrue(app.staticTexts["Feedback on the attached files"].waitForExistence(timeout: 20), "the person's message carries the comment")
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Is this gap the handshake?'")).firstMatch.exists)
    XCTAssertFalse(app.staticTexts["thread-needs-network"].exists)
    XCTAssertFalse(app.buttons["thread-comments"].exists)
    app.swipeUp()
    shot("r5b-08-went-by-itself")
  }

  // MARK: What a Send carries, and taking a change back

  /// The toast's Undo (the picture's own Undo is another button).
  @MainActor
  private func toastUndo(_ app: XCUIApplication) -> XCUIElement {
    app.buttons.matching(NSPredicate(format: "label == 'Undo' AND identifier != 'picture-undo'")).firstMatch
  }

  @MainActor
  func testACommentTheComputerDidNotKeepIsListedAndRidesNoSendAndARemovalIsUndone() {
    let app = launch(stage: "files,commented,commentstanding")
    // The strip and the tiles count what the next Send carries and the drawing that waits for the computer's
    // network (it is in the list, marked): four comments, not the drawing the computer refused.
    let strip = app.buttons["thread-comments"]
    XCTAssertTrue(strip.waitForExistence(timeout: 20))
    XCTAssertEqual(strip.label, "4 comments")
    XCTAssertTrue(tile(app, "retry-plan.md").label.contains("2 comments"), tile(app, "retry-plan.md").label)
    XCTAssertTrue(tile(app, "reconnect-flamegraph.png").label.contains("1 comment"), tile(app, "reconnect-flamegraph.png").label)
    shot("r3-01-tiles-count-comments")
    strip.tap()
    // Every comment is listed; the ones that do not go say why, and the foot says what goes.
    XCTAssertTrue(app.staticTexts["reconnect-flamegraph.png"].waitForExistence(timeout: 5))
    let refused = app.buttons.matching(NSPredicate(format: "label CONTAINS 'The flat top is the cap.'")).firstMatch
    XCTAssertTrue(refused.label.contains("The comment was not saved."), refused.label)
    let waits = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Is this gap the handshake?'")).firstMatch
    XCTAssertTrue(waits.label.contains("Needs your computer's network"), waits.label)
    XCTAssertFalse(waits.label.contains("Will send"), waits.label)
    let foot = app.staticTexts["comments-ride"]
    if !foot.exists { app.swipeUp() }
    XCTAssertTrue(foot.waitForExistence(timeout: 5))
    XCTAssertEqual(foot.label, "3 comments ride your next Send to Claude Code.")
    shot("r3-02-list-drawing-waits-rides-no-send")

    // A long press offers Edit the comment and Remove; Remove says so, with Undo, and Undo brings it back.
    let onPlan = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Say which client'")).firstMatch
    if !onPlan.isHittable { app.swipeDown() }
    onPlan.press(forDuration: 1.0)
    XCTAssertTrue(app.buttons["Edit the comment"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Remove"].exists)
    shot("r3-03-comment-row-long-press")
    app.buttons["Remove"].tap()
    XCTAssertTrue(app.staticTexts["Removed"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label CONTAINS 'Say which client'")).firstMatch.exists)
    shot("r3-04-removed-with-undo")
    toastUndo(app).tap()
    let back = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Say which client'")).firstMatch
    XCTAssertTrue(back.waitForExistence(timeout: 5), "Undo brought the comment back")
    XCTAssertTrue(back.label.contains("client drops its socket"), "on the same words: \(back.label)")
    app.navigationBars["5 comments"].buttons["Done"].tap()
    XCTAssertEqual(app.buttons["thread-comments"].label, "4 comments")

    // The drawing that waits is drawn on the picture.
    app.buttons["thread-comments"].tap()
    app.buttons.matching(NSPredicate(format: "label CONTAINS 'Is this gap the handshake?'")).firstMatch.tap()
    let picture = app.images.matching(identifier: "file-picture").firstMatch
    XCTAssertTrue(picture.waitForExistence(timeout: 20))
    shot("r3-05-picture-drawing-waits")
  }

  @MainActor
  func testAWholeFileTakesAGlobalCommentAndADrawingAddedCanBeTakenBack() {
    let app = launch()
    tile(app, "retry-plan.md").tap()
    XCTAssertTrue(app.scrollViews["file-document"].waitForExistence(timeout: 20))
    app.buttons["file-more"].tap()
    XCTAssertTrue(app.buttons["Global comment"].waitForExistence(timeout: 5))
    shot("r2-06-more-global-comment")
    app.buttons["Global comment"].tap()
    XCTAssertEqual(app.staticTexts["comment-quote"].label, "Global comment")
    keep(app, "Shorter, please.")
    app.buttons["comment-keep"].tap()
    count(app, "1 comment")
    app.buttons["file-comments"].firstMatch.tap()
    let row = app.buttons.matching(NSPredicate(format: "label CONTAINS 'Shorter, please.'")).firstMatch
    XCTAssertTrue(row.waitForExistence(timeout: 5))
    XCTAssertTrue(row.label.contains("Global comment"), row.label)
    XCTAssertEqual(app.staticTexts["comments-ride"].label, "1 comment rides your next Send to Claude Code.")
    shot("r2-07-global-comment-listed")
    app.navigationBars["1 comment"].buttons["Done"].tap()

    // A drawing kept on the picture: the window's toast, and Undo takes it off the reply and puts the marks back.
    XCTAssertTrue(app.buttons["file-more"].waitForExistence(timeout: 5))
    app.buttons["Done"].firstMatch.tap()
    tile(app, "reconnect-flamegraph.png").tap()
    let picture = app.images.matching(identifier: "file-picture").firstMatch
    XCTAssertTrue(picture.waitForExistence(timeout: 20))
    app.buttons["picture-mark"].tap()
    picture.coordinate(withNormalizedOffset: CGVector(dx: 0.55, dy: 0.3)).press(forDuration: 0.05, thenDragTo: picture.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.7)))
    app.buttons["comment-keep"].tap()
    count(app, "2 comments")
    // Shown as the phone's short words, read as the window's whole sentence.
    XCTAssertTrue(app.staticTexts["Markup added to your reply."].waitForExistence(timeout: 5))
    shot("r2-08-drawing-added-toast")
    toastUndo(app).tap()
    count(app, "1 comment")
    XCTAssertTrue(app.buttons["picture-undo"].waitForExistence(timeout: 5), "the marks are back on the picture, not kept")
  }

  @MainActor
  func testAReplyThatWaitsShowsALineForEachCommentItCarries() {
    let app = launch(stage: "files,commented,away")
    XCTAssertTrue(app.buttons["thread-comments"].waitForExistence(timeout: 20))
    app.buttons["Send"].tap()
    let line = app.descendants(matching: .any).matching(identifier: "held-comment").firstMatch
    XCTAssertTrue(line.waitForExistence(timeout: 10))
    let lines = app.descendants(matching: .any).matching(identifier: "held-comment")
    XCTAssertEqual(lines.count, 3)
    XCTAssertTrue(lines.element(boundBy: 2).label.contains("client.ts"), lines.element(boundBy: 2).label)
    XCTAssertTrue(lines.element(boundBy: 2).label.contains("3–4"), lines.element(boundBy: 2).label)
    shot("r2-09-held-reply-lines")
  }
}
