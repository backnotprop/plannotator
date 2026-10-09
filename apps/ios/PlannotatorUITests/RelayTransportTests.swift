import XCTest

/// The M6 proof, in action: 9.2's three paths against the compiled Inbox,
/// its Wi-Fi listener (dialled at loopback, its certificate pinned), the
/// tailnet's stand-in (apps/ios/scripts/proof.ts's proxy, which the test can
/// take down), and the relay under `wrangler dev` behind a proxy that keeps
/// what the phone posts. Runs after the M1 and M5 flows (class order), from a
/// phone with no source.
@MainActor
final class RelayTransportTests: XCTestCase {
    private var app: XCUIApplication!
    private var control: Control!
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")

    override func setUp() async throws {
        continueAfterFailure = false
        guard let base = ProcessInfo.processInfo.environment["PROOF_CONTROL"], let url = URL(string: base) else {
            throw XCTSkip("Run through apps/ios/scripts/proof.ts, which starts the Inbox and the relay this test talks to.")
        }
        control = Control(base: url)
        app = XCUIApplication()
    }

    func testTheRelayAsTheFallbackPath() async throws {
        app.launch()
        try await unpaired()
        try await control.post("/lan", ["on": "1"])

        // A code whose pin is not the listener's certificate, with no other
        // address: the phone refuses the listener and pairs with nothing.
        let wrong = try await control.post("/pair-link-lan", ["wrong": "1"])
        let lanAddress = try XCTUnwrap(wrong["lan"] as? String)
        try await control.post("/open-url", ["url": try XCTUnwrap(wrong["url"] as? String)])
        allowSystemOpenPrompt()
        let confirm = app.alerts.matching(NSPredicate(format: "label == 'Pair with this computer?'")).firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 30))
        XCTAssertTrue(confirm.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", lanAddress)).firstMatch.exists)
        confirm.buttons["Pair"].tap()
        let notPaired = app.alerts["Not paired"]
        XCTAssertTrue(notPaired.waitForExistence(timeout: 30))
        notPaired.buttons["OK"].tap()
        let none = try await deviceCount()
        XCTAssertEqual(none, 0, "a wrong pin paired")

        // The QR's link: over the Wi-Fi first, the certificate pinned to its
        // fingerprint; the redemption carries the relay.
        let link = try await control.post("/pair-link-lan")
        try await control.post("/open-url", ["url": try XCTUnwrap(link["url"] as? String)])
        allowSystemOpenPrompt()
        XCTAssertTrue(confirm.waitForExistence(timeout: 30))
        // Both addresses it will contact, in order, before the name.
        XCTAssertTrue(confirm.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "\(lanAddress)\n\(try XCTUnwrap(link["tailnet"] as? String))")).firstMatch.exists
            || confirm.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "\(lanAddress) ")).firstMatch.exists)
        confirm.buttons["Pair"].tap()
        XCTAssertTrue(listOrEmpty().waitForExistence(timeout: 30))
        let one = try await deviceCount()
        XCTAssertEqual(one, 1)

        // 9.2 on the Wi-Fi. The relay switch is on from pairing, notifications allowed or not.
        tab("Settings")
        let allow = element("allow-notifications")
        XCTAssertTrue(allow.waitForExistence(timeout: 30))
        let allowedBefore = allow.value as? String
        openSource()
        XCTAssertTrue(waitForLabel(element("path-status"), "Connected over Wi-Fi"))
        XCTAssertTrue(element("path-wifi").label.contains("In use"), element("path-wifi").label)
        let relaySwitch = element("relay-switch")
        XCTAssertEqual(relaySwitch.value as? String, "1", "the relay is on from pairing")
        try await control.shot("9.2-wifi")
        back()
        if allowedBefore != "1" {
            allow.switches.firstMatch.tap()
            let systemAllow = springboard.buttons["Allow"]
            if systemAllow.waitForExistence(timeout: 10) { systemAllow.tap() }
            XCTAssertTrue(waitForValue(allow, "1"))
        }
        openSource()
        XCTAssertEqual(relaySwitch.value as? String, "1", "allowing notifications changed the relay switch")
        back()
        // A CI runner's simulator gets no APNs token: the script registers a
        // stand-in at the relay the way the phone would (as M5's flow does), so
        // the pushes this flow hands to `simctl push` still go out. Where the
        // simulator has its own token, the stand-in only replaces it.
        let standIn = try await control.post("/relay-token-stand-in")
        XCTAssertEqual(standIn["registered"] as? Int, 1, "\(standIn)")

        // The Wi-Fi listener off on the computer: the tailnet.
        try await control.post("/lan", ["on": "0"])
        tab("Inbox")
        pullToRefresh()
        tab("Settings")
        openSource()
        XCTAssertTrue(waitForLabel(element("path-tailnet"), "In use"))
        XCTAssertTrue(element("path-wifi").label.contains("Not on it now"), element("path-wifi").label)
        try await control.shot("9.2-tailnet")
        back()

        // The tailnet down too: the relay, and the app says so.
        try await control.post("/proxy", ["mode": "gone"])
        tab("Inbox")
        pullToRefresh()
        XCTAssertTrue(text(containing: "Through the relay").waitForExistence(timeout: 30))
        tab("Settings")
        openSource()
        XCTAssertTrue(waitForLabel(element("path-status"), "Connected through the relay"))
        try await control.shot("9.2-relay")
        back()
        tab("Inbox")

        // An agent asks while the phone is on the relay: the list and the
        // thread come down through it, the pick and the Send go up through it,
        // and the agent's wait_for_reply gets the answer.
        let before = try await control.get("/hits")
        let asked = try await control.post("/ask")
        let thread = try XCTUnwrap(asked["thread"] as? String)
        pullToRefresh()
        let row = element("row-\(thread)")
        XCTAssertTrue(row.waitForExistence(timeout: 30))
        try await control.shot("relay-list")
        row.tap()
        let yes = app.buttons["choice-Yes"]
        XCTAssertTrue(yes.waitForExistence(timeout: 30))
        yes.tap()
        XCTAssertTrue(waitForLabel(element("reply-field"), "1 pick"))
        element("send").tap()
        let reply = try await control.post("/reply", ["thread": thread])
        XCTAssertTrue("\(reply)".contains("Yes"), "\(reply)")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Sent '")).firstMatch.waitForExistence(timeout: 30))
        let after = try await control.get("/hits")
        XCTAssertEqual(after["door_replies"] as? Int, before["door_replies"] as? Int, "the Send went to the door directly")
        XCTAssertGreaterThan(after["relay_commands"] as? Int ?? 0, before["relay_commands"] as? Int ?? 0)
        try await control.shot("relay-thread-sent")

        // Every command the phone posted (the pick and the Send among them)
        // posted again after the Inbox applied them: the relay holds each once
        // more, the Inbox answers each from the door's log, and nothing is written.
        let cursorBefore = try await control.post("/store-cursor")["cursor"] as? Int
        let replay = try await control.post("/replay-commands")
        XCTAssertGreaterThanOrEqual(replay["held"] as? Int ?? 0, 2, "\(replay)")
        try await Task.sleep(for: .seconds(6))
        let replies = try await control.post("/person-replies", ["thread": thread])
        XCTAssertEqual(replies["count"] as? Int, 1, "a replayed command wrote a reply")
        let cursorAfter = try await control.post("/store-cursor")["cursor"] as? Int
        XCTAssertEqual(cursorAfter, cursorBefore, "a replayed command wrote a store line")
        back()

        // Mid-draft, the tailnet comes back: a push makes the app read again,
        // it moves to the tailnet, and the words being typed are still there.
        // The push is the shape a phone shows, dressed by the notification
        // service extension (the summary in place of the envelope): the
        // simulator never runs the extension, so the proof hands it over dressed.
        let ship = try await control.post("/ask", ["kind": "ship", "agent": "Codex", "host": "codex"])
        let shipThread = try XCTUnwrap(ship["thread"] as? String)
        pullToRefresh()
        try await openRow(shipThread)
        XCTAssertTrue(app.buttons["choice-Yes"].waitForExistence(timeout: 30))
        element("reply-field").tap()
        let words = element("reply-text")
        XCTAssertTrue(words.waitForExistence(timeout: 30))
        words.typeText("Behind the flag first.")
        let doorBefore = try await control.get("/hits")["door_requests"] as? Int ?? 0
        try await control.post("/proxy", ["mode": "pass"])
        try await control.post("/push-dressed", ["thread": shipThread])
        _ = try await until("the app back on the tailnet") { () async throws -> Bool? in
            (try await self.control.get("/hits")["door_requests"] as? Int ?? 0) > doorBefore + 1 ? true : nil
        }
        try await Task.sleep(for: .seconds(2))
        XCTAssertEqual(words.value as? String, "Behind the flag first.", "the draft survived the change of path")
        try await control.shot("draft-kept-tailnet")
        let directBefore = try await control.get("/hits")["door_replies"] as? Int ?? 0
        element("send").tap()
        let shipReply = try await control.post("/reply", ["thread": shipThread])
        XCTAssertTrue("\(shipReply)".contains("Behind the flag first."), "\(shipReply)")
        let directAfter = try await control.get("/hits")["door_replies"] as? Int ?? 0
        XCTAssertEqual(directAfter, directBefore + 1, "the Send went over the tailnet")
        back()

        // Mid-draft the other way: a note being typed, the tailnet drops (its
        // event stream ends), the app moves to the relay, and the note rides the Send.
        let note = try await control.post("/ask")
        let noteThread = try XCTUnwrap(note["thread"] as? String)
        pullToRefresh()
        try await openRow(noteThread)
        app.buttons["choice-Yes"].tap()
        let key = try XCTUnwrap(questionKeys().first)
        element("add-note-\(key)").tap()
        let noteField = element("note-field-\(key)")
        noteField.typeText("After the deploy.")
        let readsBefore = try await control.get("/hits")["relay_reads"] as? Int ?? 0
        try await control.post("/proxy", ["mode": "gone"])
        _ = try await until("the app on the relay") { () async throws -> Bool? in
            (try await self.control.get("/hits")["relay_reads"] as? Int ?? 0) > readsBefore ? true : nil
        }
        try await Task.sleep(for: .seconds(2))
        XCTAssertEqual(noteField.value as? String, "After the deploy.", "the note survived the change of path")
        try await control.shot("draft-kept-relay")
        let commandsBefore = try await control.get("/hits")["relay_commands"] as? Int ?? 0
        element("send").tap()
        let noteReply = try await control.post("/reply", ["thread": noteThread])
        XCTAssertTrue("\(noteReply)".contains("After the deploy."), "\(noteReply)")
        let commandsAfter = try await control.get("/hits")["relay_commands"] as? Int ?? 0
        XCTAssertGreaterThan(commandsAfter, commandsBefore, "the Send went up through the relay")
        back()

        // The Inbox stopped: a Send and a lock-screen answer wait at the relay,
        // the thread says "Sent. Waiting for your computer", and both reach the
        // agents once when the Inbox starts again.
        let held = try await control.post("/ask")
        let heldThread = try XCTUnwrap(held["thread"] as? String)
        let locked = try await control.post("/ask", ["kind": "ship", "agent": "Codex", "host": "codex"])
        let lockedThread = try XCTUnwrap(locked["thread"] as? String)
        pullToRefresh()
        try await openRow(heldThread)
        XCTAssertTrue(app.buttons["choice-Yes"].waitForExistence(timeout: 30))
        back()
        try await control.post("/inbox-stop")
        try await control.post("/video/start", ["name": "M6-relay-waiting"])
        try await openRow(heldThread)
        app.buttons["choice-Yes"].tap()
        XCTAssertTrue(waitForLabel(element("reply-field"), "1 pick"))
        element("send").tap()
        let waiting = element("send-waiting")
        XCTAssertTrue(waiting.waitForExistence(timeout: 30))
        XCTAssertTrue(waiting.label.contains("Sent. Waiting for your computer"), waiting.label)
        try await control.shot("thread-waiting")
        back()
        XCTAssertTrue(text(containing: "Waiting for your computer").waitForExistence(timeout: 30))
        tab("Settings")
        openSource()
        XCTAssertTrue(waitForLabel(element("path-status"), "Waiting for your computer"))
        try await control.shot("9.2-waiting")
        back()
        tab("Inbox")
        try await control.post("/push", ["thread": lockedThread])
        let banner = notification(containing: "Ship the dark ticket page")
        XCTAssertTrue(banner.waitForExistence(timeout: 30))
        banner.press(forDuration: 1.2)
        XCTAssertTrue(springboard.buttons["Yes"].waitForExistence(timeout: 30))
        springboard.buttons["Yes"].tap()
        XCTAssertTrue(notification(containing: "sent. Waiting for your computer").waitForExistence(timeout: 30))
        try await control.shot("lock-screen-waiting")
        try await control.post("/inbox-start")
        let heldReply = try await control.post("/reply", ["thread": heldThread])
        XCTAssertTrue("\(heldReply)".contains("Yes"), "\(heldReply)")
        let lockedReply = try await control.post("/reply", ["thread": lockedThread])
        XCTAssertTrue("\(lockedReply)".contains("Yes"), "\(lockedReply)")
        for id in [heldThread, lockedThread] {
            let count = try await control.post("/person-replies", ["thread": id])
            XCTAssertEqual(count["count"] as? Int, 1, "applied once: \(id)")
        }
        // The phone hears it at its next read (a pull here): the thread shows it sent.
        try await openRow(heldThread)
        for _ in 0..<3 where waiting.exists {
            pullToRefresh()
            try await Task.sleep(for: .seconds(2))
        }
        XCTAssertFalse(waiting.exists, "still waiting after the Inbox applied it")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Sent '")).firstMatch.waitForExistence(timeout: 30))
        try await control.shot("thread-landed")
        try await control.post("/video/stop")
        back()

        // A held Send the computer refuses (its question picked twice on the
        // computer before the held commands reach it), seen back on the
        // tailnet: the thread says it was not sent, in the person's words, and
        // no longer that it waits.
        let refused = try await control.post("/ask")
        let refusedThread = try XCTUnwrap(refused["thread"] as? String)
        pullToRefresh()
        try await openRow(refusedThread)
        XCTAssertTrue(app.buttons["choice-Yes"].waitForExistence(timeout: 30))
        back()
        try await control.post("/inbox-stop")
        try await openRow(refusedThread)
        app.buttons["choice-Yes"].tap()
        XCTAssertTrue(waitForLabel(element("reply-field"), "1 pick"))
        element("send").tap()
        XCTAssertTrue(waiting.waitForExistence(timeout: 30))
        back()
        let applied = try await control.post("/relay-socket", ["blocked": "1"])["applied"] as? Int ?? 0
        try await control.post("/inbox-start")
        try await control.post("/window-pick", ["thread": refusedThread])
        try await control.post("/window-pick", ["thread": refusedThread])
        try await control.post("/relay-socket", ["blocked": "0"])
        for _ in 0..<180 {
            if (try await control.get("/hits")["applied"] as? Int ?? 0) >= applied + 2 { break }
            try await Task.sleep(for: .milliseconds(500))
        }
        let appliedNow = try await control.get("/hits")["applied"] as? Int ?? 0
        XCTAssertGreaterThanOrEqual(appliedNow, applied + 2, "the held pick and Send were not applied")
        try await control.post("/proxy", ["mode": "pass"])
        try await openRow(refusedThread)
        pullToRefresh()
        let notSent = element("send-problem")
        XCTAssertTrue(notSent.waitForExistence(timeout: 30))
        XCTAssertTrue(notSent.label.contains("Not sent. That question changed on your computer."), notSent.label)
        XCTAssertFalse(notSent.label.contains("q-"), "the door's own words: \(notSent.label)")
        XCTAssertFalse(waiting.exists, "still waiting after the computer refused it")
        let refusedReplies = try await control.post("/person-replies", ["thread": refusedThread])
        XCTAssertEqual(refusedReplies["count"] as? Int, 0)
        try await control.shot("held-refused-tailnet")
        back()
        try await control.post("/proxy", ["mode": "gone"])

        // A store line too large for the relay (a 25 MiB reply written on the
        // computer): the thread draws the words.
        let large = try await control.post("/ask")
        let largeThread = try XCTUnwrap(large["thread"] as? String)
        pullToRefresh()
        try await openRow(largeThread)
        XCTAssertTrue(app.buttons["choice-Yes"].waitForExistence(timeout: 30))
        try await control.post("/too-large", ["thread": largeThread])
        let tooLarge = element("too-large")
        for _ in 0..<3 where !tooLarge.exists {
            pullToRefresh()
            _ = tooLarge.waitForExistence(timeout: 20)
        }
        XCTAssertTrue(tooLarge.exists)
        XCTAssertTrue(tooLarge.label.contains("Too large to show here"), tooLarge.label)
        XCTAssertEqual(app.descendants(matching: .any).matching(identifier: "too-large").count, 1, "drawn once")
        try await control.shot("too-large")
        back()

        // The relay switch off: nothing more comes down, and the app says so.
        tab("Settings")
        openSource()
        relaySwitch.switches.firstMatch.tap()
        XCTAssertTrue(waitForValue(relaySwitch, "0"))
        XCTAssertTrue(waitForLabel(element("path-status"), "The relay is off"))
        try await control.shot("9.2-relay-off")
        back()
        tab("Inbox")
        let quiet = try await control.post("/ask", ["nopush": "1"])
        let quietThread = try XCTUnwrap(quiet["thread"] as? String)
        XCTAssertEqual(quiet["pushed"] as? Bool, false, "a push went out with the relay off")
        pullToRefresh()
        XCTAssertTrue(text(containing: "relay off").waitForExistence(timeout: 30))
        XCTAssertFalse(element("row-\(quietThread)").waitForExistence(timeout: 5), "a thread arrived with the relay off")
        let items = try await control.get("/relay-items")["items"] as? Int
        XCTAssertEqual(items, 0, "the relay holds items for a phone whose switch is off")
        try await control.shot("relay-off-list")

        // Leave the phone with no source, as it came.
        try await control.post("/proxy", ["mode": "pass"])
        try await removeSources()
    }

    // MARK: Helpers

    private func element(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func text(containing words: String) -> XCUIElement {
        app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
    }

    private func notification(containing words: String) -> XCUIElement {
        springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", words)).firstMatch
    }

    private func listOrEmpty() -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'row-' OR label == 'Nothing waiting'")).firstMatch
    }

    private func deviceCount() async throws -> Int {
        (try await control.get("/devices")["devices"] as? [Any])?.count ?? -1
    }

    private func openSource() {
        let source = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'source-dev'")).firstMatch
        XCTAssertTrue(source.waitForExistence(timeout: 30))
        source.tap()
        XCTAssertTrue(app.reveal("remove-source").exists)
    }

    /// Back one screen. Right after a Send the keyboard is still leaving and a
    /// first tap can land on it: from a thread, tap again until the reply bar is gone.
    private func back() {
        let inThread = element("send").exists
        app.navigationBars.buttons.element(boundBy: 0).tap()
        for _ in 0..<3 where inThread && element("send").waitForExistence(timeout: 2) {
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
    }

    private func pullToRefresh() {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        start.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9)))
        sleep(2)
    }

    /// Opens a list row: from the top, scrolling down to it (the list draws
    /// lazily), with one pull to refresh if a shared runner was slow to read it.
    private func openRow(_ thread: String) async throws {
        let row = element("row-\(thread)")
        for attempt in 0..<2 {
            for _ in 0..<3 { app.swipeDown(velocity: .fast) }
            // A thread that arrived while the list counted as scrolled waits behind the "N new" pill (2.3).
            if element("new-pill").exists { element("new-pill").tap() }
            _ = row.waitForExistence(timeout: 10)
            var tries = 0
            while !(row.exists && row.isHittable), tries < 8 {
                app.swipeUp(velocity: .slow)
                tries += 1
            }
            if row.exists && row.isHittable { break }
            if attempt == 0 {
                for _ in 0..<3 { app.swipeDown(velocity: .fast) }
                pullToRefresh()
            }
        }
        if !row.exists { try await control.shot("row-missing") }
        XCTAssertTrue(row.exists, "row \(thread)")
        row.tap()
    }

    private func questionKeys() -> [String] {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'question-'")).allElementsBoundByIndex
            .map { String($0.identifier.dropFirst("question-".count)) }
    }

    private func allowSystemOpenPrompt() {
        let open = springboard.buttons["Open"]
        if open.waitForExistence(timeout: 8) { open.tap() }
    }

    private func waitForLabel(_ target: XCUIElement, _ text: String) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", text), object: target)
        return XCTWaiter().wait(for: [expectation], timeout: 30) == .completed
    }

    private func waitForValue(_ target: XCUIElement, _ value: String) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: target)
        return XCTWaiter().wait(for: [expectation], timeout: 30) == .completed
    }

    private func until<T>(_ what: String, _ read: () async throws -> T?) async throws -> T {
        for _ in 0..<60 {
            if let value = try await read() { return value }
            try await Task.sleep(for: .milliseconds(500))
        }
        throw NSError(domain: "RelayTransportTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "timed out waiting for \(what)"])
    }

    private func tab(_ name: String) {
        let button = app.tabBars.buttons[name]
        var tries = 0
        while !button.exists, tries < 4 {
            app.swipeDown(velocity: .fast)
            tries += 1
        }
        button.tap()
    }

    private func unpaired() async throws {
        if element("connect-computer").waitForExistence(timeout: 10) { return }
        try await removeSources()
        XCTAssertTrue(element("connect-computer").waitForExistence(timeout: 30))
    }

    private func removeSources() async throws {
        for _ in 0..<3 where !app.tabBars.buttons["Settings"].exists && app.navigationBars.buttons.firstMatch.exists {
            back()
        }
        tab("Settings")
        while true {
            let source = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'source-dev'")).firstMatch
            guard source.waitForExistence(timeout: 5) else { break }
            source.tap()
            app.reveal("remove-source").tap()
            app.sheets.buttons["Remove This Source"].firstMatch.tap()
            let anyway = app.alerts.buttons["Remove Anyway"]
            if anyway.waitForExistence(timeout: 5) { anyway.tap() }
            XCTAssertTrue(element("add-source").waitForExistence(timeout: 30))
        }
        tab("Inbox")
    }
}
