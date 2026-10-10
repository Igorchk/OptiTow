import SwiftUI

/// Details for the sync queue, opened from the toolbar badge. It follows the queue live: a retry
/// moves it from "failed" to "syncing" to "all synced" while it is open.
struct SyncStatusSheet: View {
    let sync: SyncManager
    let isConfigured: Bool

    /// Measured height of the content, so the sheet hugs it instead of leaving a half-empty panel.
    @State private var contentHeight: CGFloat = 320

    var body: some View {
        SyncStatusContent(state: SyncPresentation(sync: sync, isConfigured: isConfigured)) {
            Task { await sync.drain() }
        }
        .onPreferenceChange(ContentHeightKey.self) { contentHeight = $0 }
        // Room for the drag indicator and the home-indicator safe area, which the content doesn't measure.
        .presentationDetents([.height(contentHeight + Theme.Spacing.xl + Theme.Spacing.md), .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(Theme.Radius.large)
        .presentationBackground { ThemedFill(role: .canvas) }
    }
}

private struct ContentHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// The sheet's content as a plain function of its state, so every state can be previewed.
struct SyncStatusContent: View {
    let state: SyncPresentation
    let onRetry: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                    StatusBadge(title: state.badgeTitle, systemImage: state.symbol, tone: state.tone)
                    Text(state.headline)
                        .font(.title2.weight(.bold))
                        .foregroundStyle(Theme.textPrimary)
                        .accessibilityAddTraits(.isHeader)
                    Text(state.message)
                        .font(.body)
                        .foregroundStyle(Theme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                if state.pending > 0 || state.rejected > 0 {
                    SurfaceCard {
                        VStack(spacing: Theme.Spacing.sm) {
                            if state.pending > 0 {
                                countRow("Waiting to send", state.pending, tone: .warning)
                            }
                            if state.pending > 0 && state.rejected > 0 { Divider() }
                            if state.rejected > 0 {
                                countRow("Rejected by server", state.rejected, tone: .danger)
                            }
                        }
                    }
                }

                if state.showsRetry {
                    VStack(spacing: Theme.Spacing.xs) {
                        ActionPillButton(state.retryTitle, systemImage: "arrow.clockwise", action: onRetry)
                            .disabled(!state.canRetry)
                        if state.kind == .offline {
                            Text("Retrying needs a network connection.").metadata()
                        }
                    }
                }
            }
            .padding(Theme.Spacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(GeometryReader { proxy in
                Color.clear.preference(key: ContentHeightKey.self, value: proxy.size.height)
            })
        }
        .background(Theme.background)
        .themeAnimation(value: state)
        .sensoryFeedback(.success, trigger: state.kind) { _, new in new == .synced }
    }

    private func countRow(_ title: String, _ value: Int, tone: Theme.Tone) -> some View {
        HStack {
            Text(title).font(.body).foregroundStyle(Theme.textPrimary)
            Spacer(minLength: Theme.Spacing.sm)
            Text("\(value)")
                .font(.title3.weight(.bold).monospacedDigit())
                .foregroundStyle(tone.foreground)
        }
        .accessibilityElement(children: .combine)
    }
}

#if DEBUG
/// Every sync state the screen can show, for previews and visual review.
struct SyncStatesGallery: View {
    private static let all: [SyncPresentation] = [
        SyncPresentation(status: .idle, pending: 0, rejected: 0, isOnline: true, isConfigured: true),
        SyncPresentation(status: .syncing, pending: 3, rejected: 0, isOnline: true, isConfigured: true),
        SyncPresentation(status: .offline, pending: 3, rejected: 0, isOnline: false, isConfigured: true),
        SyncPresentation(status: .retrying("The sheet is busy"), pending: 2, rejected: 0, isOnline: true, isConfigured: true),
        SyncPresentation(status: .error("The webhook rejected the secret."), pending: 2, rejected: 1, isOnline: true, isConfigured: true),
        SyncPresentation(status: .idle, pending: 0, rejected: 2, isOnline: true, isConfigured: true),
        SyncPresentation(status: .error("Secrets.plist missing or invalid."), pending: 4, rejected: 0, isOnline: true, isConfigured: false),
    ]

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.lg) {
                ForEach(Self.all.indices, id: \.self) { index in
                    SurfaceCard { SyncStatusContent(state: Self.all[index]) {} .frame(minHeight: 0) }
                }
            }
            .padding(Theme.Spacing.md)
        }
        .background(Theme.background)
    }
}

#Preview("Sync states · Light") { SyncStatesGallery().preferredColorScheme(.light) }
#Preview("Sync states · Dark") { SyncStatesGallery().preferredColorScheme(.dark) }
#Preview("Sync states · Large text") { SyncStatesGallery().dynamicTypeSize(.accessibility3) }
#endif
