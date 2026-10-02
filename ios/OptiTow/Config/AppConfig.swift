import Foundation

/// Webhook endpoint and secret, read from the git-ignored `Secrets.plist` bundled with the app.
/// See ios/README.md for setup.
struct AppConfig: Sendable {
    let webhookURL: URL
    let apiSecret: String

    static func load(bundle: Bundle = .main) -> AppConfig? {
        guard let url = bundle.url(forResource: "Secrets", withExtension: "plist"),
              let data = try? Data(contentsOf: url),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let urlString = (plist["WEBHOOK_URL"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              let webhookURL = URL(string: urlString), webhookURL.scheme == "https",
              let secret = (plist["API_SECRET"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !secret.isEmpty
        else { return nil }
        return AppConfig(webhookURL: webhookURL, apiSecret: secret)
    }
}
