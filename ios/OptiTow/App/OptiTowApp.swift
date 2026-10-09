import SwiftData
import SwiftUI

@main
struct OptiTowApp: App {
    private let container: ModelContainer
    @State private var sync: SyncManager
    @Environment(\.scenePhase) private var scenePhase

    init() {
        let container: ModelContainer
        do {
            container = try ModelContainer(for: CallRecord.self)
        } catch {
            fatalError("Unable to open the local call store: \(error)")
        }
        self.container = container
        _sync = State(initialValue: SyncManager(context: container.mainContext, config: AppConfig.load()))
    }

    var body: some Scene {
        WindowGroup {
            DispatchFormView()
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
