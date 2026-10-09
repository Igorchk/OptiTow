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

/// As-you-type address suggestions for one field, kept to California, and the step that turns a
/// tapped suggestion into a full address plus a coordinate.
@MainActor @Observable
final class AddressSearch: NSObject {
    /// At most this many suggestion rows; the "use as typed" row comes after them.
    static let maxSuggestions = 6
    static let debounce: Duration = .milliseconds(250)

    private(set) var suggestions: [AddressSuggestion] = []
    private(set) var isResolving = false
    /// Why the last tap did not produce an address, in plain words. Cleared on the next keystroke.
    private(set) var problem: String?

    @ObservationIgnored private let completer = MKLocalSearchCompleter()
    @ObservationIgnored private var pendingQuery: Task<Void, Never>?

    override init() {
        super.init()
        completer.delegate = self
        completer.resultTypes = .address
        completer.region = California.region
    }

    /// Sample rows for previews; no search is run.
    init(previewSuggestions: [AddressSuggestion]) {
        suggestions = previewSuggestions
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
