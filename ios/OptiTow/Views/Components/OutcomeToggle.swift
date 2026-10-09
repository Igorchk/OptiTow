import SwiftUI

/// The ML target variable: a massive two-way Won / Lost toggle (APP_SPEC.md §6).
///
/// Selected fills the whole button with its color; unselected is an outline in a darker, readable
/// shade of the same color. No icons: the fill and the heavy type carry the state. At accessibility text sizes the two buttons stack
/// vertically so neither is squeezed.
struct OutcomeToggle: View {
    @Binding var outcome: String
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(spacing: Theme.Spacing.sm))
            : AnyLayout(HStackLayout(spacing: Theme.Spacing.sm))

        layout {
            OutcomeButton(title: "WON", subtitle: "Booked",
                          fill: Theme.won, tone: .success, isSelected: outcome == ChipOptions.outcomeWon) {
                outcome = outcome == ChipOptions.outcomeWon ? "" : ChipOptions.outcomeWon
            }
            OutcomeButton(title: "LOST", subtitle: "Declined",
                          fill: Theme.lost, tone: .danger, isSelected: outcome == ChipOptions.outcomeLost) {
                outcome = outcome == ChipOptions.outcomeLost ? "" : ChipOptions.outcomeLost
            }
        }
        .sensoryFeedback(.impact(weight: .heavy), trigger: outcome)
    }
}

private struct OutcomeButton: View {
    let title: String
    let subtitle: String
    let fill: Color
    let tone: Theme.Tone
    let isSelected: Bool
    let action: () -> Void

    @ScaledMetric(relativeTo: .largeTitle) private var minHeight = 112.0

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: Theme.Radius.large, style: .continuous)
    }

    var body: some View {
        Button(action: action) {
            VStack(spacing: Theme.Spacing.xxs) {
                Text(title)
                    .font(.largeTitle.weight(.heavy))
                    .minimumScaleFactor(0.7)
                Text(subtitle)
                    .font(.subheadline.weight(.semibold))
            }
            .foregroundStyle(isSelected ? Theme.onFill : tone.foreground)
            .padding(Theme.Spacing.sm)
            .frame(maxWidth: .infinity, minHeight: minHeight)
            .background(isSelected ? fill : Theme.control, in: shape)
            .overlay(shape.strokeBorder(isSelected ? .clear : tone.foreground.opacity(0.55), lineWidth: 2))
            .contentShape(shape)
        }
        .buttonStyle(PressableButtonStyle(pressedScale: 0.98))
        .themeAnimation(value: isSelected)
        .accessibilityLabel("\(title.capitalized), \(subtitle.lowercased())")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
