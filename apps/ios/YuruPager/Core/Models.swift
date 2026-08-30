import Foundation

public enum RequestStatus: String, Codable, Sendable, CaseIterable {
    case pending, approved, denied, expired, cancelled, interrupted
}

public enum DeliveryStatus: String, Codable, Sendable {
    case notQueued = "not_queued"
    case queued, sent, delivered, failed
    case sentUnknown = "sent_unknown"
}

public enum RiskLevel: String, Codable, Sendable {
    case low, medium, high
}

public enum WorkspaceRole: String, Codable, Sendable {
    case owner, admin, member
}

public enum WorkspaceKind: String, Codable, Sendable {
    case personal, company, team
}

public enum RequestKind: String, Codable, Sendable {
    case approval, question
}

public enum SessionCommandStatus: String, Codable, Sendable {
    case queued, delivered, failed
    case sentUnknown = "sent_unknown"
}

public struct UserSummary: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let email: String
    public let name: String
}

public struct WorkspaceSummary: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let slug: String
    public let kind: WorkspaceKind
    public let role: WorkspaceRole
    public let pendingCount: Int
}

public struct WorkstationSummary: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let workspaceId: String
    public let workspaceName: String
    public let name: String
    public let platform: String
    public let connectorVersion: String
    public let status: String
    public let lastSeenAt: String?
    public let activeSessionCount: Int
    public let pendingCount: Int
}

public struct SessionSummary: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let workspaceId: String
    public let workstationId: String
    public let workstationName: String
    public let initiatorName: String?
    public let threadId: String
    public let projectName: String
    public let projectPath: String
    public let model: String
    public let status: String
    public let syncState: String?
    public let startedAt: String
    public let updatedAt: String
}

public struct SessionCommandSummary: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let workspaceId: String
    public let workstationId: String
    public let sessionId: String
    public let actorName: String
    public let status: SessionCommandStatus
    public let contentLength: Int
    public let attachmentCount: Int
    public let turnId: String?
    public let errorCode: String?
    public let createdAt: String
    public let updatedAt: String
    public let deliveredAt: String?
}

public struct RequestedPermissions: Codable, Hashable, Sendable {
    public struct FileSystemPermission: Codable, Hashable, Sendable {
        public let access: String
        public let path: String
    }

    public let network: Bool?
    public let fileSystem: [FileSystemPermission]?
}

public struct RequestQuestion: Codable, Identifiable, Hashable, Sendable {
    public struct Option: Codable, Hashable, Sendable {
        public let label: String
        public let description: String
    }

    public let id: String
    public let header: String
    public let question: String
    public let isSecret: Bool
    public let options: [Option]
}

public struct RequestContext: Codable, Hashable, Sendable {
    public let command: String?
    public let cwd: String?
    public let reason: String?
    public let grantRoot: String?
    public let requestedPermissions: RequestedPermissions?
    public let questions: [RequestQuestion]?

    public init(
        command: String? = nil,
        cwd: String? = nil,
        reason: String? = nil,
        grantRoot: String? = nil,
        requestedPermissions: RequestedPermissions? = nil,
        questions: [RequestQuestion]? = nil
    ) {
        self.command = command
        self.cwd = cwd
        self.reason = reason
        self.grantRoot = grantRoot
        self.requestedPermissions = requestedPermissions
        self.questions = questions
    }
}

public struct RequestSummary: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let workspaceId: String
    public let workspaceName: String
    public let workstationId: String
    public let workstationName: String
    public let sessionId: String
    public let sessionInitiatorName: String?
    public let projectName: String
    public let kind: RequestKind
    public let category: String
    public let tool: String
    public let risk: RiskLevel
    public let context: RequestContext
    public let status: RequestStatus
    public let deliveryStatus: DeliveryStatus
    public let assignedToName: String?
    public let decidedByName: String?
    public let decisionReason: String?
    public let requestedAt: String
    public let expiresAt: String
    public let decidedAt: String?
}

public struct WorkstationAccess: Codable, Hashable, Sendable {
    public let workstationId: String
    public let workstationName: String
    public let canView: Bool
    public let canRespond: Bool
    public let canApproveHighRisk: Bool
    public let canManage: Bool
}

public struct MemberSummary: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let workspaceId: String
    public let userId: String
    public let name: String
    public let email: String
    public let role: WorkspaceRole
    public let workstationCount: Int
    public let workstationAccess: [WorkstationAccess]
}

public struct UsageSummary: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let workspaceId: String
    public let workstationId: String
    public let workstationName: String
    public let sessionId: String
    public let projectName: String
    public let model: String
    public let inputTokens: Int
    public let cachedInputTokens: Int
    public let outputTokens: Int
    public let reasoningTokens: Int
    public let totalTokens: Int
    public let quality: String
    public let estimatedCostMicros: Int?
    public let priceVersion: String?
    public let updatedAt: String
}

public enum JSONValue: Codable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else { self = .array(try container.decode([JSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

public struct AuditSummary: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let workspaceId: String
    public let actorName: String?
    public let action: String
    public let entityType: String
    public let entityId: String
    public let previousState: String?
    public let nextState: String?
    public let occurredAt: String
    public let metadata: [String: JSONValue]
}

public struct Snapshot: Codable, Sendable {
    public let generatedAt: String
    public let scopeWorkspaceId: String?
    public let workspaces: [WorkspaceSummary]
    public let workstations: [WorkstationSummary]
    public let sessions: [SessionSummary]
    public let sessionCommands: [SessionCommandSummary]
    public let requests: [RequestSummary]
    public let members: [MemberSummary]
    public let usage: [UsageSummary]
    public let audit: [AuditSummary]
}

public struct DecisionInput: Codable, Hashable, Sendable {
    public enum Decision: String, Codable, Sendable { case approve, deny, answer }

    public let decision: Decision
    public let reason: String?
    public let answers: [String: [String]]?
    public let highRiskConfirmed: Bool?

    public init(
        decision: Decision,
        reason: String? = nil,
        answers: [String: [String]]? = nil,
        highRiskConfirmed: Bool? = nil
    ) {
        self.decision = decision
        self.reason = reason
        self.answers = answers
        self.highRiskConfirmed = highRiskConfirmed
    }
}

public struct DecisionResult: Codable, Sendable {
    public let request: RequestSummary
    public let replayed: Bool
}

public struct SessionCommandResult: Codable, Sendable {
    public let command: SessionCommandSummary
    public let replayed: Bool
}
