import Foundation
import Security

/// The recorder key, kept in the Keychain on this phone only. Readable after the first unlock so a
/// background sync can use it; never synced to iCloud or included in backups to other devices.
enum KeyStore {
    private static let service = "com.openplod.companion.recorder-key"

    static func save(_ key: RecorderKey) throws {
        let data = try JSONEncoder().encode(StoredKey(key))
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccount as String] = key.serial
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw CompanionFailure("Could not save the recorder key (\(status)).") }
    }

    static func load() -> RecorderKey? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                    kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data,
              let stored = try? JSONDecoder().decode(StoredKey.self, from: data) else { return nil }
        return stored.key
    }

    static func remove() {
        SecItemDelete([kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service] as CFDictionary)
    }

    /// Codable mirror of the generated `RecorderKey` record.
    private struct StoredKey: Codable {
        let serial, bindingToken, signature, privateKey: String
        init(_ key: RecorderKey) { serial = key.serial; bindingToken = key.bindingToken; signature = key.signature; privateKey = key.privateKey }
        var key: RecorderKey { RecorderKey(serial: serial, bindingToken: bindingToken, signature: signature, privateKey: privateKey) }
    }
}

struct CompanionFailure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
