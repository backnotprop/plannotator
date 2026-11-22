import XCTest

/// Opening files from a thread (FLOWS 7): the tiles under a message, the cover with its bar, each kind's viewer,
/// stepping sideways, the versions of a changed file, and a file the phone does not have while the computer is away.
/// On the stand-in computer; pictures as in RowActionUITests.
final class FileUITests: XCTestCase {
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

  /// Words on screen: a label's, or a document's (its blocks are text views, whose words are their value).
  @MainActor
  private func read(_ app: XCUIApplication, _ text: String) -> XCUIElement {
    app.descendants(matching: .any).matching(NSPredicate(format: "(elementType == %d OR elementType == %d) AND (label CONTAINS %@ OR value CONTAINS %@)", XCUIElement.ElementType.staticText.rawValue, XCUIElement.ElementType.textView.rawValue, text, text)).firstMatch
  }

  /// A tile, brought onto the screen (the first message's tiles are above where the thread lands).
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

  @MainActor
  private func title(_ app: XCUIApplication, _ name: String, _ place: String, file: StaticString = #filePath, line: UInt = #line) {
    let bar = app.navigationBars.containing(NSPredicate(format: "label CONTAINS %@ OR identifier CONTAINS %@", name, name)).firstMatch
    let words = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", place)).firstMatch
    let other = app.otherElements.containing(NSPredicate(format: "label CONTAINS %@", place)).firstMatch
    XCTAssertTrue(words.waitForExistence(timeout: 10) || other.exists || bar.exists, "\(name), \(place)", file: file, line: line)
  }

  /// The picture on screen (the files beside it are laid out too, off screen).
  @MainActor
  private func shownPicture(_ app: XCUIApplication, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
    XCTAssertTrue(app.images.matching(identifier: "file-picture").firstMatch.waitForExistence(timeout: 20), file: file, line: line)
    usleep(500_000)
    let screen = app.windows.firstMatch.frame
    let all = app.images.matching(identifier: "file-picture").allElementsBoundByIndex
    return all.first { screen.contains(CGPoint(x: $0.frame.midX, y: $0.frame.midY)) } ?? all[0]
  }

  // MARK: The tiles, and a picture

  @MainActor
  func testAMessagesFilesAreTilesAndAWidePictureOpensWholeThenIsLookedInto() {
    let app = launch()
    let screen = app.windows.firstMatch.frame
    // Every file of the message is a tile, inside the screen, with what it is under its name.
    for name in ["canary.html", "stand-up.wav", "reconnect-flamegraph.png", "reconnecting-screen.png", "reconnect-demo.mp4", "reconnect-report.pdf", "relay-traces.zip"] {
      let tile = app.buttons["file/\(name)"]
      XCTAssertTrue(tile.exists, name)
      XCTAssertGreaterThanOrEqual(tile.frame.minX, screen.minX)
      XCTAssertLessThanOrEqual(tile.frame.maxX, screen.maxX)
      XCTAssertGreaterThanOrEqual(tile.frame.height, 44, name)
    }
    XCTAssertTrue(app.buttons["file/reconnect-flamegraph.png"].label.contains("2400 × 576"))
    XCTAssertTrue(app.buttons["file/reconnect-demo.mp4"].label.contains("MP4 video · 0:03"))
    shot("01-thread-tiles")

    // The very wide picture opens whole: all of its width is on the screen.
    app.buttons["file/reconnect-flamegraph.png"].tap()
    let picture = shownPicture(app)
    XCTAssertTrue(app.buttons["Done"].exists)
    XCTAssertGreaterThanOrEqual(picture.frame.minX, screen.minX - 0.5)
    XCTAssertLessThanOrEqual(picture.frame.maxX, screen.maxX + 0.5)
    XCTAssertEqual(picture.frame.width, screen.width, accuracy: 1)
    XCTAssertEqual(picture.frame.width / picture.frame.height, 2400.0 / 576.0, accuracy: 0.05)
    shot("02-picture-wide-whole")

    // Two taps look into it: now wider than the screen. Two more, whole again.
    picture.doubleTap()
    usleep(600_000)
    XCTAssertGreaterThan(picture.frame.width, screen.width * 2)
    shot("03-picture-wide-in")
    picture.doubleTap()
    usleep(600_000)
    XCTAssertEqual(picture.frame.width, screen.width, accuracy: 1)

    // One tap puts the bar away, another brings it back.
    picture.tap()
    usleep(900_000)
    XCTAssertFalse(app.buttons["Done"].isHittable)
    shot("04-picture-bars-away")
    picture.tap()
    XCTAssertTrue(app.buttons["Done"].waitForExistence(timeout: 5))

    // The next file is a swipe away: the tall picture, whole too.
    app.swipeLeft()
    usleep(800_000)
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'reconnecting-screen.png' AND label CONTAINS 'File 8 of 11'")).firstMatch.waitForExistence(timeout: 10))
    let tall = shownPicture(app)
    XCTAssertLessThanOrEqual(tall.frame.maxY, screen.maxY + 0.5)
    XCTAssertGreaterThanOrEqual(tall.frame.minY, screen.minY - 0.5)
    shot("05-picture-tall-whole")

    // Done: the thread is where it was.
    app.buttons["Done"].tap()
    XCTAssertTrue(app.buttons["file/reconnect-flamegraph.png"].waitForExistence(timeout: 10))
    XCTAssertTrue(app.buttons["file/reconnect-flamegraph.png"].isHittable)
  }

  @MainActor
  func testAPicturePulledDownCloses() {
    let app = launch()
    app.buttons["file/reconnect-flamegraph.png"].tap()
    _ = shownPicture(app)
    let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45))
    from.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)))
    XCTAssertTrue(app.buttons["file/reconnect-flamegraph.png"].waitForExistence(timeout: 10))
    XCTAssertFalse(app.buttons["Done"].exists)
  }

  // MARK: Words: a document, code, a log, text

  @MainActor
  func testADocumentCodeALogAndTextAreReadAndSteppedThrough() {
    let app = launch()
    tile(app, "retry-plan.md").tap()
    // The document, drawn: its title, a list, and further down its table and code.
    XCTAssertTrue(read(app, "Retry plan for the relay client").waitForExistence(timeout: 20))
    XCTAssertTrue(app.staticTexts["File 1 of 11"].exists || app.otherElements.containing(NSPredicate(format: "label CONTAINS 'File 1 of 11'")).firstMatch.exists)
    XCTAssertTrue(read(app, "Problem").exists)
    // Nothing of the file's own marks is left in the words.
    XCTAssertFalse((read(app, "## ").exists || read(app, "|---").exists))
    shot("06-document-top")
    app.swipeUp()
    usleep(500_000)
    shot("07-document-table-code")
    XCTAssertTrue(app.staticTexts["Attempt"].exists)

    // More: Share and Copy file.
    app.buttons["file-more"].firstMatch.tap()
    XCTAssertTrue(app.buttons["Copy file"].waitForExistence(timeout: 5))
    XCTAssertTrue(app.buttons["Share"].exists)
    shot("08-document-more")
    app.buttons["Copy file"].tap()

    // A swipe: the code, each line with its number, nothing wider than the screen.
    app.swipeLeft()
    let code = app.scrollViews["file-code"]
    XCTAssertTrue(code.waitForExistence(timeout: 10))
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'export async function keepOpen'")).firstMatch.exists)
    let screen = app.windows.firstMatch.frame
    let long = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'console.warn'")).firstMatch
    XCTAssertTrue(long.exists)
    usleep(900_000)
    XCTAssertLessThanOrEqual(long.frame.maxX, screen.maxX + 0.5, "a long line wraps")
    shot("09-code")

    // The log is read as code (its lines kept); the notes as plain text.
    app.swipeLeft()
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'relay ping ok rtt=21 ms'")).firstMatch.waitForExistence(timeout: 10))
    XCTAssertTrue(app.scrollViews["file-code"].exists)
    shot("10-log")
    app.swipeLeft()
    XCTAssertTrue(app.scrollViews["file-text"].waitForExistence(timeout: 10))
    XCTAssertTrue(read(app, "Stand-up, Tuesday").exists)
    shot("11-text")

    app.buttons["Done"].tap()
    XCTAssertTrue(app.buttons["file/retry-plan.md"].waitForExistence(timeout: 10))
  }

  // MARK: A page, a video, a recording, a PDF, another file

  @MainActor
  func testAPageAVideoARecordingAPDFAndAnotherFileOpen() {
    let app = launch()
    app.buttons["file/canary.html"].tap()
    // The page itself, and it works: its own button answers a touch.
    let page = app.webViews.firstMatch
    XCTAssertTrue(page.waitForExistence(timeout: 20))
    XCTAssertTrue(page.staticTexts["Canary rollout · relay client"].waitForExistence(timeout: 20))
    shot("12-page")
    app.swipeUp()
    let refresh = page.buttons["Refresh"]
    XCTAssertTrue(refresh.waitForExistence(timeout: 10))
    refresh.tap()
    XCTAssertTrue(page.buttons["Refreshed"].waitForExistence(timeout: 10))
    app.buttons["Done"].tap()

    // The recording, in the system's player.
    app.buttons["file/stand-up.wav"].tap()
    XCTAssertTrue(app.otherElements["file-player"].waitForExistence(timeout: 20) || app.buttons["Play"].waitForExistence(timeout: 5))
    shot("13-recording")
    app.buttons["Done"].tap()

    app.buttons["file/reconnect-demo.mp4"].tap()
    XCTAssertTrue(app.otherElements["file-player"].waitForExistence(timeout: 20) || app.buttons["Play"].waitForExistence(timeout: 5))
    shot("14-video")
    app.buttons["Done"].tap()

    app.buttons["file/reconnect-report.pdf"].tap()
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'reconnect report'")).firstMatch.waitForExistence(timeout: 20))
    shot("15-pdf")
    app.buttons["Done"].tap()

    // A file the phone does not draw: what it is, and Share.
    app.buttons["file/relay-traces.zip"].tap()
    XCTAssertTrue(app.staticTexts["ZIP file, 46.9 KB"].waitForExistence(timeout: 20))
    XCTAssertTrue(app.buttons["Share"].exists)
    shot("16-other-file")
    app.buttons["Done"].tap()
    XCTAssertTrue(app.buttons["file/relay-traces.zip"].waitForExistence(timeout: 10))
  }

  // MARK: A file that changed, a file that is gone, the computer away

  @MainActor
  func testAChangedFileOpensAsItIsNowAndTheSentVersionIsATapAway() {
    let app = launch(stage: "files,filechanged")
    let plan = tile(app, "retry-plan.md")
    XCTAssertTrue(plan.label.contains("Changed since sent"))
    shot("17-tile-changed")
    plan.tap()
    XCTAssertTrue(app.staticTexts["Changed since sent"].waitForExistence(timeout: 20))
    XCTAssertTrue(read(app, "capped at 30 seconds").waitForExistence(timeout: 10))
    shot("18-document-changed")
    app.buttons["View sent version"].tap()
    XCTAssertTrue(app.staticTexts["Showing the sent version"].waitForExistence(timeout: 10))
    XCTAssertTrue(read(app, "capped at 60 seconds").waitForExistence(timeout: 10))
    shot("19-document-sent-version")
    app.buttons["View current file"].tap()
    XCTAssertTrue(app.staticTexts["Changed since sent"].waitForExistence(timeout: 10))
  }

  @MainActor
  func testAFileGoneFromTheComputerOpensAsItWasSent() {
    let app = launch(stage: "files,filegone")
    let plan = tile(app, "retry-plan.md")
    XCTAssertTrue(plan.label.contains("No longer on disk"))
    plan.tap()
    XCTAssertTrue(app.staticTexts["The file is gone; showing the sent copy"].waitForExistence(timeout: 20))
    XCTAssertTrue(read(app, "Retry plan for the relay client").waitForExistence(timeout: 10))
    shot("20-document-gone")
  }

  @MainActor
  func testAFileNotOnThePhoneSaysTheComputerIsAwayAndOneAlreadyOpenedStillOpens() {
    // The plan was opened earlier, then the computer went away.
    let app = launch(stage: "files,fileskept,away")
    tile(app, "retry-plan.md").tap()
    XCTAssertTrue(read(app, "Retry plan for the relay client").waitForExistence(timeout: 20))
    // The next file was never opened: it says the computer cannot be reached.
    app.swipeLeft()
    XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS 'File 2 of 11'")).firstMatch.waitForExistence(timeout: 10))
    // (The file after it is laid out beside it, and says the same.)
    XCTAssertTrue(app.buttons.matching(identifier: "Try again").firstMatch.waitForExistence(timeout: 20))
    usleep(600_000)
    let screen = app.windows.firstMatch.frame
    XCTAssertTrue(app.buttons.matching(identifier: "Try again").allElementsBoundByIndex.contains { screen.contains($0.frame) })
    XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Can't reach")).firstMatch.exists)
    shot("21-file-away")
    app.buttons["Done"].tap()
    XCTAssertTrue(app.buttons["file/client.ts"].waitForExistence(timeout: 10))
  }

  // MARK: The largest text

  @MainActor
  func testAtTheLargestTextTheTilesAndADocumentStayOnTheScreen() {
    let app = launch(more: ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL"])
    let screen = app.windows.firstMatch.frame
    let tile = tile(app, "retry-plan.md")
    XCTAssertLessThanOrEqual(tile.frame.maxX, screen.maxX + 0.5)
    shot("22-tiles-largest-type")
    tile.tap()
    let title = read(app, "Retry plan for the relay client")
    XCTAssertTrue(title.waitForExistence(timeout: 20))
    XCTAssertLessThanOrEqual(title.frame.maxX, screen.maxX + 0.5)
    XCTAssertTrue(app.buttons["Done"].exists)
    XCTAssertLessThanOrEqual(app.buttons["Done"].frame.maxX, screen.maxX)
    shot("23-document-largest-type")
    app.swipeLeft()
    XCTAssertTrue(app.scrollViews["file-code"].waitForExistence(timeout: 10))
    shot("24-code-largest-type")
  }
}
