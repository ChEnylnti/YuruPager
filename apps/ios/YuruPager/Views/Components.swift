import SwiftUI

struct WorkspaceMenu: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        Menu {
            Button {
                Task { await store.selectWorkspace(nil) }
            } label: {
                Label("全部工作空间", systemImage: store.selectedWorkspaceId == nil ? "checkmark" : "square.grid.2x2")
            }
            ForEach(store.snapshot?.workspaces ?? []) { workspace in
                Button {
                    Task { await store.selectWorkspace(workspace.id) }
                } label: {
                    Label(workspace.name, systemImage: store.selectedWorkspaceId == workspace.id ? "checkmark" : "building.2")
                }
            }
        } label: {
            Label(currentName, systemImage: "building.2")
                .lineLimit(1)
        }
        .accessibilityLabel("当前工作空间：\(currentName)")
        .accessibilityHint("轻点以切换工作空间")
    }

    private var currentName: String {
        guard let id = store.selectedWorkspaceId else { return "全部工作空间" }
        return store.snapshot?.workspaces.first(where: { $0.id == id })?.name ?? "当前工作空间"
    }
}

struct ScreenToolbar: ToolbarContent {
    @EnvironmentObject private var store: AppStore

    var body: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) { WorkspaceMenu() }
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                Task { await store.refresh() }
            } label: {
                if store.isRefreshing { ProgressView().controlSize(.small) }
                else { Image(systemName: "arrow.clockwise") }
            }
            .disabled(store.isRefreshing)
            .accessibilityLabel("刷新")
        }
    }
}

struct ConnectionBanner: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        if !store.isOnline {
            Label("当前离线，提交操作已停用", systemImage: "wifi.slash")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal)
                .padding(.vertical, 10)
                .background(.thinMaterial)
                .accessibilityAddTraits(.isStaticText)
        }
    }
}

struct LoadingOrEmpty: View {
    let isLoading: Bool
    let title: String
    let message: String
    let systemImage: String

    var body: some View {
        if isLoading {
            ProgressView("正在载入")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ContentUnavailableView(title, systemImage: systemImage, description: Text(message))
        }
    }
}

struct StatusLabel: View {
    let text: String
    let systemImage: String
    let color: Color

    var body: some View {
        Label(text, systemImage: systemImage)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .lineLimit(1)
            .accessibilityElement(children: .combine)
    }
}

struct FactRow: View {
    let label: String
    let value: String
    var monospaced = false

    var body: some View {
        LabeledContent(label) {
            Text(value)
                .font(monospaced ? .system(.body, design: .monospaced) : .body)
                .foregroundStyle(.primary)
                .multilineTextAlignment(.trailing)
                .lineLimit(nil)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }
}

extension RiskLevel {
    var color: Color {
        switch self { case .low: .green; case .medium: .orange; case .high: .red }
    }
}

extension RequestStatus {
    var icon: String {
        switch self {
        case .pending: "clock"
        case .approved: "checkmark.circle"
        case .denied: "xmark.circle"
        case .expired: "hourglass.bottomhalf.filled"
        case .cancelled: "slash.circle"
        case .interrupted: "exclamationmark.triangle"
        }
    }

    var color: Color {
        switch self {
        case .pending: .orange
        case .approved: .green
        case .denied: .red
        case .expired, .cancelled: .secondary
        case .interrupted: .red
        }
    }
}
