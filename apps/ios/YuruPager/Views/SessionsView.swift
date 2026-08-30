import SwiftUI

struct SessionsView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ConnectionBanner()
                if let snapshot = store.snapshot {
                    if snapshot.sessions.isEmpty {
                        LoadingOrEmpty(isLoading: false, title: "没有会话", message: "工作站上报的 Codex 会话会显示在这里。", systemImage: "text.bubble")
                    } else {
                        List(snapshot.sessions.sorted { $0.updatedAt > $1.updatedAt }) { session in
                            NavigationLink {
                                SessionDetailView(sessionId: session.id)
                            } label: {
                                SessionRow(session: session, title: store.sessionTitle(for: session))
                            }
                        }
                        .listStyle(.plain)
                        .refreshable { await store.refresh() }
                    }
                } else {
                    LoadingOrEmpty(isLoading: true, title: "", message: "", systemImage: "text.bubble")
                }
            }
            .navigationTitle("会话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ScreenToolbar() }
        }
    }
}

private struct SessionRow: View {
    let session: SessionSummary
    let title: String

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.headline).lineLimit(2)
                Spacer()
                StatusLabel(text: sessionSyncLabel ?? sessionStatus, systemImage: sessionIcon, color: sessionColor)
            }
            Text("\(session.projectName) · \(session.workstationName) · \(session.model)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            HStack {
                Text(session.initiatorName ?? "未知发起人")
                Spacer()
                Text(Labels.relativeDate(session.updatedAt))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
    }

    private var sessionStatus: String {
        switch session.status {
        case "running": "运行中"; case "waiting": "等待处理"; case "completed": "已完成"
        case "failed": "失败"; default: "已中断"
        }
    }
    private var sessionSyncLabel: String? {
        switch session.syncState {
        case "historical": "历史会话"
        case "stale": "暂不可同步"
        default: nil
        }
    }
    private var sessionIcon: String {
        switch session.status { case "running": "bolt"; case "waiting": "clock"; case "completed": "checkmark.circle"; default: "exclamationmark.triangle" }
    }
    private var sessionColor: Color {
        switch session.status { case "running": .green; case "waiting": .orange; case "completed": .secondary; default: .red }
    }
}
