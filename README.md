# OptiTow

A work pipeline that helps dispatchers collect data on their incoming calls, to train a price-prediction model for towing jobs.

```
iOS dispatcher app ──POST──▶ Google Apps Script ◀──webhook── CallRail
                                   │  ▲
                              Google Sheet ──pending calls──▶ Mac Mini AI worker
                              (29 columns)  ◀──tone, damage, lead source──┘
```

| Part | Folder | What it is |
|---|---|---|
| Middleware | [`apps-script/`](apps-script/README.md) | Google Apps Script web app: auth, schema, the CallRail phone merge, mileage, and the AI write-back endpoint |
| iOS app | [`ios/`](ios/README.md) | Offline-first SwiftUI/SwiftData dispatcher form that syncs to the webhook |
| AI worker | [`worker/`](worker/README.md) | Python script for the Mac Mini: `mlx-whisper` transcription and `mlx-lm` extraction |

## Quick start

On a fresh Mac or a fresh clone, just run:

```bash
./setup.sh
```

It will:
1. Install or verify `ffmpeg` with Homebrew.
2. Ask for your `WEBHOOK_URL`, `API_SECRET` and `CALLRAIL_API_KEY`.
3. Write `ios/OptiTow/Config/Secrets.plist` and `worker/.env` (both git-ignored, owner-only).
4. Create `worker/.venv`, upgrade pip and install `worker/requirements.txt`.
5. Ask whether to pre-download the MLX model weights (about 6 GB) and whether to install the cron job that runs the worker every 10 minutes.

It is safe to re-run: it offers your saved values as defaults and replaces only what it owns. `./setup.sh --help` lists the options.

`setup.sh` does not deploy the Apps Script or sign the iOS app. Do those once:
1. Deploy [`apps-script/Code.gs`](apps-script/README.md) and set its `API_SECRET` script property. That is the value you give `setup.sh`.
2. Open `ios/OptiTow.xcodeproj` in Xcode and choose your signing team.

## Tests

```bash
npm test                                            # Apps Script logic and cross-component contracts
(cd worker && .venv/bin/pip install -r requirements-dev.txt && .venv/bin/python -m pytest)   # worker
```

The iOS app is built and run from Xcode. To try the sync end to end without a Google deployment, see "Testing sync locally" in [`ios/README.md`](ios/README.md).

## Data

The sheet has 29 columns: columns 1–21 are written by the dispatcher app, column 22 (`Lead_Source`) comes from CallRail attribution, and the rest are automated (CallRail, then the AI worker). Nothing automated can overwrite a dispatcher value, and the AI only fills cells that are still blank. The picklists live in `apps-script/Code.gs` (`ENUMS`), and a contract test keeps the iOS app and the worker in step with them.
