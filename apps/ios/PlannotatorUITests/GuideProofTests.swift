import XCTest

/// The M4 proof, in action against a real Inbox (apps/ios/scripts/proof.ts):
/// Pi sends the record's guided review of the ledger export through
/// submit_guide (a shipped fixture); the person opens it from the thread
/// (6.1), marks the first section reviewed in the sections, continues to the
/// second (6.2) and marks it there; both ticks reach the Inbox, read the way
/// the desktop window reads them. Previous and Next move the sections and the
/// app's bar title follows; a tick made with the computer out of reach
/// reads off again after "Not saved"; the wrap button turns wrapping off and on; back
/// returns to the sections; and a section is drawn at the largest Dynamic
/// Type size.
@MainActor
final class GuideProofTests: ProofCase {
    func testReadAGuideAndMarkSectionsReviewed() async throws {
        app.launch()
        let sent = try await control.post("/guide")
        let thread = try XCTUnwrap(sent["thread"] as? String)
        let message = try XCTUnwrap(sent["message"] as? String)
        try await pairByCode()

        // The guide's tile at the foot of Pi's message (8.1).
        try await openRow(thread)
        let tile = element("guide-tile")
        try expect(tile, "the guide's tile")
        XCTAssertTrue(tile.label.contains("Guided review: Stream ledger exports instead of building them in memory"), tile.label)
        XCTAssertTrue(tile.label.contains("4 sections, 6 files"), tile.label)
        try await control.shot("8.1-guide-tile")

        try await control.post("/video/start", ["name": "M4-guide-flow"])

        // 6.1: the title, the summary, the sections with their marks, Continue.
        tile.tap()
        let title = element("guide-title")
        // The first web view this shard opens: WebKit's first start on the simulator is paid here
        // (before the shards, AttachmentProofTests paid it), so it waits as long as an opening screen.
        try expect(web("Stream ledger exports instead of building them in memory"), "the guide's title", timeout: ProofWait.opening)
        XCTAssertTrue(waitForLabel(title, "Guided review"))
        XCTAssertTrue(waitForLabel(title, "Pi in ledger, sent"))
        XCTAssertTrue(element("guide-close").exists, "6.1 closes")
        try await control.shot("6.1-open")

        // The first section marked reviewed in the sections: the Inbox keeps it.
        surfaceControl("01 Why memory grew with the ledger: reviewed").tap()
        try await expectTicks(thread: thread, message: message, "true,false,false,false")
        try await control.shot("6.1")

        // Continue picks up at the first section not yet reviewed: 02, one section per screen.
        let continueButton = surfaceControl("Continue with 02")
        try expect(continueButton, "Continue with 02")
        continueButton.tap()
        XCTAssertTrue(waitForLabel(title, "02 of 04"), title.label)
        XCTAssertTrue(waitForLabel(title, "Guided review · Pi in ledger"), title.label)
        try expect(web("The streaming writer"), "the second section")
        XCTAssertTrue(element("guide-back").exists, "6.2 goes back to the sections")
        try await control.shot("6.2")

        // Reviewed at the thumb: the second tick reaches the Inbox too.
        let reviewed = surfaceControl("Reviewed")
        try expect(reviewed, "Reviewed")
        reviewed.tap()
        try await expectTicks(thread: thread, message: message, "true,true,false,false")
        try await control.shot("6.2-reviewed")

        // Next and Previous move the sections; the bar's title follows.
        surfaceControl("Next: 03").tap()
        XCTAssertTrue(waitForLabel(title, "03 of 04"), title.label)
        try expect(web("A failed write leaves no partial file"), "the third section")

        // A tick that cannot reach the computer is not drawn as saved: "Not saved", and Reviewed reads off again.
        try await control.post("/proxy", ["mode": "down"])
        surfaceControl("Reviewed").tap()
        let notSaved = app.alerts["Not saved"]
        try expect(notSaved, "the Not saved alert")
        try await control.shot("6.2-not-saved")
        notSaved.buttons["OK"].tap()
        try await control.post("/proxy", ["mode": "pass"])
        let reviewedAgain = surfaceControl("Reviewed")
        try expect(reviewedAgain, "Reviewed, drawn again")
        XCTAssertTrue(waitForValue(reviewedAgain, "0"), "Reviewed reads \(String(describing: reviewedAgain.value)) after a save that failed")
        XCTAssertTrue(waitForLabel(title, "03 of 04"), title.label)
        try await expectTicks(thread: thread, message: message, "true,true,false,false")
        surfaceControl("Previous: 02").tap()
        XCTAssertTrue(waitForLabel(title, "02 of 04"), title.label)

        // The wrap button: one code line per row for a sideways read, then wrapped again.
        let wrap = element("guide-wrap")
        XCTAssertEqual(wrap.value as? String, "On")
        wrap.tap()
        XCTAssertTrue(waitForValue(wrap, "Off"))
        try await control.shot("6.2-unwrapped")
        wrap.tap()
        XCTAssertTrue(waitForValue(wrap, "On"))

        // The largest Dynamic Type size on a section, then on the sections: the guide's text grows with it;
        // the bar and the controls at the thumb stop at their own largest.
        try await control.post("/text-size", ["size": "accessibility-extra-extra-extra-large"])
        try await control.shot("ax-6.2")

        // Back to the sections: the bar reads 6.1 again and both marks are there.
        element("guide-back").tap()
        XCTAssertTrue(waitForLabel(title, "Guided review"))
        try expect(surfaceControl("Continue with 03"), "Continue with 03")
        try await control.shot("ax-6.1")
        try await control.post("/text-size", ["size": "large"])
        try await control.shot("6.1-two-reviewed")
        try await control.post("/video/stop")

        element("guide-close").tap()
        XCTAssertTrue(tile.waitForExistence(timeout: 30), "back in the thread")
        back()
        removeSource()
    }

    // MARK: Helpers

    /// A control the surface draws, by its label: a button, or a switch (a tick and Reviewed carry `aria-pressed`, which WebKit reads as a switch).
    private func surfaceControl(_ label: String) -> XCUIElement {
        app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label == %@ AND (elementType == %d OR elementType == %d)", label, XCUIElement.ElementType.button.rawValue, XCUIElement.ElementType.switch.rawValue)).firstMatch
    }

    /// Text drawn by the surface (the web view).
    private func web(_ text: String) -> XCUIElement {
        app.webViews.staticTexts.matching(NSPredicate(format: "label == %@ OR value == %@", text, text)).firstMatch
    }

    private func expect(_ target: XCUIElement, _ what: String, timeout: TimeInterval = 30, file: StaticString = #filePath, line: UInt = #line) throws {
        if !target.waitForExistence(timeout: timeout) {
            print("— \(what) not found. The screen:\n\(app.debugDescription)")
            try require(false, "\(what) not found", file: file, line: line)
        }
    }

    private func waitForValue(_ target: XCUIElement, _ value: String) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: target)
        return XCTWaiter().wait(for: [expectation], timeout: 30) == .completed
    }

    /// The ticks the Inbox keeps on the message, read through the desktop window's own route.
    private func expectTicks(thread: String, message: String, _ expected: String, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date.now.addingTimeInterval(30)
        var last = ""
        while Date.now < deadline {
            last = try await control.post("/guide-ticks", ["thread": thread, "message": message])["reviewed"] as? String ?? ""
            if last == expected { return }
            try await Task.sleep(for: .milliseconds(400))
        }
        XCTFail("the window reads the ticks as [\(last)], not [\(expected)]", file: file, line: line)
    }
}
