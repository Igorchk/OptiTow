import SwiftUI

/// A static address row in the form. It never expands, takes the keyboard or scrolls the form:
/// tapping it opens `AddressSearchSheet`, which does the typing and searching, and hands back the
/// chosen address. A filled row shows the address with a button to clear it.
///
/// Nothing here blocks saving: with no connection, or for a roadside spot with no street address,
/// "Use as typed" in the sheet keeps the text as plain text.
struct AddressField: View {
    let label: String
    let placeholder: String
    @Binding var text: String
    @Binding var entry: AddressEntry
    /// Wording for the "Use as typed" outcome; the start location differs (it falls back to the yard).
    var manualStatus = "Manual address — no mileage"
    var manualRowTitle = "Use as typed — no mileage"

    @State private var showSearch = false
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .title3) private var minHeight = Theme.controlMinHeight

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xs) {
            HStack(spacing: 0) {
                Button { showSearch = true } label: {
                    HStack(spacing: Theme.Spacing.sm) {
                        Image(systemName: text.isEmpty ? "magnifyingglass" : "mappin.and.ellipse")
                            .foregroundStyle(Theme.textSecondary)
                            .accessibilityHidden(true)
                        Text(text.isEmpty ? placeholder : text)
                            .font(.body.weight(text.isEmpty ? .regular : .semibold))
                            .foregroundStyle(text.isEmpty ? Theme.textTertiary : Theme.textPrimary)
                            .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                    }
                    .padding(.leading, Theme.Spacing.md)
                    .padding(.vertical, Theme.Spacing.xs)
                    .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(label)
                .accessibilityValue(text.isEmpty ? "Empty" : text)
                .accessibilityHint("Opens address search")

                if !text.isEmpty {
                    Button(action: clear) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.title3)
                            .foregroundStyle(Theme.textSecondary)
                            .frame(width: 52, height: minHeight)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear \(label)")
                }
            }
            .softFieldRow()

            status
        }
        .sheet(isPresented: $showSearch) {
            AddressSearchSheet(title: label, initialText: text, manualRowTitle: manualRowTitle) { address, chosen in
                text = address
                entry = chosen
            }
        }
    }

    @ViewBuilder
    private var status: some View {
        switch entry {
        case .resolved:
            Text("Confirmed address").font(.footnote.weight(.medium)).foregroundStyle(Theme.Tone.success.foreground)
        case .manual:
            Text(manualStatus).metadata()
        case .unset:
            EmptyView()
        }
    }

    private func clear() {
        text = ""
        entry = .unset
    }
}

#if DEBUG
private struct AddressFieldPreview: View {
    @State private var emptyText = ""
    @State private var emptyEntry = AddressEntry.unset
    @State private var filledText = "1315 10th St, Sacramento, CA 95814"
    @State private var filledEntry = AddressEntry.resolved(ResolvedPlace(address: "1315 10th St, Sacramento, CA 95814",
                                                                         latitude: 38.57, longitude: -121.49))
    @State private var manualText = "I-80 EB past Exit 98"
    @State private var manualEntry = AddressEntry.manual("I-80 EB past Exit 98")

    var body: some View {
        FormSection(title: "Location") {
            FieldGroup(label: "Pickup Address") {
                AddressField(label: "Pickup address", placeholder: "Tap to enter pickup address",
                             text: $emptyText, entry: $emptyEntry)
            }
            FieldGroup(label: "Dropoff Address") {
                AddressField(label: "Dropoff address", placeholder: "Tap to enter dropoff address",
                             text: $filledText, entry: $filledEntry)
            }
            FieldGroup(label: "Roadside") {
                AddressField(label: "Roadside", placeholder: "Tap to enter", text: $manualText, entry: $manualEntry)
            }
        }
        .padding(Theme.Spacing.md)
        .background(Theme.background)
    }
}

#Preview("Address rows · Light") { AddressFieldPreview().preferredColorScheme(.light) }
#Preview("Address rows · Dark") { AddressFieldPreview().preferredColorScheme(.dark) }
#Preview("Address rows · Large text") { ScrollView { AddressFieldPreview() }.dynamicTypeSize(.accessibility3) }
#endif
