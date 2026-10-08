import AppKit

// `PlannotatorSnapshots --selftest <dir>`: run the capture code paths with no UI
// (freeze every display, crop, capture the frontmost window on its own, read
// its accessibility text) and print what came back. Run straight from a
// terminal it uses that terminal's Screen Recording grant, so it can be checked
// without granting anything to the app.
let arguments = CommandLine.arguments
if let index = arguments.firstIndex(of: "--selftest") {
    let dir = arguments.count > index + 1 ? arguments[index + 1] : NSTemporaryDirectory()
    _ = NSApplication.shared
    SelfTest.run(into: dir)
    exit(0)
}

MainActor.assumeIsolated {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
}
