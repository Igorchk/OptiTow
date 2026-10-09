import Foundation

/// What the user should see for the sync queue's state: a short badge for the toolbar, and a
/// headline, message and available action for the details sheet.
///
/// It only reads `SyncManager`'s published state, so the sync engine stays untouched, and it is a
/// plain value so every state can be previewed without a running queue.
struct SyncPresentation: Equatable {
    enum Kind: Equatable {
        /// The build has no webhook address or secret, so nothing can ever sync.
        case needsSetup
        case syncing
        /// There is no network; the calls are safe on the phone and will send by themselves.
        case offline
        /// The sheet didn't accept the last attempt; the app is retrying on its own.
        case retrying
        case failed
        case queued
        case synced
    }

    var kind: Kind
    var badgeTitle: String
    var symbol: String
    var tone: Theme.Tone
    var headline: String
    var message: String
    var pending: Int
    var rejected: Int
    var canRetry: Bool

    var showsRetry: Bool { kind != .synced && kind != .needsSetup }
    var retryTitle: String { kind == .syncing ? "Syncing…" : "Retry Sync" }

    init(kind: Kind, badgeTitle: String, symbol: String, tone: Theme.Tone, headline: String,
         message: String, pending: Int = 0, rejected: Int = 0, canRetry: Bool = false) {
        self.kind = kind
        self.badgeTitle = badgeTitle
        self.symbol = symbol
        self.tone = tone
        self.headline = headline
        self.message = message
        self.pending = pending
        self.rejected = rejected
        self.canRetry = canRetry
    }

    init(status: SyncManager.Status, pending: Int, rejected: Int, isOnline: Bool, isConfigured: Bool) {
        let calls = Self.calls(pending)
        let safe = "Your calls are saved on this phone."

        var p: SyncPresentation
        if !isConfigured {
            p = SyncPresentation(
                kind: .needsSetup, badgeTitle: "Setup needed", symbol: "gearshape.fill", tone: .danger,
                headline: "Sync isn't set up",
                message: "This build has no webhook address or secret, so nothing can be sent. "
                    + "Add them (run ./setup.sh on your Mac) and rebuild the app. Your calls stay saved on this phone until then.")
        } else {
            switch status {
            case .syncing:
                p = SyncPresentation(
                    kind: .syncing, badgeTitle: "Syncing \(pending)", symbol: "arrow.triangle.2.circlepath", tone: .neutral,
                    headline: "Syncing…", message: "Sending \(calls) to the sheet.")
            case .offline:
                p = pending > 0
                    ? SyncPresentation(
                        kind: .offline, badgeTitle: "Offline · \(pending) queued", symbol: "wifi.slash", tone: .warning,
                        headline: "You're offline",
                        message: "No network. \(safe) \(Self.capitalized(calls)) will send on their own when you're back online.")
                    : SyncPresentation(
                        kind: .offline, badgeTitle: "Offline", symbol: "wifi.slash", tone: .neutral,
                        headline: "You're offline",
                        message: "No network. New calls are saved and will send when you're back online.")
            case .retrying(let reason):
                p = SyncPresentation(
                    kind: .retrying, badgeTitle: "Retrying · \(pending) queued", symbol: "clock.arrow.circlepath", tone: .warning,
                    headline: "Retrying",
                    message: "The last attempt didn't go through (\(reason)). It will retry on its own. \(safe)",
                    canRetry: true)
            case .error(let reason):
                p = SyncPresentation(
                    kind: .failed, badgeTitle: "Sync failed", symbol: "exclamationmark.triangle.fill", tone: .danger,
                    headline: "Sync failed", message: "\(reason) \(safe)", canRetry: true)
            case .idle:
                p = pending > 0
                    ? SyncPresentation(
                        kind: .queued, badgeTitle: "\(pending) queued", symbol: "tray.full.fill", tone: .warning,
                        headline: "Waiting to send", message: "\(Self.capitalized(calls)) waiting to send.", canRetry: isOnline)
                    : SyncPresentation(
                        kind: .synced, badgeTitle: "All synced", symbol: "checkmark.icloud.fill", tone: .success,
                        headline: "All synced", message: "Every call is on the sheet.")
            }
        }

        if rejected > 0 {
            let note = "\(Self.capitalized(Self.calls(rejected))) \(rejected == 1 ? "was" : "were") rejected by the server and won't be retried."
            if p.kind == .synced {
                // Nothing is waiting, so don't claim "every call is on the sheet": the rejected ones are not.
                p.badgeTitle = "\(rejected) rejected"
                p.symbol = "xmark.octagon.fill"
                p.tone = .danger
                p.headline = "Some calls were rejected"
                p.message = "All other calls are on the sheet. " + note
            } else {
                p.message += " " + note
            }
        }
        p.pending = pending
        p.rejected = rejected
        self = p
    }

    @MainActor
    init(sync: SyncManager, isConfigured: Bool) {
        self.init(status: sync.status, pending: sync.pendingCount, rejected: sync.rejectedCount,
                  isOnline: sync.isOnline, isConfigured: isConfigured)
    }

    private static func calls(_ n: Int) -> String { n == 1 ? "1 call" : "\(n) calls" }
    private static func capitalized(_ text: String) -> String { text.prefix(1).uppercased() + text.dropFirst() }
}
