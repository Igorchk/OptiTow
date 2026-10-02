import SwiftUI

/// Wrap-around grid of large 1-tap chips. Tapping the selected chip clears it.
struct ChipGrid: View {
    let options: [String]
    @Binding var selection: String
    var minChipWidth: CGFloat = 150

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: minChipWidth), spacing: 10)], spacing: 10) {
            ForEach(options, id: \.self) { option in
                ChipButton(title: option, isSelected: selection == option) {
                    selection = selection == option ? "" : option
                }
            }
        }
        .sensoryFeedback(.selection, trigger: selection)
    }
}

struct ChipButton: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.headline)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
                .frame(maxWidth: .infinity, minHeight: Theme.chipHeight)
                .padding(.horizontal, 8)
                .foregroundStyle(isSelected ? Theme.onSelected : Theme.textPrimary)
                .background(isSelected ? Theme.selected : Theme.surface,
                            in: RoundedRectangle(cornerRadius: Theme.cornerRadius))
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.cornerRadius)
                        .stroke(isSelected ? Theme.selected : Theme.surfaceBorder, lineWidth: 1.5)
                )
                .contentShape(RoundedRectangle(cornerRadius: Theme.cornerRadius))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
