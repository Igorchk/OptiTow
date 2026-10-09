import CoreLocation
import Foundation
import MapKit
import Observation

/// Driving distance between two points. A protocol so the routing logic does not depend on MapKit
/// being reachable.
protocol RouteDistanceProviding: Sendable {
    func drivingMeters(from: CLLocationCoordinate2D, to: CLLocationCoordinate2D) async throws -> Double
}

/// Apple Maps driving directions (`MKDirections`, automobile).
struct MapKitRouteProvider: RouteDistanceProviding {
    func drivingMeters(from: CLLocationCoordinate2D, to: CLLocationCoordinate2D) async throws -> Double {
        let request = MKDirections.Request()
        request.source = Self.mapItem(at: from)
        request.destination = Self.mapItem(at: to)
        request.transportType = .automobile
        request.requestsAlternateRoutes = false
        let response = try await MKDirections(request: request).calculate()
        guard let route = response.routes.first else { throw MKError(.directionsNotFound) }
        return route.distance
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
    let provider: any RouteDistanceProviding
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

        func miles(_ index: Int) -> Double? { try? results[index].get() }
        let failure = results.compactMap { result -> TripFailure? in
            if case .failure(let failure) = result { return failure }
            return nil
        }.max()
        return TripResult(legs: TripLegs(toPickup: miles(0), loaded: miles(1), toYard: miles(2)), failure: failure)
    }

    private func leg(from: CLLocationCoordinate2D, to: CLLocationCoordinate2D) async -> Result<Double, TripFailure> {
        do {
            let meters = try await withTimeout(seconds: timeoutSeconds) {
                try await provider.drivingMeters(from: from, to: to)
            }
            return .success(Miles.fromMeters(meters))
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

/// Keeps the card's state in step with the two address fields. Recomputes only when an endpoint
/// really changed, and a newer request always cancels an older one so a stale answer can never
/// overwrite a fresh one.
@MainActor @Observable
final class TripMileageModel {
    private(set) var state: TripMileageState = .idle

    @ObservationIgnored private let router: TripRouter
    @ObservationIgnored private var endpoints = TripEndpoints()
    @ObservationIgnored private var task: Task<Void, Never>?

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
        switch (endpoints.pickup, endpoints.dropoff) {
        case let (.resolved(pickup), .resolved(dropoff)):
            state = .loading
            let router = router
            var origin: CLLocationCoordinate2D?
            if case .resolved(let start) = endpoints.start { origin = start.coordinate }
            task = Task { [origin] in
                let result = await router.calculate(start: origin, pickup: pickup.coordinate,
                                                    dropoff: dropoff.coordinate)
                guard !Task.isCancelled else { return }
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
    }
}
