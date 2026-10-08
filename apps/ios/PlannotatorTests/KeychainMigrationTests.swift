import PlannotatorKit
import Security
import XCTest

/// Runs inside the app (its entitlements, its Keychain groups): an item an
/// earlier build saved in the app's own access group moves into the group the
/// notification extension shares, and nothing is left behind.
final class KeychainMigrationTests: XCTestCase {
    private let service = "ai.plannotator.app.inbox-device"
    private let device = "dev_00000000000000000000000099"

    override func tearDown() {
        Keychain.delete(device: device)
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: device] as CFDictionary)
    }

    func testAnItemFromAnEarlierBuildMovesIntoTheSharedGroup() throws {
        // As M1 saved it: no access group, so the app's own (its application identifier).
        let credential = DeviceCredential(token: "tok_test", secret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
        let add: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: device,
            kSecValueData as String: try JSONEncoder().encode(credential),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        XCTAssertEqual(SecItemAdd(add as CFDictionary, nil), errSecSuccess)
        XCTAssertNil(Keychain.load(device: device), "the shared group does not hold it yet")
        XCTAssertFalse(Keychain.all().contains { $0.device == device })

        Keychain.migrate()

        XCTAssertEqual(Keychain.load(device: device), credential)
        XCTAssertTrue(Keychain.all().contains { $0.device == device && $0.credential == credential }, "the extension sees it")
        XCTAssertEqual(groups(of: device), [Keychain.group], "no copy left in the app's own group")
        Keychain.migrate()
        XCTAssertEqual(groups(of: device), [Keychain.group], "a second run changes nothing")
    }

    private func groups(of device: String) -> [String] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: device,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var items: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &items) == errSecSuccess, let rows = items as? [[String: Any]] else { return [] }
        return rows.compactMap { $0[kSecAttrAccessGroup as String] as? String }
    }
}
