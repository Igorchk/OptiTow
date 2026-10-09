# The Central Data Schema (Google Sheets & JSON)

The Google Sheet consists of exactly 31 columns. Do not deviate from these keys in the Apps Script or the iOS SwiftData models. 

## The JSON Payload (from iOS to Apps Script)
When the iOS app syncs, it must POST this exact `snake_case` structure:
```json
{
  "token": "YOUR_API_SECRET",
  "call_id": "UUID_STRING",
  "date_time": "2026-10-02T14:32:00Z",
  "customer_phone": "916-555-0199",
  "caller_type": "Private Cash",
  "payer_name": "Cash / Customer",
  "service_requested": "Standard Tow",
  "vehicle_year": "2021",
  "vehicle_make": "Tesla",
  "vehicle_model": "Model 3",
  "drivetrain": "Electric Vehicle (EV)",
  "vehicle_condition": "No Keys",
  "scene_location": "Highway / Freeway Shoulder",
  "start_location": "I-80 Eastbound",
  "pickup_address": "I-80 & Madison Ave, Sacramento",
  "dropoff_address": "123 Auto Body Way",
  "quoted_price": 285.00,
  "outcome": "1 - Won / Booked",
  "decline_reason": "",
  "notes_comments": "Customer stuck on shoulder."
}
```

## Field rules
- `customer_phone` is required in the iOS payload: at least 10 digits once formatting is stripped. A sync without it is rejected with `BAD_REQUEST`. It is stored as `916-555-0199`.
- `date_time` and `AI_Processed_At` are stored as whole seconds (no milliseconds) and displayed as `yyyy-mm-dd hh:mm:ss` in the sheet's time zone (Pacific), e.g. `2026-10-02 08:56:04`.

## Column layout (31 columns)
Columns 1–21 are the dispatcher block. Everything after is automated ingestion, so a dispatcher write can never land on an automated column.

| # | Columns | Written by |
|---|---|---|
| 1–21 | `Call_ID`, `Date_Time`, `Customer_Phone`, `Caller_Type`, `Payer_Name`, `Service_Requested`, `Vehicle_Year`, `Vehicle_Make`, `Vehicle_Model`, `Drivetrain`, `Vehicle_Condition`, `Scene_Location`, `Start_Location`, `Pickup_Address`, `Dropoff_Address`, `Loaded_Miles`, `Deadhead_Est_Miles`, `Quoted_Price`, `Outcome`, `Decline_Reason`, `Notes_Comments` | iOS app (and website form). The Apps Script computes `Loaded_Miles` and `Deadhead_Est_Miles` itself. |
| 22 | `Lead_Source` | CallRail attribution; the Phase 3 AI fills it only if still blank. Website leads are tagged `Website Form`. |
| 23–26 | `Search_Keyword`, `Campaign_Name`, `Call_Duration_Sec`, `Call_Recording_URL` | CallRail webhook |
| 27–31 | `Caller_Tone`, `Mentioned_Damage`, `AI_Processed_At`, `Call_Intent`, `Admin_Summary` | Phase 3 Mac Mini AI worker (`worker/`). Fill-only-if-blank: it never overwrites an existing value. |

`Call_Intent` picklist: `NEW_LEAD`, `STATUS_CHECK`, `ADMIN_INQUIRY`. **Only `NEW_LEAD` rows are sales opportunities: filter on `Call_Intent = NEW_LEAD` for conversion and pricing analysis.**
- `NEW_LEAD`: a driver, adjuster, motor club, shop or fleet asking for a tow, a price or availability, or booking a job.
- `STATUS_CHECK`: asking about a tow that is already booked, under way or done (was it delivered, driver ETA, paperwork signed, closing a claim or PO).
- `ADMIN_INQUIRY`: lot or gate hours, storage fees, release requirements, general vendor calls.
- **Blank** means not classified: rows from before this column existed, and calls that were never a conversation (unanswered, dropped, automated), which already carry `N/A` in `Caller_Tone`.

For `STATUS_CHECK` and `ADMIN_INQUIRY`, `Caller_Tone` and `Mentioned_Damage` are `N/A` (they are not sales calls), `Lead_Source` is left as CallRail set it (never guessed), and `Admin_Summary` holds one sentence about the call, e.g. "Adjuster checking delivery status on 2019 Civic at Copart." `Admin_Summary` is blank for `NEW_LEAD`. A sheet created before these two columns gets them appended to its header row automatically the first time the new Apps Script runs.

`Caller_Tone` picklist: `Calm`, `Stressed`, `Frustrated`, `Angry`, `Confused`, `Rushed`, `Price Shopping`, `Cooperative`, `N/A`. **`N/A` in `Caller_Tone` and `Mentioned_Damage` marks a call with no genuine two-way conversation** (unanswered, dropped, or a recording of an automated system). Those rows have `AI_Processed_At` set and are not analyzed. Filter on it when building a dataset. It is different from `Mentioned_Damage = None`, which is a real call where no damage was mentioned. `Mentioned_Damage` is free text (short phrases, comma-separated) or `None`.

`Lead_Source` picklist: `Google Ads`, `Google Maps / Organic`, `Repeat / Direct`, `Motor Club Referral`, `Website Form`, `Other`.

## Retired and removed fields
- `urgency_level` / `Urgency_Level` is **deleted from the schema**. It was subjective dispatcher input that added no signal beyond `Caller_Tone` (distress and rushed state, from the audio) and `Scene_Location`.
- `lead_source` is not part of the iOS payload. The app never sends it, and the Apps Script ignores it if an older build does.
