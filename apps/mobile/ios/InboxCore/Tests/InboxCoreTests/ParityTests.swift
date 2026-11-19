import Foundation
import XCTest
@testable import InboxCore
import InboxStandIn
import InboxWire

/// The window's rules the phone follows for a clash of answers, an action item and a permission prompt.
@MainActor
final class ParityTests: XCTestCase {
  private func conflict(_ revision: Double?) -> DoorFailure {
    .refused(status: 409, error: DoorError(error: "Question q-1 changed since you read it.", code: "question_revision_conflict", unknownFields: revision.map { ["current_revision": .number($0)] } ?? [:]))
  }

  private func retry(_ session: InboxSession) throws -> (InboxMessageWire, InboxQuestion) {
    let asked = try XCTUnwrap(session.thread(StandInData.retry)?.thread.messages.last { $0.author.kind == .agent })
    return (asked, try XCTUnwrap(asked.questions?.first))
  }

  // MARK: A clash of answers (packages/inbox/pickConflict.ts and its tests)

  func testTheRuleBuiltIsTheWindowsTheLaterClickWins() {
    XCTAssertEqual(PickConflict.rule, .laterClickWins)
    XCTAssertEqual(PickConflict.retries, 2)
  }

  func testLaterClickWinsTheRefusedAnswerGoesAgainAtTheInboxsRevisionThenGivesWay() {
    XCTAssertEqual(PickConflict.step(conflict(4), tries: 0, rule: .laterClickWins), .retry(revision: 4))
    XCTAssertEqual(PickConflict.step(conflict(5), tries: PickConflict.retries - 1, rule: .laterClickWins), .retry(revision: 5))
    XCTAssertEqual(PickConflict.step(conflict(6), tries: PickConflict.retries, rule: .laterClickWins), .adopt)
    XCTAssertEqual(PickConflict.step(conflict(4), tries: 0, rule: .firstSaveWins), .adopt)
  }

  func testAnyOtherRefusalOrAConflictThatNamesNoRevisionIsNotAClash() {
    XCTAssertNil(PickConflict.step(.refused(status: 500, error: DoorError(error: "The disk is full.", code: "error")), tries: 0))
    XCTAssertNil(PickConflict.step(.refused(status: 409, error: DoorError(error: "Already sent.", code: "question_already_sent")), tries: 0))
    XCTAssertNil(PickConflict.step(conflict(nil), tries: 0))
    XCTAssertNil(PickConflict.step(.unreachable("offline"), tries: 0))
  }

  func testAnAnswerAnotherPlaceBeatIsSavedAgainOverItQuietly() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    let (asked, question) = try retry(session)
    // Another place answers a moment before the phone's pick arrives.
    await door.setOptions { $0.racesPicks = 1 }
    await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))

    XCTAssertNil(session.refusal(message: asked.id, key: question.key), "a clash says nothing")
    XCTAssertTrue(session.held.isEmpty)
    let stored = await door.thread(StandInData.retry)?.messages.last?.questions?.first
    XCTAssertEqual(stored?.answer?.selected, ["Staged, 10% first"], "the later click stands")
    XCTAssertEqual(try retry(session).1.answer?.selected, ["Staged, 10% first"])
    let picks = await door.posts("/picks").map(body)
    XCTAssertEqual(picks.map { $0["questions"]?.items.first?["revision"]?.whole }, [0, 1], "the second save names the revision the Inbox held")
    guard picks.count == 2 else { return }
    XCTAssertNotEqual(picks[0]["idempotency_key"]?.text, picks[1]["idempotency_key"]?.text, "a refused key is spent: the second save is a new write")
  }

  func testAQuestionThatKeepsChangingEndsOnTheInboxsAnswerNeverOnARefusal() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    let (asked, question) = try retry(session)
    await door.setOptions { $0.racesPicks = 5 }
    await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))

    let posts = await door.posts("/picks").count
    XCTAssertEqual(posts, 1 + PickConflict.retries, "saved again twice, then no more")
    XCTAssertNil(session.refusal(message: asked.id, key: question.key))
    XCTAssertTrue(session.held.isEmpty)
    XCTAssertEqual(try retry(session).1.answer?.selected, ["Everyone at once"], "the Inbox's answer is drawn")
  }

  func testAPickThatWaitedOnThePhoneNeverGoesOverANewerAnswerMadeElsewhere() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    let (asked, question) = try retry(session)
    // 9:00, the computer away: the person picks on the phone, twice, and writes a reply.
    await door.setOffline(true)
    await session.refresh()
    await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))
    let drawn = try retry(session).1
    await session.pick(thread: StandInData.retry, message: asked.id, question: drawn, answer: QuestionAnswers.choice(drawn, selected: ["Staged, 10% first"], note: "second thoughts"))
    await session.send(thread: StandInData.retry, words: "Go ahead")
    XCTAssertEqual(session.held.filter { $0.waited == true }.count, 3)
    // 11:00: they pick something else on the laptop. 11:30: the phone is back.
    await door.setOffline(false)
    await door.setOptions { $0.racesPicks = 1 }
    await session.refresh()

    let posts = await door.posts("/picks").count
    XCTAssertEqual(posts, 2, "neither old pick is saved again")
    let stored = await door.thread(StandInData.retry)
    XCTAssertEqual(stored?.messages.last?.questions?.first?.answer?.selected, ["Everyone at once"], "the newer answer, made elsewhere, stands")
    XCTAssertEqual(stored?.messages.last?.author.kind, .agent, "and the reply written behind the old pick did not go on its own")
    XCTAssertEqual(session.refusal(message: asked.id, key: question.key), .gaveWay, "the card says so, in one line")
    XCTAssertEqual(try retry(session).1.answer?.selected, ["Everyone at once"])
    XCTAssertTrue(session.held.isEmpty)
    XCTAssertEqual(session.takeReturnedWords(StandInData.retry), "Go ahead", "the words are back in the reply field")
  }

  func testAPickTheAgentReplacedSaysSoAndASendBehindItStopsUntilThePersonChooses() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    let (asked, question) = try retry(session)
    // The pick and the Send are both still on the phone when the agent replaces the question.
    await door.holdPickAnswers()
    session.hold(pick: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""), thread: StandInData.retry, message: asked.id, question: question)
    async let sending = session.send(thread: StandInData.retry, words: "Go ahead")
    await door.change(StandInData.retry) { thread in
      let last = thread.messages.count - 1
      thread.messages[last].questions?[0].state = .superseded
    }
    await door.release()
    _ = await sending

    guard case .refused(_, code: "question_superseded")? = session.refusal(message: asked.id, key: question.key) else { return XCTFail("the card says the pick was not saved") }
    XCTAssertEqual(session.stale[StandInData.retry], [InboxSession.Stale(message: asked.id, key: question.key)])
    let none = await door.posts("/reply").isEmpty
    XCTAssertTrue(none, "the reply did not go without its answer")
    XCTAssertEqual(session.takeReturnedWords(StandInData.retry), "Go ahead")
    XCTAssertEqual(try retry(session).1.state, .superseded)

    // Nothing is sent until the person chooses; "send the rest" then goes.
    let stopped = await session.send(thread: StandInData.retry, words: "Go ahead")
    XCTAssertFalse(stopped)
    let went = await session.send(thread: StandInData.retry, words: "Go ahead", pastGuard: true)
    XCTAssertTrue(went)
    XCTAssertNil(session.stale[StandInData.retry])
    let replies = await door.posts("/reply").map(body)
    XCTAssertEqual(replies.map { $0["words"]?.text }, ["Go ahead"])
    XCTAssertNil(replies.first?["questions"]?.items.first)
  }

  func testAPickOnAQuestionAlreadySentSaysItDidNotGo() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    let (asked, question) = try retry(session)
    // The laptop sent the earlier answer while the phone still shows the question open.
    await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Everyone at once"], note: ""))
    let other = DoorClient(transport: StandInTransport(door: door), token: session.computer.token, app: testApp)
    _ = try await other.reply(asked.id, body: DoorReplyBody(idempotencyKey: "laptop-send", words: "", questions: [DoorQuestionPick(key: question.key, revision: 1)]))
    let seen = try retry(session).1
    XCTAssertEqual(seen.state, .picked, "the phone has not read the thread again")
    await session.pick(thread: StandInData.retry, message: asked.id, question: seen, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))
    guard case .refused(_, code: "question_already_sent")? = session.refusal(message: asked.id, key: question.key) else { return XCTFail("the change did not go, and the card says so") }
    XCTAssertEqual(try retry(session).1.state, .sent)
  }

  // MARK: An action item (packages/inbox/components/ActionChecklist.tsx, contract flow thread-09)

  private func onboarding(_ session: InboxSession) throws -> (InboxMessageWire, InboxQuestion) {
    let asked = try XCTUnwrap(session.thread(StandInData.onboarding)?.thread.messages.first)
    return (asked, try XCTUnwrap(ActionMarks.items(of: asked).first))
  }

  func testDoneWaitsInTheDraftAndGoesWithTheNextSend() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.onboarding)
    let (asked, todo) = try onboarding(session)
    XCTAssertEqual(ActionMarks.state(todo), .open)
    XCTAssertFalse(session.canSend(thread: StandInData.onboarding, words: ""))

    await session.mark(action: todo, thread: StandInData.onboarding, message: asked.id, ActionMarks.Mark(.done, note: "  In the vault now. "))
    let marks = await door.posts("/actions/\(todo.key)")
    XCTAssertEqual(marks.map(\.path), ["messages/\(asked.id.rawValue)/actions/\(todo.key)"])
    XCTAssertEqual(body(marks[0])["outcome"]?.text, "done")
    XCTAssertEqual(body(marks[0])["note"]?.text, "In the vault now.")
    XCTAssertEqual(body(marks[0])["staged"]?.flag, true, "into the reply draft, as the window marks it")
    let marked = try onboarding(session).1
    XCTAssertEqual(ActionMarks.state(marked), .pending)
    XCTAssertTrue(ActionMarks.inDraft(marked))
    XCTAssertEqual(ActionMarks.progress([marked]).done, 1)
    let nothingSent = await door.posts("/reply").isEmpty
    XCTAssertTrue(nothingSent, "a mark alone tells the agent nothing")

    XCTAssertTrue(session.canSend(thread: StandInData.onboarding, words: ""))
    await session.send(thread: StandInData.onboarding, words: "")
    let replies = await door.posts("/reply").map(body)
    XCTAssertEqual(replies.count, 1)
    XCTAssertEqual(replies[0]["actions"]?.items.map { $0["key"]?.text }, [todo.key])
    XCTAssertNil(replies[0]["questions"]?.items.first, "an action item is never sent as a question's answer")
    XCTAssertEqual(try onboarding(session).1.state, .sent)
  }

  func testCantDoItNeedsItsReasonAndTheTickTakesAMarkBack() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.onboarding)
    let (asked, todo) = try onboarding(session)
    XCTAssertNil(ActionMarks.checked(ActionMarks.Mark(.cant, note: "  ")), "no reason, no mark")

    await session.mark(action: todo, thread: StandInData.onboarding, message: asked.id, ActionMarks.Mark(.cant, note: "I have no access to the vault."))
    var now = try onboarding(session).1
    XCTAssertEqual(now.actionResult?.outcome, .cant)
    XCTAssertEqual(now.actionResult?.note, "I have no access to the vault.")
    XCTAssertFalse(ActionMarks.isDone(now))

    await session.mark(action: now, thread: StandInData.onboarding, message: asked.id, nil)
    let undoPosts = await door.posts("/actions/\(todo.key)")
    let undo = try XCTUnwrap(undoPosts.last)
    XCTAssertEqual(body(undo)["outcome"], .null, "taking it back is said, not left out")
    now = try onboarding(session).1
    XCTAssertEqual(ActionMarks.state(now), .open)
    XCTAssertFalse(session.canSend(thread: StandInData.onboarding, words: ""))
  }

  func testAMarkMadeWhileTheComputerIsAwayShowsAndGoesOnceItIsBack() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.onboarding)
    let (asked, todo) = try onboarding(session)
    await door.setOffline(true)
    await session.refresh()
    await session.mark(action: todo, thread: StandInData.onboarding, message: asked.id, ActionMarks.Mark(.done))
    XCTAssertTrue(session.isHeldMark(message: asked.id, key: todo.key))
    XCTAssertEqual(ActionMarks.state(try onboarding(session).1), .pending, "drawn as marked while it waits")
    await door.setOffline(false)
    await session.refresh()
    XCTAssertFalse(session.isHeldMark(message: asked.id, key: todo.key))
    let stored = await door.thread(StandInData.onboarding)?.messages.first?.questions?.first { $0.kind == .action }
    XCTAssertEqual(stored?.actionResult?.outcome, .done)
    XCTAssertEqual(stored?.actionResult?.staged, true)
  }

  func testANoteTypedUnderAMarkNeverMarksAgainAnItemTakenBack() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.onboarding)
    let (asked, todo) = try onboarding(session)
    let saved = await session.mark(action: todo, thread: StandInData.onboarding, message: asked.id, ActionMarks.Mark(.done))
    XCTAssertEqual(saved, .saved)
    let marked = try onboarding(session).1
    // Away: a note is typed under the Done. Meanwhile the Done is taken out of the draft on the computer.
    await door.setOffline(true)
    await session.refresh()
    session.hold(mark: ActionMarks.Mark(.done, note: "In the vault."), action: marked, thread: StandInData.onboarding, message: asked.id, quiet: true)
    await door.change(StandInData.onboarding) { thread in
      let at = thread.messages[0].questions!.firstIndex { $0.kind == .action }!
      thread.messages[0].questions![at].actionResult = nil
      thread.messages[0].questions![at].state = .openValue
    }
    await door.setOffline(false)
    await session.refresh()
    let posts = await door.posts("/actions/\(todo.key)")
    let note = try XCTUnwrap(posts.last.map(body))
    XCTAssertEqual(note["note_only"]?.flag, true)
    let stored = await door.thread(StandInData.onboarding)?.messages.first?.questions?.first { $0.kind == .action }
    XCTAssertEqual(stored?.state, .openValue, "the take-back wins")
    XCTAssertNil(session.refusal(message: asked.id, key: todo.key))
  }

  func testARefusedMarkIsToldAsRefusedAndANoteSaveOnAnItemThatMovedOnSaysNothing() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.onboarding)
    let (asked, todo) = try onboarding(session)
    // Sent from another window while the phone still shows it open.
    await door.change(StandInData.onboarding) { thread in
      let at = thread.messages[0].questions!.firstIndex { $0.kind == .action }!
      thread.messages[0].questions![at].state = .sent
    }
    let taken = await session.mark(action: todo, thread: StandInData.onboarding, message: asked.id, ActionMarks.Mark(.cant, note: "No access."))
    XCTAssertEqual(taken, .refused, "the row keeps the reason the person typed")
    guard case .refused(_, code: "action_already_sent")? = session.refusal(message: asked.id, key: todo.key) else { return XCTFail("a pressed mark's refusal is shown") }

    session.hold(mark: ActionMarks.Mark(.done, note: "late note"), action: todo, thread: StandInData.onboarding, message: asked.id, quiet: true)
    await session.deliverHeld(thread: StandInData.onboarding)
    XCTAssertNil(session.refusal(message: asked.id, key: todo.key), "nothing for the person to do about a note that came too late")
    XCTAssertFalse(ActionMarks.mootNoteRefusal(quiet: false, code: "action_closed"))
    XCTAssertFalse(ActionMarks.mootNoteRefusal(quiet: true, code: "validation_error"))
  }

  func testInAnArchivedThreadOnlyWhatCameAfterTheArchiveLineIsLive() throws {
    var thread = try XCTUnwrap(StandInData.threads(now: Date()).first { $0.threadId == StandInData.onboarding })
    var later = thread.messages[0]
    later.seq = 50
    thread.messages[0].seq = 10
    thread.messages.append(later)
    XCTAssertTrue(SendPlan.live(thread.messages[0], in: thread))
    thread.resolvedAt = "2026-11-18T10:00:00.000Z"
    XCTAssertFalse(SendPlan.live(thread.messages[0], in: thread), "archived with no line: read only")
    thread.archiveSeq = 20
    XCTAssertFalse(SendPlan.live(thread.messages[0], in: thread))
    XCTAssertTrue(SendPlan.live(thread.messages[1], in: thread), "an action item an agent wrote after the archive can still be marked")
  }

  func testTheNextOpenItemAndTheCountLeaveReplacedOnesOut() throws {
    let message = MessageID("msg_X")
    func item(_ key: String, _ position: Int64, _ state: InboxQuestionState, result: InboxActionResult? = nil) -> InboxQuestion {
      InboxQuestion(key: key, position: position, kind: .action, prompt: key, choices: [], holdsUp: [], orphaned: false, state: state, revision: 0, sentRevision: 0, messageId: message, actionResult: result)
    }
    let done = InboxActionResult(outcome: .done, at: "2026-11-18T10:00:00.000Z", by: .person, staged: true)
    let seen = InboxActionResult(outcome: .done, at: "2026-11-18T10:00:00.000Z", by: .agent)
    let items = [item("a", 0, .picked, result: done), item("b", 1, .superseded), item("c", 2, .openValue), item("d", 3, .closed, result: seen), item("e", 4, .openValue)]
    XCTAssertEqual(items.map(ActionMarks.state), [.pending, .replaced, .open, .seen, .open])
    let progress = ActionMarks.progress(items)
    XCTAssertEqual([progress.total, progress.done, progress.replaced], [4, 2, 1])
    XCTAssertEqual(ActionMarks.nextOpen(items, after: "c"), "e")
    XCTAssertEqual(ActionMarks.nextOpen(items, after: "e"), "c", "then from the start")
    XCTAssertNil(ActionMarks.nextOpen([items[0], items[2]], after: "c"))
    XCTAssertTrue(ActionMarks.timed(item("t", 0, .picked, result: InboxActionResult(outcome: .done, at: "2026-11-18T10:00:00.000Z", by: .person))), "marked without the draft: it goes on its own")
  }

  // MARK: A permission prompt (packages/core/inbox-permission.ts, packages/inbox/components/PermissionCard.tsx)

  func testThePromptsBodyReadsBackExactlyAsTheProductReadsIt() throws {
    let vectors = try JSONDecoder().decode(JSONValue.self, from: Data(PermissionVectors.json.utf8))
    for name in ["bash", "bashMultiline", "fetch", "edit", "write", "terminalOnly", "mcp"] {
      let vector = try vectors.at(name)
      let want = try vector.at("read")
      let got = PermissionPrompt.read(try vector.at("body").str())
      XCTAssertEqual(got.detail?.text, want["detail"]?["text"]?.text, name)
      XCTAssertEqual(got.detail.map { $0.onLine ? "line" : "block" }, want["detail"]?["on"]?.text, name)
      XCTAssertEqual(got.preview?.kind, want["preview"]?["kind"]?.text, name)
      XCTAssertEqual(got.preview?.text, want["preview"]?["text"]?.text, name)
      XCTAssertEqual(got.leftover, want["leftover"]?.text, name)
      XCTAssertEqual(got.purpose, want["purpose"]?.text, name)
      XCTAssertEqual(got.folder, want["folder"]?.text, name)
      XCTAssertEqual(got.unsandboxed, want["unsandboxed"]?.flag, name)
      XCTAssertEqual(got.linksTo, want["linksTo"]?.text, name)
      XCTAssertEqual(got.note, want["note"]?.text, name)
      XCTAssertEqual(got.handoff, want["handoff"]?.text, name)
    }
    for vector in try vectors.at("spans").items {
      let got = PermissionPrompt.spans(try vector.at("text").str())
      XCTAssertEqual(got.map(\.text), try vector.at("spans").items.map { try $0.at("text").str() })
      XCTAssertEqual(got.map(\.code), try vector.at("spans").items.map { try XCTUnwrap($0["code"]?.flag) })
    }
  }

  func testTheCardsTitleKindAndSessionChoiceComeFromThePromptAndItsChoices() throws {
    XCTAssertEqual(PermissionPrompt.title("Claude Code wants to run a command"), "Run a command")
    XCTAssertEqual(PermissionPrompt.title("Codex wants to use `create_issue` from linear"), "Use `create_issue` from linear")
    XCTAssertEqual(PermissionPrompt.kind("Claude Code wants to open a web page"), .fetch)
    XCTAssertEqual(PermissionPrompt.kind("Claude Code wants to overwrite a file"), .file)
    XCTAssertEqual(PermissionPrompt.kind("Claude Code wants to use `x`"), .other)
    XCTAssertEqual(PermissionPrompt.sessionLabel(["Allow once", "Allow pages on bun.sh for this session", "Deny", "Allow and switch to Auto mode"]), "Allow pages on bun.sh for this session")
    XCTAssertNil(PermissionPrompt.sessionLabel(["Deny", "Approve in Terminal"]))
    let link = PermissionPrompt.link("https://bun.sh/docs/bundler#splitting")
    XCTAssertEqual(link.origin, "https://bun.sh")
    XCTAssertNil(PermissionPrompt.link("https://bun.sh.evil.example@other.example/x").origin, "a host that is not where the text starts is never stressed")
    XCTAssertEqual(PermissionPrompt.read("`~/work/api-server/notes.md`\n\nin `~/work/api-server`\n").what(title: "Create a file"), "notes.md")
  }

  func testTheHostShownIsTheOneABrowserWouldOpen() {
    // A backslash ends the authority as a slash does: what follows it is path, and the host is the first name.
    let spoof = PermissionPrompt.link("https://evil.com\\@bun.sh/")
    XCTAssertNil(spoof.origin, "nothing is stressed")
    XCTAssertEqual(spoof.host, "evil.com", "the real host is named on its own line")
    // What stands before an @ is not the host.
    XCTAssertEqual(PermissionPrompt.link("https://bun.sh@evil.com/x").host, "evil.com")
    XCTAssertNil(PermissionPrompt.link("https://bun.sh@evil.com/x").origin)
    // Upper case and a default port are not how the text starts once read: no stress, the host named.
    XCTAssertNil(PermissionPrompt.link("HTTPS://Bun.sh/x").origin)
    XCTAssertEqual(PermissionPrompt.link("HTTPS://Bun.sh/x").host, "bun.sh")
    XCTAssertNil(PermissionPrompt.link("https://bun.sh:443/x").origin)
    XCTAssertEqual(PermissionPrompt.link("https://bun.sh:443/x").host, "bun.sh")
    XCTAssertEqual(PermissionPrompt.link("http://localhost:3000/a").origin, "http://localhost:3000")
    XCTAssertEqual(PermissionPrompt.link("https://bun.sh/docs/bundler#splitting").origin, "https://bun.sh")
    // A look-alike letter shows in its punycode form.
    let lookalike = PermissionPrompt.link("https://b\u{0443}n.sh/")
    XCTAssertNil(lookalike.origin)
    XCTAssertEqual(lookalike.host?.hasPrefix("xn--"), true)
    XCTAssertNil(PermissionPrompt.link("file:///etc/passwd").host)
  }

  // MARK: Small rules of the window

  func testAShortPlainRefusalIsTheLineAndAnythingElseIsNot() {
    XCTAssertEqual(SendFailure.plain(" This thread is resolved; reopen it to answer. "), "This thread is resolved; reopen it to answer.")
    XCTAssertNil(SendFailure.plain(String(repeating: "x", count: 161)))
    XCTAssertNil(SendFailure.plain("Could not write /Users/a/inbox/x.jsonl"))
    XCTAssertNil(SendFailure.plain("write failed: ENOSPC"))
    XCTAssertNil(SendFailure.plain("  "))
  }

  func testDrawnOrAlignedCodeKeepsItsLayoutAndOrdinaryCodeWraps() {
    XCTAssertTrue(CodeLayout.keeps("┌───┐\n│ a │\n└───┘"))
    XCTAssertTrue(CodeLayout.keeps(" M apps/a.swift\nname    size"))
    XCTAssertTrue(CodeLayout.keeps("a\tb"))
    XCTAssertFalse(CodeLayout.keeps("const wait = Math.min(60_000, 1000 * 2 ** tries)\n  await sleep(wait)"))
    XCTAssertFalse(CodeLayout.keeps("One sentence.  Another one."), "a double space after a sentence is prose")
  }

  func testEachMarkOfARowHasItsOwnStepAndADoneInTheDraftStillShows() throws {
    func row(_ section: InboxSectionId, open: Double, actions: Double? = nil, staged: Double? = nil, waits: [InboxRowWait]? = nil) throws -> InboxListRow {
      var row = try XCTUnwrap(StandInData.list(threads: StandInData.threads(now: Date()), unread: [], session: "s", cursor: 1, version: "1").sections.flatMap(\.threads).first)
      row.section = section
      row.questions.openValue = open
      row.questions.actions = actions
      row.questions.staged = staged
      row.waits = waits
      return row
    }
    let message = MessageID("msg_X")
    func wait(_ key: String, stopped: String? = nil, holds: [String] = []) -> InboxRowWait { InboxRowWait(messageId: message, key: key, position: 0, prompt: "p", stopped: stopped, holdsUp: holds) }
    // Stopped only by an action item: the action box is the red one, the question mark stays quiet.
    var marks = RowMarks(try row(.stopped, open: 2, actions: 1, waits: [wait("a-00000001", stopped: ""), wait("q-00000001")]))
    XCTAssertEqual([marks.questions, marks.actions], [1, 1])
    XCTAssertEqual([marks.question, marks.action], [.open, .stop])
    // Nothing open, the agent still stopped: a Done waits in the draft, and its mark shows.
    marks = RowMarks(try row(.stopped, open: 0, staged: 1))
    XCTAssertEqual([marks.questions, marks.actions], [0, 1])
    XCTAssertEqual(marks.action, .stop)
    // No waits told (an older Inbox): the row's state goes on the question mark.
    marks = RowMarks(try row(.holding, open: 3))
    XCTAssertEqual([marks.question, marks.action], [.hold, .open])
    // A row that only waits: both quiet.
    marks = RowMarks(try row(.waiting, open: 2, actions: 1))
    XCTAssertEqual([marks.question, marks.action], [.open, .open])
    XCTAssertEqual([RowMarks.shown(99), RowMarks.shown(100)], ["99", "99+"])
  }

  func testTheButtonAtAThreadsFootCountsWhatWaitsIncludingPickedAnswers() throws {
    var thread = try XCTUnwrap(StandInData.threads(now: Date()).first { $0.threadId == StandInData.onboarding })
    var items = OpenItems(thread)
    XCTAssertEqual([items.questions, items.actions, items.permissions], [1, 1, 0])
    let at = try XCTUnwrap(thread.messages[0].questions?.firstIndex { $0.kind != .action })
    thread.messages[0].questions?[at].state = .picked
    items = OpenItems(thread)
    XCTAssertEqual(items.questions, 1, "a picked answer still waits until it is sent")
    items = OpenItems(StandInData.permissionThread(now: Date()))
    XCTAssertEqual([items.questions, items.actions, items.permissions], [0, 0, 1])
    XCTAssertTrue(items.shown)
  }

  private func prompt(_ session: InboxSession) throws -> (InboxMessageWire, InboxQuestion) {
    let asked = try XCTUnwrap(session.thread(StandInData.permission)?.thread.messages.first)
    return (asked, try XCTUnwrap(asked.questions?.first))
  }

  func testAPermissionAnswerIsPickedAndSentAtOnceAndCarriesNothingElse() async throws {
    let door = StandInDoor()
    // The same thread also holds a drafted answer to an ordinary question: it is not the prompt's to send.
    var thread = StandInData.permissionThread(now: Date())
    var other = try XCTUnwrap(StandInData.threads(now: Date()).first { $0.threadId == StandInData.retry }?.messages.last)
    other.threadId = StandInData.permission
    thread.messages.insert(other, at: 0)
    await door.add(thread)
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.permission)
    let drafted = try XCTUnwrap(session.thread(StandInData.permission)?.thread.messages.first)
    let question = try XCTUnwrap(drafted.questions?.first)
    await session.pick(thread: StandInData.permission, message: drafted.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))

    let asked = try XCTUnwrap(session.thread(StandInData.permission)?.thread.messages.last)
    let ask = try XCTUnwrap(asked.questions?.first)
    XCTAssertNil(PermissionPrompt.outcome(ask), "it waits")
    await session.answerNow(thread: StandInData.permission, message: asked.id, question: ask, answer: QuestionAnswer(v: 1, key: ask.key, kind: .single, prompt: ask.prompt, selected: [PermissionPrompt.allowOnce]))

    let replies = await door.posts("/reply")
    XCTAssertEqual(replies.map(\.path), ["messages/\(asked.id.rawValue)/reply"])
    XCTAssertEqual(body(replies[0])["questions"]?.items.map { $0["key"]?.text }, [ask.key], "only the prompt's own answer")
    XCTAssertEqual(body(replies[0])["words"]?.text, "")
    let stored = await door.thread(StandInData.permission)
    XCTAssertEqual(stored?.messages.first?.questions?.first?.state, .picked, "the drafted answer still waits for the person's Send")
    let answered = try XCTUnwrap(session.thread(StandInData.permission)?.thread.messages.first { $0.id == asked.id }?.questions?.first)
    XCTAssertEqual(PermissionPrompt.outcome(answered), .once)
    XCTAssertTrue(PermissionPrompt.saidByCards(in: try XCTUnwrap(session.thread(StandInData.permission)?.thread)).contains(MessageID(try XCTUnwrap(answered.sentReplyId))), "the reply that carried it is the card's to say")
  }

  func testDenyWithAReasonGoesAsWordsWithNoChoice() async throws {
    let door = StandInDoor()
    await door.add(StandInData.permissionThread(now: Date()))
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.permission)
    let (asked, ask) = try prompt(session)
    await session.answerNow(thread: StandInData.permission, message: asked.id, question: ask, answer: QuestionAnswer(v: 1, key: ask.key, kind: .single, prompt: ask.prompt, selected: [], other: "Run it on the copy first."))
    let pickPosts = await door.posts("/picks")
    let pick = try XCTUnwrap(pickPosts.first)
    XCTAssertEqual(body(pick)["questions"]?.items.first?["answer"]?["selected"]?.items.count, 0)
    XCTAssertEqual(body(pick)["questions"]?.items.first?["answer"]?["other"]?.text, "Run it on the copy first.")
    XCTAssertEqual(body(pick)["unsent_only"]?.flag, true)
    let answered = try prompt(session).1
    XCTAssertEqual(PermissionPrompt.outcome(answered), .deny)
    XCTAssertEqual(PermissionPrompt.reason(answered), "Run it on the copy first.")
  }

  func testFullPermissionsGoesOnlyWithThePersonsConfirmation() async throws {
    let door = StandInDoor()
    await door.add(StandInData.permissionThread(now: Date()))
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.permission)
    let (asked, ask) = try prompt(session)
    let full = QuestionAnswer(v: 1, key: ask.key, kind: .single, prompt: ask.prompt, selected: [PermissionPrompt.full])
    XCTAssertFalse(PermissionPrompt.fullUsed(in: try XCTUnwrap(session.thread(StandInData.permission)?.thread), before: asked))

    // Not confirmed: the Inbox takes nothing, the card says so on itself, and no reply is left to go on its own.
    await session.answerNow(thread: StandInData.permission, message: asked.id, question: ask, answer: full)
    XCTAssertNotNil(session.refusal(message: asked.id, key: ask.key))
    XCTAssertNil(session.notices[StandInData.permission], "the reply that would have carried it was never made")
    XCTAssertTrue(session.held.isEmpty)
    let none = await door.posts("/reply").isEmpty
    XCTAssertTrue(none)

    await session.answerNow(thread: StandInData.permission, message: asked.id, question: try prompt(session).1, answer: full, confirmFull: true)
    let confirmedPosts = await door.posts("/picks")
    let confirmed = try XCTUnwrap(confirmedPosts.last)
    XCTAssertEqual(body(confirmed)["confirm_full"]?.flag, true)
    XCTAssertNil(session.refusal(message: asked.id, key: ask.key))
    XCTAssertEqual(PermissionPrompt.outcome(try prompt(session).1), .full)
  }
}
