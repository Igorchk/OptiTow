import SwiftUI

/// A rounded container for a group of related controls: an adaptive surface, a hairline border and
/// a soft ambient shadow instead of a heavy drop shadow. Adapts to light and dark automatically.
struct SurfaceCard<Content: View>: View {
    var padding: CGFloat = Theme.Spacing.md
    var radius: CGFloat = Theme.Radius.large
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(Theme.hairline, lineWidth: 1)
            )
            .cardShadow()
    }
}
