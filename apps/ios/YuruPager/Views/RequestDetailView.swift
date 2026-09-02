import SwiftUI

struct RequestDetailView: View {
    @EnvironmentObject private var store: AppStore
    let requestId: String

    @State private var dialog: DecisionDialog.Kind?
    @State private var answers: [String: String] = [:]
    @State private var answerGate = SubmissionGate()
    @State private var answerError: String?

    var body: some View {
        Group {
            if let request {
                content(request)
            } else {
                ContentUnavailableView("请求不可用", systemImage: "exclamationmark.triangle", description: Text("请求可能已被移除或你不再有权查看。"))
            }
        }
        .navigationTitle(request?.kind == .question ? "代理提问" : request?.kind == .workflowGate ? "工作流审批" : "审批详情")
        .navigationBarTitleDisplayMode(.inline)
        .onDisappear {
            answers.removeAll()
            answerGate.cancel()
        }
    }

    private var request: RequestSummary? {
        store.snapshot?.requests.first { $0.id == requestId }
    }

    @ViewBuilder
    private func content(_ request: RequestSummary) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                identity(request)
                if request.deliveryStatus == .sentUnknown {
                    Label("执行结果未知，已阻止自动重发。请在工作站核对。", systemImage: "shield.slash")
                        .foregroundStyle(.red)
                        .padding()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
                        .accessibilityAddTraits(.isStaticText)
                }
                context(request)
                if request.kind == .question { questions(request) }
                handling(request)
            }
            .padding()
            .padding(.bottom, 70)
        }
        .safeAreaInset(edge: .bottom) {
            actionBar(request)
        }
        .sheet(item: $dialog) { kind in
            DecisionDialog(request: request, kind: kind)
                .presentationDetents([.medium, .large])
        }
    }

    private func identity(_ request: RequestSummary) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text(request.projectName)
                    .font(.title2.weight(.semibold))
                    .lineLimit(3)
                Spacer()
                StatusLabel(text: Labels.requestStatus(request.status), systemImage: request.status.icon, color: request.status.color)
            }
            VStack(alignment: .leading, spacing: 9) {
                identityLine("工作空间", request.workspaceName)
                identityLine("工作站", request.workstationName)
                identityLine("项目", request.projectName)
                identityLine("会话", String(request.sessionId.prefix(8)), monospaced: true)
            }
            .textSelection(.enabled)
        }
        .accessibilityElement(children: .contain)
    }

    private func identityLine(_ label: String, _ value: String, monospaced: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value)
                .font(monospaced ? .system(.subheadline, design: .monospaced) : .subheadline)
                .lineLimit(nil)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func context(_ request: RequestSummary) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("必要上下文").font(.headline)
                Spacer()
                Label(Labels.risk(request.risk), systemImage: request.risk == .high ? "exclamationmark.triangle" : "shield")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(request.risk.color)
            }
            Group {
                FactRow(label: "工具", value: request.tool)
                FactRow(label: "类别", value: request.category)
                FactRow(label: "发起人", value: request.sessionInitiatorName ?? "未知来源")
                FactRow(label: "指派给", value: request.assignedToName ?? "未指派")
                if let reason = request.context.reason { FactRow(label: "原因", value: reason) }
                if let command = request.context.command { FactRow(label: "命令", value: command, monospaced: true) }
                if let cwd = request.context.cwd { FactRow(label: "工作目录", value: cwd, monospaced: true) }
                if let grantRoot = request.context.grantRoot { FactRow(label: "授权范围", value: grantRoot, monospaced: true) }
            }
            if let permissions = request.context.requestedPermissions {
                Divider()
                if permissions.network == true { Label("请求网络访问", systemImage: "network") }
                ForEach(permissions.fileSystem ?? [], id: \.self) { permission in
                    Label("\(permission.access)：\(permission.path)", systemImage: "folder")
                        .font(.subheadline)
                        .textSelection(.enabled)
                }
            }
        }
    }

    private func questions(_ request: RequestSummary) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("需要回答").font(.headline)
            ForEach(request.context.questions ?? []) { question in
                VStack(alignment: .leading, spacing: 8) {
                    Text(question.header).font(.subheadline.weight(.semibold))
                    Text(question.question)
                    if question.isSecret {
                        Label("敏感答案只能在工作站输入", systemImage: "lock")
                            .font(.footnote)
                            .foregroundStyle(.red)
                    } else if question.options.isEmpty {
                        TextField("输入回答", text: answerBinding(question.id), axis: .vertical)
                            .lineLimit(2...6)
                            .textFieldStyle(.roundedBorder)
                            .accessibilityLabel("回答：\(question.question)")
                    } else {
                        ForEach(question.options, id: \.label) { option in
                            Button {
                                answers[question.id] = option.label
                            } label: {
                                HStack(alignment: .top) {
                                    Image(systemName: answers[question.id] == option.label ? "largecircle.fill.circle" : "circle")
                                    VStack(alignment: .leading) {
                                        Text(option.label).foregroundStyle(.primary)
                                        if !option.description.isEmpty {
                                            Text(option.description).font(.caption).foregroundStyle(.secondary)
                                        }
                                    }
                                    Spacer()
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .frame(minHeight: 44)
                            .accessibilityLabel("\(option.label)，\(option.description)")
                            .accessibilityValue(answers[question.id] == option.label ? "已选择" : "未选择")
                        }
                    }
                }
            }
            if let answerError {
                Label(answerError, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
    }

    private func handling(_ request: RequestSummary) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("处理信息").font(.headline)
            FactRow(label: "请求时间", value: Labels.date(request.requestedAt))
            FactRow(label: "过期时间", value: Labels.date(request.expiresAt))
            FactRow(label: "传送状态", value: Labels.delivery(request.deliveryStatus))
            FactRow(label: "最终操作人", value: request.decidedByName ?? "未处理")
            if let reason = request.decisionReason { FactRow(label: "拒绝原因", value: reason) }
        }
    }

    @ViewBuilder
    private func actionBar(_ request: RequestSummary) -> some View {
        if request.status == .pending {
            if request.kind == .approval || request.kind == .workflowGate {
                HStack(spacing: 12) {
                    Button(role: .destructive) { dialog = .deny } label: {
                        Label("拒绝", systemImage: "xmark")
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.bordered)
                    Button { dialog = .approve } label: {
                        Label("批准", systemImage: "checkmark")
                            .frame(maxWidth: .infinity, minHeight: 44)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(request.risk == .high ? .red : .accentColor)
                }
                .disabled(!store.isOnline)
                .padding()
                .background(.regularMaterial)
            } else {
                Button(action: submitAnswers) {
                    HStack {
                        if answerGate.isSubmitting { ProgressView().controlSize(.small) }
                        Label(answerGate.isSubmitting ? "正在提交回答" : "提交回答", systemImage: "paperplane")
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!store.isOnline || answerGate.isSubmitting || !answersComplete(request))
                .padding()
                .background(.regularMaterial)
            }
        }
    }

    private func answerBinding(_ id: String) -> Binding<String> {
        Binding(get: { answers[id] ?? "" }, set: { answers[id] = $0 })
    }

    private func answersComplete(_ request: RequestSummary) -> Bool {
        let questions = request.context.questions ?? []
        return !questions.isEmpty && questions.allSatisfy { question in
            !question.isSecret && !(answers[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    private func submitAnswers() {
        guard let request, let key = answerGate.begin() else { return }
        answerError = nil
        let payload = Dictionary(uniqueKeysWithValues: answers.map { ($0.key, [$0.value]) })
        Task {
            do {
                _ = try await store.decide(
                    request: request,
                    key: key,
                    input: DecisionInput(decision: .answer, answers: payload)
                )
                answerGate.complete()
                answers.removeAll()
                store.notice = "回答已发送"
            } catch {
                answerGate.fail()
                answerError = Labels.error(error, fallback: "无法提交回答")
            }
        }
    }
}

private struct DecisionDialog: View {
    enum Kind: String, Identifiable {
        case approve, deny
        var id: String { rawValue }
    }

    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let request: RequestSummary
    let kind: Kind

    @State private var reason = ""
    @State private var highRiskConfirmed = false
    @State private var gate = SubmissionGate()
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("请求归属") {
                    FactRow(label: "工作空间", value: request.workspaceName)
                    FactRow(label: "工作站", value: request.workstationName)
                    FactRow(label: "项目", value: request.projectName)
                    FactRow(label: "工具", value: request.tool)
                    FactRow(label: "风险", value: Labels.risk(request.risk))
                }
                if kind == .deny {
                    Section("拒绝原因") {
                        TextField("可选", text: $reason, axis: .vertical)
                            .lineLimit(2...5)
                    }
                }
                if kind == .approve && request.risk == .high {
                    Section {
                        Toggle("我已核对上下文并确认批准", isOn: $highRiskConfirmed)
                    } footer: {
                        Text("高风险操作可能修改文件、运行命令或扩大权限。")
                    }
                }
                if let errorMessage {
                    Section { Label(errorMessage, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
                }
                Section {
                    Button(role: kind == .deny ? .destructive : nil, action: submit) {
                        HStack {
                            Spacer()
                            if gate.isSubmitting { ProgressView().controlSize(.small) }
                            Text(gate.isSubmitting ? "正在提交" : kind == .approve ? "确认批准" : "确认拒绝")
                            Spacer()
                        }
                    }
                    .disabled(gate.isSubmitting || (kind == .approve && request.risk == .high && !highRiskConfirmed))
                }
            }
            .navigationTitle(kind == .approve ? "批准请求" : "拒绝请求")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { gate.cancel(); dismiss() }
                        .disabled(gate.isSubmitting)
                }
            }
            .interactiveDismissDisabled(gate.isSubmitting)
        }
    }

    private func submit() {
        guard let key = gate.begin() else { return }
        errorMessage = nil
        let trimmedReason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        let input = DecisionInput(
            decision: kind == .approve ? .approve : .deny,
            reason: trimmedReason.isEmpty ? nil : trimmedReason,
            highRiskConfirmed: kind == .approve && request.risk == .high ? true : nil
        )
        Task {
            do {
                _ = try await store.decide(request: request, key: key, input: input)
                gate.complete()
                store.notice = kind == .approve ? "批准已记录" : "请求已拒绝"
                dismiss()
            } catch {
                gate.fail()
                errorMessage = Labels.error(error, fallback: "无法提交决定")
                if let apiError = error as? APIError, apiError.code == "decision_conflict" {
                    store.notice = errorMessage
                    dismiss()
                }
            }
        }
    }
}
