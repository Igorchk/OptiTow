import Foundation
import OSLog
import SwiftData

/// What happened when the local call store could not be opened normally.
enum StoreRecovery: Equatable, Sendable {
    /// The saved-calls file would not open. Its files were set aside, untouched, in `RecoveredStores`
    /// (the folder name is kept here) and a clean store is in use, so calls can still be taken.
    case reset(folder: String)
    /// Not even a clean store could be created (or the old files could not be moved aside). Calls are
    /// held in memory, so they sync while the app stays open but are lost if it closes.
    case temporary

    var title: String {
        switch self {
        case .reset: "Local storage was reset"
        case .temporary: "Local storage isn't available"
        }
    }

    var message: String {
        switch self {
        case .reset:
            "The saved-calls file couldn't be opened, so the app set it aside and started a new one. "
                + "Calls that hadn't synced yet may be in the old file: tell the office. New calls save and sync as usual."
        case .temporary:
            "Calls will sync while the app stays open, but can be lost if it closes. "
                + "Keep it open until the sync badge says all synced, and tell the office."
        }
    }
}

/// The opened call store, and what it took to get it.
struct OpenedStore {
    let container: ModelContainer
    let recovery: StoreRecovery?
}

/// Opens the SwiftData store the dispatcher's offline queue lives in, and never gives up the app over it:
/// if the file will not open it is moved aside (kept, never deleted) and a clean store takes its place.
enum LocalStore {
    private static let log = Logger(subsystem: "com.optitow.dispatcher", category: "store")
    static let recoveredFolderName = "RecoveredStores"

    static func open(fileManager: FileManager = .default, now: Date = .now) -> OpenedStore {
        let configuration = ModelConfiguration(for: CallRecord.self)
        do {
            return OpenedStore(container: try ModelContainer(for: CallRecord.self, configurations: configuration),
                               recovery: nil)
        } catch {
            log.error("The call store would not open: \(String(describing: error), privacy: .public)")
        }

        // Set the old files aside, then start clean at the same address.
        if let folder = isolate(storeURL: configuration.url, fileManager: fileManager, now: now) {
            do {
                let container = try ModelContainer(for: CallRecord.self, configurations: configuration)
                log.error("Started a clean call store; the old files are in \(folder, privacy: .public)")
                return OpenedStore(container: container, recovery: .reset(folder: folder))
            } catch {
                log.error("A clean call store would not open either: \(String(describing: error), privacy: .public)")
            }
        }

        // Last resort: in memory, so the dispatcher can still take calls.
        do {
            let memory = ModelConfiguration(isStoredInMemoryOnly: true)
            return OpenedStore(container: try ModelContainer(for: CallRecord.self, configurations: memory),
                               recovery: .temporary)
        } catch {
            // SwiftData cannot make even an in-memory store: there is nothing left to fall back on.
            fatalError("Unable to create any call store: \(error)")
        }
    }

    /// Moves the store's files (the main file and its -shm / -wal companions) into a new timestamped
    /// folder under `RecoveredStores`. Returns the folder's name, or nil if nothing could be moved, in
    /// which case the files are left exactly where they were.
    static func isolate(storeURL: URL, fileManager: FileManager = .default, now: Date = .now) -> String? {
        let suffixes = ["", "-shm", "-wal"]
        let files = suffixes
            .map { URL(fileURLWithPath: storeURL.path + $0) }
            .filter { fileManager.fileExists(atPath: $0.path) }
        guard !files.isEmpty else { return nil }

        let stamp = now.formatted(Date.ISO8601FormatStyle(timeZone: .gmt)).replacingOccurrences(of: ":", with: "-")
        let folder = storeURL.deletingLastPathComponent()
            .appendingPathComponent(recoveredFolderName, isDirectory: true)
            .appendingPathComponent(stamp, isDirectory: true)
        var moved: [(from: URL, to: URL)] = []
        do {
            try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
            for file in files {
                let destination = folder.appendingPathComponent(file.lastPathComponent)
                try fileManager.moveItem(at: file, to: destination)
                moved.append((file, destination))
            }
            return "\(recoveredFolderName)/\(stamp)"
        } catch {
            log.error("Could not set the old call store aside: \(String(describing: error), privacy: .public)")
            // Put back whatever was already moved, so the store is never left half in each place.
            for item in moved { try? fileManager.moveItem(at: item.to, to: item.from) }
            return nil
        }
    }
}
