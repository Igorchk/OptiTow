import SwiftUI

/// Tells the dispatcher that the local call store had to be recovered, until they dismiss it.
struct StoreRecoveryBanner: View {
    let recovery: StoreRecovery
    let onDismiss: () -> Void

    private var tone: Theme.Tone { recovery == .temporary ? .danger : .warning }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Label {
                Text(recovery.title)
                    .font(.headline)
                    .foregroundStyle(Theme.textPrimary)
            } icon: {
                Image(systemName: "externaldrive.badge.exclamationmark")
                    .foregroundStyle(tone.foreground)
            }
            .accessibilityAddTraits(.isHeader)
            Text(recovery.message)
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
            ActionPillButton("Dismiss", kind: .secondary, fillsWidth: false, action: onDismiss)
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .softCard()
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 2).fill(tone.foreground).frame(width: 4).padding(.vertical, Theme.Spacing.sm)
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.top, Theme.Spacing.xs)
        .accessibilityElement(children: .contain)
    }
}

#if DEBUG
#Preview("Store reset") {
    StoreRecoveryBanner(recovery: .reset(folder: "RecoveredStores/2026-10-23T10-00-00Z")) {}
        .padding(.vertical).background(Theme.background)
}
#Preview("Store in memory · Large text") {
    StoreRecoveryBanner(recovery: .temporary) {}
        .padding(.vertical).background(Theme.background).dynamicTypeSize(.accessibility3)
}
#endif
