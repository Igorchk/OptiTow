"""OptiTow Phase 3 worker: transcribe pending CallRail recordings and enrich the Call Log.

Run on demand (cron). It takes a lock, does one batch, releases the models and exits:

    python main.py [--limit N] [--dry-run] [-v]

Exit codes: 0 = finished (individual rows may have been skipped; see the log),
            2 = fatal (bad configuration, rejected credentials, wrong deployment).
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import logging
import os
import sys
import tempfile
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, ContextManager, Iterator, Mapping, Protocol
from urllib.parse import urlsplit

from enricher import DEFAULT_LLM_MODEL, DEFAULT_WHISPER_MODEL, EnrichmentError, MlxLlm, WhisperTranscriber
from guards import MIN_LIVE_CALL_SEC, MIN_TRANSCRIPT_CHARS, classify_transcript, is_short_call
from schema import not_applicable_fields, to_update_fields
from webhook import (
    AudioFetcher,
    FetchError,
    PendingCall,
    RecordingUnavailable,
    WebhookClient,
    WebhookFatal,
    WebhookRejected,
    WebhookTransient,
    redact,
)

HERE = Path(__file__).resolve().parent
LOCK_PATH = HERE / "worker.lock"
STATE_PATH = HERE / "state.json"

# A recording that fails this many runs in a row is parked, so a few corrupt files can never
# crowd newer calls out of each batch.
MAX_FAILURES = 3

log = logging.getLogger("worker")


class FatalError(Exception):
    pass


def summarize_error(message: str, limit: int = 300) -> str:
    """One line that keeps the start (what failed) and the end (why it failed).

    Tools such as ffmpeg print a long version banner first and the actual cause last, so cutting
    from the front would keep exactly the useless part.
    """
    lines = [line.strip() for line in message.splitlines() if line.strip()]
    text = " | ".join(lines)
    if len(text) <= limit:
        return text
    head = lines[0][:80] if lines else ""
    tail_room = limit - len(head) - len(" … ")
    return f"{head} … {text[-tail_room:]}"


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Config:
    callrail_api_key: str
    webhook_url: str
    api_secret: str
    whisper_model: str = DEFAULT_WHISPER_MODEL
    llm_model: str = DEFAULT_LLM_MODEL
    batch_limit: int = 50
    # Needed to fetch recordings through CallRail's API. Lives only in worker/.env, never in code.
    callrail_account_id: str = ""


def load_config(env: Mapping[str, str]) -> Config:
    required = ("CALLRAIL_API_KEY", "CALLRAIL_ACCOUNT_ID", "WEBHOOK_URL", "API_SECRET")
    missing = [k for k in required if not env.get(k, "").strip()]
    if missing:
        raise FatalError(f"Missing {', '.join(missing)}. Add it to worker/.env (see .env.example) or re-run ./setup.sh.")
    if not env["CALLRAIL_ACCOUNT_ID"].strip().isdigit():
        raise FatalError("CALLRAIL_ACCOUNT_ID must be the numeric CallRail account id (digits only).")
    url = env["WEBHOOK_URL"].strip()
    parts = urlsplit(url)
    local_http = parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1")
    if parts.scheme != "https" and not local_http:
        raise FatalError("WEBHOOK_URL must be https (http is allowed only for localhost testing).")
    try:
        limit = int(env.get("BATCH_LIMIT", "50"))
    except ValueError:
        raise FatalError("BATCH_LIMIT must be an integer.") from None
    return Config(
        callrail_api_key=env["CALLRAIL_API_KEY"].strip(),
        callrail_account_id=env["CALLRAIL_ACCOUNT_ID"].strip(),
        webhook_url=url,
        api_secret=env["API_SECRET"].strip(),
        whisper_model=env.get("WHISPER_MODEL", "").strip() or DEFAULT_WHISPER_MODEL,
        llm_model=env.get("LLM_MODEL", "").strip() or DEFAULT_LLM_MODEL,
        batch_limit=max(1, min(500, limit)),
    )


# ---------------------------------------------------------------------------
# Lock and failure state
# ---------------------------------------------------------------------------


@contextlib.contextmanager
def single_instance(path: Path) -> Iterator[bool]:
    """Non-blocking exclusive lock. Yields False if another run holds it. Released on exit or crash."""
    handle = path.open("a+")
    try:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        handle.close()


class FailureState:
    """Per-recording failure counts, keyed by a hash of the URL (URLs can contain access keys)."""

    def __init__(self, path: Path) -> None:
        self._path = path
        try:
            self._data: dict[str, dict] = json.loads(path.read_text())
        except (OSError, ValueError):
            self._data = {}

    @staticmethod
    def key(call: PendingCall) -> str:
        return hashlib.sha256(call.call_recording_url.encode()).hexdigest()[:16]

    def is_parked(self, call: PendingCall) -> bool:
        return self._data.get(self.key(call), {}).get("failures", 0) >= MAX_FAILURES

    def record_failure(self, call: PendingCall, reason: str) -> int:
        entry = self._data.setdefault(self.key(call), {"failures": 0})
        entry.update(failures=entry["failures"] + 1, last_error=summarize_error(reason), last_at=_now())
        entry["call_id"] = call.call_id
        self._save()
        return entry["failures"]

    def clear(self, call: PendingCall) -> None:
        if self._data.pop(self.key(call), None) is not None:
            self._save()

    def _save(self) -> None:
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data, indent=2))
        os.replace(tmp, self._path)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# The batch
# ---------------------------------------------------------------------------


class Transcriber(Protocol):
    def transcribe(self, audio_path: Path) -> str: ...


class Enriching(Protocol):
    def enrich(self, transcript: str, fields: list[str]): ...


@dataclass
class Deps:
    """Everything the batch touches, injectable so tests never load a model or hit the network."""

    webhook: WebhookClient
    fetcher: AudioFetcher
    state: FailureState
    transcriber: Callable[[], ContextManager[Transcriber]]
    enricher: Callable[[], ContextManager[Enriching]]


@dataclass
class Summary:
    pending: int = 0
    parked: int = 0
    updated: int = 0
    skipped: int = 0
    not_conversation: int = 0  # unanswered, dropped or automated: recorded as N/A, no LLM used
    unavailable: int = 0  # CallRail no longer has the call: row retired, AI cells left blank
    stopped_early: str | None = None
    results: list[tuple[str, dict]] = field(default_factory=list)  # (call_id, fields) in dry-run

    def line(self) -> str:
        extra = f", stopped early: {self.stopped_early}" if self.stopped_early else ""
        return (f"pending={self.pending} parked={self.parked} updated={self.updated} "
                f"not_conversation={self.not_conversation} unavailable={self.unavailable} skipped={self.skipped}{extra}")


def run_batch(cfg: Config, deps: Deps, *, dry_run: bool = False) -> Summary:
    summary = Summary()
    try:
        pending = deps.webhook.pending(cfg.batch_limit)
    except WebhookTransient as exc:
        summary.stopped_early = f"could not fetch pending calls ({exc})"
        return summary
    except WebhookFatal as exc:
        raise FatalError(str(exc)) from exc
    summary.pending = len(pending)

    todo: list[PendingCall] = []
    for call in pending:
        if deps.state.is_parked(call):
            summary.parked += 1
            log.info("Parked after %d failures, skipping %s", MAX_FAILURES, redact(call.call_recording_url))
        else:
            todo.append(call)
    if not todo:
        return summary

    def fail(call: PendingCall, reason: str) -> None:
        summary.skipped += 1
        reason = summarize_error(reason)
        count = deps.state.record_failure(call, reason)
        log.warning("Skipping %s (failure %d/%d): %s", call.call_id, count, MAX_FAILURES, reason)

    def push(call: PendingCall, fields: dict[str, object], *, junk: bool = False) -> bool:
        """Write one row. False means the run must stop (sheet busy); the next cron tick retries."""
        if junk:
            summary.not_conversation += 1
        if dry_run:
            summary.results.append((call.call_id, fields))
            return True
        try:
            warnings = deps.webhook.update(call, fields)
        except WebhookRejected as exc:
            fail(call, f"server rejected the update: {exc}")
            return True
        except WebhookTransient as exc:
            summary.stopped_early = f"update failed ({exc})"
            return False
        except WebhookFatal as exc:
            raise FatalError(str(exc)) from exc
        for warning in warnings:
            log.info("Server note for %s: %s", call.call_id, warning)
        deps.state.clear(call)
        summary.updated += 1
        return True

    # Phase 0: rows that need no audio and no model.
    #  * every AI cell already filled by hand: just retire the row;
    #  * the call was too short to be a conversation (total duration includes ringing, so a short
    #    total proves a short conversation): record N/A without even downloading the recording.
    remaining: list[PendingCall] = []
    for call in todo:
        blank = call.blank_fields()
        if not blank:
            if not push(call, {"mark_processed": True}):
                return summary
        elif is_short_call(call.call_duration_sec):
            log.info("No conversation for %s: call lasted %ss (under %ss)",
                     call.call_id, call.call_duration_sec, MIN_LIVE_CALL_SEC)
            if not push(call, not_applicable_fields(blank), junk=True):
                return summary
        else:
            remaining.append(call)
    todo = remaining

    # Phase A: audio -> transcripts, with only the speech model in memory. A recording of a carrier
    # or voicemail system, or with no dialogue at all, is recorded as N/A here and never reaches
    # the LLM.
    transcripts: dict[str, str] = {}
    if todo:
        with tempfile.TemporaryDirectory(prefix="optitow-audio-") as tmp:
            tmp_dir = Path(tmp)
            with deps.transcriber() as transcriber:
                for call in todo:
                    try:
                        audio = deps.fetcher.fetch(call.call_recording_url, tmp_dir, stem=deps.state.key(call))
                        text = transcriber.transcribe(audio)
                        audio.unlink(missing_ok=True)
                    except RecordingUnavailable as exc:
                        # Not junk and not a failure: the call is gone from CallRail. Stamp the row
                        # processed so it stops coming back, and leave every AI cell blank.
                        log.warning("Recording unavailable for %s (%s): retiring the row, AI cells left blank",
                                    call.call_id, exc)
                        summary.unavailable += 1
                        if not push(call, {"mark_processed": True}):
                            return summary
                        continue
                    except FetchError as exc:
                        fail(call, f"audio download failed: {exc}")
                        continue
                    except Exception as exc:  # a corrupt file must not take down the batch
                        fail(call, f"transcription failed: {type(exc).__name__}: {exc}")
                        continue
                    verdict = classify_transcript(text)
                    if verdict:
                        log.info("No conversation for %s: %s", call.call_id, verdict)
                        if not push(call, not_applicable_fields(call.blank_fields()), junk=True):
                            return summary
                        continue
                    transcripts[call.call_recording_url] = text

    # Phase B: transcripts -> fields, with only the LLM in memory. Written row by row.
    if transcripts:
        with deps.enricher() as enricher:
            for call in todo:
                text = transcripts.get(call.call_recording_url)
                if text is None:
                    continue
                try:
                    result = enricher.enrich(text, call.blank_fields())
                except EnrichmentError as exc:
                    fail(call, f"model output never matched the schema: {exc}")
                    continue
                except Exception as exc:
                    fail(call, f"enrichment failed: {type(exc).__name__}: {exc}")
                    continue
                fields = to_update_fields(result)
                # The model itself found no real conversation (the prompt rule): same as the guards.
                if fields.get("caller_tone") == "N/A":
                    summary.not_conversation += 1
                if not push(call, fields):
                    break
    return summary


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_deps(cfg: Config) -> Deps:
    import httpx

    return Deps(
        webhook=WebhookClient(cfg.webhook_url, cfg.api_secret),
        fetcher=AudioFetcher(
            cfg.callrail_api_key,
            httpx.Client(timeout=120, follow_redirects=False),
            account_id=cfg.callrail_account_id,
        ),
        state=FailureState(STATE_PATH),
        transcriber=lambda: WhisperTranscriber(cfg.whisper_model),
        enricher=lambda: _LlmEnricherContext(MlxLlm(cfg.llm_model)),
    )


class _LlmEnricherContext:
    """Adapts MlxLlm so `with` yields an Enricher while still unloading the model on exit."""

    def __init__(self, llm: MlxLlm) -> None:
        self._llm = llm

    def __enter__(self):
        return self._llm.__enter__().enricher()

    def __exit__(self, *exc: object) -> None:
        self._llm.__exit__(*exc)


# Libraries whose debug output is transport noise (headers, cookies, connection details).
_NOISY_LOGGERS = ("httpx", "httpcore", "hpack", "urllib3", "huggingface_hub", "filelock", "fsspec")


def configure_logging(verbose: bool) -> None:
    """-v shows this worker's own debug messages, not the network libraries' (which log headers)."""
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    # basicConfig is a no-op if logging was already set up, so apply the level explicitly too.
    logging.getLogger().setLevel(logging.DEBUG if verbose else logging.INFO)
    for name in _NOISY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, help="max recordings this run (overrides BATCH_LIMIT)")
    parser.add_argument("--dry-run", action="store_true", help="do everything except write to the sheet; print the results")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    configure_logging(args.verbose)

    try:
        from dotenv import load_dotenv

        load_dotenv(HERE / ".env")
        cfg = load_config(os.environ)
        if args.limit:
            cfg = replace(cfg, batch_limit=max(1, min(500, args.limit)))

        with single_instance(LOCK_PATH) as acquired:
            if not acquired:
                log.info("Another run holds %s; exiting.", LOCK_PATH.name)
                return 0
            summary = run_batch(cfg, build_deps(cfg), dry_run=args.dry_run)
    except FatalError as exc:
        log.error("%s", exc)
        return 2

    log.info("Done: %s", summary.line())
    for call_id, fields in summary.results:
        print(json.dumps({"call_id": call_id, **fields}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
