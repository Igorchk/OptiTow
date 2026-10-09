import SwiftUI

/// A small uppercase status flag on a softly tinted, rounded label. The text color is tuned per
/// appearance so it stays readable on its own tint, and the optional symbol means the state never
/// relies on color alone.
struct StatusBadge: View {
    let title: String
    var systemImage: String?
    var tone: Theme.Tone = .neutral

    var body: some View {
        HStack(spacing: Theme.Spacing.xxs) {
            if let systemImage {
                Image(systemName: systemImage)
                    .imageScale(.small)
                    .accessibilityHidden(true)
            }
            // Never truncated: at accessibility text sizes the label wraps onto a second line instead.
            Text(title)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.caption2.weight(.bold).monospacedDigit())
        .textCase(.uppercase)
        .tracking(0.8)
        .foregroundStyle(tone.foreground)
        .padding(.horizontal, Theme.Spacing.xs)
        .padding(.vertical, Theme.Spacing.xxs)
        .background(tone.tint, in: RoundedRectangle(cornerRadius: Theme.Radius.small, style: .continuous))
        // Supporting text: capped so a long label still fits a row. Give it the row's full width.
        .dynamicTypeSize(...DynamicTypeSize.accessibility2)
        .accessibilityElement(children: .combine)
    }
}
