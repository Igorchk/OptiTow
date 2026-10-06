import Foundation

/// In-progress form state for the call on the line. Converted to a `CallRecord` on save.
struct CallDraft: Equatable {
    /// Generated when the form opens so retries of the same call upsert one row.
    var call_id = UUID().uuidString
    /// Captured when the form opens, i.e. roughly when the call started.
    var date_time = Date.now

    var customer_phone = ""
    var caller_type = ""
    var payer_name = ""
    var service_requested = ""
    var vehicle_year = ""
    var vehicle_make = ""
    var vehicle_model = ""
    var drivetrain = ""
    var vehicle_condition = ""
    var scene_location = ""
    var start_location = ""
    var pickup_address = ""
    var dropoff_address = ""
    var quoted_price = ""
    var outcome = ""
    var decline_reason = ""
    var notes_comments = ""

    var quotedPriceValue: Double? {
        let cleaned = quoted_price.replacingOccurrences(of: "$", with: "")
            .replacingOccurrences(of: ",", with: "")
            .trimmingCharacters(in: .whitespaces)
        return Double(cleaned)
    }

    /// The phone number's ASCII digits only, so "(916) 555-0199" and "+1 916-555-0199" count the
    /// same as "9165550199". Matches the server, which strips every non-digit.
    var phoneDigits: String { customer_phone.filter { $0.isASCII && $0.isNumber } }

    /// The phone is the key for merging CallRail data into this call, so a call can't be saved
    /// without a full number.
    var hasValidPhone: Bool { phoneDigits.count >= 10 }

    /// A call needs a usable phone number and an outcome (the ML target).
    var canSave: Bool { hasValidPhone && !outcome.isEmpty }

    var isLost: Bool { outcome == ChipOptions.outcomeLost }
}
