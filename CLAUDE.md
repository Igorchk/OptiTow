# Master Architecture: Towing Predictive Pricing ML Pipeline

## 1. Project Overview
We are building a data collection pipeline to train an XGBoost price elasticity model. The system relies on a native iOS dispatcher app (pushing JSON payloads) and local Apple Silicon AI for audio transcription and tone analysis.

## 2. Tech Stack & Boundaries
- **Database:** Google Sheets.
- **Middleware:** Google Apps Script Web App accepting JSON POST requests.
  - **Auth:** Pre-Shared Bearer Secret (`API_SECRET`) passed in payloads.
- **Frontend:** Native iOS app (Swift 6, iOS 17.0+) using SwiftData for offline caching and `NWPathMonitor` for background syncing.
- **Local AI Worker:** A single Python 3.12+ script running on an M4 Pro Mac Mini via crontab. It utilizes `mlx-whisper` for transcription and `mlx-lm` for local inference. It runs on-demand to maximize Apple Silicon's unified memory and shuts down cleanly after execution.

## 3. Core Business Rules
- **Base Rate:** $220.00.
- **Default Yard:** Rio Linda, CA (for Deadhead Google Maps routing).
- **Data Boundaries:** AI extraction must NEVER overwrite deterministic data (Quoted Price, Outcome, App fields) inputted by the human dispatcher. It strictly fills the AI-designated columns.
- **Telegram Routing:** Website forms dual-post to the Telegram Bot API and the Apps Script endpoint.

## 4. The CallRail Fail-safe (Merge Logic)
When the CallRail webhook hits the Apps Script, it searches the last 60 minutes of rows for a matching `Customer_Phone`. 
- **If found:** It merges the CallRail marketing/audio data into that existing row.
- **If NOT found:** The script creates a NEW row with the CallRail data, leaving the dispatcher fields blank. The Mac Mini AI will later transcribe the audio to fill in gaps.

## 5. Execution Plan
Do not build the entire system at once. We will execute in phases:
- **Phase 1 (Database/Middleware):** Write the Google Apps Script `doPost(e)` to handle the schema, auth, and CallRail merge logic.
- **Phase 2 (iOS App):** Read `APP_SPEC.md` and scaffold the SwiftUI interface and SwiftData offline-sync engine.
- **Phase 3 (Local AI):** Write the Python Mac Mini script to fetch pending audio, transcribe with `mlx-whisper`, and pass the text to `mlx-lm`. Use a strict Pydantic model with three fields (`caller_tone`, `mentioned_damage`, and a conditional `lead_source` that is requested only when the sheet's `Lead_Source` is still blank after CallRail attribution) to enforce a valid JSON schema response without conversational hallucination, then write the results back to the Google Sheet through the Apps Script `?source=ai` endpoint (fill-only-if-blank; Apps Script cannot receive a true PATCH).