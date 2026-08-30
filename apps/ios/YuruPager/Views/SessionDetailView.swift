import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import UIKit

struct SessionDetailView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    let sessionId: String

    @State private var draft = ""
    @State private var sendGate = SubmissionGate()
    @State private var sendError: String?
    @State private var lastCommand: SessionCommandSummary?
    @State private var followsLatest = true
    @State private var selectedPhotos: [PhotosPickerItem] = []
    @State private var isFileImporterPresented = false
    @State private var selectionTask: Task<Void, Never>?
    @State private var sendTask: Task<Void, Never>?
    @State private var preview: SessionImagePreview?
    @State private var previewReturnId: String?
    @AccessibilityFocusState private var focusedMediaId: String?

    var body: some View {
        Group {
            if let session {
                VStack(spacing: 0) {
                    identity(session)
                    Divider()
                    timeline
                }
                .safeAreaInset(edge: .bottom) { composer(session) }
                .task(id: session.id) { await store.openSession(session.id) }
                .onDisappear {
                    draft = ""
                    preview = nil
                    previewReturnId = nil
                    selectionTask?.cancel()
                    if store.attachmentUploadProgress != nil {
                        sendTask?.cancel()
                        store.cancelAttachmentUpload()
                    }
                    sendGate.cancel()
                    store.closeSession(session.id)
                }
            } else {
                ContentUnavailableView("会话不可用", systemImage: "text.bubble.fill")
            }
        }
        .navigationTitle("会话")
        .navigationBarTitleDisplayMode(.inline)
        .fileImporter(
            isPresented: $isFileImporterPresented,
            allowedContentTypes: [.image],
            allowsMultipleSelection: true,
            onCompletion: importFiles
        )
        .fullScreenCover(item: $preview, onDismiss: restorePreviewFocus) { item in
            SessionImagePreviewView(item: item)
        }
        .onChange(of: selectedPhotos) { _, items in
            guard !items.isEmpty else { return }
            importPhotos(items)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { clearTransientMedia() }
        }
        .onChange(of: store.liveConnected) { _, connected in
            if !connected { clearTransientMedia() }
        }
        .onChange(of: store.streamState) { _, state in
            if state != .live && state != .loading { clearTransientMedia() }
        }
    }

    private var session: SessionSummary? {
        store.snapshot?.sessions.first { $0.id == sessionId }
    }

    /// The agent that owns this session; Codex keeps its historical default.
    private var agentName: String {
        session?.agent ?? "Codex"
    }

    private func identity(_ session: SessionSummary) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(store.sessionTitle(for: session)).font(.headline).lineLimit(2)
                Spacer()
                Label(liveText, systemImage: liveIcon)
                    .font(.caption)
                    .foregroundStyle(liveColor)
            }
            Text("\(session.projectName) · \(session.workstationName) · \(session.model)")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Text(workspaceName(session.workspaceId))
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var timeline: some View {
        switch store.streamState {
        case .loading:
            ProgressView("正在读取工作站会话")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .connectorOffline:
            ContentUnavailableView("工作站离线", systemImage: "desktopcomputer.trianglebadge.exclamationmark", description: Text("工作站恢复连接后可重新读取会话。"))
        case .denied:
            ContentUnavailableView("无权查看会话", systemImage: "lock", description: Text("请联系工作空间管理员检查工作站授权。"))
        case .error:
            ContentUnavailableView {
                Label("无法读取会话", systemImage: "exclamationmark.triangle")
            } description: {
                Text("连接恢复后将重新从工作站读取。")
            } actions: {
                Button("重新连接") {
                    Task { await store.openSession(sessionId) }
                }
            }
        case .live:
            if store.conversation.entries.isEmpty && store.conversation.isHistoryComplete {
                ContentUnavailableView("暂无消息", systemImage: "text.bubble")
            } else {
                conversationList
            }
        }
    }

    private var conversationList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(store.conversation.entries) { entry in
                        conversationRow(entry)
                            .id(entry.id)
                        Divider().padding(.leading)
                    }
                    Color.clear.frame(height: 1).id("latest")
                }
            }
            .simultaneousGesture(DragGesture().onChanged { _ in followsLatest = false })
            .onChange(of: store.conversation.entries) { _, _ in
                guard followsLatest else { return }
                withAnimation(.timingCurve(0.22, 1, 0.36, 1, duration: reduceMotion ? 0 : 0.25)) {
                    proxy.scrollTo("latest", anchor: .bottom)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if !followsLatest {
                    Button {
                        followsLatest = true
                        proxy.scrollTo("latest", anchor: .bottom)
                    } label: {
                        Label("回到最新", systemImage: "arrow.down")
                    }
                    .buttonStyle(.bordered)
                    .background(.regularMaterial, in: Capsule())
                    .padding()
                }
            }
        }
    }

    @ViewBuilder
    private func conversationRow(_ entry: ConversationEntry) -> some View {
        switch entry {
        case .message(let message):
            VStack(alignment: .leading, spacing: 7) {
                Text(message.role == .user ? "你" : agentName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(message.role == .user ? Color.accentColor : .secondary)
                if message.role == .assistant {
                    MarkdownMessageView(source: message.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityLabel("\(agentName)：\(message.text)")
                } else {
                    Text(message.text.isEmpty ? " " : message.text)
                        .font(.body)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityLabel("你：\(message.text)")
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 14)
        case .activity(let activity):
            HStack(spacing: 10) {
                Image(systemName: activityIcon(activity.activity))
                    .frame(width: 20)
                    .foregroundStyle(.secondary)
                Text(activityLabel(activity))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if activity.status == .inProgress {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: activityStatusIcon(activity.status))
                        .foregroundStyle(activity.status == .completed ? Color.green : Color.secondary)
                }
            }
            .frame(minHeight: 42)
            .padding(.horizontal)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(activityLabel(activity))
        case .image(let image):
            conversationImageRow(image)
        }
    }

    @ViewBuilder
    private func conversationImageRow(_ image: ConversationImage) -> some View {
        let label = imageLabel(image)
        VStack(alignment: .leading, spacing: 7) {
            Text(image.role == .user ? "你" : agentName)
                .font(.caption.weight(.semibold))
                .foregroundStyle(image.role == .user ? Color.accentColor : .secondary)
            switch image.status {
            case .receiving(let receivedBytes):
                ZStack {
                    Color(.secondarySystemBackground)
                    VStack(spacing: 10) {
                        ProgressView(value: Double(receivedBytes), total: Double(max(image.byteLength, 1)))
                            .frame(maxWidth: 180)
                            .accessibilityHidden(true)
                        Text("正在接收图片")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .imageSlot()
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(label)，正在接收")
            case .ready:
                if let data = image.data, let uiImage = UIImage(data: data) {
                    Button {
                        showPreview(data: data, label: label, returnId: "history-\(image.id)")
                    } label: {
                        Image(uiImage: uiImage)
                            .resizable()
                            .scaledToFit()
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .background(Color(.secondarySystemBackground))
                    }
                    .buttonStyle(.plain)
                    .imageSlot()
                    .accessibilityLabel(label)
                    .accessibilityHint("打开全屏图片")
                    .accessibilityFocused($focusedMediaId, equals: "history-\(image.id)")
                } else {
                    imageFailure(label: label, message: "图片无法解码")
                }
            case .failed(let code):
                imageFailure(label: label, message: imageErrorLabel(code))
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 14)
    }

    private func imageFailure(label: String, message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: "photo.badge.exclamationmark")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("重新加载") {
                Task { await store.openSession(sessionId) }
            }
            .buttonStyle(.bordered)
            .frame(minHeight: 44)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.secondarySystemBackground))
        .imageSlot()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label)，\(message)")
    }

    private func activityLabel(_ activity: ConversationActivity) -> String {
        switch activity.status {
        case .inProgress: "正在\(activity.label)"
        case .completed: "已\(activity.label)"
        case .failed: "\(activity.label)失败"
        case .cancelled: "\(activity.label)已取消"
        }
    }

    private func activityIcon(_ activity: ConversationActivityKind) -> String {
        switch activity {
        case .command: "terminal"
        case .fileChange: "doc.badge.gearshape"
        case .tool: "wrench.and.screwdriver"
        case .webSearch: "globe"
        case .image: "photo"
        case .collaboration: "person.2"
        case .wait: "clock"
        case .review: "checklist"
        case .contextCompaction: "text.badge.minus"
        }
    }

    private func activityStatusIcon(_ status: ConversationActivityStatus) -> String {
        switch status {
        case .inProgress: "circle.dotted"
        case .completed: "checkmark.circle"
        case .failed: "xmark.circle"
        case .cancelled: "minus.circle"
        }
    }

    private func composer(_ session: SessionSummary) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let lastCommand {
                Label(Labels.command(lastCommand.status), systemImage: lastCommand.status == .sentUnknown ? "exclamationmark.triangle" : "paperplane")
                    .font(.caption)
                    .foregroundStyle(lastCommand.status == .sentUnknown ? .red : .secondary)
            }
            if let sendError {
                Text(sendError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !store.draftImages.isEmpty,
               let reason = store.imageUploadUnavailableReason(for: session) {
                Label(reason, systemImage: "wifi.slash")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if !store.draftImages.isEmpty {
                draftImageStrip
            }
            if let progress = store.attachmentUploadProgress {
                uploadProgress(progress)
            } else if store.isQueueingImageCommand {
                Label("正在排队发送", systemImage: "paperplane")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack(alignment: .bottom, spacing: 10) {
                PhotosPicker(
                    selection: $selectedPhotos,
                    maxSelectionCount: max(1, SessionImageLimits.maximumCount - store.draftImages.count),
                    matching: .images
                ) {
                    Image(systemName: "photo.on.rectangle.angled")
                        .frame(width: 20, height: 20)
                }
                .buttonStyle(.bordered)
                .frame(width: 44, height: 44)
                .disabled(!canSelectImages(session))
                .accessibilityLabel("从照片添加图片")
                .accessibilityHint("选择只保存在当前会话，点击发送后才上传")

                Button {
                    isFileImporterPresented = true
                } label: {
                    Image(systemName: "folder")
                        .frame(width: 20, height: 20)
                }
                .buttonStyle(.bordered)
                .frame(width: 44, height: 44)
                .disabled(!canSelectImages(session))
                .accessibilityLabel("从文件添加图片")
                .accessibilityHint("选择 PNG、JPEG 或 WebP 图片")

                TextField("发送消息", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                    .disabled(sendGate.isSubmitting)
                    .accessibilityHint("消息由工作站交给 \(agentName)，服务器确认排队后才会清空")
                Button(action: { send(session) }) {
                    if sendGate.isSubmitting { ProgressView().controlSize(.small) }
                    else { Image(systemName: "paperplane.fill") }
                }
                .buttonStyle(.borderedProminent)
                .frame(minWidth: 44, minHeight: 44)
                .disabled(!canSend)
                .accessibilityLabel(sendGate.isSubmitting ? "正在发送" : "发送消息")
            }
            if !store.draftImages.isEmpty || !draft.isEmpty {
                HStack {
                    Spacer()
                    Text("\(store.draftImages.count) 张图片 · \(draft.count) / 8,000")
                        .font(.caption2)
                        .foregroundStyle(draft.count > 8_000 ? Color.red : .secondary)
                        .monospacedDigit()
                }
            }
        }
        .padding()
        .background(.regularMaterial)
    }

    private var draftImageStrip: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 10) {
                ForEach(Array(store.draftImages.enumerated()), id: \.element.id) { index, attachment in
                    draftImageTile(attachment, index: index)
                }
            }
            .padding(.horizontal, 1)
        }
        .scrollIndicators(.hidden)
        .frame(height: 88)
        .accessibilityLabel("待发送图片")
    }

    private func draftImageTile(_ attachment: DraftImageAttachment, index: Int) -> some View {
        let label = "待发送图片 \(index + 1)"
        return ZStack(alignment: .topTrailing) {
            Button {
                showPreview(data: attachment.data, label: label, returnId: "draft-\(attachment.id)")
            } label: {
                Group {
                    if let image = UIImage(data: attachment.data) {
                        Image(uiImage: image).resizable().scaledToFill()
                    } else {
                        Image(systemName: "photo.badge.exclamationmark")
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(width: 80, height: 80)
                .background(Color(.secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .clipped()
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
            .accessibilityHint("打开全屏图片")
            .accessibilityFocused($focusedMediaId, equals: "draft-\(attachment.id)")

            Button {
                store.removeDraftImage(attachment.id)
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .black.opacity(0.72))
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .disabled(sendGate.isSubmitting)
            .accessibilityLabel("移除待发送图片 \(index + 1)")
        }
        .frame(width: 88, height: 88, alignment: .bottomLeading)
    }

    private func uploadProgress(_ progress: AttachmentUploadProgress) -> some View {
        HStack(spacing: 10) {
            ProgressView(value: progress.fractionCompleted)
                .accessibilityHidden(true)
            Text("正在上传第 \(min(progress.completedImages + 1, progress.totalImages)) / \(progress.totalImages) 张")
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Spacer(minLength: 0)
            Button("取消上传") {
                sendTask?.cancel()
                store.cancelAttachmentUpload()
                sendGate.fail()
                sendError = "图片上传已取消，文字和图片仍保留在本机。"
            }
            .font(.caption)
            .frame(minHeight: 44)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("正在上传图片，可取消")
    }

    private var canSend: Bool {
        let count = draft.trimmingCharacters(in: .whitespacesAndNewlines).count
        guard let session else { return false }
        let hasContent = count > 0 || !store.draftImages.isEmpty
        let imageReady = store.draftImages.isEmpty || store.canUploadImages(to: session)
        return store.isOnline
            && store.canRespond(to: session)
            && !sendGate.isSubmitting
            && hasContent
            && count <= 8_000
            && imageReady
    }

    private func send(_ session: SessionSummary) {
        let content = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (!content.isEmpty || !store.draftImages.isEmpty),
              content.count <= 8_000,
              let key = sendGate.begin() else { return }
        sendError = nil
        sendTask = Task {
            do {
                let command = try await store.sendMessage(session: session, key: key, content: content)
                sendGate.complete()
                draft = ""
                lastCommand = command
                if command.status == .sentUnknown {
                    sendError = "发送结果未知，已阻止自动重发。请在工作站核对。"
                }
            } catch is CancellationError {
                sendGate.fail()
                sendError = store.draftImages.isEmpty
                    ? "图片上传已取消，当前会话图片已清除。"
                    : "图片上传已取消，文字和图片仍保留在本机。"
            } catch {
                sendGate.fail()
                sendError = Labels.error(error, fallback: "无法发送消息")
            }
            sendTask = nil
        }
    }

    private func canSelectImages(_ session: SessionSummary) -> Bool {
        store.canRespond(to: session)
            && store.draftImages.count < SessionImageLimits.maximumCount
            && !sendGate.isSubmitting
    }

    private func importPhotos(_ items: [PhotosPickerItem]) {
        guard let session else { return }
        selectionTask?.cancel()
        selectionTask = Task {
            defer { selectedPhotos = []; selectionTask = nil }
            for item in items {
                guard !Task.isCancelled else { return }
                do {
                    guard let data = try await item.loadTransferable(type: Data.self) else {
                        throw SessionImageValidationError.invalidImage
                    }
                    let prepared = try prepareImage(data)
                    try store.addDraftImage(
                        data: prepared.data,
                        mimeType: prepared.mimeType,
                        sessionId: session.id
                    )
                } catch {
                    sendError = Labels.error(error, fallback: "无法读取所选图片")
                    return
                }
            }
        }
    }

    private func importFiles(_ result: Result<[URL], Error>) {
        guard let session else { return }
        switch result {
        case .failure(let error):
            if (error as NSError).code == NSUserCancelledError { return }
            sendError = Labels.error(error, fallback: "无法打开所选图片")
        case .success(let urls):
            selectionTask?.cancel()
            selectionTask = Task {
                defer { selectionTask = nil }
                for url in urls {
                    guard !Task.isCancelled else { return }
                    do {
                        let scoped = url.startAccessingSecurityScopedResource()
                        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                        let values = try url.resourceValues(forKeys: [.fileSizeKey])
                        try SessionImageSourceValidator.validateFileSize(values.fileSize)
                        let data = try Data(contentsOf: url, options: .mappedIfSafe)
                        try Task.checkCancellation()
                        let prepared = try prepareImage(data)
                        try store.addDraftImage(
                            data: prepared.data,
                            mimeType: prepared.mimeType,
                            sessionId: session.id
                        )
                    } catch {
                        sendError = Labels.error(error, fallback: "无法读取所选图片")
                        return
                    }
                }
            }
        }
    }

    private func prepareImage(_ data: Data) throws -> PreparedSessionImage {
        if let mimeType = SessionImageSignature.mimeType(for: data) {
            try SessionImageSignature.validate(data, mimeType: mimeType)
            guard UIImage(data: data) != nil else { throw SessionImageValidationError.invalidImage }
            return PreparedSessionImage(data: data, mimeType: mimeType)
        }
        guard data.count <= SessionImageLimits.maximumSourceBytes,
              let image = UIImage(data: data),
              let jpeg = image.jpegData(compressionQuality: 0.9) else {
            throw SessionImageValidationError.unsupportedImage
        }
        try SessionImageSignature.validate(jpeg, mimeType: "image/jpeg")
        return PreparedSessionImage(data: jpeg, mimeType: "image/jpeg")
    }

    private func showPreview(data: Data, label: String, returnId: String) {
        previewReturnId = returnId
        preview = SessionImagePreview(id: returnId, data: data, label: label)
    }

    private func restorePreviewFocus() {
        if let previewReturnId { focusedMediaId = previewReturnId }
        previewReturnId = nil
    }

    private func clearTransientMedia() {
        selectionTask?.cancel()
        selectedPhotos = []
        preview = nil
        previewReturnId = nil
    }

    private func imageLabel(_ image: ConversationImage) -> String {
        let images = store.conversation.images.filter { $0.role == image.role }
        let index = (images.firstIndex(where: { $0.id == image.id }) ?? 0) + 1
        return "\(image.role == .user ? "你发送的" : "\(agentName) 返回的")图片 \(index)"
    }

    private func imageErrorLabel(_ code: String) -> String {
        switch code {
        case "image_too_large": "图片超过允许大小"
        case "image_hash_mismatch", "hash_mismatch": "图片完整性校验失败"
        case "image_length_mismatch", "missing_image_chunk", "image_incomplete": "图片数据不完整"
        case "image_unavailable": "图片暂时不可用"
        case "image_invalid": "图片内容无效"
        case "unsupported_image", "invalid_image_type": "图片格式不受支持"
        default: "图片无法显示"
        }
    }

    private func workspaceName(_ workspaceId: String) -> String {
        store.snapshot?.workspaces.first { $0.id == workspaceId }?.name ?? "当前工作空间"
    }

    private var liveText: String {
        switch store.streamState { case .loading: "载入中"; case .live: "实时"; case .connectorOffline: "工作站离线"; case .denied: "无权限"; case .error: "连接错误" }
    }
    private var liveIcon: String {
        switch store.streamState { case .loading: "clock"; case .live: "dot.radiowaves.left.and.right"; case .connectorOffline: "wifi.slash"; case .denied: "lock"; case .error: "exclamationmark.triangle" }
    }
    private var liveColor: Color {
        switch store.streamState { case .live: .green; case .loading: .secondary; case .connectorOffline, .denied, .error: .red }
    }
}

private struct MarkdownMessageView: View {
    let source: String

    private var document: MarkdownDocument { MarkdownDocument(source: source) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if document.blocks.isEmpty {
                Text(" ")
            } else {
                ForEach(Array(document.blocks.enumerated()), id: \.offset) { _, block in
                    MarkdownBlockView(block: block)
                }
            }
        }
        .font(.body)
        .textSelection(.enabled)
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case .paragraph(let text):
            Text(text)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .heading(let level, let text):
            Text(text)
                .font(headingFont(level))
                .fontWeight(.semibold)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .listItem(let ordered, let ordinal, let level, let text):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(ordered ? "\(ordinal)." : "•")
                    .font(.body.weight(.semibold))
                    .frame(width: ordered ? 24 : 14, alignment: .trailing)
                Text(text)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.leading, CGFloat(level) * 14)
        case .quote(let level, let text):
            HStack(alignment: .top, spacing: 10) {
                Rectangle()
                    .fill(.secondary.opacity(0.45))
                    .frame(width: 3)
                Text(text)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.leading, CGFloat(max(0, level - 1)) * 14)
        case .code(let language, let text):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(text.isEmpty ? " " : text)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(11)
            }
            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 6))
            .overlay(alignment: .topTrailing) {
                if let language, !language.isEmpty {
                    Text(language)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                }
            }
        case .table(let header, let rows, let alignments):
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    markdownTableRow(header, alignments: alignments, header: true)
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        markdownTableRow(row, alignments: alignments, header: false)
                    }
                }
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(.quaternary))
            }
        case .thematicBreak:
            Divider()
        }
    }

    private func markdownTableRow(
        _ cells: [AttributedString],
        alignments: [MarkdownTableAlignment?],
        header: Bool
    ) -> some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(cells.enumerated()), id: \.offset) { index, cell in
                Text(cell)
                    .font(header ? .subheadline.weight(.semibold) : .subheadline)
                    .multilineTextAlignment(textAlignment(alignments[safe: index] ?? nil))
                    .frame(minWidth: 90, maxWidth: 220, alignment: frameAlignment(alignments[safe: index] ?? nil))
                    .padding(.horizontal, 9)
                    .padding(.vertical, 7)
                    .background(header ? Color(.secondarySystemBackground) : Color.clear)
                    .overlay(alignment: .trailing) { Rectangle().fill(.quaternary).frame(width: 1) }
            }
        }
        .overlay(alignment: .bottom) { Rectangle().fill(.quaternary).frame(height: 1) }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case ...1: return .title3
        case 2: return .headline
        default: return .subheadline
        }
    }

    private func textAlignment(_ alignment: MarkdownTableAlignment?) -> TextAlignment {
        switch alignment {
        case .center: return .center
        case .right: return .trailing
        default: return .leading
        }
    }

    private func frameAlignment(_ alignment: MarkdownTableAlignment?) -> Alignment {
        switch alignment {
        case .center: return .center
        case .right: return .trailing
        default: return .leading
        }
    }
}

private extension Collection {
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

private struct PreparedSessionImage: Sendable {
    let data: Data
    let mimeType: String
}

private struct SessionImagePreview: Identifiable {
    let id: String
    let data: Data
    let label: String
}

private struct SessionImagePreviewView: View {
    @Environment(\.dismiss) private var dismiss
    let item: SessionImagePreview

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if let image = UIImage(data: item.data) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .accessibilityLabel(item.label)
                } else {
                    ContentUnavailableView("图片无法显示", systemImage: "photo.badge.exclamationmark")
                        .foregroundStyle(.white)
                }
            }
            .navigationTitle(item.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("关闭图片")
                }
            }
        }
    }
}

private extension View {
    func imageSlot() -> some View {
        frame(maxWidth: 520)
            .aspectRatio(4 / 3, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}
