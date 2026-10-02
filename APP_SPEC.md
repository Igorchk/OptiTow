# iOS App UI/UX & Feature Specifications

## 1. Core Mandate
This app is a "dumb, offline-first data pusher" for dispatchers. It does NOT do machine learning. It does NOT read past data. It only captures inputs and POSTs to a webhook.

## 2. Sync Architecture (`SyncManager.swift`)
- **Offline-First:** All saves immediately write to SwiftData with `isSynced = false`.
- **Auto-Drain:** Use `NWPathMonitor`. Whenever an active network is detected, silently drain the queue by POSTing to the webhook. Mark `isSynced = true` upon a 200 OK response.

## 3. UI/UX Rules (CRITICAL)
- **One-Handed Dispatch:** The user is on the phone. Do NOT use native iOS scrolling picker wheels or tiny native dropdowns. 
- **Chip Grids:** Use large, high-contrast wrap-around button grids (`LazyVGrid`) for 1-tap selections.
- **Dark Mode:** Enforce an optimized dark theme.
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

## 6. The ML Target Variable
- `outcome`: This must be a MASSIVE visual toggle button at the bottom: [1 - Won / Booked] or [0 - Lost / Declined].
- `decline_reason`: ONLY show this chip grid if the Outcome is "0 - Lost". Options: [Price Too High, ETA Too Long, Already Found Help, Changed Mind].