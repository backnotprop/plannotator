import XCTest

/// The M1 proof, in action against a real Inbox: run by apps/ios/scripts/proof.ts,
/// which starts the compiled Inbox, connects the agents and answers this
/// test's control calls (`PROOF_CONTROL`). Without it the test is skipped.
@MainActor
final class ProofTests: ProofCase {

    func testPairPickSendResolveDeleteRemove() async throws {
        app.launch()

        // 1.1: nothing connected yet.
        XCTAssertTrue(element("connect-computer").waitForExistence(timeout: 30))
        try await control.shot("1.1")

        // The agents write before the phone pairs, so the list draws full.
        let seeded = try await control.post("/seed")
        let stopped = try XCTUnwrap(seeded["stopped"] as? String)
        let tests = try XCTUnwrap(seeded["tests"] as? String)
        let refunds = try XCTUnwrap(seeded["refunds"] as? String)

        // 1.2, then 1.3: pair by a typed address and the six digits.
        element("connect-computer").tap()
        XCTAssertTrue(element("find-nearby").waitForExistence(timeout: 30))
        try await control.shot("1.2")
        try await control.post("/video/start", ["name": "M1-pair-pick-send"])
        element("find-nearby").tap()
        let offer = try await control.post("/offer")
        let address = try XCTUnwrap(offer["address"] as? String)
        let code = try XCTUnwrap(offer["code"] as? String)
        let field = element("address-field")
        XCTAssertTrue(field.waitForExistence(timeout: 30))
        field.tap()
        field.typeText(address)
        element("address-next").tap()

        // A wrong code first: refused, with the tries left.
        let codeField = element("pairing-code")
        XCTAssertTrue(codeField.waitForExistence(timeout: 30))
        codeField.tap()
        codeField.typeText(String(code.prefix(5)) + (code.last == "9" ? "0" : "9"))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS '4 tries left'")).firstMatch.waitForExistence(timeout: 30))
        codeField.typeText(String(code.prefix(3)))
        try await control.shot("1.3")
        codeField.typeText(String(code.dropFirst(3)))

        // 2.1B: the list, drawn from the Inbox.
        let stoppedRow = element("row-\(stopped)")
        XCTAssertTrue(stoppedRow.waitForExistence(timeout: 30))
        try await control.shot("2.1B")

        // The largest Dynamic Type size: the rows stack and wrap, nothing is cut to "…".
        try await control.post("/text-size", ["size": "accessibility-extra-extra-extra-large"])
        try await control.shot("ax-list")
        try await control.post("/text-size", ["size": "large"])

        // 2.3: scrolled, two new threads wait behind the pill; a tap shows them.
        app.swipeUp()
        app.swipeUp()
        let arrived = try await control.post("/more")
        let keep = try XCTUnwrap(arrived["keep"] as? String)
        let pill = element("new-pill")
        XCTAssertTrue(pill.waitForExistence(timeout: 30))
        XCTAssertTrue(pill.label.contains("2 new"))
        try await control.shot("2.3")
        pill.tap()
        XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label CONTAINS 'Ship the dark ticket page'")).firstMatch.waitForExistence(timeout: 30))

        // 2.4: a row swiped shows Delete and Resolve.
        let docsRow = app.buttons.containing(NSPredicate(format: "label CONTAINS 'Is this the install flow'")).firstMatch
        XCTAssertTrue(docsRow.waitForExistence(timeout: 30))
        docsRow.swipeLeft()
        XCTAssertTrue(app.buttons["Resolve"].waitForExistence(timeout: 30))
        try await control.shot("2.4")
        app.buttons["Resolve"].tap()

        // A thread never read on this phone while the computer is out of reach:
        // "Can't reach", then Try Again once it is back.
        try await control.post("/proxy", ["mode": "down"])
        let ticketRow = app.buttons.containing(NSPredicate(format: "label CONTAINS 'Which ticket page should I take forward'")).firstMatch
        scrollTo(ticketRow)
        ticketRow.tap()
        XCTAssertTrue(element("thread-unreachable").waitForExistence(timeout: 30))
        try await control.shot("thread-unreachable")
        try await control.post("/proxy", ["mode": "pass"])
        app.buttons["Try Again"].firstMatch.tap()
        XCTAssertTrue(app.buttons["choice-The dark one"].waitForExistence(timeout: 30))
        back()
        app.swipeDown()
        app.swipeDown()

        // 3.1: the thread at rest.
        stoppedRow.tap()
        let first = app.buttons["choice-Retry with the same idempotency key"]
        XCTAssertTrue(first.waitForExistence(timeout: 30))
        try await control.shot("3.1")

        // The thread at the largest Dynamic Type size: it wraps inside the screen.
        try await control.post("/text-size", ["size": "accessibility-extra-extra-extra-large"])
        try await control.shot("ax-thread")
        app.swipeUp()
        try await control.shot("ax-thread-card")
        try await control.post("/text-size", ["size": "large"])
        app.swipeDown()
        app.swipeDown()

        // 3.2: a pick, a note, Other.
        first.tap()
        let replyField = element("reply-field")
        XCTAssertTrue(waitForLabel(replyField, "1 pick"))
        let firstKey = try XCTUnwrap(questionKeys().first)
        let secondKey = try XCTUnwrap(questionKeys().last)
        element("add-note-\(firstKey)").tap()
        element("note-field-\(firstKey)").typeText("Keep Retry all out of v1.\n")
        let other = element("choice-other-\(secondKey)")
        scrollTo(other)
        other.tap()
        element("other-field-\(secondKey)").typeText("Behind a flag, on for the test account first.\n")
        XCTAssertTrue(waitForLabel(replyField, "2 picks"))
        try await control.shot("3.2")

        // 3.4A at the foot, then 3.5: the composer, the picks written in as words.
        app.swipeUp()
        try await control.shot("3.4A")
        element("reply-field").tap()
        let text = element("reply-text")
        XCTAssertTrue(text.waitForExistence(timeout: 30))
        text.typeText("Start with the test account.")
        try await control.shot("3.5")
        element("send").tap()

        // The agent's wait_for_reply gets the answer.
        let reply = try await control.post("/reply", ["thread": stopped])
        let body = try XCTUnwrap((reply["reply"] as? [String: Any])?["body"] as? String ?? reply["body"] as? String, "reply: \(reply)")
        XCTAssertTrue(body.contains("Retry with the same idempotency key"), body)
        XCTAssertTrue(body.contains("Keep Retry all out of v1."), body)
        XCTAssertTrue(body.contains("Behind a flag, on for the test account first."), body)
        XCTAssertTrue(body.contains("Start with the test account."), body)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Sent '")).firstMatch.waitForExistence(timeout: 30))
        try await control.post("/video/stop")

        // Resolve: back to the list, the thread under Quiet.
        element("thread-resolve").tap()
        let quiet = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Quiet'")).firstMatch
        XCTAssertTrue(anyRow().waitForExistence(timeout: 30))
        scrollTo(quiet) // the list draws lazily: Quiet is below the fold
        quiet.tap()
        scrollTo(stoppedRow)
        XCTAssertTrue(stoppedRow.exists)

        // Delete, from the thread's menu.
        stoppedRow.tap()
        XCTAssertTrue(element("thread-more").waitForExistence(timeout: 30))
        element("thread-more").tap()
        app.buttons["Delete Thread"].firstMatch.tap()
        app.sheets.buttons["Delete Thread"].firstMatch.tap()
        scrollTo(quiet)
        XCTAssertTrue(quiet.exists)
        XCTAssertFalse(stoppedRow.exists)

        // A note still being typed when Send is tapped rides that Send.
        try await openRow(tests)
        app.buttons["choice-Yes"].tap()
        let testsKey = try XCTUnwrap(questionKeys().first)
        element("add-note-\(testsKey)").tap()
        element("note-field-\(testsKey)").typeText("Run them after the deploy.")
        try await control.shot("note-before-send")
        element("send").tap()
        let testsReply = try await control.post("/reply", ["thread": tests])
        let testsBody = try XCTUnwrap((testsReply["reply"] as? [String: Any])?["body"] as? String, "reply: \(testsReply)")
        XCTAssertTrue(testsBody.contains("Yes"), testsBody)
        XCTAssertTrue(testsBody.contains("Run them after the deploy."), testsBody)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Sent '")).firstMatch.waitForExistence(timeout: 30))
        try await control.shot("note-after-send")
        back()

        // A Send the Inbox applies whose answer never arrives: the phone re-reads
        // the thread, shows it sent, and says nothing about trying again.
        try await openRow(refunds)
        app.buttons["choice-Trust the webhook"].tap()
        XCTAssertTrue(waitForLabel(element("reply-field"), "1 pick"))
        try await control.post("/proxy", ["mode": "drop-reply"])
        element("send").tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Sent '")).firstMatch.waitForExistence(timeout: 30))
        XCTAssertFalse(element("send-problem").exists, "a false \"Not sent\" line")
        let refundsReply = try await control.post("/reply", ["thread": refunds])
        XCTAssertTrue(((refundsReply["reply"] as? [String: Any])?["body"] as? String ?? "").contains("Trust the webhook"), "\(refundsReply)")
        let count = try await control.post("/person-replies", ["thread": refunds])
        XCTAssertEqual(count["count"] as? Int, 1, "applied once")
        try await control.shot("send-dropped-after-apply")
        back()

        // A thread deleted on the computer while it is open: drawn as gone, no controls left.
        try await openRow(keep)
        XCTAssertTrue(app.buttons["choice-Yes"].waitForExistence(timeout: 30))
        try await control.post("/delete-on-computer", ["thread": keep])
        // The Inbox writes no event for a deletion; the phone learns it at its
        // next read of the thread (here a pull, as the person would).
        pullToRefresh()
        XCTAssertTrue(element("thread-gone").waitForExistence(timeout: 30))
        XCTAssertFalse(app.buttons["choice-Yes"].exists)
        try await control.shot("thread-deleted")
        app.buttons["Back to Inbox"].firstMatch.tap()

        // A pairing link inside an agent's message is plain text: content never
        // reaches the app's URL handler, so a tap pairs nothing.
        let linkThread = try await control.post("/link-message")
        try await openRow(try XCTUnwrap(linkThread["thread"] as? String))
        let linkText = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'open the diff'")).firstMatch
        XCTAssertTrue(linkText.waitForExistence(timeout: 30))
        XCTAssertFalse(app.links["open the diff"].exists, "a plannotator:// link in content is tappable")
        linkText.tap()
        XCTAssertFalse(app.alerts.firstMatch.waitForExistence(timeout: 3))
        let devices1 = try await deviceCount()
        XCTAssertEqual(devices1, 1, "nothing redeemed")
        try await control.shot("link-in-message")
        back()

        // A link whose address carries user info (shows one host, dials
        // another) has no address the phone will contact: no Pair button.
        let hostile = try await control.post("/pair-link", ["tailnet": "macbook-pro.tail0000.ts.net:8443@evil.example"])
        try await control.post("/open-url", ["url": try XCTUnwrap(hostile["url"] as? String)])
        allowSystemOpenPrompt()
        let refused = app.alerts.matching(NSPredicate(format: "label == 'Pair with this computer?'")).firstMatch
        XCTAssertTrue(refused.waitForExistence(timeout: 30))
        XCTAssertFalse(refused.buttons["Pair"].exists, "a user-info address can be paired")
        XCTAssertTrue(refused.staticTexts.containing(NSPredicate(format: "label CONTAINS 'no address your phone can reach'")).firstMatch.exists)
        try await control.shot("pair-link-userinfo")
        refused.buttons["Cancel"].tap()

        // A pairing link opened from outside the app asks first; nothing is
        // redeemed until Pair. The name reads like an address, but the line
        // the person reads is the host the phone will dial.
        let impostor = "MacBook Pro at macbook-pro.tail0000.ts.net:8443"
        let external = try await control.post("/pair-link", ["name": impostor])
        let pairURL = try XCTUnwrap(external["url"] as? String)
        let pairAddress = try XCTUnwrap(external["address"] as? String)
        let confirm = app.alerts.matching(NSPredicate(format: "label == 'Pair with this computer?'")).firstMatch
        try await control.post("/open-url", ["url": pairURL])
        allowSystemOpenPrompt()
        XCTAssertTrue(confirm.waitForExistence(timeout: 30))
        let message = confirm.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", pairAddress)).firstMatch.label
        // The message's first line is the dialled host (VoiceOver reads a line break as a space).
        XCTAssertTrue(message.hasPrefix(pairAddress + "\n") || message.hasPrefix(pairAddress + " Named"), "the dialled host leads the message: \(message)")
        try await control.shot("pair-link-confirm")
        let devices2 = try await deviceCount()
        XCTAssertEqual(devices2, 1, "nothing redeemed")
        confirm.buttons["Cancel"].tap()
        try await Task.sleep(for: .seconds(2))
        let devices3 = try await deviceCount()
        XCTAssertEqual(devices3, 1, "nothing redeemed")
        try await control.post("/open-url", ["url": pairURL])
        allowSystemOpenPrompt()
        XCTAssertTrue(confirm.waitForExistence(timeout: 30))
        confirm.buttons["Pair"].tap()
        var paired = 1
        for _ in 0..<30 where paired == 1 {
            try await Task.sleep(for: .seconds(1))
            paired = try await deviceCount()
        }
        XCTAssertEqual(paired, 2, "Pair redeems the link")
        XCTAssertTrue(anyRow().waitForExistence(timeout: 30))

        // 9.1 and 9.2.
        tab("Settings")
        let source = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'source-'")).firstMatch
        XCTAssertTrue(source.waitForExistence(timeout: 30))
        try await control.shot("9.1")
        source.tap()
        XCTAssertTrue(element("remove-source").waitForExistence(timeout: 30))
        try await control.shot("9.2")
        app.navigationBars.buttons.element(boundBy: 0).tap() // back to Settings

        // Removed on the computer: the phone's next call is 401 device_revoked, drawn as removed.
        try await control.post("/remove-on-computer")
        tab("Inbox")
        app.swipeDown()
        let pairAgain = app.buttons["Pair Again"]
        XCTAssertTrue(pairAgain.waitForExistence(timeout: 30))
        try await control.shot("removed")

        // Pair again through the computer the phone already knows (1.3's tailnet list).
        pairAgain.tap()
        element("find-nearby").tap()
        let known = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", address)).firstMatch
        XCTAssertTrue(known.waitForExistence(timeout: 30))
        let again = try await control.post("/offer")
        known.tap()
        XCTAssertTrue(codeField.waitForExistence(timeout: 30))
        codeField.tap()
        codeField.typeText(try XCTUnwrap(again["code"] as? String))
        XCTAssertTrue(anyRow().waitForExistence(timeout: 30))

        // Remove this source (9.2): the computer no longer lists the phone.
        tab("Settings")
        source.tap()
        element("remove-source").tap()
        app.sheets.buttons["Remove This Source"].firstMatch.tap()
        XCTAssertTrue(element("add-source").waitForExistence(timeout: 30))
        XCTAssertFalse(source.exists)
        let devices = try await control.get("/devices")
        XCTAssertEqual((devices["devices"] as? [Any])?.count, 0, "\(devices)")

        tab("Inbox")
        XCTAssertTrue(element("connect-computer").waitForExistence(timeout: 30))
    }

    // MARK: Helpers of this flow

    private func deviceCount() async throws -> Int {
        (try await control.get("/devices")["devices"] as? [Any])?.count ?? -1
    }

    /// The simulator asks "Open in Plannotator?" before handing a URL to the app.
    private func allowSystemOpenPrompt() {
        let open = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Open"]
        if open.waitForExistence(timeout: 8) { open.tap() }
    }
}
