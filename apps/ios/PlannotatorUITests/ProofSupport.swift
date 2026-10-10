import XCTest

/// What every proof test shares: the app, the proof script's control server
/// (`PROOF_CONTROL`, set by apps/ios/scripts/proof.ts) and the helpers.
/// Without the script the tests are skipped.
@MainActor
class ProofCase: XCTestCase {
    // Waits are long: a shared CI runner can take tens of seconds to find an
    // element that a local simulator finds at once.
    var app: XCUIApplication!
    var control: Control!

    override func setUp() async throws {
        continueAfterFailure = false
        guard let base = ProcessInfo.processInfo.environment["PROOF_CONTROL"], let url = URL(string: base) else {
            throw XCTSkip("Run through apps/ios/scripts/proof.ts, which starts the Inbox this test talks to.")
        }
        control = Control(base: url)
        // Every proof class starts from a cold install, whatever the class before it
        // left behind (a class that failed partway leaves the app paired). This is done
        // here and not in a tearDown on failure: an async test runs on past a failure,
        // and a tearDown that terminated and reinstalled the app under it hung the shard
        // until the job timeout (runs 37958261402, 38017849289 and 38023662529).
        try await control.post("/reset-app")
        app = XCUIApplication()
        app.launchArguments = ["-PlannotatorProof"]
    }

    // MARK: Helpers

    func element(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    func pullToRefresh() {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.3))
        start.press(forDuration: 0.1, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9)))
    }

    func back() {
        app.navigationBars.buttons.element(boundBy: 0).tap()
    }

    /// Opens a list row, scrolling to it (the list draws lazily).
    func openRow(_ thread: String) async throws {
        let row = element("row-\(thread)")
        app.swipeDown()
        app.swipeDown()
        scrollTo(row)
        XCTAssertTrue(row.exists, "row \(thread)")
        row.tap()
    }

    /// The tab bar minimizes on scroll (iOS 26); scrolling back up brings its items back.
    func tab(_ name: String) {
        let button = app.tabBars.buttons[name]
        var tries = 0
        while !button.exists, tries < 4 {
            app.swipeDown(velocity: .fast)
            tries += 1
        }
        button.tap()
    }

    func anyRow() -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'row-'")).firstMatch
    }

    func questionKeys() -> [String] {
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'question-'")).allElementsBoundByIndex
            .map { String($0.identifier.dropFirst("question-".count)) }
    }

    func scrollTo(_ target: XCUIElement) {
        var tries = 0
        while !(target.exists && target.isHittable), tries < 8 {
            app.swipeUp(velocity: .slow)
            tries += 1
        }
    }

    /// A step that must hold, or the test ends here: an async test runs on past an
    /// XCTFail, tapping a screen that is no longer the one it expects.
    func require(_ holds: Bool, _ message: @autoclosure () -> String, file: StaticString = #filePath, line: UInt = #line) throws {
        guard !holds else { return }
        XCTFail(message(), file: file, line: line)
        throw ProofStop()
    }

    func waitForLabel(_ target: XCUIElement, _ text: String) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label CONTAINS %@", text), object: target)
        return XCTWaiter().wait(for: [expectation], timeout: 30) == .completed
    }
}

/// Thrown by `require`: the failure is already recorded.
struct ProofStop: Error {}

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

extension ProofCase {
    /// Pairs with the proof's Inbox by its loopback address and six digits (1.3).
    func pairByCode() async throws {
        try opened(element("connect-computer"), "the first run")
        element("connect-computer").tap()
        try opened(element("find-nearby"), "the pairing cover")
        element("find-nearby").tap()
        let offer = try await control.post("/offer")
        let field = element("address-field")
        try opened(field, "the address field")
        field.tap()
        field.typeText(try XCTUnwrap(offer["address"] as? String))
        element("address-next").tap()
        let codeField = element("pairing-code")
        try opened(codeField, "the code boxes")
        codeField.tap()
        codeField.typeText(try XCTUnwrap(offer["code"] as? String))
        // A refused code or an unreachable address stays on the code screen, in its message: the screen is printed.
        try opened(anyRow(), "the list after pairing")
    }

    /// A screen of the pairing flow; when it never opens, the failure carries the screen as it was.
    private func opened(_ target: XCUIElement, _ what: String, file: StaticString = #filePath, line: UInt = #line) throws {
        if !target.waitForExistence(timeout: ProofWait.opening) {
            print("— \(what) not found. The screen:\n\(app.debugDescription)")
            try require(false, "\(what) not found", file: file, line: line)
        }
    }

    /// Remove this source (9.2), leaving the app as a fresh install finds it.
    func removeSource() {
        tab("Settings")
        let source = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'source-'")).firstMatch
        XCTAssertTrue(source.waitForExistence(timeout: 30))
        source.tap()
        app.reveal("remove-source").tap()
        app.sheets.buttons["Remove This Source"].firstMatch.tap()
        XCTAssertTrue(element("add-source").waitForExistence(timeout: 30))
        tab("Inbox")
    }
}
