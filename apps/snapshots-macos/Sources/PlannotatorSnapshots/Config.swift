import AppKit
import Foundation
import SnapshotsSecurity

/// Where Plannotator keeps its data and how to run its CLI. The app is started
/// by LaunchServices (never as a child of a terminal), so it has no shell
/// environment. The CLI tells it both with `defaults write ai.plannotator.snapshots`
/// (keys `dataDir` and `cli`) before it opens the app; never through the URL
/// scheme, which any process or web page can open (SnapshotsSecurity).
enum Config {
    private static let defaults = UserDefaults.standard

    /// `--data-dir` (this run only), else the data dir the CLI saved, else the
    /// getPlannotatorDataDir() rules: an existing ~/.plannotator, else
    /// $XDG_DATA_HOME/plannotator, else ~/.plannotator.
    static var dataDir: String {
        if let given = argument("--data-dir") { return given }
        return DataDirRule.resolve(
            saved: defaults.string(forKey: "dataDir"),
            home: NSHomeDirectory(),
            xdgDataHome: ProcessInfo.processInfo.environment["XDG_DATA_HOME"],
            exists: { FileManager.default.fileExists(atPath: $0) }
        )
    }

    /// `--data-dir <path>` / `--cli "<argv>"` on the command line: used for this run only, never saved (development, sandboxed runs).
    static func argument(_ name: String) -> String? {
        let args = CommandLine.arguments
        guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
        return args[index + 1]
    }

    /// The argv that runs `plannotator` (the compiled binary, or bun + script in development):
    /// `--cli` for this run, else the one the CLI saved, else the usual install locations.
    /// Every element must be a regular file owned by this user (or root) that nobody else can write.
    static var cli: [String]? {
        if let given = argument("--cli") { return TrustedCLI.validate(given.split(separator: " ").map(String.init)) }
        return TrustedCLI.resolve(saved: defaults.array(forKey: "cli") as? [String], home: NSHomeDirectory())
    }

    static var snapshotsDir: String { (dataDir as NSString).appendingPathComponent("snapshots") }
    static var incomingDir: String { (snapshotsDir as NSString).appendingPathComponent("incoming") }
    static var registryPath: String { (snapshotsDir as NSString).appendingPathComponent("hub.json") }
    static var logPath: String { (snapshotsDir as NSString).appendingPathComponent("app.log") }

    static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
}

/// One line per event in snapshots/app.log (never content: no text, no pixels).
func log(_ message: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
    let path = Config.logPath
    try? FileManager.default.createDirectory(atPath: Config.snapshotsDir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    if let handle = FileHandle(forWritingAtPath: path) {
        handle.seekToEndOfFile()
        handle.write(line.data(using: .utf8)!)
        try? handle.close()
    } else {
        FileManager.default.createFile(atPath: path, contents: line.data(using: .utf8), attributes: [.posixPermissions: 0o600])
    }
}

extension NSScreen {
    var displayID: CGDirectDisplayID {
        (deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
    }

    static var withMouse: NSScreen {
        let point = NSEvent.mouseLocation
        return NSScreen.screens.first { NSMouseInRect(point, $0.frame, false) } ?? NSScreen.main ?? NSScreen.screens[0]
    }
}

/// Global window coordinates (top-left origin, CGWindowList) ↔ AppKit screen coordinates (bottom-left origin).
enum Coords {
    static var primaryHeight: CGFloat { NSScreen.screens.first?.frame.height ?? 0 }

    static func toAppKit(_ rect: CGRect) -> CGRect {
        CGRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
    }

    static func toGlobal(_ rect: CGRect) -> CGRect {
        CGRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
    }
}
