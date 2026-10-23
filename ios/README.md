# OptiTow iOS Dispatcher App

This is an offline-first data pusher (SwiftUI, SwiftData, Swift 6, iOS 17+). It captures one call per form and queues it locally. Whenever the network is available, it POSTs the queued calls to the Apps Script webhook. It never reads past data.

## Setup

1. Open `OptiTow.xcodeproj` in Xcode 16 or later.
2. Copy `Secrets.example.plist` to `OptiTow/Config/Secrets.plist` (this path is git-ignored) and fill in two values:
   - `WEBHOOK_URL`: the Apps Script `/exec` URL. It must be `https`.
   - `API_SECRET`: the same value as the Apps Script `API_SECRET` script property.
3. Under **Signing & Capabilities**, select your team. The bundle ID is `com.optitow.dispatcher`; change it if needed.
4. Run on a device or the Simulator.

**Without `Secrets.plist`:** the app still saves calls. The toolbar badge shows a setup error, and the queue drains once the file is added and the app is rebuilt.

The project uses a synchronized folder: any file added under `OptiTow/` joins the target automatically.

### Testing sync locally (no Google deployment)

`tests/mock-webhook.js` runs the real `apps-script/Code.gs` against an in-memory sheet. Debug builds accept a plain `http` URL, but only for localhost.

1. Start the mock server from the repo root:

   ```bash
   node tests/mock-webhook.js
   ```

2. In `Secrets.plist`, set `WEBHOOK_URL` to `http://127.0.0.1:8787/exec` and `API_SECRET` to `test-api-secret`.
3. Run the app in the Simulator.

Endpoints for checking results and simulating failures:

| Command | Effect |
|---|---|
| `curl localhost:8787/rows` | Shows the rows the sheet would contain |
| `curl -X POST localhost:8787/__mode/busy` | The server answers `BUSY` |
| `curl -X POST localhost:8787/__mode/fault` | The server answers `INTERNAL` (a call that keeps failing is parked after 6 tries) |
| `curl -X POST localhost:8787/__mode/down` | The server drops connections |
| `curl -X POST localhost:8787/__mode/ok` | Back to normal |

## Layout

```
OptiTow/
  App/OptiTowApp.swift          entry point, ModelContainer, foreground → drain
  Models/CallRecord.swift       SwiftData model + SyncPayload (exact SCHEMA.md keys)
  Models/CallDraft.swift        form state for the call on the line
  Sync/SyncManager.swift        NWPathMonitor + queue drain + retry backoff + parking
  Models/LocalStore.swift       opens the SwiftData store; sets a store that won't open aside and starts a clean one
  Sync/WebhookClient.swift      POST + response classification
  Sync/CustomerLocationService.swift  asks a customer to share their location and polls for it
  Config/AppConfig.swift        reads Secrets.plist
  Catalog/ChipOptions.swift     exact chip strings (mirror Code.gs ENUMS)
  Catalog/VehicleCatalog.swift  make → models lookup
  Resources/vehicles.json       15 makes and their top models
  Views/DispatchFormView.swift  the only screen
  Views/MileageCalculatorView.swift  standalone Quick Mileage sheet
  Views/AddressSearchSheet.swift     the address search and suggestions sheet
  Views/Components/             chips, outcome toggle, address field, trip mileage card, route map card, theme
  Maps/AddressSearch.swift      California address suggestions (MKLocalSearchCompleter)
  Maps/TripRouter.swift         yard -> pickup -> dropoff -> yard driving legs (MKDirections)
  Maps/TripMileage.swift        miles math, leg totals, failure types
  Config/YardLocation.swift     the yard (default Rio Linda, CA) and California bounds
```

## Sync rules

- **Saving:** a save writes the call to SwiftData with `isSynced = false`, then starts a drain.
- **When the queue drains:** when the network comes up, when the app returns to the foreground, after each save, and on a backoff timer after a temporary failure.
- **Order:** records go one at a time, oldest first. A record is marked `isSynced = true` only when the response body has `"ok": true`. Apps Script returns HTTP 200 even for errors.

How each failure is handled:

| Server code | What the app does |
|---|---|
| `BUSY`, network failure | Retries with backoff: 15 s, doubling, up to 5 min, with no limit |
| `INTERNAL`, or a code the app does not know | The same backoff, but only up to 6 failures in a row: then the call is **parked** (kept on the phone, out of the queue), the calls behind it carry on, and the sync sheet shows "Parked: needs attention" with a **Retry Parked Calls** button |
| `UNAUTHORIZED`, `SERVER_MISCONFIGURED`, non-JSON reply | Stops draining and shows the error; resumes on the next trigger |
| `BAD_REQUEST` | Marks the record `isRejected` and keeps the rest of the queue moving |

- **Retries are safe:** each form gets a UUID `call_id` when it opens, so resending a call updates its existing row instead of adding one.

## UI rules applied

- **No picker wheels or dropdowns:** every choice is a large chip in a `LazyVGrid`, and tapping a selected chip clears it.
- **Vehicle chips:** the make and model chips depend on each other. Choosing Tesla shows only Model 3, Y, S, X and Cybertruck. An **Other** chip reveals a free-text field.
- **Outcome toggle:** a large Won/Lost toggle sits at the bottom of the form. Decline reasons appear only when the call is Lost. A call can't be saved until Won or Lost is picked.
- **Light and dark:** the app follows the system appearance. Colors are semantic tokens in `Theme.swift`, so both modes come from one set of definitions.
- **No history:** there are no search bars or history lists. The toolbar badge shows the sync state (all synced, syncing, offline with calls queued, retrying, failed, or setup needed). Tapping it opens a sheet that explains the state and offers **Retry Sync**, and **Retry Parked Calls** when a call has been parked.
- **Address search and trip mileage:** Pickup and Dropoff are static rows that open an Address Search sheet with California address suggestions; tapping one confirms the address and its coordinate, and "Use as typed" keeps free text. With both confirmed, a Trip Mileage card shows the three driving legs (yard to pickup, loaded, back to the yard) and a total from Apple Maps, and a Route Map card under it draws those legs (dashed orange to pickup, solid green loaded, dashed blue return). This is display only: nothing about it is saved or synced, and without a connection the fields stay plain text. Set a different yard with optional `YARD_ADDRESS`, `YARD_LAT` and `YARD_LON` keys in `Secrets.plist`.
- **Start Location:** a static row like Pickup and Dropoff. A confirmed address replaces the configured yard as the route's origin and return point; empty or manual falls back to the yard.
- **Ask for Location:** with a valid phone, a button texts the customer a link (system Messages sheet; a copy/share fallback where texting is unavailable). The app then polls the Apps Script (`?source=location`) every 3 seconds for up to 5 minutes and fills the Pickup row with the customer's shared position. Needs the updated `Code.gs` deployed (see `apps-script/README.md`).
- **Save button:** it appears under the Outcome card only once the call can be saved (10-digit phone and an outcome). There is no pinned bottom bar.
- **Soft style:** the palette button in the toolbar toggles a neumorphic theme (`AppTheme`, stored under the `app_theme` key and read through `\.appTheme`). The modifiers `softCard`, `softButton` and `softFieldRow` in `Views/Components/SoftUI.swift` draw the standard or the soft surface from the same view structure, so a switch never resets the form.
- **Landmark / Clue search:** the address sheet has a "Standard Address / Landmark / Clue" picker. Landmark mode runs a natural-language Apple Maps search (California only, up to six matches with address and distance from the yard) when you press Search, for places described by a business or a cross street rather than an address.
- **Live-traffic ETA:** a badge under the Pickup row shows the driving time from the yard (or the Start Location) to the pickup with current traffic, as soon as the pickup is confirmed; the Route Map card also shows it next to the leg's miles. Uses `MKDirections` with `departureDate = now`. Display only.
- **Quick Mileage:** the toolbar map button opens a standalone mileage calculator in a sheet, separate from the call in progress.
- **Private Cash shortcut:** choosing **Private Cash** fills the payer with **Cash / Customer** if no payer is set yet.

## Known limits

- **Background sync:** queued calls sync while the app is open, or briefly after it's backgrounded mid-sync. A fully background refresh (`BGTaskScheduler`) is not set up yet.
- **The secret is in the app bundle:** `API_SECRET` ships inside the app and can be pulled out of an IPA. That's acceptable for an internal, ad-hoc-distributed build. Rotate the secret if a device is lost.
