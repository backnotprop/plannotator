import XCTest

/// Writing on the phone (FLOWS 6): the reply's words kept on leaving the thread and the app, ↩ to quote a message,
/// files attached to a reply, and New message with its agent picker. On the stand-in computer; pictures as in
/// FileUITests (SHOTS_DIR, SHOTS_LOOK).
final class WritingUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  private static let retry = "msg_STANDIN0000000000000003"

  @MainActor
  private func launch(stage: String? = nil, open: String? = retry) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-standIn", "YES", "-AppleLanguages", "(en)", "-resetFolds", "YES"] + (stage.map { ["-stage", $0] } ?? []) + (open.map { ["-open", $0] } ?? [])
    app.launch()
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
  private func field(_ app: XCUIApplication) -> XCUIElement { app.textFields.matching(NSPredicate(format: "label == %@ OR label == %@", "Reply", "Add a note, or just send")).firstMatch }

  @MainActor
  private func text(_ app: XCUIApplication, _ words: String) -> XCUIElement {
    app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
  }

  /// A draft file's name and state, as VoiceOver reads them ("<name>, <state>").
  @MainActor
  private func fileState(_ app: XCUIApplication, _ name: String) -> XCUIElement {
    app.descendants(matching: .any).matching(identifier: "draft-file-state").matching(NSPredicate(format: "label BEGINSWITH %@", "\(name), ")).firstMatch
  }

  /// Words typed in a reply are still there after leaving the thread, and after the app went to the background.
  @MainActor
  func testTheReplysWordsStayAfterLeavingTheThreadAndTheApp() {
    let app = launch()
    let box = field(app)
    XCTAssertTrue(box.waitForExistence(timeout: 20))
    box.tap()
    box.typeText("Cap it at a minute")
    app.navigationBars.buttons.firstMatch.tap()
    XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
    app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Retry logic for the relay client")).firstMatch.tap()
    XCTAssertTrue(field(app).waitForExistence(timeout: 10))
    XCTAssertEqual(field(app).value as? String, "Cap it at a minute")
    shot("01-draft-kept")

    XCUIDevice.shared.press(.home)
    app.activate()
    XCTAssertTrue(field(app).waitForExistence(timeout: 10))
    XCTAssertEqual(field(app).value as? String, "Cap it at a minute")
  }

  /// ↩ on an older message quotes it in the reply; × takes the quote away.
  @MainActor
  func testTheReplyArrowQuotesAnOlderMessage() {
    let app = launch()
    // The thread's first message: an agent wrote after it, so ↩ quotes it.
    XCTAssertTrue(field(app).waitForExistence(timeout: 20))
    let arrow = app.buttons["reply-to/msg_STANDIN0000000000000003"]
    for _ in 0..<6 where !arrow.isHittable { app.swipeDown() }
    arrow.tap()
    let line = app.otherElements["quote-line"]
    XCTAssertTrue(line.waitForExistence(timeout: 5) || app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Replying to")).firstMatch.waitForExistence(timeout: 1))
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Replying to Claude Code's message")).firstMatch.exists)
    shot("02-quote")
    app.buttons["Remove quote"].tap()
    XCTAssertFalse(app.buttons["Remove quote"].waitForExistence(timeout: 2))
  }

  /// A reply with a quote, a picture on the computer and a file the Inbox refused: the refused one says why, and
  /// Send carries the rest.
  @MainActor
  func testAReplyCarriesItsQuoteAndFiles() {
    let app = launch(stage: "writing")
    XCTAssertTrue(fileState(app, "error-dashboard.png").waitForExistence(timeout: 20))
    // The refused file says why in full, on screen with no sideways scroll, and VoiceOver reads the name and the reason.
    let refused = fileState(app, ".env")
    XCTAssertTrue(refused.exists)
    XCTAssertEqual(refused.label, ".env, Not attached: .env files often hold secrets.")
    XCTAssertTrue(refused.isHittable)
    XCTAssertTrue(app.windows.firstMatch.frame.contains(refused.frame), "the refused tile is cut at the screen's edge")
    XCTAssertTrue(app.buttons["Remove .env"].isHittable)
    XCTAssertTrue(app.buttons["Remove quote"].exists)
    XCTAssertTrue(app.buttons["Attach files"].exists)
    shot("03-reply-files-r2")
    app.buttons["Remove .env"].tap()
    XCTAssertFalse(fileState(app, ".env").waitForExistence(timeout: 2))
    app.buttons["Send"].tap()
    // The reply is in the thread, with the picture as its file; the box is empty again.
    XCTAssertTrue(app.buttons["file/error-dashboard.png"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["Remove quote"].exists)
    XCTAssertFalse(app.otherElements["draft-files"].exists)
    // The sent reply shows its quote as one line, not the lead the Inbox wrote for the agent.
    XCTAssertTrue(app.buttons["sent-quote"].waitForExistence(timeout: 5))
    XCTAssertFalse(text(app, "(msg_").exists)
    shot("04-reply-sent")
    app.buttons["sent-quote"].tap()
    XCTAssertTrue(app.buttons["reply-to/msg_STANDIN0000000000000003"].waitForExistence(timeout: 5))
  }

  /// The paperclip offers the library, the camera (on a phone that has one) and Files.
  @MainActor
  func testThePaperclipOffersItsSources() {
    let app = launch()
    let clip = app.buttons["Attach files"]
    XCTAssertTrue(clip.waitForExistence(timeout: 20))
    clip.tap()
    XCTAssertTrue(app.buttons["Photo Library"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Choose Files"].exists)
    shot("05-attach-menu")
  }

  /// New message: Send with no agent says so and opens the picker; with one chosen the thread is written and the
  /// list says where it went.
  @MainActor
  func testANewMessageGoesToTheChosenAgent() {
    let app = launch(open: nil)
    let new = app.buttons["New message"]
    XCTAssertTrue(new.waitForExistence(timeout: 20))
    new.tap()
    let words = app.textFields["compose-words"]
    XCTAssertTrue(words.waitForExistence(timeout: 5))
    shot("06-compose-empty")
    words.tap()
    words.typeText("Add a retry budget to the export job.")
    app.buttons["compose-send"].tap()
    XCTAssertTrue(text(app, "Choose an agent to send it.").waitForExistence(timeout: 5))
    let agent = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Claude Code")).firstMatch
    XCTAssertTrue(agent.waitForExistence(timeout: 5))
    shot("07-compose-picker")
    agent.tap()
    XCTAssertTrue(text(app, "in api-server").waitForExistence(timeout: 5))
    shot("08-compose-ready")
    app.buttons["compose-send"].tap()
    XCTAssertTrue(text(app, "Sent to Claude Code").waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Add a retry budget to the export job")).firstMatch.waitForExistence(timeout: 10))
    shot("09-compose-sent")
  }

  /// Closing New message keeps the words, the agent and the file for next time.
  @MainActor
  func testClosingNewMessageKeepsIt() {
    let app = launch(stage: "compose", open: nil)
    app.buttons["New message"].tap()
    XCTAssertTrue(fileState(app, "export-p99.png").waitForExistence(timeout: 10))
    shot("10-compose-file-r2")
    app.buttons["Cancel"].tap()
    app.buttons["New message"].tap()
    XCTAssertTrue(fileState(app, "export-p99.png").waitForExistence(timeout: 10))
    XCTAssertEqual(app.textFields["compose-words"].value as? String, "Add a retry budget to the export job, and tell me what it costs at peak.")
  }

  /// Sent while the computer is away, a new message waits on the phone and the list says so.
  @MainActor
  func testANewMessageMadeAwayWaitsInTheList() {
    let app = launch(stage: "compose,relayfiles,away", open: nil)
    app.buttons["New message"].tap()
    XCTAssertTrue(app.textFields["compose-words"].waitForExistence(timeout: 10))
    // The picture went up before the computer went away: the message can wait on the phone.
    app.buttons["compose-send"].tap()
    XCTAssertTrue(text(app, "Add a retry budget to the export job").waitForExistence(timeout: 10))
    // "Will send when … is back." is said once: by the away banner, not again by the waiting row under it.
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@ AND label CONTAINS %@", "Can't reach Work Mac", "Will send when Work Mac is back.")).firstMatch.waitForExistence(timeout: 5))
    let row = app.descendants(matching: .any).matching(identifier: "held-new-message")
    XCTAssertTrue(row.matching(NSPredicate(format: "label CONTAINS %@", "Add a retry budget")).firstMatch.exists)
    XCTAssertFalse(row.matching(NSPredicate(format: "label CONTAINS %@", "Will send when")).firstMatch.exists, "the waiting row says it again")
    shot("11-compose-held-r2")
  }

  /// On the relay a file waits for the computer's network, and Send says to wait for it.
  @MainActor
  func testOnTheRelayAFileWaitsForTheNetwork() {
    let app = launch(stage: "relayfiles,compose", open: nil)
    app.buttons["New message"].tap()
    XCTAssertTrue(fileState(app, "export-p99.png").waitForExistence(timeout: 10))
    XCTAssertEqual(fileState(app, "export-p99.png").label, "export-p99.png, Needs your computer's network")
    app.buttons["compose-send"].tap()
    XCTAssertTrue(text(app, "Wait for the files to finish uploading.").waitForExistence(timeout: 5))
    shot("12-compose-needs-network-r2")
  }

  /// No agent running: the picker says so.
  @MainActor
  func testNoAgentRunning() {
    let app = launch(stage: "noagents", open: nil)
    app.buttons["New message"].tap()
    XCTAssertTrue(app.buttons["compose-to"].waitForExistence(timeout: 10))
    app.buttons["compose-to"].tap()
    XCTAssertTrue(text(app, "No agent is running").waitForExistence(timeout: 10))
    shot("13-no-agent")
  }
}
