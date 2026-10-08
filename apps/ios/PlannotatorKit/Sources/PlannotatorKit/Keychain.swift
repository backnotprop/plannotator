import Foundation
import Security

/// What a paired phone keeps secret about one computer: its bearer token and
/// the pairing secret the relay keys are later derived from (contract
/// sections 2 and 4). One Keychain item per paired device, readable after the
/// first unlock and never synced or restored to another device.
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

    public static func delete(device: String) {
        SecItemDelete(base(device) as CFDictionary)
    }

    /// Every item this app wrote (a fresh start after the app was deleted keeps
    /// Keychain items on iOS; the app clears what no paired source names).
    public static func deleteAll() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
    }

    static func base(_ device: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: device]
    }
}
