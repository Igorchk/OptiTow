import SwiftUI

/// A card in the dispatch form with a small uppercase header on the canvas above it. Each section is
/// its own surface, so the form reads as a few clear groups instead of one long wall of controls.
struct FormSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            Text(title)
                .sectionHeader()
                .padding(.horizontal, Theme.Spacing.md)
                .accessibilityAddTraits(.isHeader)
            SurfaceCard {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    content
                }
            }
        }
    }
}

/// Labeled field group inside a section.
struct FieldGroup<Content: View>: View {
    let label: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(label).fieldLabel()
            content
        }
    }
}

/// Large text field. `label` is what VoiceOver reads; `placeholder` is the hint shown while empty.
struct BigTextField: View {
    let label: String
    let placeholder: String
    @Binding var text: String
    var keyboard: KeyboardKind = .text

    enum KeyboardKind {
        case text, phone, number, decimal
    }

    @FocusState private var isFocused: Bool
    @ScaledMetric(relativeTo: .title3) private var minHeight = Theme.controlMinHeight

    var body: some View {
        TextField(label, text: $text, prompt: Text(placeholder).foregroundStyle(Theme.textTertiary))
            .fieldValue()
            .focused($isFocused)
            .padding(.horizontal, Theme.Spacing.md)
            .frame(minHeight: minHeight)
            .softFieldRow(isFocused: isFocused)
            .themeAnimation(value: isFocused)
            .autocorrectionDisabled(keyboard != .text)
            #if os(iOS)
            .keyboardType(keyboard.uiKeyboardType)
            .textInputAutocapitalization(keyboard == .text ? .words : .never)
            #endif
    }
}

/// Multi-line field for free-text notes.
struct NotesField: View {
    let label: String
    let placeholder: String
    @Binding var text: String

    @FocusState private var isFocused: Bool

    var body: some View {
        TextField(label, text: $text, prompt: Text(placeholder).foregroundStyle(Theme.textTertiary), axis: .vertical)
            .lineLimit(3...8)
            .font(.body)
            .foregroundStyle(Theme.textPrimary)
            .focused($isFocused)
            .padding(Theme.Spacing.md)
            .frame(maxWidth: .infinity, alignment: .leading)
            .softFieldRow(isFocused: isFocused)
            .themeAnimation(value: isFocused)
    }
}

#if os(iOS)
private extension BigTextField.KeyboardKind {
    var uiKeyboardType: UIKeyboardType {
        switch self {
        case .text: .default
        case .phone: .phonePad
        case .number: .numberPad
        case .decimal: .decimalPad
        }
    }
}
#endif
