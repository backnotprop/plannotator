import Foundation

/// One frame of the door's event stream (Server-Sent Events).
public struct EventFrame: Hashable, Sendable {
  public var event: String
  public var data: String
  public var id: String?
}

/// Reads Server-Sent Events from bytes cut at any place: a frame ends at a blank line, a line starting with a colon
/// is a comment (the door's `: ping`), and `data` lines join with a newline.
public struct EventStreamReader: Sendable {
  private var pending = Data()
  private var event = ""
  private var data: [String] = []
  private var id: String?
  /// The newest `id` seen: what a reconnect sends as `Last-Event-ID`.
  public private(set) var lastEventID: String?

  public init() {}

  public mutating func feed(_ bytes: Data) -> [EventFrame] {
    pending.append(bytes)
    var frames: [EventFrame] = []
    while let end = pending.firstIndex(where: { $0 == 0x0A || $0 == 0x0D }) {
      // A CR at the very end may be the first half of CRLF: wait for the next bytes.
      if pending[end] == 0x0D, end == pending.index(before: pending.endIndex) { break }
      let line = String(decoding: pending[pending.startIndex..<end], as: UTF8.self)
      var next = pending.index(after: end)
      if pending[end] == 0x0D, next < pending.endIndex, pending[next] == 0x0A { next = pending.index(after: next) }
      pending = Data(pending[next...])
      if let frame = take(line) { frames.append(frame) }
    }
    return frames
  }

  private mutating func take(_ line: String) -> EventFrame? {
    if line.isEmpty {
      defer {
        event = ""
        data = []
        id = nil
      }
      // A frame with no data is not dispatched (the SSE rule); its id still stands.
      guard !data.isEmpty else { return nil }
      return EventFrame(event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n"), id: id)
    }
    if line.hasPrefix(":") { return nil }
    let name: Substring
    var value: Substring
    if let colon = line.firstIndex(of: ":") {
      name = line[..<colon]
      value = line[line.index(after: colon)...]
      if value.hasPrefix(" ") { value = value.dropFirst() }
    } else {
      name = Substring(line)
      value = ""
    }
    switch name {
    case "event": event = String(value)
    case "data": data.append(String(value))
    case "id":
      if !value.contains("\0") {
        id = String(value)
        lastEventID = id
      }
    default: break
    }
    return nil
  }
}
