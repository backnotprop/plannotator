import XCTest

/// Writing on the phone, part 2: `@` in the reply tags another agent, 👍 Looks good and its tray, and Take back. On
/// the stand-in computer; pictures as in WritingUITests (SHOTS_DIR, SHOTS_LOOK).
final class WritingTwoUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  private static let retry = "msg_STANDIN0000000000000003"
  private static let docs = "msg_STANDIN0000000000000004"
  private static let upload = "msg_STANDIN0000000000000005"
  private static let largest = ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"]

  @MainActor
  private func launch(open: String, more: [String] = []) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-standIn", "YES", "-AppleLanguages", "(en)", "-resetFolds", "YES", "-open", open] + more
    app.launch()
    return app
  }

  @MainActor
  private func shot(_ name: String) {
    guard let folder = ProcessInfo.processInfo.environment["SHOTS_DIR"], !folder.isEmpty else { return }
    let look = ProcessInfo.processInfo.environment["SHOTS_LOOK"] ?? "light"
    usleep(700_000)
    let file = URL(fileURLWithPath: folder).appendingPathComponent("\(name)-\(look).png")
    // A picture already taken is never written over.
    guard !FileManager.default.fileExists(atPath: file.path) else { return }
    try? XCUIScreen.main.screenshot().pngRepresentation.write(to: file)
  }

  @MainActor
  private func field(_ app: XCUIApplication) -> XCUIElement { app.textFields.matching(NSPredicate(format: "label == %@ OR label == %@", "Reply", "Add a note, or just send")).firstMatch }

  @MainActor
  private func text(_ app: XCUIApplication, _ words: String) -> XCUIElement {
    app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
  }

  @MainActor
  private func any(_ app: XCUIApplication, _ id: String) -> XCUIElement { app.descendants(matching: .any).matching(identifier: id).firstMatch }

  /// `@` opens the list of agents to tag; a pick writes its tag; the sent reply says who it tagged, with a line for it.
  @MainActor
  func testAtTagsAnotherAgentAndTheSentReplyNamesIt() {
    let app = launch(open: Self.retry)
    let box = field(app)
    XCTAssertTrue(box.waitForExistence(timeout: 20))
    box.tap()
    box.typeText("@")
    let pi = app.buttons["tag-option/ses_docs"]
    XCTAssertTrue(pi.waitForExistence(timeout: 10))
    XCTAssertTrue(any(app, "tag-option/mcp_review").exists, "an agent that reads the Inbox is offered too")
    XCTAssertTrue(text(app, "Reads the Inbox, not woken").exists)
    XCTAssertTrue(text(app, "Owns this thread").exists, "the thread's own agent says so")
    shot("01-tag-list")
    // What is typed after `@` narrows the list.
    box.typeText("p")
    XCTAssertTrue(pi.waitForExistence(timeout: 3))
    XCTAssertFalse(any(app, "tag-option/mcp_review").exists)
    pi.tap()
    XCTAssertFalse(any(app, "tag-list").waitForExistence(timeout: 2))
    let value = box.value as? String ?? ""
    XCTAssertTrue(value.hasPrefix("@Pi"), value)
    XCTAssertTrue(value.hasSuffix(" "), "the caret goes past the tag with a space")
    box.typeText("check the docs index builds at start too.")
    shot("02-tagged-words")
    app.buttons["Send"].tap()
    XCTAssertTrue(text(app, "tagged Pi").waitForExistence(timeout: 10))
    let line = any(app, "tag-line/ses_docs")
    XCTAssertTrue(line.waitForExistence(timeout: 5))
    XCTAssertTrue(line.label.contains("Queued for Pi"), line.label)
    shot("03-tagged-sent")
  }

  /// Deleting back to an `@` does not open the list: only typing at it does (the window's `quietOnDelete`).
  @MainActor
  func testDeletingBackToAnAtDoesNotOpenTheList() {
    let app = launch(open: Self.retry)
    let box = field(app)
    XCTAssertTrue(box.waitForExistence(timeout: 20))
    box.tap()
    box.typeText("Ask @")
    XCTAssertTrue(any(app, "tag-list").waitForExistence(timeout: 10))
    box.typeText(",")
    XCTAssertFalse(any(app, "tag-list").waitForExistence(timeout: 2), "a comma after the @ closes the list")
    box.typeText(XCUIKeyboardKey.delete.rawValue)
    XCTAssertEqual(box.value as? String, "Ask @")
    XCTAssertFalse(any(app, "tag-list").waitForExistence(timeout: 2), "a deletion never opens it")
    box.typeText("P")
    XCTAssertTrue(any(app, "tag-list").waitForExistence(timeout: 5), "typing at it does")
  }

  /// 👍 Looks good beside the empty reply field marks the agent's message; a touch on the pressed button takes it back.
  @MainActor
  func testLooksGoodMarksTheMessageAndATouchTakesItBack() {
    let app = launch(open: Self.docs)
    let good = app.buttons["looks-good"]
    XCTAssertTrue(good.waitForExistence(timeout: 20))
    XCTAssertEqual(good.label, "Looks good")
    XCTAssertGreaterThanOrEqual(good.frame.height, 44)
    shot("04-looks-good")
    good.tap()
    let line = any(app, "ack-line")
    XCTAssertTrue(line.waitForExistence(timeout: 10))
    XCTAssertTrue(line.label.contains("goes to Pi in a few seconds"), line.label)
    XCTAssertTrue(good.isSelected)
    shot("05-looks-good-on")
    good.tap()
    XCTAssertTrue(line.waitForNonExistence(timeout: 10))
    // Words in the box: the button steps aside, as in the window.
    field(app).tap()
    field(app).typeText("One more thing")
    XCTAssertFalse(good.waitForExistence(timeout: 2))
  }

  /// A hold on 👍 opens the tray: 👍 Looks good, and Any emoji, which opens on the emoji keyboard.
  @MainActor
  func testAHoldOpensTheTrayAndAnyEmojiOpensTheEmojiKeyboard() {
    let app = launch(open: Self.docs)
    let good = app.buttons["looks-good"]
    XCTAssertTrue(good.waitForExistence(timeout: 20))
    good.press(forDuration: 1)
    let anyEmoji = app.buttons["Any emoji"]
    XCTAssertTrue(anyEmoji.waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["👍 Looks good"].exists)
    shot("06-tray")
    anyEmoji.tap()
    let input = any(app, "any-emoji")
    XCTAssertTrue(input.waitForExistence(timeout: 5))
    shot("07-any-emoji")
    // The emoji keyboard's keys are out of a UI test's reach: what a pick sends is InboxCore's test
    // (WritingTwoTests), and how a reaction is drawn is the next test's.
    XCTAssertTrue(app.keyboards.firstMatch.exists, "the field opens on the keyboard")
  }

  /// A reaction other than 👍: the button and the line under the message say which, VoiceOver by the emoji's name.
  @MainActor
  func testAReactionIsSaidByItsEmojisName() {
    let app = launch(open: Self.docs, more: ["-stage", "reacted"])
    let good = app.buttons["looks-good"]
    let line = any(app, "ack-line")
    XCTAssertTrue(line.waitForExistence(timeout: 20))
    XCTAssertTrue(line.label.contains("Reacted with party popper"), line.label)
    XCTAssertEqual(good.label, "Reacted with party popper")
    shot("08-reacted")
  }

  /// Take back on a reply no agent has: it leaves the thread and its words are back in the box, with the note.
  @MainActor
  func testTakeBackPutsTheReplyBackInTheBox() {
    let app = launch(open: Self.upload)
    let take = app.buttons["take-back"]
    XCTAssertTrue(take.waitForExistence(timeout: 20))
    XCTAssertEqual(take.label, "Take back")
    XCTAssertGreaterThanOrEqual(take.frame.height, 44)
    shot("09-take-back")
    take.tap()
    let note = any(app, "take-back-note")
    XCTAssertTrue(note.waitForExistence(timeout: 10))
    XCTAssertTrue(note.label.contains("Taken back. Codex never got it."), note.label)
    XCTAssertEqual(field(app).value as? String, "Wait for the progress event instead of sleeping.")
    XCTAssertFalse(take.exists, "the reply is out of the thread")
    shot("10-taken-back")
    // Sent again, the note goes.
    app.buttons["Send"].tap()
    XCTAssertTrue(note.waitForNonExistence(timeout: 10))
    XCTAssertTrue(app.buttons["take-back"].waitForExistence(timeout: 10), "the reply is back in the thread, and can be taken back again")
  }

  /// A reply that waits on the phone for the computer: Take back puts its words back in the box, and nothing is sent.
  @MainActor
  func testAReplyWaitingOnThePhoneIsTakenBack() {
    let app = launch(open: Self.retry, more: ["-stage", "readretry,away"])
    let box = field(app)
    XCTAssertTrue(box.waitForExistence(timeout: 20))
    box.tap()
    box.typeText("Go ahead when it is back.")
    app.buttons["Send"].tap()
    let take = app.buttons["take-back"]
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Will send when'")).firstMatch.waitForExistence(timeout: 10))
    for _ in 0..<4 where !take.isHittable { app.swipeUp() }
    XCTAssertTrue(take.waitForExistence(timeout: 5))
    shot("14-held-take-back")
    take.tap()
    XCTAssertTrue(take.waitForNonExistence(timeout: 5))
    XCTAssertEqual(field(app).value as? String, "Go ahead when it is back.")
  }

  /// At the largest text size the tag list, 👍 and Take back keep their words on screen.
  @MainActor
  func testTheWritingPartsKeepTheirWordsAtTheLargestTextSize() {
    var app = launch(open: Self.retry, more: Self.largest)
    let box = field(app)
    XCTAssertTrue(box.waitForExistence(timeout: 20))
    box.tap()
    box.typeText("@")
    XCTAssertTrue(app.buttons["tag-option/ses_api"].waitForExistence(timeout: 10))
    shot("11-tag-list-largest")
    // What is typed after `@` narrows the list to Pi.
    box.typeText("P")
    let pi = app.buttons["tag-option/ses_docs"]
    XCTAssertTrue(pi.waitForExistence(timeout: 5))
    XCTAssertTrue(app.windows.firstMatch.frame.contains(pi.frame), "a row is cut at the screen's edge")
    app.terminate()

    app = launch(open: Self.docs, more: Self.largest)
    let good = app.buttons["looks-good"]
    XCTAssertTrue(good.waitForExistence(timeout: 20))
    XCTAssertTrue(app.windows.firstMatch.frame.contains(good.frame), "👍 is cut at the screen's edge")
    good.tap()
    XCTAssertTrue(any(app, "ack-line").waitForExistence(timeout: 10))
    shot("12-looks-good-largest-r2")
    app.terminate()

    app = launch(open: Self.upload, more: Self.largest)
    let take = app.buttons["take-back"]
    XCTAssertTrue(take.waitForExistence(timeout: 20))
    for _ in 0..<4 where !take.isHittable { app.swipeUp() }
    XCTAssertTrue(take.isHittable)
    shot("13-take-back-largest")
  }
}
