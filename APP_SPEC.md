# iOS App UI/UX & Feature Specifications

## 1. Core Mandate
This app is a "dumb, offline-first data pusher" for dispatchers. It does NOT do machine learning. It does NOT read past data. It only captures inputs and POSTs to a webhook.

## 2. Sync Architecture (`SyncManager.swift`)
- **Offline-First:** All saves immediately write to SwiftData with `isSynced = false`.
- **Auto-Drain:** Use `NWPathMonitor`. Whenever an active network is detected, silently drain the queue by POSTing to the webhook. Mark `isSynced = true` upon a 200 OK response.

## 3. UI/UX Rules (CRITICAL)
- **One-Handed Dispatch:** The user is on the phone. Do NOT use native iOS scrolling picker wheels or tiny native dropdowns. 
- **Chip Grids:** Use large, high-contrast wrap-around button grids (`LazyVGrid`) for 1-tap selections.
- **Light and Dark Mode:** Follow the system appearance, using Apple semantic colors for surfaces and text. Contrast is checked separately in each mode (text at least 4.5:1). The one loud color is safety yellow, reserved for "selected" and the primary action; it is never the only cue: selected controls also change type weight and gain a thicker outline, with no icon inside the pill.
- **Touch targets:** Chips and buttons are at least 52pt tall (Apple's minimum is 44pt) and scale with Dynamic Type. At accessibility text sizes chips go one per row and Won/Lost stack vertically.
- **Layout and tokens:** Sections are cards on a grouped background, on an 8-point grid (`Theme.swift`: spacing 4/8/12/16/24/32/48, radii 8/14/20). All text uses Dynamic Type styles; numbers use monospaced digits.
- **States:** The screen has no lists, so there are no empty or loading placeholders. The states that exist are the sync states (all synced, syncing, offline with calls queued, retrying, failed, setup needed), shown as a badge in the toolbar and explained, with a Retry action, in a bottom sheet.
- **Motion and feedback:** One spring for state changes, with a quick fade instead when Reduce Motion is on. Haptics use SwiftUI's native `sensoryFeedback`.
- **No Lookups:** Do not build search bars or historical list views.

## 4. Dependent Vehicle Selectors
Vehicle Make and Model must utilize a dependent dictionary to save time. 
- Example: If the user taps "Tesla" for `vehicle_make`, the `vehicle_model` chips must instantly filter to only display "Model 3", "Model Y", "Model S", "Model X", "Cybertruck".
- Implement a basic hardcoded JSON dictionary of the 15 most common vehicle makes and their top models to power this logic.

## 5. Input Fields & Options
Use these EXACT string values for the selection chips:
- `caller_type`: [Private Cash, Insurance / Motor Club, Commercial Fleet, Body Shop]
- `payer_name`: [Cash / Customer, Triple A (AAA), Agero, Geico, Allstate, State Farm, Swoop, Urgently, Other]
- `service_requested`: [Standard Tow, Flatbed / Specialty, Jump Start, Tire Change, Tire Patch, Lockout, Winch Out Only, Winch Out + Tow]
- `drivetrain`: [FWD, RWD, AWD / 4WD, Electric Vehicle (EV), Hybrid, Unknown]
- `vehicle_condition`: [Rolling / Neutral, Locked in Park, No Keys, Flat Tire, Ditch / Mud / Winch, Collision, Wheel Damaged, Mechanical / Electrical Issue]
- `scene_location`: [Residential Driveway, Public Surface Street, Highway / Freeway Shoulder, Underground Parking Structure, Commercial Lot]

**Not captured in the app (removed on purpose):**
- `lead_source`: attribution is automated. CallRail fills it, and the Phase 3 AI worker fills it only if it is still blank.
- `urgency_level`: retired from the schema entirely. `Caller_Tone` (from the audio) and `scene_location` already carry that signal.

The app must not show, store or POST either field.

## 5b. Required Fields
- `customer_phone` is **mandatory**: at least 10 digits, ignoring formatting (dashes, spaces, parentheses, a leading `+1`). The phone number is how CallRail data is merged into the call, so a call without one can't be saved. The "Save Call" button stays disabled and dimmed, and says what is missing, until the phone has 10 digits and an outcome is chosen.
- The Apps Script enforces the same rule and answers `BAD_REQUEST` ("customer_phone is required and must be at least 10 digits.") for an app sync that breaks it.

## 5c. Address Search and Trip Mileage (display only)
- **Autocomplete:** the Pickup and Dropoff fields show suggestions as the dispatcher types (Apple `MKLocalSearchCompleter`, address results, biased to California and filtered to California). Tapping one fills the field with the full resolved address and confirms its coordinate. Editing the text afterward drops the confirmation.
- **"Use as typed":** the last row of the list keeps the text exactly as written (highway mile markers, cross streets, unnumbered spots). Such an address has no mileage; the Trip Mileage card says "Manual address — mileage unavailable". Saving is never blocked.
- **Trip Mileage card** (under Location): once both addresses are confirmed it shows three Apple Maps driving legs, rounded to 0.1 mile: **To Pickup** (yard to pickup), **Loaded** (pickup to dropoff) and **To Yard** (dropoff to yard), plus a **Total Miles** callout (the sum of the three rounded legs). It shows a loading state, and per-leg dashes with a "Try again" button if a route fails or there is no connection.
- **The yard** defaults to Rio Linda, CA. Optional `YARD_ADDRESS`, `YARD_LAT` and `YARD_LON` keys in `Secrets.plist` override it (the point must be in California).
- **Nothing here is synced.** The payload, `SCHEMA.md` and the sheet are unchanged. The sheet keeps computing its own `Loaded_Miles` and `Deadhead_Est_Miles` from the address text (Google Maps), so the phone's numbers are an estimate for quoting and can differ slightly. The full resolved address in the existing field helps that geocoding.
- **Offline:** search and routing need a connection. Without one the fields behave as plain text and the card says it can't reach Maps.

## 6. The ML Target Variable
- `outcome`: This must be a MASSIVE visual toggle button at the bottom: [1 - Won / Booked] or [0 - Lost / Declined].
- `decline_reason`: ONLY show this chip grid if the Outcome is "0 - Lost". Options: [Price Too High, ETA Too Long, Already Found Help, Changed Mind].