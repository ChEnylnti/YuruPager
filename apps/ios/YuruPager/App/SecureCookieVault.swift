import Foundation
import Security

final class SecureCookieVault {
    private struct CookieRecord: Codable {
        let name: String
        let value: String
        let domain: String
        let path: String
        let expiresDate: Date?
        let isSecure: Bool
    }

    private let service = "com.yurupager.mobile.session-cookies"

    func restore(for baseURL: URL) {
        guard let data = read(),
              let records = try? JSONDecoder().decode([CookieRecord].self, from: data) else { return }
        let cookies = records.compactMap { record in
            var properties: [HTTPCookiePropertyKey: Any] = [
                .name: record.name,
                .value: record.value,
                .domain: record.domain,
                .path: record.path,
                .secure: record.isSecure ? "TRUE" : "FALSE",
            ]
            if let expiresDate = record.expiresDate { properties[.expires] = expiresDate }
            return HTTPCookie(properties: properties)
        }
        HTTPCookieStorage.shared.setCookies(cookies, for: baseURL, mainDocumentURL: nil)
    }

    func save(for baseURL: URL) {
        let records = (HTTPCookieStorage.shared.cookies(for: baseURL) ?? []).map {
            CookieRecord(
                name: $0.name,
                value: $0.value,
                domain: $0.domain,
                path: $0.path,
                expiresDate: $0.expiresDate,
                isSecure: $0.isSecure
            )
        }
        guard let data = try? JSONEncoder().encode(records) else { return }
        write(data)
    }

    func clear(for baseURL: URL) {
        for cookie in HTTPCookieStorage.shared.cookies(for: baseURL) ?? [] {
            HTTPCookieStorage.shared.deleteCookie(cookie)
        }
        clearPersisted()
    }

    func clearPersisted() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        SecItemDelete(query as CFDictionary)
    }

    private func read() -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
        return result as? Data
    }

    private func write(_ data: Data) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        let attributes: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insertion = query
            insertion[kSecValueData as String] = data
            insertion[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            SecItemAdd(insertion as CFDictionary, nil)
        }
    }
}
