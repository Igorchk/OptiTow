import CoreLocation
import Foundation
import MapKit

/// Distances for the three legs of a job, in miles to one decimal place.
enum Miles {
    static let metersPerMile = 1609.344

    /// Same conversion and rounding the Apps Script uses for the sheet's mileage columns.
    static func fromMeters(_ meters: Double) -> Double {
        ((meters / metersPerMile) * 10).rounded() / 10
    }

    /// "12.3", or an em dash when there is no value.
    static func text(_ miles: Double?) -> String {
        guard let miles else { return "—" }
        return miles.formatted(.number.precision(.fractionLength(1)))
    }
}

/// Yard -> pickup, pickup -> dropoff, dropoff -> yard. A leg is nil until it has been routed.
struct TripLegs: Equatable, Sendable {
    var toPickup: Double?
    var loaded: Double?
    var toYard: Double?

    /// The sum of the three rounded legs, so the card always adds up as shown. Nil unless all three exist.
    var total: Double? {
        guard let toPickup, let loaded, let toYard else { return nil }
        return ((toPickup + loaded + toYard) * 10).rounded() / 10
    }
}

enum TripFailure: Int, Comparable, Error, Sendable {
    case noRoute, failed, busy, unreachable

    static func < (lhs: TripFailure, rhs: TripFailure) -> Bool { lhs.rawValue < rhs.rawValue }

    var message: String {
        switch self {
        case .unreachable: "Can't reach Maps. Check the connection and try again."
        case .busy: "Maps is busy. Try again in a minute."
        case .noRoute: "Maps couldn't find a driving route between these addresses."
        case .failed: "Couldn't calculate the route."
        }
    }

    static func classify(_ error: Error) -> TripFailure {
        if error is TripTimeout || error is URLError { return .unreachable }
        if let mapError = error as? MKError {
            switch mapError.code {
            case .directionsNotFound: return .noRoute
            case .loadingThrottled: return .busy
            case .serverFailure: return .unreachable
            default: return .failed
            }
        }
        return .failed
    }
}

struct TripTimeout: Error {}

/// A point on the map. Plain doubles, so route geometry can cross concurrency boundaries and be
/// compared (MapKit's own polyline and route classes are neither `Sendable` nor `Equatable`).
struct GeoPoint: Equatable, Sendable {
    var latitude: Double
    var longitude: Double

    init(latitude: Double, longitude: Double) {
        self.latitude = latitude
        self.longitude = longitude
    }

    init(_ coordinate: CLLocationCoordinate2D) {
        self.init(latitude: coordinate.latitude, longitude: coordinate.longitude)
    }

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }
}

/// One routed leg: the driving distance, the expected travel time with current traffic, and the
/// line to draw for it.
struct DrivingRoute: Equatable, Sendable {
    var meters: Double
    var seconds: TimeInterval
    var path: [GeoPoint]
}

/// Travel time as short text for the dispatcher to read out.
enum TravelTime {
    /// "18 min", "1 hr 12 min", or "< 1 min" under a minute. Nil for no value or zero. Rounds to the
    /// nearest minute, so 18.9 minutes reads as 19, not 18.
    static func text(_ seconds: TimeInterval?) -> String? {
        guard let seconds, seconds > 0, seconds.isFinite else { return nil }
        guard seconds >= 60 else { return "< 1 min" }
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = [.hour, .minute]
        formatter.unitsStyle = .short
        // The short style puts a comma between units ("1 hr, 12 min"); read aloud it is cleaner without.
        return formatter.string(from: (seconds / 60).rounded() * 60)?.replacingOccurrences(of: ",", with: "")
    }
}

/// The line of each leg, empty until that leg has been routed (or when it could not be).
struct TripPaths: Equatable, Sendable {
    var toPickup: [GeoPoint] = []
    var loaded: [GeoPoint] = []
    var toYard: [GeoPoint] = []
}

/// Everything the route map draws: the three stops, plus whichever legs have been routed so far.
struct TripMap: Equatable, Sendable {
    /// Where the truck leaves from and returns to: the yard, or the confirmed Start Location.
    var origin: GeoPoint
    var originIsYard: Bool
    var pickup: GeoPoint
    var dropoff: GeoPoint
    var paths = TripPaths()
    /// Yard (or start) to pickup: miles, and travel time with live traffic. Nil until routed.
    var leg1Miles: Double?
    var leg1Seconds: TimeInterval?
}

struct TripResult: Equatable, Sendable {
    var legs: TripLegs
    var paths = TripPaths()
    /// Yard (or start) to pickup, with live traffic. Nil when that leg could not be routed.
    var leg1TravelTime: TimeInterval?
    /// The most serious problem among the legs that could not be routed, if any.
    var failure: TripFailure?

    var formattedLeg1ETA: String? { TravelTime.text(leg1TravelTime) }
}

/// What the Trip Mileage card shows.
enum TripMileageState: Equatable, Sendable {
    /// Addresses not chosen from the suggestions yet.
    case idle
    case loading
    case result(TripLegs)
    /// Some or all legs failed; the ones that worked are still shown.
    case failed(TripLegs, TripFailure)
    /// An address was entered by hand, so there is nothing to route.
    case manual
}
