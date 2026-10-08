import XCTest

/// The proof's waits for a screen to appear, one constant for every test class.
///
/// On a cold macOS CI runner the app's first launch on a fresh simulator took
/// 42 to 62 s to reach idle, and the first screens after it more than 30 s
/// each (runs 37799098038 and 37811000174); a local run takes a few seconds.
/// `WarmUpLaunch` takes that first-time cost before the proof, so the bound is
/// headroom for a slow runner, not for a first launch.
enum ProofWait {
    static let opening: TimeInterval = 120
}

/// Run alone, before every other test, by apps/ios/scripts/proof.ts: one launch
/// of the app on the fresh simulator, one pairing with the proof's Inbox (the
/// first Keychain write, the first door requests, the first list drawn), Remove
/// this source, quit. Every proof class then starts on a warm simulator from a
/// fresh app. Without the proof script it is skipped.
@MainActor
final class WarmUpLaunch: XCTestCase {
    func testFirstLaunch() async throws {
        guard let base = ProcessInfo.processInfo.environment["PROOF_CONTROL"], let url = URL(string: base) else {
            throw XCTSkip("Run through apps/ios/scripts/proof.ts.")
        }
        continueAfterFailure = false
        let control = Control(base: url)
        let app = XCUIApplication()
        let element = { (id: String) in app.descendants(matching: .any).matching(identifier: id).firstMatch }
        app.launch()
        XCTAssertTrue(element("connect-computer").waitForExistence(timeout: ProofWait.opening))
        element("connect-computer").tap()
        XCTAssertTrue(element("find-nearby").waitForExistence(timeout: ProofWait.opening))
        element("find-nearby").tap()
        let offer = try await control.post("/offer")
        let field = element("address-field")
        XCTAssertTrue(field.waitForExistence(timeout: ProofWait.opening))
        field.tap()
        field.typeText(try XCTUnwrap(offer["address"] as? String))
        element("address-next").tap()
        let code = element("pairing-code")
        XCTAssertTrue(code.waitForExistence(timeout: ProofWait.opening))
        code.tap()
        code.typeText(try XCTUnwrap(offer["code"] as? String))
        // The Inbox has no thread yet: the list's empty state is the paired screen.
        XCTAssertTrue(app.staticTexts["Nothing waiting"].waitForExistence(timeout: ProofWait.opening))
        app.tabBars.buttons["Settings"].tap()
        let source = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'source-'")).firstMatch
        XCTAssertTrue(source.waitForExistence(timeout: ProofWait.opening))
        source.tap()
        XCTAssertTrue(element("remove-source").waitForExistence(timeout: ProofWait.opening))
        element("remove-source").tap()
        app.sheets.buttons["Remove This Source"].firstMatch.tap()
        XCTAssertTrue(element("add-source").waitForExistence(timeout: ProofWait.opening))
        app.terminate()
    }
}
