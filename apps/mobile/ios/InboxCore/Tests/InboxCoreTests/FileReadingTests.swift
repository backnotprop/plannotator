import Foundation
import XCTest
@testable import InboxCore
import InboxStandIn
import InboxWire

/// Opening files from a thread: what a tile says, how each kind is drawn, the blocks of a document (held to the
/// window's own, apps/mobile/contract/vectors/files.json and documents.json), the order a cover steps in, and how a
/// picture sits in the viewer.
@MainActor
final class FileReadingTests: XCTestCase {
  private func folder() -> URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("inbox-core-tests-\(UUID().uuidString)", isDirectory: true)
  }

  // MARK: The window's words

  func testASizeAndAMomentAreSaidAsTheWindowSaysThem() throws {
    let vectors = try Contract.json("vectors/files.json")
    XCTAssertEqual(Int(FileFacts.viewCap), try vectors.at("view_max_bytes").int())
    for expected in try vectors.at("sizes").items {
      let bytes = try XCTUnwrap(expected["bytes"]?.decoded(Double.self))
      XCTAssertEqual(FileFacts.bytes(Int64(bytes)), try expected.at("words").str(), "\(bytes) bytes")
    }
    for expected in try vectors.at("moments").items {
      let seconds = try XCTUnwrap(expected["seconds"]?.decoded(Double.self))
      XCTAssertEqual(FileFacts.moment(seconds), try expected.at("words").str(), "\(seconds) s")
    }
  }

  func testATileNamesAFilesKindAndSizeAndEachKindIsDrawnAsInTheWindow() throws {
    for expected in try Contract.json("vectors/files.json").at("files").items {
      let name = try expected.at("name").str()
      var record = InboxAttachment(
        id: "att_F", path: "/work/\(name)", name: name, kind: InboxAttachmentKind(rawValue: try expected.at("kind").str()), sentSha256: "", size: Int64(try expected.at("size").int()), sentAt: "", sentMtime: "",
        mediaType: expected["media_type"]?.text)
      record.width = try expected["width"]?.decoded(Double.self)
      record.height = try expected["height"]?.decoded(Double.self)
      record.durationMs = try expected["duration_ms"]?.decoded(Int64.self)
      var item = AttachmentItem(record: record, message: MessageID("msg_F"), inline: false)
      if let current = expected["current_size"]?.whole { item.current = InboxAttachmentStateCurrent(sha256: "", size: Int64(current), mtime: "") }
      XCTAssertEqual(FileFacts.kind(item.kind, name: name, mediaType: item.mediaType), try expected.at("label").str(), name)
      XCTAssertEqual(FileFacts.detail(item), try expected.at("detail").str(), name)
      XCTAssertEqual(FileFacts.viewKind(record.kind, name: name).rawValue, try expected.at("view_kind").str(), name)
    }
  }

  func testEachKindOpensInItsOwnViewerAndTextTooLargeIsNotDrawn() {
    XCTAssertEqual(FileFacts.shown(.image, name: "a.png", size: 10), .picture)
    XCTAssertEqual(FileFacts.shown(.markdown, name: "plan.md", size: 10), .document)
    XCTAssertEqual(FileFacts.shown(.text, name: "notes.txt", size: 10), .text)
    XCTAssertEqual(FileFacts.shown(.text, name: "run.log", size: 10), .code)
    XCTAssertEqual(FileFacts.shown(.code, name: "a.ts", size: 10), .code)
    XCTAssertEqual(FileFacts.shown(.mermaid, name: "flow.mmd", size: 10), .code)
    XCTAssertEqual(FileFacts.shown(.html, name: "page.html", size: 10), .page)
    XCTAssertEqual(FileFacts.shown(.video, name: "a.mp4", size: 10), .player)
    XCTAssertEqual(FileFacts.shown(.audio, name: "a.wav", size: 10), .player)
    XCTAssertEqual(FileFacts.shown(.pdf, name: "a.pdf", size: 10), .pdf)
    XCTAssertEqual(FileFacts.shown(.file, name: "a.zip", size: 10), .card)
    XCTAssertEqual(FileFacts.shown(.unknown("hologram"), name: "a.holo", size: 10), .card)
    // Past 16 MB a text file is a file to share, not a page to draw; a video of any size still plays.
    XCTAssertEqual(FileFacts.shown(.code, name: "a.ts", size: FileFacts.viewCap), .code)
    XCTAssertEqual(FileFacts.shown(.code, name: "a.ts", size: FileFacts.viewCap + 1), .card)
    XCTAssertEqual(FileFacts.shown(.markdown, name: "a.md", size: FileFacts.viewCap + 1), .card)
    XCTAssertEqual(FileFacts.shown(.video, name: "a.mp4", size: FileFacts.viewCap + 1), .player)
  }

  func testACodeFilesLinesAreCountedAsItsEditorCountsThem() {
    XCTAssertEqual(FileFacts.lines("a\nb\n").map(String.init), ["a", "b"])
    XCTAssertEqual(FileFacts.lines("a\r\n\r\nb").map(String.init), ["a", "", "b"])
    XCTAssertEqual(FileFacts.lines("").map(String.init), [""])
    XCTAssertEqual(FileFacts.lines(StandInData.log).count, 60)
  }

  // MARK: A document's blocks

  func testADocumentIsSplitIntoTheWindowsBlocksWithTheWindowsIds() throws {
    for document in try Contract.json("vectors/documents.json").at("documents").items {
      let name = try document.at("name").str()
      XCTAssertEqual(DocumentBlocks.stripsFrontmatter(name: name), try XCTUnwrap(document.at("strips_frontmatter").flag), name)
      let text = try document.at("text").str()
      XCTAssertTrue(DocumentBlocks.matchesWindow(text), name)
      let mine = DocumentBlocks.parse(text, frontmatter: DocumentBlocks.stripsFrontmatter(name: name))
      let numbers = DocumentBlocks.listNumbers(mine)
      let theirs = try document.at("blocks").items
      XCTAssertEqual(mine.map(\.id), try theirs.map { try $0.at("id").str() }, name)
      for (block, expected) in zip(mine, theirs) {
        let what = "\(name) \(block.id)"
        XCTAssertEqual(block.kind.rawValue, try expected.at("type").str(), what)
        XCTAssertEqual(block.content, try expected.at("content").str(), what)
        XCTAssertEqual(block.startLine, try expected.at("start_line").int(), what)
        XCTAssertEqual(block.level, expected["level"]?.whole, what)
        XCTAssertEqual(block.language, expected["language"]?.text, what)
        XCTAssertEqual(block.checked, expected["checked"]?.flag, what)
        XCTAssertEqual(block.ordered, expected["ordered"]?.flag, what)
        XCTAssertEqual(block.orderedStart, expected["ordered_start"]?.whole, what)
        XCTAssertEqual(block.alertKind, expected["alert_kind"]?.text, what)
        XCTAssertEqual(block.directiveKind, expected["directive_kind"]?.text, what)
        XCTAssertEqual(numbers[block.id], expected["number"]?.whole, what)
      }
    }
  }

  func testAFileWithPartsThePhoneDoesNotSplitYetSaysItsIdsAreNotTheWindows() {
    XCTAssertTrue(DocumentBlocks.matchesWindow(StandInData.plan))
    XCTAssertFalse(DocumentBlocks.matchesWindow("Words\n\n$$\nx^2\n$$\n"))
    XCTAssertFalse(DocumentBlocks.matchesWindow("<details>\n<summary>More</summary>\n</details>"))
    XCTAssertFalse(DocumentBlocks.matchesWindow("See [the plan][plan].\n\n[plan]: https://example.com/plan"))
    // It still reads: nothing is dropped.
    XCTAssertEqual(DocumentBlocks.parse("Words\n\n$$\nx^2\n$$\n").map(\.content), ["Words", "$$\nx^2\n$$"])
  }

  func testATablesCellsAreItsHeadingRowThenItsRows() {
    let table = DocumentBlocks.table("| Attempt | Wait |\n|---|---:|\n| 1 | 1 s |\n| a \\| b | `x|y` |\n| short |")
    XCTAssertEqual(table.head, ["Attempt", "Wait"])
    XCTAssertEqual(table.rows, [["1", "1 s"], ["a | b", "`x|y`"], ["short"]])
  }

  // MARK: The files of a thread

  func testACoverStepsThroughTheThreadsFilesMessageByMessageAndSaysWhereItIs() async throws {
    let door = StandInDoor()
    let made = await door.addFilesThread()
    let session = await pairedSession(door: door, bytes: AttachmentCache(folder: folder()))
    await session.start()
    await session.open(StandInData.files)
    await session.readAttachments(StandInData.files)
    let all = session.attachments(StandInData.files)
    XCTAssertEqual(all.map(\.name), [StandInData.planName, StandInData.codeName, StandInData.logName, StandInData.notesName, StandInData.pageName, "stand-up.wav"])
    // A message's own files are the ones under it.
    XCTAssertEqual(all.filter { $0.message == StandInData.filesSecond }.map(\.name), [StandInData.pageName, "stand-up.wav"])
    let steps = FileFacts.Steps(all)
    let page = try XCTUnwrap(all.first { $0.name == StandInData.pageName })
    XCTAssertEqual(steps.place(page.id)?.at, 5)
    XCTAssertEqual(steps.place(page.id)?.of, 6)
    XCTAssertNil(FileFacts.Steps([page]).place(page.id), "a file alone has no count")
    XCTAssertEqual(made.count, 6)
  }

  func testADocumentOpensFromItsBytesAndAgainWithTheComputerAway() async throws {
    let door = StandInDoor()
    await door.addFilesThread()
    let session = await pairedSession(door: door, bytes: AttachmentCache(folder: folder()))
    await session.start()
    await session.open(StandInData.files)
    await session.readAttachments(StandInData.files)
    let plan = try XCTUnwrap(session.attachments(StandInData.files).first { $0.name == StandInData.planName })
    XCTAssertEqual(session.availability(plan), .fetchable)
    let url = try await session.openAttachment(plan)
    XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), StandInData.plan)
    session.attachmentClosed(plan)
    // Away: the kept file opens; one never opened says it is not kept.
    await door.setOffline(true)
    await session.refresh()
    let again = try await session.openAttachment(plan)
    XCTAssertEqual(try String(contentsOf: again, encoding: .utf8), StandInData.plan)
    session.attachmentClosed(plan)
    let code = try XCTUnwrap(session.attachments(StandInData.files).first { $0.name == StandInData.codeName })
    XCTAssertEqual(session.availability(code), .notKept)
    do {
      _ = try await session.openAttachment(code)
      XCTFail("a file not kept does not open while the computer is away")
    } catch let error as AttachmentError {
      XCTAssertEqual(error, .notKept)
    }
  }

  func testAFileThatChangedOpensAsItIsNowAndTheSentVersionStillOpens() async throws {
    let door = StandInDoor()
    let made = await door.addFilesThread()
    let session = await pairedSession(door: door, bytes: AttachmentCache(folder: folder()))
    await session.start()
    await session.open(StandInData.files)
    await door.changeFile(made[0].id, to: Data("# Retry plan, second draft\n".utf8))
    await session.readAttachments(StandInData.files)
    let plan = try XCTUnwrap(session.attachments(StandInData.files).first { $0.name == StandInData.planName })
    XCTAssertEqual(plan.changedSinceSent, true)
    XCTAssertEqual(plan.opens, .current)
    let now = try await session.openAttachment(plan)
    XCTAssertEqual(try String(contentsOf: now, encoding: .utf8), "# Retry plan, second draft\n")
    let sent = try await session.openAttachment(plan, version: .sent)
    XCTAssertEqual(try String(contentsOf: sent, encoding: .utf8), StandInData.plan)
    // Gone from the computer: the sent version is what opens.
    await door.changeFile(made[0].id, to: nil)
    await session.readAttachments(StandInData.files)
    let gone = try XCTUnwrap(session.attachments(StandInData.files).first { $0.name == StandInData.planName })
    XCTAssertEqual(gone.opens, .sent)
    XCTAssertNotNil(gone.unavailable)
  }

  // MARK: A picture in the viewer

  func testAVeryWidePictureOpensWholeAndIsPinchedInto() {
    // 2400 × 576 in a 393 × 700 room: all of it shows, at a sixth of its size.
    let whole = PictureFit.whole(width: 2400, height: 576, roomWidth: 393, roomHeight: 700)
    XCTAssertEqual(whole, 393.0 / 2400, accuracy: 0.0001)
    XCTAssertLessThanOrEqual(2400 * whole, 393.0001)
    // A tall one is held by its height; a small one is not blown up.
    XCTAssertEqual(PictureFit.whole(width: 400, height: 4000, roomWidth: 393, roomHeight: 700), 0.175, accuracy: 0.0001)
    XCTAssertEqual(PictureFit.whole(width: 120, height: 80, roomWidth: 393, roomHeight: 700), 1)
    // A pinch goes to eight times the picture's own points.
    XCTAssertEqual(PictureFit.most(whole: whole), 8)
    // A double tap on the wide one goes in until its height fills the room (capped at its own size), and back out.
    let near = PictureFit.doubleTap(from: whole, whole: whole, width: 2400, height: 576, roomWidth: 393, roomHeight: 700)
    XCTAssertEqual(near, 1, accuracy: 0.0001)
    XCTAssertEqual(PictureFit.doubleTap(from: near, whole: whole, width: 2400, height: 576, roomWidth: 393, roomHeight: 700), whole)
    // On a picture that already fills the room it goes in to twice.
    let fits = PictureFit.whole(width: 786, height: 1400, roomWidth: 393, roomHeight: 700)
    XCTAssertEqual(PictureFit.doubleTap(from: fits, whole: fits, width: 786, height: 1400, roomWidth: 393, roomHeight: 700), 1, accuracy: 0.0001)
  }
}
