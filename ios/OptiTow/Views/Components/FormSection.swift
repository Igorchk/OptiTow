import SwiftUI

/// Titled block in the dispatch form.
struct FormSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title.uppercased())
                .font(.caption.weight(.bold))
                .tracking(1.2)
                .foregroundStyle(Theme.textSecondary)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Labeled field group inside a section.
struct FieldGroup<Content: View>: View {
    let label: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
            content
        }
    }
}

/// Large dark text field.
struct BigTextField: View {
    let placeholder: String
    @Binding var text: String
    var keyboard: KeyboardKind = .text

    enum KeyboardKind {
        case text, phone, number, decimal
    }

    var body: some View {
        TextField("", text: $text, prompt: Text(placeholder).foregroundStyle(Theme.textSecondary))
            .font(.title3.weight(.semibold))
            .foregroundStyle(Theme.textPrimary)
            .padding(.horizontal, 16)
            .frame(minHeight: Theme.chipHeight)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cornerRadius))
            .overlay(RoundedRectangle(cornerRadius: Theme.cornerRadius).stroke(Theme.surfaceBorder, lineWidth: 1.5))
            .autocorrectionDisabled(keyboard != .text)
            #if os(iOS)
            .keyboardType(keyboard.uiKeyboardType)
            .textInputAutocapitalization(keyboard == .text ? .words : .never)
            #endif
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
