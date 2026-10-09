#if DEBUG
import SwiftUI

/// The form's controls in their selected and unselected states, for previews and visual review.
struct FormControlsGallery: View {
    @State private var payer = "Agero"
    @State private var make = "Tesla"
    @State private var phone = "9165550199"
    @State private var empty = ""
    @State private var notes = ""
    @State private var wonOutcome = ChipOptions.outcomeWon
    @State private var lostOutcome = ChipOptions.outcomeLost
    @State private var noOutcome = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                FormSection(title: "Chips") {
                    FieldGroup(label: "Payer") {
                        ChipGrid(options: ChipOptions.payerName, selection: $payer, minChipWidth: 105)
                    }
                    FieldGroup(label: "Make") {
                        ChipGridWithOther(options: ["Toyota", "Honda", "Tesla"], value: $make,
                                          otherPlaceholder: "Make", minChipWidth: 105)
                    }
                }
                FormSection(title: "Fields") {
                    FieldGroup(label: "Phone") {
                        BigTextField(label: "Phone", placeholder: "916-555-0199", text: $phone, keyboard: .phone)
                    }
                    FieldGroup(label: "Empty") {
                        BigTextField(label: "Empty", placeholder: "Placeholder text", text: $empty)
                    }
                    NotesField(label: "Notes", placeholder: "Anything else…", text: $notes)
                }
                FormSection(title: "Outcome: won") { OutcomeToggle(outcome: $wonOutcome) }
                FormSection(title: "Outcome: lost") { OutcomeToggle(outcome: $lostOutcome) }
                FormSection(title: "Outcome: none") { OutcomeToggle(outcome: $noOutcome) }
            }
            .padding(Theme.Spacing.md)
        }
        .background(Theme.background)
    }
}

#Preview("Controls · Light") { FormControlsGallery().preferredColorScheme(.light) }
#Preview("Controls · Dark") { FormControlsGallery().preferredColorScheme(.dark) }
#Preview("Controls · Large text") { FormControlsGallery().dynamicTypeSize(.accessibility3) }
#endif
