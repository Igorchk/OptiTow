import SwiftUI

/// A labeled dropdown for a category with too many choices for a chip grid.
///
/// Short lists (10 or fewer) open a native `Menu`: a checkmark beside the current choice and no
/// keyboard. Longer lists, or any list with `isSearchable == true`, open a searchable list: a bottom
/// sheet on a phone (medium and large detents), a 480pt popover on an iPad. Picking a row closes it.
///
/// The field wears the same well as the form's text fields (pressed in for the soft theme, a faint
/// tint with a fine outline for the standard one), at least 52pt tall, with the current choice or the
/// placeholder and a chevron. `selection` is nil while nothing is chosen.
struct AdaptiveDropdownPicker<Option: Hashable & CustomStringConvertible>: View {
    /// At most this many options and the picker is a menu; more and it is a searchable list.
    static var menuLimit: Int { 10 }

    let title: String
    let options: [Option]
    @Binding var selection: Option?
    var placeholder = "Select"
    var isSearchable: Bool?

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var showList = false
    @ScaledMetric(relativeTo: .title3) private var minHeight = Theme.controlMinHeight

    init(title: String, options: [Option], selection: Binding<Option?>,
         placeholder: String = "Select", isSearchable: Bool? = nil) {
        self.title = title
        self.options = options
        self._selection = selection
        self.placeholder = placeholder
        self.isSearchable = isSearchable
    }

    /// Whether this picker opens the searchable list (rather than a menu).
    var usesSearchList: Bool { isSearchable ?? (options.count > Self.menuLimit) }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Text(title).fieldLabel()
            if usesSearchList { searchTrigger } else { menu }
        }
        .accessibilityElement(children: .contain)
    }

    // MARK: Menu

    private var menu: some View {
        Menu {
            ForEach(options, id: \.self) { option in
                Button {
                    selection = option
                } label: {
                    if option == selection {
                        Label(option.description, systemImage: "checkmark")
                    } else {
                        Text(option.description)
                    }
                }
            }
            if selection != nil {
                Divider()
                Button("Clear selection", role: .destructive) { selection = nil }
            }
        } label: {
            field
        }
        .menuOrder(.fixed)
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(selectionText ?? "No selection")
        .accessibilityHint("Opens a menu")
    }

    // MARK: Searchable list

    private var searchTrigger: some View {
        Button { showList = true } label: { field }
            .buttonStyle(PressableButtonStyle(pressedScale: 0.99))
            .accessibilityLabel(title)
            .accessibilityValue(selectionText ?? "No selection")
            .accessibilityHint("Opens a searchable list")
            // A phone (compact width) gets a sheet, an iPad (regular width) a popover.
            .sheet(isPresented: presented(whenRegular: false)) {
                list
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            .popover(isPresented: presented(whenRegular: true), arrowEdge: .top) {
                list
                    // 480 x 560 when there is room; it shrinks, not clips, in a narrow window.
                    .frame(minWidth: 280, idealWidth: 480, maxWidth: 480, minHeight: 320, idealHeight: 560, maxHeight: 640)
                    .presentationCompactAdaptation(.popover)
            }
    }

    /// `showList`, but only for the presentation that matches the current size class, so a single
    /// flag opens exactly one of the sheet and the popover.
    private func presented(whenRegular regular: Bool) -> Binding<Bool> {
        Binding(
            get: { showList && (horizontalSizeClass == .regular) == regular },
            set: { if !$0 { showList = false } }
        )
    }

    private var list: some View {
        DropdownSearchList(title: title, options: options, selection: selection) { picked in
            selection = picked
            showList = false
        } onCancel: {
            showList = false
        }
    }

    // MARK: Field

    private var selectionText: String? { selection?.description }

    private var field: some View {
        HStack(spacing: Theme.Spacing.sm) {
            Group {
                if let selectionText {
                    Text(selectionText).fieldValue()
                } else {
                    // The same size and weight as a text field's prompt.
                    Text(placeholder).font(.title3.weight(.semibold)).foregroundStyle(Theme.textTertiary)
                }
            }
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.down")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.textSecondary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, Theme.Spacing.md)
        .frame(minHeight: minHeight)
        .softFieldRow(isFocused: showList)
        .contentShape(Rectangle())
    }
}

extension AdaptiveDropdownPicker where Option == String {
    /// For a form field stored as a plain string, where an empty string means nothing is chosen.
    init(title: String, options: [String], text: Binding<String>,
         placeholder: String = "Select", isSearchable: Bool? = nil) {
        self.init(
            title: title, options: options,
            selection: Binding(
                get: { text.wrappedValue.isEmpty ? nil : text.wrappedValue },
                set: { text.wrappedValue = $0 ?? "" }),
            placeholder: placeholder, isSearchable: isSearchable)
    }
}

// MARK: - Searchable list

/// The list behind a long dropdown: a search field pinned under the title, the options filtered as
/// you type, a checkmark on the current one, and Cancel (plus Clear when something is chosen).
private struct DropdownSearchList<Option: Hashable & CustomStringConvertible>: View {
    let title: String
    let options: [Option]
    let selection: Option?
    let onPick: (Option?) -> Void
    let onCancel: () -> Void

    @State private var query = ""
    @ScaledMetric(relativeTo: .body) private var rowHeight = Theme.controlMinHeight

    private var filtered: [Option] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return options }
        return options.filter { $0.description.localizedStandardContains(trimmed) }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(filtered, id: \.self) { option in
                    Button { onPick(option) } label: {
                        HStack(spacing: Theme.Spacing.sm) {
                            Text(option.description)
                                .font(.body)
                                .foregroundStyle(Theme.textPrimary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if option == selection {
                                Image(systemName: "checkmark")
                                    .font(.body.weight(.semibold))
                                    .foregroundStyle(Theme.link)
                                    .accessibilityHidden(true)
                            }
                        }
                        .frame(minHeight: rowHeight)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(ThemedFill(role: .surface))
                    // The row is its own 52pt target; the list's default padding would stack on top of it.
                    .listRowInsets(EdgeInsets(top: 0, leading: Theme.Spacing.md, bottom: 0, trailing: Theme.Spacing.md))
                    .accessibilityAddTraits(option == selection ? .isSelected : [])
                }
            }
            .overlay {
                if filtered.isEmpty { ContentUnavailableView.search(text: query) }
            }
            .scrollContentBackground(.hidden)
            .background(ThemedFill(role: .canvas).ignoresSafeArea())
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search \(title)")
            .navigationTitle(title)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
                if selection != nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Clear") { onPick(nil) }
                    }
                }
            }
        }
        .presentationBackground { ThemedFill(role: .canvas) }
    }
}

#if DEBUG
private struct DropdownGallery: View {
    @State private var payer: String? = "Agero"
    @State private var empty: String?
    @State private var make: String? = "Tesla"
    @State private var forced: String?

    private static let makes = ["Toyota", "Honda", "Ford", "Chevrolet", "Nissan", "Hyundai", "Kia", "Jeep", "Subaru",
                                "Tesla", "BMW", "Mercedes-Benz", "Volkswagen", "Ram", "GMC"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                FormSection(title: "Menu (9 options)") {
                    AdaptiveDropdownPicker(title: "Payer", options: ChipOptions.payerName, selection: $payer,
                                           placeholder: "Select payer")
                    AdaptiveDropdownPicker(title: "Payer, nothing chosen", options: ChipOptions.payerName,
                                           selection: $empty, placeholder: "Select payer")
                }
                FormSection(title: "Searchable (15 options)") {
                    AdaptiveDropdownPicker(title: "Make", options: Self.makes, selection: $make,
                                           placeholder: "Select make")
                }
                FormSection(title: "Searchable by override (4 options)") {
                    AdaptiveDropdownPicker(title: "Service", options: Array(ChipOptions.serviceRequested.prefix(4)),
                                           selection: $forced, placeholder: "Select service", isSearchable: true)
                }
            }
            .padding(Theme.Spacing.md)
        }
        .background(Theme.background)
    }
}

#Preview("Dropdown · Light") { DropdownGallery().preferredColorScheme(.light) }
#Preview("Dropdown · Neumorphic") { DropdownGallery().environment(\.appTheme, .neumorphic) }
#Preview("Dropdown · Dark") { DropdownGallery().preferredColorScheme(.dark) }
#Preview("Dropdown · Large text") { DropdownGallery().dynamicTypeSize(.accessibility3) }
#endif
