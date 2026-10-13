import CoreLocation
import Foundation
import MapKit
import Observation

/// Driving distance and line between two points. A protocol so the routing logic does not depend on
/// MapKit being reachable.
protocol RouteProviding: Sendable {
    func drivingRoute(from: CLLocationCoordinate2D, to: CLLocationCoordinate2D) async throws -> DrivingRoute
}

/// Apple Maps driving directions (`MKDirections`, automobile).
struct MapKitRouteProvider: RouteProviding {
    func drivingRoute(from: CLLocationCoordinate2D, to: CLLocationCoordinate2D) async throws -> DrivingRoute {
        let request = MKDirections.Request()
        request.source = Self.mapItem(at: from)
        request.destination = Self.mapItem(at: to)
        request.transportType = .automobile
        request.requestsAlternateRoutes = false
        // Binds the estimate to traffic right now rather than to typical conditions.
        request.departureDate = Date()
        let response = try await MKDirections(request: request).calculate()
        guard let route = response.routes.first else { throw MKError(.directionsNotFound) }
        return DrivingRoute(meters: route.distance, seconds: route.expectedTravelTime, path: Self.path(of: route))
    }

    /// The route's line as plain points; `MKRoute` itself cannot leave this call (not `Sendable`).
    private static func path(of route: MKRoute) -> [GeoPoint] {
        let polyline = route.polyline
        var coordinates = [CLLocationCoordinate2D](repeating: kCLLocationCoordinate2DInvalid,
                                                   count: polyline.pointCount)
        polyline.getCoordinates(&coordinates, range: NSRange(location: 0, length: polyline.pointCount))
        return coordinates.filter(CLLocationCoordinate2DIsValid).map(GeoPoint.init)
    }

    private static func mapItem(at coordinate: CLLocationCoordinate2D) -> MKMapItem {
        if #available(iOS 26.0, *) {
            return MKMapItem(location: CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude),
                             address: nil)
        }
        return MKMapItem(placemark: MKPlacemark(coordinate: coordinate))
    }
}

/// Routes the three legs of a job at once and reports each one.
struct TripRouter: Sendable {
    let yard: CLLocationCoordinate2D
    let provider: any RouteProviding
    /// A leg that has not answered by then counts as unreachable instead of spinning forever.
    var timeoutSeconds: Double = 20

    static var live: TripRouter {
        TripRouter(yard: YardLocation.current.coordinate, provider: MapKitRouteProvider())
    }

    /// `start` is where the truck leaves from and returns to; the configured yard when nil.
    func calculate(start: CLLocationCoordinate2D? = nil, pickup: CLLocationCoordinate2D,
                   dropoff: CLLocationCoordinate2D) async -> TripResult {
        let origin = start ?? yard
        async let toPickup = leg(from: origin, to: pickup)
        async let loaded = leg(from: pickup, to: dropoff)
        async let toYard = leg(from: dropoff, to: origin)
        let results = await [toPickup, loaded, toYard]

        func miles(_ index: Int) -> Double? { (try? results[index].get()).map { Miles.fromMeters($0.meters) } }
        func path(_ index: Int) -> [GeoPoint] { (try? results[index].get())?.path ?? [] }
        let leg1Seconds = (try? results[0].get())?.seconds
        let failure = results.compactMap { result -> TripFailure? in
            if case .failure(let failure) = result { return failure }
            return nil
        }.max()
        return TripResult(legs: TripLegs(toPickup: miles(0), loaded: miles(1), toYard: miles(2)),
                          paths: TripPaths(toPickup: path(0), loaded: path(1), toYard: path(2)),
                          leg1TravelTime: leg1Seconds, failure: failure)
    }

    /// Only yard (or `start`) to pickup, for an ETA before a dropoff is known.
    func calculateLeg1(start: CLLocationCoordinate2D? = nil, pickup: CLLocationCoordinate2D) async -> DrivingRoute? {
        try? await leg(from: start ?? yard, to: pickup).get()
    }

    private func leg(from: CLLocationCoordinate2D, to: CLLocationCoordinate2D) async -> Result<DrivingRoute, TripFailure> {
        do {
            let route = try await withTimeout(seconds: timeoutSeconds) {
                try await provider.drivingRoute(from: from, to: to)
            }
            return .success(route)
        } catch {
            return .failure(TripFailure.classify(error))
        }
    }

    private func withTimeout<T: Sendable>(seconds: Double, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await work() }
            group.addTask {
                try await Task.sleep(for: .seconds(seconds))
                throw TripTimeout()
            }
            defer { group.cancelAll() }
            guard let first = try await group.next() else { throw TripTimeout() }
            return first
        }
    }
}

/// The live-traffic estimate to the pickup, as the form shows it.
enum ETAState: Equatable, Sendable {
    case idle
    case loading
    /// Ready-to-read text, such as "18 min".
    case ready(String)
    case unavailable

    init(_ text: String?) {
        self = text.map(ETAState.ready) ?? .unavailable
    }
}

/// Keeps the card's state in step with the two address fields. Recomputes only when an endpoint
/// really changed, and a newer request always cancels an older one so a stale answer can never
/// overwrite a fresh one.
@MainActor @Observable
final class TripMileageModel {
    private(set) var state: TripMileageState = .idle
    /// What the route map draws; nil until both the pickup and the dropoff are confirmed addresses.
    /// The stops appear at once and each leg's line is added as it is routed.
    private(set) var map: TripMap?
    /// Yard (or start) to pickup with live traffic. Known as soon as the pickup is confirmed, before
    /// any dropoff.
    private(set) var eta: ETAState = .idle
    /// Whether that leg starts at the configured yard (rather than a confirmed Start Location).
    private(set) var etaFromYard = true

    @ObservationIgnored private let router: TripRouter
    @ObservationIgnored private var endpoints = TripEndpoints()
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var etaTask: Task<Void, Never>?

    init(router: TripRouter = .live) {
        self.router = router
    }

    func update(_ new: TripEndpoints) {
        guard new != endpoints else { return }
        endpoints = new
        start()
    }

    func retry() {
        start()
    }

    private func start() {
        task?.cancel()
        etaTask?.cancel()
        map = nil
        eta = .idle
        switch (endpoints.pickup, endpoints.dropoff) {
        case let (.resolved(pickup), .resolved(dropoff)):
            state = .loading
            let router = router
            var origin: CLLocationCoordinate2D?
            if case .resolved(let start) = endpoints.start { origin = start.coordinate }
            map = TripMap(origin: GeoPoint(origin ?? router.yard), originIsYard: origin == nil,
                          pickup: GeoPoint(pickup.coordinate), dropoff: GeoPoint(dropoff.coordinate))
            eta = .loading
            etaFromYard = origin == nil
            task = Task { [origin] in
                let result = await router.calculate(start: origin, pickup: pickup.coordinate,
                                                    dropoff: dropoff.coordinate)
                guard !Task.isCancelled else { return }
                map?.paths = result.paths
                map?.leg1Miles = result.legs.toPickup
                map?.leg1Seconds = result.leg1TravelTime
                eta = ETAState(result.formattedLeg1ETA)
                if let failure = result.failure {
                    state = .failed(result.legs, failure)
                } else {
                    state = .result(result.legs)
                }
            }
        case (.manual, _), (_, .manual):
            state = .manual
        default:
            state = .idle
        }
        startETAIfPickupOnly()
    }

    /// With a confirmed pickup but no routable dropoff, still estimate the trip to the pickup: it is
    /// what a customer asks first.
    private func startETAIfPickupOnly() {
        guard case .resolved(let pickup) = endpoints.pickup else { return }
        if case .resolved = endpoints.dropoff { return }
        var origin: CLLocationCoordinate2D?
        if case .resolved(let start) = endpoints.start { origin = start.coordinate }
        etaFromYard = origin == nil
        eta = .loading
        let router = router
        etaTask = Task { [origin] in
            let route = await router.calculateLeg1(start: origin, pickup: pickup.coordinate)
            guard !Task.isCancelled else { return }
            eta = ETAState(TravelTime.text(route?.seconds))
        }
    }
}
