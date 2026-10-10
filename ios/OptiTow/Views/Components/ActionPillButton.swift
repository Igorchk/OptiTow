import SwiftUI

/// Press feedback shared by every tappable control: a small scale-down and fade that follow the
/// finger, with an optional light haptic on touch-down. With Reduce Motion on, the scale is dropped
/// and only the fade remains.
struct PressableButtonStyle: ButtonStyle {
    var pressedScale: CGFloat = 0.97
    var haptic: SensoryFeedback?

    func makeBody(configuration: Configuration) -> some View {
        PressedLabel(configuration: configuration, pressedScale: pressedScale, haptic: haptic)
    }

    private struct PressedLabel: View {
        let configuration: ButtonStyleConfiguration
        let pressedScale: CGFloat
        let haptic: SensoryFeedback?
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        var body: some View {
            let pressed = configuration.isPressed
            configuration.label
                .scaleEffect(pressed && !reduceMotion ? pressedScale : 1)
                .opacity(pressed ? 0.85 : 1)
                .animation(reduceMotion ? Theme.reducedMotion : Theme.spring, value: pressed)
                .modifier(PressHaptic(feedback: haptic, isPressed: pressed))
        }
    }
}

/// Fires the haptic when a press begins (not when it ends), and only if one was requested.
struct PressHaptic: ViewModifier {
    let feedback: SensoryFeedback?
    let isPressed: Bool

    func body(content: Content) -> some View {
        if let feedback {
            content.sensoryFeedback(feedback, trigger: isPressed) { _, pressed in pressed }
        } else {
            content
        }
    }
}

/// A full-width capsule button for the actions that matter: Save, Retry. At least 52pt tall (scaled
/// with Dynamic Type), with a light haptic and a press animation. A disabled button looks muted and
/// does nothing, instead of looking tappable.
struct ActionPillButton: View {
    enum Kind { case primary, secondary, destructive }

    let title: String
    var systemImage: String?
    var kind: Kind
    var fillsWidth: Bool
    let action: () -> Void

    @Environment(\.isEnabled) private var isEnabled
    @ScaledMetric(relativeTo: .headline) private var minHeight = Theme.controlMinHeight

    init(
        _ title: String,
        systemImage: String? = nil,
        kind: Kind = .primary,
        fillsWidth: Bool = true,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.systemImage = systemImage
        self.kind = kind
        self.fillsWidth = fillsWidth
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: Theme.Spacing.xs) {
                if let systemImage {
                    Image(systemName: systemImage).accessibilityHidden(true)
                }
                Text(title).multilineTextAlignment(.center)
            }
            .font(.headline)
            .foregroundStyle(foreground)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.xs)
            .frame(maxWidth: fillsWidth ? .infinity : nil, minHeight: minHeight)
        }
        .buttonStyle(SoftButtonStyle(
            radius: 100,
            standard: SoftStandardStyle(unselectedFill: background, unselectedStroke: border,
                                        raisedFill: kind == .primary ? Theme.selected : nil),
            haptic: .impact(weight: .light)))
        .animation(Theme.spring, value: isEnabled)
    }

    private var foreground: Color {
        guard isEnabled else { return Theme.textTertiary }
        switch kind {
        case .primary: return Theme.onFill
        case .secondary: return Theme.textPrimary
        case .destructive: return Theme.Tone.danger.foreground
        }
    }

    private var background: Color {
        guard isEnabled else { return Theme.fillMuted }
        switch kind {
        case .primary: return Theme.selected
        case .secondary: return Theme.fillMuted
        case .destructive: return Theme.Tone.danger.tint
        }
    }

    private var border: Color {
        guard isEnabled else { return Theme.hairline }
        switch kind {
        case .primary: return Theme.selectedStroke.opacity(0.5)
        case .secondary: return Theme.hairline
        case .destructive: return Theme.Tone.danger.foreground.opacity(0.25)
        }
    }
}
