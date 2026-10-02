import SwiftUI

/// Compact queue indicator. Deliberately not a list — the app never shows past calls.
struct SyncStatusPill: View {
    let sync: SyncManager

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol)
            Text(label).lineLimit(1)
        }
        .font(.footnote.weight(.semibold))
        .foregroundStyle(color)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(color.opacity(0.15), in: Capsule())
        .accessibilityElement(children: .combine)
    }

    private var label: String {
        var text: String
        switch sync.status {
        case .syncing: text = "Syncing \(sync.pendingCount)"
        case .offline: text = sync.pendingCount > 0 ? "Offline · \(sync.pendingCount) queued" : "Offline"
        case .retrying: text = "Retrying · \(sync.pendingCount) queued"
        case .error: text = "Sync error · \(sync.pendingCount) queued"
        case .idle: text = sync.pendingCount > 0 ? "\(sync.pendingCount) queued" : "All synced"
        }
        if sync.rejectedCount > 0 { text += " · \(sync.rejectedCount) rejected" }
        return text
    }

    private var symbol: String {
        switch sync.status {
        case .syncing: "arrow.triangle.2.circlepath"
        case .offline: "wifi.slash"
        case .retrying: "clock.arrow.circlepath"
        case .error: "exclamationmark.triangle.fill"
        case .idle: sync.pendingCount > 0 ? "tray.full.fill" : "checkmark.icloud.fill"
        }
    }

    private var color: Color {
        switch sync.status {
        case .error: Theme.lost
        case .offline, .retrying: Theme.selected
        case .syncing, .idle: sync.rejectedCount > 0 ? Theme.lost : Theme.won
        }
    }
}
