import Foundation
import Security

/// One computer this phone is paired with: what the pair exchange answered.
public struct PairedComputer: Codable, Hashable, Sendable, Identifiable {
  /// The device id the computer gave this phone (`dev_…`): one per pairing.
  public var id: String
  public var name: String
  /// The door's bearer. Never leaves the Keychain except in a request to that door.
  public var token: String
  /// The pairing secret: the root of the relay keys.
  public var secret: String
  public var addresses: [DoorAddress]
  public var relayURL: String?
  public var mailboxID: String?

  public init(id: String, name: String, token: String, secret: String, addresses: [DoorAddress], relayURL: String? = nil, mailboxID: String? = nil) {
    self.id = id
    self.name = name
    self.token = token
    self.secret = secret
    self.addresses = addresses
    self.relayURL = relayURL
    self.mailboxID = mailboxID
  }
}

public protocol CredentialStore: Sendable {
  func all() throws -> [PairedComputer]
  func save(_ computer: PairedComputer) throws
  func remove(id: String) throws
}

public struct KeychainFailure: Error, Sendable { public var status: OSStatus }

/// The Keychain: this device only, readable after the first unlock (so a notification can be opened while locked),
/// never synced. Brief S1 also asks for an access group the notification extension shares: that needs the
/// owner's Team ID and comes with the extension.
public struct KeychainCredentialStore: CredentialStore {
  public var service: String

  public init(service: String = "ai.plannotator.inbox.computers") { self.service = service }

  private func query(_ id: String? = nil) -> [String: Any] {
    var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrSynchronizable as String: false]
    if let id { query[kSecAttrAccount as String] = id }
    return query
  }

  public func all() throws -> [PairedComputer] {
    var query = query()
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    query[kSecReturnData as String] = true
    query[kSecReturnAttributes as String] = true
    var found: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &found)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess else { throw KeychainFailure(status: status) }
    let items = (found as? [[String: Any]]) ?? []
    return items.compactMap { item in (item[kSecValueData as String] as? Data).flatMap { try? JSONDecoder().decode(PairedComputer.self, from: $0) } }
      .sorted { $0.id < $1.id }
  }

  public func save(_ computer: PairedComputer) throws {
    let data = try JSONEncoder().encode(computer)
    var status = SecItemUpdate(query(computer.id) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var item = query(computer.id)
      item[kSecValueData as String] = data
      item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      status = SecItemAdd(item as CFDictionary, nil)
    }
    guard status == errSecSuccess else { throw KeychainFailure(status: status) }
  }

  public func remove(id: String) throws {
    let status = SecItemDelete(query(id) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainFailure(status: status) }
  }
}

/// Credentials kept in memory: the tests, and the demo's stand-in computer.
public final class MemoryCredentialStore: CredentialStore, @unchecked Sendable {
  private let lock = NSLock()
  private var items: [String: PairedComputer] = [:]

  public init(_ computers: [PairedComputer] = []) { for computer in computers { items[computer.id] = computer } }

  public func all() -> [PairedComputer] { lock.withLock { items.values.sorted { $0.id < $1.id } } }
  public func save(_ computer: PairedComputer) { lock.withLock { items[computer.id] = computer } }
  public func remove(id: String) { lock.withLock { items[id] = nil } }
}
