import CoreLocation
import Foundation
import MapKit

/// Where the truck starts and ends a job. The mileage card routes yard -> pickup -> dropoff -> yard.
///
/// Defaults to Rio Linda, CA (the same yard the Apps Script uses). A different yard can be set with
/// optional `YARD_ADDRESS`, `YARD_LAT` and `YARD_LON` keys in `Secrets.plist`; this is read
/// separately from `AppConfig`, so mileage works even in a build with no webhook set up.
struct YardLocation: Equatable, Sendable {
    let address: String
    let latitude: Double
    let longitude: Double

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    static let `default` = YardLocation(address: "Rio Linda, CA", latitude: 38.6882, longitude: -121.4483)

    /// Read once at launch.
    static let current = load()

    static func load(bundle: Bundle = .main) -> YardLocation {
        guard let url = bundle.url(forResource: "Secrets", withExtension: "plist"),
              let data = try? Data(contentsOf: url),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        else { return .default }
        return from(plist: plist)
    }

    /// Falls back to the default unless all three keys are present and the point is in California.
    static func from(plist: [String: Any]) -> YardLocation {
        func number(_ key: String) -> Double? {
            if let value = plist[key] as? Double { return value }
            if let text = plist[key] as? String { return Double(text.trimmingCharacters(in: .whitespaces)) }
            return nil
        }
        guard let address = (plist["YARD_ADDRESS"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !address.isEmpty, let lat = number("YARD_LAT"), let lon = number("YARD_LON"),
              California.contains(CLLocationCoordinate2D(latitude: lat, longitude: lon))
        else { return .default }
        return YardLocation(address: address, latitude: lat, longitude: lon)
    }
}

/// What counts as California for address search.
enum California {
    /// Biases the search completer toward the state (it is a hint to MapKit, not a hard limit).
    static let region = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 37.25, longitude: -119.5),
        span: MKCoordinateSpan(latitudeDelta: 10.5, longitudeDelta: 11.0)
    )

    /// A coarse box around the state, used as a sanity check on resolved coordinates. It includes
    /// slivers of neighbouring states, so the state name in the address is checked as well.
    static func contains(_ coordinate: CLLocationCoordinate2D) -> Bool {
        (32.5...42.05).contains(coordinate.latitude) && (-124.5 ... -114.1).contains(coordinate.longitude)
    }

    /// Whether a search suggestion is in California. MapKit puts the place in the subtitle
    /// ("Rocklin, CA"); a suggestion with no subtitle (a city) carries it in the title.
    static func isCaliforniaSuggestion(title: String, subtitle: String) -> Bool {
        let place = subtitle.trimmingCharacters(in: .whitespaces).isEmpty ? title : subtitle
        return place.range(of: #"(^|[\s,])(CA|California)([\s,.]|$)"#, options: .regularExpression) != nil
    }
}
