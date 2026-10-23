import Foundation
import SwiftData

/// One dispatcher call, cached offline until the webhook accepts it.
///
/// Payload properties deliberately use the exact snake_case keys from SCHEMA.md so the
/// model, the JSON payload and the Apps Script can't drift apart.
@Model
final class CallRecord {
    @Attribute(.unique) var call_id: String
    var date_time: Date
    var customer_phone: String
    var caller_type: String
    var payer_name: String
    var service_requested: String
    var vehicle_year: String
    var vehicle_make: String
    var vehicle_model: String
    var drivetrain: String
    var vehicle_condition: String
    var scene_location: String
    var start_location: String
    var pickup_address: String
    var dropoff_address: String
    var quoted_price: Double?
    var outcome: String
    var decline_reason: String
    var notes_comments: String

    // Sync bookkeeping — never sent to the webhook.
    var isSynced: Bool
    /// The server answered BAD_REQUEST; retrying the same payload can't succeed.
    var isRejected: Bool
    /// Parked rather than rejected by the server: it kept answering with a server error (not a refusal
    /// of this payload), so the app gave up on it and moved on. Always also `isRejected`, which is what
    /// takes it out of the queue. The dispatcher can put it back with "Retry parked calls".
    var isParked: Bool = false
    /// Every transient retry, whatever the cause (offline, busy, a server error).
    var syncAttempts: Int
    /// Consecutive server errors (INTERNAL or an unclassified code) for this call; a success resets it.
    /// Offline and busy retries do not count, so only a call that keeps failing the server gets parked.
    var attemptCount: Int = 0
    var lastSyncError: String?
    var createdAt: Date
    var syncedAt: Date?

    init(draft: CallDraft) {
        call_id = draft.call_id
        date_time = draft.date_time
        customer_phone = draft.customer_phone
        caller_type = draft.caller_type
        payer_name = draft.payer_name
        service_requested = draft.service_requested
        vehicle_year = draft.vehicle_year
        vehicle_make = draft.vehicle_make
        vehicle_model = draft.vehicle_model
        drivetrain = draft.drivetrain
        vehicle_condition = draft.vehicle_condition
        scene_location = draft.scene_location
        start_location = draft.start_location
        pickup_address = draft.pickup_address
        dropoff_address = draft.dropoff_address
        quoted_price = draft.quotedPriceValue
        outcome = draft.outcome
        decline_reason = draft.outcome == ChipOptions.outcomeLost ? draft.decline_reason : ""
        notes_comments = draft.notes_comments
        isSynced = false
        isRejected = false
        isParked = false
        syncAttempts = 0
        attemptCount = 0
        lastSyncError = nil
        createdAt = .now
        syncedAt = nil
    }

    func payload(token: String) -> SyncPayload {
        SyncPayload(
            token: token,
            call_id: call_id,
            date_time: date_time.ISO8601Format(),
            customer_phone: customer_phone,
            caller_type: caller_type,
            payer_name: payer_name,
            service_requested: service_requested,
            vehicle_year: vehicle_year,
            vehicle_make: vehicle_make,
            vehicle_model: vehicle_model,
            drivetrain: drivetrain,
            vehicle_condition: vehicle_condition,
            scene_location: scene_location,
            start_location: start_location,
            pickup_address: pickup_address,
            dropoff_address: dropoff_address,
            quoted_price: quoted_price,
            outcome: outcome,
            decline_reason: decline_reason,
            notes_comments: notes_comments
        )
    }
}

/// The exact JSON body from SCHEMA.md. Property names are the wire keys.
struct SyncPayload: Encodable, Sendable {
    let token: String
    let call_id: String
    let date_time: String
    let customer_phone: String
    let caller_type: String
    let payer_name: String
    let service_requested: String
    let vehicle_year: String
    let vehicle_make: String
    let vehicle_model: String
    let drivetrain: String
    let vehicle_condition: String
    let scene_location: String
    let start_location: String
    let pickup_address: String
    let dropoff_address: String
    let quoted_price: Double?
    let outcome: String
    let decline_reason: String
    let notes_comments: String
}
