import SwiftUI

/// Wrap-around grid of large 1-tap chips. Tapping the selected chip clears it.
struct ChipGrid: View {
    let options: [String]
    @Binding var selection: String
    var minChipWidth: CGFloat = 150

    /// Grows with Dynamic Type, so at accessibility sizes the grid falls back to one chip per row
    /// instead of squeezing words.
    @ScaledMetric(relativeTo: .headline) private var scale = 1.0

    var body: some View {
        LazyVGrid(
            columns: [GridItem(.adaptive(minimum: minChipWidth * scale), spacing: Theme.Spacing.grid)],
            spacing: Theme.Spacing.grid
        ) {
            ForEach(options, id: \.self) { option in
                ChipButton(title: option, isSelected: selection == option) {
                    selection = selection == option ? "" : option
                }
            }
        }
        .sensoryFeedback(.selection, trigger: selection)
    }
}

/// One chip. Selected is a yellow fill with a 2pt amber outline and bold type; unselected is a faint
/// well with a fine outline and medium type. The three cues together (fill, outline, weight) keep it
/// from relying on color alone, with no icon inside the pill. At least 60pt tall (scaled with text size).
struct ChipButton: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    @ScaledMetric(relativeTo: .headline) private var minHeight = Theme.chipMinHeight

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous)
    }

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.headline.weight(isSelected ? .bold : .medium))
                .multilineTextAlignment(.center)
                .foregroundStyle(isSelected ? Theme.onFill : Theme.textPrimary)
                .padding(.horizontal, Theme.Spacing.sm)
                .padding(.vertical, Theme.Spacing.xs)
                .frame(maxWidth: .infinity, minHeight: minHeight)
                .background(isSelected ? Theme.selected : Theme.control, in: shape)
                .overlay(
                    shape.strokeBorder(isSelected ? Theme.selectedStroke : Theme.controlBorder,
                                       lineWidth: isSelected ? 2 : 1)
                )
                .contentShape(shape)
        }
        .buttonStyle(PressableButtonStyle())
        .themeAnimation(value: isSelected)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
