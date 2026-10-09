import CoreLocation
import Foundation

/// An address the dispatcher confirmed from the suggestions, with the coordinate used for routing.
/// Form-only: it is never saved or synced. Only the address text goes in the existing field.
struct ResolvedPlace: Equatable, Sendable {
    let address: String
    let latitude: Double
    let longitude: Double

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    /// The street line. MapKit's placemark sometimes drops the house number that the suggestion's own
    /// title had ("5431 Brook Trail Ct" resolving to "Brook Trail Ct"), so the title wins whenever it
    /// contains the placemark's street name.
    static func streetLine(title: String, subThoroughfare: String?, thoroughfare: String?) -> String {
        let street = (thoroughfare ?? "").trimmingCharacters(in: .whitespaces)
        let number = (subThoroughfare ?? "").trimmingCharacters(in: .whitespaces)
        if !street.isEmpty, title.localizedCaseInsensitiveContains(street) { return title }
        return [number, street].filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// "5431 Brook Dr, Rocklin, CA 95677": street, city, state and ZIP, skipping any missing part
    /// and not repeating a name (a city-level result titled "Rocklin" in the city "Rocklin").
    static func formatAddress(street: String?, locality: String?, state: String?, postalCode: String?,
                              fallbackTitle: String) -> String {
        func clean(_ text: String?) -> String? {
            let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : trimmed
        }
        let stateAndZip = [clean(state), clean(postalCode)].compactMap { $0 }.joined(separator: " ")
        var parts: [String] = []
        for part in [clean(street) ?? clean(fallbackTitle), clean(locality), clean(stateAndZip)].compactMap({ $0 }) {
            if parts.last?.caseInsensitiveCompare(part) != .orderedSame { parts.append(part) }
        }
        return parts.joined(separator: ", ")
    }
}

/// What the dispatcher has done in an address field.
enum AddressEntry: Equatable, Sendable {
    /// Nothing chosen: empty, or text still being typed.
    case unset
    /// "Use as typed": the text stays exactly as written and no mileage is available.
    case manual(String)
    /// A confirmed suggestion.
    case resolved(ResolvedPlace)
}

/// Both ends of the trip, as the mileage card sees them.
struct TripEndpoints: Equatable, Sendable {
    var pickup: AddressEntry = .unset
    var dropoff: AddressEntry = .unset
}
