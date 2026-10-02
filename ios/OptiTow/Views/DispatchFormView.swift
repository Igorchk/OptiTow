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

    private let catalog = VehicleCatalog.shared

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 32) {
                        Color.clear.frame(height: 0).id("top")
                        callerSection
                        jobSection
                        vehicleSection
                        locationSection
                        quoteSection
                        outcomeSection
                        notesSection
                    }
                    .padding(16)
                    // New call_id => fresh child state (e.g. "Other" text fields collapse).
                    .id(draft.call_id)
                }
                .scrollDismissesKeyboard(.interactively)
                .background(Theme.background)
                .safeAreaInset(edge: .bottom) { saveBar(proxy: proxy) }
            }
            .navigationTitle("New Call")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { toolbarContent }
            .overlay(alignment: .top) { savedBanner }
        }
        .sensoryFeedback(.success, trigger: savedCount)
        .alert("Couldn't save call", isPresented: Binding(get: { saveError != nil }, set: { if !$0 { saveError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(saveError ?? "")
        }
        .alert("Sync status", isPresented: $showSyncDetail) {
            Button("Retry now") { Task { await sync.drain() } }
            Button("OK", role: .cancel) {}
        } message: {
            Text(syncDetail)
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
        .onChange(of: draft.vehicle_year) { _, newValue in
            let digits = String(newValue.filter(\.isNumber).prefix(4))
            if digits != newValue { draft.vehicle_year = digits }
        }
    }

    // MARK: - Sections

    private var callerSection: some View {
        FormSection(title: "Caller") {
            FieldGroup(label: "Phone") {
                BigTextField(placeholder: "916-555-0199", text: $draft.customer_phone, keyboard: .phone)
            }
            FieldGroup(label: "Caller Type") {
                ChipGrid(options: ChipOptions.callerType, selection: $draft.caller_type)
            }
            FieldGroup(label: "Payer") {
                ChipGrid(options: ChipOptions.payerName, selection: $draft.payer_name, minChipWidth: 105)
            }
            FieldGroup(label: "Lead Source") {
                ChipGrid(options: ChipOptions.leadSource, selection: $draft.lead_source)
            }
        }
    }

    private var jobSection: some View {
        FormSection(title: "Job") {
            FieldGroup(label: "Service") {
                ChipGrid(options: ChipOptions.serviceRequested, selection: $draft.service_requested)
            }
            FieldGroup(label: "Urgency") {
                ChipGrid(options: ChipOptions.urgencyLevel, selection: $draft.urgency_level, minChipWidth: 105)
            }
        }
    }

    private var vehicleSection: some View {
        FormSection(title: "Vehicle") {
            FieldGroup(label: "Year") {
                BigTextField(placeholder: "2021", text: $draft.vehicle_year, keyboard: .number)
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
            BigTextField(placeholder: "Model", text: $draft.vehicle_model)
        } else {
            Text("Pick a make to see its models")
                .font(.subheadline)
                .foregroundStyle(Theme.textSecondary)
        }
    }

    private var locationSection: some View {
        FormSection(title: "Location") {
            FieldGroup(label: "Scene") {
                ChipGrid(options: ChipOptions.sceneLocation, selection: $draft.scene_location)
            }
            FieldGroup(label: "Pickup Address") {
                BigTextField(placeholder: "I-80 & Madison Ave, Sacramento", text: $draft.pickup_address)
            }
            FieldGroup(label: "Dropoff Address") {
                BigTextField(placeholder: "123 Auto Body Way", text: $draft.dropoff_address)
            }
            FieldGroup(label: "Start Location") {
                BigTextField(placeholder: "Yard", text: $draft.start_location)
            }
        }
    }

    private var quoteSection: some View {
        FormSection(title: "Quote") {
            FieldGroup(label: "Quoted Price ($)") {
                BigTextField(placeholder: "220.00", text: $draft.quoted_price, keyboard: .decimal)
            }
        }
    }

    private var outcomeSection: some View {
        FormSection(title: "Outcome") {
            OutcomeToggle(outcome: $draft.outcome)
            if draft.isLost {
                FieldGroup(label: "Why did they decline?") {
                    ChipGrid(options: ChipOptions.declineReason, selection: $draft.decline_reason)
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(.snappy, value: draft.isLost)
    }

    private var notesSection: some View {
        FormSection(title: "Notes") {
            TextField("", text: $draft.notes_comments,
                      prompt: Text("Anything else…").foregroundStyle(Theme.textSecondary),
                      axis: .vertical)
                .lineLimit(3...8)
                .font(.body)
                .foregroundStyle(Theme.textPrimary)
                .padding(16)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.cornerRadius))
                .overlay(RoundedRectangle(cornerRadius: Theme.cornerRadius).stroke(Theme.surfaceBorder, lineWidth: 1.5))
        }
    }

    // MARK: - Chrome

    private func saveBar(proxy: ScrollViewProxy) -> some View {
        Button {
            save(proxy: proxy)
        } label: {
            Text(draft.canSave ? "Save Call" : "Pick Won or Lost to save")
                .font(.title3.weight(.heavy))
                .frame(maxWidth: .infinity, minHeight: 64)
                .foregroundStyle(draft.canSave ? Color.black : Theme.textSecondary)
                .background(draft.canSave ? Theme.selected : Theme.surface,
                            in: RoundedRectangle(cornerRadius: Theme.cornerRadius))
        }
        .buttonStyle(.plain)
        .disabled(!draft.canSave)
        .padding(.horizontal, 16)
        .padding(.top, 10)
        .padding(.bottom, 6)
        .background(.ultraThinMaterial)
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button("Clear") { confirmClear = true }
                .foregroundStyle(Theme.textSecondary)
        }
        ToolbarItem(placement: .primaryAction) {
            Button { showSyncDetail = true } label: { SyncStatusPill(sync: sync) }
                .buttonStyle(.plain)
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
                .foregroundStyle(.black)
                .padding(.horizontal, 20)
                .padding(.vertical, 12)
                .background(Theme.won, in: Capsule())
                .padding(.top, 8)
                .transition(.move(edge: .top).combined(with: .opacity))
        }
    }

    private var syncDetail: String {
        var lines = ["\(sync.pendingCount) call(s) waiting to sync."]
        if sync.rejectedCount > 0 {
            lines.append("\(sync.rejectedCount) call(s) were rejected by the server and won't retry.")
        }
        switch sync.status {
        case .error(let message), .retrying(let message): lines.append(message)
        case .offline: lines.append("No network — calls will sync automatically when it's back.")
        case .idle, .syncing: break
        }
        return lines.joined(separator: "\n\n")
    }

    // MARK: - Actions

    private func save(proxy: ScrollViewProxy) {
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
        withAnimation { proxy.scrollTo("top", anchor: .top) }
        withAnimation(.snappy) { showSavedBanner = true }
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            withAnimation(.snappy) { showSavedBanner = false }
        }
    }

    private func dismissKeyboard() {
        #if os(iOS)
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        #endif
    }
}
