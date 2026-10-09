import SwiftUI

/// Chip grid plus an "Other" chip that reveals a free-text field, for lists that can't be
/// exhaustive (vehicle makes and models).
struct ChipGridWithOther: View {
    static let otherLabel = "Other"

    let options: [String]
    @Binding var value: String
    let otherPlaceholder: String
    var minChipWidth: CGFloat = 150

    @State private var isOther: Bool

    init(options: [String], value: Binding<String>, otherPlaceholder: String, minChipWidth: CGFloat = 150) {
        self.options = options
        self._value = value
        self.otherPlaceholder = otherPlaceholder
        self.minChipWidth = minChipWidth
        let current = value.wrappedValue
        self._isOther = State(initialValue: !current.isEmpty && !options.contains(current))
    }

    var body: some View {
        VStack(spacing: Theme.Spacing.xs) {
            ChipGrid(options: options + [Self.otherLabel], selection: chipSelection, minChipWidth: minChipWidth)
            if isOther {
                BigTextField(label: otherPlaceholder, placeholder: otherPlaceholder, text: $value)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .themeAnimation(value: isOther)
    }

    private var chipSelection: Binding<String> {
        Binding(
            get: { isOther ? Self.otherLabel : (options.contains(value) ? value : "") },
            set: { newValue in
                isOther = newValue == Self.otherLabel
                value = isOther ? "" : newValue
            }
        )
    }
}
