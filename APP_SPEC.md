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
- **States:** The screen has no lists, so there are no empty or loading placeholders. The states that exist are the sync states (all synced, syncing, offline with calls queued, retrying, failed, setup needed, and "needs attention" for a call the app parked after repeated server errors), shown as a badge in the toolbar and explained, with a Retry action, in a bottom sheet. If the local call store cannot be opened at launch, the app sets it aside, starts a clean one and shows a dismissible banner at the top of the form.
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
- `vehicle_condition`: [Rolling / Neutral, Locked in Park, No Keys, Flat Tire, Ditch / Mud / Winch, Collision, Wheel Damaged, Mechanical / Electrical Issue]

**Not captured in the app (removed on purpose):**
- `lead_source`: attribution is automated. CallRail fills it, and the Phase 3 AI worker fills it only if it is still blank.
- `urgency_level`: retired from the schema entirely. `Caller_Tone` (from the audio) already carries that signal.
- `drivetrain` and `scene_location`: no longer asked for in the app. The sheet keeps both columns (`Drivetrain`, `Scene_Location`) and the app still sends both keys, always as `""`, so the payload contract is unchanged. The server drops blank values, so nothing is written and nothing existing is overwritten.

The app must not show, store or POST `lead_source` or `urgency_level`.

## 5b. Required Fields
- `customer_phone` is **mandatory**: at least 10 digits, ignoring formatting (dashes, spaces, parentheses, a leading `+1`). The phone number is how CallRail data is merged into the call, so a call without one can't be saved. The "Save Call" button sits directly under the Outcome card (below WON / LOST) and does not exist until the phone has 10 digits and an outcome is chosen: there is no disabled button and no bar pinned to the bottom of the screen.
- The Apps Script enforces the same rule and answers `BAD_REQUEST` ("customer_phone is required and must be at least 10 digits.") for an app sync that breaks it.

## 5c. Address Search and Trip Mileage (display only)
- **Address rows:** Pickup and Dropoff are static rows (a search icon and "Tap to enter pickup address" when empty; the address with an X to clear it when filled). They never take the keyboard themselves. Tapping one opens a full-height **Address Search sheet**: a search field pinned at the top and focused on open, a Cancel button, and a list of up to 6 suggestions (Apple `MKLocalSearchCompleter`, address results, biased to California and filtered to California). Tapping a suggestion resolves its full address and coordinate, closes the sheet and fills the row. Dragging the list dismisses the keyboard. Inline suggestion lists were tried and dropped: a list that grows inside a scrolling form fights the keyboard and makes the screen jump.
- **"Use as typed":** the last row of the sheet's list keeps the text exactly as written (highway mile markers, cross streets, unnumbered spots). Such an address has no mileage; the Trip Mileage card says "Manual address — mileage unavailable". Saving is never blocked.
- **Trip Mileage card** (under Location): once both addresses are confirmed it shows three Apple Maps driving legs, rounded to 0.1 mile: **To Pickup** (yard to pickup), **Loaded** (pickup to dropoff) and **To Yard** (dropoff to yard), plus a **Total Miles** callout (the sum of the three rounded legs). It shows a loading state, and per-leg dashes with a "Try again" button if a route fails or there is no connection.
- **Start Location** (the yard) is the same kind of row as Pickup and Dropoff and opens the same search sheet. A confirmed address becomes where the truck leaves from and returns to, so changing it recalculates To Pickup, To Yard and the total (Loaded is unchanged). Empty, or "Use as typed", means the configured yard is used. The text still syncs in `start_location` as before; the confirmed coordinate is form-only.
- **The default yard** is Rio Linda, CA. Optional `YARD_ADDRESS`, `YARD_LAT` and `YARD_LON` keys in `Secrets.plist` override it (the point must be in California).
- **Nothing here is synced.** The payload, `SCHEMA.md` and the sheet are unchanged. The sheet keeps computing its own `Loaded_Miles` and `Deadhead_Est_Miles` from the address text (Google Maps), so the phone's numbers are an estimate for quoting and can differ slightly. The full resolved address in the existing field helps that geocoding.
- **Landmark / Clue search:** the address search sheet has a mode picker under the search bar. **Standard Address** is the as-you-type street suggestions described above. **Landmark / Clue** takes a description such as "Shell off I-80 near Rocklin" or "McDonald's near Sunrise Blvd" and runs when the dispatcher presses Search (or taps the "Search for…" row), using Apple Maps natural-language search biased to California. It shows up to six matches, each with its name, full street address and straight-line distance from the yard; tapping one confirms the address and its coordinate and closes the sheet, exactly like a standard suggestion. Results outside California are dropped, and "Use as typed" remains at the bottom in both modes.
- **Live-traffic ETA:** as soon as the pickup is a confirmed address (before any dropoff), a one-line badge under the Pickup row shows "ETA from Yard: ~22 min (live traffic)", the driving time from the yard (or "Start" for a confirmed Start Location) using Apple Maps with the departure time set to now. The badge keeps the same one-line height while it is estimating, so nothing below it moves; if Maps cannot answer it says "unavailable". The Route Map card adds "Yard → Pickup: 16.7 mi • 22 min" under its legend. Display only, never saved or synced.
- **Route Map card** (directly under Trip Mileage, and under the breakdown in Quick Mileage): appears once the pickup and dropoff are confirmed addresses and draws the three legs on an Apple Maps view: **To Pickup** as a dashed orange line, **Loaded** as a solid green line, **Return** as a dashed blue line, with Yard (or Start, when a Start Location is confirmed), Pickup and Dropoff markers and a legend below. The map is 220 pt tall, can be panned and zoomed, and refits the route whenever a stop changes. A leg that cannot be routed simply has no line. It is hidden for manual addresses and when an address is cleared. Display only, like the mileage.
- **Soft style toggle:** a palette button in the toolbar (next to Quick Mileage) switches the whole app between the standard look and a neumorphic "soft UI" look: one matte background, raised cards, chips and buttons, pressed-in fields and selected states (yellow tint for chips, green or red for Won/Lost), and light/dark shadow tokens for both appearances. The choice is stored on the device and persists across restarts. Switching is lossless: it only changes colors and shadows, so the draft, the keyboard focus, a pending location request and the scroll position are untouched. Both themes use identical layout.
- **Quick Mileage:** a map button in the toolbar opens a standalone calculator (its own Pickup and Dropoff fields and Trip Mileage card) in a sheet. It shares no state with the call being filled in, and closing it discards it.
- **Offline:** search and routing need a connection. Without one the fields behave as plain text and the card says it can't reach Maps.

## 5d. Customer Location Sharing
- **Ask for Location:** once the phone has 10 digits (and the build has a webhook configured), a secondary button with a `location.fill` icon appears under the Phone field. It registers a one-time link with the Apps Script, then opens the system Messages sheet addressed to the customer with: "Hi from Recovery Towing! Please tap this link so our driver can find your exact spot: <link>". The dispatcher taps Send. On a device that cannot text, a sheet shows the same message with Copy and Share and an "I sent it" button.
- **Waiting:** after the text is sent (not if the sheet is cancelled), a pill under the Pickup row says "Waiting for customer location…" with an X. The app checks every 3 seconds for up to 5 minutes. It then says "No location yet. Ask again or enter the address." and can be dismissed. A failure to register the link (offline, or an out-of-date Apps Script) shows a message instead of opening Messages.
- **Result:** when the customer shares, the Pickup row fills with the street address (or the coordinates if Maps has none) as a confirmed address with its coordinate, a success haptic plays, and the Trip Mileage card works as usual. Typing or choosing a Pickup address while waiting stops the wait, so a late answer never replaces it. Clear and Save also stop it.
- **Privacy:** the location is held for 15 minutes in the Apps Script cache and is never written to the sheet. Only the app, with the API secret, can read it. The link is single-use in effect: the first location submitted wins.

## 6. The ML Target Variable
- `outcome`: This must be a MASSIVE visual toggle button at the bottom: [1 - Won / Booked] or [0 - Lost / Declined].
- `decline_reason`: ONLY show this chip grid if the Outcome is "0 - Lost". Options: [Price Too High, ETA Too Long, Already Found Help, Changed Mind].