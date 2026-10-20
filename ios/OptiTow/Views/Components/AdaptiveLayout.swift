import SwiftUI

/// Widths that keep the form readable on a wide iPad screen. The form is built for a phone; on an iPad
/// it either sits in two columns (regular width) or is held to a phone-like measure (compact width).
enum AdaptiveLayout {
    /// One column of cards: never wider than this, centered when the window is wider.
    static let columnMaxWidth: CGFloat = 640
    /// Two columns side by side, with the gap between them: the widest the dispatch form grows.
    static let twoColumnMaxWidth: CGFloat = 1_240
}

extension View {
    /// Holds the view to `maxWidth` and centers it in whatever space there is. Narrower than
    /// `maxWidth` (any phone) it has no effect.
    func readableWidth(_ maxWidth: CGFloat = AdaptiveLayout.columnMaxWidth) -> some View {
        frame(maxWidth: maxWidth).frame(maxWidth: .infinity)
    }
}
