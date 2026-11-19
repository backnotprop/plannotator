import Foundation
import XCTest
@testable import InboxCore
import InboxStandIn
import InboxWire

final class PairLinkTests: XCTestCase {
  // proves: pair-02
  func testReadsEveryPartOfTheLinkTheComputerShows() throws {
    let fp = String(repeating: "ab", count: 32)
    let link = try PairLink("plannotator://pair?v=1&name=Work%20Mac&tailnet=work-mac.example.ts.net%3A8443&lan=192.168.1.20%3A51820&fp=\(fp)&secret=abcDEF_-123&code=004219")
    XCTAssertEqual(link.name, "Work Mac")
    XCTAssertEqual(link.secret, "abcDEF_-123")
    XCTAssertEqual(link.code, "004219")
    // The Wi-Fi first, then the tailnet: the order the contract gives for redeeming a secret.
    XCTAssertEqual(link.addresses, [.wifi(hostPort: "192.168.1.20:51820", fingerprint: fp), .tailnet(hostPort: "work-mac.example.ts.net:8443")])
  }

  func testAWifiAddressWithNoFingerprintIsNeverUsed() throws {
    let link = try PairLink("plannotator://pair?v=1&name=M&tailnet=m.example.ts.net%3A8443&lan=192.168.1.20%3A51820&secret=s&code=1")
    XCTAssertEqual(link.addresses, [.tailnet(hostPort: "m.example.ts.net:8443")])
    XCTAssertThrowsError(try PairLink("plannotator://pair?v=1&name=M&lan=192.168.1.20%3A51820&fp=nothex&secret=s")) { XCTAssertEqual($0 as? PairLink.Failure, .noAddress) }
  }

  func testALinkFromANewerInboxSaysSoAndOtherTextIsNotALink() {
    XCTAssertThrowsError(try PairLink("plannotator://pair?v=2&name=M&tailnet=a%3A1&secret=s")) { XCTAssertEqual($0 as? PairLink.Failure, .newerVersion) }
    for text in ["https://example.com/pair?v=1&secret=s", "plannotator://open?v=1&secret=s", "plannotator://pair?v=1&tailnet=a%3A1", "hello"] {
      XCTAssertThrowsError(try PairLink(text)) { XCTAssertEqual($0 as? PairLink.Failure, .notAPairLink) }
    }
  }
}

final class SkewTests: XCTestCase {
  private func health(_ door: String?) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: Data("{\"ok\":true\(door.map { ",\"door\":\($0)" } ?? "")}".utf8))
  }
  private let client = DoorClientFacts(contract: 1, minInboxContract: 0, routesBeforeDoor: ["GET threads"])

  func testOffersOnlyWhatTheDoorLists() throws {
    let skew = DoorSkew.read(health: try health(#"{"contract":1,"routes":["GET threads","GET events"],"not_by_relay":["GET events"],"grants":[],"min_app_contract":1}"#), client: client)
    XCTAssertTrue(skew.offers("GET threads"))
    XCTAssertFalse(skew.offers("POST messages/:id/reply"))
    XCTAssertTrue(skew.offers("GET events", path: .direct))
    XCTAssertFalse(skew.offers("GET events", path: .relay))
  }

  func testAnInboxFromBeforeTheHandshakeOffersTheRoutesItHadThen() throws {
    XCTAssertEqual(DoorSkew.read(health: try health(nil), client: client), .ok(contract: 0, routes: ["GET threads"], notByRelay: [], grants: []))
  }

  func testTheInboxsFloorRefusesAnOlderApp() throws {
    let skew = DoorSkew.read(health: try health(#"{"contract":3,"routes":["GET threads"],"min_app_contract":2}"#), client: client)
    XCTAssertEqual(skew, .appNeedsUpdate(contract: 3, minAppContract: 2))
    XCTAssertFalse(skew.offers("GET threads"))
  }

  func testANumberThatIsNotASafeWholeNumberMakesTheDoorUnreadable() throws {
    for contract in ["\"1\"", "-1", "1.5", "9007199254740993"] {
      let skew = DoorSkew.read(health: try health("{\"contract\":\(contract),\"routes\":[\"GET search\"],\"min_app_contract\":1}"), client: client)
      XCTAssertEqual(skew, .ok(contract: 0, routes: ["GET threads"], notByRelay: [], grants: []), contract)
    }
  }

  func testTheAppNamesItselfInTheDoorsForm() {
    XCTAssertEqual(AppIdentity(version: "1.4.0", contract: 14).headerValue, "ios 1.4.0 contract 14")
    XCTAssertEqual(AppIdentity.parse("ios 1.4.0 contract 14"), AppIdentity(version: "1.4.0", contract: 14))
    XCTAssertNil(AppIdentity.parse("ios 1.4.0"))
    XCTAssertNil(AppIdentity.parse("ios 1.4.0 contract 01"))
  }
}

final class QuestionAnswerTests: XCTestCase {
  private func question(_ kind: InboxQuestionKind, answer: QuestionAnswer? = nil, revision: Int64 = 0) -> InboxQuestion {
    InboxQuestion(key: "q", position: 0, kind: kind, prompt: "Ship it?", choices: [], holdsUp: [], orphaned: false, state: .openValue, answer: answer, revision: revision, sentRevision: 0, messageId: MessageID("m"))
  }

  func testATapMakesAChoiceAndTrimsItsNote() throws {
    let answer = QuestionAnswers.choice(question(.single), selected: ["Yes"], note: "  after lunch ")
    XCTAssertEqual(try JSONValue.of(answer), try JSONValue.of(QuestionAnswer(v: 1, key: "q", kind: .single, prompt: "Ship it?", selected: ["Yes"], note: "after lunch")))
  }

  func testOtherWordsReplaceThePicksAndAChoiceReplacesOtherWords() {
    let other = QuestionAnswers.other(question(.multi), other: " Only staging ", note: "")
    XCTAssertEqual(other.selected, [])
    XCTAssertEqual(other.other, "Only staging")
    XCTAssertEqual(other.kind, .multi)
    let back = QuestionAnswers.choice(question(.multi, answer: other), selected: ["A", "B"], note: "")
    XCTAssertNil(back.other)
    XCTAssertEqual(back.selected, ["A", "B"])
  }

  func testSkipIsAnAnswerOfItsOwnAndAPickClearsIt() {
    let skipped = QuestionAnswers.skip(question(.single), note: "")
    XCTAssertEqual(skipped.skipped, true)
    XCTAssertNil(QuestionAnswers.choice(question(.single, answer: skipped), selected: ["Yes"], note: "").skipped)
  }

  func testAPickNamesTheRevisionItReadAndTakingItBackWritesNull() throws {
    let q = question(.single, revision: 2)
    let body = QuestionAnswers.pickBody(key: q.key, revision: q.revision, answer: nil, unsentOnly: true, idempotencyKey: "key-1")
    let json = try JSONValue.of(body)
    XCTAssertEqual(json["idempotency_key"], .string("key-1"))
    XCTAssertEqual(json["unsent_only"], .bool(true))
    XCTAssertNil(json["confirm_full"])
    XCTAssertEqual(json["questions"]?.items.first?["revision"], .number(2))
    XCTAssertEqual(json["questions"]?.items.first?["answer"], .null, "a taken-back pick must be written as null, not left out")
  }
}

final class SendPlanTests: XCTestCase {
  private func message(_ id: String, _ author: InboxAuthor, picked: [String] = []) -> InboxMessageWire {
    let questions = picked.map {
      InboxQuestion(key: $0, position: 0, kind: .single, prompt: $0, choices: [], holdsUp: [], orphaned: false, state: .picked, revision: 1, sentRevision: 0, messageId: MessageID(id))
    }
    return InboxMessageWire(questions: questions.isEmpty ? nil : questions, id: MessageID(id), projectId: ProjectID("p"), threadId: ThreadID("t"), author: author, body: "", createdAt: "")
  }
  private func thread(_ messages: [InboxMessageWire]) -> InboxThread {
    InboxThread(threadId: ThreadID("t"), project: InboxThreadProject(id: "p", key: "p", name: "p", root: "/", createdAt: ""), messages: messages)
  }
  private let a = InboxAuthor(kind: .agent, host: "claude-code", session: "A")
  private let b = InboxAuthor(kind: .agent, host: "codex", session: "B")

  // proves: answer-08
  func testOneReplyPerAgentSessionWithTheWordsGoingToTheLatestWriter() {
    let targets = SendPlan.targets(in: thread([message("m1", a, picked: ["q1"]), message("m2", b, picked: ["q2"]), message("m3", a, picked: ["q3"])]))
    XCTAssertEqual(targets.map(\.message.rawValue), ["m2", "m3"], "session A wrote last, so its reply is last and carries the words")
    // A pick on another message of the same session names that message; one on the reply's own message names none.
    XCTAssertEqual(targets[1].questions.map { "\($0.messageId?.rawValue ?? "-")/\($0.key)" }, ["m1/q1", "-/q3"])
  }

  func testWordsAloneAnswerTheLatestAgentMessage() {
    let targets = SendPlan.targets(in: thread([message("m1", a, picked: ["q1"]), message("m2", b)]))
    XCTAssertEqual(targets.map(\.message.rawValue), ["m1", "m2"])
    XCTAssertEqual(targets[1].questions, [])
    XCTAssertFalse(SendPlan.hasSomethingToSend(thread: thread([message("m1", a)]), words: "  "))
    XCTAssertTrue(SendPlan.hasSomethingToSend(thread: thread([message("m1", a)]), words: "ok"))
  }

  func testTheWordsGoPastAPermissionPromptAndARoutinesChangeLine() {
    var prompt = message("m2", InboxAuthor(kind: .agent, host: "claude-code", session: "perm:A"), picked: ["allow"])
    prompt.body = "Allow Bash?"
    var change = message("m3", b)
    change.scheduledChange = InboxScheduledChange(scheduledId: "r", name: "nightly", op: .unknown("edit"))
    let targets = SendPlan.targets(in: thread([message("m1", a), prompt, change]))
    // The prompt's own answer rides a reply to the prompt; the words go to the agent itself, last.
    XCTAssertEqual(targets.map(\.message.rawValue), ["m2", "m1"])
    XCTAssertEqual(targets[0].questions.map(\.key), ["allow"])
  }

  func testAScriptsPostDoesNotTakeTheWordsFromTheSessionThatWrote() {
    let script = InboxAuthor(kind: .agent)
    // The words go past the script's post to the latest message with a session.
    XCTAssertEqual(SendPlan.targets(in: thread([message("m1", a), message("m2", script)])).map(\.message.rawValue), ["m1"])
    // Answering the script's own question: the reply, words too, is the script's.
    XCTAssertEqual(SendPlan.targets(in: thread([message("m1", a), message("m2", script, picked: ["q"])])).map(\.message.rawValue), ["m2"])
    // No session wrote: the script's post, as before.
    XCTAssertEqual(SendPlan.targets(in: thread([message("m1", script), message("m2", script)])).map(\.message.rawValue), ["m2"])
    // An agent's shell the CLI names (Gemini CLI: a name, no session, no host) is not a script.
    XCTAssertEqual(SendPlan.targets(in: thread([message("m1", a), message("m2", InboxAuthor(kind: .agent, name: "Gemini CLI"))])).map(\.message.rawValue), ["m2"])
    // A sender with a session id but no host is not a script.
    XCTAssertEqual(SendPlan.targets(in: thread([message("m1", a), message("m2", InboxAuthor(kind: .agent, session: "ses_x"))])).map(\.message.rawValue), ["m2"])
  }

  func testOnlyAHandOffThatStillStandsIsAnsweredOnTheComputer() {
    var handed = message("m2", InboxAuthor(kind: .person))
    handed.handoff = InboxHandoff(at: "2026-11-18T10:00:00.000Z")
    handed.to = InboxAddressee(host: "codex", session: "B")
    XCTAssertTrue(SendPlan.needsComputer(thread([message("m1", a), handed])))
    XCTAssertFalse(SendPlan.needsComputer(thread([message("m1", a)])))
    // Undone: the phone sends as usual.
    var undone = handed
    undone.handoff?.undoneAt = "2026-11-18T10:01:00.000Z"
    XCTAssertFalse(SendPlan.needsComputer(thread([message("m1", a), undone])))
    // A reply that took over holds the thread only until an agent writes again.
    var took = message("m3", InboxAuthor(kind: .person))
    took.tookOver = true
    took.to = InboxAddressee(host: "codex", session: "B")
    XCTAssertTrue(SendPlan.needsComputer(thread([message("m1", a), handed, took])))
    XCTAssertFalse(SendPlan.needsComputer(thread([message("m1", a), handed, took, message("m4", b)])))
  }
}

final class CardAnswerTests: XCTestCase {
  private func question(_ kind: InboxQuestionKind, answer: QuestionAnswer? = nil) -> InboxQuestion {
    let choices = ["A", "B", "C"].map { InboxQuestionChoice(label: $0, recommended: false, settled: false) }
    return InboxQuestion(key: "q", position: 0, kind: kind, prompt: "Which?", choices: choices, holdsUp: [], orphaned: false, state: .openValue, answer: answer, revision: 0, sentRevision: 0, messageId: MessageID("m"))
  }
  private func saved(_ edit: CardAnswers.Edit, file: StaticString = #filePath, line: UInt = #line) -> QuestionAnswer? {
    guard case .save(let answer) = edit else { XCTFail("expected a save", file: file, line: line); return nil }
    return answer
  }

  // proves: answer-05
  func testOnAPickAnyQuestionTicksAndOtherWordsStayTogether() {
    let typed = saved(CardAnswers.other(question(.multi), words: "A wizard"))
    XCTAssertEqual(typed?.other, "A wizard")
    let ticked = saved(CardAnswers.tap(question(.multi, answer: typed), label: "C"))
    XCTAssertEqual(ticked?.other, "A wizard", "ticking does not erase the Other words")
    let both = saved(CardAnswers.tap(question(.multi, answer: ticked), label: "A"))
    XCTAssertEqual(both?.selected, ["A", "C"], "in the agent's order, not the tap order")
    let retyped = saved(CardAnswers.other(question(.multi, answer: both), words: "A wizard, two steps"))
    XCTAssertEqual(retyped?.selected, ["A", "C"], "typing Other does not erase the ticks")
    let unticked = saved(CardAnswers.tap(question(.multi, answer: retyped), label: "A"))
    XCTAssertEqual(unticked?.selected, ["C"])
  }

  // proves: answer-04
  func testOnAPickOneQuestionATapMovesThePickAndATapOnThePickedRowDoesNothing() {
    let first = saved(CardAnswers.tap(question(.single), label: "A"))
    XCTAssertEqual(first?.selected, ["A"])
    XCTAssertEqual(CardAnswers.tap(question(.single, answer: first), label: "A"), .nothing)
    XCTAssertEqual(saved(CardAnswers.tap(question(.single, answer: first), label: "B"))?.selected, ["B"])
    // Other words give up the pick, and a pick gives up the Other words.
    let other = saved(CardAnswers.other(question(.single, answer: first), words: "Neither"))
    XCTAssertEqual(other?.selected, [])
    XCTAssertNil(saved(CardAnswers.tap(question(.single, answer: other), label: "B"))?.other)
  }

  // proves: answer-11
  func testSkipKeepsTheNoteAndUnskipRemovesOnlyTheSkip() {
    let noted = saved(CardAnswers.note(question(.single), words: "ask Dana first"))
    XCTAssertEqual(noted?.note, "ask Dana first", "a note stands on its own")
    let skipped = saved(CardAnswers.toggleSkip(question(.single, answer: noted)))
    XCTAssertEqual(skipped?.skipped, true)
    XCTAssertEqual(skipped?.note, "ask Dana first")
    let back = saved(CardAnswers.toggleSkip(question(.single, answer: skipped)))
    XCTAssertNil(back?.skipped)
    XCTAssertEqual(back?.note, "ask Dana first")
    // With no note, Unskip leaves nothing worth keeping: the answer is taken back.
    let bare = saved(CardAnswers.toggleSkip(question(.single)))
    XCTAssertEqual(CardAnswers.toggleSkip(question(.single, answer: bare)), .save(nil))
  }

  func testATapOnAChoiceTheAgentMarkedSettledDoesNothingOnAPickOneQuestion() {
    var q = question(.single)
    q.choices[1].settled = true
    XCTAssertEqual(CardAnswers.selected(q), ["B"])
    XCTAssertEqual(CardAnswers.tap(q, label: "B"), .nothing)
    XCTAssertEqual(saved(CardAnswers.tap(q, label: "A"))?.selected, ["A"])
    XCTAssertFalse(CardAnswers.offersAccept(q))
  }

  func testTheAgentsOwnSuggestionIsARowStoredAsTheOtherAnswer() {
    var single = question(.single)
    single.suggestedText = "Neither: wait a week"
    let picked = saved(CardAnswers.tapSuggestion(single))
    XCTAssertEqual(picked?.other, "Neither: wait a week")
    XCTAssertEqual(picked?.selected, [])
    single.answer = picked
    XCTAssertTrue(CardAnswers.suggestionPicked(single))
    XCTAssertEqual(CardAnswers.tapSuggestion(single), .nothing)
    // Pick any: it toggles beside the ticks, and unticking puts back the words it replaced.
    var multi = question(.multi, answer: saved(CardAnswers.other(question(.multi, answer: saved(CardAnswers.tap(question(.multi), label: "A"))), words: "mine")))
    multi.suggestedText = "All three, later"
    let on = saved(CardAnswers.tapSuggestion(multi))
    XCTAssertEqual(on?.selected, ["A"])
    XCTAssertEqual(on?.other, "All three, later")
    multi.answer = on
    XCTAssertEqual(saved(CardAnswers.tapSuggestion(multi, replaced: "mine"))?.other, "mine")
    var text = question(.text)
    text.suggestedText = "Pay now"
    XCTAssertNil(CardAnswers.suggestion(of: text), "a free-text question has no row: Accept recommended fills the field")
  }

  func testAcceptRecommendedTicksTheRecommendedChoicesAndIsOfferedUntilTheyAreTicked() {
    var q = question(.multi)
    q.choices[0].recommended = true
    q.choices[2].recommended = true
    XCTAssertTrue(CardAnswers.offersAccept(q))
    q.answer = saved(CardAnswers.other(question(.multi, answer: saved(CardAnswers.tap(q, label: "A"))), words: "and mine"))
    XCTAssertTrue(CardAnswers.offersAccept(q), "one tick must not take away the one tap that ticks the rest")
    let accepted = saved(CardAnswers.acceptRecommended(q))
    XCTAssertEqual(accepted?.selected, ["A", "C"])
    XCTAssertEqual(accepted?.other, "and mine")
    q.answer = accepted
    XCTAssertFalse(CardAnswers.offersAccept(q))
    var text = question(.text)
    text.suggestedText = "Pay now"
    XCTAssertEqual(saved(CardAnswers.acceptRecommended(text))?.text, "Pay now")
    XCTAssertFalse(CardAnswers.offersAccept(question(.single)), "nothing recommended, nothing to accept")
    var one = question(.single)
    one.choices[0].recommended = true
    one.answer = saved(CardAnswers.tap(one, label: "B"))
    XCTAssertFalse(CardAnswers.offersAccept(one), "a pick-one question answered any way offers it no more")
  }

  func testTypingTheSameWordsAgainWritesNothing() {
    let text = saved(CardAnswers.text(question(.text), words: "Pay now"))
    XCTAssertEqual(CardAnswers.text(question(.text, answer: text), words: "Pay now"), .nothing)
    XCTAssertEqual(CardAnswers.text(question(.text, answer: text), words: ""), .save(nil))
    XCTAssertEqual(CardAnswers.other(question(.single), words: ""), .nothing)
  }
}

final class StreamAndTimeTests: XCTestCase {
  func testFramesSurviveAnyCutAndCommentsAreSkipped() {
    let text = ": ping\n\nevent: hello\ndata: {\"cursor\":4}\n\nid: 9\r\nevent: record\r\ndata: a\r\ndata: b\r\n\r\n"
    let bytes = Data(text.utf8)
    for size in [1, 2, 3, 7, bytes.count] {
      var reader = EventStreamReader()
      var frames: [EventFrame] = []
      var start = 0
      while start < bytes.count {
        let end = min(start + size, bytes.count)
        frames += reader.feed(bytes.subdata(in: start..<end))
        start = end
      }
      XCTAssertEqual(frames, [EventFrame(event: "hello", data: "{\"cursor\":4}", id: nil), EventFrame(event: "record", data: "a\nb", id: "9")], "cut every \(size)")
      XCTAssertEqual(reader.lastEventID, "9")
    }
  }

  func testTimesReadAsTheWindowsDo() throws {
    let words = TimeWords(locale: Locale(identifier: "en_US"), timeZone: TimeZone(identifier: "UTC")!)
    let now = try XCTUnwrap(TimeWords.date("2026-11-18T15:30:00.000Z"))
    XCTAssertEqual(TimeWords.normalise(words.short("2026-11-18T00:05:00.000Z", now: now)), "12:05 AM")
    XCTAssertEqual(TimeWords.normalise(words.short("2026-11-17T23:55:00.000Z", now: now)), "Nov 17")
    XCTAssertEqual(TimeWords.normalise(words.short("2025-09-02T20:22:00.000Z", now: now)), "Sep 2, 2025")
    XCTAssertEqual(TimeWords.normalise(words.when("2026-11-17T08:00:00.000Z", now: now)), "Nov 17, 8:00 AM")
    XCTAssertEqual(words.short("not a time", now: now), "")
  }

  func testCountsReadAsTheWindowsDo() {
    XCTAssertEqual(CountWords.waiting(open: 1), "")
    XCTAssertEqual(CountWords.waiting(open: 2), "2 questions")
    XCTAssertEqual(CountWords.waiting(open: 3, actions: 2), "1 question, 2 action items")
    XCTAssertEqual(CountWords.waiting(open: 1, actions: 1), "1 action item")
  }

  func testACertificatesFingerprintIsTheSha256OfItsBytesInLowercaseHex() {
    XCTAssertEqual(CertificatePin.fingerprint(ofDER: Data("abc".utf8)), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  }
}
