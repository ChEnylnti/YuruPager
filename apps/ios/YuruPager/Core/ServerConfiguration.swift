import Foundation

public struct ServerConfiguration: Equatable, Sendable {
    /// Resolution order for the pre-filled login address:
    ///
    /// 1. The `YuruPagerDefaultServerAddress` Info.plist value, injected at
    ///    build time from the `YURUPAGER_DEFAULT_SERVER_ADDRESS` build
    ///    setting (see apps/ios/README.md).
    /// 2. The example origin below when the setting is empty or absent —
    ///    for example in `swift build` / `swift run yurupager-core-checks`
    ///    where there is no app Info.plist.
    ///
    /// No real deployment origin is committed to the repository.
    public static let defaultAddress: String = {
        let configured = Bundle.main.object(forInfoDictionaryKey: "YuruPagerDefaultServerAddress")
            as? String
        let trimmed = (configured ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "https://yurupager.example.com/" : trimmed
    }()

    public let baseURL: URL

    public init?(address: String) {
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              components.host != nil else { return nil }
        if !components.path.hasSuffix("/") { components.path += "/" }
        components.query = nil
        components.fragment = nil
        guard let url = components.url else { return nil }
        baseURL = url
    }

    public func url(for relativePath: String) -> URL {
        let path = relativePath.hasPrefix("/") ? String(relativePath.dropFirst()) : relativePath
        return URL(string: path, relativeTo: baseURL)!.absoluteURL
    }

    public var liveURL: URL {
        var components = URLComponents(url: url(for: "api/live"), resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        return components.url!
    }

    public var isTransportAllowed: Bool {
        if baseURL.scheme == "https" { return true }
        return baseURL.host == "localhost" || baseURL.host == "127.0.0.1"
    }
}
