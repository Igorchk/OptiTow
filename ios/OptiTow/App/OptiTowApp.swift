import SwiftData
import SwiftUI

@main
struct OptiTowApp: App {
    private let container: ModelContainer
    /// Set when the local store had to be reset or could not be kept on disk; shown once as a banner.
    private let storeRecovery: StoreRecovery?
    @State private var sync: SyncManager
    @Environment(\.scenePhase) private var scenePhase

    init() {
        // Never fatal: a store that won't open is set aside and replaced (see LocalStore).
        let opened = LocalStore.open()
        self.container = opened.container
        self.storeRecovery = opened.recovery
        _sync = State(initialValue: SyncManager(context: opened.container.mainContext, config: AppConfig.load()))
    }

    var body: some Scene {
        WindowGroup {
            DispatchFormView(storeRecovery: storeRecovery)
                .environment(sync)
                .tint(Theme.link)
                .task { sync.start() }
        }
        .modelContainer(container)
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task { await sync.drain() }
            }
        }
    }
}
