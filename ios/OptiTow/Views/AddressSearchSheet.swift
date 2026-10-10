import SwiftUI

/// The place to type an address: a search field pinned at the top (focused as the sheet opens) and
/// a full-height list of California suggestions beneath it, with "Use as typed" last. Tapping a
/// suggestion resolves its full address and coordinate, hands them back and closes the sheet.
///
/// All typing happens here, in a screen that does nothing but search, so the keyboard never has to
/// negotiate with the dispatch form's scroll view.
struct AddressSearchSheet: View {
    let title: String
    let manualRowTitle: String
    let onPick: (String, AddressEntry) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var search = AddressSearch()
    @State private var query: String
    @State private var mode = SearchMode.standard
    @FocusState private var fieldFocused: Bool
    @Environment(\.dynamicTypeSize) private var typeSize

    init(title: String, initialText: String, manualRowTitle: String = "Use as typed — no mileage",
         onPick: @escaping (String, AddressEntry) -> Void) {
        self.title = title
        self.manualRowTitle = manualRowTitle
        self.onPick = onPick
        _query = State(initialValue: initialText)
    }

    /// What the sheet is searching for. Standard is as-you-type street address suggestions; landmark
    /// takes a description ("Shell off I-80 near Rocklin") and runs when submitted.
    private enum SearchMode: String, CaseIterable, Identifiable {
        case standard = "Standard Address"
        case landmark = "Landmark / Clue"
        var id: String { rawValue }
    }

    private var trimmed: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(spacing: 0) {
            header
            results
        }
        .themedCanvas()
        .presentationDragIndicator(.visible)
        .task {
            search.update(query: query)
            fieldFocused = true
        }
        .onChange(of: query) { _, new in
            switch mode {
            case .standard: search.update(query: new)
            // Results for an older description would no longer match what is typed.
            case .landmark: search.clearLandmarks()
            }
        }
        .onChange(of: mode) { _, new in
            search.clear()
            search.clearLandmarks()
            if new == .standard { search.update(query: query) }
            fieldFocused = true
        }
        .onSubmit { if mode == .landmark { search.searchLandmarks(query: query) } }
    }

    // MARK: Pinned header

    /// Field and Cancel side by side; stacked (Cancel on top, right-aligned) at accessibility sizes,
    /// where they would otherwise fight over the width and leave the field showing a few letters.
    private var header: some View {
        VStack(spacing: Theme.Spacing.sm) {
            searchRow
            modePicker
        }
        .padding(.horizontal, Theme.Spacing.md)
        .padding(.top, Theme.Spacing.lg)
        .padding(.bottom, Theme.Spacing.sm)
    }

    /// Below the search bar. Segmented, or a menu at accessibility sizes where two long labels
    /// would not fit side by side.
    @ViewBuilder
    private var modePicker: some View {
        let picker = Picker("Search mode", selection: $mode) {
            ForEach(SearchMode.allCases) { Text($0.rawValue).tag($0) }
        }
        .labelsHidden()
        if typeSize.isAccessibilitySize {
            picker.pickerStyle(.menu).frame(maxWidth: .infinity, alignment: .leading)
        } else {
            picker.pickerStyle(.segmented)
        }
    }

    private var searchRow: some View {
        let stacked = typeSize.isAccessibilitySize
        let layout = stacked
            ? AnyLayout(VStackLayout(alignment: .trailing, spacing: Theme.Spacing.xs))
            : AnyLayout(HStackLayout(spacing: Theme.Spacing.sm))
        return layout {
            if stacked { cancelButton }
            HStack(spacing: Theme.Spacing.xs) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(Theme.textSecondary)
                    .accessibilityHidden(true)
                TextField(title, text: $query, prompt: Text(mode == .standard ? "Search address"
                                                : "Describe visual cues, cross streets, or businesses...")
                    .foregroundStyle(Theme.textTertiary))
                    .font(.body.weight(.semibold))
                    .foregroundStyle(Theme.textPrimary)
                    .focused($fieldFocused)
                    .submitLabel(.search)
                    .autocorrectionDisabled()
                    #if os(iOS)
                    .textInputAutocapitalization(.words)
                    #endif
                if !query.isEmpty {
                    Button { query = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(Theme.textSecondary)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.leading, Theme.Spacing.md)
            .frame(minHeight: Theme.controlMinHeight)
            .softFieldRow(isFocused: fieldFocused)

            if !stacked { cancelButton }
        }
    }

    private var cancelButton: some View {
        Button("Cancel") { dismiss() }
            .font(.body)
            .frame(minHeight: 44)
    }

    // MARK: Results

    private var results: some View {
        List {
            if let problem = search.problem {
                Text(problem)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Theme.Tone.danger.foreground)
                    .listRowBackground(Color.clear)
            }
            if mode == .landmark { landmarkRows }
            if mode == .standard { ForEach(search.suggestions) { suggestion in
                Button { select(suggestion) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(suggestion.title).font(.body.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                        if !suggestion.subtitle.isEmpty {
                            Text(suggestion.subtitle).metadata()
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: Theme.controlMinHeight - Theme.Spacing.md, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .listRowBackground(ThemedFill(role: .surface))
            } }
            if trimmed.count >= 2 {
                Button(action: useAsTyped) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(manualRowTitle).font(.body.weight(.semibold)).foregroundStyle(Theme.link)
                        Text(trimmed).metadata().lineLimit(1).truncationMode(.middle)
                    }
                    .frame(maxWidth: .infinity, minHeight: Theme.controlMinHeight - Theme.Spacing.md, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .listRowBackground(ThemedFill(role: .surface))
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .scrollDismissesKeyboard(.interactively)
        .overlay {
            if search.isResolving { ProgressView().controlSize(.large) }
        }
        .disabled(search.isResolving)
    }

    // MARK: Landmark rows

    /// Landmark mode: a spinner row while searching, a "Search" row until a search has been run for
    /// the typed text, then up to six candidates with name, address and distance from the yard.
    /// Every row has the same minimum height as an address row, so switching modes moves nothing.
    @ViewBuilder
    private var landmarkRows: some View {
        if trimmed.isEmpty {
            // The field's placeholder is cut short on a phone, so the full hint lives here.
            Text("Describe visual cues, cross streets, or businesses, for example “Shell off I-80 near Rocklin” or “McDonald's near Sunrise Blvd”. Press Search to look it up.")
                .metadata()
                .listRowBackground(Color.clear)
        }
        if search.isSearchingLandmarks {
            HStack(spacing: Theme.Spacing.sm) {
                ProgressView()
                Text("Searching California…").font(.body.weight(.semibold)).foregroundStyle(Theme.textPrimary)
            }
            .frame(maxWidth: .infinity, minHeight: Theme.controlMinHeight - Theme.Spacing.md, alignment: .leading)
            .listRowBackground(ThemedFill(role: .surface))
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Searching")
        } else if search.landmarks.isEmpty && trimmed.count >= 2 && search.problem == nil {
            Button { search.searchLandmarks(query: query) } label: {
                HStack(spacing: Theme.Spacing.sm) {
                    Image(systemName: "magnifyingglass").accessibilityHidden(true)
                    Text("Search for “\(trimmed)”").font(.body.weight(.semibold)).lineLimit(2)
                }
                .foregroundStyle(Theme.link)
                .frame(maxWidth: .infinity, minHeight: Theme.controlMinHeight - Theme.Spacing.md, alignment: .leading)
                .contentShape(Rectangle())
            }
            .listRowBackground(ThemedFill(role: .surface))
        }
        ForEach(search.landmarks) { candidate in
            Button { select(candidate) } label: {
                HStack(alignment: .top, spacing: Theme.Spacing.sm) {
                    Image(systemName: "mappin.and.ellipse")
                        .foregroundStyle(Theme.textSecondary)
                        .frame(width: 24)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(candidate.title).font(.body.weight(.semibold)).foregroundStyle(Theme.textPrimary)
                        Text(candidate.address).metadata()
                        Text(candidate.distanceText).font(.caption).foregroundStyle(Theme.textSecondary)
                    }
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: Theme.controlMinHeight - Theme.Spacing.md, alignment: .leading)
                .contentShape(Rectangle())
            }
            .listRowBackground(ThemedFill(role: .surface))
            .accessibilityElement(children: .combine)
            .accessibilityHint("Uses this address")
        }
    }

    // MARK: Actions

    private func select(_ candidate: LandmarkCandidate) {
        onPick(candidate.address, .resolved(candidate.place))
        dismiss()
    }

    private func select(_ suggestion: AddressSuggestion) {
        Task {
            guard let place = await search.resolve(suggestion) else { return }
            onPick(place.address, .resolved(place))
            dismiss()
        }
    }

    private func useAsTyped() {
        onPick(trimmed, .manual(trimmed))
        dismiss()
    }
}

#if DEBUG
#Preview("Address search · Light") { AddressSearchSheet(title: "Pickup address", initialText: "") { _, _ in }.preferredColorScheme(.light) }
#Preview("Address search · Dark") { AddressSearchSheet(title: "Pickup address", initialText: "") { _, _ in }.preferredColorScheme(.dark) }
#Preview("Address search · Large text") { AddressSearchSheet(title: "Pickup address", initialText: "") { _, _ in }.dynamicTypeSize(.accessibility3) }
#endif
