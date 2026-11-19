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

  func testWhenANewerAnswerOfItWaitsThatOneDecides() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    let (asked, question) = try retry(session)
    await door.setOffline(true)
    await session.refresh()
    await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))
    let drawn = try retry(session).1
    await session.pick(thread: StandInData.retry, message: asked.id, question: drawn, answer: QuestionAnswers.choice(drawn, selected: ["Everyone at once"], note: "second thoughts"))
    await door.setOffline(false)
    await door.setOptions { $0.racesPicks = 1 }
    await session.refresh()

    let posts = await door.posts("/picks").count
    XCTAssertEqual(posts, 2, "the first is not saved again: the second goes at the Inbox's revision")
    XCTAssertTrue(session.held.isEmpty)
    XCTAssertNil(session.refusal(message: asked.id, key: question.key))
    let stored = await door.thread(StandInData.retry)?.messages.last?.questions?.first
    XCTAssertEqual(stored?.answer?.note, "second thoughts")
  }

  func testAPickTheThreadAlreadyExplainsAddsNoWords() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    let (asked, question) = try retry(session)
    // The agent replaced the question while the phone still shows it.
    await door.change(StandInData.retry) { thread in
      let last = thread.messages.count - 1
      thread.messages[last].questions?[0].state = .superseded
    }
    await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))
    XCTAssertNil(session.refusal(message: asked.id, key: question.key))
    XCTAssertEqual(try retry(session).1.state, .superseded, "the card now says it was replaced")
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
