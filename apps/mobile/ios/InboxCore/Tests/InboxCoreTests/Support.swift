import Foundation
import XCTest
@testable import InboxCore
import InboxStandIn
import InboxWire

/// apps/mobile/contract/vectors: what the product's own code makes of the contract's fixtures. A suite whose file
/// is not in the checkout yet is skipped by name (never passed silently). INBOX_CONTRACT_DIR points the runner at
/// another copy of the contract folder.
enum Contract {
  static var folder: URL {
    if let other = ProcessInfo.processInfo.environment["INBOX_CONTRACT_DIR"] { return URL(fileURLWithPath: other, isDirectory: true) }
    // Tests/InboxCoreTests/Support.swift → apps/mobile/contract
    return URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .appendingPathComponent("contract", isDirectory: true)
  }

  static func json(_ path: String) throws -> JSONValue {
    let file = folder.appendingPathComponent(path)
    guard FileManager.default.fileExists(atPath: file.path) else { throw XCTSkip("apps/mobile/contract/\(path) is not in this checkout yet") }
    return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: file))
  }
}

extension JSONValue {
  subscript(_ key: String) -> JSONValue? {
    if case .object(let fields) = self { return fields[key] }
    return nil
  }
  var items: [JSONValue] {
    if case .array(let items) = self { return items }
    return []
  }
  var text: String? {
    if case .string(let text) = self { return text }
    return nil
  }
  var flag: Bool? {
    if case .bool(let flag) = self { return flag }
    return nil
  }
  var whole: Int? {
    if case .number(let number) = self { return Int(number) }
    return nil
  }
  var strings: [String] { items.compactMap(\.text) }
  /// A field a vector must have: missing, it fails the one test that asked, never the whole run.
  func at(_ key: String, file: StaticString = #filePath, line: UInt = #line) throws -> JSONValue { try XCTUnwrap(self[key], "the vector has no \"\(key)\"", file: file, line: line) }
  func str(file: StaticString = #filePath, line: UInt = #line) throws -> String { try XCTUnwrap(text, "not a string", file: file, line: line) }
  func int(file: StaticString = #filePath, line: UInt = #line) throws -> Int { try XCTUnwrap(whole, "not a number", file: file, line: line) }
  func decoded<T: Decodable>(_ type: T.Type) throws -> T { try JSONDecoder().decode(type, from: JSONEncoder().encode(self)) }
  static func of<T: Encodable>(_ value: T) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value)) }
  /// The same value with one field of an object left out.
  func without(_ key: String) -> JSONValue {
    guard case .object(var fields) = self else { return self }
    fields[key] = nil
    return .object(fields)
  }
}

let testApp = AppIdentity(version: "0.1.0")

/// A paired phone and its stand-in computer.
@MainActor
func pairedSession(door: StandInDoor, copy: LocalCopy = LocalCopy(folder: nil)) async -> InboxSession {
  let issued = await door.issueToken()
  let computer = PairedComputer(id: issued.device.rawValue, name: "Work Mac", token: issued.token, secret: "s", addresses: [])
  return InboxSession(computer: computer, app: testApp, copy: copy) { _ in [StandInTransport(door: door)] }
}

func body(_ call: DoorCall) -> JSONValue { (try? JSONDecoder().decode(JSONValue.self, from: call.body ?? Data())) ?? .null }

extension StandInDoor {
  func posts(_ suffix: String) -> [DoorCall] { calls.filter { $0.method == .post && $0.path.hasSuffix(suffix) } }
}
