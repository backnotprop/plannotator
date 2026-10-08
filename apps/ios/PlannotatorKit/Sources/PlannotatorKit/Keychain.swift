import Foundation
import Security

/// What a paired phone keeps secret about one computer: its bearer token and
/// the pairing secret the relay keys are derived from (contract sections 2
/// and 4). One Keychain item per paired device, readable after the first
/// unlock and never synced or restored to another device, in the access group
/// the app shares with its notification service extension, which opens a
/// push's envelope with the key derived from the secret.
public struct DeviceCredential: Codable, Equatable, Sendable {
    public var token: String
    public var secret: String

    public init(token: String, secret: String) {
        self.token = token
        self.secret = secret
    }
}

public enum Keychain {
    static let service = "ai.plannotator.app.inbox-device"
    /// The app group, which is also a Keychain access group for the app and its extension.
    public static let group = "group.ai.plannotator.app"

    public static func save(_ credential: DeviceCredential, device: String) {
        let data = (try? JSONEncoder().encode(credential)) ?? Data()
        let query = base(device)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        if SecItemUpdate(query as CFDictionary, attributes as CFDictionary) == errSecItemNotFound {
            SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        }
    }

    public static func load(device: String) -> DeviceCredential? {
        var query = base(device)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(DeviceCredential.self, from: data)
    }

    /// Every paired device's credential, by device id: the extension tries each key on a push.
    public static func all() -> [(device: String, credential: DeviceCredential)] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccessGroup as String: group,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var items: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &items) == errSecSuccess, let rows = items as? [[String: Any]] else { return [] }
        return rows.compactMap { row in
            guard let device = row[kSecAttrAccount as String] as? String, let data = row[kSecValueData as String] as? Data,
                  let credential = try? JSONDecoder().decode(DeviceCredential.self, from: data) else { return nil }
            return (device, credential)
        }
    }

    public static func delete(device: String) {
        SecItemDelete(base(device) as CFDictionary)
    }

    /// Every item this app wrote (a fresh start after the app was deleted keeps
    /// Keychain items on iOS; the app clears what no paired source names).
    public static func deleteAll() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccessGroup as String: group] as CFDictionary)
    }

    static func base(_ device: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccessGroup as String: group, kSecAttrAccount as String: device]
    }
}
