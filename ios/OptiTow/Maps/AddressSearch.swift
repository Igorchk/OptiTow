import CoreLocation
import MapKit
import Observation

/// One row in the suggestions list.
struct AddressSuggestion: Identifiable {
    /// Stable across result updates, so a row that is still a match is kept, not rebuilt.
    var id: String { "\(title)|\(subtitle)" }
    let title: String
    let subtitle: String
    /// Nil only for the sample rows in previews.
    let completion: MKLocalSearchCompletion?
}

/// One landmark or business match from a natural-language search ("Shell off I-80 near Rocklin"),
/// already resolved: it carries its address and coordinate, so choosing it needs no second lookup.
/// Plain values only (no MapKit objects), so it crosses the sheet boundary safely.
struct LandmarkCandidate: Identifiable, Equatable, Sendable {
    var id: String { "\(title)|\(address)|\(latitude)|\(longitude)" }
    /// The business or landmark name, or the street line for an address result.
    let title: String
    /// The full street address: street, city, state and ZIP.
    let address: String
    let latitude: Double
    let longitude: Double
    /// Straight-line distance from the yard, in miles, to help tell same-named places apart.
    let milesFromYard: Double

    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    var place: ResolvedPlace {
        ResolvedPlace(address: address, latitude: latitude, longitude: longitude)
    }

    var distanceText: String { "\(Miles.text(milesFromYard)) mi from yard" }

    /// Builds a candidate from a MapKit result's parts, or nil when it is outside California or has
    /// nothing to show. Kept free of MapKit types so it can be tested on its own.
    static func make(name: String?, subThoroughfare: String?, thoroughfare: String?, locality: String?,
                     state: String?, postalCode: String?, coordinate: CLLocationCoordinate2D,
                     yard: CLLocationCoordinate2D) -> LandmarkCandidate? {
        guard California.contains(coordinate), state == nil || state == "CA" else { return nil }
        func clean(_ text: String?) -> String? {
            let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return trimmed.isEmpty ? nil : trimmed
        }
        let street = [clean(subThoroughfare), clean(thoroughfare)].compactMap { $0 }.joined(separator: " ")
        guard let title = clean(name) ?? clean(street) ?? clean(locality) else { return nil }
        let address = ResolvedPlace.formatAddress(street: street.isEmpty ? nil : street, locality: locality,
                                                  state: state, postalCode: postalCode, fallbackTitle: title)
        let meters = CLLocation(latitude: coordinate.latitude, longitude: coordinate.longitude)
            .distance(from: CLLocation(latitude: yard.latitude, longitude: yard.longitude))
        return LandmarkCandidate(title: title, address: address, latitude: coordinate.latitude,
                                 longitude: coordinate.longitude, milesFromYard: Miles.fromMeters(meters))
    }
}

/// As-you-type address suggestions for one field, kept to California, and the step that turns a
/// tapped suggestion into a full address plus a coordinate.
@MainActor @Observable
final class AddressSearch: NSObject {
    /// At most this many suggestion rows; the "use as typed" row comes after them.
    static let maxSuggestions = 6
    static let debounce: Duration = .milliseconds(250)
    /// At most this many landmark matches are shown.
    static let maxLandmarks = 6

    private(set) var suggestions: [AddressSuggestion] = []
    private(set) var isResolving = false
    /// Matches for the last landmark search, in MapKit's order of relevance.
    private(set) var landmarks: [LandmarkCandidate] = []
    private(set) var isSearchingLandmarks = false
    /// Why the last tap did not produce an address, in plain words. Cleared on the next keystroke.
    private(set) var problem: String?

    @ObservationIgnored private let completer = MKLocalSearchCompleter()
    @ObservationIgnored private var pendingQuery: Task<Void, Never>?
    @ObservationIgnored private var landmarkTask: Task<Void, Never>?

    override init() {
        super.init()
        completer.delegate = self
        completer.resultTypes = .address
        completer.region = California.region
    }

    /// Sample rows for previews; no search is run.
    init(previewSuggestions: [AddressSuggestion], previewLandmarks: [LandmarkCandidate] = []) {
        suggestions = previewSuggestions
        landmarks = previewLandmarks
        super.init()
    }

    /// Call as the text changes. Waits for a pause in typing before asking MapKit.
    func update(query: String) {
        pendingQuery?.cancel()
        problem = nil
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else {
            completer.cancel()
            suggestions = []
            return
        }
        pendingQuery = Task {
            try? await Task.sleep(for: Self.debounce)
            guard !Task.isCancelled else { return }
            completer.queryFragment = trimmed
        }
    }

    func clear() {
        pendingQuery?.cancel()
        completer.cancel()
        suggestions = []
        problem = nil
    }

    /// Forgets landmark results and cancels a search in flight, so a late answer cannot appear.
    func clearLandmarks() {
        landmarkTask?.cancel()
        landmarks = []
        isSearchingLandmarks = false
        problem = nil
    }

    /// Runs a natural-language search ("McDonald's near Sunrise Blvd"), biased to California, and
    /// keeps up to `maxLandmarks` matches that are in the state. A newer search replaces an older one.
    func searchLandmarks(query: String, yard: CLLocationCoordinate2D = YardLocation.current.coordinate) {
        landmarkTask?.cancel()
        problem = nil
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 2 else {
            landmarks = []
            isSearchingLandmarks = false
            return
        }
        isSearchingLandmarks = true
        landmarks = []
        landmarkTask = Task {
            let request = MKLocalSearch.Request()
            request.naturalLanguageQuery = trimmed
            request.region = California.region
            request.resultTypes = [.pointOfInterest, .address]
            request.pointOfInterestFilter = .includingAll
            do {
                let response = try await MKLocalSearch(request: request).start()
                guard !Task.isCancelled else { return }
                var seen = Set<String>()
                let found = response.mapItems.compactMap { item -> LandmarkCandidate? in
                    let placemark = item.placemark
                    return LandmarkCandidate.make(
                        name: item.name, subThoroughfare: placemark.subThoroughfare,
                        thoroughfare: placemark.thoroughfare, locality: placemark.locality,
                        state: placemark.administrativeArea, postalCode: placemark.postalCode,
                        coordinate: placemark.coordinate, yard: yard)
                }
                landmarks = found.filter { seen.insert($0.id).inserted }.prefix(Self.maxLandmarks).map { $0 }
                if landmarks.isEmpty {
                    problem = "No California matches. Add a city or a cross street, or use it as typed."
                }
            } catch {
                guard !Task.isCancelled else { return }
                landmarks = []
                problem = Self.landmarkProblem(for: error)
            }
            isSearchingLandmarks = false
        }
    }

    private static func landmarkProblem(for error: Error) -> String {
        if let mapError = error as? MKError {
            switch mapError.code {
            case .placemarkNotFound:
                return "No California matches. Add a city or a cross street, or use it as typed."
            case .loadingThrottled:
                return "Maps is busy. Try again in a minute, or use it as typed."
            default: break
            }
        }
        return "Couldn't search (no connection?). You can use it as typed."
    }

    /// Looks the suggestion up and returns a California address with its coordinate, or nil with
    /// `problem` explaining why.
    func resolve(_ suggestion: AddressSuggestion) async -> ResolvedPlace? {
        guard let completion = suggestion.completion else { return nil }
        isResolving = true
        problem = nil
        defer { isResolving = false }
        do {
            let response = try await MKLocalSearch(request: MKLocalSearch.Request(completion: completion)).start()
            guard let item = response.mapItems.first else {
                problem = "Couldn't find that address. Pick another, or use it as typed."
                return nil
            }
            let placemark = item.placemark
            let state = placemark.administrativeArea
            guard California.contains(placemark.coordinate), state == nil || state == "CA" else {
                problem = "That address isn't in California. Pick another, or use it as typed."
                return nil
            }
            let address = ResolvedPlace.formatAddress(
                street: ResolvedPlace.streetLine(title: suggestion.title, subThoroughfare: placemark.subThoroughfare,
                                                 thoroughfare: placemark.thoroughfare),
                locality: placemark.locality, state: state, postalCode: placemark.postalCode,
                fallbackTitle: suggestion.title)
            return ResolvedPlace(address: address, latitude: placemark.coordinate.latitude,
                                 longitude: placemark.coordinate.longitude)
        } catch {
            problem = "Couldn't confirm that address (no connection?). You can use it as typed."
            return nil
        }
    }
}

extension AddressSearch: MKLocalSearchCompleterDelegate {
    // MapKit calls these on the main thread, so hopping onto the main actor is immediate.
    nonisolated func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) {
        nonisolated(unsafe) let results = completer.results
        MainActor.assumeIsolated { show(results) }
    }

    nonisolated func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) {
        MainActor.assumeIsolated { suggestions = [] }
    }

    private func show(_ results: [MKLocalSearchCompletion]) {
        var seen = Set<String>()
        suggestions = results
            .filter { California.isCaliforniaSuggestion(title: $0.title, subtitle: $0.subtitle) }
            .map { AddressSuggestion(title: $0.title, subtitle: $0.subtitle, completion: $0) }
            .filter { seen.insert($0.id).inserted }
            .prefix(Self.maxSuggestions)
            .map { $0 }
    }
}
