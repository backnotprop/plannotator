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
      XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "\(section), ")).firstMatch.exists, section)
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
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Sent, ")).firstMatch.waitForExistence(timeout: 5))
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
