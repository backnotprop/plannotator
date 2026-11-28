import XCTest

/// The first slice, walked as a person would, on the stand-in computer ("Try it without a computer").
/// Nothing here reaches a real Inbox.
final class FirstSliceTests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  // proves: pair-01, pair-04, list-01, list-06, answer-04, answer-07, answer-08
  @MainActor
  func testPairTheDemoOpenAThreadPickAndSend() {
    let app = XCUIApplication()
    app.launchArguments = ["-demo", "NO", "-AppleLanguages", "(en)"]
    app.launch()

    // First run opens on the scanner.
    XCTAssertTrue(app.staticTexts["Scan the code on your computer"].waitForExistence(timeout: 10))
    app.buttons["Try it without a computer"].tap()

    // The list: the computer's sections, in its order, under the product's names.
    XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 10))
    for section in ["Stopped on you", "Holding up work", "Waiting on you"] {
      XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "\(section), ")).firstMatch.exists, section)
    }

    // A tap on a row opens the thread, with its question as a card.
    app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Retry logic for the relay client")).firstMatch.tap()
    let staged = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Staged, 10% first")).firstMatch
    XCTAssertTrue(staged.waitForExistence(timeout: 10))
    XCTAssertFalse(staged.isSelected)

    // A tap saves the pick; a tap on another row moves it.
    staged.tap()
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "in your draft")).firstMatch.waitForExistence(timeout: 5))
    let everyone = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Everyone at once")).firstMatch
    everyone.tap()
    XCTAssertTrue(everyone.waitForExistence(timeout: 5))
    expectation(for: NSPredicate(format: "isSelected == true"), evaluatedWith: everyone)
    waitForExpectations(timeout: 5)
    XCTAssertFalse(staged.isSelected)

    // Send posts the saved pick: the card reads Sent and the person's message is in the thread.
    app.buttons["Send"].tap()
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Sent ")).firstMatch.waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts["You"].exists)
    // A sent card is settled: nothing left to tap.
    XCTAssertFalse(staged.exists)

    // Back in the list the thread has moved to Sent.
    app.navigationBars.buttons.firstMatch.tap()
    XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Sent, ")).firstMatch.waitForExistence(timeout: 5))
  }

  /// An action item is done on the phone, and a permission prompt is answered with one touch and shrinks to a line.
  @MainActor
  func testAnActionItemIsMarkedDoneAndAPermissionPromptIsAllowed() {
    let app = XCUIApplication()
    app.launchArguments = ["-standIn", "YES", "-AppleLanguages", "(en)", "-stage", "permission", "-open", "msg_STANDIN0000000000000007"]
    app.launch()

    // The action item comes before the question, with Done and Can't do it.
    XCTAssertTrue(app.staticTexts["1 thing only you can do"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts["0 of 1 done"].exists)
    XCTAssertTrue(app.buttons["Can't do it…"].exists)
    XCTAssertFalse(app.buttons["Send"].isEnabled)
    app.buttons["Done"].tap()
    // It waits in the draft: nothing reaches the agent until Send.
    XCTAssertTrue(app.staticTexts["1 of 1 done"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", "in your draft")).firstMatch.exists)
    XCTAssertTrue(app.buttons["Send"].isEnabled)

    // The permission prompt: its answers are buttons, and one touch answers it.
    app.navigationBars.buttons.firstMatch.tap()
    app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Migrate billing tables: permission")).firstMatch.tap()
    let allow = app.buttons["Allow once"]
    XCTAssertTrue(allow.waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["Deny with a reason"].exists)
    XCTAssertTrue(app.staticTexts["bun run db:migrate --env staging"].exists)
    // The answers wait a moment after the card appears.
    sleep(1)
    allow.tap()
    XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "You chose Allow once")).firstMatch.waitForExistence(timeout: 5))
    XCTAssertFalse(allow.exists)
  }

  // MARK: A long thread, built as it scrolls

  private func openLong(_ thread: String) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-standIn", "YES", "-AppleLanguages", "(en)", "-stage", "long", "-open", thread]
    app.launch()
    return app
  }

  private func field(_ app: XCUIApplication, _ label: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND (elementType == %d OR elementType == %d)", label, XCUIElement.ElementType.textField.rawValue, XCUIElement.ElementType.textView.rawValue)).firstMatch
  }

  /// The foot's button goes to a question far up a 300-message thread, a card not built until the page gets there,
  /// and the page rests with the card whole between the title bar and the foot.
  @MainActor
  func testTheFootButtonRestsOnAQuestionFarUpALongThread() {
    let app = openLong("msg_STANDIN0000000000000009")
    XCTAssertTrue(app.staticTexts["Ship it today?"].waitForExistence(timeout: 30))
    let foot = app.buttons["2 questions, 1 action item"]
    XCTAssertTrue(foot.waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["Keep the old retry flag?"].exists, "far up, not built yet")
    foot.tap()
    let prompt = app.staticTexts["Keep the old retry flag?"]
    XCTAssertTrue(prompt.waitForExistence(timeout: 15))
    sleep(2)
    let drop = app.buttons.containing(NSPredicate(format: "label BEGINSWITH %@", "Drop it")).firstMatch
    XCTAssertTrue(drop.exists)
    let skip = app.buttons.matching(NSPredicate(format: "label == %@", "Skip")).allElementsBoundByIndex.first { $0.frame.minY > drop.frame.maxY && $0.frame.minY < drop.frame.maxY + 200 }
    let bar = app.navigationBars.firstMatch.frame.maxY
    XCTAssertGreaterThanOrEqual(prompt.frame.minY, bar, "the card's top is under the title bar, not behind it")
    XCTAssertNotNil(skip, "the card's last row is built")
    XCTAssertLessThanOrEqual(skip?.frame.maxY ?? .infinity, foot.frame.minY, "the card ends above the foot")
  }

  /// At the largest text size the rows above the newest message measure themselves again while the thread lands
  /// (the question's place reaches the page a moment after the message's), and once more when something reads
  /// the whole page, as this test does and VoiceOver does: the page still rests on the question, every time the
  /// thread opens. It did not, about one opening in three, when the landing watched the message's place alone and
  /// nothing kept the page's place afterwards. Opened several times: one opening can land right by luck.
  @MainActor
  func testAThreadLandsOnItsQuestionAtTheLargestTextSize() {
    for run in 1...5 {
      let app = XCUIApplication()
      app.launchArguments = ["-standIn", "YES", "-AppleLanguages", "(en)", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL", "-open", "msg_STANDIN0000000000000003"]
      app.launch()
      // Nothing is asked of the app while it lands, as when a person opens it: asking makes it measure again.
      sleep(6)
      let prompt = app.staticTexts["How should this roll out?"]
      XCTAssertTrue(prompt.waitForExistence(timeout: 10))
      // Reading the page built the rows above: the page is given a moment to take its place again.
      sleep(1)
      let bar = app.navigationBars.firstMatch.frame.maxY
      let foot = app.buttons["1 open question"].frame.minY
      XCTAssertGreaterThanOrEqual(prompt.frame.minY, bar, "opening \(run): the question is above the page")
      XCTAssertLessThan(prompt.frame.minY, foot, "opening \(run): the question is below the page")
      app.terminate()
    }
  }

  /// The place a landed thread keeps is the person's to take: a tap on the status bar sends the page to the top
  /// (no finger drags it, and the rows above are built and measured on the way), and the page stays where it was
  /// sent. It is never pulled back to the question.
  @MainActor
  func testALandedThreadLetsGoWhenThePageIsMoved() {
    let app = XCUIApplication()
    app.launchArguments = ["-standIn", "YES", "-AppleLanguages", "(en)", "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL", "-open", "msg_STANDIN0000000000000003"]
    app.launch()
    sleep(6)
    let prompt = app.staticTexts["How should this roll out?"]
    XCTAssertTrue(prompt.waitForExistence(timeout: 10))
    sleep(1)
    let foot = app.buttons["1 open question"].frame.minY
    XCTAssertLessThan(prompt.frame.minY, foot, "landed on the question")
    // The status bar, over the clock's side of the island.
    app.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.03)).tap()
    sleep(2)
    XCTAssertGreaterThan(prompt.frame.minY, foot, "the page went to the top: the question is below it")
    sleep(2)
    XCTAssertGreaterThan(prompt.frame.minY, foot, "and it stayed there")
  }

  /// A Can't do it reason being typed on the newest message survives the agent writing again meanwhile: the
  /// message is no longer the newest, and its card is built anew where older messages are.
  @MainActor
  func testACantDoItReasonSurvivesTheAgentWritingAgain() {
    let app = XCUIApplication()
    app.launchArguments = ["-standIn", "YES", "-AppleLanguages", "(en)", "-stage", "long,writes", "-open", "msg_STANDIN0000000000000009"]
    app.launch()
    XCTAssertTrue(app.buttons["Can't do it…"].waitForExistence(timeout: 15))
    sleep(1)
    app.buttons["Can't do it…"].tap()
    let reason = field(app, "Why can't you? Claude Code gets this word for word.")
    XCTAssertTrue(reason.waitForExistence(timeout: 5))
    reason.typeText("No access to staging.")
    let written = app.staticTexts["While that waits: the other steps all passed."]
    XCTAssertFalse(written.exists, "typed before the agent writes again")
    XCTAssertTrue(written.waitForExistence(timeout: 30))
    sleep(1)
    XCTAssertTrue(reason.waitForExistence(timeout: 5))
    XCTAssertEqual(reason.value as? String, "No access to staging.")
  }

  /// A Deny reason being typed on the newest prompt survives a second prompt arriving meanwhile: the first
  /// prompt's message is no longer the newest, and its card is built anew where older messages are.
  @MainActor
  func testADenyReasonSurvivesASecondPromptArriving() {
    let app = XCUIApplication()
    app.launchArguments = ["-standIn", "YES", "-AppleLanguages", "(en)", "-stage", "long,writes", "-open", "msg_STANDIN0000000000000010"]
    app.launch()
    XCTAssertTrue(app.buttons["Deny with a reason"].waitForExistence(timeout: 15))
    sleep(1)
    app.buttons["Deny with a reason"].tap()
    let reason = field(app, "Why you deny this, for Claude")
    XCTAssertTrue(reason.waitForExistence(timeout: 5))
    sleep(1)
    // The field opens and the keyboard rises with the page still on the card: the rows far above are not guessed
    // again into a different place.
    let command = app.staticTexts["bun test --filter step-200"]
    XCTAssertTrue(command.exists)
    XCTAssertGreaterThanOrEqual(command.frame.minY, app.navigationBars.firstMatch.frame.maxY)
    XCTAssertLessThanOrEqual(reason.frame.maxY, app.keyboards.firstMatch.frame.minY)
    reason.typeText("Run the dry run first.")
    let written = app.staticTexts["bun run lint"]
    XCTAssertFalse(written.exists, "typed before the second prompt arrives")
    XCTAssertTrue(written.waitForExistence(timeout: 30))
    sleep(1)
    XCTAssertTrue(reason.waitForExistence(timeout: 5))
    XCTAssertEqual(reason.value as? String, "Run the dry run first.")
  }

  /// A pairing link from outside the app is shown and waits: nothing is paired until the person says Pair.
  @MainActor
  func testAPairingLinkFromOutsideAsksBeforeAnythingIsPaired() {
    let app = XCUIApplication()
    app.launchArguments = ["-standIn", "YES", "-AppleLanguages", "(en)", "-pairLink", "plannotator://pair?v=1&name=Studio%20Mac&tailnet=studio-mac.example.ts.net%3A8443&secret=abc&code=123456"]
    app.launch()
    XCTAssertTrue(app.staticTexts["Pair with this computer?"].waitForExistence(timeout: 10))
    // The address leads; the name is only what the link says of itself.
    XCTAssertTrue(app.staticTexts["studio-mac.example.ts.net:8443"].exists)
    XCTAssertTrue(app.staticTexts["It calls itself “Studio Mac”."].exists)
    XCTAssertTrue(app.buttons["Pair"].exists)
    app.buttons["Cancel"].tap()
    // Still on the computer it was on, and the demo says it is a demo.
    XCTAssertTrue(app.navigationBars["Inbox"].waitForExistence(timeout: 5))
    XCTAssertFalse(app.staticTexts["Pair with this computer?"].exists)
    XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label CONTAINS %@", "Work Mac, Demo")).firstMatch.exists)
  }
}
