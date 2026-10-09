# OptiTow iOS Dispatcher App

This is an offline-first data pusher (SwiftUI, SwiftData, Swift 6, iOS 17+). It captures one call per form and queues it locally. Whenever the network is available, it POSTs the queued calls to the Apps Script webhook. It never reads past data.

## Setup

1. Open `OptiTow.xcodeproj` in Xcode 16 or later.
2. Copy `Secrets.example.plist` to `OptiTow/Config/Secrets.plist` (this path is git-ignored) and fill in two values:
   - `WEBHOOK_URL`: the Apps Script `/exec` URL. It must be `https`.
   - `API_SECRET`: the same value as the Apps Script `API_SECRET` script property.
3. Under **Signing & Capabilities**, select your team. The bundle ID is `com.optitow.dispatcher`; change it if needed.
4. Run on a device or the Simulator.

**Without `Secrets.plist`:** the app still saves calls. The sync pill shows a setup error, and the queue drains once the file is added and the app is rebuilt.

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
| `curl -X POST localhost:8787/__mode/down` | The server drops connections |
| `curl -X POST localhost:8787/__mode/ok` | Back to normal |

## Layout

```
OptiTow/
  App/OptiTowApp.swift          entry point, ModelContainer, foreground → drain
  Models/CallRecord.swift       SwiftData model + SyncPayload (exact SCHEMA.md keys)
  Models/CallDraft.swift        form state for the call on the line
  Sync/SyncManager.swift        NWPathMonitor + queue drain + retry backoff
  Sync/WebhookClient.swift      POST + response classification
  Config/AppConfig.swift        reads Secrets.plist
  Catalog/ChipOptions.swift     exact chip strings (mirror Code.gs ENUMS)
  Catalog/VehicleCatalog.swift  make → models lookup
  Resources/vehicles.json       15 makes and their top models
  Views/DispatchFormView.swift  the only screen
  Views/Components/             chip grids, outcome toggle, sync pill, theme
```

## Sync rules

- **Saving:** a save writes the call to SwiftData with `isSynced = false`, then starts a drain.
- **When the queue drains:** when the network comes up, when the app returns to the foreground, after each save, and on a backoff timer after a temporary failure.
- **Order:** records go one at a time, oldest first. A record is marked `isSynced = true` only when the response body has `"ok": true`. Apps Script returns HTTP 200 even for errors.

How each failure is handled:

| Server code | What the app does |
|---|---|
| `BUSY`, `INTERNAL`, network failure | Retries with backoff: 15 s, doubling, up to 5 min |
| `UNAUTHORIZED`, `SERVER_MISCONFIGURED`, non-JSON reply | Stops draining and shows the error; resumes on the next trigger |
| `BAD_REQUEST` | Marks the record `isRejected` and keeps the rest of the queue moving |

- **Retries are safe:** each form gets a UUID `call_id` when it opens, so resending a call updates its existing row instead of adding one.

## UI rules applied

- **No picker wheels or dropdowns:** every choice is a large chip in a `LazyVGrid`, and tapping a selected chip clears it.
- **Vehicle chips:** the make and model chips depend on each other. Choosing Tesla shows only Model 3, Y, S, X and Cybertruck. An **Other** chip reveals a free-text field.
- **Outcome toggle:** a large Won/Lost toggle sits at the bottom of the form. Decline reasons appear only when the call is Lost. A call can't be saved until Won or Lost is picked.
- **Light and dark:** the app follows the system appearance. Colors are semantic tokens in `Theme.swift`, so both modes come from one set of definitions.
- **No history:** there are no search bars or history lists. The toolbar badge shows the sync state (all synced, syncing, offline with calls queued, retrying, failed, or setup needed). Tapping it opens a sheet that explains the state and offers **Retry Sync**.
- **Private Cash shortcut:** choosing **Private Cash** fills the payer with **Cash / Customer** if no payer is set yet.

## Known limits

- **Background sync:** queued calls sync while the app is open, or briefly after it's backgrounded mid-sync. A fully background refresh (`BGTaskScheduler`) is not set up yet.
- **The secret is in the app bundle:** `API_SECRET` ships inside the app and can be pulled out of an IPA. That's acceptable for an internal, ad-hoc-distributed build. Rotate the secret if a device is lost.
