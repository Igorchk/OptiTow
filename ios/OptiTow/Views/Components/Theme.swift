import SwiftUI

/// High-contrast dark palette tuned for glanceable, one-handed use.
enum Theme {
    static let background = Color(red: 0.05, green: 0.05, blue: 0.06)
    static let surface = Color(red: 0.13, green: 0.13, blue: 0.15)
    static let surfaceBorder = Color.white.opacity(0.14)
    static let textPrimary = Color.white
    static let textSecondary = Color.white.opacity(0.62)

    /// Selected chips: safety yellow on near-black reads instantly at arm's length.
    static let selected = Color(red: 1.0, green: 0.80, blue: 0.0)
    static let onSelected = Color.black

    static let won = Color(red: 0.13, green: 0.77, blue: 0.37)
    static let lost = Color(red: 0.94, green: 0.27, blue: 0.27)

    static let chipHeight: CGFloat = 58
    static let cornerRadius: CGFloat = 14
}
