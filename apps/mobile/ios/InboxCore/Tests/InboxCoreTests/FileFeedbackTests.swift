import Foundation
import XCTest
@testable import InboxCore
import InboxWire

/// The text a Send carries for comments on files, held to the window's own (apps/mobile/contract/vectors/
/// feedback.json, made by running packages/inbox/attachments.ts `attachmentFeedback` and the window's makers of a
/// code comment and a picture comment), and the rule for which comments the phone writes at all.
final class FileFeedbackTests: XCTestCase {
  private func comment(_ record: JSONValue, thread: String = "msg_FEEDBACK") throws -> FileComment {
    FileComment(
      id: try record.at("id").str(), thread: ThreadID(thread), attachment: AttachmentID(try record.at("attachment_id").str()), version: try record.at("version").str(),
      annotation: try record.at("annotation").decoded([String: JSONValue].self), createdAt: "")
  }

  private func file(_ value: JSONValue) throws -> FeedbackFile {
    FeedbackFile(id: try value.at("id").str(), path: try value.at("path").str(), name: try value.at("name").str(), kind: try value.at("kind").str())
  }

  func testTheFeedbackTextIsTheWindowsByteForByte() throws {
    let cases = try Contract.json("vectors/feedback.json").at("cases").items
    XCTAssertGreaterThanOrEqual(cases.count, 4)
    for one in cases {
      let name = try one.at("name").str()
      let files = try one.at("attachments").items.map(file)
      let texts = try one.at("texts").decoded([String: String].self)
      let comments = try one.at("records").items.map { try comment($0) }
      // Every comment of the suite is one the phone says it writes.
      for comment in comments {
        XCTAssertTrue(FileFeedback.carries(comment, file: files.first { $0.id == comment.attachment.rawValue }, text: texts[FileFeedback.textKey(comment.attachment, comment.version)]), "\(name) \(comment.id)")
      }
      // A page a question shows as a prototype is filed under its option, by the window's own rule.
      var prototypes: [String: String] = [:]
      if let messages = one["messages"] {
        prototypes = PrototypeNames.attachments(try messages.decoded([PrototypeNames.Message].self), root: try one.at("project_root").str())
        XCTAssertEqual(prototypes, try one.at("prototype_names").decoded([String: String].self), name)
      }
      XCTAssertEqual(FileFeedback.text(comments, files: files, texts: texts, projectRoot: try one.at("project_root").str(), prototypes: prototypes), try one.at("feedback").str(), name)
    }
  }

  /// A made annotation without the two fields the maker stamps itself.
  private func bare(_ annotation: [String: JSONValue]) -> JSONValue {
    var fields = annotation
    fields["id"] = nil
    fields["createdA"] = nil
    return .object(fields)
  }

  func testACodeCommentIsMadeAsTheWindowMakesIt() throws {
    let cases = try Contract.json("vectors/feedback.json").at("code_comments").items
    XCTAssertGreaterThanOrEqual(cases.count, 8)
    for one in cases {
      let mine = FileComments.lines(lineStart: try one.at("line_start").int(), lineEnd: try one.at("line_end").int(), code: try one.at("code").str(), comment: try one.at("text").str())
      XCTAssertEqual(bare(mine), try one.at("annotation"), one["text"]?.text ?? "")
    }
  }

  func testAPictureCommentIsMadeAsTheWindowMakesIt() throws {
    for one in try Contract.json("vectors/feedback.json").at("image_comments").items {
      let markup = try one["markup"].flatMap { value -> FileComment.Picture? in
        if case .null = value { return nil }
        return FileComment.Picture(path: try value.at("path").str(), name: try value.at("name").str())
      }
      let mine = FileComments.picture(name: try one.at("name").str(), comment: try one.at("words").str(), markup: markup)
      XCTAssertEqual(bare(mine), try one.at("annotation"), one["words"]?.text ?? "")
    }
  }

  func testLongLinesAreToldApartByTheWindowsHash() throws {
    for one in try Contract.json("vectors/feedback.json").at("hashes").items {
      XCTAssertEqual(FileComments.hash(try one.at("text").str()), try one.at("hash").str())
    }
  }

  // MARK: What the phone leaves to the window

  private let plan = FeedbackFile(id: "att_P", path: "/work/plan.md", name: "plan.md", kind: "markdown")

  private func made(_ annotation: [String: JSONValue], on file: String = "att_P") -> FileComment {
    FileComment(id: "a", thread: ThreadID("t"), attachment: AttachmentID(file), version: FileComment.current, annotation: annotation, createdAt: "")
  }

  func testACommentThePhoneCannotWriteAsTheWindowDoesIsNotCarried() {
    let words = FileComments.words(block: "block-0", start: 0, quote: "Plan", comment: "Why?")
    XCTAssertTrue(FileFeedback.carries(made(words), file: plan, text: "# Plan\n"))
    // The window writes each of these in a way of its own: a quick label, a tag of an agent, a part of a diagram,
    // a moment of a video, a picture added to the comment (an upload that rides the reply as a file).
    for (key, value) in [("isQuickLabel", JSONValue.bool(true)), ("mentions", .array([.string("ses_1")])), ("diagramAnchor", .object(["kind": .string("node")])), ("inboxVideo", .object(["time": .number(2)])), ("inReplyTo", .string("b"))] {
      var other = words
      other[key] = value
      XCTAssertFalse(FileFeedback.carries(made(other), file: plan, text: "# Plan\n"), key)
    }
    var withUpload = words
    withUpload["images"] = .array([.object(["path": .string("upl_01ABC/shot.png"), "name": .string("shot")])])
    XCTAssertFalse(FileFeedback.carries(made(withUpload), file: plan, text: "# Plan\n"))
    // A kind the phone does not comment on, a picture a message's words show, a file it does not know.
    XCTAssertFalse(FileFeedback.carries(made(words), file: FeedbackFile(id: "att_P", path: "/work/flow.mmd", name: "flow.mmd", kind: "mermaid"), text: "graph TD"))
    XCTAssertFalse(FileFeedback.carries(made(words), file: FeedbackFile(id: "att_P", path: "/work/a.png", name: "a.png", kind: "image", inline: true), text: nil))
    XCTAssertFalse(FileFeedback.carries(made(words), file: nil, text: nil))
  }

  func testAPlaceInADocumentIsCarriedOnlyWhereThePhoneSplitsTheFileAsTheWindowDoes() {
    let math = "Words\n\n$$\nx^2\n$$\n\nMore words\n"
    // A block of a file with display math: the phone's block ids part from the window's there, so the line the
    // feedback would name could be wrong. Not written by the phone.
    XCTAssertFalse(FileFeedback.carries(made(FileComments.words(block: "block-1", start: 0, quote: "More", comment: "Why?")), file: plan, text: math))
    // The text of the file is not on the phone: its lines cannot be named.
    XCTAssertFalse(FileFeedback.carries(made(FileComments.words(block: "block-1", start: 0, quote: "More", comment: "Why?")), file: plan, text: nil))
    // The same words with no block: the quote finds the place, and the feedback names no line.
    let placeless = made(FileComments.words(block: "", start: 12, quote: "More", comment: "Why?"))
    XCTAssertTrue(FileFeedback.carries(placeless, file: plan, text: math))
    let text = FileFeedback.text([placeless], files: [plan], texts: ["att_P|current": math], projectRoot: "/work")
    XCTAssertTrue(text.contains("### 1. Feedback on: \"More\"\n> Why?"), text)
  }

  func testAPinQuotesTheElementsWordsOrNamesTheElement() throws {
    let answer: JSONValue = .object([
      "tag": .string("button"), "text": .string("  Refresh\n now "), "selector": .string("#b"), "x": .number(40), "y": .number(912.26), "path": .string("body > section > button#b"),
      "rect": .object(["x": .number(36.04), "y": .number(900), "w": .number(96), "h": .number(44), "vw": .number(393), "vh": .number(700)]),
    ])
    let element = try XCTUnwrap(PinnedElement(answer))
    XCTAssertEqual(element.quote, "Refresh now")
    let pin = FileComments.pin(element: element, order: 2, comment: "Does nothing.")
    let comment = made(pin, on: "att_H")
    let page = FeedbackFile(id: "att_H", path: "/work/canary.html", name: "canary.html", kind: "html")
    XCTAssertTrue(FileFeedback.carries(comment, file: page, text: nil))
    let text = FileFeedback.text([comment], files: [page], texts: [:], projectRoot: "/work")
    XCTAssertTrue(text.contains("### 1. Feedback on: \"Refresh now\"\n> Does nothing.\n\n- **selector** `#b`\n- **path** `body > section > button#b`\n- **text** \"Refresh now\"\n- **box** 36,900 96×44 (viewport 393×700)\n"), text)
    XCTAssertEqual(comment.pinPoint?.y, 912.26)

    // An element with no words of its own is named by what it is, as the window names one.
    let bare = try XCTUnwrap(PinnedElement(.object(["tag": .string("img"), "x": .number(1), "y": .number(2)])))
    XCTAssertEqual(bare.quote, "[element: img]")
    let named = FileFeedback.text([made(FileComments.pin(element: bare, order: 0, comment: "Swap it."), on: "att_H")], files: [page], texts: [:], projectRoot: "/work")
    XCTAssertTrue(named.contains("### 1. Feedback on the <img> element\n> Swap it."), named)

    // What is not an element's answer is not a pin: a tag that is not a tag, a point that is not a number.
    XCTAssertNil(PinnedElement(.object(["tag": .string("<script>"), "x": .number(1), "y": .number(2)])))
    XCTAssertNil(PinnedElement(.object(["tag": .string("p"), "x": .string("1"), "y": .number(2)])))
    XCTAssertNil(PinnedElement(.string("p")))
  }
}
