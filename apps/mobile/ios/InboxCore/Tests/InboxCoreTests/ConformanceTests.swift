import Foundation
import XCTest
@testable import InboxCore
import InboxWire

/// The conformance runner: the same inputs as the window, the same outcomes (apps/mobile/contract/vectors).
final class ConformanceTests: XCTestCase {
  // proves: answer-03, answer-04, answer-05, answer-06
  func testQuestionsSuiteBuildsTheWindowsAnswersAndPickBodies() throws {
    let vectors = try Contract.json("vectors/questions.json")
    let questions = try Contract.json("fixtures/questions.json").at("questions").decoded([InboxQuestion].self)
    let cases = try vectors.at("cases").items
    XCTAssertFalse(cases.isEmpty)
    for item in cases {
      let act = try item.at("act")
      let question = try XCTUnwrap(questions.first { $0.key == act["question"]?.text })
      let note = act["note"]?.text ?? ""
      let answer: QuestionAnswer?
      switch act["act"]?.text {
      case "choice": answer = QuestionAnswers.choice(question, selected: try act.at("selected").strings, note: note)
      case "other": answer = QuestionAnswers.other(question, other: try act.at("other").str(), note: note)
      case "text": answer = QuestionAnswers.text(question, text: try act.at("text").str(), note: note)
      case "skip": answer = QuestionAnswers.skip(question, note: note)
      case "clear": answer = nil
      default: XCTFail("an act this runner does not know: \(act)"); continue
      }
      XCTAssertEqual(try answer.map { try JSONValue.of($0) } ?? .null, item["answer"], "answer for \(act)")
      let body = QuestionAnswers.pickBody(
        key: question.key, revision: question.revision, answer: answer, unsentOnly: act["unsentOnly"]?.flag ?? false, confirmFull: act["confirmFull"]?.flag ?? false, idempotencyKey: "k")
      XCTAssertEqual(try JSONValue.of(body).without("idempotency_key"), item["body"], "pick body for \(act)")
    }
  }

  // proves: pair-08
  func testSkewSuiteReadsEveryHealthAnswerAsTheProductDoes() throws {
    let vectors = try Contract.json("vectors/skew.json")
    var clients: [String: DoorClientFacts] = [:]
    if case .object(let named)? = vectors["clients"] {
      for (name, facts) in named {
        clients[name] = DoorClientFacts(
          contract: try facts.at("contract").int(), minInboxContract: try facts.at("min_inbox_contract").int(), routesBeforeDoor: try facts.at("routes_before_door").strings,
          notByRelayBeforeDoor: facts["not_by_relay_before_door"]?.strings ?? [])
      }
    }
    let cases = try vectors.at("health").items
    XCTAssertFalse(cases.isEmpty)
    for item in cases {
      let note = item["note"]?.text ?? ""
      // A case may give the answer as text, to keep a number JSON's own tools would round.
      let health = try item["health_text"]?.text.map { try JSONDecoder().decode(JSONValue.self, from: Data($0.utf8)) } ?? XCTUnwrap(item["health"])
      let skew = DoorSkew.read(health: health, client: try XCTUnwrap(clients[try item.at("client").str()]))
      let expected = try item.at("skew")
      switch skew {
      case .ok(let contract, let routes, let notByRelay, let grants):
        XCTAssertEqual(expected["state"]?.text, "ok", note)
        XCTAssertEqual(contract, expected["contract"]?.whole, note)
        XCTAssertEqual(routes, expected["routes"]?.strings, note)
        XCTAssertEqual(notByRelay, expected["not_by_relay"]?.strings, note)
        XCTAssertEqual(grants, expected["grants"]?.strings, note)
      case .inboxNeedsUpdate(let contract, let floor):
        XCTAssertEqual(expected["state"]?.text, "inbox_needs_update", note)
        XCTAssertEqual(contract, expected["contract"]?.whole, note)
        XCTAssertEqual(floor, expected["min_inbox_contract"]?.whole, note)
      case .appNeedsUpdate(let contract, let floor):
        XCTAssertEqual(expected["state"]?.text, "app_needs_update", note)
        XCTAssertEqual(contract, expected["contract"]?.whole, note)
        XCTAssertEqual(floor, expected["min_app_contract"]?.whole, note)
      }
      for offer in item["offers"]?.items ?? [] {
        let route = try offer.at("route").str()
        XCTAssertEqual(skew.offers(route, path: .direct), offer["direct"]?.flag, "\(note): \(route) direct")
        XCTAssertEqual(skew.offers(route, path: .relay), offer["relay"]?.flag, "\(note): \(route) by relay")
      }
    }
    let headers = try vectors.at("headers").items
    XCTAssertFalse(headers.isEmpty)
    for item in headers {
      let parsed = AppIdentity.parse(item["header"]?.text)
      if case .null? = item["app"] {
        XCTAssertNil(parsed, "\(String(describing: item["header"])) is not in the form")
      } else {
        XCTAssertEqual(parsed?.platform, item["app"]?["platform"]?.text)
        XCTAssertEqual(parsed?.version, item["app"]?["app_version"]?.text)
        XCTAssertEqual(parsed?.contract, item["app"]?["contract"]?.whole)
        XCTAssertEqual(parsed?.headerValue, item["formatted"]?.text)
      }
    }
  }

  func testTimeSuiteWordsTimesAsTheWindowDoes() throws {
    let vectors = try Contract.json("vectors/time.json")
    let now = try XCTUnwrap(TimeWords.date(try vectors.at("now").str()))
    let zones = try vectors.at("zones").items
    XCTAssertFalse(zones.isEmpty)
    for zone in zones {
      let name = try zone.at("time_zone").str()
      let words = TimeWords(locale: Locale(identifier: "en_US"), timeZone: try XCTUnwrap(TimeZone(identifier: name), name))
      let cases = try zone.at("cases").items
      XCTAssertFalse(cases.isEmpty, name)
      for item in cases {
        let iso = try item.at("iso").str()
        XCTAssertEqual(TimeWords.normalise(words.short(iso, now: now)), item["shortTime"]?.text, "shortTime \(iso) in \(name)")
        XCTAssertEqual(TimeWords.normalise(words.when(iso, now: now)), item["whenTime"]?.text, "whenTime \(iso) in \(name)")
      }
    }
  }

  func testStreamSuiteReadsTheSameFramesHoweverTheBytesAreCut() throws {
    let vectors = try Contract.json("vectors/stream.json")
    let bytes = Data(try vectors.at("text").str().utf8)
    let expected = try vectors.at("frames").items
    // The window drops a frame whose name it does not know; the app's reader hands every frame on and the session
    // acts on the names it knows.
    let known = Set(expected.compactMap { $0["name"]?.text })
    func frames(cuts: [Int]) -> [EventFrame] {
      var reader = EventStreamReader()
      var out: [EventFrame] = []
      var start = 0
      for cut in cuts + [bytes.count] where cut > start && cut <= bytes.count {
        out += reader.feed(bytes.subdata(in: start..<cut))
        start = cut
      }
      return out.filter { known.contains($0.event) }
    }
    for cuts in [[], try vectors.at("cuts").items.compactMap(\.whole), Array(1..<bytes.count)] {
      let read = frames(cuts: cuts)
      XCTAssertEqual(read.map(\.event), try expected.map { try $0.at("name").str() })
      XCTAssertEqual(read.map(\.data), try expected.map { try $0.at("data").str() })
      XCTAssertEqual(read.map(\.id), expected.map { $0["id"]?.text })
    }
  }

  func testWordsSuiteCountsAsTheWindowDoes() throws {
    let vectors = try Contract.json("vectors/words.json")
    guard let counts = vectors["counts"]?.items, !counts.isEmpty else { throw XCTSkip("vectors/words.json holds no counting words in this checkout") }
    for item in counts {
      let n = try XCTUnwrap(item["n"]?.whole)
      XCTAssertEqual(CountWords.count(n), item["formatCount"]?.text)
      XCTAssertEqual(CountWords.questions(n), item["questionCount"]?.text)
      XCTAssertEqual(CountWords.waiting(open: n), item["waitCount"]?.text)
      XCTAssertEqual(CountWords.waiting(open: n, actions: 1), item["waitCountWithOneAction"]?.text)
    }
    // The generated templates, filled as the window fills them.
    for item in vectors["filled"]?.items ?? [] {
      let name = item["parts"]?["name"]?.text ?? ""
      switch item["key"]?.text {
      case "delivery.sent_queued": XCTAssertEqual(Words.deliverySentQueued(name: name), item["text"]?.text)
      case "delivery.sent_saved": XCTAssertEqual(Words.deliverySentSaved(name: name), item["text"]?.text)
      default: break
      }
    }
  }
}
