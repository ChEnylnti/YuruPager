import SwiftUI

struct RootView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        Group {
            switch store.phase {
            case .launching:
                ProgressView("正在恢复会话")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityLabel("正在恢复登录会话")
            case .signedOut:
                LoginView()
            case .ready:
                MainTabView()
            }
        }
        .alert("YuruPager", isPresented: Binding(
            get: { store.notice != nil },
            set: { if !$0 { store.notice = nil } }
        )) {
            Button("好", role: .cancel) { store.notice = nil }
        } message: {
            Text(store.notice ?? "")
        }
    }
}

private struct MainTabView: View {
    @EnvironmentObject private var store: AppStore
    @State private var selection: Tab = .requests

    private enum Tab: Hashable {
        case requests, workstations, sessions, usage, more
    }

    var body: some View {
        TabView(selection: $selection) {
            RequestsView()
                .tabItem { Label("请求", systemImage: "tray.full") }
                .badge(pendingCount)
                .tag(Tab.requests)

            WorkstationsView()
                .tabItem { Label("工作站", systemImage: "desktopcomputer") }
                .tag(Tab.workstations)

            SessionsView()
                .tabItem { Label("会话", systemImage: "text.bubble") }
                .tag(Tab.sessions)

            UsageView()
                .tabItem { Label("用量", systemImage: "chart.bar") }
                .tag(Tab.usage)

            MoreView()
                .tabItem { Label("更多", systemImage: "ellipsis") }
                .tag(Tab.more)
        }
    }

    private var pendingCount: Int {
        store.snapshot?.requests.filter { $0.status == .pending }.count ?? 0
    }
}
