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

  func testTheArrowDoesToTheReplyBoxWhatTheWindowsDoes() throws {
    let suite = try Contract.json("vectors/quote.json")
    let selected = try suite.at("selected").str()
    let arrows = try suite.at("arrows").items
    XCTAssertGreaterThanOrEqual(arrows.count, 5)
    for thread in arrows {
      let shape = try thread.at("shape").str()
      let messages = shape.enumerated().map { i, who in
        InboxMessageWire(
          seq: Int64(i), id: MessageID("msg_R\(i)"), projectId: ProjectID("p"), threadId: ThreadID("t"),
          author: who == "p" ? InboxAuthor(kind: .person) : InboxAuthor(kind: .agent, host: "claude-code", session: "ses_\(String(who).uppercased())"),
          body: "", createdAt: "2026-11-20T10:00:00.000Z")
      }
      for press in try thread.at("presses").items {
        let at = MessageID(try press.at("at").str())
        let words = press["words"]?.text
        XCTAssertTrue(words == nil || words == selected)
        let made = ReplyQuoteRules.arrow(messages, at: at, words: words, quoted: try XCTUnwrap(press.at("quoted").flag))
        let quote = try press.at("quote")
        let expected: DraftQuote?? = quote.text == "keep" ? nil : quote == .null ? .some(nil) : .some(DraftQuote(of: MessageID(try quote.at("of").str()), words: quote["words"]?.text))
        XCTAssertEqual(made.quote, expected, "\(shape) \(at) words \(words ?? "none")")
        XCTAssertEqual(made.aim, press["aim"]?.text, "\(shape) \(at)")
      }
    }
  }

  func testAWholeMessageIsQuotedAsTheStoresExcerpt() throws {
    let excerpts = try Contract.json("vectors/quote.json").at("excerpts").items
    XCTAssertGreaterThanOrEqual(excerpts.count, 8)
    for item in excerpts {
      let body = try item.at("body").str()
      XCTAssertEqual(ReplyQuoteRules.excerpt(person: try item.at("kind").str() == "person", body: body), try item.at("excerpt").str(), body)
    }
  }
}
