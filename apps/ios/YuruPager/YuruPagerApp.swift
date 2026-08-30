import SwiftUI

@main
struct YuruPagerApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .task { await store.bootstrap() }
                .onChange(of: scenePhase) { _, phase in
                    switch phase {
                    case .active: Task { await store.activate() }
                    case .background: store.deactivate()
                    default: break
                    }
                }
        }
    }
}
