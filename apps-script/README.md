# OptiTow Middleware (Google Apps Script)

`Code.gs` is the single web-app endpoint between the iOS app, CallRail, the website form, the Mac Mini AI worker and the Google Sheet. It also serves the page customers open to share their location.

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

`customer_phone` is required and must contain at least 10 digits (formatting is ignored). Otherwise the sync is rejected with `{"ok": false, "code": "BAD_REQUEST", "error": "customer_phone is required and must be at least 10 digits."}` and no row is created. The iOS app never retries a `BAD_REQUEST` and parks the call as rejected. The rule applies to app syncs only, not to website leads or CallRail.

`Date_Time` and `AI_Processed_At` are written as whole seconds (any milliseconds are dropped) and formatted `yyyy-mm-dd hh:mm:ss` on every write.

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
| `source` + `medium` (or `utm_medium`) | `Lead_Source`, mapped as below (`source_name` is the tracking number's label, so it is not used) |

**Junk calls (no conversation).** A call is closed at ingestion, with no audio download or AI analysis, when:
- CallRail says `answered` is false (unless it is a voicemail, which can hold a real customer message and is judged later), or
- there is less than **15 seconds** of talk, measured by `recording_duration` if CallRail sent it and by `duration` otherwise (`duration` can include ringing, and CallRail has no talk-time field).

Such a row gets `Caller_Tone = N/A`, `Mentioned_Damage = N/A` and `AI_Processed_At`, so the worker never sees it. `Lead_Source`, the campaign and the rest of the CallRail data are still recorded. A row the dispatcher already logged an outcome for is never marked, because a conversation clearly happened. The webhook response carries `ai_skipped` with the reason, and the Executions log line shows `not_live`. The threshold is `CONFIG.MIN_LIVE_CALL_SEC`, and a contract test keeps it equal to the worker's.

**Search keyword.** CallRail's `keywords` field holds what the visitor searched for. It is only populated for **paid ad** calls on **Website (Session) trackers**, so `Search_Keyword` is legitimately empty for Google My Business, Performance Max, organic and direct calls. The parser reads `keywords`, then falls back to `utm_term` and the older `search_keywords`. It skips empty values and ad-template placeholders that were never filled in (`{keyword}`, `(not set)`), and it never writes a blank over an existing keyword. `keywords_spotted` is words detected in the call audio and is deliberately not used. Each webhook writes one line to the Executions log with the payload's key names, `source`, `medium` and which keyword field was used (never the keyword text or the phone number), so you can audit what CallRail actually sent.

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
- **Picklists.** `caller_tone` must be one of `Calm`, `Stressed`, `Frustrated`, `Angry`, `Confused`, `Rushed`, `Price Shopping`, `Cooperative`, `N/A`. `lead_source` must be one of the six `Lead_Source` values. Anything else is ignored with a warning, and the request still succeeds.
- **Send `call_recording_url` too.** If the iOS app claims a CallRail row while the worker is processing it, that row's `call_id` changes, and the recording URL is how the update still finds it.

CallRail's v3 `recording` URL is an API endpoint that needs a CallRail API key. Phase 3 will fetch audio with that key.

### Customer location sharing: `?source=location` and `GET <exec-url>?loc=<token>`

Lets the dispatcher text a customer a link, and fills the Pickup address from the position the customer shares. Nothing is written to the sheet: everything lives in the script cache for **15 minutes**, then disappears.

1. The app picks a random 12-character link token and registers it: `POST ?source=location` with `{ "token": "<API_SECRET>", "action": "request_location", "loc": "<token>" }`.
2. The customer opens `<exec-url>?loc=<token>` (a mobile page titled Recovery Towing). Tapping **Share My Exact Location** asks the browser for the position and posts it back: `POST ?source=location` with form fields `action=submit_location&loc=<token>&lat=<lat>&lng=<lng>`. The server reverse-geocodes it (Maps) and stores `{ status: "ready", address, lat, lng }`.
3. The app polls `{ "token": "<API_SECRET>", "action": "check_location", "loc": "<token>" }` every 3 seconds for up to 5 minutes. The reply is `{ "ok": true, "status": "pending" }` or `{ "ok": true, "status": "ready", "address", "lat", "lng" }`. An unknown or expired token also reads as `pending`.

**Why `loc`, not `token`:** `token` is the API secret in every request, so the link token has its own field.

**Safeguards (the customer's page has no secret):**
- `request_location` and `check_location` require the API secret. The website secret does not work, so a location can only be read by the app.
- `submit_location` is the only public call. It is accepted only for a token the app registered and that has not expired (otherwise `NOT_FOUND`), so strangers cannot create cache entries or spend the Maps quota. It returns nothing about the position, and the **first** position wins.
- Link tokens must be 8 to 32 lowercase letters or digits; coordinates must be numbers within range. The token is put in the page only after it passes that check.
- If Maps has no street address for the spot, `address` is empty and the app shows the coordinates.

**Deploying:** pasting the new `Code.gs` is not enough. Use **Deploy → Manage deployments → Edit → New version**, or the old code keeps answering (the app then says the Apps Script has not been updated for location sharing).

**Check before relying on it:** the landing page runs inside Apps Script's HtmlService frame. Some browsers or in-app webviews block `navigator.geolocation` there. The page then shows "Unable to detect location. Please tell your dispatcher your nearest cross street." and offers Try Again. Send yourself a link and tap it on a real phone before using it on a customer. If a browser blocks it, the page can be hosted elsewhere and still post to this same endpoint.
