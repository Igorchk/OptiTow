import SwiftUI

/// Shown instead of the Messages sheet when this device cannot send texts (the Simulator, an iPad
/// with no SMS, no iMessage set up). The dispatcher sends the same message another way, then says so.
struct LocationLinkFallbackSheet: View {
    let message: String
    let link: URL
    /// The message was sent some other way: start waiting for the customer.
    let onSent: () -> Void
    let onCancel: () -> Void

    @State private var copied = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    Text("This device can't send texts. Send this message to the customer another way, then tap “I sent it”.")
                        .font(.body)
                        .foregroundStyle(Theme.textPrimary)

                    Text(message)
                        .font(.body)
                        .foregroundStyle(Theme.textPrimary)
                        .textSelection(.enabled)
                        .padding(Theme.Spacing.md)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous)
                            .strokeBorder(Theme.controlBorder, lineWidth: 1))

                    VStack(spacing: Theme.Spacing.sm) {
                        ActionPillButton(copied ? "Copied" : "Copy Message", systemImage: "doc.on.doc", kind: .secondary) {
                            copy()
                        }
                        ShareLink(item: message) {
                            Label("Share…", systemImage: "square.and.arrow.up")
                                .font(.headline)
                                .foregroundStyle(Theme.textPrimary)
                                .frame(maxWidth: .infinity, minHeight: Theme.controlMinHeight)
                                .background(Theme.fillMuted, in: Capsule())
                        }
                        ActionPillButton("I sent it", action: onSent)
                    }
                }
                .padding(Theme.Spacing.md)
            }
            .themedCanvas()
            .navigationTitle("Send the link")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func copy() {
        #if os(iOS)
        UIPasteboard.general.string = message
        #endif
        copied = true
    }
}

#if DEBUG
private struct FallbackPreview: View {
    private let url = URL(string: "https://script.google.com/macros/s/AKfycbx/exec?loc=a1b2c3d4e5f6")!
    var body: some View {
        LocationLinkFallbackSheet(
            message: "Hi from Recovery Towing! Please tap this link so our driver can find your exact spot: \(url.absoluteString)",
            link: url, onSent: {}, onCancel: {})
    }
}

#Preview("Send link fallback · Light") { FallbackPreview().preferredColorScheme(.light) }
#Preview("Send link fallback · Dark") { FallbackPreview().preferredColorScheme(.dark) }
#Preview("Send link fallback · Large text") { FallbackPreview().dynamicTypeSize(.accessibility3) }
#endif
