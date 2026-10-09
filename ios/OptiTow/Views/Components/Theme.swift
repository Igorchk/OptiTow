import SwiftUI
import UIKit

/// Design tokens: one place for spacing, radii, color, type and elevation.
///
/// Everything adapts to light and dark through Apple's semantic colors. Where a hue has to be
/// tuned per appearance (text on a tinted background, the accent), `Color(light:dark:)` picks the
/// value, with contrast checked independently in each mode rather than assumed to carry over.
enum Theme {
    // MARK: Spacing (8-point grid)

    enum Spacing {
        static let xxs: CGFloat = 4
        static let xs: CGFloat = 8
        static let sm: CGFloat = 12
        static let md: CGFloat = 16
        static let lg: CGFloat = 24
        static let xl: CGFloat = 32
        static let xxl: CGFloat = 48
    }

    // MARK: Corner radii

    enum Radius {
        static let small: CGFloat = 8
        static let medium: CGFloat = 14
        static let large: CGFloat = 20
    }

    // MARK: Sizing

    /// Chips and buttons are tapped one-handed during a live call: never below 52pt tall (Apple's
    /// minimum is 44pt). Scaled with Dynamic Type where it is used.
    static let controlMinHeight: CGFloat = 52

    // MARK: Surfaces

    /// The screen behind everything.
    static let background = Color(uiColor: .systemGroupedBackground)
    /// Cards and fields sitting on the background.
    static let surface = Color(uiColor: .secondarySystemGroupedBackground)
    /// A control inside a card (an unselected chip, a text field).
    static let control = Color(uiColor: .tertiarySystemGroupedBackground)
    /// The hairline that outlines cards and controls.
    static let hairline = Color.primary.opacity(0.08)
    /// Soft ambient shadow under cards. Barely there in light mode, invisible in dark.
    static let shadow = Color.black.opacity(0.06)

    // MARK: Text

    static let textPrimary = Color(uiColor: .label)
    static let textSecondary = Color(uiColor: .secondaryLabel)
    static let textTertiary = Color(uiColor: .tertiaryLabel)

    // MARK: Accent and outcome colors

    /// Safety yellow: the one loud color, reserved for "this is selected / this is the action".
    static let selected = Color(red: 1.0, green: 0.80, blue: 0.0)
    /// A darker amber that stays visible against white, for the selected outline in light mode.
    static let selectedStroke = Color(light: Color(red: 0.72, green: 0.54, blue: 0.0), dark: selected)
    /// Text and icons on any saturated fill (yellow, green, red): black is the highest-contrast
    /// choice on all three, in both appearances.
    static let onFill = Color.black

    /// Tint for text buttons in the navigation and keyboard bars: dark amber on light, yellow on dark,
    /// because bright yellow text is unreadable on white.
    static let link = Color(light: Color(red: 0.60, green: 0.38, blue: 0.0), dark: selected)

    static let won = Color(uiColor: .systemGreen)
    static let lost = Color(uiColor: .systemRed)

    // MARK: Status tones (tinted backgrounds with text that stays readable in both modes)

    enum Tone {
        case neutral, success, warning, danger

        /// Text and icon color on the tinted badge. Tuned per appearance to stay above 4.5:1.
        var foreground: Color {
            switch self {
            case .neutral: Theme.textSecondary
            case .success: Color(light: Color(red: 0.05, green: 0.45, blue: 0.20), dark: Color(red: 0.32, green: 0.85, blue: 0.50))
            case .warning: Color(light: Color(red: 0.60, green: 0.38, blue: 0.0), dark: Color(red: 1.0, green: 0.80, blue: 0.0))
            case .danger: Color(light: Color(red: 0.75, green: 0.10, blue: 0.10), dark: Color(red: 1.0, green: 0.45, blue: 0.42))
            }
        }

        var tint: Color {
            switch self {
            case .neutral: Color.primary.opacity(0.08)
            default: foreground.opacity(0.14)
            }
        }
    }

    // MARK: Motion

    /// The one spring used for state changes, so everything moves the same way.
    static let spring = Animation.spring(response: 0.35, dampingFraction: 0.82)
    /// What replaces the spring when Reduce Motion is on.
    static let reducedMotion = Animation.easeOut(duration: 0.12)
}

// MARK: - Color helper

extension Color {
    /// A color with separate values for light and dark appearance.
    init(light: Color, dark: Color) {
        self.init(uiColor: UIColor { traits in
            traits.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light)
        })
    }
}

// MARK: - Type styles
//
// Built only from Dynamic Type text styles, so every size scales with the user's settings. Numbers
// that change (phone, price, counts) use monospaced digits so they don't jitter as they update.

extension View {
    /// Section header: high contrast against the small field labels beneath it.
    func sectionTitle() -> some View {
        font(.title3.weight(.bold)).foregroundStyle(Theme.textPrimary)
    }

    /// Label above a field or chip group.
    func fieldLabel() -> some View {
        font(.subheadline.weight(.semibold)).foregroundStyle(Theme.textSecondary)
    }

    /// Small supporting text.
    func metadata() -> some View {
        font(.footnote).foregroundStyle(Theme.textSecondary)
    }

    /// Value text in an input, with steady digit widths.
    func fieldValue() -> some View {
        font(.title3.weight(.semibold).monospacedDigit()).foregroundStyle(Theme.textPrimary)
    }

    /// Soft ambient elevation for cards.
    func cardShadow() -> some View {
        shadow(color: Theme.shadow, radius: 8, x: 0, y: 2)
    }
}

// MARK: - Motion

/// Animates `value` changes with the shared spring, or a quick fade when Reduce Motion is on.
private struct ThemeAnimation<Value: Equatable>: ViewModifier {
    let value: Value
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.animation(reduceMotion ? Theme.reducedMotion : Theme.spring, value: value)
    }
}

extension View {
    func themeAnimation<Value: Equatable>(value: Value) -> some View {
        modifier(ThemeAnimation(value: value))
    }
}
