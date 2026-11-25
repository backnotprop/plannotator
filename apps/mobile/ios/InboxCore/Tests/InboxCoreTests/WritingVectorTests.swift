import Foundation
import XCTest
@testable import InboxCore
import InboxWire

/// apps/mobile/contract/vectors/writing.json: who the reply box can tag with `@` and what a pick writes, who a sent
/// reply's tags name, the line under a 👍 and where Take back is offered, held to the window's own functions.
final class WritingVectorTests: XCTestCase {
  private let suite = "vectors/writing.json"
  private func time(_ iso: String) -> String { "T(\(iso))" }

  func testTheTagListsRowsAreTheWindows() throws {
    let cases = try Contract.json(suite).at("taggable").items
    XCTAssertGreaterThanOrEqual(cases.count, 4)
    for item in cases {
      guard case .object(var fields) = try item.at("model") else { return XCTFail("a model") }
      fields["serverSession"] = .string("s")
      let model = try JSONValue.object(fields).decoded(DoorTaggableAnswer.self)
      let made = TagRules.options(model, owner: item["owner"]?.text, project: item["project"]?.text, time: time)
      let expected = try item.at("options").items
      let name = try item.at("name").str()
      XCTAssertEqual(made.count, expected.count, name)
      for (row, want) in zip(made, expected) {
        XCTAssertEqual(row.id, try want.at("id").str())
        XCTAssertEqual(row.label, try want.at("label").str())
        XCTAssertEqual(row.agent, try want.at("agent").str())
        XCTAssertEqual(row.detail, try want.at("detail").str())
        XCTAssertEqual(row.group, try want.at("group").str())
        XCTAssertEqual(row.owner, try XCTUnwrap(want.at("owner").flag))
        XCTAssertEqual(row.wakes, try XCTUnwrap(want.at("wakes").flag))
        XCTAssertEqual(row.taggable, try XCTUnwrap(want.at("taggable").flag))
        XCTAssertEqual(TagRules.picked(row), try want.at("picked").str())
      }
      // Every row tagged, last first: the owner is left out, the rest in that order.
      let send = try item.at("send")
      let order = try send.at("order").strings
      let tags = order.compactMap { id in made.first { $0.id == id }.map { DraftTag(session: $0.id, host: $0.host, label: $0.label) } }
      let sent = TagRules.toSend(tags, owner: send["owner"]?.text)
      let want = try send.at("tags").items
      XCTAssertEqual(sent.map(\.session), try want.map { try $0.at("session").str() })
      XCTAssertEqual(sent.map(\.label), want.map { $0["label"]?.text })
    }
  }

  func testAtOpensTheListWhereTheWindowOpensIt() throws {
    let cases = try Contract.json(suite).at("triggers").items
    XCTAssertGreaterThanOrEqual(cases.count, 8)
    for item in cases {
      let text = try item.at("text").str()
      let made = TagRules.trigger(text, caret: try item.at("caret").int())
      let want = try item.at("trigger")
      if want == .null {
        XCTAssertNil(made, text)
      } else {
        XCTAssertEqual(made, MentionTrigger(query: try want.at("query").str(), from: try want.at("from").int(), to: try want.at("to").int()), text)
      }
    }
  }

  func testAPickWritesTheWindowsToken() throws {
    for item in try Contract.json(suite).at("picks").items {
      let text = try item.at("text").str()
      let trigger = try XCTUnwrap(TagRules.trigger(text, caret: try item.at("caret").int()))
      let made = TagRules.pick(text, trigger, label: try item.at("label").str())
      XCTAssertEqual(made.text, try item.at("result").at("text").str())
      XCTAssertEqual(made.caret, try item.at("result").at("caret").int())
      XCTAssertEqual(TagRules.sanitize(try item.at("label").str()), try item.at("token").str())
    }
  }

  func testATagStandsWhileItsTokenDoes() throws {
    for item in try Contract.json(suite).at("surviving").items {
      let text = try item.at("text").str()
      XCTAssertEqual(TagRules.surviving(text, labels: try item.at("labels").strings), try item.at("kept").strings, text)
    }
  }

  func testASentRepliesTagsAreNamedAsTheWindowNamesThem() throws {
    for item in try Contract.json(suite).at("tagNames").items {
      let tag = try item.at("tag")
      let made = TagRules.name(
        InboxTag(host: tag["host"]?.text, session: try tag.at("session").str(), name: tag["name"]?.text, label: tag["label"]?.text, wakes: true),
        ownerHost: item["ownerHost"]?.text, ownerSession: item["ownerSession"]?.text)
      XCTAssertEqual(made, try item.at("name").str())
    }
  }

  func testEachTaggedAgentsLineIsTheWindows() throws {
    let cases = try Contract.json(suite).at("tagLines").items
    XCTAssertGreaterThanOrEqual(cases.count, 5)
    for item in cases {
      let made = TagRules.line(try item.at("tag").decoded(InboxTag.self), name: try item.at("name").str(), time: time)
      XCTAssertEqual(made.text, try item.at("line").at("text").str())
      XCTAssertEqual(made.state, try item.at("line").at("state").str())
    }
  }

  func testTheLineUnderALooksGoodIsTheWindows() throws {
    let cases = try Contract.json(suite).at("acks").items
    XCTAssertGreaterThanOrEqual(cases.count, 6)
    for item in cases {
      let ack = try item.at("ack").decoded(InboxAck.self)
      let made = Reactions.line(ack, agent: try item.at("agent").str(), wakes: try XCTUnwrap(item.at("wakes").flag), time: time)
      XCTAssertEqual(made.text, try item.at("line").at("text").str())
      XCTAssertEqual(made.state.rawValue, try item.at("line").at("state").str())
    }
  }

  func testTakeBackIsOfferedWhereTheWindowOffersIt() throws {
    let cases = try Contract.json(suite).at("takeBack").items
    XCTAssertGreaterThanOrEqual(cases.count, 12)
    for item in cases {
      let messages = try item.at("threads").items.enumerated().map { index, entry -> InboxMessageWire in
        let parts = entry.items
        let person = parts.first?.text == "person"
        var fields: [String: JSONValue] = [
          "id": .string("msg_T\(index)"), "thread_id": .string("msg_T0"), "project_id": .string("prj"), "body": .string("words"), "created_at": .string("2026-11-23T10:00:00.000Z"),
          "author": person ? .object(["kind": .string("person")]) : .object(["kind": .string("agent"), "host": .string("pi"), "session": .string("ses_a")]),
        ]
        if case .object(let extra)? = parts.dropFirst().first {
          for (key, value) in extra {
            // A question names only what the rule reads: fill in the rest a question must have.
            if key == "questions" {
              fields[key] = .array(value.items.map { q in
                guard case .object(var question) = q else { return q }
                for (name, filler) in ["position": JSONValue.number(0), "kind": .string("single"), "prompt": .string("p"), "choices": .array([]), "state": .string("sent"), "revision": .number(1), "sent_revision": .number(1), "message_id": .string("msg_T\(index)"), "orphaned": .bool(false), "holds_up": .array([])] where question[name] == nil { question[name] = filler }
                return .object(question)
              })
            } else {
              fields[key] = value
            }
          }
        }
        return try JSONValue.object(fields).decoded(InboxMessageWire.self)
      }
      let at = try item.at("at").int()
      let name = try item.at("name").str()
      XCTAssertEqual(TakeBackRule.offered(messages[at], in: messages), try XCTUnwrap(item.at("offered").flag), name)
    }
  }

  func testAReactionIsSpokenByTheWindowsNameForItsEmoji() throws {
    let cases = try Contract.json(suite).at("speech").items
    XCTAssertGreaterThanOrEqual(cases.count, 6)
    for item in cases {
      let emoji = try item.at("emoji").str()
      XCTAssertEqual(Reactions.speech(emoji), try item.at("said").str(), emoji)
    }
  }
}
