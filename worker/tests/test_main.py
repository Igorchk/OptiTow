import contextlib
import json
import logging
from pathlib import Path

import pytest

import main
from enricher import EnrichmentError
from main import Config, Deps, FailureState, FatalError, load_config, run_batch, single_instance
from schema import Enrichment, model_for
from webhook import FetchError, PendingCall, WebhookFatal, WebhookRejected, WebhookTransient

CFG = Config(callrail_api_key="k", webhook_url="https://script.google.com/x/exec", api_secret="s")
LONG = "Hi, my car has a flat tire and the front bumper is dented. I found you on Google Maps."


def call(n=1, tone="", damage="", lead=""):
    return PendingCall(call_id=f"c{n}", call_recording_url=f"https://media.example.com/r{n}.mp3?key=SECRET",
                       caller_tone=tone, mentioned_damage=damage, lead_source=lead)


class FakeWebhook:
    def __init__(self, items, update_errors=None, pending_error=None):
        self.items, self.updates = items, []
        self.update_errors = update_errors or {}
        self.pending_error = pending_error

    def pending(self, limit):
        if self.pending_error:
            raise self.pending_error
        return self.items[:limit]

    def update(self, c, fields):
        if c.call_id in self.update_errors:
            raise self.update_errors[c.call_id]
        self.updates.append((c.call_id, fields))
        return []


class FakeFetcher:
    def __init__(self, errors=None):
        self.errors, self.fetched = errors or {}, []

    def fetch(self, url, dest, stem="call"):
        self.fetched.append(url)
        for needle, exc in self.errors.items():
            if needle in url:
                raise exc
        path = dest / f"{stem}.mp3"
        path.write_bytes(b"audio")
        return path


class FakeTranscriber:
    """Audio files are named after FailureState.key(call), so tests can target one recording."""

    def __init__(self):
        self.heard = []

    def transcribe(self, path):
        self.heard.append(path.stem)
        return LONG


class FakeEnricher:
    def __init__(self, answer=None, errors=None):
        self.answer = answer or {"caller_tone": "Stressed", "mentioned_damage": ["flat tire"], "lead_source": "Google Maps / Organic"}
        self.errors, self.asked = errors or {}, []

    def enrich(self, transcript, fields):
        self.asked.append(list(fields))
        if self.errors.get("all"):
            raise self.errors["all"]
        return model_for(fields).model_validate({k: v for k, v in self.answer.items() if k in fields})


def deps(tmp_path, items, *, webhook=None, fetcher=None, transcriber=None, enricher=None):
    events = []

    @contextlib.contextmanager
    def tctx():
        events.append("whisper loaded")
        yield transcriber or FakeTranscriber()
        events.append("whisper released")

    @contextlib.contextmanager
    def ectx():
        events.append("llm loaded")
        yield enricher or FakeEnricher()
        events.append("llm released")

    d = Deps(webhook=webhook or FakeWebhook(items), fetcher=fetcher or FakeFetcher(),
             state=FailureState(tmp_path / "state.json"), transcriber=tctx, enricher=ectx)
    d.events = events
    return d


# --- happy path ----------------------------------------------------------------


def test_fills_all_blank_fields_and_unloads_models_in_order(tmp_path):
    d = deps(tmp_path, [call(1)])
    summary = run_batch(CFG, d)
    assert summary.updated == 1 and summary.skipped == 0
    assert d.webhook.updates == [("c1", {"caller_tone": "Stressed", "mentioned_damage": ["flat tire"],
                                          "lead_source": "Google Maps / Organic"})]
    # One model resident at a time: speech model fully released before the LLM loads.
    assert d.events == ["whisper loaded", "whisper released", "llm loaded", "llm released"]


def test_only_blank_fields_are_requested_lead_source_when_blank_only(tmp_path):
    enricher = FakeEnricher()
    d = deps(tmp_path, [call(1, lead="Google Ads"), call(2, tone="Calm", damage="dented door")], enricher=enricher)
    run_batch(CFG, d)
    assert enricher.asked == [["caller_tone", "mentioned_damage"], ["lead_source"]]
    sent = dict(d.webhook.updates)
    assert "lead_source" not in sent["c1"]
    assert set(sent["c2"]) == {"lead_source"}


def test_row_with_every_cell_filled_is_only_marked_processed(tmp_path):
    fetcher, transcriber = FakeFetcher(), FakeTranscriber()
    d = deps(tmp_path, [call(1, "Calm", "None", "Other")], fetcher=fetcher, transcriber=transcriber)
    summary = run_batch(CFG, d)
    assert d.webhook.updates == [("c1", {"mark_processed": True})]
    assert fetcher.fetched == [] and transcriber.heard == [] and summary.updated == 1


def test_no_pending_rows_loads_no_models(tmp_path):
    d = deps(tmp_path, [])
    assert run_batch(CFG, d).pending == 0
    assert d.events == []


def test_dry_run_never_writes(tmp_path):
    d = deps(tmp_path, [call(1)])
    summary = run_batch(CFG, d, dry_run=True)
    assert d.webhook.updates == [] and summary.updated == 0
    assert summary.results[0][0] == "c1"


# --- failures, skipping, parking -------------------------------------------------


def test_download_and_transcription_failures_skip_only_that_row(tmp_path):
    fetcher = FakeFetcher(errors={"r1": FetchError("HTTP 404")})
    d = deps(tmp_path, [call(1), call(2)], fetcher=fetcher)
    summary = run_batch(CFG, d)
    assert [u[0] for u in d.webhook.updates] == ["c2"]
    assert summary.skipped == 1 and summary.updated == 1


def test_transcription_crash_is_isolated(tmp_path):
    class Boom(FakeTranscriber):
        def transcribe(self, path):
            if path.stem == FailureState.key(call(1)):
                raise RuntimeError("ffmpeg failed")
            return LONG

    d = deps(tmp_path, [call(1), call(2)], transcriber=Boom())
    summary = run_batch(CFG, d)
    assert summary.skipped == 1 and [u[0] for u in d.webhook.updates] == ["c2"]


def test_silent_recordings_are_skipped_not_enriched(tmp_path):
    class Silent(FakeTranscriber):
        def transcribe(self, path):
            return "Thank you."

    enricher = FakeEnricher()
    d = deps(tmp_path, [call(1)], transcriber=Silent(), enricher=enricher)
    summary = run_batch(CFG, d)
    assert summary.skipped == 1 and enricher.asked == [] and d.webhook.updates == []
    assert d.events == ["whisper loaded", "whisper released"], "LLM never loaded with nothing to do"


def test_enrichment_error_writes_nothing_and_skips(tmp_path):
    d = deps(tmp_path, [call(1)], enricher=FakeEnricher(errors={"all": EnrichmentError("bad json twice")}))
    summary = run_batch(CFG, d)
    assert summary.skipped == 1 and d.webhook.updates == []


def test_row_is_parked_after_three_failed_runs_and_never_blocks_others(tmp_path):
    items = [call(1), call(2)]
    for _ in range(main.MAX_FAILURES):
        d = deps(tmp_path, items, fetcher=FakeFetcher(errors={"r1": FetchError("corrupt")}))
        run_batch(CFG, d)
    fetcher = FakeFetcher(errors={"r1": FetchError("corrupt")})
    d = deps(tmp_path, items, fetcher=fetcher)
    summary = run_batch(CFG, d)
    assert summary.parked == 1
    assert all("r1" not in u for u in fetcher.fetched)


def test_success_clears_failure_history(tmp_path):
    state = FailureState(tmp_path / "state.json")
    state.record_failure(call(1), "once")
    d = deps(tmp_path, [call(1)])
    run_batch(CFG, d)
    assert not FailureState(tmp_path / "state.json").is_parked(call(1))
    assert json.loads((tmp_path / "state.json").read_text()) == {}


def test_state_file_never_stores_the_recording_url(tmp_path):
    state = FailureState(tmp_path / "state.json")
    state.record_failure(call(1), "x")
    assert "SECRET" not in (tmp_path / "state.json").read_text()


# --- webhook reactions ------------------------------------------------------------


def test_rejected_update_skips_the_row_but_continues(tmp_path):
    wh = FakeWebhook([call(1), call(2)], update_errors={"c1": WebhookRejected("NOT_FOUND")})
    summary = run_batch(CFG, deps(tmp_path, [], webhook=wh))
    assert summary.skipped == 1 and [u[0] for u in wh.updates] == ["c2"]


def test_busy_sheet_stops_the_run_for_the_next_cron_tick(tmp_path):
    wh = FakeWebhook([call(1), call(2)], update_errors={"c1": WebhookTransient("BUSY")})
    summary = run_batch(CFG, deps(tmp_path, [], webhook=wh))
    assert summary.stopped_early and "BUSY" in summary.stopped_early
    assert wh.updates == []
    assert not FailureState(tmp_path / "state.json").is_parked(call(1)), "a busy sheet is not the recording's fault"


def test_unreachable_sheet_on_fetch_is_not_fatal(tmp_path):
    summary = run_batch(CFG, deps(tmp_path, [], webhook=FakeWebhook([], pending_error=WebhookTransient("net"))))
    assert summary.stopped_early


def test_bad_credentials_are_fatal(tmp_path):
    with pytest.raises(FatalError):
        run_batch(CFG, deps(tmp_path, [], webhook=FakeWebhook([], pending_error=WebhookFatal("UNAUTHORIZED"))))
    wh = FakeWebhook([call(1)], update_errors={"c1": WebhookFatal("UNAUTHORIZED")})
    with pytest.raises(FatalError):
        run_batch(CFG, deps(tmp_path, [], webhook=wh))


# --- config, lock, logging ----------------------------------------------------------


def test_load_config_validates_and_defaults():
    env = {"CALLRAIL_API_KEY": " k ", "WEBHOOK_URL": "https://script.google.com/x/exec", "API_SECRET": "s"}
    cfg = load_config(env)
    assert cfg.callrail_api_key == "k"
    assert cfg.whisper_model == "mlx-community/whisper-large-v3-turbo"
    assert cfg.llm_model == "mlx-community/Qwen2.5-7B-Instruct-4bit"
    for missing in env:
        with pytest.raises(FatalError, match=missing):
            load_config({k: v for k, v in env.items() if k != missing})
    with pytest.raises(FatalError, match="https"):
        load_config({**env, "WEBHOOK_URL": "http://script.google.com/x"})
    assert load_config({**env, "WEBHOOK_URL": "http://127.0.0.1:8787/exec"})
    assert load_config({**env, "BATCH_LIMIT": "9999"}).batch_limit == 500
    with pytest.raises(FatalError):
        load_config({**env, "BATCH_LIMIT": "lots"})


def test_second_instance_cannot_take_the_lock(tmp_path):
    lock = tmp_path / "worker.lock"
    with single_instance(lock) as first:
        assert first is True
        with single_instance(lock) as second:
            assert second is False
    with single_instance(lock) as again:
        assert again is True, "lock is released when the first run ends"


def test_logs_never_contain_recording_url_queries(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    d = deps(tmp_path, [call(1)], fetcher=FakeFetcher(errors={"r1": FetchError("HTTP 404")}))
    for _ in range(main.MAX_FAILURES + 1):
        run_batch(CFG, d)
    assert "SECRET" not in caplog.text
