import SwiftUI

/// The ML target variable: a massive two-way Won / Lost toggle (APP_SPEC.md §6).
struct OutcomeToggle: View {
    @Binding var outcome: String

    var body: some View {
        HStack(spacing: 12) {
            side(value: ChipOptions.outcomeWon, title: "WON", subtitle: "Booked",
                 symbol: "checkmark.circle.fill", color: Theme.won)
            side(value: ChipOptions.outcomeLost, title: "LOST", subtitle: "Declined",
                 symbol: "xmark.circle.fill", color: Theme.lost)
        }
        .sensoryFeedback(.impact(weight: .heavy), trigger: outcome)
    }

    private func side(value: String, title: String, subtitle: String, symbol: String, color: Color) -> some View {
        let isSelected = outcome == value
        return Button {
            outcome = isSelected ? "" : value
        } label: {
            VStack(spacing: 6) {
                Image(systemName: symbol).font(.system(size: 38, weight: .bold))
                Text(title).font(.system(size: 30, weight: .heavy))
                Text(subtitle).font(.subheadline.weight(.semibold)).opacity(0.8)
            }
            .frame(maxWidth: .infinity, minHeight: 150)
            .foregroundStyle(isSelected ? Color.black : color)
            .background(isSelected ? color : Theme.surface, in: RoundedRectangle(cornerRadius: 20))
            .overlay(RoundedRectangle(cornerRadius: 20).stroke(color, lineWidth: isSelected ? 0 : 3))
            .contentShape(RoundedRectangle(cornerRadius: 20))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title), \(subtitle)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
