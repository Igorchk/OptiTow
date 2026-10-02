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
from schema import to_update_fields
from webhook import (
    AudioFetcher,
    FetchError,
    PendingCall,
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
# Whisper hallucinates short filler ("Thank you.") on silence; below this there is nothing to analyze.
MIN_TRANSCRIPT_CHARS = 20

log = logging.getLogger("worker")


class FatalError(Exception):
    pass


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


def load_config(env: Mapping[str, str]) -> Config:
    missing = [k for k in ("CALLRAIL_API_KEY", "WEBHOOK_URL", "API_SECRET") if not env.get(k, "").strip()]
    if missing:
        raise FatalError(f"Missing {', '.join(missing)}. Copy .env.example to .env and fill it in.")
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
        entry.update(failures=entry["failures"] + 1, last_error=reason[:300], last_at=_now())
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
    stopped_early: str | None = None
    results: list[tuple[str, dict]] = field(default_factory=list)  # (call_id, fields) in dry-run

    def line(self) -> str:
        extra = f", stopped early: {self.stopped_early}" if self.stopped_early else ""
        return (f"pending={self.pending} parked={self.parked} updated={self.updated} "
                f"skipped={self.skipped}{extra}")


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
        count = deps.state.record_failure(call, reason)
        log.warning("Skipping %s (failure %d/%d): %s", call.call_id, count, MAX_FAILURES, reason)

    # Phase A: audio -> transcripts, with only the speech model in memory.
    transcripts: dict[str, str] = {}
    with tempfile.TemporaryDirectory(prefix="optitow-audio-") as tmp:
        tmp_dir = Path(tmp)
        needs_audio = [c for c in todo if c.blank_fields()]
        with deps.transcriber() as transcriber:
            for call in needs_audio:
                try:
                    audio = deps.fetcher.fetch(call.call_recording_url, tmp_dir, stem=deps.state.key(call))
                    text = transcriber.transcribe(audio)
                    audio.unlink(missing_ok=True)
                except FetchError as exc:
                    fail(call, f"audio download failed: {exc}")
                    continue
                except Exception as exc:  # a corrupt file must not take down the batch
                    fail(call, f"transcription failed: {type(exc).__name__}: {exc}")
                    continue
                if len(text.strip()) < MIN_TRANSCRIPT_CHARS:
                    fail(call, "transcript empty or too short (silence or voicemail?)")
                    continue
                transcripts[call.call_recording_url] = text

    # Phase B: transcripts -> fields, with only the LLM in memory. Written row by row.
    def push(call: PendingCall, fields: dict[str, object]) -> bool:
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

    # Rows with every AI cell already filled by hand need no model: just retire them.
    for call in todo:
        if not call.blank_fields() and not push(call, {"mark_processed": True}):
            return summary

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
                if not push(call, to_update_fields(result)):
                    break
    return summary


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_deps(cfg: Config) -> Deps:
    import httpx

    return Deps(
        webhook=WebhookClient(cfg.webhook_url, cfg.api_secret),
        fetcher=AudioFetcher(cfg.callrail_api_key, httpx.Client(timeout=120, follow_redirects=False)),
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, help="max recordings this run (overrides BATCH_LIMIT)")
    parser.add_argument("--dry-run", action="store_true", help="do everything except write to the sheet; print the results")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)  # httpx logs full URLs at INFO

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
