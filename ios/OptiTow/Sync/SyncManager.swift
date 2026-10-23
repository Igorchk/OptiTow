import Foundation
import Network
import Observation
import OSLog
import SwiftData
#if canImport(UIKit)
import UIKit
#endif

/// Offline-first queue drain (APP_SPEC.md §2).
///
/// Saves land in SwiftData with `isSynced == false`. The queue drains, oldest first, whenever
/// the network comes up, the app returns to the foreground, or a call is saved. A record is
/// marked synced only when the webhook body says `"ok": true`.
@MainActor
@Observable
final class SyncManager {
    enum Status: Equatable {
        case idle
        case offline
        case syncing
        case retrying(String)
        case error(String)
    }

    private(set) var status: Status = .idle
    private(set) var pendingCount = 0
    private(set) var rejectedCount = 0
    /// Calls parked after repeated server errors: they need someone to look at them.
    private(set) var parkedCount = 0
    private(set) var isOnline = false

    /// A call is parked once it has failed with a server error more than this many times in a row.
    static let maxServerFaults = 5
    private static let log = Logger(subsystem: "com.optitow.dispatcher", category: "sync")

    private let context: ModelContext
    private let config: AppConfig?
    private let monitor = NWPathMonitor()
    private var isDraining = false
    private var isMonitoring = false
    private var consecutiveFailures = 0
    private var retryTask: Task<Void, Never>?

    init(context: ModelContext, config: AppConfig?) {
        self.context = context
        self.config = config
        if config == nil {
            status = .error("Secrets.plist missing or invalid — calls are saved but can't sync.")
        }
        refreshCounts()
    }

    func start() {
        guard !isMonitoring else { return }
        isMonitoring = true
        // Explicitly @Sendable: otherwise Swift 6 infers @MainActor from this method and
        // traps at runtime when the monitor calls back on its own queue.
        monitor.pathUpdateHandler = { @Sendable [weak self] path in
            let online = path.status == .satisfied
            Task { @MainActor in self?.networkChanged(online: online) }
        }
        monitor.start(queue: DispatchQueue(label: "OptiTow.NetworkMonitor"))
    }

    /// Persist a finished call and kick the queue.
    func save(_ draft: CallDraft) throws {
        context.insert(CallRecord(draft: draft))
        try context.save()
        refreshCounts()
        Task { await drain() }
    }

    func drain() async {
        guard let config, isOnline, !isDraining else { return }
        isDraining = true
        let backgroundTask = BackgroundTask(name: "OptiTow.drain")
        defer {
            isDraining = false
            refreshCounts()
            backgroundTask.end()
        }

        let client = WebhookClient(endpoint: config.webhookURL)
        while isOnline, let record = nextPending() {
            status = .syncing
            let result = await client.send(record.payload(token: config.apiSecret))

            switch result {
            case .synced:
                record.isSynced = true
                record.syncedAt = .now
                record.lastSyncError = nil
                record.attemptCount = 0
                consecutiveFailures = 0
            case .reject(let message):
                record.isRejected = true
                record.lastSyncError = message
            case .halt(let message):
                record.lastSyncError = message
                status = .error(message)
                persist()
                return
            case .retryLater(let message):
                record.syncAttempts += 1
                record.lastSyncError = message
                persist()
                scheduleRetry(reason: message)
                return
            case .serverFault(let message):
                record.syncAttempts += 1
                record.attemptCount += 1
                record.lastSyncError = message
                if record.attemptCount > Self.maxServerFaults {
                    park(record, after: message)
                    persist()
                    continue  // the calls behind it are not held up
                }
                persist()
                scheduleRetry(reason: message)
                return
            }
            persist()
        }
        status = isOnline ? .idle : .offline
    }

    /// Puts parked calls back in the queue, with a fresh count, and sends them.
    func retryParked() {
        let parked = (try? context.fetch(FetchDescriptor<CallRecord>(predicate: #Predicate { $0.isParked }))) ?? []
        guard !parked.isEmpty else { return }
        for record in parked {
            record.isParked = false
            record.isRejected = false
            record.attemptCount = 0
        }
        persist()
        refreshCounts()
        Task { await drain() }
    }

    // MARK: - Private

    /// Takes a call out of the queue for good (until someone retries it), with the reason kept on it.
    private func park(_ record: CallRecord, after message: String) {
        record.isRejected = true
        record.isParked = true
        record.lastSyncError = "Parked after \(record.attemptCount) server errors in a row. Last: \(message)"
        Self.log.error("Parked a call after \(record.attemptCount, privacy: .public) server errors: \(message, privacy: .private) (call \(record.call_id, privacy: .private))")
    }

    private func networkChanged(online: Bool) {
        isOnline = online
        guard config != nil else { return } // keep the setup error visible
        if online {
            consecutiveFailures = 0
            Task { await drain() }
        } else {
            retryTask?.cancel()
            retryTask = nil
            if !isDraining { status = .offline }
        }
    }

    private func scheduleRetry(reason: String) {
        consecutiveFailures += 1
        let delay = min(300.0, 15.0 * pow(2.0, Double(consecutiveFailures - 1)))
        status = .retrying(reason)
        retryTask?.cancel()
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.drain()
        }
    }

    private func nextPending() -> CallRecord? {
        var descriptor = FetchDescriptor<CallRecord>(
            predicate: #Predicate { !$0.isSynced && !$0.isRejected },
            sortBy: [SortDescriptor(\.createdAt)]
        )
        descriptor.fetchLimit = 1
        return try? context.fetch(descriptor).first
    }

    private func refreshCounts() {
        pendingCount = (try? context.fetchCount(FetchDescriptor<CallRecord>(
            predicate: #Predicate { !$0.isSynced && !$0.isRejected }
        ))) ?? 0
        rejectedCount = (try? context.fetchCount(FetchDescriptor<CallRecord>(
            predicate: #Predicate { $0.isRejected && !$0.isParked }
        ))) ?? 0
        parkedCount = (try? context.fetchCount(FetchDescriptor<CallRecord>(
            predicate: #Predicate { $0.isParked }
        ))) ?? 0
    }

    private func persist() {
        do {
            try context.save()
        } catch {
            status = .error("Local save failed: \(error.localizedDescription)")
        }
    }
}

/// Keeps a drain alive for a few seconds if the dispatcher locks the phone mid-sync.
@MainActor
private final class BackgroundTask {
    #if canImport(UIKit)
    private var id: UIBackgroundTaskIdentifier = .invalid

    init(name: String) {
        id = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            MainActor.assumeIsolated { self?.end() }
        }
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
    #else
    init(name: String) {}
    func end() {}
    #endif
}
