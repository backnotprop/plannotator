import XCTest

/// The M7 proof, in action against Workspaces (staging) and a real local Inbox:
/// run by apps/ios/scripts/workspaces-proof.ts, which starts the Inbox, holds
/// the test account and the agent's key, and answers this test's control
/// calls (`WORKSPACES_PROOF_CONTROL`). Without it the test is skipped.
@MainActor
final class WorkspacesProofTests: XCTestCase {
    private var app: XCUIApplication!
    private var control: Control!

    override func setUp() async throws {
        continueAfterFailure = false
        guard let base = ProcessInfo.processInfo.environment["WORKSPACES_PROOF_CONTROL"], let url = URL(string: base) else {
            throw XCTSkip("Run through apps/ios/scripts/workspaces-proof.ts, which holds the Workspaces test account.")
        }
        control = Control(base: url)
        app = XCUIApplication()
    }

    func testSignInSwitchPickSendDecideLiveSignOut() async throws {
        app.launch()

        // 1.1 with both ways in.
        XCTAssertTrue(element("connect-workspaces").waitForExistence(timeout: 30))
        try await control.shot("1.1")

        // A forged return link, with no sign-in started: dropped, nothing happens.
        try await control.post("/open-url", ["url": "plannotator://signin?state=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&ticket=forged"])
        allowSystemOpenPrompt()
        XCTAssertFalse(app.alerts.firstMatch.waitForExistence(timeout: 4), "a forged return raised something")
        XCTAssertTrue(element("connect-workspaces").exists)
        try await control.shot("forged-return-dropped")

        // The computer's Inbox first, by typed address and code (M1's path).
        element("connect-computer").tap()
        element("find-nearby").tap()
        let offer = try await control.post("/offer")
        let field = element("address-field")
        XCTAssertTrue(field.waitForExistence(timeout: 30))
        field.tap()
        field.typeText(try XCTUnwrap(offer["address"] as? String))
        element("address-next").tap()
        let code = element("pairing-code")
        XCTAssertTrue(code.waitForExistence(timeout: 30))
        code.tap()
        code.typeText(try XCTUnwrap(offer["code"] as? String))
        XCTAssertTrue(anyRow().waitForExistence(timeout: 30))

        // 1.4: Add a source, Workspaces: the real AuthKit page in the system sheet.
        tab("Settings")
        element("add-source").tap()
        app.buttons["Workspaces"].firstMatch.tap()
        try await control.post("/video/start", ["name": "M7-sign-in-pick-send"])
        let web = authPage()
        let email = web.textFields.firstMatch
        XCTAssertTrue(email.waitForExistence(timeout: 60), "the AuthKit page did not show")
        try await control.shot("1.4")
        email.tap()
        let address = try await control.get("/email")["email"] as? String
        email.typeText(try XCTUnwrap(address) + "\n")
        let secret = web.secureTextFields.firstMatch
        XCTAssertTrue(secret.waitForExistence(timeout: 60), "no password step")
        // Pasted, never typed: XCTest writes typed text into its log.
        try await control.post("/password-to-pasteboard")
        secret.tap()
        try await Task.sleep(for: .seconds(1))
        secret.tap() // a second tap on the focused field shows the edit menu
        let paste = app.menuItems["Paste"].exists ? app.menuItems["Paste"] : app.descendants(matching: .any).matching(NSPredicate(format: "label == 'Paste'")).firstMatch
        XCTAssertTrue(paste.waitForExistence(timeout: 10), "no Paste in the edit menu")
        paste.tap()
        try await control.post("/clear-pasteboard")
        secret.typeText("\n")

        // Back in the app, signed in: Settings lists both sources (9.1).
        let workspacesRow = element("source-workspaces")
        XCTAssertTrue(workspacesRow.waitForExistence(timeout: 90), "not signed in")
        try await control.shot("9.1")

        // The list is Workspaces' now; an agent asks, and the row lands live (by ticket, no pull).
        tab("Inbox")
        XCTAssertTrue(app.navigationBars.staticTexts["Workspaces"].waitForExistence(timeout: 30) || app.staticTexts["Workspaces"].waitForExistence(timeout: 5))
        let asked = try await control.post("/ask")
        let thread = try XCTUnwrap(asked["thread"] as? String)
        let row = element("row-\(thread)")
        XCTAssertTrue(row.waitForExistence(timeout: 45), "the new row did not arrive live")
        try await control.shot("2.1B-workspaces")

        // 1.5A: the switcher with both sources and what waits in each.
        switcher().tap()
        let remote = app.collectionViews.buttons["Workspaces"]
        XCTAssertTrue(remote.waitForExistence(timeout: 30), "Workspaces in the switcher")
        try await control.shot("1.5A")
        print("MENU \(app.collectionViews.element(boundBy: app.collectionViews.count - 1).debugDescription)")
        let local = app.collectionViews.buttons.containing(.image, identifier: "laptopcomputer").firstMatch
        XCTAssertNotEqual(local.label, remote.label)
        XCTAssertTrue(remote.isSelected, "Workspaces is the source shown")
        // One source at a time: the computer, then back to Workspaces.
        local.tap()
        XCTAssertTrue(app.buttons.containing(NSPredicate(format: "label CONTAINS 'Which way should the worker go'")).firstMatch.waitForExistence(timeout: 30))
        switcher().tap()
        XCTAssertTrue(app.collectionViews.buttons["Workspaces"].waitForExistence(timeout: 30))
        app.collectionViews.buttons["Workspaces"].tap()
        XCTAssertTrue(row.waitForExistence(timeout: 30))

        // The thread: the document row, the cards; a pick on each, the decision tick, words, Send.
        row.tap()
        let yes = app.buttons["choice-Yes"].firstMatch
        XCTAssertTrue(yes.waitForExistence(timeout: 30))
        XCTAssertTrue(element("document-row").exists)
        try await control.shot("3.1-workspaces")
        let keys = questionKeys()
        XCTAssertEqual(keys.count, 2)
        let first = try XCTUnwrap(keys.first)
        yes.tap()
        XCTAssertTrue(waitForLabel(element("reply-field"), "1 pick"))
        element("decision-\(first)").tap()
        let flag = app.buttons.matching(identifier: "choice-Yes").element(boundBy: 1)
        scrollTo(flag)
        flag.tap()
        XCTAssertTrue(waitForLabel(element("reply-field"), "2 picks"))
        try await control.shot("3.2-workspaces")
        element("reply-field").tap()
        let text = element("reply-text")
        XCTAssertTrue(text.waitForExistence(timeout: 30))
        text.typeText("Go ahead.")
        element("send").tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH 'Sent '")).firstMatch.waitForExistence(timeout: 30))
        try await control.shot("sent-workspaces")
        try await control.post("/video/stop")

        // The agent reads the reply through list_annotations; the tick recorded a decision.
        let annotation = String(thread.split(separator: "/").last ?? "")
        let answers = try await control.post("/answers", ["annotation": annotation])
        let reply = try XCTUnwrap(answers["reply"] as? String, "\(answers)")
        XCTAssertTrue(reply.contains("Go ahead."), reply)
        XCTAssertTrue(reply.contains("Answer: Yes"), reply)
        let questions = try XCTUnwrap(answers["questions"] as? [[String: Any]])
        XCTAssertEqual(questions.compactMap { $0["state"] as? String }, ["sent", "sent"])
        XCTAssertNotNil(questions.first?["decision_id"] as? String, "the tick recorded no decision")
        let decisions = try await control.post("/decisions")
        XCTAssertEqual((decisions["decisions"] as? [Any])?.count, 1, "\(decisions)")

        // The document's text, natively.
        element("document-row").tap()
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Ship behind the'")).firstMatch.waitForExistence(timeout: 30))
        try await control.shot("document")
        back()
        back()

        // The largest Dynamic Type size on the Workspaces list.
        try await control.post("/text-size", ["size": "accessibility-extra-extra-extra-large"])
        try await control.shot("ax-list-workspaces")
        try await control.post("/text-size", ["size": "large"])

        // Sign out (Settings, Workspaces): the app forgets the session and the
        // door ends it at Workspaces, so the cookie the app held answers 401.
        XCUIDevice.shared.press(.home) // the cookie store writes its file in the background
        let held = try await control.post("/hold-session")
        app.activate()
        XCTAssertEqual(held["held"] as? Bool, true, "no session cookie in the app's store")
        let before = try await control.post("/held-session")
        XCTAssertEqual(before["status"] as? Int, 200)
        tab("Settings")
        workspacesRow.tap()
        element("sign-out").tap()
        app.sheets.buttons["Sign Out"].firstMatch.tap()
        XCTAssertTrue(element("add-source").waitForExistence(timeout: 30))
        XCTAssertFalse(element("source-workspaces").exists)
        try await control.shot("signed-out")
        XCUIDevice.shared.press(.home)
        let gone = try await control.post("/app-session-gone")
        app.activate()
        XCTAssertEqual(gone["gone"] as? Bool, true, "the app still holds the session cookie")
        // Workspaces checks a session's access token without calling WorkOS, so the
        // revoked session's cookie answers until that token expires (about five
        // minutes, measured on staging), then 401.
        let signedOutAt = Date.now
        var status = 200
        while status == 200, Date.now.timeIntervalSince(signedOutAt) < 420 {
            try await Task.sleep(for: .seconds(15))
            status = try await control.post("/held-session")["status"] as? Int ?? 0
        }
        XCTAssertEqual(status, 401, "the session still answers after sign-out")
        print("SIGNED-OUT 401 after \(Int(Date.now.timeIntervalSince(signedOutAt))) s")
    }

    // MARK: Helpers

    private func element(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    /// The system sign-in sheet's web content: in the app's tree, or in the
    /// Safari view service that hosts it.
    private func authPage() -> XCUIElement {
        let own = app.webViews.firstMatch
        if own.waitForExistence(timeout: 20) { return own }
        return XCUIApplication(bundleIdentifier: "com.apple.SafariViewService").webViews.firstMatch
    }

    private func allowSystemOpenPrompt() {
        let open = XCUIApplication(bundleIdentifier: "com.apple.springboard").buttons["Open"]
        if open.waitForExistence(timeout: 8) { open.tap() }
    }

    /// The title's menu (1.5A), on the inline title. iOS 26 draws its chevron on the inline title,
    /// so the list is scrolled a little until the large title folds into the bar.
    private func switcher() -> XCUIElement {
        let bar = app.navigationBars.firstMatch
        let title = bar.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Inbox'")).firstMatch
        if !title.waitForExistence(timeout: 10) { XCTFail("no title menu: \(bar.debugDescription)") }
        return title
    }

    private func back() {
        app.navigationBars.buttons.element(boundBy: 0).tap()
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
        return XCTWaiter().wait(for: [expectation], timeout: 30) == .completed
    }
}
