import Foundation
import XCTest
@testable import InboxCore
import InboxStandIn
import InboxWire

/// A large file of words is bounded work for the viewer: rows a lazy list draws one at a time, none of them more
/// than a short piece of the file. And a file read before a relaunch opens with the computer away, as the version
/// it was.
@MainActor
final class FileRowsTests: XCTestCase {
  // MARK: Rows

  func testA3MBOneLineFileIsManyShortRowsNotOneText() {
    let line = String(repeating: "{\"id\":12345,\"name\":\"relay\",\"ok\":true},", count: 3_000_000 / 39)
    let code = TextRows.code(line)
    XCTAssertEqual(code.lines, 1)
    XCTAssertTrue(code.rows.allSatisfy { Int($0.end - $0.start) <= TextRows.piece }, "no row past a piece")
    XCTAssertGreaterThanOrEqual(code.rows.count, line.utf8.count / TextRows.piece)
    XCTAssertLessThanOrEqual(code.rows.count, line.utf8.count / (TextRows.piece / 2) + 1, "cut near a piece's end, not at every mark")
    XCTAssertEqual(code.rows.filter(\.first).count, 1, "one line: one number")
    XCTAssertEqual(code.rows.map(code.text).joined(), line, "nothing lost or doubled")

    // With no place to cut (a run of letters, a long word in another script), it is cut between whole characters.
    let word = String(repeating: "é", count: 1_500_000)
    let plain = TextRows.plain(word)
    XCTAssertTrue(plain.rows.allSatisfy { Int($0.end - $0.start) <= TextRows.piece })
    XCTAssertEqual(plain.rows.map(plain.text).joined(), word)
  }

  func testA20000LineFileIsARowPerLineFoundByItsNumber() {
    let text = (1...20_000).map { "line \($0): relay ping ok" }.joined(separator: "\n") + "\n"
    let code = TextRows.code(text)
    XCTAssertEqual(code.lines, 20_000)
    XCTAssertEqual(code.rows.count, 20_000)
    XCTAssertEqual(code.row(ofLine: 12_345).map { code.text(code.rows[$0]) }, "line 12345: relay ping ok")
    XCTAssertEqual(FileFacts.lines(text).count, code.lines, "counted as the editor counts")
    XCTAssertEqual(TextRows.code("a\r\n\r\nb").rows.count, 3)
    XCTAssertEqual(TextRows.code("").rows.count, 1)

    // Plain text: a row per paragraph.
    let notes = (1...20_000).map { "Paragraph \($0)." }.joined(separator: "\r\n\r\n")
    let plain = TextRows.plain(notes)
    XCTAssertEqual(plain.lines, 20_000)
    XCTAssertEqual(plain.rows.count, 20_000)
    XCTAssertEqual(plain.text(plain.rows[1]), "Paragraph 2.")
  }

  func testALongMarkdownBlockIsPartsAndALongTableIsARowPerRow() {
    let paragraph = String(repeating: "The relay retries with a growing wait. ", count: 3_000_000 / 39)
    let one = DocumentRows(text: paragraph, name: "notes.md")
    XCTAssertEqual(one.blocks.count, 1)
    XCTAssertGreaterThan(one.rows.count, 1)
    XCTAssertLessThanOrEqual(one.rows.count, paragraph.utf8.count / (DocumentRows.blockCap / 2) + 1)
    for row in one.rows {
      guard case .piece(_, let words, _) = row else { return XCTFail("a long paragraph is drawn in parts") }
      XCTAssertLessThanOrEqual(words.utf8.count, DocumentRows.blockCap)
    }

    let table = "| Attempt | Wait |\n|---|---|\n" + (1...5_000).map { "| \($0) | \($0 * 2) s |" }.joined(separator: "\n")
    let list = (1...20_000).map { "- item \($0)" }.joined(separator: "\n")
    let document = DocumentRows(text: "# Runs\n\n\(table)\n\n\(list)\n", name: "runs.md")
    XCTAssertEqual(document.rows.count, 1 + 1 + 5_000 + 20_000, "the heading, the table's head and rows, each item")
    XCTAssertEqual(document.tables[1]?.rows.count, 5_000)
    XCTAssertEqual(document.rows[1], .tableHead(block: 1))
    XCTAssertEqual(document.rows[2], .tableRow(block: 1, row: 0))
    // A short table is still one block, drawn as one.
    XCTAssertEqual(DocumentRows(text: "| a |\n|---|\n| 1 |\n", name: "t.md").rows, [.block(0)])
  }

  // MARK: A file's name on the phone

  func testAFileNamedAsNoFileCanBeOpensUnderANameThatCanBe() {
    XCTAssertEqual(FileFacts.localName("retry-plan.md"), "retry-plan.md")
    XCTAssertEqual(FileFacts.localName("a/b.md"), "a_b.md")
    for name in ["", ".", ".."] { XCTAssertEqual(FileFacts.localName(name), "file", name) }
    let long = String(repeating: "ü", count: 300) + ".json"
    XCTAssertLessThanOrEqual(FileFacts.localName(long).utf8.count, 255)
    XCTAssertTrue(FileFacts.localName(long).hasSuffix(".json"), "its kind is still in its name")
  }

  // MARK: After a relaunch, the computer away

  func testAChangedFileReadBeforeARelaunchOpensWithTheComputerAwayAsTheVersionItWas() async throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("inbox-core-tests-\(UUID().uuidString)", isDirectory: true)
    let door = StandInDoor()
    _ = await door.addFile(thread: StandInData.docs, name: "plan.md", kind: .markdown, bytes: Data("# Sent".utf8))
    let first = await pairedSession(door: door, bytes: AttachmentCache(folder: folder))
    await first.start()
    await first.open(StandInData.docs)
    let sent = try XCTUnwrap(first.attachments(StandInData.docs).first)
    await door.changeFile(sent.id.rawValue, to: Data("# Now".utf8))
    await first.readAttachments(StandInData.docs)
    let changed = try XCTUnwrap(first.attachments(StandInData.docs).first)
    let read = try await first.openAttachment(changed)
    XCTAssertEqual(try String(contentsOf: read, encoding: .utf8), "# Now")
    first.attachmentClosed(changed)
    first.stop()

    // The app starts again; the computer is away, so nothing says how the file stands: it opens as sent, which
    // this phone never read.
    await door.setOffline(true)
    let again = await pairedSession(door: door, bytes: AttachmentCache(folder: folder))
    let unasked = sent
    XCTAssertNil(unasked.changedSinceSent)
    XCTAssertEqual(again.availability(unasked), .notKept)
    let kept = try XCTUnwrap(again.lastKept(unasked), "the version read before opens")
    XCTAssertEqual(kept.changedSinceSent, true, "and says it is not the sent version")
    XCTAssertEqual(kept.opens, .current)
    let opened = try await again.openAttachment(kept)
    XCTAssertEqual(try String(contentsOf: opened, encoding: .utf8), "# Now")

    // A phone that keeps the sent version opens that, as before.
    XCTAssertNil(first.lastKept(changed), "asked: the computer's word stands")
  }

  func testAViewerReleasesItsOwnHoldNotAnotherVersions() async throws {
    let door = StandInDoor()
    _ = await door.addFile(thread: StandInData.docs, name: "plan.md", kind: .markdown, bytes: Data("# Sent".utf8))
    let session = await pairedSession(door: door, bytes: AttachmentCache(folder: FileManager.default.temporaryDirectory.appendingPathComponent("inbox-core-tests-\(UUID().uuidString)")))
    await session.start()
    await session.open(StandInData.docs)
    let item = try XCTUnwrap(session.attachments(StandInData.docs).first)
    await door.changeFile(item.id.rawValue, to: Data("# Now".utf8))
    await session.readAttachments(StandInData.docs)
    let changed = try XCTUnwrap(session.attachments(StandInData.docs).first)
    let sentOpen = try await session.openHeld(changed, version: .sent)
    let currentOpen = try await session.openHeld(changed, version: .current)
    let sent = try XCTUnwrap(sentOpen.hold)
    let current = try XCTUnwrap(currentOpen.hold)
    // The older open (the sent version) lets go after the newer one came.
    session.release(sent)
    XCTAssertEqual(session.files.open[item.id]?.map(\.key), [current.key])
    session.release(sent)
    XCTAssertEqual(session.files.open[item.id]?.map(\.key), [current.key], "a hold is released once")
    session.release(current)
    XCTAssertNil(session.files.open[item.id])
  }
}
