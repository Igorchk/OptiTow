# The Central Data Schema (Google Sheets & JSON)

The Google Sheet consists of exactly 29 columns. Do not deviate from these keys in the Apps Script or the iOS SwiftData models. 

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

## Column layout (29 columns)
Columns 1–21 are the dispatcher block. Everything after is automated ingestion, so a dispatcher write can never land on an automated column.

| # | Columns | Written by |
|---|---|---|
| 1–21 | `Call_ID`, `Date_Time`, `Customer_Phone`, `Caller_Type`, `Payer_Name`, `Service_Requested`, `Vehicle_Year`, `Vehicle_Make`, `Vehicle_Model`, `Drivetrain`, `Vehicle_Condition`, `Scene_Location`, `Start_Location`, `Pickup_Address`, `Dropoff_Address`, `Loaded_Miles`, `Deadhead_Est_Miles`, `Quoted_Price`, `Outcome`, `Decline_Reason`, `Notes_Comments` | iOS app (and website form). The Apps Script computes `Loaded_Miles` and `Deadhead_Est_Miles` itself. |
| 22 | `Lead_Source` | CallRail attribution; the Phase 3 AI fills it only if still blank. Website leads are tagged `Website Form`. |
| 23–26 | `Search_Keyword`, `Campaign_Name`, `Call_Duration_Sec`, `Call_Recording_URL` | CallRail webhook |
| 27–29 | `Caller_Tone`, `Mentioned_Damage`, `AI_Processed_At` | Phase 3 Mac Mini AI worker (`worker/`). Fill-only-if-blank: it never overwrites an existing value. |

`Caller_Tone` picklist: `Calm`, `Stressed`, `Frustrated`, `Angry`, `Confused`, `Rushed`, `Price Shopping`, `Cooperative`. `Mentioned_Damage` is free text (short phrases, comma-separated) or `None`.

`Lead_Source` picklist: `Google Ads`, `Google Maps / Organic`, `Repeat / Direct`, `Motor Club Referral`, `Website Form`, `Other`.

## Retired and removed fields
- `urgency_level` / `Urgency_Level` is **deleted from the schema**. It was subjective dispatcher input that added no signal beyond `Caller_Tone` (distress and rushed state, from the audio) and `Scene_Location`.
- `lead_source` is not part of the iOS payload. The app never sends it, and the Apps Script ignores it if an older build does.
