import contextlib
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

import main
from enricher import EnrichmentError
from main import Config, Deps, FailureState, FatalError, load_config, run_batch, single_instance
from schema import Enrichment, model_for
from webhook import FetchError, PendingCall, RecordingUnavailable, WebhookFatal, WebhookRejected, WebhookTransient

CFG = Config(callrail_api_key="k", webhook_url="https://script.google.com/x/exec", api_secret="s")
LONG = "Hi, my car has a flat tire and the front bumper is dented. I found you on Google Maps."


NOW = datetime(2026, 10, 2, 22, 0, 0, tzinfo=timezone.utc)


def call(n=1, tone="", damage="", lead="", dur=None, ended_min_ago=None):
    """`ended_min_ago` gives the call a start time such that it ended that long before NOW."""
    date_time = ""
    if ended_min_ago is not None:
        started = NOW - timedelta(minutes=ended_min_ago) - timedelta(seconds=dur or 0)
        date_time = started.strftime("%Y-%m-%dT%H:%M:%SZ")
    return PendingCall(call_id=f"c{n}", call_recording_url=f"https://media.example.com/r{n}.mp3?key=SECRET",
                       caller_tone=tone, mentioned_damage=damage, lead_source=lead, call_duration_sec=dur,
                       date_time=date_time)


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
    def __init__(self, errors=None, account_ok=True):
        self.errors, self.fetched = errors or {}, []
        self.account_ok, self.account_checks = account_ok, 0

    def verify_account(self):
        self.account_checks += 1
        if not self.account_ok:
            raise FetchError("call unavailable, but the CallRail account check failed (key or account id wrong?)")

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

    def __init__(self, by_call=None, default=LONG):
        self.by_call = {FailureState.key(c): text for c, text in (by_call or {}).items()}
        self.default, self.heard = default, []

    def transcribe(self, path):
        self.heard.append(path.stem)
        return self.by_call.get(path.stem, self.default)


class FakeEnricher:
    def __init__(self, answer=None, errors=None):
        self.answer = answer or {"caller_tone": "Stressed", "mentioned_damage": ["flat tire"], "lead_source": "Google Maps / Organic"}
        self.errors, self.asked = errors or {}, []

    def enrich(self, transcript, fields):
        self.asked.append(list(fields))
        if self.errors.get("all"):
            raise self.errors["all"]
        return model_for(fields).model_validate({k: v for k, v in self.answer.items() if k in fields})


def deps(tmp_path, items, *, webhook=None, fetcher=None, transcriber=None, enricher=None, now=NOW):
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
             state=FailureState(tmp_path / "state.json"), transcriber=tctx, enricher=ectx,
             clock=lambda: now)
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


# --- junk calls: recorded as N/A, never analyzed -------------------------------------------------

NA_BOTH = {"caller_tone": "N/A", "mentioned_damage": "N/A"}
CARRIER = "Sorry, your call cannot be completed as dialed."


def test_silent_or_tiny_recordings_are_recorded_as_na_and_leave_the_queue(tmp_path):
    enricher = FakeEnricher()
    d = deps(tmp_path, [call(1)], transcriber=FakeTranscriber(default="Thank you."), enricher=enricher)
    summary = run_batch(CFG, d)
    assert d.webhook.updates == [("c1", NA_BOTH)], "no lead_source guess either"
    assert (summary.not_conversation, summary.skipped, summary.updated) == (1, 0, 1)
    assert enricher.asked == []
    assert d.events == ["whisper loaded", "whisper released"], "LLM never loaded"


def test_short_calls_download_no_audio_and_load_no_model(tmp_path):
    fetcher = FakeFetcher()
    d = deps(tmp_path, [call(1, dur=8)], fetcher=fetcher)
    summary = run_batch(CFG, d)
    assert d.webhook.updates == [("c1", NA_BOTH)]
    assert fetcher.fetched == [] and d.events == []
    assert summary.not_conversation == 1


def test_the_short_call_threshold_is_15_seconds(tmp_path):
    fetcher = FakeFetcher()
    d = deps(tmp_path, [call(1, dur=14), call(2, dur=15), call(3, dur=145), call(4, dur=None)], fetcher=fetcher)
    run_batch(CFG, d)
    assert dict(d.webhook.updates)["c1"] == NA_BOTH, "14s is junk"
    assert len(fetcher.fetched) == 3, "15s and longer (or unknown) are transcribed"


def test_carrier_transcripts_never_reach_the_llm_but_real_calls_still_do(tmp_path):
    enricher = FakeEnricher()
    transcriber = FakeTranscriber(by_call={call(1): CARRIER})
    d = deps(tmp_path, [call(1), call(2)], transcriber=transcriber, enricher=enricher)
    summary = run_batch(CFG, d)
    sent = dict(d.webhook.updates)
    assert sent["c1"] == NA_BOTH
    assert sent["c2"]["caller_tone"] == "Stressed"
    assert len(enricher.asked) == 1, "only the real call used the model"
    assert (summary.not_conversation, summary.updated) == (1, 2)


def test_a_voicemail_with_a_real_customer_message_is_analyzed(tmp_path):
    message = ("Hi, my truck broke down on the westbound shoulder near the Madison exit and the front "
               "tire is flat, I need a tow as soon as you can get here, please call me back.")
    enricher = FakeEnricher()
    d = deps(tmp_path, [call(1)], transcriber=FakeTranscriber(default=f"Please leave a message after the tone. {message}"),
             enricher=enricher)
    summary = run_batch(CFG, d)
    assert len(enricher.asked) == 1 and summary.not_conversation == 0


def test_na_only_fills_cells_that_are_still_blank(tmp_path):
    d = deps(tmp_path, [call(1, tone="Calm", dur=5), call(2, tone="Calm", damage="x", dur=5),
                        call(3, damage="None", lead="Other", dur=5)])
    run_batch(CFG, d)
    sent = dict(d.webhook.updates)
    assert sent["c1"] == {"mentioned_damage": "N/A"}
    assert sent["c2"] == {"mark_processed": True}, "only lead_source is blank, and it is never guessed"
    assert sent["c3"] == {"caller_tone": "N/A"}


def test_a_model_that_answers_na_is_recorded_without_a_lead_source_guess(tmp_path):
    answer = {"caller_tone": "N/A", "mentioned_damage": ["flat tire"], "lead_source": "Google Ads"}
    d = deps(tmp_path, [call(1)], enricher=FakeEnricher(answer=answer))
    summary = run_batch(CFG, d)
    assert d.webhook.updates == [("c1", NA_BOTH)]
    assert summary.not_conversation == 1


def test_junk_is_not_a_failure_and_is_never_parked(tmp_path):
    for _ in range(main.MAX_FAILURES + 2):
        d = deps(tmp_path, [call(1, dur=3)])
        run_batch(CFG, d)
        assert d.webhook.updates == [("c1", NA_BOTH)]
    state_file = tmp_path / "state.json"
    assert not state_file.exists() or json.loads(state_file.read_text()) == {}


def test_junk_dry_run_reports_without_writing(tmp_path):
    d = deps(tmp_path, [call(1, dur=3)])
    summary = run_batch(CFG, d, dry_run=True)
    assert d.webhook.updates == [] and summary.results == [("c1", NA_BOTH)] and summary.not_conversation == 1


def test_a_busy_sheet_while_recording_junk_stops_the_run_without_blaming_the_row(tmp_path):
    wh = FakeWebhook([call(1, dur=3), call(2)], update_errors={"c1": WebhookTransient("BUSY")})
    summary = run_batch(CFG, deps(tmp_path, [], webhook=wh))
    assert summary.stopped_early and wh.updates == []
    assert not FailureState(tmp_path / "state.json").is_parked(call(1, dur=3))


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
    env = {"CALLRAIL_API_KEY": " k ", "CALLRAIL_ACCOUNT_ID": " 123456789 ",
           "WEBHOOK_URL": "https://script.google.com/x/exec", "API_SECRET": "s"}
    cfg = load_config(env)
    assert cfg.callrail_api_key == "k" and cfg.callrail_account_id == "123456789"
    assert cfg.whisper_model == "mlx-community/whisper-large-v3-turbo"
    assert cfg.llm_model == "mlx-community/Qwen2.5-7B-Instruct-4bit"
    for missing in env:
        with pytest.raises(FatalError, match=missing):
            load_config({k: v for k, v in env.items() if k != missing})
    for bad in ("abc", "12 34", "123456789/", "a/../b"):
        with pytest.raises(FatalError, match="numeric"):
            load_config({**env, "CALLRAIL_ACCOUNT_ID": bad})
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


# --- readable failures and quiet logs ---------------------------------------------------------

FFMPEG_BANNER = "\n".join(f"  configuration line {i} --enable-something" for i in range(40))


def test_summarize_error_keeps_the_start_and_the_root_cause():
    message = ("transcription failed: RuntimeError: Failed to load audio: ffmpeg version 9\n" + FFMPEG_BANNER
               + "\n[in#0] Failed to find two consecutive MPEG audio frames.\n"
               "Error opening input files: Invalid data found when processing input\n")
    out = main.summarize_error(message)
    assert len(out) <= 300 and "\n" not in out
    assert out.startswith("transcription failed: RuntimeError")
    assert out.endswith("Invalid data found when processing input")
    assert "configuration line 0" not in out


def test_summarize_error_leaves_short_messages_alone():
    assert main.summarize_error("audio download failed: HTTP 404") == "audio download failed: HTTP 404"
    assert main.summarize_error("") == ""


def test_state_file_records_the_root_cause_of_a_transcription_crash(tmp_path):
    class Crashing(FakeTranscriber):
        def transcribe(self, path):
            raise RuntimeError("Failed to load audio: ffmpeg version 9\n" + FFMPEG_BANNER
                               + "\nError opening input files: Invalid data found when processing input")

    run_batch(CFG, deps(tmp_path, [call(1)], transcriber=Crashing()))
    entry = next(iter(json.loads((tmp_path / "state.json").read_text()).values()))
    assert entry["last_error"].endswith("Invalid data found when processing input")
    assert len(entry["last_error"]) <= 300


def test_verbose_mode_silences_network_library_debug_logs():
    import logging

    main.configure_logging(verbose=True)
    try:
        assert logging.getLogger("worker").getEffectiveLevel() == logging.DEBUG
        for noisy in ("httpx", "httpcore", "huggingface_hub"):
            assert logging.getLogger(noisy).getEffectiveLevel() >= logging.WARNING, noisy
        assert logging.getLogger("httpcore.http11").getEffectiveLevel() >= logging.WARNING
    finally:
        logging.getLogger().setLevel(logging.WARNING)


# --- calls CallRail says it no longer has: wait if recent, otherwise retire (not junk, not failed) ----

GONE_MSG = "This call is no longer available."


def gone(*recordings):
    return {r: RecordingUnavailable(GONE_MSG) for r in recordings}


def test_unavailable_recording_is_retired_without_touching_ai_cells_or_state(tmp_path):
    d = deps(tmp_path, [call(1, ended_min_ago=120), call(2)], fetcher=FakeFetcher(errors=gone("r1")))
    summary = run_batch(CFG, d)
    assert d.webhook.updates[0] == ("c1", {"mark_processed": True}), "stamped processed, no N/A written"
    assert [u[0] for u in d.webhook.updates] == ["c1", "c2"], "other rows still enrich"
    assert summary.unavailable == 1 and summary.deferred == 0 and summary.not_conversation == 0 and summary.skipped == 0
    assert not d.state.is_parked(call(1)) and d.state._data == {}, "never counted as a failure"
    assert d.fetcher.account_checks == 1, "the account is confirmed before a row is retired"


def test_a_call_with_no_readable_start_time_is_judged_as_before_not_deferred(tmp_path):
    d = deps(tmp_path, [call(1)], fetcher=FakeFetcher(errors=gone("r1")))  # no date_time at all
    summary = run_batch(CFG, d)
    assert summary.unavailable == 1 and summary.deferred == 0
    assert d.webhook.updates == [("c1", {"mark_processed": True})]


def test_unavailable_recording_dry_run_writes_nothing(tmp_path):
    d = deps(tmp_path, [call(1, ended_min_ago=120)], fetcher=FakeFetcher(errors=gone("r1")))
    summary = run_batch(CFG, d, dry_run=True)
    assert d.webhook.updates == [] and summary.results == [("c1", {"mark_processed": True})]


def test_a_call_inside_the_grace_period_is_deferred_not_retired_or_failed(tmp_path, caplog):
    d = deps(tmp_path, [call(1, ended_min_ago=5), call(2)], fetcher=FakeFetcher(errors=gone("r1")))
    with caplog.at_level(logging.INFO, logger="worker"):
        summary = run_batch(CFG, d)
    assert [u[0] for u in d.webhook.updates] == ["c2"], "nothing is written for the young call; others still enrich"
    assert (summary.deferred, summary.unavailable, summary.skipped, summary.not_conversation) == (1, 0, 0, 0)
    assert d.state._data == {}, "no failure recorded"
    assert d.fetcher.account_checks == 0, "no account request for a call that is simply too new"
    text = caplog.text
    assert "c1" in text and "grace period" in text and "ended 5 min ago" in text and "30 min" in text
    assert "deferred=1" in summary.line()
    assert "SECRET" not in text, "recording URLs and their keys stay out of the log"


def test_a_deferred_call_is_never_parked_however_many_runs_defer_it(tmp_path):
    d = deps(tmp_path, [call(1, ended_min_ago=5)], fetcher=FakeFetcher(errors=gone("r1")))
    for _ in range(main.MAX_FAILURES + 3):
        summary = run_batch(CFG, d)
        assert (summary.deferred, summary.parked, summary.skipped) == (1, 0, 0)
    assert d.state._data == {} and not d.state.is_parked(call(1)) and d.webhook.updates == []


def test_the_grace_period_is_thirty_minutes_and_ends_exactly_there(tmp_path):
    assert main.RECORDING_GRACE_MINUTES == 30
    just_inside = deps(tmp_path, [call(1, ended_min_ago=29.9)], fetcher=FakeFetcher(errors=gone("r1")))
    assert run_batch(CFG, just_inside).deferred == 1 and just_inside.webhook.updates == []

    at_the_limit = deps(tmp_path, [call(1, ended_min_ago=30)], fetcher=FakeFetcher(errors=gone("r1")))
    summary = run_batch(CFG, at_the_limit)
    assert (summary.unavailable, summary.deferred) == (1, 0)
    assert at_the_limit.webhook.updates == [("c1", {"mark_processed": True})]


def test_the_grace_period_is_measured_from_the_end_of_the_call(tmp_path):
    # Started 40 minutes ago and lasted 20: it ended 20 minutes ago, so still inside the grace period.
    d = deps(tmp_path, [call(1, dur=1200, ended_min_ago=20)], fetcher=FakeFetcher(errors=gone("r1")))
    assert run_batch(CFG, d).deferred == 1


def test_a_deferred_call_is_retired_once_it_ages_past_the_grace_period(tmp_path):
    items = [call(1, ended_min_ago=10)]
    fetcher = FakeFetcher(errors=gone("r1"))
    first = deps(tmp_path, items, fetcher=fetcher)
    assert run_batch(CFG, first).deferred == 1 and first.webhook.updates == []

    later = deps(tmp_path, items, fetcher=fetcher, now=NOW + timedelta(minutes=25))  # call now 35 min old
    summary = run_batch(CFG, later)
    assert (summary.unavailable, summary.deferred) == (1, 0)
    assert later.webhook.updates == [("c1", {"mark_processed": True})]


def test_an_old_call_whose_account_cannot_be_confirmed_is_an_ordinary_retried_failure(tmp_path):
    d = deps(tmp_path, [call(1, ended_min_ago=120)], fetcher=FakeFetcher(errors=gone("r1"), account_ok=False))
    summary = run_batch(CFG, d)
    assert d.webhook.updates == [], "never retired on an unconfirmed account"
    assert (summary.skipped, summary.unavailable, summary.deferred) == (1, 0, 0)
    assert list(d.state._data.values())[0]["failures"] == 1, "counts toward parking, as any failure does"


def test_deferral_covers_only_unavailable_recordings_other_fetch_errors_still_count(tmp_path):
    d = deps(tmp_path, [call(1, ended_min_ago=5)], fetcher=FakeFetcher(errors={"r1": FetchError("HTTP 500")}))
    summary = run_batch(CFG, d)
    assert (summary.skipped, summary.deferred) == (1, 0)


def test_deferred_call_dry_run_reports_nothing_and_writes_nothing(tmp_path):
    d = deps(tmp_path, [call(1, ended_min_ago=5)], fetcher=FakeFetcher(errors=gone("r1")))
    summary = run_batch(CFG, d, dry_run=True)
    assert d.webhook.updates == [] and summary.results == [] and summary.deferred == 1


def test_audio_is_deleted_right_after_each_row_even_when_transcription_crashes(tmp_path):
    seen, leftover_at_next_row = [], []

    class Watching(FakeTranscriber):
        def transcribe(self, path):
            leftover_at_next_row.extend(p for p in seen if p.exists())  # checked while the batch is still running
            seen.append(path)
            if path.stem == FailureState.key(call(1)):
                raise RuntimeError("ffmpeg failed")
            return LONG

    d = deps(tmp_path, [call(1), call(2)], transcriber=Watching())
    run_batch(CFG, d)
    assert len(seen) == 2 and leftover_at_next_row == [], "a crashed row's recording is gone before the next row starts"
