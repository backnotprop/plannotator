import Foundation

/// The app's client for the Plannotator Shots hub (`plannotator screenshot hub`):
/// reads `shots/hub.json`, starts the hub when it is not running, and
/// registers captures. The HUD page talks to the hub itself.
final class Hub {
    struct Entry: Decodable {
        let v: Int
        let pid: Int
        let port: Int
        let url: String
        let token: String
        let serverSession: String
        let cli: [String]?
    }

    struct Attached {
        let entry: Entry
        let hudToken: String
    }

    struct CaptureAnswer: Decodable {
        struct ShotRef: Decodable { let id: String; let captureId: String }
        let shot: ShotRef
        let collectionId: String
        let first: Bool
        let count: Int
    }

    private(set) var attached: Attached?

    func readEntry() -> Entry? {
        guard let data = FileManager.default.contents(atPath: Config.registryPath) else { return nil }
        return try? JSONDecoder().decode(Entry.self, from: data)
    }

    private func healthy(_ entry: Entry) async -> Bool {
        guard let url = URL(string: "\(entry.url)/api/shots/health") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.5
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return false }
        return body["serverSession"] as? String == entry.serverSession
    }

    /// The running hub, started if needed. Throws when it cannot be reached.
    func ensureRunning() async throws -> Entry {
        if let entry = readEntry(), await healthy(entry) { return entry }
        guard let cli = Config.cli ?? readEntry()?.cli else {
            throw HubError.message("Plannotator Shots does not know where the plannotator CLI is yet. Run `plannotator screenshot` once.")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: cli[0])
        process.arguments = Array(cli.dropFirst()) + ["screenshot", "hub", "--background"]
        var env = ProcessInfo.processInfo.environment
        env["PLANNOTATOR_DATA_DIR"] = Config.dataDir
        process.environment = env
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        log("starting the hub: \(cli.joined(separator: " "))")
        for _ in 0..<150 {
            try await Task.sleep(nanoseconds: 100_000_000)
            if let entry = readEntry(), await healthy(entry) { return entry }
        }
        throw HubError.message("The Plannotator Shots hub did not start; see \(Config.shotsDir)/hub.out.")
    }

    /// A HUD token for the panel. Again whenever the hub restarted (its token rotates).
    func attach() async throws -> Attached {
        let entry = try await ensureRunning()
        if let attached, attached.entry.serverSession == entry.serverSession { return attached }
        let body = try await post(entry: entry, token: entry.token, path: "/api/shots/attach", json: [:])
        guard let hudToken = body["hudToken"] as? String else { throw HubError.message("The hub refused to attach.") }
        let fresh = Attached(entry: entry, hudToken: hudToken)
        attached = fresh
        log("attached to the hub on port \(entry.port)")
        return fresh
    }

    /// The data dir changed: the next attach reads the new registry.
    func resetAttachment() {
        attached = nil
    }

    /// True when the hub we attached to is no longer the one running.
    func needsReattach() async -> Bool {
        guard let attached else { return true }
        guard let entry = readEntry(), entry.serverSession == attached.entry.serverSession else { return true }
        return !(await healthy(entry))
    }

    func registerCapture(_ capture: [String: Any]) async throws -> CaptureAnswer {
        let attached = try await attach()
        let data = try await postData(entry: attached.entry, token: attached.hudToken, path: "/api/shots/capture", json: capture)
        return try JSONDecoder().decode(CaptureAnswer.self, from: data)
    }

    @discardableResult
    func post(entry: Entry, token: String, path: String, json: [String: Any]) async throws -> [String: Any] {
        let data = try await postData(entry: entry, token: token, path: path, json: json)
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    private func postData(entry: Entry, token: String, path: String, json: [String: Any]) async throws -> Data {
        guard let url = URL(string: "\(entry.url)\(path)") else { throw HubError.message("Bad hub URL") }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        request.httpBody = try JSONSerialization.data(withJSONObject: json)
        request.timeoutInterval = 15
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw HubError.message(message ?? "The hub answered \(status).")
        }
        return data
    }
}

enum HubError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self {
        case .message(let text): return text
        }
    }
}
