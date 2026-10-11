import SwiftUI

/// A one-line badge under the Pickup row: the driving time from the yard (or the Start Location) to
/// the pickup with live traffic. It takes the same single line whether it is still working or done,
/// so the form below it does not move when the answer arrives.
struct ETABadge: View {
    let state: ETAState
    let fromYard: Bool

    var body: some View {
        if let content {
            HStack(spacing: Theme.Spacing.xs) {
                if case .loading = state {
                    ProgressView().controlSize(.small).accessibilityHidden(true)
                } else {
                    Image(systemName: "clock.fill")
                        .imageScale(.small)
                        .foregroundStyle(Theme.textSecondary)
                        .accessibilityHidden(true)
                }
                Text(content)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .multilineTextAlignment(.leading)
            }
            .padding(.horizontal, Theme.Spacing.sm)
            .padding(.vertical, Theme.Spacing.xs)
            .frame(maxWidth: .infinity, alignment: .leading)
            .softFieldRow(radius: Theme.Radius.small)
            .accessibilityElement(children: .combine)
        }
    }

    private var content: String? {
        let origin = fromYard ? "Yard" : "Start"
        switch state {
        case .idle: return nil
        case .loading: return "Estimating ETA from \(origin)…"
        case .ready(let time): return "ETA from \(origin): ~\(time) (live traffic)"
        case .unavailable: return "ETA from \(origin) unavailable"
        }
    }
}

#if DEBUG
private struct ETABadgeGallery: View {
    var body: some View {
        VStack(spacing: Theme.Spacing.md) {
            ETABadge(state: .loading, fromYard: true)
            ETABadge(state: .ready("18min"), fromYard: true)
            ETABadge(state: .ready("1hr 12min"), fromYard: false)
            ETABadge(state: .unavailable, fromYard: true)
        }
        .padding(Theme.Spacing.md)
        .background(Theme.background)
    }
}

#Preview("ETA badge · Light") { ETABadgeGallery().preferredColorScheme(.light) }
#Preview("ETA badge · Dark") { ETABadgeGallery().preferredColorScheme(.dark) }
#Preview("ETA badge · Large text") { ScrollView { ETABadgeGallery() }.dynamicTypeSize(.accessibility3) }
#endif
