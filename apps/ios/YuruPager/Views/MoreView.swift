import SwiftUI

struct MoreView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink {
                        MembersView()
                    } label: {
                        Label("成员与授权", systemImage: "person.2")
                    }
                    NavigationLink {
                        AuditView()
                    } label: {
                        Label("审计历史", systemImage: "list.clipboard")
                    }
                    NavigationLink {
                        WorkflowsView()
                    } label: {
                        Label("工作流", systemImage: "flowchart")
                    }
                }
                Section("账户") {
                    if let user = store.user {
                        LabeledContent("用户", value: user.name)
                        LabeledContent("邮箱", value: user.email)
                    }
                    LabeledContent("服务器") {
                        Text(store.configuration.baseURL.absoluteString)
                            .font(.caption.monospaced())
                            .multilineTextAlignment(.trailing)
                            .textSelection(.enabled)
                    }
                    Button("退出登录", role: .destructive) {
                        Task { await store.logout() }
                    }
                }
            }
            .navigationTitle("更多")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ScreenToolbar() }
        }
    }
}

private struct MembersView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        Group {
            if let members = store.snapshot?.members, !members.isEmpty {
                List(members) { member in
                    NavigationLink {
                        MemberDetailView(member: member)
                    } label: {
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(member.name).font(.headline).lineLimit(2)
                                Spacer()
                                Text(Labels.role(member.role)).font(.caption).foregroundStyle(.secondary)
                            }
                            Text(member.email).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                            Text("\(member.workstationCount) 个工作站授权").font(.caption).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                }
                .refreshable { await store.refresh() }
            } else {
                ContentUnavailableView("没有成员记录", systemImage: "person.2")
            }
        }
        .navigationTitle("成员与授权")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct MemberDetailView: View {
    let member: MemberSummary

    var body: some View {
        List {
            Section("成员") {
                FactRow(label: "姓名", value: member.name)
                FactRow(label: "邮箱", value: member.email)
                FactRow(label: "角色", value: Labels.role(member.role))
            }
            Section("工作站授权") {
                if member.workstationAccess.isEmpty {
                    Text("无工作站授权").foregroundStyle(.secondary)
                }
                ForEach(member.workstationAccess, id: \.workstationId) { access in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(access.workstationName).font(.headline).lineLimit(2)
                        PermissionLine(label: "查看", allowed: access.canView)
                        PermissionLine(label: "响应", allowed: access.canRespond)
                        PermissionLine(label: "批准高风险", allowed: access.canApproveHighRisk)
                        PermissionLine(label: "管理", allowed: access.canManage)
                    }
                    .padding(.vertical, 5)
                }
            }
        }
        .navigationTitle(member.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct PermissionLine: View {
    let label: String
    let allowed: Bool

    var body: some View {
        Label(label, systemImage: allowed ? "checkmark.circle.fill" : "minus.circle")
            .font(.subheadline)
            .foregroundStyle(allowed ? .green : .secondary)
            .accessibilityValue(allowed ? "允许" : "不允许")
    }
}

private struct AuditView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        Group {
            if let audit = store.snapshot?.audit, !audit.isEmpty {
                List(audit.sorted { $0.occurredAt > $1.occurredAt }) { entry in
                    VStack(alignment: .leading, spacing: 7) {
                        Text(actionLabel(entry.action)).font(.headline).lineLimit(2)
                        Text(entry.actorName ?? "系统")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        HStack {
                            Text("\(entry.entityType) · \(String(entry.entityId.prefix(8)))")
                            Spacer()
                            Text(Labels.date(entry.occurredAt))
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                    .accessibilityElement(children: .combine)
                }
                .refreshable { await store.refresh() }
            } else {
                ContentUnavailableView("没有审计记录", systemImage: "list.clipboard")
            }
        }
        .navigationTitle("审计历史")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func actionLabel(_ action: String) -> String {
        switch action {
        case "request.approve": "批准请求"
        case "request.deny": "拒绝请求"
        case "request.answer": "回答问题"
        case "request.resolved": "请求已解决"
        case "session.message_queued": "主动消息已排队"
        case "session.message_delivery_updated": "主动消息投递更新"
        case "workstation.register": "注册工作站"
        case "workstation.heartbeat": "工作站心跳"
        case "connector.connected": "Connector 已连接"
        default: action.replacingOccurrences(of: "_", with: " ")
        }
    }
}
