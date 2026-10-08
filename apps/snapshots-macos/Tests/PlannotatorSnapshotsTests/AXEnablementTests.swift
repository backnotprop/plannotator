import ApplicationServices
import XCTest
@testable import PlannotatorSnapshots

/// App Capture asks Chromium and Electron apps for their accessibility tree so a
/// person never turns on Chrome's accessibility mode by hand. These pin which apps
/// are asked, with which attribute, and how long the capture may wait.
final class AXEnablementTests: XCTestCase {
    typealias E = AXEnablement

    func testChromiumBrowsersByBundleId() {
        for id in ["com.google.Chrome", "com.google.Chrome.canary", "org.chromium.Chromium", "com.microsoft.edgemac",
                   "com.brave.Browser", "company.thebrowser.Browser", "com.operasoftware.Opera", "com.vivaldi.Vivaldi"] {
            XCTAssertEqual(E.family(bundleId: id, frameworks: []), .chromium, id)
        }
    }

    func testChromiumRebrandByFramework() {
        XCTAssertEqual(E.family(bundleId: "com.example.rebrand", frameworks: ["Chromium Framework.framework"]), .chromium)
    }

    func testElectronByFrameworkWinsOverBundleId() {
        // VS Code, Slack, Discord, Notion: all carry Electron Framework.framework.
        for id in ["com.microsoft.VSCode", "com.tinyspeck.slackmacgap", "com.hnc.Discord", "notion.id", nil] {
            XCTAssertEqual(E.family(bundleId: id, frameworks: ["Squirrel.framework", "Electron Framework.framework"]), .electron)
        }
    }

    func testNativeAppsAreNeither() {
        XCTAssertEqual(E.family(bundleId: "com.apple.Safari", frameworks: []), .other)
        XCTAssertEqual(E.family(bundleId: "org.mozilla.firefox", frameworks: ["ChannelPrefs.framework"]), .other)
        XCTAssertEqual(E.family(bundleId: nil, frameworks: []), .other)
    }

    func testStep() {
        XCTAssertEqual(E.step(family: .chromium, alreadyEnabled: false), .beforeWalk)
        XCTAssertEqual(E.step(family: .electron, alreadyEnabled: false), .beforeWalk)
        // Asked once per process: afterwards only an empty tree asks again (no toggling).
        XCTAssertEqual(E.step(family: .chromium, alreadyEnabled: true), .ifSparse)
        XCTAssertEqual(E.step(family: .other, alreadyEnabled: false), .ifSparse)
    }

    func testEnhancedUserInterfaceOnlyForARefusingChromium() {
        XCTAssertTrue(E.useEnhancedFallback(family: .chromium, manualResult: .attributeUnsupported))
        XCTAssertFalse(E.useEnhancedFallback(family: .chromium, manualResult: .success))
        XCTAssertFalse(E.useEnhancedFallback(family: .chromium, manualResult: .cannotComplete), "a busy app is not a refusal")
        XCTAssertFalse(E.useEnhancedFallback(family: .electron, manualResult: .attributeUnsupported))
        XCTAssertFalse(E.useEnhancedFallback(family: .other, manualResult: .attributeUnsupported))
    }

    func testOnlySuccessCountsAsEnabled() {
        XCTAssertTrue(E.accepted(.success))
        XCTAssertFalse(E.accepted(.cannotComplete))
        XCTAssertFalse(E.accepted(.attributeUnsupported))
    }

    func testSettleTimeStaysInsideTheBudget() {
        let now = Date()
        XCTAssertEqual(E.settleTime(now: now, deadline: now.addingTimeInterval(2)), E.settleLimit)
        XCTAssertEqual(E.settleTime(now: now, deadline: now.addingTimeInterval(1.0)), 1.0 - E.walkReserve, accuracy: 0.001)
        XCTAssertEqual(E.settleTime(now: now, deadline: now.addingTimeInterval(0.3)), 0)
        XCTAssertEqual(E.settleTime(now: now, deadline: now.addingTimeInterval(-1)), 0)
        XCTAssertLessThanOrEqual(E.settleLimit + E.walkReserve, 2.0, "waiting plus the walk fit the 2 s budget")
    }

    func testProcessKeySeparatesReusedPids() {
        let a = E.processKey(pid: 42, launched: Date(timeIntervalSince1970: 1))
        let b = E.processKey(pid: 42, launched: Date(timeIntervalSince1970: 2))
        XCTAssertNotEqual(a, b)
        E.markEnabled(a)
        XCTAssertTrue(E.wasEnabled(a))
        XCTAssertFalse(E.wasEnabled(b))
    }

    func testSparse() {
        XCTAssertTrue(AXText.isSparse(["button Back", "button Forward", "field https://example.com"]))
        XCTAssertFalse(AXText.isSparse(["page Example", "  heading Example Domain", "  text This domain is for use"]))
    }

    func testSelfTestDecisionsHold() {
        XCTAssertEqual(SelfTest.enablementChecks(), [])
    }

    func testExcludedAppsAreNeverAsked() {
        // The exclusion check returns before any attribute is written.
        let result = AXText.capture(pid: 1, bundleId: "com.1password.1password", windowTitle: "", frame: .zero)
        XCTAssertNil(result.text)
        XCTAssertNil(result.enablement)
        XCTAssertEqual(result.unavailable, "this app is on the exclusion list")
    }
}
