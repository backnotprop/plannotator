import XCTest

/// The M1 proof, in action against a real Inbox: run by apps/ios/scripts/proof.ts,
/// which starts the compiled Inbox, connects the agents and answers this
/// test's control calls (`PROOF_CONTROL`). Without it the test is skipped.
@MainActor
final class ProofTests: XCTestCase {
    private var app: XCUIApplication!
    private var control: Control!

    override func setUp() async throws {
        continueAfterFailure = false
        guard let base = ProcessInfo.processInfo.environment["PROOF_CONTROL"], let url = URL(string: base) else {
            throw XCTSkip("Run through apps/ios/scripts/proof.ts, which starts the Inbox this test talks to.")
        }
        control = Control(base: url)
        app = XCUIApplication()
    }

    func testPairPickSendResolveDeleteRemove() async throws {
        app.launch()

        // 1.1: nothing connected yet.
        XCTAssertTrue(element("connect-computer").waitForExistence(timeout: 10))
        try await control.shot("1.1")

        // The agents write before the phone pairs, so the list draws full.
        let seeded = try await control.post("/seed")
        let stopped = try XCTUnwrap(seeded["stopped"] as? String)

        // 1.2, then 1.3: pair by a typed address and the six digits.
        element("connect-computer").tap()
        XCTAssertTrue(element("find-nearby").waitForExistence(timeout: 5))
        try await control.shot("1.2")
        try await control.post("/video/start", ["name": "M1-pair-pick-send"])
        element("find-nearby").tap()
        let offer = try await control.post("/offer")
        let address = try XCTUnwrap(offer["address"] as? String)
        let code = try XCTUnwrap(offer["code"] as? String)
        let field = element("address-field")
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(address)
        element("address-next").tap()

        // A wrong code first: refused, with the tries left.
        let codeField = element("pairing-code")
        XCTAssertTrue(codeField.waitForExistence(timeout: 5))
        codeField.tap()
        codeField.typeText(String(code.prefix(5)) + (code.last == "9" ? "0" : "9"))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS '4 tries left'")).firstMatch.waitForExistence(timeout: 10))
        codeField.typeText(String(code.prefix(3)))
        try await control.shot("1.3")
        codeField.typeText(String(code.dropFirst(3)))

        // 2.1B: the list, drawn from the Inbox.
        let stoppedRow = element("row-\(stopped)")
        XCTAssertTrue(stoppedRow.waitForExistence(timeout: 15))
        try await control.shot("2.1B")

        // 2.3: scrolled, two new threads wait behind the pill; a tap shows them.
        app.swipeUp()
        app.swipeUp()
        try await control.post("/more")
        let pill = element("new-pill")
        XCTAssertTrue(pill.waitForExistence(timeout: 15))
        XCTAssertTrue(pill.label.contains("2 new"))
        try await control.shot("2.3")
        pill.tap()
        XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label CONTAINS 'Ship the dark ticket page'")).firstMatch.waitForExistence(timeout: 5))

        // 2.4: a row swiped shows Delete and Resolve.
        let docsRow = app.buttons.containing(NSPredicate(format: "label CONTAINS 'Is this the install flow'")).firstMatch
        XCTAssertTrue(docsRow.waitForExistence(timeout: 5))
        docsRow.swipeLeft()
        XCTAssertTrue(app.buttons["Resolve"].waitForExistence(timeout: 5))
        try await control.shot("2.4")
        app.buttons["Resolve"].tap()

        // 3.1: the thread at rest.
        stoppedRow.tap()
        let first = app.buttons["choice-Retry with the same idempotency key"]
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        try await control.shot("3.1")

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
        XCTAssertTrue(text.waitForExistence(timeout: 5))
        text.typeText("Start with the test account.")
        try await control.shot("3.5")
        element("send").tap()

        // The agent's wait_for_reply gets the answer.
        let reply = try await control.get("/reply")
        let body = try XCTUnwrap((reply["reply"] as? [String: Any])?["body"] as? String ?? reply["body"] as? String, "reply: \(reply)")
        XCTAssertTrue(body.contains("Retry with the same idempotency key"), body)
        XCTAssertTrue(body.contains("Keep Retry all out of v1."), body)
        XCTAssertTrue(body.contains("Behind a flag, on for the test account first."), body)
        XCTAssertTrue(body.contains("Start with the test account."), body)
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Sent '")).firstMatch.waitForExistence(timeout: 10))
        try await control.post("/video/stop")

        // Resolve: back to the list, the thread under Quiet.
        element("thread-resolve").tap()
        let quiet = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Quiet'")).firstMatch
        XCTAssertTrue(anyRow().waitForExistence(timeout: 10))
        scrollTo(quiet) // the list draws lazily: Quiet is below the fold
        quiet.tap()
        scrollTo(stoppedRow)
        XCTAssertTrue(stoppedRow.exists)

        // Delete, from the thread's menu.
        stoppedRow.tap()
        XCTAssertTrue(element("thread-more").waitForExistence(timeout: 10))
        element("thread-more").tap()
        app.buttons["Delete Thread"].firstMatch.tap()
        app.sheets.buttons["Delete Thread"].firstMatch.tap()
        scrollTo(quiet)
        XCTAssertTrue(quiet.exists)
        XCTAssertFalse(stoppedRow.exists)

        // 9.1 and 9.2.
        tab("Settings")
        let source = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'source-'")).firstMatch
        XCTAssertTrue(source.waitForExistence(timeout: 5))
        try await control.shot("9.1")
        source.tap()
        XCTAssertTrue(element("remove-source").waitForExistence(timeout: 5))
        try await control.shot("9.2")
        app.navigationBars.buttons.element(boundBy: 0).tap() // back to Settings

        // Removed on the computer: the phone's next call is 401 device_revoked, drawn as removed.
        try await control.post("/remove-on-computer")
        tab("Inbox")
        app.swipeDown()
        let pairAgain = app.buttons["Pair Again"]
        XCTAssertTrue(pairAgain.waitForExistence(timeout: 15))
        try await control.shot("removed")

        // Pair again through the computer the phone already knows (1.3's tailnet list).
        pairAgain.tap()
        element("find-nearby").tap()
        let known = app.buttons.containing(NSPredicate(format: "label CONTAINS %@", address)).firstMatch
        XCTAssertTrue(known.waitForExistence(timeout: 5))
        let again = try await control.post("/offer")
        known.tap()
        XCTAssertTrue(codeField.waitForExistence(timeout: 5))
        codeField.tap()
        codeField.typeText(try XCTUnwrap(again["code"] as? String))
        XCTAssertTrue(anyRow().waitForExistence(timeout: 15))

        // Remove this source (9.2): the computer no longer lists the phone.
        tab("Settings")
        source.tap()
        element("remove-source").tap()
        app.sheets.buttons["Remove This Source"].firstMatch.tap()
        XCTAssertTrue(element("add-source").waitForExistence(timeout: 10))
        XCTAssertFalse(source.exists)
        let devices = try await control.get("/devices")
        XCTAssertEqual((devices["devices"] as? [Any])?.count, 0, "\(devices)")

        tab("Inbox")
        XCTAssertTrue(element("connect-computer").waitForExistence(timeout: 5))
    }

    // MARK: Helpers

    private func element(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    /// The tab bar minimizes on scroll (iOS 26); scrolling back up brings its items back.
    private func tab(_ name: String) {
        let button = app.tabBars.buttons[name]
        var tries = 0
        while !button.exists, tries < 4 {
            app.swipeDown(velocity: .fast)
            tries += 1
        }
        button.tap()
    }

    private func anyRow() -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'row-'")).firstMatch
    }

    private func questionKeys() -> [String] {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'question-'")).allElementsBoundByIndex
            .map { String($0.identifier.dropFirst("question-".count)) }
    }

    private func scrollTo(_ target: XCUIElement) {
        var tries = 0
        while !(target.exists && target.isHittable), tries < 8 {
            app.swipeUp(velocity: .slow)
            tries += 1
        }
    }

    private func waitForLabel(_ target: XCUIElement, _ text: String) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", text), object: target)
        return XCTWaiter().wait(for: [expectation], timeout: 5) == .completed
    }
}

/// The proof script's loopback control server.
struct Control {
    let base: URL

    @discardableResult
    func post(_ path: String, _ body: [String: String] = [:]) async throws -> [String: Any] {
        var request = URLRequest(url: base.appending(path: path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(request)
    }

    func get(_ path: String) async throws -> [String: Any] {
        try await send(URLRequest(url: base.appending(path: path)))
    }

    func shot(_ name: String) async throws {
        try await Task.sleep(for: .milliseconds(700)) // let motion settle
        try await post("/shot", ["name": name])
    }

    private func send(_ request: URLRequest) async throws -> [String: Any] {
        var request = request
        request.timeoutInterval = 120
        let (data, response) = try await URLSession.shared.data(for: request)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw NSError(domain: "Control", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(request.url!.path): \(json)"])
        }
        return json
    }
}
