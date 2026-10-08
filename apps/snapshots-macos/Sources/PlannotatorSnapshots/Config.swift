import AppKit
import Foundation

/// Where Plannotator keeps its data and how to run its CLI. The app is started
/// by LaunchServices (never as a child of a terminal), so it has no shell
/// environment: the CLI hands both over in the launch URL and they are kept in
/// UserDefaults for launches that come from elsewhere (login, a hotkey later).
enum Config {
    private static let defaults = UserDefaults.standard

    /// Mirrors getPlannotatorDataDir(): an existing ~/.plannotator wins, else
    /// $XDG_DATA_HOME/plannotator, else ~/.plannotator. A data dir passed by
    /// the CLI overrides both and is remembered.
    static var dataDir: String {
        if let given = argument("--data-dir") { return given }
        if let saved = defaults.string(forKey: "dataDir"), !saved.isEmpty { return saved }
        let home = NSHomeDirectory()
        let legacy = (home as NSString).appendingPathComponent(".plannotator")
        if FileManager.default.fileExists(atPath: legacy) { return legacy }
        if let xdg = ProcessInfo.processInfo.environment["XDG_DATA_HOME"], xdg.hasPrefix("/") {
            return (xdg as NSString).appendingPathComponent("plannotator")
        }
        return legacy
    }

    static func setDataDir(_ path: String) {
        if argument("--data-dir") != nil { return }
        defaults.set(path, forKey: "dataDir")
    }

    /// `--data-dir <path>` / `--cli "<argv>"` on the command line: used for this run only, never saved (development, sandboxed runs).
    static func argument(_ name: String) -> String? {
        let args = CommandLine.arguments
        guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
        return args[index + 1]
    }

    /// The argv that runs `plannotator` (the compiled binary, or bun + script in development).
    static var cli: [String]? {
        if let given = argument("--cli") { return given.split(separator: " ").map(String.init) }
        if let saved = defaults.array(forKey: "cli") as? [String], !saved.isEmpty { return saved }
        return nil
    }

    static func setCli(_ argv: [String]) {
        defaults.set(argv, forKey: "cli")
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
