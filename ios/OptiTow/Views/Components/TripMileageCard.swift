import SwiftUI

/// "Trip Mileage": the driving miles for yard -> pickup, pickup -> dropoff and dropoff -> yard, with
/// a total. A quote and triage aid for the dispatcher only; it is never saved or synced (the sheet
/// computes its own mileage from the addresses).
struct TripMileageCard: View {
    let state: TripMileageState
    var onRetry: () -> Void = {}

    @Environment(\.dynamicTypeSize) private var typeSize

    private var legs: TripLegs {
        switch state {
        case .result(let legs), .failed(let legs, _): legs
        case .idle, .loading, .manual: TripLegs()
        }
    }

    var body: some View {
        FormSection(title: "Trip Mileage") {
            switch state {
            case .idle:
                Text("Choose the pickup and dropoff from the address suggestions to see the driving miles.")
                    .metadata()
            case .manual:
                manualNotice
            case .loading, .result, .failed:
                VStack(alignment: .leading, spacing: Theme.Spacing.md) {
                    legRow
                    totalBlock
                    footer
                }
            }
        }
    }

    // MARK: Pieces

    private var legRow: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(spacing: Theme.Spacing.xs))
            : AnyLayout(HStackLayout(alignment: .top, spacing: Theme.Spacing.xs))
        return layout {
            LegCell(title: "To Pickup", miles: legs.toPickup, isLoading: state == .loading)
            LegCell(title: "Loaded", miles: legs.loaded, isLoading: state == .loading)
            LegCell(title: "To Yard", miles: legs.toYard, isLoading: state == .loading)
        }
    }

    private var totalBlock: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            Text("Total miles")
                .font(.footnote.weight(.semibold))
                .tracking(0.9)
                .textCase(.uppercase)
                .opacity(0.75)
            if state == .loading {
                HStack(spacing: Theme.Spacing.xs) {
                    ProgressView().tint(Theme.inverseText)
                    Text("Calculating…").font(.title3.weight(.semibold))
                }
            } else {
                HStack(alignment: .firstTextBaseline, spacing: Theme.Spacing.xs) {
                    Text(Miles.text(legs.total))
                        .font(.system(.largeTitle, design: .rounded).weight(.heavy).monospacedDigit())
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                    if legs.total != nil { Text("mi").font(.title3.weight(.semibold)) }
                }
            }
        }
        .foregroundStyle(Theme.inverseText)
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.inverseFill, in: RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(totalAccessibilityLabel)
    }

    private var totalAccessibilityLabel: String {
        if state == .loading { return "Total miles, calculating" }
        guard let total = legs.total else { return "Total miles, unavailable" }
        return "Total miles, \(Miles.text(total))"
    }

    @ViewBuilder
    private var footer: some View {
        if case .failed(_, let failure) = state {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                Text(failure.message)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.Tone.danger.foreground)
                ActionPillButton("Try again", kind: .secondary, fillsWidth: false, action: onRetry)
            }
        } else if case .result = state {
            Text("Estimate from Apple Maps driving directions. The spreadsheet records its own mileage.").metadata()
        }
    }

    private var manualNotice: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            Text("Manual address — mileage unavailable")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
            Text("Pick a suggested address for both stops to see mileage. Saving isn't affected.").metadata()
        }
        .padding(Theme.Spacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.control, in: RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous)
            .strokeBorder(Theme.controlBorder, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

/// One leg: a small label over the miles, in a quiet well.
private struct LegCell: View {
    let title: String
    let miles: Double?
    let isLoading: Bool

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            Text(title).font(.footnote.weight(.medium)).foregroundStyle(Theme.textSecondary)
            HStack(alignment: .firstTextBaseline, spacing: 3) {
                Text(Miles.text(miles))
                    .font(.title3.weight(.semibold).monospacedDigit())
                    .foregroundStyle(miles == nil ? Theme.textTertiary : Theme.textPrimary)
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
                if miles != nil { Text("mi").font(.footnote.weight(.medium)).foregroundStyle(Theme.textSecondary) }
            }
        }
        .padding(Theme.Spacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.control, in: shape)
        .overlay(shape.strokeBorder(Theme.controlBorder, lineWidth: 1))
        .opacity(isLoading ? 0.6 : 1)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    private var accessibilityLabel: String {
        if isLoading { return "\(title), calculating" }
        guard let miles else { return "\(title), unavailable" }
        return "\(title), \(Miles.text(miles)) miles"
    }
}

#if DEBUG
private struct TripMileageGallery: View {
    private let full = TripLegs(toPickup: 12.4, loaded: 8.7, toYard: 15.1)

    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.lg) {
                TripMileageCard(state: .idle)
                TripMileageCard(state: .loading)
                TripMileageCard(state: .result(full))
                TripMileageCard(state: .failed(TripLegs(toPickup: 12.4, loaded: nil, toYard: 15.1), .noRoute))
                TripMileageCard(state: .failed(TripLegs(), .unreachable))
                TripMileageCard(state: .manual)
            }
            .padding(Theme.Spacing.md)
        }
        .background(Theme.background)
    }
}

#Preview("Trip mileage · Light") { TripMileageGallery().preferredColorScheme(.light) }
#Preview("Trip mileage · Dark") { TripMileageGallery().preferredColorScheme(.dark) }
#Preview("Trip mileage · Large text") { TripMileageGallery().dynamicTypeSize(.accessibility3) }
#endif
