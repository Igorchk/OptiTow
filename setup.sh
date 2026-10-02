#!/usr/bin/env bash
# OptiTow setup for a fresh Mac or a fresh clone. Safe to re-run: it offers your saved values as
# defaults and replaces only what it owns.
#
#   ./setup.sh
#
# What it does:
#   1. Installs/verifies ffmpeg with Homebrew (needed by mlx-whisper).
#   2. Asks for WEBHOOK_URL, API_SECRET and CALLRAIL_API_KEY.
#   3. Writes ios/OptiTow/Config/Secrets.plist and worker/.env (both git-ignored, owner-only).
#   4. Creates worker/.venv, upgrades pip and installs worker/requirements.txt.
#   5. Optionally pre-downloads the MLX model weights and installs the cron job.
#
# Skip the y/n prompts (e.g. for automation) with SETUP_CACHE_MODELS=y|n, SETUP_INSTALL_CRON=y|n
# and SETUP_INSTALL_PYTHON=y|n. Values already exported as WEBHOOK_URL / API_SECRET /
# CALLRAIL_API_KEY are used as the defaults.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKER="$ROOT/worker"
ENV_FILE="$WORKER/.env"
PLIST="$ROOT/ios/OptiTow/Config/Secrets.plist"
CRON_TAG="# optitow-worker"

if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'; else B=; G=; Y=; R=; N=; fi
step() { printf '\n%s==> %s%s\n' "$B" "$1" "$N"; }
ok()   { printf '%s✓%s %s\n' "$G" "$N" "$1"; }
warn() { printf '%s!%s %s\n' "$Y" "$N" "$1" >&2; }
die()  { printf '%s✗ %s%s\n' "$R" "$1" "$N" >&2; exit 1; }

case "${1:-}" in
  "") ;;
  -h|--help) sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "Unknown argument '$1'. Try ./setup.sh --help" ;;
esac

[ "$(uname -s)" = "Darwin" ] || die "setup.sh targets macOS (the iOS app and MLX need a Mac)."
[ "$(uname -m)" = "arm64" ] || warn "This is not an Apple Silicon Mac: MLX will not install, so step 4 will fail."

# --- helpers -------------------------------------------------------------------

# confirm "Question?" y|n ENV_VAR_THAT_CAN_PRESET_THE_ANSWER
confirm() {
  local question="$1" default="$2" answer="${!3:-}" hint="[y/N]"
  [ "$default" = "y" ] && hint="[Y/n]"
  if [ -z "$answer" ]; then
    read -r -p "$question $hint " answer || answer=""
    answer="${answer:-$default}"
  fi
  case "$answer" in [yY]*) return 0 ;; *) return 1 ;; esac
}

env_get() { # env_get FILE KEY -> value from a KEY='value' line, if present
  [ -f "$1" ] || return 0
  local line
  line="$(grep -E "^$2=" "$1" | tail -n 1 || true)"
  line="${line#*=}"; line="${line#\'}"; line="${line%\'}"
  printf '%s' "$line"
}

plist_get() { # plist_get KEY
  [ -f "$PLIST" ] || return 0
  /usr/libexec/PlistBuddy -c "Print :$1" "$PLIST" 2>/dev/null || true
}

validate_url() {
  if [[ "$1" =~ ^https://[^[:space:]\'\"]+$ ]]; then return 0; fi
  if [[ "$1" =~ ^http://(localhost|127\.0\.0\.1)([:/][^[:space:]\'\"]*)?$ ]]; then
    echo "http is accepted for local testing only; the iOS Release build needs https."; return 0
  fi
  echo "WEBHOOK_URL must be the https Apps Script /exec URL (no spaces or quotes)."; return 1
}
validate_secret() {
  [ -n "$1" ] || { echo "This value is required."; return 1; }
  if [[ "$1" =~ [[:space:][:cntrl:]\'\"\\\`\$] ]]; then
    echo "No spaces, quotes, backslashes, backticks or \$ allowed."; return 1
  fi
}

# prompt_value VAR "Label" secret(0|1) validator
prompt_value() {
  local var="$1" label="$2" secret="$3" validator="$4" current input err
  current="${!var:-}"
  [ -n "$current" ] || current="$(env_get "$ENV_FILE" "$var")"
  [ -n "$current" ] || current="$(plist_get "$var")"
  while true; do
    if [ "$secret" = 1 ]; then
      local hint=""; [ -n "$current" ] && hint=" (Enter keeps the saved value)"
      read -rs -p "$label$hint: " input || input=""; echo
    else
      read -r -p "$label${current:+ [$current]}: " input || input=""
    fi
    input="${input:-$current}"
    input="${input#"${input%%[![:space:]]*}"}"; input="${input%"${input##*[![:space:]]}"}"
    if err="$($validator "$input" 2>&1)"; then
      [ -z "$err" ] || warn "$err"
      printf -v "$var" '%s' "$input"
      return 0
    fi
    warn "$err"
  done
}

find_python() { # newest-stable first; MLX needs 3.12+
  local c p
  for c in python3.13 python3.12 python3.14 python3; do
    p="$(command -v "$c" 2>/dev/null)" || continue
    if "$p" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)'; then printf '%s' "$p"; return 0; fi
  done
  return 1
}

# --- 1. ffmpeg (and Python) ---------------------------------------------------------

step "1/5  Checking ffmpeg"
command -v brew >/dev/null 2>&1 || die "Homebrew is required. Install it from https://brew.sh and re-run ./setup.sh."
BREW_BIN="$(brew --prefix)/bin"
if command -v ffmpeg >/dev/null 2>&1 || brew list --formula ffmpeg >/dev/null 2>&1; then
  ok "ffmpeg already installed"
else
  echo "Installing ffmpeg with Homebrew…"
  brew install ffmpeg
fi
# Capture first: piping `ffmpeg -version` into head can SIGPIPE and trip `pipefail`.
ffmpeg_out="$(PATH="$BREW_BIN:$PATH" ffmpeg -version 2>/dev/null || true)"
case "$ffmpeg_out" in ffmpeg*) ;; *) die "ffmpeg is installed but not runnable." ;; esac
ok "$(printf '%s' "${ffmpeg_out%%$'\n'*}" | cut -d' ' -f1-3)"

if ! PY="$(find_python)"; then
  warn "The worker needs Python 3.12 or newer and none was found."
  if confirm "Install Python 3.13 with Homebrew now?" y SETUP_INSTALL_PYTHON; then
    brew install python@3.13
    PY="$(find_python)" || die "Python 3.13 installed but not found on PATH. Open a new terminal and re-run."
  else
    die "Python 3.12+ is required."
  fi
fi
ok "Using $("$PY" --version) ($PY)"

# --- 2. credentials ------------------------------------------------------------------

step "2/5  Credentials"
echo "These are stored only in two git-ignored files on this machine."
prompt_value WEBHOOK_URL "Apps Script WEBHOOK_URL (https .../exec)" 0 validate_url
prompt_value API_SECRET "API_SECRET (same as the Apps Script property)" 1 validate_secret
prompt_value CALLRAIL_API_KEY "CALLRAIL_API_KEY" 1 validate_secret

# --- 3. write config files -----------------------------------------------------------

step "3/5  Writing config files"
mkdir -p "$WORKER" "$(dirname "$PLIST")"

# worker/.env: owner-only; keep any optional overrides (WHISPER_MODEL, LLM_MODEL, BATCH_LIMIT…).
(
  umask 077
  tmp="$(mktemp "$ENV_FILE.XXXXXX")"
  {
    echo "# Written by setup.sh. Git-ignored: never commit this file."
    printf "CALLRAIL_API_KEY='%s'\n" "$CALLRAIL_API_KEY"
    printf "WEBHOOK_URL='%s'\n" "$WEBHOOK_URL"
    printf "API_SECRET='%s'\n" "$API_SECRET"
    if [ -f "$ENV_FILE" ]; then
      grep -vE '^(CALLRAIL_API_KEY|WEBHOOK_URL|API_SECRET)=|^# Written by setup\.sh' "$ENV_FILE" || true
    fi
  } > "$tmp"
  mv "$tmp" "$ENV_FILE"
)
ok "worker/.env"

# Secrets.plist is built with plistlib so a secret can never break the XML.
(
  umask 077
  WEBHOOK_URL="$WEBHOOK_URL" API_SECRET="$API_SECRET" "$PY" - "$PLIST" <<'PY'
import os, plistlib, sys
with open(sys.argv[1], "wb") as f:
    plistlib.dump({"WEBHOOK_URL": os.environ["WEBHOOK_URL"], "API_SECRET": os.environ["API_SECRET"]}, f)
PY
)
ok "ios/OptiTow/Config/Secrets.plist (this ships inside the app, so use a secret you can rotate)"

# --- 4. Python environment ----------------------------------------------------------------

step "4/5  Python environment (worker/.venv)"
VENV="$WORKER/.venv"
if [ -x "$VENV/bin/python" ] && ! "$VENV/bin/python" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)'; then
  warn "Existing worker/.venv uses an older Python; recreating it."
  rm -rf "$VENV"
fi
[ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
"$VENV/bin/python" -m pip install --quiet --upgrade pip
echo "Installing worker/requirements.txt (MLX is a large download)…"
"$VENV/bin/python" -m pip install --quiet -r "$WORKER/requirements.txt"
ok "dependencies installed"

# --- 5. optional: model weights and cron --------------------------------------------------------

step "5/5  Optional extras"
if confirm "Pre-download the MLX model weights now? (Whisper ~1.5 GB + Qwen 7B ~4-5 GB; otherwise the first run does it.)" n SETUP_CACHE_MODELS; then
  (
    cd "$WORKER"
    WHISPER_MODEL="$(env_get "$ENV_FILE" WHISPER_MODEL)" LLM_MODEL="$(env_get "$ENV_FILE" LLM_MODEL)" \
      "$VENV/bin/python" - <<'PY'
import os
from huggingface_hub import snapshot_download
from enricher import DEFAULT_LLM_MODEL, DEFAULT_WHISPER_MODEL

for repo in (os.environ.get("WHISPER_MODEL") or DEFAULT_WHISPER_MODEL,
             os.environ.get("LLM_MODEL") or DEFAULT_LLM_MODEL):
    print(f"Downloading {repo} …", flush=True)
    snapshot_download(repo)
print("Models cached in ~/.cache/huggingface")
PY
  )
  ok "model weights cached"
else
  echo "Skipped. The first worker run will download them."
fi

if confirm "Install the cron job (runs the worker every 10 minutes)?" n SETUP_INSTALL_CRON; then
  case "$WORKER" in *%*) die "cron cannot handle a '%' in the path ($WORKER). Move the repo and re-run." ;; esac
  CRON_LINE="*/10 * * * * cd \"$WORKER\" && PATH=$BREW_BIN:/usr/bin:/bin \"$VENV/bin/python\" main.py >> worker.log 2>&1 $CRON_TAG"
  existing="$(crontab -l 2>/dev/null || true)"
  { printf '%s\n' "$existing" | grep -vF "$CRON_TAG" || true; printf '%s\n' "$CRON_LINE"; } | sed '/^[[:space:]]*$/d' | crontab -
  ok "cron job installed (re-running setup replaces it; remove it with: crontab -e)"
  case "$ROOT" in
    "$HOME"/Documents/*|"$HOME"/Desktop/*|"$HOME"/Downloads/*)
      warn "This repo is under a macOS-protected folder. cron needs Full Disk Access to read it:"
      warn "System Settings > Privacy & Security > Full Disk Access > add /usr/sbin/cron (or move the repo)." ;;
  esac
else
  echo "Skipped. To install it later, re-run ./setup.sh or see worker/README.md."
fi

# --- done -------------------------------------------------------------------------------------------

step "Done"
cat <<EOF
Next steps:
  1. Try the worker without writing to the sheet:
       cd worker && .venv/bin/python main.py --dry-run --limit 2 -v
  2. Open ios/OptiTow.xcodeproj in Xcode, choose your signing team, and run.
  3. Deploy apps-script/Code.gs (see apps-script/README.md) if you haven't yet.
EOF
