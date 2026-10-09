import Foundation
import Observation

// MARK: - Transport

/// What the app learns when it asks whether the customer has shared yet.
enum LocationCheck: Equatable, Sendable {
    case pending
    case ready(address: String, latitude: Double, longitude: Double)
}

enum LocationTransportError: Error, Equatable, Sendable {
    /// The deployment or credentials are wrong: asking again will not help.
    case fatal(String)
    /// Network trouble or a busy server: try again.
    case temporary(String)
}

/// The two calls the app makes. A protocol so the polling logic can be tested without a network.
protocol LocationTransport: Sendable {
    /// Tells the server this link token exists, so the customer's page has something to answer.
    func register(token: String) async throws
    func check(token: String) async throws -> LocationCheck
}

/// Talks to `apps-script/Code.gs` (`?source=location`), authenticated with the API secret. The
/// customer's own page uses a separate public call; the app never exposes the secret.
struct WebhookLocationTransport: LocationTransport {
    let endpoint: URL
    let secret: String
    var session: URLSession = .shared

    private struct Reply: Decodable {
        let ok: Bool
        let code: String?
        let error: String?
        let status: String?
        let address: String?
        let lat: Double?
        let lng: Double?
    }

    func register(token: String) async throws {
        _ = try await call(action: "request_location", token: token)
    }

    func check(token: String) async throws -> LocationCheck {
        let reply = try await call(action: "check_location", token: token)
        guard reply.status == "ready", let lat = reply.lat, let lng = reply.lng else { return .pending }
        return .ready(address: reply.address ?? "", latitude: lat, longitude: lng)
    }

    private func call(action: String, token: String) async throws -> Reply {
        guard var parts = URLComponents(url: endpoint, resolvingAgainstBaseURL: false) else {
            throw LocationTransportError.fatal("The webhook address is not valid.")
        }
        parts.queryItems = (parts.queryItems ?? []) + [URLQueryItem(name: "source", value: "location")]
        guard let url = parts.url else { throw LocationTransportError.fatal("The webhook address is not valid.") }

        var request = URLRequest(url: url, timeoutInterval: 20)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // `token` is the API secret (as in every app request); `loc` is the customer link token.
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "token": secret, "action": action, "loc": token,
        ])

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw LocationTransportError.temporary(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw LocationTransportError.temporary("HTTP \((response as? HTTPURLResponse)?.statusCode ?? -1)")
        }
        guard let reply = try? JSONDecoder().decode(Reply.self, from: data) else {
            throw LocationTransportError.fatal("The webhook returned a non-JSON reply. Check the web app deployment access.")
        }
        guard reply.ok else {
            let message = reply.error ?? "Unknown error"
            switch reply.code {
            case "UNAUTHORIZED", "SERVER_MISCONFIGURED":
                throw LocationTransportError.fatal(message)
            case "BAD_REQUEST":
                // An older deployment does not know the `location` source.
                throw LocationTransportError.fatal(message.contains("Unknown source")
                    ? "The Apps Script has not been updated for location sharing. Deploy the latest Code.gs."
                    : message)
            default:
                throw LocationTransportError.temporary(message)
            }
        }
        return reply
    }
}

// MARK: - Service

/// Runs one "ask the customer where they are" request: registers a link token, hands back the link
/// to text, then polls until the customer shares, the wait times out or the dispatcher gives up.
@MainActor @Observable
final class CustomerLocationService {
    enum State: Equatable {
        case idle
        /// Registering the link with the server.
        case preparing
        case listening(token: String)
        case received(address: String)
        case timedOut
        /// Could not register or poll (offline at the start, a wrong deployment, a bad secret).
        case failed(String)
    }

    static let pollInterval: Duration = .seconds(3)
    static let timeout: Duration = .seconds(5 * 60)

    private(set) var state: State = .idle
    /// The shared position, until the form takes it with `acknowledgeReceived()`.
    private(set) var receivedPlace: ResolvedPlace?
    /// Goes up once per received location; the form uses it to react and to play the haptic.
    private(set) var receivedCount = 0

    /// False in a build with no webhook configured: there is nothing to ask.
    let isAvailable: Bool

    @ObservationIgnored private let transport: LocationTransport?
    @ObservationIgnored private let linkBase: URL?
    @ObservationIgnored private let pollInterval: Duration
    @ObservationIgnored private let timeout: Duration
    @ObservationIgnored private var pendingToken: String?
    @ObservationIgnored private var pollTask: Task<Void, Never>?

    init(config: AppConfig?, session: URLSession = .shared) {
        self.linkBase = config?.webhookURL
        self.transport = config.map { WebhookLocationTransport(endpoint: $0.webhookURL, secret: $0.apiSecret, session: session) }
        self.isAvailable = config != nil
        self.pollInterval = Self.pollInterval
        self.timeout = Self.timeout
    }

    init(transport: LocationTransport, linkBase: URL,
         pollInterval: Duration = CustomerLocationService.pollInterval,
         timeout: Duration = CustomerLocationService.timeout) {
        self.transport = transport
        self.linkBase = linkBase
        self.isAvailable = true
        self.pollInterval = pollInterval
        self.timeout = timeout
    }

    /// Twelve random lowercase hex characters: long enough that a link cannot be guessed while it
    /// is live, short enough to keep the text message tidy.
    static func makeToken() -> String {
        String(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(12))
    }

    /// The link to send to the customer.
    static func link(base: URL, token: String) -> URL? {
        guard var parts = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return nil }
        parts.queryItems = (parts.queryItems ?? []) + [URLQueryItem(name: "loc", value: token)]
        return parts.url
    }

    /// Registers a new link token and returns the link, or nil with `state == .failed`.
    func prepareLink() async -> URL? {
        guard let transport, let linkBase else { return nil }
        cancel()
        state = .preparing
        let token = Self.makeToken()
        do {
            try await transport.register(token: token)
        } catch let error as LocationTransportError {
            guard state == .preparing else { return nil }  // cancelled while registering
            switch error {
            case .fatal(let message): state = .failed(message)
            case .temporary: state = .failed("Can't reach the server. Asking for a location needs a connection.")
            }
            return nil
        } catch {
            state = .failed("Can't reach the server. Asking for a location needs a connection.")
            return nil
        }
        guard state == .preparing else { return nil }  // cancelled while registering
        pendingToken = token
        state = .idle
        return Self.link(base: linkBase, token: token)
    }

    /// Call once the text has been sent. Does nothing without a prepared link.
    func startListening() {
        guard let token = pendingToken, let transport else { return }
        pollTask?.cancel()
        state = .listening(token: token)
        let (interval, limit) = (pollInterval, timeout)
        pollTask = Task { [weak self] in
            let clock = ContinuousClock()
            let deadline = clock.now.advanced(by: limit)
            while !Task.isCancelled {
                do { try await Task.sleep(for: interval) } catch { return }
                if clock.now >= deadline {
                    self?.finish(.timedOut)
                    return
                }
                do {
                    if case .ready(let address, let lat, let lng) = try await transport.check(token: token) {
                        self?.receive(address: address, latitude: lat, longitude: lng)
                        return
                    }
                } catch LocationTransportError.fatal(let message) {
                    self?.finish(.failed(message))
                    return
                } catch {
                    continue  // a temporary failure: the next poll tries again
                }
            }
        }
    }

    /// Stops waiting (or dismisses a message) and returns to idle.
    func cancel() {
        pollTask?.cancel()
        pollTask = nil
        pendingToken = nil
        state = .idle
    }

    /// The form has taken `receivedPlace`.
    func acknowledgeReceived() {
        receivedPlace = nil
        if case .received = state { state = .idle }
    }

    // MARK: Private

    private func receive(address: String, latitude: Double, longitude: Double) {
        guard case .listening = state else { return }  // cancelled while the answer was in flight
        let text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        // Maps had no street address for the spot: the coordinates are still exact.
        let shown = text.isEmpty ? String(format: "%.5f, %.5f", latitude, longitude) : text
        receivedPlace = ResolvedPlace(address: shown, latitude: latitude, longitude: longitude)
        pendingToken = nil
        pollTask = nil
        state = .received(address: shown)
        receivedCount += 1
    }

    private func finish(_ final: State) {
        guard case .listening = state else { return }
        pendingToken = nil
        pollTask = nil
        state = final
    }
}
