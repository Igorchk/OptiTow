import MapKit
import SwiftUI

/// "Route Map": the three legs of the job drawn on a map, directly under the Trip Mileage card. To
/// pickup is a dashed orange line, the loaded tow is solid green, and the return is a dashed blue
/// line, so the legs differ by line style and not by color alone. Display only, like the mileage.
struct RouteMapPreviewCard: View {
    let map: TripMap
    var isLoading = false

    @State private var position: MapCameraPosition
    @Environment(\.dynamicTypeSize) private var typeSize

    init(map: TripMap, isLoading: Bool = false) {
        self.map = map
        self.isLoading = isLoading
        _position = State(initialValue: .rect(Self.framingRect(for: map)))
    }

    private static let height: CGFloat = 220
    private static let toPickupColor = Color.orange
    private static let loadedColor = Color.green
    private static let returnColor = Color.blue

    var body: some View {
        FormSection(title: "Route Map") {
            VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
                mapView
                legend
            }
        }
        // Fit the whole route again when a stop changes or a leg's line arrives; a pan or zoom in
        // between is the dispatcher's own and stays until then.
        .onChange(of: map) { _, new in position = .rect(Self.framingRect(for: new)) }
    }

    // MARK: Map

    private var mapView: some View {
        Map(position: $position, interactionModes: [.pan, .zoom]) {
            Marker(map.originIsYard ? "Yard" : "Start", systemImage: "house.fill", coordinate: map.origin.coordinate)
                .tint(.secondary)
            Marker("Pickup", systemImage: "car.fill", coordinate: map.pickup.coordinate)
                .tint(.orange)
            Marker("Dropoff", systemImage: "flag.checkered", coordinate: map.dropoff.coordinate)
                .tint(.green)

            if map.paths.toPickup.count > 1 {
                MapPolyline(coordinates: map.paths.toPickup.map(\.coordinate))
                    .stroke(Self.toPickupColor, style: StrokeStyle(lineWidth: 4, dash: [6, 3]))
            }
            if map.paths.loaded.count > 1 {
                MapPolyline(coordinates: map.paths.loaded.map(\.coordinate))
                    .stroke(Self.loadedColor, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
            }
            if map.paths.toYard.count > 1 {
                MapPolyline(coordinates: map.paths.toYard.map(\.coordinate))
                    .stroke(Self.returnColor.opacity(0.8), style: StrokeStyle(lineWidth: 4, dash: [6, 3]))
            }
        }
        .frame(height: Self.height)
        .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.Radius.medium, style: .continuous)
            .strokeBorder(Theme.hairline, lineWidth: 1))
        .overlay(alignment: .topLeading) {
            if isLoading {
                HStack(spacing: Theme.Spacing.xs) {
                    ProgressView().controlSize(.small)
                    Text("Routing…").font(.footnote.weight(.semibold))
                }
                .foregroundStyle(Theme.textPrimary)
                .padding(.horizontal, Theme.Spacing.sm)
                .padding(.vertical, Theme.Spacing.xs)
                .background(.regularMaterial, in: Capsule())
                .padding(Theme.Spacing.sm)
                .transition(.identity)
            }
        }
        .accessibilityLabel("Route map")
        .accessibilityHint("Shows the route from \(map.originIsYard ? "the yard" : "the start") to the pickup, to the dropoff, and back.")
    }

    // MARK: Legend

    private var legend: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: Theme.Spacing.xs))
            : AnyLayout(HStackLayout(spacing: Theme.Spacing.md))
        return layout {
            LegendItem(title: "To Pickup", color: Self.toPickupColor, dashed: true)
            LegendItem(title: "Loaded", color: Self.loadedColor, dashed: false)
            LegendItem(title: "Return", color: Self.returnColor, dashed: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Legend: dashed orange is the trip to the pickup, solid green is the loaded tow, dashed blue is the return.")
    }

    // MARK: Framing

    /// The smallest rectangle holding every stop and line, with room around it. Never smaller than a
    /// couple of miles across, so two nearby stops do not zoom in to street level.
    static func framingRect(for map: TripMap) -> MKMapRect {
        var points = [map.origin, map.pickup, map.dropoff]
        points += map.paths.toPickup + map.paths.loaded + map.paths.toYard
        var rect = MKMapRect.null
        for point in points {
            let mapPoint = MKMapPoint(point.coordinate)
            rect = rect.union(MKMapRect(x: mapPoint.x, y: mapPoint.y, width: 0, height: 0))
        }
        let perMeter = MKMapPointsPerMeterAtLatitude(MKMapPoint(x: rect.midX, y: rect.midY).coordinate.latitude)
        let minimum = 3_000 * perMeter
        let width = max(rect.width * 1.6, minimum)
        let height = max(rect.height * 1.6, minimum)
        // Pins are drawn above their coordinate, so the view sits a little north of centre to keep
        // the northernmost pin inside the frame.
        let lift = height * 0.08
        return MKMapRect(x: rect.midX - width / 2, y: rect.midY - height / 2 - lift, width: width, height: height)
    }
}

/// A short sample of a leg's line next to its name.
private struct LegendItem: View {
    let title: String
    let color: Color
    let dashed: Bool

    var body: some View {
        HStack(spacing: Theme.Spacing.xs) {
            Path { path in
                path.move(to: CGPoint(x: 0, y: 2))
                path.addLine(to: CGPoint(x: 26, y: 2))
            }
            .stroke(color, style: StrokeStyle(lineWidth: dashed ? 4 : 5, lineCap: dashed ? .butt : .round,
                                              dash: dashed ? [6, 3] : []))
            .frame(width: 26, height: 4)
            Text(title)
                .font(.footnote.weight(.medium))
                .foregroundStyle(Theme.textSecondary)
        }
        .accessibilityHidden(true)
    }
}

#if DEBUG
private enum RouteMapSamples {
    static let yard = GeoPoint(latitude: 38.6882, longitude: -121.4488)
    static let pickup = GeoPoint(latitude: 38.5816, longitude: -121.4944)
    static let dropoff = GeoPoint(latitude: 38.7521, longitude: -121.2880)

    static func line(_ a: GeoPoint, _ b: GeoPoint) -> [GeoPoint] {
        (0...12).map { step in
            let t = Double(step) / 12
            let bend = sin(t * .pi) * 0.01
            return GeoPoint(latitude: a.latitude + (b.latitude - a.latitude) * t + bend,
                            longitude: a.longitude + (b.longitude - a.longitude) * t)
        }
    }

    static let full = TripMap(origin: yard, originIsYard: true, pickup: pickup, dropoff: dropoff,
                              paths: TripPaths(toPickup: line(yard, pickup), loaded: line(pickup, dropoff),
                                               toYard: line(dropoff, yard)))
    static let stopsOnly = TripMap(origin: yard, originIsYard: false, pickup: pickup, dropoff: dropoff)
}

private struct RouteMapGallery: View {
    var body: some View {
        ScrollView {
            VStack(spacing: Theme.Spacing.lg) {
                RouteMapPreviewCard(map: RouteMapSamples.full)
                RouteMapPreviewCard(map: RouteMapSamples.stopsOnly, isLoading: true)
            }
            .padding(Theme.Spacing.md)
        }
        .background(Theme.background)
    }
}

#Preview("Route map · Light") { RouteMapGallery().preferredColorScheme(.light) }
#Preview("Route map · Dark") { RouteMapGallery().preferredColorScheme(.dark) }
#Preview("Route map · Large text") { RouteMapGallery().dynamicTypeSize(.accessibility3) }
#endif
