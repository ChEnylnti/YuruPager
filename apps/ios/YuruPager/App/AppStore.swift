import Combine
import Foundation
import UIKit

@MainActor
final class AppStore: ObservableObject {
    enum Phase: Equatable {
        case launching
        case signedOut
        case ready
    }

    @Published private(set) var phase: Phase = .launching
    @Published private(set) var user: UserSummary?
    @Published private(set) var snapshot: Snapshot?
    @Published private(set) var isRefreshing = false
    @Published private(set) var isOnline = true
    @Published private(set) var liveConnected = false
    @Published private(set) var activeSessionId: String?
    @Published private(set) var streamState: SessionStreamState = .loading
    @Published private(set) var conversation = ConversationState()
    @Published private(set) var sessionTitles: [String: String] = [:]
    @Published private(set) var imageDraft = SessionImageDraftState()
    @Published private(set) var attachmentUploadProgress: AttachmentUploadProgress?
    @Published private(set) var isQueueingImageCommand = false
    @Published var notice: String?

    @Published private(set) var configuration: ServerConfiguration
    @Published var selectedWorkspaceId: String? {
        didSet { UserDefaults.standard.set(selectedWorkspaceId, forKey: Keys.workspaceId) }
    }

    private enum Keys {
        static let serverAddress = "serverAddress"
        static let workspaceId = "workspaceId"
    }

    private var api: APIClient
    private var live: LiveSocketClient
    private let cookieVault = SecureCookieVault()
    private var refreshTask: Task<Void, Never>?
    private var imageAssembler = SessionImageAssembler()
    private var uploadAttemptId: UUID?
    private var activeUploadIds: Set<String> = []

    var draftImages: [DraftImageAttachment] { imageDraft.attachments }

    init() {
        let savedAddress = UserDefaults.standard.string(forKey: Keys.serverAddress)
            ?? ServerConfiguration.defaultAddress
        let configuration = ServerConfiguration(address: savedAddress)
            ?? ServerConfiguration(address: ServerConfiguration.defaultAddress)!
        self.configuration = configuration
        self.api = APIClient(configuration: configuration)
        self.live = LiveSocketClient(configuration: configuration)
        self.selectedWorkspaceId = UserDefaults.standard.string(forKey: Keys.workspaceId)
#if DEBUG
        if ProcessInfo.processInfo.environment["YURUPAGER_UI_TEST"] == "1" {
            cookieVault.clear(for: configuration.baseURL)
        }
#endif
        cookieVault.restore(for: configuration.baseURL)
        installLiveHandlers()
    }

    func bootstrap() async {
        do {
            user = try await api.currentUser()
            phase = .ready
            await refresh()
            live.connect()
        } catch let error as APIError where error.status == 401 {
            phase = .signedOut
        } catch {
            phase = .signedOut
            notice = Labels.error(error, fallback: "无法连接服务器，请检查地址和网络")
        }
    }

    func configureServer(address: String) -> Bool {
        guard let next = ServerConfiguration(address: address), next.isTransportAllowed else { return false }
        clearConversation()
        live.disconnect()
        sessionTitles.removeAll(keepingCapacity: false)
        snapshot = nil
        user = nil
        configuration = next
        api = APIClient(configuration: next)
        live = LiveSocketClient(configuration: next)
        installLiveHandlers()
        cookieVault.restore(for: next.baseURL)
        UserDefaults.standard.set(next.baseURL.absoluteString, forKey: Keys.serverAddress)
        phase = .signedOut
        return true
    }

    func login(email: String, password: String, rememberSession: Bool) async throws {
        user = try await api.login(email: email, password: password)
        if rememberSession {
            cookieVault.save(for: configuration.baseURL)
        } else {
            cookieVault.clearPersisted()
        }
        phase = .ready
        await refresh()
        live.connect()
    }

    func logout() async {
        try? await api.logout()
        clearSessionMedia()
        live.disconnect()
        cookieVault.clear(for: configuration.baseURL)
        clearPrivateState()
        phase = .signedOut
    }

    func activate() async {
        guard phase == .ready else { return }
        await refresh()
        live.connect()
    }

    func deactivate() {
        clearSessionMedia()
        live.disconnect()
        streamState = .loading
    }

    func selectWorkspace(_ workspaceId: String?) async {
        guard selectedWorkspaceId != workspaceId else { return }
        selectedWorkspaceId = workspaceId
        clearConversation()
        snapshot = nil
        await refresh()
    }

    func refresh() async {
        guard phase == .ready, !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            let next = try await api.snapshot(workspaceId: selectedWorkspaceId)
            snapshot = next
            isOnline = true
            if let selectedWorkspaceId,
               !next.workspaces.contains(where: { $0.id == selectedWorkspaceId }) {
                self.selectedWorkspaceId = nil
                snapshot = try await api.snapshot(workspaceId: nil)
            }
        } catch let error as APIError where error.status == 401 {
            live.disconnect()
            clearPrivateState()
            phase = .signedOut
            notice = "登录已失效，请重新登录"
        } catch {
            isOnline = false
            notice = Labels.error(error, fallback: "无法刷新数据")
        }
    }

    func decide(request: RequestSummary, key: String, input: DecisionInput) async throws -> RequestSummary {
        do {
            let result = try await api.decide(requestId: request.id, key: key, input: input)
            replaceRequest(result.request)
            return result.request
        } catch let error as APIError where error.code == "decision_conflict" {
            await refresh()
            throw error
        }
    }

    func sendMessage(
        session: SessionSummary,
        key: String,
        content: String
    ) async throws -> SessionCommandSummary {
        guard activeSessionId == session.id else { throw AttachmentUploadError.liveOffline }
        var attachments = draftImages
        let attachmentIds = attachments.map(\.id)
        let tickets: [String]
        if attachments.isEmpty {
            tickets = []
        } else {
            guard canUploadImages(to: session) else { throw AttachmentUploadError.liveOffline }
            tickets = try await upload(attachments, sessionId: session.id)
            isQueueingImageCommand = true
        }
        attachments.removeAll(keepingCapacity: false)
        defer { isQueueingImageCommand = false }
        let result = try await api.sendMessage(
            sessionId: session.id,
            key: key,
            content: content,
            attachmentTickets: tickets
        )
        if !attachmentIds.isEmpty { imageDraft.completeSubmission(attachmentIds: attachmentIds) }
        appendCommand(result.command)
        return result.command
    }

    @discardableResult
    func addDraftImage(data: Data, mimeType: String, sessionId: String) throws -> DraftImageAttachment {
        guard activeSessionId == sessionId, uploadAttemptId == nil else { throw AttachmentUploadError.uploadFailed }
        return try imageDraft.add(
            data: data,
            mimeType: mimeType,
            sessionId: sessionId,
            id: UUID().uuidString
        )
    }

    func removeDraftImage(_ id: String) {
        guard uploadAttemptId == nil else { return }
        imageDraft.remove(id)
    }

    func clearDraftImages() {
        guard uploadAttemptId == nil else { return }
        imageDraft.removeAll()
    }

    func canUploadImages(to session: SessionSummary) -> Bool {
        guard isOnline,
              liveConnected,
              streamState == .live,
              snapshot?.workstations.first(where: { $0.id == session.workstationId })?.status == "online" else {
            return false
        }
        return canRespond(to: session)
    }

    func imageUploadUnavailableReason(for session: SessionSummary) -> String? {
        if !canRespond(to: session) { return "你无权向此会话发送图片" }
        if !isOnline { return "网络恢复后才能发送图片" }
        if snapshot?.workstations.first(where: { $0.id == session.workstationId })?.status != "online"
            || !liveConnected
            || streamState != .live {
            return "工作站在线后才能发送图片"
        }
        return nil
    }

    func canRespond(to session: SessionSummary) -> Bool {
        guard let user, let snapshot else { return false }
        return snapshot.members
            .first(where: { $0.workspaceId == session.workspaceId && $0.userId == user.id })?
            .workstationAccess
            .first(where: { $0.workstationId == session.workstationId })?
            .canRespond == true
    }

    func cancelAttachmentUpload() {
        guard let sessionId = activeSessionId else { return }
        uploadAttemptId = nil
        attachmentUploadProgress = nil
        for uploadId in activeUploadIds {
            live.cancelAttachmentWait(sessionId: sessionId, uploadId: uploadId)
            Task { await live.send(.attachmentCancel(sessionId: sessionId, uploadId: uploadId)) }
        }
        activeUploadIds.removeAll(keepingCapacity: false)
    }

    func openSession(_ sessionId: String) async {
        if let current = activeSessionId, current != sessionId {
            await live.send(.unsubscribe(current))
            clearSessionMedia()
        }
        imageAssembler.clear()
        conversation.clear()
        streamState = .loading
        activeSessionId = sessionId
        imageDraft.bind(to: sessionId)
        await live.send(.subscribe(sessionId))
    }

    func closeSession(_ sessionId: String) {
        guard activeSessionId == sessionId else { return }
        Task { await live.send(.unsubscribe(sessionId)) }
        clearConversation()
    }

    private func installLiveHandlers() {
        live.onConnectionChange = { [weak self] connected in
            guard let self else { return }
            liveConnected = connected
            if connected, let activeSessionId {
                Task { await self.live.send(.subscribe(activeSessionId)) }
            } else if !connected, activeSessionId != nil {
                streamState = .error
                clearSessionMedia()
                conversation.clear()
            }
            if !connected { sessionTitles.removeAll(keepingCapacity: false) }
        }
        live.onMessage = { [weak self] message in
            self?.handleLive(message)
        }
    }

    private func handleLive(_ message: LiveServerMessage) {
        switch message.type {
        case "snapshot.invalidated":
            guard selectedWorkspaceId == nil || selectedWorkspaceId == message.workspaceId else { return }
            refreshTask?.cancel()
            refreshTask = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(150))
                guard !Task.isCancelled else { return }
                await self?.refresh()
            }
        case "session.stream.status":
            guard message.sessionId == activeSessionId, let state = message.sessionStreamState else { return }
            streamState = state
            if state != .live && state != .loading {
                clearSessionMedia()
                conversation.clear()
            }
        case "session.stream.frame":
            guard message.sessionId == activeSessionId, let frame = message.frame else { return }
            handleSessionFrame(frame)
        case "session.titles.snapshot":
            guard let titles = message.titles else { return }
            sessionTitles = Dictionary(titles.map { ($0.sessionId, $0.title) }, uniquingKeysWith: { _, latest in latest })
        default:
            break
        }
    }

    private func replaceRequest(_ request: RequestSummary) {
        guard let current = snapshot,
              let index = current.requests.firstIndex(where: { $0.id == request.id }) else { return }
        var requests = current.requests
        requests[index] = request
        snapshot = Snapshot(
            generatedAt: current.generatedAt,
            scopeWorkspaceId: current.scopeWorkspaceId,
            workspaces: current.workspaces,
            workstations: current.workstations,
            sessions: current.sessions,
            sessionCommands: current.sessionCommands,
            requests: requests,
            members: current.members,
            usage: current.usage,
            audit: current.audit
        )
    }

    private func appendCommand(_ command: SessionCommandSummary) {
        guard let current = snapshot else { return }
        snapshot = Snapshot(
            generatedAt: current.generatedAt,
            scopeWorkspaceId: current.scopeWorkspaceId,
            workspaces: current.workspaces,
            workstations: current.workstations,
            sessions: current.sessions,
            sessionCommands: [command] + current.sessionCommands.filter { $0.id != command.id },
            requests: current.requests,
            members: current.members,
            usage: current.usage,
            audit: current.audit
        )
    }

    private func clearConversation() {
        clearSessionMedia()
        activeSessionId = nil
        streamState = .loading
        conversation.clear()
    }

    private func upload(_ attachments: [DraftImageAttachment], sessionId: String) async throws -> [String] {
        try SessionImageDraftValidator.validate(attachments)

        let attemptId = UUID()
        uploadAttemptId = attemptId
        activeUploadIds = Set(attachments.map(\.id))
        let totalBytes = attachments.reduce(0, { $0 + $1.data.count })
        attachmentUploadProgress = AttachmentUploadProgress(
            completedBytes: 0,
            totalBytes: totalBytes,
            completedImages: 0,
            totalImages: attachments.count
        )
        var completedBytes = 0
        var tickets: [String] = []

        defer {
            if uploadAttemptId == attemptId { uploadAttemptId = nil }
            activeUploadIds.removeAll(keepingCapacity: false)
            attachmentUploadProgress = nil
        }

        do {
            for (index, attachment) in attachments.enumerated() {
                try Task.checkCancellation()
                try ensureUploadAttempt(attemptId)
                let sha256 = SessionImageAssembler.sha256Hex(attachment.data)
                var status = try await live.sendAwaitingAttachmentStatus(
                    .attachmentBegin(
                        sessionId: sessionId,
                        uploadId: attachment.id,
                        mimeType: attachment.mimeType,
                        byteLength: attachment.data.count,
                        sha256: sha256
                    ),
                    sessionId: sessionId,
                    uploadId: attachment.id
                )
                try ensureUploadAttempt(attemptId)
                if status.state == .ready {
                    tickets.append(try ticket(from: status))
                    completedBytes += attachment.data.count
                    reportUploadProgress(completedBytes, totalBytes, index + 1, attachments.count)
                    continue
                }
                var offset = try nextOffset(from: status, byteLength: attachment.data.count)
                reportUploadProgress(completedBytes + offset, totalBytes, index, attachments.count)

                while offset < attachment.data.count {
                    try Task.checkCancellation()
                    try ensureUploadAttempt(attemptId)
                    let end = min(offset + SessionImageLimits.chunkBytes, attachment.data.count)
                    let encoded = attachment.data.subdata(in: offset..<end).base64EncodedString()
                    status = try await live.sendAwaitingAttachmentStatus(
                        .attachmentChunk(sessionId: sessionId, uploadId: attachment.id, offset: offset, data: encoded),
                        sessionId: sessionId,
                        uploadId: attachment.id
                    )
                    try ensureUploadAttempt(attemptId)
                    if status.state == .ready { break }
                    let next = try nextOffset(from: status, byteLength: attachment.data.count)
                    guard next > offset else { throw AttachmentUploadError.uploadStalled }
                    offset = next
                    reportUploadProgress(completedBytes + offset, totalBytes, index, attachments.count)
                }

                if status.state != .ready {
                    status = try await live.sendAwaitingAttachmentStatus(
                        .attachmentComplete(sessionId: sessionId, uploadId: attachment.id),
                        sessionId: sessionId,
                        uploadId: attachment.id
                    )
                }
                guard status.state == .ready else { throw uploadError(from: status) }
                tickets.append(try ticket(from: status))
                completedBytes += attachment.data.count
                reportUploadProgress(completedBytes, totalBytes, index + 1, attachments.count)
            }
            return tickets
        } catch {
            if uploadAttemptId == attemptId {
                for uploadId in activeUploadIds {
                    live.cancelAttachmentWait(sessionId: sessionId, uploadId: uploadId)
                    Task { await live.send(.attachmentCancel(sessionId: sessionId, uploadId: uploadId)) }
                }
            }
            throw error
        }
    }

    private func reportUploadProgress(_ completedBytes: Int, _ totalBytes: Int, _ completedImages: Int, _ totalImages: Int) {
        attachmentUploadProgress = AttachmentUploadProgress(
            completedBytes: completedBytes,
            totalBytes: totalBytes,
            completedImages: completedImages,
            totalImages: totalImages
        )
    }

    private func ensureUploadAttempt(_ id: UUID) throws {
        guard uploadAttemptId == id else { throw AttachmentUploadError.uploadCancelled }
    }

    private func nextOffset(from status: AttachmentUploadStatus, byteLength: Int) throws -> Int {
        if status.state == .failed || status.state == .cancelled { throw uploadError(from: status) }
        guard status.state == .accepted || status.state == .progress,
              let offset = status.nextOffset,
              offset >= 0,
              offset <= byteLength else {
            throw AttachmentUploadError.invalidUploadOffset
        }
        return offset
    }

    private func ticket(from status: AttachmentUploadStatus) throws -> String {
        guard let ticket = status.ticket, ticket.count >= 16 else {
            throw AttachmentUploadError.missingUploadTicket
        }
        return ticket
    }

    private func uploadError(from status: AttachmentUploadStatus) -> Error {
        if status.state == .cancelled { return AttachmentUploadError.uploadCancelled }
        return RemoteAttachmentUploadError(code: status.code ?? "upload_failed")
    }

    private func handleSessionFrame(_ frame: SessionStreamFrame) {
        switch frame {
        case .historyStart:
            imageAssembler.clear()
            conversation.apply(frame)
        case .imageStart(let imageId, _, _, let mimeType, let byteLength):
            conversation.apply(frame)
            do {
                try imageAssembler.begin(imageId: imageId, mimeType: mimeType, byteLength: byteLength)
            } catch {
                imageAssembler.fail(imageId: imageId)
                conversation.failImage(imageId, code: safeImageErrorCode(error))
            }
        case .imageChunk(let imageId, let sequence, let data):
            guard !isTerminalImage(imageId) else { return }
            do {
                let receivedBytes = try imageAssembler.append(
                    imageId: imageId,
                    sequence: sequence,
                    encodedData: data
                )
                conversation.updateImageProgress(imageId, receivedBytes: receivedBytes)
            } catch {
                imageAssembler.fail(imageId: imageId)
                conversation.failImage(imageId, code: safeImageErrorCode(error))
            }
        case .imageComplete(let imageId, let sha256):
            guard !isTerminalImage(imageId) else { return }
            do {
                let completed = try imageAssembler.complete(imageId: imageId, sha256: sha256)
                guard UIImage(data: completed.data) != nil else {
                    throw SessionImageValidationError.invalidImage
                }
                conversation.completeImage(imageId, data: completed.data)
            } catch {
                conversation.failImage(imageId, code: safeImageErrorCode(error))
            }
        case .imageError(let imageId, _, _, _):
            imageAssembler.fail(imageId: imageId)
            conversation.apply(frame)
        default:
            conversation.apply(frame)
        }
    }

    private func isTerminalImage(_ imageId: String) -> Bool {
        guard let image = conversation.images.first(where: { $0.id == imageId }) else { return false }
        switch image.status {
        case .receiving: return false
        case .ready, .failed: return true
        }
    }

    private func safeImageErrorCode(_ error: Error) -> String {
        (error as? SessionImageValidationError)?.rawValue ?? "invalid_image"
    }

    private func clearSessionMedia() {
        cancelAttachmentUpload()
        isQueueingImageCommand = false
        imageDraft.clear()
        imageAssembler.clear()
        conversation.clear()
    }

    func sessionTitle(for session: SessionSummary) -> String {
        sessionTitles[session.id] ?? "Codex 会话 \(String(session.threadId.prefix(8)))"
    }

    private func clearPrivateState() {
        refreshTask?.cancel()
        refreshTask = nil
        user = nil
        snapshot = nil
        notice = nil
        sessionTitles.removeAll(keepingCapacity: false)
        clearConversation()
    }
}

private struct RemoteAttachmentUploadError: LocalizedError {
    let code: String

    var errorDescription: String? {
        switch code {
        case "connector_offline": "工作站离线，图片未上传"
        case "permission_denied": "你无权向此会话上传图片"
        case "invalid_image", "invalid_image_type": "图片内容与格式不匹配"
        case "image_too_large": "图片超过允许大小"
        case "hash_mismatch", "image_hash_mismatch": "图片完整性校验失败"
        case "image_incomplete", "invalid_chunk", "chunk_out_of_order": "图片数据不完整"
        case "connector_write_failed": "工作站无法保存图片"
        case "upload_expired": "图片上传已过期，请重新发送"
        default: "图片上传失败，内容已保留"
        }
    }
}
