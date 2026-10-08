import XCTest

/// The M2 proof, in action against a real Inbox (apps/ios/scripts/proof.ts):
/// an agent attaches a markdown plan, the record's "Low Tide" ticket page and
/// a Mermaid flow; the person comments on each by touch (a text selection, a
/// pin moved to its parent and back, a diagram node) and sends, and the
/// agent's feedback names all three. On the way: the agent edits the plan and
/// the changed line opens the version it sent; the "3 annotations" sheet opens
/// a file at its mark; Share; links (an https link opens Safari View
/// Controller, a plannotator:// link opens nothing, a scripted navigation is
/// cancelled); and the page's forged bridge messages are dropped.
@MainActor
final class AttachmentProofTests: ProofCase {
    func testCommentOnThreeFilesAndSend() async throws {
        app.launch()
        let attached = try await control.post("/attach")
        let thread = try XCTUnwrap(attached["thread"] as? String)
        try await pairByCode()

        // 3.4A: the files at the foot of the message.
        try await openRow(thread)
        let planTile = element("attachment-retry-plan.md")
        XCTAssertTrue(planTile.waitForExistence(timeout: 30))
        scrollTo(element("attachment-install-flow.mmd"))
        try await control.shot("3.4A-files")
        // The largest Dynamic Type size: the tiles wrap inside the screen.
        try await control.post("/text-size", ["size": "accessibility-extra-extra-extra-large"])
        try await control.shot("ax-files")
        try await control.post("/text-size", ["size": "large"])

        try await control.post("/video/start", ["name": "M2-comment-flow"])

        // 4.1: the plan full screen. Its last section starts below the fold.
        planTile.tap()
        let title = web("Retry worker for Stripe 409s")
        expect(title, "the plan's title")
        try await control.shot("4.1-plan")
        // The document follows Dynamic Type (the surface's text scale), the bars follow the system.
        try await control.post("/text-size", ["size": "accessibility-extra-extra-extra-large"])
        try await control.shot("ax-plan")
        try await control.post("/text-size", ["size": "large"])
        let target = web("An alert fires when that count passes ten in an hour.")
        XCTAssertFalse(target.exists && target.isHittable, "the commented line starts below the fold")

        // Long press: the system selection, with Comment first in the edit menu (4.1), then the sheet (4.2).
        swipeWeb(until: target)
        target.press(forDuration: 1.2)
        let comment = app.menuItems["Comment"]
        expect(comment, "Comment in the edit menu")
        try await control.shot("4.1-menu")
        comment.tap()
        let words = element("comment-text")
        expect(words, "the comment sheet")
        words.typeText("Ten an hour is a lot for one customer. Alert on three.")
        try await control.shot("4.2")
        element("comment-save").tap()
        XCTAssertTrue(waitGone(element("comment-panel")))
        XCTAssertTrue(waitForLabel(element("file-count"), "1"))

        // The agent edits the plan: the changed line, and the version it sent.
        try await control.post("/edit-plan")
        element("file-close").tap()
        planTile.tap()
        let changed = element("changed-line")
        expect(changed, "the changed line")
        XCTAssertTrue(changed.label.contains("Changed since Claude Code sent it"), changed.label)
        try await control.shot("4.1-changed")
        tapLink("Open the version it sent", in: changed)
        XCTAssertTrue(waitForLabel(changed, "The version Claude Code sent"))
        expect(web("The duplicate-charge report goes to finance at the end of the first week."), "the sent text")
        try await control.shot("4.1-sent")

        // Links in rendered markdown: https opens Safari View Controller; plannotator:// opens nothing.
        let guide = app.webViews.links["Stripe's idempotency guide"]
        swipeWeb(until: guide)
        guide.tap()
        try await expectSafari("docs.stripe.com")
        let pairLink = app.webViews.links["pair this phone"]
        swipeWeb(until: pairLink)
        pairLink.tap()
        try await expectNothingOpened()

        // Share: the file's bytes through the system share sheet.
        element("file-more").tap()
        app.buttons["Share"].firstMatch.tap()
        let shareSheet = app.otherElements["ActivityListView"].firstMatch
        expect(shareSheet, "the share sheet")
        try await control.shot("share")
        dismissShareSheet()
        element("file-close").tap()

        // 4.3: the ticket page. It forges bridge messages and navigates itself
        // 1.5 s after it loads, with nobody touching it: nothing opens.
        element("attachment-ticket-page.html").tap()
        let tickets = app.webViews.buttons["Get tickets · €24"]
        expect(tickets, "the ticket page")
        // The page's own folder: photos named with a space ("dj tern.png") and an accent ("joão.png") load.
        expect(app.webViews.staticTexts["Photos: 3 of 3"], "all three photos from the page's folder")
        // A page it embeds from its folder runs, and its image beacon, fetch and WebSocket reach nothing.
        expect(app.webViews.staticTexts["Lift to the roof from the Pier 9 lobby. Notes ran."], "the embedded page's script")
        try await Task.sleep(for: .seconds(4))
        XCTAssertFalse(element("comment-panel").exists, "a forged message opened a composer")
        let probe = element("bridge-dropped")
        let counts = probe.label.split(separator: " ").compactMap { Int($0) }
        XCTAssertEqual(counts.count, 3, probe.label)
        XCTAssertGreaterThan(counts[0], 0, "messages posted from the page's own frame reach the shell and are dropped there")
        XCTAssertGreaterThan(counts[1], 0, "a pin the page forged through the viewer's protocol is dropped without a touch")
        XCTAssertTrue(tickets.exists, "the scripted navigation was cancelled")
        try await expectNothingOpened()
        let beacons = try await control.get("/beacons")
        XCTAssertEqual(beacons["count"] as? Int, 0, "the embedded page phoned home: \(beacons)")
        try await control.shot("4.3-page")

        // A pin by touch, moved to its parent and back to the child, then saved.
        // The pinned element stays in sight above the switch and the panel the whole time.
        tickets.tap()
        expect(element("pin-parent"), "the pin's sheet")
        try await expectAbovePanel(tickets, "the pinned button")
        try await control.shot("4.3-pin")
        element("pin-parent").tap()
        try await expectAbovePanel(tickets, "the button inside the pinned parent")
        try await control.shot("4.3-pin-parent")
        element("pin-child").tap()
        try await expectAbovePanel(tickets, "the pinned button, back from its parent")
        let pinWords = element("comment-text")
        pinWords.tap()
        pinWords.typeText("Show the booking fee in this price, not at checkout.")
        element("comment-save").tap()
        XCTAssertTrue(waitGone(element("comment-panel")))
        try await control.shot("4.3-saved")
        // The saved mark's badge: a tap shows the comment with Edit and Remove (4.3).
        let badge = app.webViews.buttons["Comment 1"]
        expect(badge, "the saved mark's badge")
        badge.tap()
        expect(element("shown-edit"), "the saved comment")
        XCTAssertEqual(element("shown-text").label, "Show the booking fee in this price, not at checkout.")
        try await control.shot("4.3")
        element("comment-panel").swipeDown()
        XCTAssertTrue(waitGone(element("comment-panel")))

        // Interact: a real link opens Safari View Controller; the app's own scheme opens nothing.
        element("mode-interact").tap()
        let venue = app.webViews.links["Venue map"]
        swipeWeb(until: venue)
        venue.tap()
        try await expectSafari("example.com")
        let openInApp = app.webViews.links["Open in the app"]
        openInApp.tap()
        try await expectNothingOpened()
        element("file-close").tap()

        // 4.4: a node of the diagram.
        element("attachment-install-flow.mmd").tap()
        let node = web("Pick a host")
        expect(node, "the diagram")
        node.tap()
        let nodeWords = element("comment-text")
        expect(nodeWords, "the node's sheet")
        XCTAssertTrue(app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'Pick a host'")).firstMatch.exists)
        try await control.shot("4.4-sheet")
        nodeWords.tap()
        nodeWords.typeText("Name the hosts with their marks here, not a bare list.")
        try await control.shot("4.4")
        element("comment-save").tap()
        XCTAssertTrue(waitGone(element("comment-panel")))
        try await control.post("/video/stop")
        element("file-close").tap()

        // 3.6: the three annotations ride the next Send; a file name opens the file at its mark.
        let chip = element("annotations-chip")
        expect(chip, "the annotations chip")
        XCTAssertTrue(chip.label.contains("3 annotations"), chip.label)
        try await control.shot("3.4A-annotations")
        chip.tap()
        expect(element("annotations-title"), "the annotations sheet")
        try await control.shot("3.6")
        element("annotations-file-retry-plan.md").tap()
        expect(title, "the plan, opened from the sheet")
        // Opened at the mark: the commented line is on screen without scrolling.
        // The saved mark splits the line's text around the word, so the line is found by either end.
        let focused = app.webViews.staticTexts.matching(NSPredicate(format: "label CONTAINS 'An alert fires' OR label CONTAINS 'passes ten in an'")).firstMatch
        let deadline = Date.now.addingTimeInterval(15)
        while !(focused.exists && focused.isHittable), Date.now < deadline { try await Task.sleep(for: .milliseconds(300)) }
        try await control.shot("3.6-opened-at-mark")
        XCTAssertTrue(focused.isHittable, "the file opened at its mark")
        element("file-close").tap()

        // Send: the agent's feedback names all three files and carries all three comments.
        element("send").tap()
        let reply = try await control.post("/reply", ["thread": thread])
        let body = try XCTUnwrap((reply["reply"] as? [String: Any])?["body"] as? String, "reply: \(reply)")
        for piece in ["retry-plan.md", "ticket-page.html", "install-flow.mmd",
                      "Alert on three.", "Show the booking fee in this price", "Name the hosts with their marks"] {
            XCTAssertTrue(body.contains(piece), "\(piece) in \(body)")
        }
        XCTAssertTrue(waitGone(chip), "the annotations went with the Send")
        try await control.shot("sent-with-annotations")

        back()
        removeSource()
    }

    // MARK: Helpers

    /// Text drawn by the surface (the web view).
    private func web(_ text: String) -> XCUIElement {
        app.webViews.staticTexts.matching(NSPredicate(format: "label == %@ OR value == %@", text, text)).firstMatch
    }

    private func expect(_ target: XCUIElement, _ what: String, timeout: TimeInterval = 30, file: StaticString = #filePath, line: UInt = #line) {
        if !target.waitForExistence(timeout: timeout) {
            print("— \(what) not found. The screen:\n\(app.debugDescription)")
            XCTFail("\(what) not found", file: file, line: line)
        }
    }

    private func waitGone(_ target: XCUIElement) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: target)
        return XCTWaiter().wait(for: [expectation], timeout: 30) == .completed
    }

    /// Scrolls the document (inside the web view) until the element is on screen.
    /// Scrolls the document (inside the web view) until the element is on screen and in the
    /// upper part of it, clear of the floating toolstrip at the thumb (a fast runner and a slow
    /// one stop a swipe at different places).
    private func swipeWeb(until target: XCUIElement) {
        var tries = 0
        while !(target.exists && target.isHittable), tries < 10 {
            app.webViews.firstMatch.swipeUp(velocity: .slow)
            tries += 1
        }
        let limit = app.frame.height * 0.6
        tries = 0
        while target.exists, target.frame.midY > limit, tries < 6 {
            let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.65))
            start.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.45)), withVelocity: .slow, thenHoldForDuration: 0.3)
            tries += 1
        }
    }

    private func tapLink(_ title: String, in container: XCUIElement) {
        let link = container.links[title].firstMatch
        if link.exists { link.tap() } else { app.links[title].firstMatch.tap() }
    }

    /// The element is on screen and wholly above the Annotate and Interact switch (and so above the panel).
    private func expectAbovePanel(_ target: XCUIElement, _ what: String) async throws {
        let strip = element("mode-annotate")
        let deadline = Date.now.addingTimeInterval(10)
        while Date.now < deadline {
            if target.exists, target.isHittable, target.frame.maxY <= strip.frame.minY, target.frame.minY >= 110 { return }
            try await Task.sleep(for: .milliseconds(250))
        }
        XCTFail("\(what) is not in sight above the panel: \(target.frame) under \(strip.frame)")
    }

    /// Safari View Controller is up on that host; then closed.
    private func expectSafari(_ host: String) async throws {
        let shown = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", host, host)).firstMatch
        expect(shown, "Safari View Controller on \(host)")
        try await control.shot("safari-\(host)")
        print("— Safari:\n\(app.debugDescription)")
        let close = app.buttons.matching(NSPredicate(format: "(label == 'Close' OR label == 'Done') AND identifier != 'file-close'")).firstMatch
        expect(close, "Safari's close button")
        close.tap()
        XCTAssertTrue(element("file-close").waitForExistence(timeout: 30))
    }

    /// Nothing opened: no Safari, no mail, no pairing, the file still on screen.
    private func expectNothingOpened() async throws {
        try await Task.sleep(for: .seconds(2))
        XCTAssertTrue(element("file-close").isHittable, "something covered the file")
        XCTAssertFalse(element("find-nearby").exists, "pairing opened")
        XCTAssertFalse(app.textFields["pairing-code"].exists, "pairing opened")
    }

    private func dismissShareSheet() {
        let close = app.buttons.matching(NSPredicate(format: "label == 'Close'")).allElementsBoundByIndex.last { $0.isHittable }
        if let close { close.tap() } else { app.swipeDown() }
        XCTAssertTrue(waitGone(app.otherElements["ActivityListView"].firstMatch))
    }
}
