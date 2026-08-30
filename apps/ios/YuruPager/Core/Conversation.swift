import Foundation

public enum ConversationRole: String, Codable, Sendable {
    case user, assistant
}

public enum ConversationPhase: String, Codable, Sendable {
    case commentary
    case finalAnswer = "final_answer"
}

public enum ConversationTurnStatus: String, Codable, Sendable {
    case inProgress = "in_progress"
    case completed, failed, interrupted
}

public enum ConversationActivityKind: String, Codable, Sendable {
    case command
    case fileChange = "file_change"
    case tool
    case webSearch = "web_search"
    case image, collaboration, wait, review
    case contextCompaction = "context_compaction"
}

public enum ConversationActivityStatus: String, Codable, Sendable {
    case inProgress = "in_progress"
    case completed, failed, cancelled
}

public enum SessionStreamState: String, Codable, Sendable {
    case loading, live
    case connectorOffline = "connector_offline"
    case denied, error
}

public enum SessionStreamFrame: Codable, Equatable, Sendable {
    case historyStart
    case messageStart(messageId: String, turnId: String, role: ConversationRole, phase: ConversationPhase?)
    case messageReset(messageId: String)
    case messageDelta(messageId: String, delta: String)
    case messageComplete(messageId: String)
    case activityUpsert(activityId: String, turnId: String, activity: ConversationActivityKind, label: String, status: ConversationActivityStatus)
    case imageStart(imageId: String, turnId: String, role: ConversationRole, mimeType: String, byteLength: Int)
    case imageChunk(imageId: String, sequence: Int, data: String)
    case imageComplete(imageId: String, sha256: String)
    case imageError(imageId: String, turnId: String, role: ConversationRole, code: String)
    case historyComplete
    case turnStatus(turnId: String, status: ConversationTurnStatus)

    private enum CodingKeys: String, CodingKey {
        case kind, messageId, activityId, imageId, turnId, role, phase, delta, activity, label, status
        case mimeType, byteLength, sequence, data, sha256, code
    }

    private enum Kind: String, Codable {
        case historyStart = "history.start"
        case messageStart = "message.start"
        case messageReset = "message.reset"
        case messageDelta = "message.delta"
        case messageComplete = "message.complete"
        case activityUpsert = "activity.upsert"
        case imageStart = "image.start"
        case imageChunk = "image.chunk"
        case imageComplete = "image.complete"
        case imageError = "image.error"
        case historyComplete = "history.complete"
        case turnStatus = "turn.status"
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        switch try values.decode(Kind.self, forKey: .kind) {
        case .historyStart: self = .historyStart
        case .messageStart:
            self = .messageStart(
                messageId: try values.decode(String.self, forKey: .messageId),
                turnId: try values.decode(String.self, forKey: .turnId),
                role: try values.decode(ConversationRole.self, forKey: .role),
                phase: try values.decodeIfPresent(ConversationPhase.self, forKey: .phase)
            )
        case .messageReset:
            self = .messageReset(messageId: try values.decode(String.self, forKey: .messageId))
        case .messageDelta:
            self = .messageDelta(
                messageId: try values.decode(String.self, forKey: .messageId),
                delta: try values.decode(String.self, forKey: .delta)
            )
        case .messageComplete:
            self = .messageComplete(messageId: try values.decode(String.self, forKey: .messageId))
        case .activityUpsert:
            self = .activityUpsert(
                activityId: try values.decode(String.self, forKey: .activityId),
                turnId: try values.decode(String.self, forKey: .turnId),
                activity: try values.decode(ConversationActivityKind.self, forKey: .activity),
                label: try values.decode(String.self, forKey: .label),
                status: try values.decode(ConversationActivityStatus.self, forKey: .status)
            )
        case .imageStart:
            self = .imageStart(
                imageId: try values.decode(String.self, forKey: .imageId),
                turnId: try values.decode(String.self, forKey: .turnId),
                role: try values.decode(ConversationRole.self, forKey: .role),
                mimeType: try values.decode(String.self, forKey: .mimeType),
                byteLength: try values.decode(Int.self, forKey: .byteLength)
            )
        case .imageChunk:
            self = .imageChunk(
                imageId: try values.decode(String.self, forKey: .imageId),
                sequence: try values.decode(Int.self, forKey: .sequence),
                data: try values.decode(String.self, forKey: .data)
            )
        case .imageComplete:
            self = .imageComplete(
                imageId: try values.decode(String.self, forKey: .imageId),
                sha256: try values.decode(String.self, forKey: .sha256)
            )
        case .imageError:
            self = .imageError(
                imageId: try values.decode(String.self, forKey: .imageId),
                turnId: try values.decode(String.self, forKey: .turnId),
                role: try values.decode(ConversationRole.self, forKey: .role),
                code: try values.decode(String.self, forKey: .code)
            )
        case .historyComplete: self = .historyComplete
        case .turnStatus:
            self = .turnStatus(
                turnId: try values.decode(String.self, forKey: .turnId),
                status: try values.decode(ConversationTurnStatus.self, forKey: .status)
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .historyStart:
            try values.encode(Kind.historyStart, forKey: .kind)
        case .messageStart(let messageId, let turnId, let role, let phase):
            try values.encode(Kind.messageStart, forKey: .kind)
            try values.encode(messageId, forKey: .messageId)
            try values.encode(turnId, forKey: .turnId)
            try values.encode(role, forKey: .role)
            try values.encodeIfPresent(phase, forKey: .phase)
        case .messageReset(let messageId):
            try values.encode(Kind.messageReset, forKey: .kind)
            try values.encode(messageId, forKey: .messageId)
        case .messageDelta(let messageId, let delta):
            try values.encode(Kind.messageDelta, forKey: .kind)
            try values.encode(messageId, forKey: .messageId)
            try values.encode(delta, forKey: .delta)
        case .messageComplete(let messageId):
            try values.encode(Kind.messageComplete, forKey: .kind)
            try values.encode(messageId, forKey: .messageId)
        case .activityUpsert(let activityId, let turnId, let activity, let label, let status):
            try values.encode(Kind.activityUpsert, forKey: .kind)
            try values.encode(activityId, forKey: .activityId)
            try values.encode(turnId, forKey: .turnId)
            try values.encode(activity, forKey: .activity)
            try values.encode(label, forKey: .label)
            try values.encode(status, forKey: .status)
        case .imageStart(let imageId, let turnId, let role, let mimeType, let byteLength):
            try values.encode(Kind.imageStart, forKey: .kind)
            try values.encode(imageId, forKey: .imageId)
            try values.encode(turnId, forKey: .turnId)
            try values.encode(role, forKey: .role)
            try values.encode(mimeType, forKey: .mimeType)
            try values.encode(byteLength, forKey: .byteLength)
        case .imageChunk(let imageId, let sequence, let data):
            try values.encode(Kind.imageChunk, forKey: .kind)
            try values.encode(imageId, forKey: .imageId)
            try values.encode(sequence, forKey: .sequence)
            try values.encode(data, forKey: .data)
        case .imageComplete(let imageId, let sha256):
            try values.encode(Kind.imageComplete, forKey: .kind)
            try values.encode(imageId, forKey: .imageId)
            try values.encode(sha256, forKey: .sha256)
        case .imageError(let imageId, let turnId, let role, let code):
            try values.encode(Kind.imageError, forKey: .kind)
            try values.encode(imageId, forKey: .imageId)
            try values.encode(turnId, forKey: .turnId)
            try values.encode(role, forKey: .role)
            try values.encode(code, forKey: .code)
        case .historyComplete:
            try values.encode(Kind.historyComplete, forKey: .kind)
        case .turnStatus(let turnId, let status):
            try values.encode(Kind.turnStatus, forKey: .kind)
            try values.encode(turnId, forKey: .turnId)
            try values.encode(status, forKey: .status)
        }
    }
}

public struct ConversationMessage: Identifiable, Equatable, Sendable {
    public let id: String
    public let turnId: String
    public let role: ConversationRole
    public let phase: ConversationPhase?
    public var text: String
    public var isComplete: Bool
}

public struct ConversationActivity: Identifiable, Equatable, Sendable {
    public let id: String
    public let turnId: String
    public let activity: ConversationActivityKind
    public let label: String
    public let status: ConversationActivityStatus
}

public enum ConversationEntry: Identifiable, Equatable, Sendable {
    case message(ConversationMessage)
    case activity(ConversationActivity)
    case image(ConversationImage)

    public var id: String {
        switch self {
        case .message(let message): "message-\(message.id)"
        case .activity(let activity): "activity-\(activity.id)"
        case .image(let image): "image-\(image.id)"
        }
    }
}

public struct ConversationState: Equatable, Sendable {
    public private(set) var entries: [ConversationEntry] = []
    public private(set) var isHistoryComplete = false
    public private(set) var turnStatuses: [String: ConversationTurnStatus] = [:]

    public var messages: [ConversationMessage] {
        entries.compactMap { entry in
            if case .message(let message) = entry { return message }
            return nil
        }
    }

    public var activities: [ConversationActivity] {
        entries.compactMap { entry in
            if case .activity(let activity) = entry { return activity }
            return nil
        }
    }

    public var images: [ConversationImage] {
        entries.compactMap { entry in
            if case .image(let image) = entry { return image }
            return nil
        }
    }

    public init() {}

    public mutating func apply(_ frame: SessionStreamFrame) {
        switch frame {
        case .historyStart:
            clear()
        case .messageStart(let messageId, let turnId, let role, let phase):
            if let index = entries.firstIndex(where: { entry in
                if case .message(let message) = entry { return message.id == messageId }
                return false
            }), case .message(let current) = entries[index] {
                entries[index] = .message(ConversationMessage(
                    id: messageId,
                    turnId: turnId,
                    role: role,
                    phase: phase,
                    text: current.text,
                    isComplete: false
                ))
                return
            }
            entries.append(.message(ConversationMessage(
                id: messageId,
                turnId: turnId,
                role: role,
                phase: phase,
                text: "",
                isComplete: false
            )))
        case .messageReset(let messageId):
            update(messageId) { $0.text = ""; $0.isComplete = false }
        case .messageDelta(let messageId, let delta):
            update(messageId) { $0.text += delta; $0.isComplete = false }
        case .messageComplete(let messageId):
            update(messageId) { $0.isComplete = true }
        case .activityUpsert(let activityId, let turnId, let activity, let label, let status):
            let next = ConversationActivity(id: activityId, turnId: turnId, activity: activity, label: label, status: status)
            if let index = entries.firstIndex(where: { entry in
                if case .activity(let current) = entry { return current.id == activityId }
                return false
            }) {
                entries[index] = .activity(next)
            } else {
                entries.append(.activity(next))
            }
        case .imageStart(let imageId, let turnId, let role, let mimeType, let byteLength):
            let next = ConversationImage(
                id: imageId,
                turnId: turnId,
                role: role,
                mimeType: mimeType,
                byteLength: byteLength
            )
            if let index = imageIndex(imageId) { entries[index] = .image(next) }
            else { entries.append(.image(next)) }
        case .imageChunk:
            break
        case .imageComplete:
            break
        case .imageError(let imageId, let turnId, let role, let code):
            failImage(imageId, turnId: turnId, role: role, code: code)
        case .historyComplete:
            isHistoryComplete = true
        case .turnStatus(let turnId, let status):
            turnStatuses[turnId] = status
        }
    }

    public mutating func clear() {
        entries.removeAll(keepingCapacity: false)
        turnStatuses.removeAll(keepingCapacity: false)
        isHistoryComplete = false
    }

    public mutating func updateImageProgress(_ imageId: String, receivedBytes: Int) {
        updateImage(imageId) { image in
            image.status = .receiving(receivedBytes: min(max(receivedBytes, 0), image.byteLength))
        }
    }

    public mutating func completeImage(_ imageId: String, data: Data) {
        updateImage(imageId) { image in
            image.data = data
            image.status = .ready
        }
    }

    public mutating func failImage(
        _ imageId: String,
        turnId: String = "",
        role: ConversationRole = .assistant,
        code: String
    ) {
        if imageIndex(imageId) != nil {
            updateImage(imageId) { image in
                image.data = nil
                image.status = .failed(code: code)
            }
        } else {
            entries.append(.image(ConversationImage(
                id: imageId,
                turnId: turnId,
                role: role,
                mimeType: "",
                byteLength: 0,
                status: .failed(code: code)
            )))
        }
    }

    private mutating func update(_ messageId: String, body: (inout ConversationMessage) -> Void) {
        guard let index = entries.firstIndex(where: { entry in
            if case .message(let message) = entry { return message.id == messageId }
            return false
        }), case .message(var message) = entries[index] else { return }
        body(&message)
        entries[index] = .message(message)
    }

    private func imageIndex(_ imageId: String) -> Int? {
        entries.firstIndex { entry in
            if case .image(let image) = entry { return image.id == imageId }
            return false
        }
    }

    private mutating func updateImage(_ imageId: String, body: (inout ConversationImage) -> Void) {
        guard let index = imageIndex(imageId), case .image(var image) = entries[index] else { return }
        body(&image)
        entries[index] = .image(image)
    }
}

public struct SessionTitle: Decodable, Sendable, Equatable {
    public let sessionId: String
    public let title: String
}

public struct LiveServerMessage: Decodable, Sendable {
    public let type: String
    public let userId: String?
    public let workspaceId: String?
    public let requestId: String?
    public let sessionId: String?
    public let commandId: String?
    public let status: String?
    public let state: String?
    public let frame: SessionStreamFrame?
    public let titles: [SessionTitle]?
    public let uploadId: String?
    public let nextOffset: Int?
    public let ticket: String?
    public let code: String?

    public var sessionStreamState: SessionStreamState? {
        state.flatMap(SessionStreamState.init(rawValue:))
    }

    public var attachmentStatus: AttachmentUploadStatus? {
        guard type == "session.attachment.status",
              let sessionId,
              let uploadId,
              let state,
              let uploadState = AttachmentUploadState(rawValue: state) else { return nil }
        return AttachmentUploadStatus(
            sessionId: sessionId,
            uploadId: uploadId,
            state: uploadState,
            nextOffset: nextOffset,
            ticket: ticket,
            code: code
        )
    }
}

public struct LiveClientMessage: Encodable, Sendable {
    public let type: String
    public let sessionId: String
    public let uploadId: String?
    public let mimeType: String?
    public let byteLength: Int?
    public let sha256: String?
    public let offset: Int?
    public let data: String?

    private init(
        type: String,
        sessionId: String,
        uploadId: String? = nil,
        mimeType: String? = nil,
        byteLength: Int? = nil,
        sha256: String? = nil,
        offset: Int? = nil,
        data: String? = nil
    ) {
        self.type = type
        self.sessionId = sessionId
        self.uploadId = uploadId
        self.mimeType = mimeType
        self.byteLength = byteLength
        self.sha256 = sha256
        self.offset = offset
        self.data = data
    }

    public static func subscribe(_ sessionId: String) -> Self {
        .init(type: "session.stream.subscribe", sessionId: sessionId)
    }

    public static func unsubscribe(_ sessionId: String) -> Self {
        .init(type: "session.stream.unsubscribe", sessionId: sessionId)
    }

    public static func attachmentBegin(
        sessionId: String,
        uploadId: String,
        mimeType: String,
        byteLength: Int,
        sha256: String
    ) -> Self {
        .init(
            type: "session.attachment.begin",
            sessionId: sessionId,
            uploadId: uploadId,
            mimeType: mimeType,
            byteLength: byteLength,
            sha256: sha256
        )
    }

    public static func attachmentChunk(sessionId: String, uploadId: String, offset: Int, data: String) -> Self {
        .init(
            type: "session.attachment.chunk",
            sessionId: sessionId,
            uploadId: uploadId,
            offset: offset,
            data: data
        )
    }

    public static func attachmentComplete(sessionId: String, uploadId: String) -> Self {
        .init(type: "session.attachment.complete", sessionId: sessionId, uploadId: uploadId)
    }

    public static func attachmentCancel(sessionId: String, uploadId: String) -> Self {
        .init(type: "session.attachment.cancel", sessionId: sessionId, uploadId: uploadId)
    }
}
