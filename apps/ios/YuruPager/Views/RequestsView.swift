import SwiftUI

struct RequestsView: View {
    @EnvironmentObject private var store: AppStore
    @State private var scope: Scope = .pending

    private enum Scope: String, CaseIterable, Identifiable {
        case pending = "待处理"
        case history = "历史"
        var id: Self { self }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ConnectionBanner()
                Picker("请求范围", selection: $scope) {
                    ForEach(Scope.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.vertical, 10)

                if let snapshot = store.snapshot {
                    if requests(snapshot).isEmpty {
                        LoadingOrEmpty(
                            isLoading: false,
                            title: scope == .pending ? "没有待处理请求" : "没有历史请求",
                            message: scope == .pending ? "新的审批和问题会显示在这里。" : "处理过的请求会显示在这里。",
                            systemImage: scope == .pending ? "checkmark.circle" : "clock.arrow.circlepath"
                        )
                    } else {
                        List(requests(snapshot)) { request in
                            NavigationLink {
                                RequestDetailView(requestId: request.id)
                            } label: {
                                RequestRow(request: request)
                            }
                        }
                        .listStyle(.plain)
                        .refreshable { await store.refresh() }
                    }
                } else {
                    LoadingOrEmpty(isLoading: true, title: "", message: "", systemImage: "tray")
                }
            }
            .navigationTitle("请求")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ScreenToolbar() }
        }
    }

    private func requests(_ snapshot: Snapshot) -> [RequestSummary] {
        snapshot.requests
            .filter { scope == .pending ? $0.status == .pending : $0.status != .pending }
            .sorted { $0.requestedAt > $1.requestedAt }
    }
}

private struct RequestRow: View {
    let request: RequestSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(request.projectName)
                    .font(.headline)
                    .lineLimit(2)
                Spacer(minLength: 8)
                StatusLabel(
                    text: Labels.requestStatus(request.status),
                    systemImage: request.status.icon,
                    color: request.status.color
                )
            }
            Text("\(request.workspaceName) · \(request.workstationName)")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            HStack {
                Label(Labels.risk(request.risk), systemImage: request.risk == .high ? "exclamationmark.triangle" : "shield")
                    .foregroundStyle(request.risk.color)
                Text(request.tool)
                    .lineLimit(1)
                Spacer()
                Text(Labels.relativeDate(request.requestedAt))
                    .foregroundStyle(.secondary)
            }
            .font(.caption)
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(request.projectName)，\(request.workspaceName)，\(Labels.risk(request.risk))，\(Labels.requestStatus(request.status))")
    }
}
