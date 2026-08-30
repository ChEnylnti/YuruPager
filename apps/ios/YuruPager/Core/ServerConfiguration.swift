import Foundation

public struct ServerConfiguration: Equatable, Sendable {
    public static let defaultAddress = "https://117.50.192.44/yurupager/"

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
