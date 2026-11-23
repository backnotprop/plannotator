import Foundation
import XCTest
@testable import InboxCore
import InboxWire

/// apps/mobile/contract/vectors/quote.json: the lead the Inbox writes in front of a quoting reply, the words the
/// window draws without it, and where ↩ quotes a whole message, held to the window's own functions.
final class QuoteVectorTests: XCTestCase {
  func testTheLeadIsWrittenAsTheInboxWritesIt() throws {
    let suite = try Contract.json("vectors/quote.json")
    let leads = try suite.at("leads").items
    XCTAssertGreaterThanOrEqual(leads.count, 4)
    for lead in leads {
      let input = try lead.at("input")
      let whose = try input.at("whose")
      let kind = try whose.at("kind").str()
      let who: ReplyQuoteRules.Whose = kind == "yours" ? .yours : kind == "mine" ? .mine : .theirs(try whose.at("name").str())
      let made = ReplyQuoteRules.lead(whose: who, id: try input.at("id").str(), time: input["time"]?.text, text: try input.at("text").str(), selected: try XCTUnwrap(input.at("selected").flag))
      XCTAssertEqual(made, try lead.at("lead").str())
    }
  }

  func testTheReplysWordsAreDrawnWithoutTheLead() throws {
    let bodies = try Contract.json("vectors/quote.json").at("bodies").items
    XCTAssertGreaterThanOrEqual(bodies.count, 20)
    for body in bodies {
      let text = try body.at("body").str()
      XCTAssertEqual(ReplyQuoteRules.withoutLead(text), try body.at("words").str(), text)
    }
  }

  func testTheArrowQuotesWholeOnlyWhenAnAgentWroteAfter() throws {
    for thread in try Contract.json("vectors/quote.json").at("threads").items {
      let shape = try thread.at("shape").str()
      let messages = shape.enumerated().map { i, who in
        InboxMessageWire(seq: Int64(i), id: MessageID("msg_Q\(i)"), projectId: ProjectID("p"), threadId: ThreadID("t"), author: InboxAuthor(kind: who == "a" ? .agent : .person), body: "", createdAt: "2026-11-20T10:00:00.000Z")
      }
      let expected = try thread.at("quotes").items.map { try XCTUnwrap($0.flag) }
      XCTAssertEqual(messages.map { ReplyQuoteRules.quotesWhole(messages, $0.id) }, expected, shape)
    }
  }
}
