import XCTest

/// The M3 proof, in action against a real Inbox (apps/ios/scripts/proof.ts):
/// the decision switch and its sheet (5.1), the Decisions tab (5.2), and New
/// message (8.1 to 8.3) to live Claude Code sessions, which are the Claude
/// Code mod's own code polling the Inbox from their projects. Without the
/// script the test is skipped. It starts from a cold install (ProofCase), and
/// leaves the app as a fresh install finds it and deletes its threads on the
/// computer.
@MainActor
final class DecisionsProofTests: ProofCase {
    func testDecisionsAndNewMessage() async throws {
        app.launch()
        let seeded = try await control.post("/m3-seed")
        let decide = try XCTUnwrap(seeded["decide"] as? String)
        let noDecision = try XCTUnwrap(seeded["no_decision"] as? String)
        let pi = try XCTUnwrap(seeded["pi"] as? String)
        try await pairByCode()
        try await control.post("/video/start", ["name": "M3-decisions-new-message"])

        // A question answered and sent with the switch off records no decision.
        try await openRow(noDecision)
        let yes = app.buttons["choice-Yes"]
        XCTAssertTrue(yes.waitForExistence(timeout: 30))
        let offKey = try XCTUnwrap(questionKeys().first)
        XCTAssertFalse(isOn(element("decision-\(offKey)")), "the switch starts off")
        yes.tap()
        XCTAssertTrue(waitForLabel(element("reply-field"), "1 pick"))
        element("send").tap()
        XCTAssertTrue(sentLine().waitForExistence(timeout: 30))
        let offDecisions = try await control.post("/m3-decisions", ["thread": noDecision])
        XCTAssertEqual((offDecisions["of_thread"] as? [Any])?.count, 0, "a decision with the switch off: \(offDecisions)")
        back()

        // The switch turned on opens the decision card as a sheet (5.1), the
        // words drafted from the pick and the question. Cancel keeps nothing.
        try await openRow(decide)
        let retry = app.buttons["choice-Retry with the same idempotency key"]
        XCTAssertTrue(retry.waitForExistence(timeout: 30))
        let key = try XCTUnwrap(questionKeys().first)
        retry.tap()
        XCTAssertTrue(waitForLabel(element("reply-field"), "1 pick"))
        let row = element("decision-\(key)")
        XCTAssertTrue(row.label.contains("Record as a decision"), row.label)
        row.switches.firstMatch.tap()
        let statement = element("decision-text")
        XCTAssertTrue(statement.waitForExistence(timeout: 30))
        XCTAssertEqual(statement.value as? String, "Retry with the same idempotency key.")
        XCTAssertEqual(element("decision-reason").value as? String, "Asked by Claude Code: Which way should the worker go on a Stripe 409?")
        element("decision-cancel").tap()
        XCTAssertTrue(statement.waitForNonExistence(timeout: 30), "Cancel closes the sheet")
        XCTAssertFalse(isOn(row), "Cancel keeps the switch off")

        // On again; Done keeps the words and turns recording on.
        row.switches.firstMatch.tap()
        XCTAssertTrue(statement.waitForExistence(timeout: 30))
        try await control.shot("5.1")
        try await control.post("/text-size", ["size": "accessibility-extra-extra-extra-large"])
        try await control.shot("ax-5.1")
        try await control.post("/text-size", ["size": "large"])
        element("decision-done").tap()
        // The sheet is gone before Back: while it slides away its Cancel is the first bar button.
        XCTAssertTrue(statement.waitForNonExistence(timeout: 30), "Done closes the sheet")
        XCTAssertTrue(waitForLabel(row, "Answering this records a decision"))
        XCTAssertTrue(isOn(row))
        back()

        // 5.2 before Send: the question waits on a call, beside what holds.
        tab("Decisions")
        let waiting = app.buttons.containing(NSPredicate(format: "label CONTAINS 'Which way should the worker go on a Stripe 409?'")).firstMatch
        XCTAssertTrue(waiting.waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["Waiting"].exists || app.otherElements.containing(NSPredicate(format: "label BEGINSWITH 'Waiting'")).firstMatch.exists)

        // A waiting row opens its thread; Send there records the decision.
        waiting.tap()
        XCTAssertTrue(retry.waitForExistence(timeout: 30))
        element("send").tap()
        XCTAssertTrue(sentLine().waitForExistence(timeout: 30))
        back()

        // 5.2 after Send: Settled, newest first, and found by the desktop window's own route.
        let settled = app.buttons.containing(NSPredicate(format: "label BEGINSWITH 'Retry with the same idempotency key.'")).firstMatch
        XCTAssertTrue(settled.waitForExistence(timeout: 30))
        XCTAssertTrue(settled.label.contains("From your answer to Claude Code"), settled.label)
        let onDecisions = try await control.post("/m3-decisions", ["thread": decide])
        let recorded = try XCTUnwrap(onDecisions["of_thread"] as? [[String: Any]])
        XCTAssertEqual(recorded.count, 1, "\(onDecisions)")
        XCTAssertEqual(recorded.first?["text"] as? String, "Retry with the same idempotency key.")
        let newest = try XCTUnwrap((onDecisions["current"] as? [String])?.first)
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'decision-dec_'")).firstMatch.label.hasPrefix(newest), "newest first")
        element("decisions-ended").tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Retired'")).firstMatch.waitForExistence(timeout: 30)
            || app.otherElements.containing(NSPredicate(format: "label CONTAINS 'Retired ·'")).firstMatch.exists)
        element("decisions-ended").tap()
        try await control.shot("5.2")
        try await control.post("/text-size", ["size": "accessibility-extra-extra-extra-large"])
        try await control.shot("ax-5.2")
        try await control.post("/text-size", ["size": "large"])

        // A settled row opens its thread.
        settled.tap()
        XCTAssertTrue(app.staticTexts["Which way should the worker go on a Stripe 409?"].firstMatch.waitForExistence(timeout: 30))
        back()
        tab("Inbox")

        // The live Claude Code sessions start now, not at the seed, so the runner is quiet while the app pairs.
        let live = try await control.post("/m3-live")
        let gateway = try XCTUnwrap(live["gateway"] as? String)
        let ledger = try XCTUnwrap(live["ledger"] as? String)

        // 8.2: one live session in api-gateway; New message opens the compose sheet addressed to it.
        try await openRow(gateway)
        let newMessage = element("new-message")
        XCTAssertTrue(newMessage.waitForExistence(timeout: 30))
        XCTAssertEqual(newMessage.label, "New message")
        newMessage.tap()
        let words = element("new-message-text")
        XCTAssertTrue(words.waitForExistence(timeout: 30))
        XCTAssertTrue(element("new-message-to").label.contains("Claude Code, started"), element("new-message-to").label)
        words.typeText("Before you merge, write the header row first so an empty ledger still exports a valid CSV.")
        try await control.shot("8.2")
        element("new-message-send").tap()
        XCTAssertTrue(words.waitForNonExistence(timeout: 30), "the sheet closes once delivered")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'write the header row first'")).firstMatch.waitForExistence(timeout: 30))

        // The live session takes it as a turn and answers in the same thread.
        let turn = try await control.post("/m3-turn", ["who": "gateway"])
        XCTAssertEqual(turn["submits"] as? [String: Int], ["gateway": 1, "ledger-writer": 0, "ledger-other": 0], "\(turn)")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Added the header row'")).firstMatch.waitForExistence(timeout: 30))
        try await control.shot("new-message-answered")
        back()
        let gatewayRow = element("row-\(gateway)")
        XCTAssertTrue(gatewayRow.waitForExistence(timeout: 30))
        try await control.shot("new-message-list")

        // 8.1: two live sessions in ledger; a system menu names each, the thread's writer first.
        try await openRow(ledger)
        XCTAssertTrue(newMessage.waitForExistence(timeout: 30))
        let menuHeading = app.staticTexts["Two Claude Code sessions are live in ledger"]
        var opened = false
        for _ in 0..<15 where !opened {
            newMessage.tap()
            opened = menuHeading.waitForExistence(timeout: 2)
            if !opened {
                // Still one live as last read: the sheet opened; close it and wait for the next read.
                if element("new-message-cancel").exists { element("new-message-cancel").tap() }
                try await Task.sleep(for: .seconds(2))
            }
        }
        XCTAssertTrue(opened, "the menu of two live sessions")
        let items = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'live-session-'"))
        XCTAssertEqual(items.count, 2)
        try await control.shot("8.1")
        try await darkFrame("8.1", open: { newMessage.tap() }, shown: menuHeading)
        // The thread's writer first; each item says what the session is doing.
        let sorted = items.allElementsBoundByIndex.sorted { $0.frame.minY < $1.frame.minY }
        XCTAssertEqual(sorted[0].identifier, "live-session-\(try XCTUnwrap(live["ledger_writer_session"] as? String))", "the writer first")
        // Pick the other session, the one that did not write the thread.
        sorted[1].tap()
        XCTAssertTrue(words.waitForExistence(timeout: 30))
        words.typeText("Add a header row to the CSV export too.")
        element("new-message-send").tap()
        XCTAssertTrue(words.waitForNonExistence(timeout: 30), "the sheet closes once delivered")
        let picked = try await control.post("/m3-turn", ["who": "ledger-other"])
        XCTAssertEqual(picked["submits"] as? [String: Int], ["gateway": 1, "ledger-writer": 0, "ledger-other": 1], "only the picked session: \(picked)")
        back()

        // 8.3: none live in search-indexer: the desktop's words, and Reply instead opens the reply.
        try await openRow(pi)
        XCTAssertTrue(newMessage.waitForExistence(timeout: 30))
        newMessage.tap()
        XCTAssertTrue(app.staticTexts["Pi is not running in search-indexer"].waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Start Pi in ' AND label CONTAINS 'search-indexer and press New message again'")).firstMatch.exists)
        try await control.shot("8.3")
        try await darkFrame("8.3", open: { newMessage.tap() }, shown: app.staticTexts["Pi is not running in search-indexer"])

        // At the largest text size the words wrap and scroll in a sheet, and Reply instead stays reachable.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap()
        XCTAssertTrue(app.staticTexts["Pi is not running in search-indexer"].waitForNonExistence(timeout: 10))
        try await control.post("/text-size", ["size": "accessibility-extra-extra-extra-large"])
        newMessage.tap()
        let replyInstead = element("reply-instead")
        XCTAssertTrue(replyInstead.waitForExistence(timeout: 30))
        try await control.shot("ax-8.3")
        if !replyInstead.isHittable { app.swipeUp() }
        XCTAssertTrue(replyInstead.isHittable, "Reply instead reachable at the largest text size")
        replyInstead.tap()
        XCTAssertTrue(element("reply-text").waitForExistence(timeout: 30))
        try await control.post("/text-size", ["size": "large"])
        try await control.post("/video/stop")
        back()

        // Leave the computer and the app as the next proof expects them.
        try await control.post("/m3-cleanup")
        tab("Settings")
        let source = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'source-'")).firstMatch
        XCTAssertTrue(source.waitForExistence(timeout: 30))
        source.tap()
        app.reveal("remove-source").tap()
        app.sheets.buttons["Remove This Source"].firstMatch.tap()
        XCTAssertTrue(element("add-source").waitForExistence(timeout: 30))
        tab("Inbox")
        XCTAssertTrue(element("connect-computer").waitForExistence(timeout: 30))
    }

    // MARK: Helpers

    /// The dark frame of a menu or popover: closed, the simulator turned dark, opened again, then light again and open.
    private func darkFrame(_ name: String, open: () -> Void, shown: XCUIElement) async throws {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3)).tap() // a tap outside closes it
        XCTAssertTrue(shown.waitForNonExistence(timeout: 10))
        try await control.post("/m3-dark", ["on": "true"])
        open()
        XCTAssertTrue(shown.waitForExistence(timeout: 30))
        try await Task.sleep(for: .milliseconds(700))
        try await control.post("/m3-dark", ["on": "false", "snap": name])
    }

    private func isOn(_ row: XCUIElement) -> Bool {
        (row.switches.firstMatch.value as? String ?? row.value as? String) == "1"
    }

    private func sentLine() -> XCUIElement {
        app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Sent '")).firstMatch
    }
}
