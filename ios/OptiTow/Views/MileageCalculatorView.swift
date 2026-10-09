import SwiftUI

/// A standalone mileage estimate: pick a pickup and a dropoff and see the yard -> pickup -> dropoff
/// -> yard driving miles. It has its own address state and its own mileage model, so nothing typed
/// here reaches the call being filled in, and closing the sheet discards it.
struct MileageCalculatorView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var pickupText = ""
    @State private var dropoffText = ""
    @State private var startText = ""
    @State private var start = AddressEntry.unset
    @State private var pickup = AddressEntry.unset
    @State private var dropoff = AddressEntry.unset
    @State private var trip = TripMileageModel()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: Theme.Spacing.lg) {
                    FormSection(title: "Route") {
                        FieldGroup(label: "Start Location") {
                            AddressField(label: "Start location", placeholder: "Tap to enter start location (default: yard)",
                                         text: $startText, entry: $start,
                                         manualStatus: "Manual start — mileage uses the yard",
                                         manualRowTitle: "Use as typed — mileage uses the yard")
                        }
                        FieldGroup(label: "Pickup Address") {
                            AddressField(label: "Pickup address", placeholder: "Tap to enter pickup address",
                                         text: $pickupText, entry: $pickup)
                        }
                        FieldGroup(label: "Dropoff Address") {
                            AddressField(label: "Dropoff address", placeholder: "Tap to enter dropoff address",
                                         text: $dropoffText, entry: $dropoff)
                        }
                    }
                    TripMileageCard(state: trip.state, onRetry: trip.retry)
                }
                .padding(Theme.Spacing.md)
            }
            .scrollDismissesKeyboard(.interactively)
            // Short content still bounces, so a drag dismisses the keyboard and reveals the result.
            .scrollBounceBehavior(.always, axes: .vertical)
            .background(Theme.background)
            .navigationTitle("Quick Mileage")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .font(.headline)
                }
                #if os(iOS)
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Hide Keyboard") { dismissKeyboard() }
                        .font(.headline)
                }
                #endif
            }
            .onChange(of: TripEndpoints(start: start, pickup: pickup, dropoff: dropoff)) { _, endpoints in
                trip.update(endpoints)
            }
        }
        .presentationDragIndicator(.visible)
    }
}

#if DEBUG
#Preview("Quick mileage · Light") { MileageCalculatorView().preferredColorScheme(.light) }
#Preview("Quick mileage · Dark") { MileageCalculatorView().preferredColorScheme(.dark) }
#Preview("Quick mileage · Large text") { MileageCalculatorView().dynamicTypeSize(.accessibility3) }
#endif
