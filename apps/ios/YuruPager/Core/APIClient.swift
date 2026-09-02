import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct APIError: Error, LocalizedError, Sendable {
    public let status: Int
    public let code: String
    public let message: String
    public let details: JSONValue?

    public var errorDescription: String? { message }

    public func decodeDetails<T: Decodable>(_ type: T.Type) -> T? {
        guard let details, let data = try? JSONEncoder().encode(details) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }
}

public actor APIClient {
    private struct UserEnvelope: Decodable, Sendable { let user: UserSummary }
    private struct ErrorEnvelope: Decodable, Sendable {
        struct Body: Decodable, Sendable {
            let code: String?
            let message: String?
            let details: JSONValue?
        }
        let error: Body?
    }
    private struct SessionCommandAttachment: Encodable, Sendable { let ticket: String }
    private struct SessionCommandBody: Encodable, Sendable {
        let content: String
        let attachments: [SessionCommandAttachment]
    }

    private let configuration: ServerConfiguration
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    public init(configuration: ServerConfiguration, session: URLSession = .shared) {
        self.configuration = configuration
        self.session = session
    }

    public func currentUser() async throws -> UserSummary {
        let envelope: UserEnvelope = try await request("api/auth/me")
        return envelope.user
    }

    public func login(email: String, password: String) async throws -> UserSummary {
        let envelope: UserEnvelope = try await request(
            "api/auth/login",
            method: "POST",
            body: ["email": email, "password": password]
        )
        return envelope.user
    }

    public func logout() async throws {
        let _: EmptyResponse = try await request("api/auth/logout", method: "POST")
    }

    // MARK: Planning workflows (run monitoring + gate approval; no editing on iOS)

    public func workflows(workspaceId: String) async throws -> [WorkflowSummary] {
        try await request("api/workflows?workspaceId=\(workspaceId)")
    }

    public func workflowRuns(workflowId: String, workspaceId: String) async throws -> [WorkflowRunSummary] {
        try await request("api/workflows/\(workflowId)/runs?workspaceId=\(workspaceId)")
    }

    public func cancelWorkflowRun(runId: String, workspaceId: String) async throws -> WorkflowRunSummary {
        try await request(
            "api/workflow-runs/\(runId)/cancel",
            method: "POST",
            body: ["workspaceId": workspaceId]
        )
    }

    public func snapshot(workspaceId: String?) async throws -> Snapshot {
        var path = "api/snapshot"
        if let workspaceId {
            path += "?workspaceId=\(workspaceId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? workspaceId)"
        }
        return try await request(path)
    }

    public func decide(
        requestId: String,
        key: String,
        input: DecisionInput
    ) async throws -> DecisionResult {
        try await request(
            "api/requests/\(requestId)/decision",
            method: "POST",
            headers: ["Idempotency-Key": key],
            encodableBody: input
        )
    }

    public func sendMessage(
        sessionId: String,
        key: String,
        content: String,
        attachmentTickets: [String] = []
    ) async throws -> SessionCommandResult {
        try await request(
            "api/sessions/\(sessionId)/commands",
            method: "POST",
            headers: ["Idempotency-Key": key],
            encodableBody: SessionCommandBody(
                content: content,
                attachments: attachmentTickets.map { SessionCommandAttachment(ticket: $0) }
            )
        )
    }

    private func request<Response: Decodable & Sendable>(
        _ path: String,
        method: String = "GET",
        headers: [String: String] = [:],
        body: [String: String]? = nil
    ) async throws -> Response {
        let data = try body.map(encoder.encode)
        return try await requestData(path, method: method, headers: headers, body: data)
    }

    private func request<Response: Decodable & Sendable, Body: Encodable>(
        _ path: String,
        method: String,
        headers: [String: String],
        encodableBody: Body
    ) async throws -> Response {
        try await requestData(path, method: method, headers: headers, body: encoder.encode(encodableBody))
    }

    private func requestData<Response: Decodable & Sendable>(
        _ path: String,
        method: String,
        headers: [String: String],
        body: Data?
    ) async throws -> Response {
        var request = URLRequest(url: configuration.url(for: path))
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        for (field, value) in headers { request.setValue(value, forHTTPHeaderField: field) }
        request.httpBody = body

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError(status: 0, code: "invalid_response", message: "服务器响应无效", details: nil)
        }
        guard (200..<300).contains(http.statusCode) else {
            let envelope = try? decoder.decode(ErrorEnvelope.self, from: data)
            throw APIError(
                status: http.statusCode,
                code: envelope?.error?.code ?? "request_failed",
                message: envelope?.error?.message ?? "请求失败（\(http.statusCode)）",
                details: envelope?.error?.details
            )
        }
        if data.isEmpty { return EmptyResponse() as! Response }
        return try decoder.decode(Response.self, from: data)
    }
}

private struct EmptyResponse: Codable, Sendable {
    init() {}
}
