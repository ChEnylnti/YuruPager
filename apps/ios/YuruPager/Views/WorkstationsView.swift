import SwiftUI

struct WorkstationsView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ConnectionBanner()
                if let snapshot = store.snapshot {
                    if snapshot.workstations.isEmpty {
                        LoadingOrEmpty(isLoading: false, title: "没有工作站", message: "连接的工作站会显示在这里。", systemImage: "desktopcomputer")
                    } else {
                        List(snapshot.workstations.sorted { $0.name < $1.name }) { workstation in
                            NavigationLink {
                                WorkstationDetailView(workstationId: workstation.id)
                            } label: {
                                WorkstationRow(workstation: workstation)
                            }
                        }
                        .listStyle(.plain)
                        .refreshable { await store.refresh() }
                    }
                } else {
                    LoadingOrEmpty(isLoading: true, title: "", message: "", systemImage: "desktopcomputer")
                }
            }
            .navigationTitle("工作站")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ScreenToolbar() }
        }
    }
}

private struct WorkstationRow: View {
    let workstation: WorkstationSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(workstation.name).font(.headline).lineLimit(2)
                Spacer()
                StatusLabel(text: statusText, systemImage: statusIcon, color: statusColor)
            }
            Text(workstation.workspaceName)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            HStack {
                Text(workstation.platform)
                Spacer()
                Text("\(workstation.activeSessionCount) 个活动会话")
                if workstation.pendingCount > 0 { Text("\(workstation.pendingCount) 待处理").foregroundStyle(.orange) }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
    }

    private var statusText: String {
        switch workstation.status { case "online": "在线"; case "degraded": "降级"; default: "离线" }
    }
    private var statusIcon: String {
        switch workstation.status { case "online": "checkmark.circle"; case "degraded": "exclamationmark.triangle"; default: "wifi.slash" }
    }
    private var statusColor: Color {
        switch workstation.status { case "online": .green; case "degraded": .orange; default: .secondary }
    }
}

private struct WorkstationDetailView: View {
    @EnvironmentObject private var store: AppStore
    let workstationId: String

    var body: some View {
        Group {
            if let workstation {
                List {
                    Section("工作站") {
                        FactRow(label: "名称", value: workstation.name)
                        FactRow(label: "工作空间", value: workstation.workspaceName)
                        FactRow(label: "平台", value: workstation.platform)
                        FactRow(label: "Connector", value: workstation.connectorVersion)
                        FactRow(label: "状态", value: statusText(workstation.status))
                        FactRow(label: "最后在线", value: workstation.lastSeenAt.map(Labels.date) ?? "尚无记录")
                    }
                    Section("当前活动") {
                        FactRow(label: "活动会话", value: "\(workstation.activeSessionCount)")
                        FactRow(label: "待处理请求", value: "\(workstation.pendingCount)")
                    }
                    let sessions = (store.snapshot?.sessions ?? []).filter { $0.workstationId == workstationId }
                    if !sessions.isEmpty {
                        Section("会话") {
                            ForEach(sessions) { session in
                                NavigationLink {
                                    SessionDetailView(sessionId: session.id)
                                } label: {
                                    VStack(alignment: .leading) {
                                        Text(store.sessionTitle(for: session)).lineLimit(2)
                                        Text("\(session.projectName) · \(session.model)").font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                }
            } else {
                ContentUnavailableView("工作站不可用", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
            }
        }
        .navigationTitle(workstation?.name ?? "工作站")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var workstation: WorkstationSummary? {
        store.snapshot?.workstations.first { $0.id == workstationId }
    }

    private func statusText(_ status: String) -> String {
        switch status { case "online": "在线"; case "degraded": "降级"; default: "离线" }
    }
}
