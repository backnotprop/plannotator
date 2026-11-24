import Foundation
import XCTest
@testable import InboxCore
import InboxStandIn
import InboxWire

/// Writing on the phone, part 2: tagging agents with `@`, 👍 Looks good and its tray, and Take back, against the
/// stand-in computer.
@MainActor
final class WritingTwoTests: XCTestCase {
  private func picture() -> Data { Data((0..<64).map { UInt8($0) }) }

  private func replies(_ door: StandInDoor) async -> [DoorCall] { await door.calls.filter { $0.method == .post && $0.path.hasSuffix("/reply") } }

  /// The `@` list, a pick, and the Send: the reply carries the tag exactly as the window sends it.
  private func tagPi(_ session: InboxSession, in id: ThreadID, before: String = "Ask ") async throws -> TagOption {
    await session.readTaggable(id)
    XCTAssertTrue(session.tagsOffered(id))
    let typed = "\(before)@p"
    let trigger = try XCTUnwrap(TagRules.trigger(typed, caret: typed.utf16.count))
    let options = TagRules.matches(session.tagOptions(id, time: { $0 }), trigger: trigger, tagged: [])
    let pi = try XCTUnwrap(options.first { $0.host == "pi" })
    let picked = TagRules.pick(typed, trigger, label: pi.label)
    session.pickTag(id, words: picked.text, option: pi)
    return pi
  }

  // MARK: Tags

  func testATaggedReplyCarriesTheTagAndTheSentMessageNamesIt() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    let pi = try await tagPi(session, in: StandInData.retry)
    XCTAssertFalse(pi.owner)
    XCTAssertEqual(pi.label, "Pi")
    let words = "\(try XCTUnwrap(session.draft(StandInData.retry)?.words))raise the timeout"
    session.keepDraft(StandInData.retry, words: words)
    await door.clearCalls()

    let got1 = await session.send(thread: StandInData.retry, words: words)
    XCTAssertTrue(got1)
    let sentCalls = await replies(door)
    let reply = try XCTUnwrap(sentCalls.last)
    XCTAssertEqual(body(reply)["words"], .string("Ask @Pi raise the timeout"), "the words keep the token as typed")
    XCTAssertEqual(body(reply)["tags"], .array([.object(["host": .string("pi"), "session": .string("ses_docs"), "label": .string("Pi")])]))
    let onComputer = await door.thread(StandInData.retry)
    let sent = try XCTUnwrap(onComputer?.messages.last)
    XCTAssertEqual(sent.tags?.map(\.session), ["ses_docs"])
    XCTAssertNil(session.draft(StandInData.retry)?.tags, "the Send spent the tag")
  }

  func testATagWhoseTokenWasDeletedIsNotSentAndTheOwnerNeverIs() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    _ = try await tagPi(session, in: StandInData.retry)
    // The owner (Claude Code, which the reply goes to anyway) tagged too.
    let owner = try XCTUnwrap(session.tagOptions(StandInData.retry, time: { $0 }).first { $0.owner })
    session.pickTag(StandInData.retry, words: "Ask @P and @\(owner.label) ", option: owner)
    await door.clearCalls()
    let got2 = await session.send(thread: StandInData.retry, words: "Ask @P and @\(owner.label) ")
    XCTAssertTrue(got2)
    let sentCalls = await replies(door)
    let reply = try XCTUnwrap(sentCalls.last)
    XCTAssertNil(body(reply)["tags"], "the @Pi token is gone, and the owner is never a tag")
  }

  func testATagWhoseTokenWasDeletedStaysGoneWhenTheWordsAreTypedAgain() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    _ = try await tagPi(session, in: StandInData.retry)
    // The token is deleted, then "@Pi" is typed again by hand: it is words now, not a tag (as in the window).
    session.keepDraft(StandInData.retry, words: "Ask ")
    session.keepDraft(StandInData.retry, words: "Ask @Pi raise the timeout")
    XCTAssertNil(session.draft(StandInData.retry)?.tags)
    await door.clearCalls()
    let got = await session.send(thread: StandInData.retry, words: "Ask @Pi raise the timeout")
    XCTAssertTrue(got)
    let sentCalls = await replies(door)
    let reply = try XCTUnwrap(sentCalls.last)
    XCTAssertNil(body(reply)["tags"])
  }

  func testSendEmptyingTheBoxBeforeItReadsTheTagsStillSendsThem() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    _ = try await tagPi(session, in: StandInData.retry)
    let words = "Ask @Pi raise the timeout"
    session.keepDraft(StandInData.retry, words: words)
    // The box empties as Send is pressed, before the Send reads the draft.
    session.keepDraft(StandInData.retry, words: "")
    await door.clearCalls()
    let got = await session.send(thread: StandInData.retry, words: words)
    XCTAssertTrue(got)
    let sentCalls = await replies(door)
    let reply = try XCTUnwrap(sentCalls.last)
    XCTAssertEqual(body(reply)["tags"]?.items.count, 1)
    XCTAssertNil(session.draft(StandInData.retry)?.tags, "the Send spent it")
  }

  func testAReplyRefusedForATagGivesTheWordsAndTheTagBack() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    _ = try await tagPi(session, in: StandInData.retry)
    let words = try XCTUnwrap(session.draft(StandInData.retry)?.words) + "now"
    session.keepDraft(StandInData.retry, words: words)
    // Pi's session ends before the Send.
    let groups = await door.sessionsSnapshot()
    await door.setLiveSessions(groups.map { group in
      var kept = group
      kept.sessions.removeAll { $0.host == "pi" }
      return kept
    })
    _ = await session.send(thread: StandInData.retry, words: words)
    XCTAssertEqual(session.takeReturnedWords(StandInData.retry), words)
    XCTAssertEqual(session.draft(StandInData.retry)?.tags?.map(\.session), ["ses_docs"], "the tag waits with the words for the person to change")
    if case .refused(_, let code)? = session.notices[StandInData.retry] { XCTAssertEqual(code, "session_not_live") } else { XCTFail("the refusal is said") }
  }

  func testAtIsPlainTextUntilTheComputerSaysWhoCanBeTagged() async throws {
    let door = StandInDoor(options: { var o = StandInDoor.Options(); o.withoutRoutes = ["GET threads/:id/taggable"]; return o }())
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    await session.readTaggable(StandInData.retry)
    XCTAssertFalse(session.tagsOffered(StandInData.retry))
  }

  // MARK: Take back

  func testTakeBackPutsTheWordsFilesQuoteAndTagsBackAndTheNextSendClearsTheComputersDraft() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    let first = try XCTUnwrap(session.thread(StandInData.retry)?.thread.messages.first).id
    _ = try await tagPi(session, in: StandInData.retry)
    let words = try XCTUnwrap(session.draft(StandInData.retry)?.words) + "look at this"
    session.keepDraft(StandInData.retry, words: words)
    session.setQuote(StandInData.retry, DraftQuote(of: first))
    await session.attach(picture(), name: "shot.png", type: "image/png", to: .thread(StandInData.retry))
    let got3 = await session.send(thread: StandInData.retry, words: words, files: session.files(.thread(StandInData.retry)), quote: session.draft(StandInData.retry)?.quote)
    XCTAssertTrue(got3)
    let sent = try XCTUnwrap(session.thread(StandInData.retry)?.thread.messages.last)
    XCTAssertEqual(sent.author.kind, .person)
    XCTAssertTrue(session.takeBackOffered(StandInData.retry, sent))

    let got4 = await session.takeBack(StandInData.retry, message: sent.id, name: "Claude Code")
    XCTAssertEqual(got4, .taken)
    XCTAssertFalse(session.thread(StandInData.retry)?.thread.messages.contains { $0.id == sent.id } ?? true, "it left the thread")
    XCTAssertEqual(session.takeRefilledWords(StandInData.retry), words)
    let draft = try XCTUnwrap(session.draft(StandInData.retry))
    XCTAssertEqual(draft.words, words)
    XCTAssertEqual(draft.quote?.of, first)
    XCTAssertEqual(draft.files?.map(\.name), ["shot.png"])
    XCTAssertNotNil(draft.files?.first?.upload, "the file is an upload on the computer again")
    XCTAssertEqual(draft.tags?.map(\.session), ["ses_docs"])

    // Sent again as it came back: the same tag, the file, the quote, and the computer's draft is cleared.
    await door.clearCalls()
    let base = session.computerDraft(StandInData.retry)?.updatedAt
    let got5 = await session.send(thread: StandInData.retry, words: words, clearDraft: base, files: session.files(.thread(StandInData.retry)), quote: draft.quote)
    XCTAssertTrue(got5)
    let againCalls = await replies(door)
    let again = try XCTUnwrap(againCalls.last)
    XCTAssertEqual(body(again)["clear_draft"], base.map { .string($0) })
    XCTAssertEqual(body(again)["tags"]?.items.count, 1)
    XCTAssertEqual(body(again)["uploads"]?.items.count, 1)
    XCTAssertEqual(body(again)["quote"]?["of"], .string(first.rawValue))
  }

  // MARK: Take back and the words in the box

  func testTakeBackJoinsTheReplysWordsWithTheBoxAsTheWindowWould() {
    // The box began as the computer's draft "foo", untouched: the computer's own join is the window's.
    XCTAssertEqual(TakeBackRule.refill(body: "R\n\nfoo", kept: "foo", box: "foo", fromKept: true), "R\n\nfoo")
    // Changed on the phone: the phone's words stand in for the draft they began as.
    XCTAssertEqual(TakeBackRule.refill(body: "R\n\nfoo", kept: "foo", box: "foo bar", fromKept: true), "R\n\nfoo bar")
    // Emptied on the phone: the reply's words alone, as the window's emptied box would make it.
    XCTAssertEqual(TakeBackRule.refill(body: "R\n\nfoo", kept: "foo", box: "", fromKept: true), "R")
    // A reply of files only: the box's words, unchanged.
    XCTAssertEqual(TakeBackRule.refill(body: "foo", kept: "foo", box: "foo bar", fromKept: true), "foo bar")
    // The computer had no words: the reply's, then the box's.
    XCTAssertEqual(TakeBackRule.refill(body: "R", kept: nil, box: "mine", fromKept: false), "R\n\nmine")
    // Words of the phone's own, beside a draft on the computer: nothing of either is lost, and nothing twice.
    XCTAssertEqual(TakeBackRule.refill(body: "R\n\nfoo", kept: "foo", box: "mine", fromKept: false), "R\n\nfoo\n\nmine")
    XCTAssertEqual(TakeBackRule.refill(body: "R\n\nfoo", kept: "foo", box: "foo", fromKept: false), "R\n\nfoo")
    // The computer's draft changed after the box began from it: its new words stay, the box's follow.
    XCTAssertEqual(TakeBackRule.refill(body: "R\n\nfoo, changed", kept: "foo", box: "foo bar", fromKept: true), "R\n\nfoo, changed\n\nfoo bar")
  }

  /// A reply sent with an empty box, then a draft on the computer that the box opens with.
  private func sentThenDraft(_ door: StandInDoor, _ session: InboxSession, draft: String = "foo") async throws -> MessageID {
    await session.start()
    await session.open(StandInData.retry)
    let got = await session.send(thread: StandInData.retry, words: "R")
    XCTAssertTrue(got)
    let sent = try XCTUnwrap(session.thread(StandInData.retry)?.thread.messages.last).id
    await door.setDraft(StandInData.retry, body: draft)
    let opening = await session.openDraft(StandInData.retry)
    XCTAssertEqual(opening.words, draft)
    session.keepDraft(StandInData.retry, words: draft)
    return sent
  }

  func testTakeBackKeepsTheWordsChangedOnThePhone() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    let sent = try await sentThenDraft(door, session)
    session.keepDraft(StandInData.retry, words: "foo bar")
    let outcome = await session.takeBack(StandInData.retry, message: sent, name: "Claude Code")
    XCTAssertEqual(outcome, .taken)
    XCTAssertEqual(session.takeRefilledWords(StandInData.retry), "R\n\nfoo bar", "the phone's \"bar\" is kept")
    XCTAssertEqual(session.draft(StandInData.retry)?.words, "R\n\nfoo bar")
    // The Send that clears the computer's draft carries every word.
    await door.clearCalls()
    let base = session.computerDraft(StandInData.retry)?.updatedAt
    let again = await session.send(thread: StandInData.retry, words: "R\n\nfoo bar", clearDraft: base)
    XCTAssertTrue(again)
    let sentCalls = await replies(door)
    let reply = try XCTUnwrap(sentCalls.last)
    XCTAssertEqual(body(reply)["words"], .string("R\n\nfoo bar"))
  }

  func testATakeBackRetriedAfterALostAnswerUsesItsKeyAgainAndFillsTheBox() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    let sent = try await sentThenDraft(door, session)
    session.keepDraft(StandInData.retry, words: "foo bar")
    await door.loseTakeBackAnswers(1)
    await door.clearCalls()
    let lost = await session.takeBack(StandInData.retry, message: sent, name: "Claude Code")
    XCTAssertEqual(lost, .refused("It was not taken back. Try again."))
    XCTAssertNil(session.takeRefilledWords(StandInData.retry))
    let retried = await session.takeBack(StandInData.retry, message: sent, name: "Claude Code")
    XCTAssertEqual(retried, .taken)
    let keys = await door.calls.filter { $0.path.hasSuffix("/take-back") }.map { body($0)["idempotency_key"] }
    XCTAssertEqual(keys.count, 2)
    XCTAssertEqual(keys.first, keys.last, "one key for the whole Take back")
    XCTAssertEqual(session.takeRefilledWords(StandInData.retry), "R\n\nfoo bar")
  }

  func testATakeBackAnsweredWithNoDraftReadsTheComputersDraft() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    let sent = try await sentThenDraft(door, session)
    session.keepDraft(StandInData.retry, words: "foo bar")
    await door.loseTakeBackAnswers(1)
    _ = await session.takeBack(StandInData.retry, message: sent, name: "Claude Code")
    // The door's log of keys ended: the retry is answered as a reply already taken back, with no draft.
    await door.forgetKeys()
    let retried = await session.takeBack(StandInData.retry, message: sent, name: "Claude Code")
    XCTAssertEqual(retried, .taken)
    XCTAssertEqual(session.takeRefilledWords(StandInData.retry), "R\n\nfoo bar", "filled from the computer's draft, read again")
  }

  func testTakeBackOnAReplyAlreadyOnItsWaySaysItWasNotTakenBack() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.docs)
    await door.setOffline(true)
    _ = await session.send(thread: StandInData.docs, words: "Later")
    let held = try XCTUnwrap(session.held.first { $0.kind == .reply })
    session.book.inFlight.insert(held.id)
    XCTAssertEqual(session.takeBackHeld(held.id, name: "Pi"), .refused("It was not taken back. Try again."))
    XCTAssertTrue(session.held.contains { $0.id == held.id }, "it still goes")
    XCTAssertNil(session.takeReturnedWords(StandInData.docs))
    session.book.inFlight.remove(held.id)
    XCTAssertEqual(session.takeBackHeld(held.id, name: "Pi"), .taken)
    XCTAssertEqual(session.takeReturnedWords(StandInData.docs), "Later")
  }

  func testTakeBackSaysWhyWhenTheAgentHasItAndChangesNothing() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.retry)
    let got6 = await session.send(thread: StandInData.retry, words: "Ship it")
    XCTAssertTrue(got6)
    let sent = try XCTUnwrap(session.thread(StandInData.retry)?.thread.messages.last).id
    await door.agentTakes(sent)
    let outcome = await session.takeBack(StandInData.retry, message: sent, name: "Claude Code")
    XCTAssertEqual(outcome, .refused("Claude Code already has this message, so it can't be taken back. Reply below to change it."))
    XCTAssertTrue(session.thread(StandInData.retry)?.thread.messages.contains { $0.id == sent } ?? false)
    XCTAssertNil(session.takeRefilledWords(StandInData.retry))
  }

  func testTakeBackIsNotOfferedOnALoneFirstMessageOrADeliveredOne() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.upload)
    // The stand-in's person reply here waits (no `delivery`: no agent has it): offered.
    let waiting = try XCTUnwrap(session.thread(StandInData.upload)?.thread.messages.last)
    XCTAssertTrue(session.takeBackOffered(StandInData.upload, waiting))
    var delivered = waiting
    delivered.delivery = InboxDelivery(state: "delivered", host: "codex", session: "ses_store", at: "2026-11-23T10:00:00.000Z")
    XCTAssertFalse(TakeBackRule.offered(delivered, in: [delivered]))
    // Any `delivery` is one, as the window reads it, whatever its state says.
    delivered.delivery?.state = "queued"
    XCTAssertFalse(TakeBackRule.offered(delivered, in: [delivered]))
    let lone = InboxMessageWire(id: MessageID("msg_L"), projectId: ProjectID("p"), threadId: ThreadID("msg_L"), author: InboxAuthor(kind: .person), body: "Hi", createdAt: "2026-11-23T10:00:00.000Z")
    XCTAssertTrue(TakeBackRule.offered(lone, in: [lone]), "the window offers it")
    XCTAssertFalse(session.takeBackOffered(ThreadID("msg_L"), lone), "the phone does not: the door refuses draft_id")
  }

  func testTakingBackAReplyThatWaitsOnThePhoneGivesItsFilesAndQuoteBack() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.docs)
    let first = try XCTUnwrap(session.thread(StandInData.docs)?.thread.messages.first).id
    session.setQuote(StandInData.docs, DraftQuote(of: first))
    await session.attach(picture(), name: "shot.png", type: "image/png", to: .thread(StandInData.docs))
    await door.setOffline(true)
    _ = await session.send(thread: StandInData.docs, words: "Later", files: session.files(.thread(StandInData.docs)), quote: session.draft(StandInData.docs)?.quote)
    let held = try XCTUnwrap(session.held.first { $0.kind == .reply })
    XCTAssertEqual(session.cancelHeld(held.id), .cancelled)
    XCTAssertEqual(session.takeReturnedWords(StandInData.docs), "Later")
    XCTAssertEqual(session.draft(StandInData.docs)?.quote?.of, first)
    XCTAssertEqual(session.draft(StandInData.docs)?.files?.map(\.name), ["shot.png"])
  }

  // MARK: 👍 Looks good

  func testLooksGoodMarksTheLatestAgentMessageAndATapAgainTakesItBack() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.docs)
    let target = try XCTUnwrap(session.ackTarget(StandInData.docs))
    let got7 = await session.react(StandInData.docs, message: target.id, on: true)
    XCTAssertEqual(got7, .done)
    let calls = await door.calls
    let call = try XCTUnwrap(calls.last { $0.path.hasSuffix("/ack") })
    XCTAssertEqual(body(call)["ack"], .bool(true))
    XCTAssertEqual(body(call)["reaction"], .null, "the tray's 👍 is Looks good: a null reaction")
    let marked = try XCTUnwrap(session.thread(StandInData.docs)?.thread.messages.last?.ack)
    XCTAssertEqual(Reactions.line(marked, agent: "Pi", wakes: true, time: { _ in "now" }).text, "You, now · goes to Pi in a few seconds")
    XCTAssertEqual(session.ackTarget(StandInData.docs)?.id, target.id, "still pressed: a tap takes it back")

    let got8 = await session.react(StandInData.docs, message: target.id, on: false)
    XCTAssertEqual(got8, .done)
    XCTAssertNil(session.thread(StandInData.docs)?.thread.messages.last?.ack)
  }

  func testAnotherEmojiFromTheTrayAndOnceSentItStays() async throws {
    let door = StandInDoor()
    let session = await pairedSession(door: door)
    await session.start()
    await session.open(StandInData.bumps)
    let target = try XCTUnwrap(session.ackTarget(StandInData.bumps))
    let got9 = await session.react(StandInData.bumps, message: target.id, on: true, reaction: Reactions.reaction(for: "🚀"))
    XCTAssertEqual(got9, .done)
    XCTAssertEqual(session.thread(StandInData.bumps)?.thread.messages.last?.ack?.reaction?.emoji, "🚀")
    // Its ten seconds pass: it goes to the agent, and the button is not offered again.
    await door.setAckWindow(0)
    await session.open(StandInData.bumps)
    XCTAssertNotNil(session.thread(StandInData.bumps)?.thread.messages.last?.ack?.settledSeq)
    XCTAssertNil(session.ackTarget(StandInData.bumps))
    let got10 = await session.react(StandInData.bumps, message: target.id, on: false)
    XCTAssertEqual(got10, .refused("This reaction was sent already; it can't be taken back."))
  }

  func testLooksGoodIsNotOfferedWhileAQuestionWaitsOrTheBoxHoldsWords() async throws {
    let session = await pairedSession(door: StandInDoor())
    await session.start()
    await session.open(StandInData.retry)
    XCTAssertNil(session.ackTarget(StandInData.retry), "a question waits")
    await session.open(StandInData.docs)
    XCTAssertNotNil(session.ackTarget(StandInData.docs))
    session.keepDraft(StandInData.docs, words: "One more thing")
    XCTAssertNil(session.ackTarget(StandInData.docs), "the box holds words: the reply is the answer")
  }

  func testAnEmojiIsOneCharacterDrawnAsOne() {
    XCTAssertTrue(Reactions.isEmoji("🚀"))
    XCTAssertTrue(Reactions.isEmoji("👍🏽"))
    XCTAssertTrue(Reactions.isEmoji("❤️"))
    XCTAssertFalse(Reactions.isEmoji("a"))
    XCTAssertFalse(Reactions.isEmoji("🚀🚀"))
    XCTAssertFalse(Reactions.isEmoji("1"))
  }
}
