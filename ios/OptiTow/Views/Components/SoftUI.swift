import SwiftUI

/// Design tokens for the neumorphic ("soft UI") theme: one matte color for the screen and every
/// control, with a light and a dark shadow on opposite corners making a shape look raised (shadows
/// outside) or pressed in (shadows inside).
enum Soft {
    static let canvas = Color(light: Color(hex: 0xE0E5EC), dark: Color(hex: 0x24272C))
    /// The lit edge: white in light mode, a lifted charcoal in dark.
    static let highlight = Color(light: Color(hex: 0xFFFFFF), dark: Color(hex: 0x32363D))
    /// The shaded edge: a muted slate in light mode, near-black in dark.
    static let shade = Color(light: Color(hex: 0xA3B1C6), dark: Color(hex: 0x101214))

    /// Light mode lifts a little higher than dark, where the same shadows would look heavy.
    static func offset(_ scheme: ColorScheme) -> CGFloat { scheme == .dark ? 3 : 4 }
    static func blur(_ scheme: ColorScheme) -> CGFloat { scheme == .dark ? 5 : 6 }
}

extension Color {
    fileprivate init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255)
    }
}

// MARK: - Surfaces

/// A raised, convex surface: highlight up-left, shade down-right.
private struct RaisedSurface: View {
    let radius: CGFloat
    var fill: Color = Soft.canvas
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(fill)
            .shadow(color: Soft.highlight, radius: Soft.blur(scheme), x: -Soft.offset(scheme), y: -Soft.offset(scheme))
            .shadow(color: Soft.shade, radius: Soft.blur(scheme), x: Soft.offset(scheme), y: Soft.offset(scheme))
    }
}

/// A pressed-in, concave surface: shade inside the up-left edge, highlight inside the down-right.
private struct InsetSurface: View {
    let radius: CGFloat
    var tint: Color = Soft.canvas
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let offset = Soft.offset(scheme) * 0.75
        let blur = Soft.blur(scheme) * 0.7
        RoundedRectangle(cornerRadius: radius, style: .continuous)
            .fill(tint
                .shadow(.inner(color: Soft.shade, radius: blur, x: offset, y: offset))
                .shadow(.inner(color: Soft.highlight, radius: blur, x: -offset, y: -offset)))
    }
}

// MARK: - Cards

extension View {
    /// A raised card in the neumorphic theme; the white card with a hairline and a soft ambient
    /// shadow in the standard one. Only the background changes between themes, so the card's
    /// content keeps its identity and state when the theme is switched.
    func softCard(radius: CGFloat = Theme.Radius.large) -> some View {
        modifier(SoftCard(radius: radius))
    }

    /// A text well or address row: pressed in for the neumorphic theme, a faint tint with a fine
    /// outline for the standard one. The outline turns amber and thick while `isFocused`.
    func softFieldRow(isFocused: Bool = false, radius: CGFloat = Theme.Radius.medium) -> some View {
        modifier(SoftFieldRow(isFocused: isFocused, radius: radius))
    }

    /// The surface for a button's label, meant for `SoftButtonStyle`: raised when unselected, pressed
    /// in and tinted with `accentColor` when selected, and pressed in while the finger is down.
    func softButton(isPressed: Bool = false, isSelected: Bool = false, accentColor: Color = Theme.selected,
                    radius: CGFloat = Theme.Radius.medium, standard: SoftStandardStyle = .chip) -> some View {
        modifier(SoftButton(isPressed: isPressed, isSelected: isSelected, accentColor: accentColor,
                            radius: radius, standard: standard))
    }

    /// The theme's screen background.
    func themedCanvas() -> some View {
        background(ThemedFill(role: .canvas).ignoresSafeArea())
    }
}

/// The canvas or card color of the active theme, as a view, for places that take a background view
/// (presentation backgrounds, list rows).
struct ThemedFill: View {
    enum Role { case canvas, surface }
    let role: Role
    @Environment(\.appTheme) private var theme

    var body: some View {
        role == .canvas ? theme.canvas : theme.surface
    }
}

private struct SoftCard: ViewModifier {
    let radius: CGFloat
    @Environment(\.appTheme) private var theme

    func body(content: Content) -> some View {
        content
            .background {
                if theme.isNeumorphic {
                    RaisedSurface(radius: radius)
                } else {
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .fill(Theme.surface)
                        .cardShadow()
                }
            }
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(theme.isNeumorphic ? .clear : Theme.hairline, lineWidth: 1)
            )
    }
}

private struct SoftFieldRow: ViewModifier {
    let isFocused: Bool
    let radius: CGFloat
    @Environment(\.appTheme) private var theme

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background {
                if theme.isNeumorphic {
                    InsetSurface(radius: radius)
                } else {
                    shape.fill(Theme.control)
                }
            }
            .overlay(shape.strokeBorder(
                isFocused ? Theme.selectedStroke : (theme.isNeumorphic ? .clear : Theme.controlBorder),
                lineWidth: isFocused ? 2 : 1))
    }
}

// MARK: - Buttons

/// How a control looks in the standard theme, so one modifier can serve chips, the Won/Lost
/// buttons and the pill buttons without changing any of their standard appearance.
struct SoftStandardStyle {
    var unselectedFill: Color = Theme.control
    /// Nil uses the accent color.
    var selectedFill: Color?
    var selectedStroke: Color = Theme.selectedStroke
    var selectedWidth: CGFloat = 2
    var unselectedStroke: Color = Theme.controlBorder
    var unselectedWidth: CGFloat = 1
    /// What the raised neumorphic surface is filled with; the canvas when nil. Used for the one
    /// primary action, so it stays yellow.
    var raisedFill: Color?

    static let chip = SoftStandardStyle()
}

private struct SoftButton: ViewModifier {
    let isPressed: Bool
    let isSelected: Bool
    let accentColor: Color
    let radius: CGFloat
    let standard: SoftStandardStyle
    @Environment(\.appTheme) private var theme
    @Environment(\.isEnabled) private var isEnabled

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background {
                if theme.isNeumorphic {
                    neumorphicSurface
                } else {
                    shape.fill(isSelected ? (standard.selectedFill ?? accentColor) : standard.unselectedFill)
                }
            }
            .overlay(shape.strokeBorder(stroke, lineWidth: lineWidth))
            .contentShape(shape)
    }

    @ViewBuilder
    private var neumorphicSurface: some View {
        if !isEnabled {
            // A disabled button is flat: nothing to press.
            RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Theme.fillMuted)
        } else if isSelected {
            InsetSurface(radius: radius, tint: accentColor.opacity(0.88))
        } else if isPressed {
            InsetSurface(radius: radius)
        } else {
            RaisedSurface(radius: radius, fill: standard.raisedFill ?? Soft.canvas)
        }
    }

    private var stroke: Color {
        if theme.isNeumorphic { return isEnabled ? .clear : Theme.hairline }
        return isSelected ? standard.selectedStroke : standard.unselectedStroke
    }

    private var lineWidth: CGFloat {
        if theme.isNeumorphic { return 1 }
        return isSelected ? standard.selectedWidth : standard.unselectedWidth
    }
}

/// Press feedback plus the soft surface. In the neumorphic theme a press shows as the surface
/// sinking in (no scale or fade); in the standard theme it scales and fades as `PressableButtonStyle`
/// does. The label supplies its own padding, frame and foreground color.
struct SoftButtonStyle: ButtonStyle {
    var isSelected = false
    var accentColor: Color = Theme.selected
    var radius: CGFloat = Theme.Radius.medium
    var standard: SoftStandardStyle = .chip
    var pressedScale: CGFloat = 0.97
    var haptic: SensoryFeedback?

    func makeBody(configuration: Configuration) -> some View {
        Pressed(configuration: configuration, style: self)
    }

    private struct Pressed: View {
        let configuration: ButtonStyleConfiguration
        let style: SoftButtonStyle
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @Environment(\.appTheme) private var theme

        var body: some View {
            let pressed = configuration.isPressed
            let scales = pressed && !reduceMotion && !theme.isNeumorphic
            configuration.label
                .softButton(isPressed: pressed, isSelected: style.isSelected, accentColor: style.accentColor,
                            radius: style.radius, standard: style.standard)
                .scaleEffect(scales ? style.pressedScale : 1)
                .opacity(pressed && !theme.isNeumorphic ? 0.85 : 1)
                .animation(reduceMotion ? Theme.reducedMotion : Theme.spring, value: pressed)
                .modifier(PressHaptic(feedback: style.haptic, isPressed: pressed))
        }
    }
}
