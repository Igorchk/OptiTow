# OptiTow Local AI Worker (Phase 3)

A single Python script for the M4 Pro Mac Mini. On each run it fetches calls that still need AI enrichment from the Google Sheet. For each one it downloads the CallRail recording, transcribes it with `mlx-whisper`, extracts structured fields with `mlx-lm`, and writes them back through the Apps Script webhook. It then releases the models and exits. It is meant to be run by cron.

It lives in its own directory so its Python dependencies stay separate from `ios/` and `apps-script/`.

## What it writes

| Column | Source | Rule |
|---|---|---|
| `Caller_Tone` | model | One of `Calm`, `Stressed`, `Frustrated`, `Angry`, `Confused`, `Rushed`, `Price Shopping`, `Cooperative`, or `N/A` when there is no real conversation |
| `Mentioned_Damage` | model | Short phrases the caller actually states (max 8, 80 characters each), `None` for a real call with no damage mentioned, or `N/A` when there is no real conversation |
| `Lead_Source` | model | One of the six values, **only if the cell is blank** after CallRail attribution |
| `AI_Processed_At` | server | Set by the Apps Script when the update lands |

**Nothing is ever overwritten.** The Apps Script fills each of these cells only if it is still blank, and the worker only asks the model for cells that are blank. Dispatcher columns and CallRail data are never touched, because the endpoint can't reach them.

To re-run a row, clear its `Caller_Tone`, `Mentioned_Damage` and `AI_Processed_At` cells (and `Lead_Source` if you want it re-guessed).

## Setup

Requires Python 3.12+ on Apple Silicon, and `ffmpeg` (mlx-whisper uses it to decode audio).

```bash
cd worker
brew install ffmpeg
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env     # then fill in the three values
```

`.env` (git-ignored):

| Variable | Meaning |
|---|---|
| `CALLRAIL_API_KEY` | CallRail API key. Sent only to `*.callrail.com`. |
| `WEBHOOK_URL` | The Apps Script `/exec` URL (https). |
| `API_SECRET` | Must equal the `API_SECRET` Script Property. |

Optional: `WHISPER_MODEL` (default `mlx-community/whisper-large-v3-turbo`), `LLM_MODEL` (default `mlx-community/Qwen2.5-7B-Instruct-4bit`), `BATCH_LIMIT` (default 50).

**The first real run downloads the models** from Hugging Face into `~/.cache/huggingface`: roughly 1.5 GB for Whisper and 4–5 GB for Qwen. After that it runs offline.

## First run

Try it without writing anything to the sheet:

```bash
.venv/bin/python main.py --dry-run --limit 2 -v
```

It prints the JSON it would send for each call. If it looks right, run it for real with `.venv/bin/python main.py`.

## Schedule (cron)

```cron
*/10 * * * * cd /Users/YOU/path/to/OptiTow/worker && PATH=/opt/homebrew/bin:/usr/bin:/bin .venv/bin/python main.py >> worker.log 2>&1
```

Cron's PATH is minimal, so the line above puts Homebrew's `ffmpeg` on it. `worker.log` is git-ignored; rotate it occasionally.

## Calls that are not conversations

Unanswered calls, dropped calls and recordings of a carrier or voicemail system would otherwise get an invented emotion. They are recorded as `N/A` (tone and damage) with `AI_Processed_At` set, so they leave the queue and are never retried. Cheapest check first:

1. **Apps Script, at ingestion:** `answered` is false, or under 15 seconds of talk time (see the Apps Script README). These rows never reach the worker.
2. **Worker, before downloading:** a pending row whose total duration is under 15 seconds (this covers rows stored before those fields were captured). No audio is fetched and no model is loaded.
3. **Worker, after transcribing, before the LLM:** the transcript is effectively empty, or it contains carrier, IVR or voicemail phrases and almost no human speech once those sentences are set aside (`guards.py`). A voicemail greeting followed by a real customer message is still analyzed.
4. **The prompt:** anything that gets through is told to answer `N/A` for tone rather than guess, and the worker then also writes `N/A` for damage and does not write a lead-source guess.

`Lead_Source` is never guessed for these calls. The thresholds and phrase list are constants in `guards.py`, covered by tests.

## How a run works

1. **Lock.** It takes `worker.lock`. If another run holds it (a long batch), this run logs "Another run holds worker.lock" and exits 0.
2. **Fetch.** It asks the webhook for rows that have a recording and no `AI_Processed_At`.
3. **Transcribe.** With only Whisper loaded, it downloads and transcribes each recording, then unloads Whisper.
4. **Enrich.** With only the LLM loaded, it extracts exactly the missing fields, then unloads the model. Each row is written to the sheet as soon as it is done.
5. **Exit.** It frees unified memory and exits.

## Strict JSON

`mlx-lm` has no grammar-constrained decoding, so the guarantee comes from three layers:
1. The reply is pre-started with `{`, decoding is greedy (temperature 0), and the prompt carries the Pydantic JSON schema.
2. The reply must pass a strict Pydantic model (`schema.py`). Picklist values are literals, extra keys are rejected, and the model for a row contains only the fields that row still needs.
3. On a failure the model gets one retry, shown its own bad output and the validation error. If it fails again the row is skipped and **nothing is written**.

The Apps Script validates the picklists again, so a bad value can't reach the sheet even if the worker had a bug.

## Audio download

Both shapes of CallRail recording link work:
- A direct or signed media URL, possibly behind redirects, is fetched with no credentials.
- The authenticated API URL (`api.callrail.com/.../recording.json`) is fetched with `Authorization: Token token=<CALLRAIL_API_KEY>`. It answers with JSON containing the real media URL, which is then fetched without the key.

The API key is never sent to a non-CallRail host. Redirects are followed manually so a redirect can't carry it elsewhere, and other `*.callrail.com` hosts only get it after answering 401/403. Only https URLs are accepted. Logs show URLs without their query strings, since those can contain access keys.

## Errors and skipping

| Situation | What happens |
|---|---|
| Download fails, ffmpeg can't read the file, model output never validates, or the server rejects that update | The row is skipped, counted, and logged. Other rows continue. |
| A recording fails 3 runs in a row | It is **parked** in `state.json` and no longer retried, so a few bad files can't crowd newer calls out of each batch. Delete its entry in `state.json` to retry. |
| Sheet is busy or the network is down | The run stops cleanly and the next cron tick retries. This does not count against any recording. |
| Wrong `API_SECRET`, wrong deployment access, or missing config | Exit code 2 with a clear message. |

`state.json` stores only a hash of each recording URL, never the URL itself.

## Tests

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest
```

No model is loaded. The tests use fakes for audio, transcription and the LLM text. They run the real webhook client and Pydantic validation against the actual `apps-script/Code.gs`, through `tests/mock-webhook.js` (needs `node`). The repo's `npm test` also checks that the picklists here match the Apps Script.
