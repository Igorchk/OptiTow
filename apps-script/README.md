# OptiTow Middleware (Google Apps Script)

`Code.gs` is the single web-app endpoint between the iOS app, CallRail, the website form, the Mac Mini AI worker and the Google Sheet.

## Deploy

1. Open the Google Sheet → **Extensions → Apps Script**. Paste `Code.gs`, then enable **Show "appsscript.json"** under Project Settings and paste `appsscript.json`.
2. **Project Settings → Script Properties**, add:
   - `API_SECRET`: a long random string, used by the iOS app, CallRail and the AI worker.
   - `WEBSITE_SECRET`: a *different* random string. It is visible in public page code and can only create website leads.
3. Select `setup` in the editor and **Run** it (authorize when prompted). It does the following:
   - Sets the spreadsheet time zone to `America/Los_Angeles`.
   - Writes the 29 headers if the Call Log is empty, or checks them if it isn't. Columns are found by header name, so a sheet in an older order still works as long as every header exists.
   - Freezes the header row and applies column formats.
   - Rewrites the **Reference Data** tab from `ENUMS`, adding `Website Form`.
4. **Deploy → New deployment → Web app**, with *Execute as: Me* and *Who has access: Anyone*. Copy the `/exec` URL.
5. Check the deployment: opening the URL in a browser should return `{"ok":true,"service":"optitow-middleware"}`.

To update the code later, use **Deploy → Manage deployments → Edit → New version**. This keeps the same URL.

Run the tests locally with `npm test` from the repo root. They use in-memory mocks of the Apps Script services.

## Response contract (all sources)

Apps Script always answers **HTTP 200**, even when a request fails, so clients must read the JSON body. It also answers through a 302 redirect; follow it.

```json
{ "ok": true,  "action": "created|updated|merged", "call_id": "…", "row": 42, "warnings": [] }
{ "ok": false, "code": "UNAUTHORIZED", "error": "Invalid token." }
```

| `code` | Meaning | Client should |
|---|---|---|
| `BUSY` | Lock timeout | Retry later |
| `INTERNAL` | Unexpected error | Retry later |
| `UNAUTHORIZED`, `BAD_REQUEST`, `NOT_FOUND` | Request will never succeed as sent | Stop retrying and surface the error |
| `SERVER_MISCONFIGURED` | Missing secret or tab | Fix the deployment, then retry |

`warnings` lists data that was stored anyway but looks wrong, such as an unknown chip value or a failed Maps route. Dispatcher data is never dropped.

## Sources

### iOS app: `POST <exec-url>`
The body follows the payload in `SCHEMA.md`, with `token` set to `API_SECRET`. `call_id` is required.

`lead_source` and `urgency_level` are not part of the app payload. If an older build still sends them, they are ignored. `Lead_Source` is filled automatically (see CallRail and AI worker below), and `Urgency_Level` no longer exists.

- **Upsert:** if a row with that `call_id` already exists, it is updated. Offline-queue retries are safe.
- **Claiming a CallRail or website row:** otherwise, if there is a row that meets all of these, the app's fields are written into it and its `Call_ID` becomes the app's UUID:
  - same phone number,
  - `Date_Time` within ±60 min,
  - no `Outcome` yet.

  CallRail and AI columns are kept.
- **Outcome rule:** when `outcome` is `1 - Won / Booked`, `Decline_Reason` is forced to `N/A - Won`.
- **Mileage:** `Deadhead_Est_Miles` is the drive from the Rio Linda, CA yard to `pickup_address`. `Loaded_Miles` is pickup to dropoff. Both use Google Maps driving routes and are cached for 6 hours.
- **The app must mark `isSynced = true` only when the body has `"ok": true`.**

### CallRail: `POST <exec-url>?source=callrail&token=<API_SECRET>`
Configure this as the **post-call webhook**. It accepts both the v3 JSON body and legacy form-encoded fields.

| CallRail field | Column |
|---|---|
| `keywords` / `utm_term` | `Search_Keyword` |
| `campaign` / `utm_campaign` | `Campaign_Name` |
| `duration` | `Call_Duration_Sec` |
| `recording` / `recording_player` | `Call_Recording_URL` |
| `source` + `medium` (or `source_name` / `utm_medium`) | `Lead_Source`, mapped as below |

**Lead source mapping.** The source and medium text is lowercased and the first matching rule wins:

| If it contains | `Lead_Source` |
|---|---|
| `google ads`, `adwords`, `ppc`, `cpc`, `google paid` | `Google Ads` |
| `google organic`, `google my business`, `google business profile`, `google maps`, `gmb`, `maps` | `Google Maps / Organic` |
| `motor club`, `auto club` | `Motor Club Referral` |
| `direct`, `organic search`, `referral` | `Repeat / Direct` |
| `website form` | `Website Form` |
| anything else | `Other` |

- **Order:** the rules run in the order shown. This is why "Motor Club Referral" maps to `Motor Club Referral` and not to the generic `referral` rule.
- **`cpc` is an addition:** the `cpc` and `google paid` terms are included because that is how CallRail and Google label paid clicks. `ppc` also catches non-Google paid traffic (e.g. Bing).
- **No source at all:** `Lead_Source` is left blank, so the AI worker can fill it.
- **Never overwritten:** CallRail only fills `Lead_Source` when it is blank. A website lead that then phones in keeps `Website Form`.

1. **Retries:** CallRail retries webhooks. A webhook whose recording URL is already in the sheet updates that row instead of adding one.
2. **Merge:** otherwise the webhook goes into the row that meets all of these, picking the one closest in time:
   - same phone number (matched on the last 10 digits),
   - `Date_Time` within ±60 min of the call's `start_time`,
   - no CallRail data yet.

   Only the four CallRail columns and a blank `Lead_Source` are written.
3. **New row:** if nothing matches, a new row is created with a generated UUID, `Date_Time` and phone filled in, and the dispatcher columns left blank.

### Website form: `POST <exec-url>?source=website`
- **Auth:** `token` set to `WEBSITE_SECRET`, sent in the body or the query string.
- **Body:** JSON or form-encoded, using the `SCHEMA.md` keys. `phone` is also accepted as an alias for `customer_phone`.
- **Defaults:** `Lead_Source` is always set to `Website Form` and `call_id` is generated.
- **Other fields:** any other fields (name, email, message, etc.) are appended to `Notes_Comments`.
- **Browser `fetch`:** send `Content-Type: text/plain` (with a JSON string body) or form-encoded data. `application/json` triggers a CORS preflight that Apps Script can't answer.

### AI worker: `POST <exec-url>?source=ai`
List rows that have a recording but no `AI_Processed_At` yet:
```json
{ "token": "…", "action": "pending", "limit": 25 }
→ { "ok": true, "count": 1, "items": [{ "call_id", "date_time", "customer_phone", "call_duration_sec", "call_recording_url", "lead_source", "caller_tone", "mentioned_damage" }] }
```
Write results:
```json
{ "token": "…", "action": "update", "call_id": "…", "call_recording_url": "…",
  "caller_tone": "Stressed", "mentioned_damage": ["front bumper"], "lead_source": "Repeat / Direct" }
```
- **Columns written:** only `Caller_Tone`, `Mentioned_Damage`, `Lead_Source` and `AI_Processed_At` (set to server time). Any other keys are ignored. Arrays for `mentioned_damage` are stored comma-joined.
- **At least one of `caller_tone`, `mentioned_damage`, `lead_source` or `"mark_processed": true` is required.** `mark_processed` only sets `AI_Processed_At`. It retires a row whose AI cells were all filled by hand.
- **Fill-only-if-blank.** Each of the three cells is written only if it is currently empty (an existing value is ignored and reported in `warnings`). The `pending` items carry the current `caller_tone`, `mentioned_damage` and `lead_source`, so a worker only asks the model for the blanks. To re-run a row, clear those cells first.
- **Picklists.** `caller_tone` must be one of `Calm`, `Stressed`, `Frustrated`, `Angry`, `Confused`, `Rushed`, `Price Shopping`, `Cooperative`. `lead_source` must be one of the six `Lead_Source` values. Anything else is ignored with a warning, and the request still succeeds.
- **Send `call_recording_url` too.** If the iOS app claims a CallRail row while the worker is processing it, that row's `call_id` changes, and the recording URL is how the update still finds it.

CallRail's v3 `recording` URL is an API endpoint that needs a CallRail API key. Phase 3 will fetch audio with that key.
