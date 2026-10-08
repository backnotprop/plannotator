import Foundation

/// One event from `GET events` (exchange 7.9): `hello` with the cursor the
/// stream starts from, then one `record` per store line, `id:` its seq.
public enum InboxEvent: Equatable, Sendable {
    case hello(cursor: Int)
    case record(seq: Int, kind: String)
}

extension InboxClient {
    /// The event stream after `cursor`: the lines the phone missed first, then
    /// live ones. It ends when the connection drops; the caller reconnects
    /// from the last seq it saw.
    public func events(after cursor: Int?) -> AsyncThrowingStream<InboxEvent, Error> {
        var events = request("events", query: cursor.map { [URLQueryItem(name: "cursor", value: String($0))] } ?? [])
        events.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        events.timeoutInterval = 60 // the Inbox sends a heartbeat every 15 s
        let request = events
        let stream = AsyncThrowingStream<InboxEvent, Error> { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await Self.session.bytes(for: request)
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    guard status == 200 else {
                        var data = Data()
                        for try await byte in bytes { data.append(byte) }
                        if let body = try? Self.decoder.decode(InboxErrorBody.self, from: data) {
                            throw InboxError.refused(status: status, code: body.code, message: body.error, triesLeft: body.triesLeft)
                        }
                        throw InboxError.unreachable
                    }
                    // Lines are split here, not with `bytes.lines`, which drops the
                    // blank line that ends an event.
                    var parser = ServerSentEvents()
                    var line: [UInt8] = []
                    for try await byte in bytes {
                        guard byte == 0x0A else { line.append(byte); continue }
                        if line.last == 0x0D { line.removeLast() }
                        if let event = parser.feed(String(decoding: line, as: UTF8.self)) { continuation.yield(event) }
                        line.removeAll(keepingCapacity: true)
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
        return stream
    }
}

/// The text/event-stream framing the Inbox writes: `id:`, `event:` and
/// `data:` lines, a blank line ends an event, `:` lines are heartbeats.
struct ServerSentEvents {
    private var name: String?
    private var id: String?
    private var data = ""

    mutating func feed(_ line: String) -> InboxEvent? {
        if line.isEmpty { return flush() }
        if line.hasPrefix(":") { return nil }
        let (field, value) = Self.split(line)
        switch field {
        case "event": name = value
        case "id": id = value
        case "data": data += data.isEmpty ? value : "\n" + value
        default: break
        }
        return nil
    }

    private mutating func flush() -> InboxEvent? {
        defer { name = nil; id = nil; data = "" }
        guard let name else { return nil }
        let json = (try? JSONSerialization.jsonObject(with: Data(data.utf8))) as? [String: Any]
        switch name {
        case "hello":
            guard let cursor = json?["cursor"] as? Int else { return nil }
            return .hello(cursor: cursor)
        case "record":
            guard let seq = (json?["seq"] as? Int) ?? id.flatMap(Int.init) else { return nil }
            return .record(seq: seq, kind: json?["kind"] as? String ?? "")
        default:
            return nil
        }
    }

    private static func split(_ line: String) -> (String, String) {
        guard let colon = line.firstIndex(of: ":") else { return (line, "") }
        var value = line[line.index(after: colon)...]
        if value.first == " " { value = value.dropFirst() }
        return (String(line[..<colon]), String(value))
    }
}
