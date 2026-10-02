import Foundation

/// Body returned by apps-script/Code.gs. Apps Script always answers HTTP 200, so success
/// is `ok`, never the status code.
struct WebhookResponse: Decodable, Sendable {
    let ok: Bool
    let code: String?
    let error: String?
    let action: String?
    let warnings: [String]?
}

enum SyncResult: Sendable, Equatable {
    case synced
    /// Transient (lock busy, server hiccup, no connectivity): retry the same record later.
    case retryLater(String)
    /// Deployment/credential problem: affects every record, so stop draining.
    case halt(String)
    /// This payload will never be accepted: park the record.
    case reject(String)

    init(response: WebhookResponse) {
        if response.ok {
            self = .synced
            return
        }
        let message = response.error ?? "Unknown error"
        switch response.code {
        case "BAD_REQUEST": self = .reject(message)
        case "UNAUTHORIZED", "SERVER_MISCONFIGURED": self = .halt(message)
        default: self = .retryLater(message) // BUSY, INTERNAL, anything new
        }
    }
}

struct WebhookClient: Sendable {
    let endpoint: URL
    var session: URLSession = .shared

    func send(_ payload: SyncPayload) async -> SyncResult {
        var request = URLRequest(url: endpoint, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        do {
            request.httpBody = try JSONEncoder().encode(payload)
            // URLSession follows Apps Script's 302 to script.googleusercontent.com as a GET,
            // which is how the web app hands back its response.
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? -1
                return .retryLater("HTTP \(status)")
            }
            guard let body = try? JSONDecoder().decode(WebhookResponse.self, from: data) else {
                // Usually a Google sign-in page: the deployment isn't set to "Anyone".
                return .halt("Webhook returned a non-JSON response. Check the web app deployment access.")
            }
            return SyncResult(response: body)
        } catch {
            return .retryLater(error.localizedDescription)
        }
    }
}
