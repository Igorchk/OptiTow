import SwiftUI

/// A compact line under the Pickup row while a location request is outstanding: waiting (with a
/// cancel X), timed out, or failed. Shows nothing when there is no request.
struct LocationRequestStatus: View {
    let state: CustomerLocationService.State
    let onDismiss: () -> Void

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if let content {
            HStack(spacing: Theme.Spacing.sm) {
                if content.isWaiting {
                    ProgressView().accessibilityHidden(true)
                } else {
                    Image(systemName: content.symbol)
                        .foregroundStyle(content.tone.foreground)
                        .accessibilityHidden(true)
                }
                Text(content.text)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(content.isWaiting ? Theme.textPrimary : content.tone.foreground)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(action: onDismiss) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(Theme.textSecondary)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(content.isWaiting ? "Cancel waiting for location" : "Dismiss")
            }
            .padding(.leading, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.xxs)
            .background(Theme.control, in: RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous)
                .strokeBorder(Theme.controlBorder, lineWidth: 1))
            .accessibilityElement(children: .contain)
        }
    }

    private struct Content {
        let text: String
        let symbol: String
        let tone: Theme.Tone
        var isWaiting = false
    }

    private var content: Content? {
        switch state {
        case .listening:
            Content(text: "Waiting for customer location…", symbol: "location", tone: .neutral, isWaiting: true)
        case .timedOut:
            Content(text: "No location yet. Ask again or enter the address.", symbol: "clock.badge.exclamationmark", tone: .warning)
        case .failed(let message):
            Content(text: message, symbol: "exclamationmark.triangle.fill", tone: .danger)
        case .idle, .preparing, .received:
            nil
        }
    }
}

#if DEBUG
private struct StatusPreview: View {
    var body: some View {
        VStack(spacing: Theme.Spacing.md) {
            LocationRequestStatus(state: .listening(token: "a1b2c3d4e5f6"), onDismiss: {})
            LocationRequestStatus(state: .timedOut, onDismiss: {})
            LocationRequestStatus(state: .failed("Can't reach the server. Asking for a location needs a connection."), onDismiss: {})
        }
        .padding(Theme.Spacing.md)
        .background(Theme.background)
    }
}

#Preview("Location status · Light") { StatusPreview().preferredColorScheme(.light) }
#Preview("Location status · Dark") { StatusPreview().preferredColorScheme(.dark) }
#Preview("Location status · Large text") { ScrollView { StatusPreview() }.dynamicTypeSize(.accessibility3) }
#endif
