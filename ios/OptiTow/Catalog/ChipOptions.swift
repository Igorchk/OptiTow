import Foundation

/// Exact chip strings from APP_SPEC.md §5–6. These values are written verbatim to the
/// sheet and must stay in sync with `ENUMS` in apps-script/Code.gs.
enum ChipOptions {
    static let callerType = ["Private Cash", "Insurance / Motor Club", "Commercial Fleet", "Body Shop"]
    static let payerName = ["Cash / Customer", "Triple A (AAA)", "Agero", "Geico", "Allstate", "State Farm", "Swoop", "Urgently", "Other"]
    static let serviceRequested = ["Standard Tow", "Flatbed / Specialty", "Jump Start", "Tire Change", "Tire Patch", "Lockout", "Winch Out Only", "Winch Out + Tow"]
    static let vehicleCondition = ["Rolling / Neutral", "Locked in Park", "No Keys", "Flat Tire", "Ditch / Mud / Winch", "Collision", "Wheel Damaged", "Mechanical / Electrical Issue"]

    static let outcomeWon = "1 - Won / Booked"
    static let outcomeLost = "0 - Lost / Declined"
    static let declineReason = ["Price Too High", "ETA Too Long", "Already Found Help", "Changed Mind"]

    static let privateCash = "Private Cash"
    static let cashPayer = "Cash / Customer"
}
