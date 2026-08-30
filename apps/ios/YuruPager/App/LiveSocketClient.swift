import Foundation

@MainActor
final class LiveSocketClient {
    var onMessage: ((LiveServerMessage) -> Void)?
    var onConnectionChange: ((Bool) -> Void)?

    private let configuration: ServerConfiguration
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var shouldReconnect = false
    private var reconnectAttempt = 0
    private var attachmentWaiters: [AttachmentWaiterKey: AttachmentWaiter] = [:]

    private struct AttachmentWaiterKey: Hashable {
        let sessionId: String
        let uploadId: String
    }

    private struct AttachmentWaiter {
        let continuation: CheckedContinuation<AttachmentUploadStatus, Error>
        var timeoutTask: Task<Void, Never>?
    }

    init(configuration: ServerConfiguration) {
        self.configuration = configuration
    }

    func connect() {
        shouldReconnect = true
        guard socket == nil else { return }
        let socket = URLSession.shared.webSocketTask(with: configuration.liveURL)
        self.socket = socket
        socket.resume()
        receiveTask = Task { [weak self] in
            await self?.receiveLoop(socket)
        }
    }

    func disconnect() {
        shouldReconnect = false
        reconnectTask?.cancel()
        reconnectTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        reconnectAttempt = 0
        failAttachmentWaiters(with: AttachmentUploadError.liveOffline)
        onConnectionChange?(false)
    }

    @discardableResult
    func send(_ message: LiveClientMessage) async -> Bool {
        guard let socket, let data = try? JSONEncoder().encode(message) else { return false }
        do {
            try await socket.send(.data(data))
            return true
        } catch {
            connectionLost(socket)
            return false
        }
    }

    func sendAwaitingAttachmentStatus(
        _ message: LiveClientMessage,
        sessionId: String,
        uploadId: String
    ) async throws -> AttachmentUploadStatus {
        let key = AttachmentWaiterKey(sessionId: sessionId, uploadId: uploadId)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard socket != nil, attachmentWaiters[key] == nil, !Task.isCancelled else {
                    continuation.resume(throwing: Task.isCancelled ? CancellationError() : AttachmentUploadError.liveOffline)
                    return
                }
                attachmentWaiters[key] = AttachmentWaiter(continuation: continuation, timeoutTask: nil)
                let timeoutTask = Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .seconds(20))
                    guard !Task.isCancelled else { return }
                    self?.failAttachmentWaiter(key, with: AttachmentUploadError.uploadTimeout)
                }
                attachmentWaiters[key]?.timeoutTask = timeoutTask
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    if !(await send(message)) {
                        failAttachmentWaiter(key, with: AttachmentUploadError.liveOffline)
                    }
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in
                self?.failAttachmentWaiter(key, with: CancellationError())
            }
        }
    }

    func cancelAttachmentWait(sessionId: String, uploadId: String) {
        failAttachmentWaiter(
            AttachmentWaiterKey(sessionId: sessionId, uploadId: uploadId),
            with: CancellationError()
        )
    }

    private func receiveLoop(_ expectedSocket: URLSessionWebSocketTask) async {
        while !Task.isCancelled, socket === expectedSocket {
            do {
                let message = try await expectedSocket.receive()
                let data: Data
                switch message {
                case .data(let value): data = value
                case .string(let value): data = Data(value.utf8)
                @unknown default: continue
                }
                let decoded = try JSONDecoder().decode(LiveServerMessage.self, from: data)
                if decoded.type == "connected" {
                    reconnectAttempt = 0
                    onConnectionChange?(true)
                }
                if let status = decoded.attachmentStatus {
                    resolveAttachmentWaiter(status)
                }
                onMessage?(decoded)
            } catch {
                connectionLost(expectedSocket)
                return
            }
        }
    }

    private func connectionLost(_ expectedSocket: URLSessionWebSocketTask) {
        guard socket === expectedSocket else { return }
        socket = nil
        receiveTask = nil
        failAttachmentWaiters(with: AttachmentUploadError.liveOffline)
        onConnectionChange?(false)
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard shouldReconnect, reconnectTask == nil else { return }
        reconnectAttempt += 1
        let seconds = min(pow(2, Double(reconnectAttempt - 1)), 30)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(seconds))
            guard !Task.isCancelled else { return }
            self?.reconnectTask = nil
            self?.connect()
        }
    }

    private func resolveAttachmentWaiter(_ status: AttachmentUploadStatus) {
        let key = AttachmentWaiterKey(sessionId: status.sessionId, uploadId: status.uploadId)
        guard let waiter = attachmentWaiters.removeValue(forKey: key) else { return }
        waiter.timeoutTask?.cancel()
        waiter.continuation.resume(returning: status)
    }

    private func failAttachmentWaiter(_ key: AttachmentWaiterKey, with error: Error) {
        guard let waiter = attachmentWaiters.removeValue(forKey: key) else { return }
        waiter.timeoutTask?.cancel()
        waiter.continuation.resume(throwing: error)
    }

    private func failAttachmentWaiters(with error: Error) {
        let waiters = attachmentWaiters
        attachmentWaiters.removeAll(keepingCapacity: false)
        for waiter in waiters.values {
            waiter.timeoutTask?.cancel()
            waiter.continuation.resume(throwing: error)
        }
    }
}
