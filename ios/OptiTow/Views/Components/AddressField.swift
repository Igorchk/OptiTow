import SwiftUI

/// An address input with an inline list of California suggestions beneath it.
///
/// Typing shows matches (title and subtitle). Tapping one fills the full address and confirms its
/// coordinate; "Use as typed" keeps the text exactly as written. Any later edit to a confirmed or
/// manual address clears that choice. Nothing here blocks saving: with no connection, or for a
/// roadside spot with no street address, the text still works as plain text.
struct AddressField: View {
    let label: String
    let placeholder: String
    @Binding var text: String
    @Binding var entry: AddressEntry

    @State private var search = AddressSearch()
    @State private var isFocused = false
    @State private var listDismissed = false

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var showsList: Bool {
        isFocused && !listDismissed && entry == .unset && trimmed.count >= 2
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            BigTextField(label: label, placeholder: placeholder, text: $text,
                         disablesAutocorrection: true, onFocusChange: focusChanged)
            if showsList {
                AddressSuggestionList(suggestions: search.suggestions, typedText: trimmed,
                                      isResolving: search.isResolving, onSelect: select, onUseAsTyped: useAsTyped)
                    .transition(.opacity)
            }
            status
        }
        // No animation modifiers and no scrolling here: the scroll view owns keyboard avoidance, and
        // anything that animates this container or moves the offset fights it on every keystroke.
        .onChange(of: text) { _, new in textChanged(new) }
    }

    @ViewBuilder
    private var status: some View {
        if let problem = search.problem, showsList {
            Text(problem).font(.footnote.weight(.medium)).foregroundStyle(Theme.Tone.danger.foreground)
        } else {
            switch entry {
            case .resolved:
                Text("Confirmed address").font(.footnote.weight(.medium)).foregroundStyle(Theme.Tone.success.foreground)
            case .manual:
                Text("Manual address — no mileage").metadata()
            case .unset:
                EmptyView()
            }
        }
    }

    // MARK: Events

    private func focusChanged(_ focused: Bool) {
        isFocused = focused
        if focused, entry == .unset { search.update(query: text) }
    }

    private func textChanged(_ new: String) {
        switch entry {
        case .resolved(let place) where place.address == new: return
        case .manual(let typed) where typed == new: return
        default: entry = .unset
        }
        listDismissed = false
        search.update(query: new)
    }

    /// Confirms the address and closes the list with one short fade. The keyboard stays up and the
    /// field keeps focus, so the screen does not re-flow around a keyboard coming and going.
    private func select(_ suggestion: AddressSuggestion) {
        Task {
            guard let place = await search.resolve(suggestion) else { return }
            withAnimation(.easeOut(duration: 0.15)) {
                text = place.address
                entry = .resolved(place)
                listDismissed = true
            }
            search.clear()
        }
    }

    private func useAsTyped() {
        withAnimation(.easeOut(duration: 0.15)) {
            entry = .manual(text)
            listDismissed = true
        }
        search.clear()
    }
}

/// The rows under the field. Separate from `AddressField` so previews can show it with sample data.
struct AddressSuggestionList: View {
    let suggestions: [AddressSuggestion]
    let typedText: String
    var isResolving = false
    let onSelect: (AddressSuggestion) -> Void
    let onUseAsTyped: () -> Void

    @ScaledMetric(relativeTo: .body) private var rowHeight = Theme.controlMinHeight
    @Environment(\.dynamicTypeSize) private var typeSize

    /// One line per row at normal sizes, so a row's height never changes as the text under it does.
    /// At accessibility sizes truncating would hide the address, so rows wrap there.
    private var lineLimit: Int? { typeSize.isAccessibilitySize ? nil : 1 }

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous)
    }

    var body: some View {
        VStack(spacing: 0) {
            ForEach(suggestions) { suggestion in
                row(title: suggestion.title, subtitle: suggestion.subtitle, emphasized: true) { onSelect(suggestion) }
                Theme.hairline.frame(height: 1)
            }
            row(title: "Use as typed — no mileage", subtitle: typedText, emphasized: false, middleTruncate: true,
                action: onUseAsTyped)
        }
        .background(Theme.surface, in: shape)
        .overlay(shape.strokeBorder(Theme.controlBorder, lineWidth: 1))
        .clipShape(shape)
        .opacity(isResolving ? 0.55 : 1)
        .disabled(isResolving)
        .overlay { if isResolving { ProgressView() } }
    }

    private func row(title: String, subtitle: String, emphasized: Bool, middleTruncate: Bool = false,
                     action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.body.weight(emphasized ? .semibold : .medium))
                    .foregroundStyle(emphasized ? Theme.textPrimary : Theme.link)
                    .lineLimit(lineLimit)
                if !subtitle.isEmpty {
                    Text(subtitle).metadata()
                        .lineLimit(lineLimit)
                        .truncationMode(middleTruncate ? .middle : .tail)
                }
            }
            .multilineTextAlignment(.leading)
            .padding(.horizontal, Theme.Spacing.md)
            .padding(.vertical, Theme.Spacing.xs)
            .frame(maxWidth: .infinity, minHeight: rowHeight, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableButtonStyle(pressedScale: 0.99))
    }
}

#if DEBUG
private struct AddressFieldPreview: View {
    private let sampleSuggestions = [
        AddressSuggestion(title: "5431 Brook Dr", subtitle: "Rocklin, CA", completion: nil),
        AddressSuggestion(title: "5431 Brook Rd", subtitle: "Sacramento, CA", completion: nil),
        AddressSuggestion(title: "5431 Brookside Ln", subtitle: "Citrus Heights, CA", completion: nil),
    ]

    var body: some View {
        FormSection(title: "Location") {
            FieldGroup(label: "Pickup Address") {
                AddressSuggestionList(suggestions: sampleSuggestions, typedText: "5431 Brook", onSelect: { _ in }, onUseAsTyped: {})
            }
            FieldGroup(label: "Dropoff Address") {
                AddressSuggestionList(suggestions: [], typedText: "I-80 EB past Exit 98", onSelect: { _ in }, onUseAsTyped: {})
            }
        }
        .padding(Theme.Spacing.md)
        .background(Theme.background)
    }
}

#Preview("Suggestions · Light") { AddressFieldPreview().preferredColorScheme(.light) }
#Preview("Suggestions · Dark") { AddressFieldPreview().preferredColorScheme(.dark) }
#Preview("Suggestions · Large text") { ScrollView { AddressFieldPreview() }.dynamicTypeSize(.accessibility3) }
#endif
