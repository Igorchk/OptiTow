import SwiftUI

/// The single screen: capture one call, save it to the offline queue, start the next.
struct DispatchFormView: View {
    @Environment(SyncManager.self) private var sync

    @State private var draft = CallDraft()
    @State private var savedCount = 0
    @State private var showSavedBanner = false
    @State private var saveError: String?
    @State private var showSyncDetail = false
    @State private var confirmClear = false
    @State private var trip = TripMileageModel()
    @State private var showQuickMileage = false
    /// Bumped after a save; the scroll view returns to the top for the next call.
    @State private var scrollTopTick = 0

    private let catalog = VehicleCatalog.shared

    /// Whether this build has a webhook address and secret. Read once; the sync engine itself only
    /// reports a generic error when they are missing, and this screen wants a distinct state for it.
    private static let isConfigured = AppConfig.load() != nil

    private var syncState: SyncPresentation {
        SyncPresentation(sync: sync, isConfigured: Self.isConfigured)
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    // The scroll anchor lives outside the re-identified form so scrollTo
                    // still finds it after a save swaps the form's identity.
                    Color.clear.frame(height: 0).id("top")
                    VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                        callerSection
                        jobSection
                        vehicleSection
                        locationSection
                        TripMileageCard(state: trip.state, onRetry: trip.retry)
                        quoteSection
                        outcomeSection
                        notesSection
                    }
                    .padding(Theme.Spacing.md)
                    // New call_id => fresh child state (e.g. "Other" text fields collapse).
                    .id(draft.call_id)
                }
                .scrollDismissesKeyboard(.interactively)
                .background(Theme.background)
                .onChange(of: scrollTopTick) {
                    withAnimation { proxy.scrollTo("top", anchor: .top) }
                }
            }
            .navigationTitle("New Call")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { toolbarContent }
            .overlay(alignment: .top) { savedBanner }
        }
        .sensoryFeedback(.success, trigger: savedCount)
        .sheet(isPresented: $showSyncDetail) {
            SyncStatusSheet(sync: sync, isConfigured: Self.isConfigured)
        }
        .sheet(isPresented: $showQuickMileage) {
            MileageCalculatorView()
        }
        .alert("Couldn't save call", isPresented: Binding(get: { saveError != nil }, set: { if !$0 { saveError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(saveError ?? "")
        }
        .confirmationDialog("Clear this call?", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("Clear form", role: .destructive) { draft = CallDraft() }
        }
        .onChange(of: draft.caller_type) { _, newValue in
            if newValue == ChipOptions.privateCash && draft.payer_name.isEmpty {
                draft.payer_name = ChipOptions.cashPayer
            }
        }
        .onChange(of: draft.vehicle_make) { oldMake, newMake in
            let model = draft.vehicle_model
            if catalog.models(for: oldMake).contains(model) && !catalog.models(for: newMake).contains(model) {
                draft.vehicle_model = ""
            }
        }
        .onChange(of: draft.tripEndpoints) { _, endpoints in
            trip.update(endpoints)
        }
        .onChange(of: draft.vehicle_year) { _, newValue in
            let digits = String(newValue.filter(\.isNumber).prefix(4))
            if digits != newValue { draft.vehicle_year = digits }
        }
    }

    // MARK: - Sections

    private var callerSection: some View {
        FormSection(title: "Caller") {
            FieldGroup(label: "Phone") {
                BigTextField(label: "Phone", placeholder: "916-555-0199", text: $draft.customer_phone, keyboard: .phone)
            }
            FieldGroup(label: "Caller Type") {
                ChipGrid(options: ChipOptions.callerType, selection: $draft.caller_type)
            }
            FieldGroup(label: "Payer") {
                ChipGrid(options: ChipOptions.payerName, selection: $draft.payer_name, minChipWidth: 105)
            }
        }
    }

    private var jobSection: some View {
        FormSection(title: "Job") {
            FieldGroup(label: "Service") {
                ChipGrid(options: ChipOptions.serviceRequested, selection: $draft.service_requested)
            }
        }
    }

    private var vehicleSection: some View {
        FormSection(title: "Vehicle") {
            FieldGroup(label: "Year") {
                BigTextField(label: "Vehicle year", placeholder: "2021", text: $draft.vehicle_year, keyboard: .number)
            }
            FieldGroup(label: "Make") {
                ChipGridWithOther(options: catalog.entries.map(\.make), value: $draft.vehicle_make,
                                  otherPlaceholder: "Make", minChipWidth: 105)
            }
            FieldGroup(label: "Model") {
                modelPicker
            }
            FieldGroup(label: "Drivetrain") {
                ChipGrid(options: ChipOptions.drivetrain, selection: $draft.drivetrain, minChipWidth: 105)
            }
            FieldGroup(label: "Condition") {
                ChipGrid(options: ChipOptions.vehicleCondition, selection: $draft.vehicle_condition)
            }
        }
    }

    @ViewBuilder
    private var modelPicker: some View {
        let models = catalog.models(for: draft.vehicle_make)
        if !models.isEmpty {
            ChipGridWithOther(options: models, value: $draft.vehicle_model,
                              otherPlaceholder: "Model", minChipWidth: 105)
                .id(draft.vehicle_make)
        } else if !draft.vehicle_make.isEmpty {
            BigTextField(label: "Model", placeholder: "Model", text: $draft.vehicle_model)
        } else {
            Text("Pick a make to see its models").metadata()
        }
    }

    private var locationSection: some View {
        FormSection(title: "Location") {
            FieldGroup(label: "Scene") {
                ChipGrid(options: ChipOptions.sceneLocation, selection: $draft.scene_location)
            }
            FieldGroup(label: "Pickup Address") {
                AddressField(label: "Pickup address", placeholder: "Tap to enter pickup address",
                             text: $draft.pickup_address, entry: $draft.pickup_entry)
            }
            FieldGroup(label: "Dropoff Address") {
                AddressField(label: "Dropoff address", placeholder: "Tap to enter dropoff address",
                             text: $draft.dropoff_address, entry: $draft.dropoff_entry)
            }
            FieldGroup(label: "Start Location") {
                AddressField(label: "Start location", placeholder: "Tap to enter start location (default: yard)",
                             text: $draft.start_location, entry: $draft.start_entry,
                             manualStatus: "Manual start — mileage uses the yard",
                             manualRowTitle: "Use as typed — mileage uses the yard")
            }
        }
    }

    private var quoteSection: some View {
        FormSection(title: "Quote") {
            FieldGroup(label: "Quoted Price ($)") {
                BigTextField(label: "Quoted price in dollars", placeholder: "220.00",
                             text: $draft.quoted_price, keyboard: .decimal)
            }
        }
    }

    /// The Outcome card, and under it the Save button. The button does not exist until the call can
    /// be saved (a 10-digit phone and an outcome), so there is never a disabled button to puzzle over.
    private var outcomeSection: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
            FormSection(title: "Outcome") {
                OutcomeToggle(outcome: $draft.outcome)
                if draft.isLost {
                    FieldGroup(label: "Why did they decline?") {
                        ChipGrid(options: ChipOptions.declineReason, selection: $draft.decline_reason)
                    }
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .themeAnimation(value: draft.isLost)

            Group {
                if draft.canSave {
                    ActionPillButton("Save Call", action: save)
                        .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.15), value: draft.canSave)
        }
    }

    private var notesSection: some View {
        FormSection(title: "Notes") {
            NotesField(label: "Notes", placeholder: "Anything else…", text: $draft.notes_comments)
        }
    }

    // MARK: - Chrome

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItemGroup(placement: .cancellationAction) {
            Button("Clear") { confirmClear = true }
            Button { showQuickMileage = true } label: {
                Image(systemName: "map")
                    .frame(minWidth: 44, minHeight: 44)
            }
            .accessibilityLabel("Quick mileage")
            .accessibilityHint("Opens a standalone mileage calculator. The current call is not changed.")
        }
        ToolbarItem(placement: .primaryAction) {
            let state = syncState
            Button { showSyncDetail = true } label: {
                StatusBadge(title: state.badgeTitle, systemImage: state.symbol, tone: state.tone)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle())
            .accessibilityLabel("Sync status: \(state.badgeTitle)")
            .accessibilityHint("Opens sync details")
        }
        #if os(iOS)
        ToolbarItemGroup(placement: .keyboard) {
            Spacer()
            Button("Done") { dismissKeyboard() }
                .font(.headline)
        }
        #endif
    }

    @ViewBuilder
    private var savedBanner: some View {
        if showSavedBanner {
            Label("Call saved", systemImage: "checkmark.circle.fill")
                .font(.headline)
                .foregroundStyle(Theme.onFill)
                .padding(.horizontal, Theme.Spacing.lg)
                .padding(.vertical, Theme.Spacing.sm)
                .background(Theme.won, in: Capsule())
                .cardShadow()
                .padding(.top, Theme.Spacing.xs)
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    // MARK: - Actions

    private func save() {
        guard draft.canSave else { return }
        do {
            try sync.save(draft)
        } catch {
            saveError = error.localizedDescription
            return
        }
        dismissKeyboard()
        draft = CallDraft()
        savedCount += 1
        scrollTopTick += 1
        withAnimation(Theme.spring) { showSavedBanner = true }
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            withAnimation(Theme.spring) { showSavedBanner = false }
        }
    }
}

#if DEBUG
import SwiftData

/// The whole screen with an in-memory queue. This build has no webhook, so it also shows the
/// "setup needed" state in the toolbar.
private struct DispatchFormPreview: View {
    private static let container: ModelContainer = {
        // swiftlint:disable:next force_try
        try! ModelContainer(for: CallRecord.self, configurations: ModelConfiguration(isStoredInMemoryOnly: true))
    }()

    var body: some View {
        DispatchFormView()
            .environment(SyncManager(context: Self.container.mainContext, config: nil))
            .modelContainer(Self.container)
    }
}

#Preview("Dispatch · Light") { DispatchFormPreview().preferredColorScheme(.light) }
#Preview("Dispatch · Dark") { DispatchFormPreview().preferredColorScheme(.dark) }
#Preview("Dispatch · Large text") { DispatchFormPreview().dynamicTypeSize(.accessibility3) }
#endif
