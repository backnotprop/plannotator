import XCTest

/// What a file's viewer must never do: let a page leave for the network, a site or another app on its own, show
/// the bytes of a file the agent has since changed as if they were the file now, or read a task box as plain text.
/// On the stand-in computer, as FileUITests.
final class FileSafetyUITests: XCTestCase {
  override func setUp() { continueAfterFailure = false }

  @MainActor
  private func launch(stage: String) -> XCUIApplication {
    let app = XCUIApplication()
    app.launchArguments = ["-standIn", "YES", "-AppleLanguages", "(en)", "-stage", stage, "-open", "msg_STANDIN0000000000000060", "-resetFolds", "YES"]
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

  /// A tile, brought onto the screen.
  @MainActor
  private func tile(_ app: XCUIApplication, _ name: String, up: Bool = false) -> XCUIElement {
    let found = app.buttons["file/\(name)"]
    var tries = 0
    while !(found.exists && found.isHittable), tries < 8 {
      if up { app.swipeUp(velocity: .slow) } else { app.swipeDown(velocity: .slow) }
      tries += 1
    }
    XCTAssertTrue(found.exists && found.isHittable, name)
    return found
  }

  private func words(_ app: XCUIApplication, _ text: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "(elementType == %d OR elementType == %d) AND (label CONTAINS %@ OR value CONTAINS %@)", XCUIElement.ElementType.staticText.rawValue, XCUIElement.ElementType.textView.rawValue, text, text)).firstMatch
  }

  @MainActor
  func testAPageThatTriesToLeaveStaysOnTheFileAndReachesNothing() {
    let app = launch(stage: "files,filespage")
    tile(app, "leaving.html", up: true).tap()
    XCTAssertTrue(words(app, "A page that tries to leave").waitForExistence(timeout: 20))
    // Its policy is the one in force: the fetch it made was refused before it left the phone.
    XCTAssertTrue(words(app, "Network: refused by connect-src").waitForExistence(timeout: 10))
    // Its script clicked a link to a site and a phone number, then moved `location`, with no touch on the page.
    XCTAssertTrue(words(app, "Links: clicked by the page").waitForExistence(timeout: 10))
    usleep(2_500_000)
    XCTAssertEqual(app.state, .runningForeground, "no other app was opened")
    XCTAssertTrue(words(app, "A page that tries to leave").exists, "the file is still on screen, not another page")
    XCTAssertTrue(app.buttons["Done"].exists)
    shot("25-page-stays")
  }

  @MainActor
  func testCommentingOnAPageGivesItsFramesBackAsThePageMadeThem() {
    let app = launch(stage: "files,framedpage")
    tile(app, "framed.html", up: true).tap()
    let page = app.webViews["file-page"]
    XCTAssertTrue(page.waitForExistence(timeout: 20))
    let under = page.buttons["Under the frame"]
    XCTAssertTrue(under.waitForExistence(timeout: 10))
    // Comment on, then off: the frame the page let touches through still lets them through.
    let mode = app.segmentedControls["page-mode"]
    mode.buttons["Comment"].tap()
    usleep(500_000)
    mode.buttons["Use the page"].tap()
    usleep(500_000)
    under.tap()
    XCTAssertTrue(page.buttons["Pressed"].waitForExistence(timeout: 5), "the touch passed the frame to the button under it")
  }

  @MainActor
  func testAFileTheAgentChangedAfterThePhoneLastAskedOpensAsItIsNow() {
    // The plan was read on the phone; the agent changed it after the phone last asked how the thread's files stand.
    let app = launch(stage: "files,fileskept,filechangesnext")
    tile(app, "retry-plan.md").tap()
    XCTAssertTrue(app.staticTexts["Changed since sent"].waitForExistence(timeout: 20))
    XCTAssertTrue(words(app, "capped at 30 seconds").waitForExistence(timeout: 10), "the file as it is now")
    XCTAssertFalse(words(app, "capped at 60 seconds").exists, "not the bytes the phone kept from before")
    app.buttons["View sent version"].tap()
    XCTAssertTrue(app.staticTexts["Showing the sent version"].waitForExistence(timeout: 10))
    XCTAssertTrue(words(app, "capped at 60 seconds").waitForExistence(timeout: 10))
    XCTAssertFalse(words(app, "capped at 30 seconds").exists)
  }

  @MainActor
  func testATaskBoxIsReadAsTickedOrNotAndNotAsASwitch() {
    let app = launch(stage: "files")
    tile(app, "retry-plan.md").tap()
    let done = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Reproduce on a sleeping laptop'")).firstMatch
    let open = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'Ship behind a flag'")).firstMatch
    if !done.waitForExistence(timeout: 20) { app.swipeUp() }
    XCTAssertTrue(done.waitForExistence(timeout: 10))
    XCTAssertTrue(open.exists)
    // Its state is read as a value. It is not a switch: nothing tells the person to toggle what cannot be toggled.
    XCTAssertEqual(done.value as? String, "Checked", "a ticked box is read as ticked: \(done.debugDescription)")
    XCTAssertEqual(open.value as? String, "Not checked", "an open one as not ticked, not as plain text: \(open.debugDescription)")
    XCTAssertNotEqual(done.elementType, .switch, "not a switch")
    XCTAssertNotEqual(done.elementType, .toggle)
    XCTAssertFalse(done.label.contains("Done"), "not the Done button's word")
  }
}
