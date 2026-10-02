import Foundation

/// Make -> models lookup that powers the dependent vehicle chips (APP_SPEC.md §4).
/// Backed by the bundled `vehicles.json` so the list can be edited without touching code.
struct VehicleCatalog: Sendable {
    struct Entry: Decodable, Sendable {
        let make: String
        let models: [String]
    }

    static let otherMake = "Other"

    let entries: [Entry]

    var makes: [String] { entries.map(\.make) + [Self.otherMake] }

    func models(for make: String) -> [String] {
        entries.first { $0.make == make }?.models ?? []
    }

    static let shared: VehicleCatalog = {
        guard let url = Bundle.main.url(forResource: "vehicles", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let entries = try? JSONDecoder().decode([Entry].self, from: data)
        else {
            assertionFailure("vehicles.json missing or malformed")
            return VehicleCatalog(entries: [])
        }
        return VehicleCatalog(entries: entries)
    }()
}
