#if DEBUG
import SwiftUI

/// Every design-system component in every state, for previews and visual review. Debug builds only.
struct ComponentGallery: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                Text("Components").sectionTitle()

                SurfaceCard {
                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        Text("Surface card").sectionTitle()
                        Text("Hairline border, adaptive surface, soft ambient shadow.").metadata()
                        Text("(916) 555-0199").fieldValue()
                    }
                }

                SurfaceCard {
                    VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                        Text("Status badges").fieldLabel()
                        FlowRow {
                            StatusBadge(title: "All synced", systemImage: "checkmark.icloud.fill", tone: .success)
                            StatusBadge(title: "3 queued", systemImage: "tray.full.fill", tone: .warning)
                            StatusBadge(title: "Offline", systemImage: "wifi.slash", tone: .neutral)
                            StatusBadge(title: "Sync failed", systemImage: "exclamationmark.triangle.fill", tone: .danger)
                        }
                    }
                }

                SurfaceCard {
                    VStack(spacing: Theme.Spacing.sm) {
                        Text("Action buttons").fieldLabel().frame(maxWidth: .infinity, alignment: .leading)
                        ActionPillButton("Save Call") {}
                        ActionPillButton("Retry Sync", systemImage: "arrow.clockwise", kind: .secondary) {}
                        ActionPillButton("Discard Call", systemImage: "trash", kind: .destructive) {}
                        ActionPillButton("Enter a 10-digit phone to save") {}.disabled(true)
                    }
                }
            }
            .padding(Theme.Spacing.md)
        }
        .background(Theme.background)
    }
}

/// Badges side by side, wrapping onto new lines. At accessibility text sizes they stack instead,
/// so each gets the full width and its words never break mid-word.
private struct FlowRow<Content: View>: View {
    @Environment(\.dynamicTypeSize) private var typeSize
    @ViewBuilder var content: Content

    var body: some View {
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: Theme.Spacing.xs) { content }
        } else {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 130), spacing: Theme.Spacing.xs, alignment: .leading)],
                      alignment: .leading, spacing: Theme.Spacing.xs) {
                content
            }
        }
    }
}

#Preview("Light") {
    ComponentGallery().preferredColorScheme(.light)
}

#Preview("Dark") {
    ComponentGallery().preferredColorScheme(.dark)
}

#Preview("Large text") {
    ComponentGallery().dynamicTypeSize(.accessibility3)
}
#endif
