import XCTest

/// The M5 proof, in action: the compiled Inbox pushes through the relay under
/// `wrangler dev` to Apple, played locally by apps/ios/scripts/proof.ts, and
/// the exact body Apple received is delivered to this simulator with
/// `xcrun simctl push`. Runs after the M1 flow (class order), from a phone
/// with no source.
///
/// `simctl push` never runs a notification service extension (the device
/// spike, item 5), so a push that arrives while the app is in the front is
/// dressed by the app with the extension's own code (`PushNotification.dress`),
/// and one that arrives in the back shows the relay's plain words. The
/// extension itself under a real push, and Face ID before a choice, are
/// device proofs.
@MainActor
final class RelayPushTests: XCTestCase {
    private var app: XCUIApplication!
    private var control: Control!
    private let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    private let subject = "Run the retry tests against the Stripe test clock?"

    override func setUp() async throws {
        continueAfterFailure = false
        guard let base = ProcessInfo.processInfo.environment["PROOF_CONTROL"], let url = URL(string: base) else {
            throw XCTSkip("Run through apps/ios/scripts/proof.ts, which starts the Inbox and the relay this test talks to.")
        }
        control = Control(base: url)
        app = XCUIApplication()
    }

    func testRelayPushAndTheLockScreenAnswer() async throws {
        app.launch()
        try await unpaired()

        // Pair by the address and the six digits: the Inbox makes its mailbox
        // and registers this phone at the relay, with no APNs token yet.
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
        // The list, or its empty state when this test runs alone.
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'row-' OR label == 'Nothing waiting'")).firstMatch.waitForExistence(timeout: 30))
        let registered = try await until("this phone at the relay") { () async throws -> [[String: Any]]? in
            let devices = try await self.relayDevices()
            return devices.isEmpty ? nil : devices
        }
        XCTAssertEqual(registered.count, 1, "\(registered)")
        XCTAssertTrue(registered.first?["apns_token"] is NSNull, "\(registered)")

        // 9.1: no prompt at launch; "Allow notifications" asks the system once,
        // and the APNs token reaches the relay.
        tab("Settings")
        let allow = element("allow-notifications")
        XCTAssertTrue(allow.waitForExistence(timeout: 30))
        XCTAssertEqual(allow.value as? String, "0")
        XCTAssertFalse(element("answer-lock-screen").isEnabled)
        allow.switches.firstMatch.tap()
        let systemAllow = springboard.buttons["Allow"]
        XCTAssertTrue(systemAllow.waitForExistence(timeout: 30))
        systemAllow.tap()
        XCTAssertTrue(waitForValue(allow, "1"))
        XCTAssertTrue(element("answer-lock-screen").isEnabled)
        // The simulator's own token, where it can reach APNs (a Mac); a CI
        // runner's simulator gets none, and the script registers a stand-in
        // the way the phone would, so the pushes still go out.
        var withToken = (try? await until("the APNs token at the relay", tries: 40) { try await self.relayDevices().first?["apns_token"] as? String }) ?? ""
        if withToken.isEmpty {
            let standIn = try await control.post("/relay-token-stand-in")
            XCTAssertEqual(standIn["registered"] as? Int, 1, "\(standIn)")
            print("RelayPushTests: no APNs token from this simulator; a stand-in token is registered at the relay")
            withToken = try await until("the stand-in token at the relay") { try await self.relayDevices().first?["apns_token"] as? String }
        }
        XCTAssertTrue(withToken.count >= 64 && withToken.allSatisfy(\.isHexDigit), withToken)
        try await control.shot("9.1")
        // The largest Dynamic Type size: the switches and the footer wrap inside the screen.
        try await control.post("/text-size", ["size": "accessibility-extra-extra-extra-large"])
        let lockScreenRow = element("answer-lock-screen")
        for _ in 0..<6 where !lockScreenRow.isHittable { app.swipeUp(velocity: .slow) }
        try await control.shot("ax-9.1")
        try await control.post("/text-size", ["size": "large"])
        app.swipeDown(velocity: .fast)
        app.swipeDown(velocity: .fast)
        tab("Inbox")

        // 7.1: a guided review, then a single-choice question, each pushed by
        // the Inbox through the relay; the exact bodies Apple got arrive here.
        let guide = try await control.post("/ask", ["kind": "guide", "agent": "Pi", "host": "pi"])
        let guideThread = try XCTUnwrap(guide["thread"] as? String)
        try await control.post("/push", ["thread": guideThread])
        XCTAssertTrue(notification(containing: "guided review of the export change").waitForExistence(timeout: 30))
        let asked = try await control.post("/ask")
        let thread = try XCTUnwrap(asked["thread"] as? String)
        XCTAssertEqual(asked["device_token"] as? String, withToken)
        XCTAssertEqual((asked["collapse_id"] as? String)?.count, 64)
        try await control.post("/push", ["thread": thread])
        let banner = notification(containing: subject)
        XCTAssertTrue(banner.waitForExistence(timeout: 30))

        // 7.2, drawn: a long press shows the choices, recommended first. (The
        // simulator does not draw an expanded notification on its lock screen,
        // so the frame is taken from the banner; the answer below is tapped locked.)
        banner.press(forDuration: 1.2)
        XCTAssertTrue(springboard.buttons["Yes"].waitForExistence(timeout: 30))
        let order = springboard.buttons.allElementsBoundByIndex.map(\.label).filter { $0 == "Yes" || $0 == "No" }
        XCTAssertEqual(order, ["Yes", "No"])
        try await control.shot("7.2")
        springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)).tap()
        sleep(1)

        // Locked: the subject as the title, "<agent> in <project>: <context>" as the body.
        try await control.post("/video/start", ["name": "M5-lock-screen-answer"])
        lock()
        let question = notification(containing: subject)
        XCTAssertTrue(question.waitForExistence(timeout: 30))
        XCTAssertTrue(question.label.contains("Claude Code in billing-svc: They take about four minutes against the test key."), question.label)
        // The guided review sits in the stack under it (the system groups an app's notifications).
        try await control.shot("7.1")

        // Locked, Yes picks and sends at once.
        expand(question)
        let yes = springboard.buttons["Yes"]
        XCTAssertTrue(yes.waitForExistence(timeout: 30))
        yes.tap()
        let reply = try await control.post("/reply", ["thread": thread])
        XCTAssertTrue("\(reply)".contains("Yes"), "\(reply)")
        try await control.post("/video/stop")

        // A choice whose computer cannot be reached directly goes up through
        // the relay's command path (R2), sealed under this phone's up key, and
        // the Inbox applies it through the door: the agent gets it all the same.
        unlock()
        app.activate()
        let ship = try await control.post("/ask", ["kind": "ship", "agent": "Codex", "host": "codex"])
        let shipThread = try XCTUnwrap(ship["thread"] as? String)
        try await control.post("/push", ["thread": shipThread])
        let shipBanner = notification(containing: "Ship the dark ticket page")
        XCTAssertTrue(shipBanner.waitForExistence(timeout: 30))
        try await control.post("/proxy", ["mode": "gone"])
        shipBanner.press(forDuration: 1.2)
        XCTAssertTrue(springboard.buttons["No"].waitForExistence(timeout: 30))
        springboard.buttons["No"].tap()
        let carried = try await control.post("/reply", ["thread": shipThread])
        XCTAssertTrue("\(carried)".contains("Answer: No"), "\(carried)")
        let commands = try await control.get("/relay-log")
        XCTAssertTrue((commands["queued"] as? Int ?? 0) >= 1, "\(commands)")
        try await control.post("/proxy", ["mode": "pass"])

        // A push that is not one single-choice question opens its thread. In
        // the back, as `simctl push` delivers it, it shows the relay's plain
        // words; the tap opens the thread from the envelope.
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 30) || app.wait(for: .runningBackgroundSuspended, timeout: 30))
        sleep(2)
        try await control.post("/push", ["thread": guideThread])
        let plain = notification(containing: "New in your Inbox")
        XCTAssertTrue(plain.waitForExistence(timeout: 30))
        plain.tap()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'guided review of the export change'")).firstMatch.waitForExistence(timeout: 30))
        try await control.shot("7.1-opened-thread")

        // Previews hidden: "Question from an agent", no subject, no agent text.
        let previews = try setShowPreviews("Never")
        app.activate()
        try await control.post("/push", ["thread": thread])
        lock()
        let hidden = notification(containing: "Question from an agent")
        XCTAssertTrue(hidden.waitForExistence(timeout: 30))
        XCTAssertFalse(hidden.label.contains("Stripe"), hidden.label)
        XCTAssertFalse(notification(containing: subject).exists)
        try await control.shot("7.1-previews-hidden")
        unlock()
        _ = try setShowPreviews(previews)

        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 30))
        // A push no key here opens (as from a computer this phone was removed
        // from), arriving in front: shown once as "Question from an agent",
        // never dressed again.
        try await control.post("/push-unopenable")
        let unopened = notification(containing: "Question from an agent")
        XCTAssertTrue(unopened.waitForExistence(timeout: 30))
        sleep(3)
        XCTAssertEqual(springboard.descendants(matching: .any).matching(identifier: "NotificationShortLookView").matching(NSPredicate(format: "label CONTAINS 'Question from an agent'")).count, 1)
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 5))

        // Leave the phone with no source, as it came.
        try await removeSources()
    }

    // MARK: Helpers

    private func element(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func notification(containing text: String) -> XCUIElement {
        springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    private func relayDevices() async throws -> [[String: Any]] {
        try await control.get("/relay")["devices"] as? [[String: Any]] ?? []
    }

    private func until<T>(_ what: String, tries: Int = 60, _ read: () async throws -> T?) async throws -> T {
        for _ in 0..<tries {
            if let value = try await read() { return value }
            try await Task.sleep(for: .milliseconds(500))
        }
        throw NSError(domain: "RelayPushTests", code: 1, userInfo: [NSLocalizedDescriptionKey: "timed out waiting for \(what)"])
    }

    private func waitForValue(_ target: XCUIElement, _ value: String) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: target)
        return XCTWaiter().wait(for: [expectation], timeout: 30) == .completed
    }

    /// The simulator has no lock command; XCUIDevice's private lock button is how the spike locked it.
    private func lock() {
        XCUIDevice.shared.perform(NSSelectorFromString("pressLockButton"))
        sleep(2)
    }

    private func unlock() {
        XCUIDevice.shared.press(.home)
        sleep(1)
        XCUIDevice.shared.press(.home)
        sleep(1)
    }

    /// A notification's actions, drawn. On the simulator's lock screen a long
    /// press does not expand a notification (the device spike, item 5); a swipe
    /// and View does, as Options and View do on a phone.
    private func expand(_ notification: XCUIElement) {
        notification.swipeLeft()
        let view = springboard.buttons["View"]
        if view.waitForExistence(timeout: 5) { view.tap() } else { notification.press(forDuration: 1.5) }
        sleep(1)
    }

    /// Settings > Apps > Plannotator > Notifications > Show Previews (the
    /// simulator's Settings has no top-level Notifications row); answers the
    /// value it replaced.
    private func setShowPreviews(_ value: String) throws -> String {
        let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        settings.launch()
        func row(_ label: String) -> XCUIElement {
            let target = settings.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
            var tries = 0
            while !(target.waitForExistence(timeout: 3) && target.isHittable), tries < 10 {
                settings.swipeUp(velocity: .slow)
                tries += 1
            }
            return target
        }
        row("Apps").tap()
        row("Plannotator").tap()
        row("Notifications").tap()
        let previews = settings.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH 'Show Previews'")).firstMatch
        var tries = 0
        while !(previews.waitForExistence(timeout: 3) && previews.isHittable), tries < 6 {
            settings.swipeUp(velocity: .slow)
            tries += 1
        }
        let before = "\(previews.label) \((previews.value as? String) ?? "")"
        previews.tap()
        let option = settings.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", value)).firstMatch
        XCTAssertTrue(option.waitForExistence(timeout: 30))
        option.tap()
        settings.terminate()
        return ["When Unlocked", "Never", "Always"].first { before.contains($0) } ?? "When Unlocked"
    }

    /// The tab bar minimizes on scroll (iOS 26); scrolling back up brings its
    /// items back, which a slow runner can take a moment to draw.
    private func tab(_ name: String) {
        let button = app.tabBars.buttons[name]
        var tries = 0
        while !button.waitForExistence(timeout: 3), tries < 6 {
            // Minimized, the bar shows only the selected tab: a tap on it opens it again.
            if tries % 2 == 0, app.tabBars.buttons.firstMatch.exists { app.tabBars.buttons.firstMatch.tap() } else { app.swipeDown(velocity: .fast) }
            tries += 1
        }
        button.tap()
    }

    /// The first run, removing any source a test before this one left.
    private func unpaired() async throws {
        if element("connect-computer").waitForExistence(timeout: 10) { return }
        try await removeSources()
        XCTAssertTrue(element("connect-computer").waitForExistence(timeout: 30))
    }

    private func removeSources() async throws {
        // Back out of a thread a notification opened: the tab bar hides there.
        for _ in 0..<3 where !app.tabBars.buttons["Settings"].exists && app.navigationBars.buttons.firstMatch.exists {
            app.navigationBars.buttons.element(boundBy: 0).tap()
        }
        tab("Settings")
        while true {
            let source = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'source-'")).firstMatch
            guard source.waitForExistence(timeout: 5) else { break }
            source.tap()
            element("remove-source").tap()
            app.sheets.buttons["Remove This Source"].firstMatch.tap()
            XCTAssertTrue(element("add-source").waitForExistence(timeout: 30))
        }
        tab("Inbox")
    }
}
