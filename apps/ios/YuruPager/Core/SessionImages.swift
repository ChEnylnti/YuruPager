import CryptoKit
import Foundation

public enum SessionImageLimits {
    public static let maximumCount = 4
    public static let maximumImageBytes = 5 * 1024 * 1024
    public static let maximumTotalBytes = 12 * 1024 * 1024
    public static let maximumSourceBytes = 25 * 1024 * 1024
    public static let chunkBytes = 48 * 1024
}

public enum SessionImageValidationError: String, Error, LocalizedError, Equatable, Sendable {
    case emptyImage = "empty_image"
    case unsupportedImage = "unsupported_image"
    case invalidImage = "invalid_image"
    case imageTooLarge = "image_too_large"
    case sourceImageTooLarge = "source_image_too_large"
    case tooManyImages = "too_many_images"
    case imagesTooLarge = "images_too_large"
    case missingImageStart = "missing_image_start"
    case invalidImageSequence = "invalid_image_sequence"
    case conflictingImageChunk = "conflicting_image_chunk"
    case missingImageChunk = "missing_image_chunk"
    case invalidImageChunk = "invalid_image_chunk"
    case invalidImageBase64 = "invalid_image_base64"
    case imageLengthMismatch = "image_length_mismatch"
    case imageHashMismatch = "image_hash_mismatch"

    public var errorDescription: String? {
        switch self {
        case .emptyImage: "图片内容为空"
        case .unsupportedImage: "仅支持 PNG、JPEG 和 WebP 图片"
        case .invalidImage: "图片内容与格式不匹配"
        case .imageTooLarge: "每张图片不能超过 5 MiB"
        case .sourceImageTooLarge: "待转换图片不能超过 25 MiB"
        case .tooManyImages: "每条消息最多添加 4 张图片"
        case .imagesTooLarge: "每条消息的图片总大小不能超过 12 MiB"
        case .missingImageStart: "图片缺少开始帧"
        case .invalidImageSequence: "图片分块序号无效"
        case .conflictingImageChunk: "重复图片分块内容不一致"
        case .missingImageChunk: "图片分块不连续"
        case .invalidImageChunk: "图片分块大小无效"
        case .invalidImageBase64: "图片分块编码无效"
        case .imageLengthMismatch: "图片数据不完整"
        case .imageHashMismatch: "图片完整性校验失败"
        }
    }
}

public enum SessionImageSourceValidator {
    public static func validateFileSize(_ byteLength: Int?) throws {
        guard let byteLength else { return }
        guard byteLength <= SessionImageLimits.maximumSourceBytes else {
            throw SessionImageValidationError.sourceImageTooLarge
        }
    }
}

public enum SessionImageSignature {
    public static func mimeType(for data: Data) -> String? {
        let bytes = [UInt8](data.prefix(12))
        if bytes.count >= 8,
           Array(bytes[0..<8]) == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] {
            return "image/png"
        }
        if bytes.count >= 3, bytes[0] == 0xff, bytes[1] == 0xd8, bytes[2] == 0xff {
            return "image/jpeg"
        }
        if bytes.count >= 12,
           Array(bytes[0..<4]) == [0x52, 0x49, 0x46, 0x46],
           Array(bytes[8..<12]) == [0x57, 0x45, 0x42, 0x50] {
            return "image/webp"
        }
        return nil
    }

    public static func validate(_ data: Data, mimeType: String) throws {
        guard !data.isEmpty else { throw SessionImageValidationError.emptyImage }
        guard data.count <= SessionImageLimits.maximumImageBytes else {
            throw SessionImageValidationError.imageTooLarge
        }
        guard mimeType == "image/png" || mimeType == "image/jpeg" || mimeType == "image/webp" else {
            throw SessionImageValidationError.unsupportedImage
        }
        guard self.mimeType(for: data) == mimeType else {
            throw SessionImageValidationError.invalidImage
        }
    }
}

public struct DraftImageAttachment: Identifiable, Equatable, Sendable {
    public let id: String
    public let mimeType: String
    public let data: Data

    public init(id: String, mimeType: String, data: Data) {
        self.id = id
        self.mimeType = mimeType
        self.data = data
    }
}

public enum SessionImageDraftValidator {
    public static func validate(_ attachments: [DraftImageAttachment]) throws {
        guard attachments.count <= SessionImageLimits.maximumCount else {
            throw SessionImageValidationError.tooManyImages
        }
        guard attachments.reduce(0, { $0 + $1.data.count }) <= SessionImageLimits.maximumTotalBytes else {
            throw SessionImageValidationError.imagesTooLarge
        }
        for attachment in attachments {
            try SessionImageSignature.validate(attachment.data, mimeType: attachment.mimeType)
        }
    }

    public static func validateAdding(
        data: Data,
        mimeType: String,
        to attachments: [DraftImageAttachment]
    ) throws {
        try validate(attachments + [DraftImageAttachment(id: "validation", mimeType: mimeType, data: data)])
    }
}

public struct SessionImageDraftState: Equatable, Sendable {
    public private(set) var sessionId: String?
    public private(set) var attachments: [DraftImageAttachment] = []

    public init() {}

    public mutating func bind(to sessionId: String) {
        if self.sessionId != sessionId {
            attachments.removeAll(keepingCapacity: false)
            self.sessionId = sessionId
        }
    }

    @discardableResult
    public mutating func add(data: Data, mimeType: String, sessionId: String, id: String) throws -> DraftImageAttachment {
        if self.sessionId == nil { self.sessionId = sessionId }
        guard self.sessionId == sessionId else { throw AttachmentUploadError.uploadFailed }
        try SessionImageDraftValidator.validateAdding(data: data, mimeType: mimeType, to: attachments)
        let attachment = DraftImageAttachment(id: id, mimeType: mimeType, data: data)
        attachments.append(attachment)
        return attachment
    }

    public mutating func remove(_ id: String) {
        attachments.removeAll { $0.id == id }
    }

    public mutating func removeAll() {
        attachments.removeAll(keepingCapacity: false)
    }

    public mutating func completeSubmission(attachmentIds: [String]) {
        guard attachments.map(\.id) == attachmentIds else { return }
        removeAll()
    }

    public mutating func clear() {
        removeAll()
        sessionId = nil
    }
}

public struct AttachmentUploadProgress: Equatable, Sendable {
    public let completedBytes: Int
    public let totalBytes: Int
    public let completedImages: Int
    public let totalImages: Int

    public init(completedBytes: Int, totalBytes: Int, completedImages: Int, totalImages: Int) {
        self.completedBytes = completedBytes
        self.totalBytes = totalBytes
        self.completedImages = completedImages
        self.totalImages = totalImages
    }

    public var fractionCompleted: Double {
        guard totalBytes > 0 else { return 0 }
        return min(max(Double(completedBytes) / Double(totalBytes), 0), 1)
    }
}

public enum ConversationImageStatus: Equatable, Sendable {
    case receiving(receivedBytes: Int)
    case ready
    case failed(code: String)
}

public struct ConversationImage: Identifiable, Equatable, Sendable {
    public let id: String
    public let turnId: String
    public let role: ConversationRole
    public let mimeType: String
    public let byteLength: Int
    public var status: ConversationImageStatus
    public var data: Data?

    public init(
        id: String,
        turnId: String,
        role: ConversationRole,
        mimeType: String,
        byteLength: Int,
        status: ConversationImageStatus = .receiving(receivedBytes: 0),
        data: Data? = nil
    ) {
        self.id = id
        self.turnId = turnId
        self.role = role
        self.mimeType = mimeType
        self.byteLength = byteLength
        self.status = status
        self.data = data
    }
}

public struct CompletedSessionImage: Equatable, Sendable {
    public let imageId: String
    public let mimeType: String
    public let data: Data
}

public struct SessionImageAssembler: Sendable {
    private struct PendingImage: Sendable {
        let mimeType: String
        let byteLength: Int
        var chunks: [Data]
        var encodedChunks: [String]
        var receivedBytes: Int
    }

    private var pending: [String: PendingImage] = [:]

    public init() {}

    public mutating func begin(imageId: String, mimeType: String, byteLength: Int) throws {
        guard byteLength > 0 else { throw SessionImageValidationError.emptyImage }
        guard byteLength <= SessionImageLimits.maximumImageBytes else {
            throw SessionImageValidationError.imageTooLarge
        }
        guard mimeType == "image/png" || mimeType == "image/jpeg" || mimeType == "image/webp" else {
            throw SessionImageValidationError.unsupportedImage
        }
        pending[imageId] = PendingImage(
            mimeType: mimeType,
            byteLength: byteLength,
            chunks: [],
            encodedChunks: [],
            receivedBytes: 0
        )
    }

    @discardableResult
    public mutating func append(imageId: String, sequence: Int, encodedData: String) throws -> Int {
        guard var image = pending[imageId] else { throw SessionImageValidationError.missingImageStart }
        guard sequence >= 0 else { throw SessionImageValidationError.invalidImageSequence }
        if sequence < image.chunks.count {
            guard image.encodedChunks[sequence] == encodedData else {
                throw SessionImageValidationError.conflictingImageChunk
            }
            return image.receivedBytes
        }
        guard sequence == image.chunks.count else { throw SessionImageValidationError.missingImageChunk }
        guard !encodedData.isEmpty,
              encodedData.count.isMultiple(of: 4),
              let chunk = Data(base64Encoded: encodedData),
              chunk.base64EncodedString() == encodedData else {
            throw SessionImageValidationError.invalidImageBase64
        }
        guard !chunk.isEmpty, chunk.count <= SessionImageLimits.chunkBytes else {
            throw SessionImageValidationError.invalidImageChunk
        }
        guard image.receivedBytes + chunk.count <= image.byteLength else {
            throw SessionImageValidationError.imageTooLarge
        }
        image.chunks.append(chunk)
        image.encodedChunks.append(encodedData)
        image.receivedBytes += chunk.count
        pending[imageId] = image
        return image.receivedBytes
    }

    public mutating func complete(imageId: String, sha256: String) throws -> CompletedSessionImage {
        guard let image = pending.removeValue(forKey: imageId) else {
            throw SessionImageValidationError.missingImageStart
        }
        guard image.receivedBytes == image.byteLength else {
            throw SessionImageValidationError.imageLengthMismatch
        }
        var data = Data(capacity: image.byteLength)
        for chunk in image.chunks { data.append(chunk) }
        try SessionImageSignature.validate(data, mimeType: image.mimeType)
        guard sha256.count == 64,
              sha256.allSatisfy({ "0123456789abcdef".contains($0) }),
              Self.sha256Hex(data) == sha256 else {
            throw SessionImageValidationError.imageHashMismatch
        }
        return CompletedSessionImage(imageId: imageId, mimeType: image.mimeType, data: data)
    }

    public mutating func fail(imageId: String) {
        pending.removeValue(forKey: imageId)
    }

    public mutating func clear() {
        pending.removeAll(keepingCapacity: false)
    }

    public static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

public enum AttachmentUploadState: String, Codable, Sendable {
    case accepted, progress, ready, failed, cancelled
}

public struct AttachmentUploadStatus: Equatable, Sendable {
    public let sessionId: String
    public let uploadId: String
    public let state: AttachmentUploadState
    public let nextOffset: Int?
    public let ticket: String?
    public let code: String?

    public init(
        sessionId: String,
        uploadId: String,
        state: AttachmentUploadState,
        nextOffset: Int? = nil,
        ticket: String? = nil,
        code: String? = nil
    ) {
        self.sessionId = sessionId
        self.uploadId = uploadId
        self.state = state
        self.nextOffset = nextOffset
        self.ticket = ticket
        self.code = code
    }
}

public enum AttachmentUploadError: String, Error, LocalizedError, Equatable, Sendable {
    case liveOffline = "live_offline"
    case uploadTimeout = "upload_timeout"
    case uploadCancelled = "upload_cancelled"
    case uploadFailed = "upload_failed"
    case invalidUploadOffset = "invalid_upload_offset"
    case uploadStalled = "upload_stalled"
    case uploadIncomplete = "upload_incomplete"
    case missingUploadTicket = "missing_upload_ticket"

    public var errorDescription: String? {
        switch self {
        case .liveOffline: "实时连接不可用，图片未上传"
        case .uploadTimeout: "等待工作站响应超时"
        case .uploadCancelled: "图片上传已取消，内容已保留"
        case .uploadFailed: "图片上传失败，内容已保留"
        case .invalidUploadOffset: "工作站返回了无效的上传位置"
        case .uploadStalled: "图片上传没有继续进行"
        case .uploadIncomplete: "工作站未完成图片校验"
        case .missingUploadTicket: "工作站未返回图片票据"
        }
    }
}
