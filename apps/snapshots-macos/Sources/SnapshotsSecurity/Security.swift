import Foundation

// The trust decisions of Plannotator Snapshots.app, kept pure so they can be
// unit tested (Tests/SnapshotsSecurityTests) and checked by `--selftest`.
//
// The app answers a URL scheme (`plannotator-snapshots://`) that ANY process or
// web page can open, so nothing in such a URL is trusted beyond an action
// name: never a path, never a program to run. Where the data lives and which
// `plannotator` binary starts the hub come from the app's own defaults (written
// by the CLI with `defaults write ai.plannotator.snapshots …`, which only a
// local process can do) or from the usual install locations, and the binary
// must be a regular executable owned by this user (or root) that nobody else
// can write. The HUD page, which holds a HUD token and talks to the native app
// through the `snapshots` message handler, may only come from the hub on
// loopback.

/// A command from the URL scheme. Only the action and the capture kind are read; every other query item is ignored.
public enum URLCommand: Equatable {
    case capture(kind: String)
    case show
    case quit

    public static let scheme = "plannotator-snapshots"
    /// The capture kinds the app knows; anything else reads as a Screen Capture.
    public static let kinds: Set<String> = ["region", "app", "app-pick"]

    public static func parse(_ text: String) -> URLCommand? {
        guard let url = URLComponents(string: text), url.scheme?.lowercased() == scheme else { return nil }
        switch url.host?.lowercased() {
        case "capture":
            let kind = url.queryItems?.first { $0.name == "kind" }?.value ?? ""
            return .capture(kind: kinds.contains(kind) ? kind : "region")
        case "show":
            return .show
        case "quit":
            return .quit
        default:
            return nil
        }
    }
}

/// The hub's origin as the registry names it: `http://127.0.0.1:<port>` or `http://localhost:<port>`, nothing else.
public struct HubOrigin: Equatable {
    public let host: String
    public let port: Int

    public static let loopbackHosts: Set<String> = ["127.0.0.1", "localhost"]

    /// Accepts exactly `http://<loopback>:<port>` (an optional trailing slash), with the port the registry names.
    public init?(hubURL: String, port expected: Int) {
        guard let url = URLComponents(string: hubURL),
              url.scheme == "http",
              let host = url.host?.lowercased(), HubOrigin.loopbackHosts.contains(host),
              let port = url.port, port == expected, port > 0, port < 65536,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/"
        else { return nil }
        self.host = host
        self.port = port
    }

    public var base: String { "http://\(host):\(port)" }

    /// A URL on this origin (same scheme, host and port).
    public func contains(_ url: URL?) -> Bool {
        guard let url, url.scheme?.lowercased() == "http", url.host?.lowercased() == host else { return false }
        return url.port == port
    }

    /// A WebKit security origin (`WKSecurityOrigin`'s protocol, host and port) is this one.
    public func matches(protocol scheme: String, host other: String, port otherPort: Int) -> Bool {
        scheme.lowercased() == "http" && other.lowercased() == host && otherPort == port
    }
}

/// What the HUD's web view does with a navigation.
public enum NavigationDecision: Equatable {
    case allow
    case cancel
    /// A link the person followed to a web page: opened in their browser, never in the HUD.
    case openExternally
}

public enum NavigationPolicy {
    /// Only the hub's own pages load in the HUD. A link the person activates to an
    /// http(s) page opens in their browser; everything else is cancelled.
    public static func decide(url: URL?, isMainFrame: Bool, isLinkActivation: Bool, origin: HubOrigin?) -> NavigationDecision {
        guard let url else { return .cancel }
        if let origin, origin.contains(url) { return .allow }
        if !isMainFrame, url.scheme?.lowercased() == "about" { return .allow }
        if isLinkActivation, isOpenableExternally(url) { return .openExternally }
        return .cancel
    }

    public static func isOpenableExternally(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { return false }
        return !(url.host ?? "").isEmpty && url.user == nil && url.password == nil
    }
}

/// Where the `plannotator` CLI is.
public enum TrustedCLI {
    /// Where the installers put the binary, in the order they are tried.
    public static func defaultCandidates(home: String) -> [String] {
        [
            (home as NSString).appendingPathComponent(".local/bin/plannotator"),
            "/usr/local/bin/plannotator",
            "/opt/homebrew/bin/plannotator",
        ]
    }

    /// An absolute path to a regular, executable file (symlinks followed) owned by this user or root and not writable by group or others.
    public static func isTrustedFile(_ path: String, executable: Bool, uid: uid_t = getuid()) -> Bool {
        guard path.hasPrefix("/") else { return false }
        let resolved = (path as NSString).resolvingSymlinksInPath
        var info = stat()
        guard stat(resolved, &info) == 0 else { return false }
        guard (info.st_mode & S_IFMT) == S_IFREG else { return false }
        guard info.st_uid == uid || info.st_uid == 0 else { return false }
        guard (info.st_mode & (S_IWGRP | S_IWOTH)) == 0 else { return false }
        if executable && (info.st_mode & S_IXUSR) == 0 { return false }
        return true
    }

    /// A saved argv (`[binary]`, or `[bun, script]` in development) when every element is a trusted file.
    public static func validate(_ argv: [String]?, uid: uid_t = getuid()) -> [String]? {
        guard let argv, let first = argv.first, argv.count <= 2 else { return nil }
        guard isTrustedFile(first, executable: true, uid: uid) else { return nil }
        if argv.count == 2 && !isTrustedFile(argv[1], executable: false, uid: uid) { return nil }
        return argv
    }

    /// The argv that runs `plannotator`: the saved one when it checks out, else the first trusted default location.
    public static func resolve(saved: [String]?, home: String, uid: uid_t = getuid()) -> [String]? {
        if let valid = validate(saved, uid: uid) { return valid }
        for candidate in defaultCandidates(home: home) where isTrustedFile(candidate, executable: true, uid: uid) {
            return [candidate]
        }
        return nil
    }
}

/// Where Plannotator keeps its data, as getPlannotatorDataDir() decides it.
public enum DataDirRule {
    /// A saved data dir (written by the CLI with `defaults write`) when absolute, else an existing
    /// ~/.plannotator, else $XDG_DATA_HOME/plannotator when absolute, else ~/.plannotator.
    public static func resolve(saved: String?, home: String, xdgDataHome: String?, exists: (String) -> Bool) -> String {
        if let saved, saved.hasPrefix("/"), !saved.contains("\0") { return (saved as NSString).standardizingPath }
        let legacy = (home as NSString).appendingPathComponent(".plannotator")
        if exists(legacy) { return legacy }
        if let xdg = xdgDataHome, xdg.hasPrefix("/") { return (xdg as NSString).appendingPathComponent("plannotator") }
        return legacy
    }
}
