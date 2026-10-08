import AppKit

// `PlannotatorSnapshots --selftest <dir>`: run the capture code paths with no UI
// (freeze every display, crop, capture the frontmost window on its own, read
// its accessibility text) and print what came back. Run straight from a
// terminal it uses that terminal's Screen Recording grant, so it can be checked
// without granting anything to the app. `--ax-app <bundle id>` reads that running
// app's front window instead of the frontmost one.
let arguments = CommandLine.arguments
if let index = arguments.firstIndex(of: "--selftest") {
    let dir = arguments.count > index + 1 && !arguments[index + 1].hasPrefix("--") ? arguments[index + 1] : NSTemporaryDirectory()
    let axApp = arguments.firstIndex(of: "--ax-app").flatMap { arguments.count > $0 + 1 ? arguments[$0 + 1] : nil }
    _ = NSApplication.shared
    let passed = SelfTest.run(into: dir, axApp: axApp)
    exit(passed ? 0 : 1)
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
}
