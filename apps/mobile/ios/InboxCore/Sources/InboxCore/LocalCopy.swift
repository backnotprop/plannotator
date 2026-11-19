import CryptoKit
import Foundation
import InboxWire

/// The phone's copy of one computer's list and threads, so the app opens on what it last read and stays readable
/// while the computer is away. Files in the app's own folder, protected until the first unlock and left out of
/// backups (SPEC 1.5). Brief S1 names SQLite; plain files hold the same data for this slice.
public struct LocalCopy: Sendable {
  public let folder: URL?

  /// `folder` nil keeps nothing (the demo, and tests that do not ask for a copy).
  public init(folder: URL?) { self.folder = folder }

  public static func folder(root: URL, computer id: String) -> URL {
    root.appendingPathComponent("computers", isDirectory: true).appendingPathComponent(name(id), isDirectory: true)
  }

  static func name(_ id: String) -> String {
    SHA256.hash(data: Data(id.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
  }

  private func file(_ name: String) -> URL? { folder?.appendingPathComponent(name) }

  private func write(_ data: Data, to name: String) {
    guard let folder, let file = file(name) else { return }
    do {
      try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
      try data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      var values = URLResourceValues()
      values.isExcludedFromBackup = true
      var target = folder
      try? target.setResourceValues(values)
    } catch {
      // A copy that cannot be written is only a slower next open.
    }
  }

  private func read(_ name: String) -> Data? { file(name).flatMap { try? Data(contentsOf: $0) } }

  public func saveList(_ model: ListModel) { if let data = try? JSONEncoder().encode(model) { write(data, to: "list.json") } }
  public func list() -> ListModel? { read("list.json").flatMap { try? DoorClient.readList($0).model } }

  public func saveThread(_ model: ThreadModel) {
    if let data = try? JSONEncoder().encode(model) { write(data, to: "thread-\(Self.name(model.thread.threadId.rawValue)).json") }
  }

  public func thread(_ id: ThreadID) -> ThreadModel? {
    read("thread-\(Self.name(id.rawValue)).json").flatMap { try? JSONDecoder().decode(ThreadModel.self, from: $0) }
  }

  public func saveOutbox(_ writes: [HeldWrite]) { if let data = try? JSONEncoder().encode(writes) { write(data, to: "outbox.json") } }
  public func outbox() -> [HeldWrite] { read("outbox.json").flatMap { try? JSONDecoder().decode([HeldWrite].self, from: $0) } ?? [] }

  /// Words a refused Send gave back to the person, and why, by thread: kept until the composer takes them.
  public struct GivenBack: Codable, Hashable, Sendable {
    public var words: String
    public var notice: InboxSession.Notice?
  }

  public func saveGivenBack(_ kept: [String: GivenBack]) { if let data = try? JSONEncoder().encode(kept) { write(data, to: "given-back.json") } }
  public func givenBack() -> [String: GivenBack] { read("given-back.json").flatMap { try? JSONDecoder().decode([String: GivenBack].self, from: $0) } ?? [:] }

  /// Erase the copies of computers this phone is no longer paired with (a removal that was cut short).
  public static func sweep(root: URL, keeping ids: [String]) {
    let folder = root.appendingPathComponent("computers", isDirectory: true)
    let keep = Set(ids.map(name))
    for item in (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] where !keep.contains(item.lastPathComponent) {
      try? FileManager.default.removeItem(at: item)
    }
  }

  /// Remove this computer: its copy goes with its Keychain item.
  public func erase() {
    guard let folder else { return }
    try? FileManager.default.removeItem(at: folder)
  }
}

/// A write the person made that has no definite answer yet. Its key never changes: across retries, paths and
/// restarts the door sees one intent.
public struct HeldWrite: Codable, Hashable, Sendable, Identifiable {
  public enum Kind: String, Codable, Sendable { case pick, reply, seen, action }

  /// The idempotency key.
  public var id: String
  public var kind: Kind
  public var thread: String
  public var message: String?
  /// The door route's name, as `health.door.routes` lists it.
  public var route: String
  public var method: String
  public var path: String
  public var body: Data
  public var madeAt: Date
  /// A reply's words, kept so a refusal can hand them back to the person.
  public var words: String?
  /// How many times this pick was saved again over another place's answer (PickConflict).
  public var tries: Int?
  /// True once this write has waited for the computer: made while it was away, or sent and not answered.
  public var waited: Bool?
  /// A note typed under a marked action item: its refusal, when the item moved on meanwhile, is not the person's to act on.
  public var quiet: Bool?
}
