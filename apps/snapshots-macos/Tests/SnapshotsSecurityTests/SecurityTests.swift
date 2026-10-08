import Foundation
import XCTest
@testable import SnapshotsSecurity

final class URLCommandTests: XCTestCase {
    func testReadsOnlyTheActionAndKind() {
        XCTAssertEqual(URLCommand.parse("plannotator-snapshots://capture?kind=app"), .capture(kind: "app"))
        XCTAssertEqual(URLCommand.parse("plannotator-snapshots://capture?kind=app-pick"), .capture(kind: "app-pick"))
        XCTAssertEqual(URLCommand.parse("plannotator-snapshots://show"), .show)
        XCTAssertEqual(URLCommand.parse("plannotator-snapshots://quit"), .quit)
    }

    func testIgnoresCliAndDataDirInTheURL() {
        // The exploit from the review: a web page or process naming a program to run and a data dir.
        let hostile = "plannotator-snapshots://show?dataDir=/tmp/x&cli=%5B%22/bin/sh%22,%22-c%22,%22touch%20/tmp/pwned;:%22%5D"
        XCTAssertEqual(URLCommand.parse(hostile), .show)
        let capture = "plannotator-snapshots://capture?kind=region&dataDir=/tmp/x&cli=%5B%22/bin/sh%22%5D"
        XCTAssertEqual(URLCommand.parse(capture), .capture(kind: "region"))
    }

    func testUnknownKindsAndActionsAndSchemes() {
        XCTAssertEqual(URLCommand.parse("plannotator-snapshots://capture?kind=../../etc"), .capture(kind: "region"))
        XCTAssertEqual(URLCommand.parse("plannotator-snapshots://capture"), .capture(kind: "region"))
        XCTAssertNil(URLCommand.parse("plannotator-snapshots://setCli?argv=x"))
        XCTAssertNil(URLCommand.parse("https://capture?kind=app"))
        XCTAssertNil(URLCommand.parse("not a url at all"))
    }
}

final class HubOriginTests: XCTestCase {
    func testAcceptsLoopbackWithTheRegistryPort() {
        XCTAssertEqual(HubOrigin(hubURL: "http://127.0.0.1:51234", port: 51234)?.base, "http://127.0.0.1:51234")
        XCTAssertEqual(HubOrigin(hubURL: "http://127.0.0.1:51234/", port: 51234)?.base, "http://127.0.0.1:51234")
    }

    func testRefusesLocalhostWhichMayBeIPv6() {
        // The hub binds 127.0.0.1; `localhost` can resolve to ::1, another socket.
        XCTAssertNil(HubOrigin(hubURL: "http://localhost:51234", port: 51234))
        XCTAssertNil(HubOrigin(hubURL: "http://[::1]:51234", port: 51234))
    }

    func testRefusesAnythingElse() {
        XCTAssertNil(HubOrigin(hubURL: "https://evil.example:443", port: 443))
        XCTAssertNil(HubOrigin(hubURL: "http://evil.example:51234", port: 51234))
        XCTAssertNil(HubOrigin(hubURL: "http://127.0.0.1.evil.example:51234", port: 51234))
        XCTAssertNil(HubOrigin(hubURL: "http://127.0.0.1:51234", port: 51235), "the URL's port must be the registry's")
        XCTAssertNil(HubOrigin(hubURL: "http://127.0.0.1", port: 80))
        XCTAssertNil(HubOrigin(hubURL: "http://127.0.0.1:51234/somewhere", port: 51234))
        XCTAssertNil(HubOrigin(hubURL: "http://user@127.0.0.1:51234", port: 51234))
        XCTAssertNil(HubOrigin(hubURL: "file:///tmp/hud.html", port: 0))
        XCTAssertNil(HubOrigin(hubURL: "javascript:alert(1)", port: 0))
    }

    func testOriginChecks() throws {
        let origin = try XCTUnwrap(HubOrigin(hubURL: "http://127.0.0.1:51234", port: 51234))
        XCTAssertTrue(origin.contains(URL(string: "http://127.0.0.1:51234/hud")))
        XCTAssertFalse(origin.contains(URL(string: "http://127.0.0.1:51235/hud")))
        XCTAssertFalse(origin.contains(URL(string: "http://localhost:51234/hud")), "only the IPv4 literal the hub binds")
        XCTAssertFalse(origin.contains(URL(string: "https://127.0.0.1:51234/hud")))
        XCTAssertTrue(origin.matches(protocol: "http", host: "127.0.0.1", port: 51234))
        XCTAssertFalse(origin.matches(protocol: "https", host: "127.0.0.1", port: 51234))
        XCTAssertFalse(origin.matches(protocol: "http", host: "evil.example", port: 51234))
    }

    func testNavigationPolicy() throws {
        let origin = try XCTUnwrap(HubOrigin(hubURL: "http://127.0.0.1:51234", port: 51234))
        let hud = URL(string: "http://127.0.0.1:51234/hud")
        let web = URL(string: "https://example.com/docs")
        XCTAssertEqual(NavigationPolicy.decide(url: hud, isMainFrame: true, isLinkActivation: false, origin: origin), .allow)
        XCTAssertEqual(NavigationPolicy.decide(url: web, isMainFrame: true, isLinkActivation: false, origin: origin), .cancel, "a script never takes the HUD elsewhere")
        XCTAssertEqual(NavigationPolicy.decide(url: web, isMainFrame: true, isLinkActivation: true, origin: origin), .openExternally)
        XCTAssertEqual(NavigationPolicy.decide(url: URL(string: "file:///etc/passwd"), isMainFrame: true, isLinkActivation: true, origin: origin), .cancel)
        XCTAssertEqual(NavigationPolicy.decide(url: URL(string: "plannotator-snapshots://quit"), isMainFrame: true, isLinkActivation: true, origin: origin), .cancel)
        XCTAssertEqual(NavigationPolicy.decide(url: URL(string: "about:blank"), isMainFrame: false, isLinkActivation: false, origin: origin), .allow)
        XCTAssertEqual(NavigationPolicy.decide(url: URL(string: "about:blank"), isMainFrame: true, isLinkActivation: false, origin: origin), .cancel)
        XCTAssertEqual(NavigationPolicy.decide(url: hud, isMainFrame: true, isLinkActivation: false, origin: nil), .cancel, "nothing loads before the hub is known")
    }
}

final class TrustedCLITests: XCTestCase {
    private var dir: String!

    override func setUpWithError() throws {
        dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("snapshots-cli-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: dir)
    }

    private func file(_ name: String, mode: Int) throws -> String {
        let path = (dir as NSString).appendingPathComponent(name)
        FileManager.default.createFile(atPath: path, contents: Data("#!/bin/sh\n".utf8))
        try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: path)
        return path
    }

    func testValidatesSavedArgv() throws {
        let binary = try file("plannotator", mode: 0o755)
        let script = try file("index.ts", mode: 0o644)
        XCTAssertEqual(TrustedCLI.validate([binary]), [binary])
        XCTAssertEqual(TrustedCLI.validate([binary, script]), [binary, script])
        XCTAssertNil(TrustedCLI.validate([binary, "-c", "x"]), "no shell-style argv")
        XCTAssertNil(TrustedCLI.validate(["plannotator"]), "absolute paths only")
        XCTAssertNil(TrustedCLI.validate([]))
        XCTAssertNil(TrustedCLI.validate([dir]), "a directory is not a binary")
        XCTAssertNil(TrustedCLI.validate([(dir as NSString).appendingPathComponent("missing")]))
    }

    func testRefusesFilesOthersCanWriteOrRun() throws {
        let writable = try file("writable", mode: 0o777)
        XCTAssertNil(TrustedCLI.validate([writable]))
        let notExecutable = try file("plain", mode: 0o644)
        XCTAssertNil(TrustedCLI.validate([notExecutable]))
        let binary = try file("plannotator", mode: 0o755)
        XCTAssertNil(TrustedCLI.validate([binary], uid: getuid() &+ 4242), "owned by someone else")
    }

    func testResolveFallsBackToTheInstallLocation() throws {
        let home = (dir as NSString).appendingPathComponent("home")
        try FileManager.default.createDirectory(atPath: "\(home)/.local/bin", withIntermediateDirectories: true)
        let installed = "\(home)/.local/bin/plannotator"
        FileManager.default.createFile(atPath: installed, contents: Data("#!/bin/sh\n".utf8))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: installed)
        XCTAssertEqual(TrustedCLI.resolve(saved: ["/bin/sh", "-c", "payload"], home: home), [installed])
        XCTAssertEqual(TrustedCLI.resolve(saved: nil, home: home), [installed])
    }
}

final class DataDirRuleTests: XCTestCase {
    func testRules() {
        XCTAssertEqual(DataDirRule.resolve(saved: "/data/p", home: "/Users/a", xdgDataHome: nil, exists: { _ in true }), "/data/p")
        XCTAssertEqual(DataDirRule.resolve(saved: "relative", home: "/Users/a", xdgDataHome: nil, exists: { _ in true }), "/Users/a/.plannotator")
        XCTAssertEqual(DataDirRule.resolve(saved: nil, home: "/Users/a", xdgDataHome: "/x", exists: { _ in false }), "/x/plannotator")
        XCTAssertEqual(DataDirRule.resolve(saved: nil, home: "/Users/a", xdgDataHome: "/x", exists: { _ in true }), "/Users/a/.plannotator")
        XCTAssertEqual(DataDirRule.resolve(saved: nil, home: "/Users/a", xdgDataHome: "rel", exists: { _ in false }), "/Users/a/.plannotator")
    }
}
