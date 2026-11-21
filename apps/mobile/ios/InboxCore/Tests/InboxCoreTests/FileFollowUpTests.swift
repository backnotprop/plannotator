import Foundation
import XCTest
@testable import InboxCore
import InboxStandIn
import InboxWire

/// Rules of the file viewers that guard the person: when a page's link may leave for the browser, which links a
/// document opens, how long text is cut for the screen, what a kept copy says of itself, and how a run of code
/// lines and a picture's marks are measured.
@MainActor
final class FileFollowUpTests: XCTestCase {
  private let start = Date(timeIntervalSince1970: 1_800_000_000)

  // MARK: A page's links

  func testOnlyATapArmsAPagesLinkNeverAScrollOrARestingFinger() {
    var gate = PageGate()
    XCTAssertFalse(gate.allows(at: start, assistive: false), "nothing was touched")

    // A tap: down and up in one place, briefly. A link opens just after it, and not much later.
    gate.touchBegan(at: start, x: 100, y: 300)
    gate.touchEnded(at: start.addingTimeInterval(0.08), x: 102, y: 301)
    XCTAssertTrue(gate.allows(at: start.addingTimeInterval(0.1), assistive: false))
    XCTAssertFalse(gate.allows(at: start.addingTimeInterval(0.08 + PageGate.window + 0.01), assistive: false), "the window is short")

    // A scroll: the finger moves. While it moves, and after it lifts, nothing is armed.
    var scroll = PageGate()
    scroll.touchBegan(at: start, x: 100, y: 500)
    scroll.touchMoved(x: 100, y: 440)
    XCTAssertFalse(scroll.allows(at: start.addingTimeInterval(0.05), assistive: false), "a page cannot leave while the person scrolls")
    scroll.touchEnded(at: start.addingTimeInterval(0.3), x: 100, y: 200)
    XCTAssertFalse(scroll.allows(at: start.addingTimeInterval(0.31), assistive: false))
    // Back where it began after wandering: still not a tap.
    var wander = PageGate()
    wander.touchBegan(at: start, x: 100, y: 500)
    wander.touchMoved(x: 100, y: 440)
    wander.touchEnded(at: start.addingTimeInterval(0.2), x: 100, y: 500)
    XCTAssertFalse(wander.allows(at: start.addingTimeInterval(0.21), assistive: false))

    // A finger resting on the page (reading, or a long press) is not a tap either.
    var rest = PageGate()
    rest.touchBegan(at: start, x: 100, y: 300)
    rest.touchEnded(at: start.addingTimeInterval(PageGate.press + 0.2), x: 100, y: 300)
    XCTAssertFalse(rest.allows(at: start.addingTimeInterval(PageGate.press + 0.21), assistive: false))

    // A touch only begun arms nothing (the old gate armed on touch down).
    var down = PageGate()
    down.touchBegan(at: start, x: 100, y: 300)
    XCTAssertFalse(down.allows(at: start.addingTimeInterval(0.01), assistive: false))
    down.touchCancelled()
    XCTAssertFalse(down.allows(at: start.addingTimeInterval(0.02), assistive: false))
  }

  func testALinkActivatedByAKeyOrThroughAnAssistiveTechnologyOpens() {
    // VoiceOver or Switch Control: no touch reaches the page. The person moves the focus onto the link and
    // activates it: that opens, once.
    var voice = PageGate()
    voice.pageLoaded(at: start)
    XCTAssertFalse(voice.allows(at: start.addingTimeInterval(5), assistive: true), "no focus in the page: a script's click")
    voice.focusLanded(at: start.addingTimeInterval(4), onLink: true)
    XCTAssertTrue(voice.open(at: start.addingTimeInterval(5), assistive: true))
    // A script clicking in a loop after it opens nothing more until the focus moves again.
    for step in 1...20 { XCTAssertFalse(voice.open(at: start.addingTimeInterval(5 + Double(step) * 0.2), assistive: true)) }
    voice.focusLanded(at: start.addingTimeInterval(10), onLink: true)
    XCTAssertTrue(voice.open(at: start.addingTimeInterval(10.5), assistive: true), "the next link the person goes to")
    // A landing on anything but a link arms nothing: a page clicking a link each second opens nothing as the person
    // reads it with swipes.
    var reading = PageGate()
    reading.pageLoaded(at: start)
    for step in 2...30 {
      reading.focusLanded(at: start.addingTimeInterval(Double(step)), onLink: false)
      XCTAssertFalse(reading.open(at: start.addingTimeInterval(Double(step) + 0.5), assistive: true), "a swipe onto words")
    }
    // A landing is good for a short while, not until whenever a script clicks.
    var stale = PageGate()
    stale.pageLoaded(at: start)
    stale.focusLanded(at: start.addingTimeInterval(2), onLink: true)
    XCTAssertFalse(stale.allows(at: start.addingTimeInterval(2 + PageGate.reach + 1), assistive: true))
    // The focus VoiceOver puts back as the page loads, or as the app returns from the browser, is not a landing:
    // after a link opened, the person lands again.
    var early = PageGate()
    early.pageLoaded(at: start)
    early.focusLanded(at: start.addingTimeInterval(0.3), onLink: true)
    XCTAssertFalse(early.allows(at: start.addingTimeInterval(1.5), assistive: true))
    var back = PageGate()
    back.pageLoaded(at: start)
    back.focusLanded(at: start.addingTimeInterval(2), onLink: true)
    XCTAssertTrue(back.open(at: start.addingTimeInterval(3), assistive: true))
    back.appActivated(at: start.addingTimeInterval(20))
    back.focusLanded(at: start.addingTimeInterval(20.2), onLink: true)
    XCTAssertFalse(back.allows(at: start.addingTimeInterval(21), assistive: true), "the focus restored on return")
    back.focusLanded(at: start.addingTimeInterval(23), onLink: true)
    XCTAssertTrue(back.allows(at: start.addingTimeInterval(23.5), assistive: true), "the person's next landing")
    // A tap opens one link, not every link a script clicks after it.
    var tap = PageGate()
    tap.touchBegan(at: start, x: 10, y: 10)
    tap.touchEnded(at: start.addingTimeInterval(0.05), x: 10, y: 10)
    XCTAssertTrue(tap.open(at: start.addingTimeInterval(0.1), assistive: false))
    XCTAssertFalse(tap.open(at: start.addingTimeInterval(0.15), assistive: false))
    // Return or Space on a hardware keyboard.
    var keys = PageGate()
    keys.keyPressed(at: start, editing: false)
    XCTAssertTrue(keys.allows(at: start.addingTimeInterval(0.05), assistive: false))
    XCTAssertFalse(keys.allows(at: start.addingTimeInterval(PageGate.window + 0.1), assistive: false))
    // Return typed into the page's own field arms nothing: a script clicking a link as the person types opens none.
    var typing = PageGate()
    typing.keyPressed(at: start, editing: true)
    XCTAssertFalse(typing.allows(at: start.addingTimeInterval(0.05), assistive: false))
  }

  func testAFocusThePagesScriptMovedIsNotThePersonsLanding() {
    // The script calls focus() on a link, and VoiceOver's focus lands there just after: no link opens.
    var after = PageGate()
    after.pageLoaded(at: start)
    after.scriptedFocus(at: start.addingTimeInterval(5))
    after.focusLanded(at: start.addingTimeInterval(5.2), onLink: true)
    XCTAssertFalse(after.allows(at: start.addingTimeInterval(5.5), assistive: true))
    // The landing is heard before the script's word of it: it is taken back.
    var before = PageGate()
    before.pageLoaded(at: start)
    before.focusLanded(at: start.addingTimeInterval(5), onLink: true)
    before.scriptedFocus(at: start.addingTimeInterval(5.3))
    XCTAssertFalse(before.allows(at: start.addingTimeInterval(5.5), assistive: true))
    // The person's own landing later still opens their link.
    after.focusLanded(at: start.addingTimeInterval(8), onLink: true)
    XCTAssertTrue(after.allows(at: start.addingTimeInterval(8.5), assistive: true))
  }

  // MARK: A document's links

  func testADocumentsLinkOpensASiteOrAMailAddressAndNothingElse() throws {
    for allowed in ["https://example.com/plan", "http://example.com", "HTTPS://EXAMPLE.COM", "mailto:someone@example.com"] {
      XCTAssertTrue(FileFacts.documentLinkOpens(try XCTUnwrap(URL(string: allowed))), allowed)
    }
    // Another app, the phone's dialer, a file, a script, and the app's own pairing link.
    for refused in ["plannotator://pair?secret=abc", "tel:5550100", "sms:5550100", "file:///etc/hosts", "javascript:alert(1)", "itms-apps://example", "app-settings:", "relative/path.md"] {
      XCTAssertFalse(FileFacts.documentLinkOpens(try XCTUnwrap(URL(string: refused))), refused)
    }
  }

  // MARK: Long text, cut for the screen

  /// Every row's text, as whole characters of the original: joined, the rows are the text.
  private func assertWhole(_ rows: TextRows, of text: String, file: StaticString = #filePath, line: UInt = #line) {
    let parts = rows.rows.map(rows.text)
    XCTAssertEqual(parts.joined(), text, "nothing is lost or doubled", file: file, line: line)
    var seen = Substring(text)
    for part in parts {
      // A row that began or ended inside a character would not be a prefix of what is left, character by character.
      XCTAssertTrue(seen.starts(with: part), "a row starts and ends between characters", file: file, line: line)
      seen = seen.dropFirst(part.count)
    }
    XCTAssertTrue(seen.isEmpty, file: file, line: line)
  }

  func testARunWithNoBreakIsCutBetweenWholeCharacters() {
    // Families and flags are several scalars joined; an accented letter is a letter and its marks.
    let family = "👨‍👩‍👧‍👦"
    let flag = "🇵🇹"
    let accented = "e\u{0301}\u{0323}"
    for unit in [family, flag, accented, "👍🏽"] {
      // Offsets so the cut falls at every place inside the unit.
      for lead in 0..<unit.utf8.count {
        let text = String(repeating: "x", count: lead) + String(repeating: unit, count: (TextRows.piece * 3) / unit.utf8.count)
        let rows = TextRows.code(text)
        XCTAssertGreaterThan(rows.rows.count, 2, unit)
        assertWhole(rows, of: text)
        for row in rows.rows { XCTAssertLessThanOrEqual(rows.text(row).utf8.count, TextRows.piece) }
      }
    }
  }

  func testALongDocumentBlockIsCutWhereNoInlineMarkdownIsOpen() {
    // A paragraph of sentences, each holding bold words, code, a link and emphasis, far past one part's size.
    let sentence = "The **retry loop** calls `socket.open()` again, see [the plan for the relay client](https://example.com/plans/relay?x=1) and _measure it_ first. "
    let block = String(repeating: sentence, count: (DocumentRows.blockCap * 3) / sentence.utf8.count)
    let parts = DocumentRows.parts(block)
    XCTAssertGreaterThan(parts.count, 2)
    for part in parts {
      XCTAssertLessThanOrEqual(part.utf8.count, DocumentRows.blockCap)
      // Each part is Markdown on its own: every mark it opens it closes.
      XCTAssertEqual(part.components(separatedBy: "**").count % 2, 1, "bold is whole in a part")
      XCTAssertEqual(part.components(separatedBy: "`").count % 2, 1, "code is whole in a part")
      XCTAssertEqual(part.components(separatedBy: "[").count, part.components(separatedBy: "](").count, "a link's words keep its address")
      XCTAssertEqual(part.components(separatedBy: "](").count, part.components(separatedBy: ")").count - part.components(separatedBy: "()").count + 1, "a link's address is whole")
    }
    XCTAssertEqual(parts.joined(), block, "nothing is lost")

    // A blank line is preferred to a line break, and a line break to a space.
    let paragraphs = String(repeating: String(repeating: "word ", count: 500) + "\n\n", count: 12)
    for part in DocumentRows.parts(paragraphs).dropLast() { XCTAssertTrue(part.hasSuffix("word "), "a part ends where a paragraph ends") }

    // No place at all (one long word of emoji): cut between whole characters.
    let run = String(repeating: "👨‍👩‍👧‍👦", count: DocumentRows.blockCap / 10)
    XCTAssertEqual(DocumentRows.parts(run).joined(), run)
    for part in DocumentRows.parts(run) { XCTAssertEqual(part.count * "👨‍👩‍👧‍👦".utf8.count, part.utf8.count, "no family is parted") }
  }

  // MARK: A kept copy while the computer is away

  func testACopyKeptWhileTheComputerIsAwaySaysSoAndIsNotCalledTheFileAsItIsNow() async throws {
    let door = StandInDoor()
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("inbox-core-tests-\(UUID().uuidString)", isDirectory: true)
    _ = await door.addFile(thread: StandInData.docs, name: "plan.md", kind: .markdown, bytes: Data("# Sent".utf8))
    let first = await pairedSession(door: door, bytes: AttachmentCache(folder: folder))
    await first.start()
    await first.open(StandInData.docs)
    let sent = try XCTUnwrap(first.attachments(StandInData.docs).first)
    await door.changeFile(sent.id.rawValue, to: Data("# Now".utf8))
    await first.readAttachments(StandInData.docs)
    let changed = try XCTUnwrap(first.attachments(StandInData.docs).first)
    _ = try await first.openAttachment(changed)
    // The computer answers: the file is the current one, and the sent version is on offer.
    let here = first.opening(changed, asked: nil)
    XCTAssertFalse(here.keptCopy)
    XCTAssertEqual(here.version, .current)

    // The app starts again with the computer away: what opens is the copy this phone kept.
    await door.setOffline(true)
    let again = await pairedSession(door: door, bytes: AttachmentCache(folder: folder))
    let opening = again.opening(sent, asked: nil)
    XCTAssertTrue(opening.keptCopy, "it is a kept copy, and says so: not 'changed since sent' with a sent version on offer")
    XCTAssertEqual(opening.version, .current)
    let keptFile = try await again.openAttachment(opening.item)
    XCTAssertEqual(try String(contentsOf: keptFile, encoding: .utf8), "# Now")
    // Asked for the sent version: that is what is asked for, not the kept copy.
    XCTAssertFalse(again.opening(sent, asked: .sent).keptCopy)
  }

  // MARK: Lines and marks

  func testATouchOnALineStartsARunStretchesItOrStartsOver() {
    XCTAssertEqual(FileComments.run(nil, touched: 7), 7...7)
    XCTAssertEqual(FileComments.run(7...7, touched: 11), 7...11, "another line: from the one to the other")
    XCTAssertEqual(FileComments.run(7...11, touched: 3), 3...11, "above the run: it stretches up")
    XCTAssertEqual(FileComments.run(3...11, touched: 14), 3...14)
    XCTAssertEqual(FileComments.run(3...14, touched: 9), 9...9, "inside the run: start over from that line")
    XCTAssertEqual(FileComments.run(9...9, touched: 9), 9...9)
  }

  func testAMarkIsSizedForTheFingerAndNeverLostWhenThePictureIsWhole() {
    // A wide picture shown whole on a phone: about a sixth of a point per pixel.
    let whole = 393.0 / 2400.0
    XCTAssertEqual(PictureMark.strokeSize(zoom: whole, longest: 2400), 3.5 / whole, accuracy: 0.001, "three and a half points under the finger")
    // Looked into eight times: the line is thin in pixels, to mark a small thing, but not thinner than the floor.
    XCTAssertEqual(PictureMark.strokeSize(zoom: 8, longest: 2400), 2400 / 500, accuracy: 0.001)
    XCTAssertEqual(PictureMark.pinSize(zoom: 8, longest: 2400), 2400.0 / 70, accuracy: 0.001)
    XCTAssertEqual(PictureMark.pinSize(zoom: whole, longest: 2400), 13 / whole, accuracy: 0.001)

    // Where to look to see a comment's marks: around all of them, with their own size.
    let marks = [PictureMark(kind: .pin, points: [100, 200], size: 10), PictureMark(kind: .stroke, points: [300, 50, 400, 260], size: 4)]
    let box = try? XCTUnwrap(PictureMark.bounds(marks))
    XCTAssertEqual(box?.x, 90)
    XCTAssertEqual(box?.y, 46)
    XCTAssertEqual(box?.width, 314)
    XCTAssertEqual(box?.height, 218)
    XCTAssertNil(PictureMark.bounds([]))
  }

  func testWhatWasDrawnStaysWithItsCommentAcrossAReadAndClosingTheApp() async throws {
    let door = StandInDoor()
    await door.addFilesThread()
    _ = await door.addFile(thread: StandInData.files, message: StandInData.filesSecond, name: "flame.png", kind: .image, bytes: Data([0x89, 0x50, 0x4E, 0x47, 1, 2, 3]), mediaType: "image/png")
    let copy = LocalCopy(folder: FileManager.default.temporaryDirectory.appendingPathComponent("inbox-core-tests-\(UUID().uuidString)", isDirectory: true))
    let session = await pairedSession(door: door, copy: copy)
    await session.start()
    await session.open(StandInData.files)
    await session.readAttachments(StandInData.files)
    let picture = try XCTUnwrap(session.attachments(StandInData.files).first { $0.name == "flame.png" })
    let marks = [PictureMark(kind: .pin, points: [40, 60], size: 12)]
    let made = try XCTUnwrap(session.addComment(thread: StandInData.files, item: picture, version: .current, annotation: FileComments.picture(name: picture.name, comment: "Here.", markup: nil), drawing: Data([0x89, 0x50, 0x4E, 0x47, 9]), marks: marks))
    for _ in 0..<100 where session.held.contains(where: { $0.kind == .annotation || $0.kind == .markup }) {
      await session.deliverHeld(thread: StandInData.files)
      try? await Task.sleep(for: .milliseconds(5))
    }
    // The computer's list has the comment, with no marks (they are the phone's): the read does not wipe them.
    await session.readAttachments(StandInData.files)
    XCTAssertEqual(session.comments(StandInData.files).first?.marks, marks)
    let record = await door.comment(made.id)
    let kept = try XCTUnwrap(record)
    XCTAssertNil(kept.annotation["marks"], "the computer gets the flattened drawing, never the marks")
    session.stop()
    let again = await pairedSession(door: door, copy: copy)
    await again.start()
    XCTAssertEqual(again.comments(StandInData.files).first?.marks, marks)
  }
}
