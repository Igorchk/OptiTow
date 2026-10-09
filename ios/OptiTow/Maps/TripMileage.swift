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

struct TripResult: Equatable, Sendable {
    var legs: TripLegs
    /// The most serious problem among the legs that could not be routed, if any.
    var failure: TripFailure?
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
