"""End to end against the REAL apps-script/Code.gs (via tests/mock-webhook.js).

Real: WebhookClient, run_batch, Enricher + Pydantic, and the Apps Script AI endpoint.
Scripted: audio download, transcription and the LLM text (no model is loaded).
"""

import contextlib
import json
import re
import shutil
import socket
import subprocess
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

from enricher import Enricher
from main import Config, Deps, FailureState, run_batch
from webhook import AudioFetcher, WebhookClient

REPO = Path(__file__).resolve().parents[2]
SECRET = "test-api-secret"  # the mock server's API_SECRET

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is needed for the mock webhook")


@pytest.fixture()
def server():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    proc = subprocess.Popen(["node", str(REPO / "tests" / "mock-webhook.js"), str(port)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    try:
        for _ in range(100):
            try:
                httpx.get(f"{base}/rows", timeout=1)
                break
            except httpx.HTTPError:
                time.sleep(0.05)
        else:
            pytest.fail("mock webhook did not start")
        yield base
    finally:
        proc.terminate()
        proc.wait(timeout=5)


def callrail(base, n, **extra):
    body = {
        "customer_phone_number": f"+1916555{n:04d}",
        "start_time": "2026-10-02T14:40:00.000-07:00",
        "duration": "120",
        "recording": f"https://media.example.com/rec{n}.mp3",
        **extra,
    }
    out = httpx.post(f"{base}/exec", params={"source": "callrail", "token": SECRET}, json=body).json()
    assert out["ok"], out
    return out


def rows(base):
    return {r["Call_Recording_URL"]: r for r in httpx.get(f"{base}/rows").json()}


def scripted_llm(messages):
    """Answers with exactly the keys the prompt asks for, like a well-behaved model."""
    keys = re.search(r"exactly these keys: ([a-z_, ]+)\.", messages[0]["content"]).group(1).split(", ")
    full = {"call_intent": "NEW_LEAD", "admin_summary": None, "caller_tone": "Stressed",
            "mentioned_damage": ["flat tire"], "lead_source": "Google Maps / Organic"}
    return json.dumps({k: full[k] for k in keys})


class FileFetcher:
    def fetch(self, url, dest, stem="call"):
        path = dest / f"{stem}.mp3"
        path.write_bytes(b"audio")
        return path


class SpeechModel:
    def __init__(self, text="Hi, I have a flat tire on I-80 and I'm in a hurry. I found you on Google Maps."):
        self.text = text

    def transcribe(self, path):
        return self.text


class ForbiddenFetcher:
    def fetch(self, *args, **kwargs):
        raise AssertionError("audio must not be downloaded for this call")


def make_deps(base, tmp_path, transcript=None, fetcher=None, llm_allowed=True, generate=None):
    @contextlib.contextmanager
    def whisper():
        yield SpeechModel() if transcript is None else SpeechModel(transcript)

    @contextlib.contextmanager
    def llm():
        if not llm_allowed:
            raise AssertionError("the LLM must not be loaded for this call")
        yield Enricher(generate or scripted_llm)

    return Deps(
        webhook=WebhookClient(f"{base}/exec", SECRET, httpx.Client(follow_redirects=True)),
        fetcher=fetcher or FileFetcher(),
        state=FailureState(tmp_path / "state.json"),
        transcriber=whisper,
        enricher=llm,
    )


CFG = Config(callrail_api_key="k", webhook_url="http://127.0.0.1/exec", api_secret=SECRET)


def test_worker_fills_ai_columns_without_touching_callrail_attribution(server, tmp_path):
    callrail(server, 1, source="Google Ads")  # CallRail attributed this one
    callrail(server, 2)                        # no attribution: the AI may fill Lead_Source

    summary = run_batch(CFG, make_deps(server, tmp_path))
    assert (summary.pending, summary.updated, summary.skipped) == (2, 2, 0)

    by_url = rows(server)
    attributed = by_url["https://media.example.com/rec1.mp3"]
    unattributed = by_url["https://media.example.com/rec2.mp3"]

    assert attributed["Lead_Source"] == "Google Ads", "CallRail attribution is never overwritten"
    assert unattributed["Lead_Source"] == "Google Maps / Organic", "AI fills a blank Lead_Source"
    for row in (attributed, unattributed):
        assert row["Caller_Tone"] == "Stressed"
        assert row["Mentioned_Damage"] == "flat tire"
        assert row["AI_Processed_At"]
        # Dispatcher columns stay exactly as CallRail left them.
        assert row["Quoted_Price"] == "" and row["Outcome"] == "" and row["Caller_Type"] == ""

    # Processed rows leave the queue: a second run has nothing to do and loads no model.
    again = run_batch(CFG, make_deps(server, tmp_path))
    assert (again.pending, again.updated) == (0, 0)


def test_dry_run_leaves_the_sheet_untouched(server, tmp_path):
    callrail(server, 3)
    summary = run_batch(CFG, make_deps(server, tmp_path), dry_run=True)
    assert summary.results and summary.updated == 0
    row = rows(server)["https://media.example.com/rec3.mp3"]
    assert row["Caller_Tone"] == "" and row["AI_Processed_At"] == ""


def test_audio_fetcher_class_is_wired_for_real_use():
    # Guards the constructor signature main.build_deps relies on.
    AudioFetcher("key", httpx.Client(follow_redirects=False))


def test_unanswered_call_is_closed_at_ingestion_and_the_worker_never_sees_it(server, tmp_path):
    callrail(server, 4, answered=False, source="Google Ads")
    row = rows(server)["https://media.example.com/rec4.mp3"]
    assert (row["Caller_Tone"], row["Mentioned_Damage"]) == ("N/A", "N/A")
    assert row["AI_Processed_At"] and row["Lead_Source"] == "Google Ads"

    summary = run_batch(CFG, make_deps(server, tmp_path, fetcher=ForbiddenFetcher(), llm_allowed=False))
    assert summary.pending == 0


def test_carrier_message_on_an_answered_looking_call_is_recorded_as_na_without_the_llm(server, tmp_path):
    callrail(server, 5, source="Google Ads", duration="40")  # looks live: only the transcript gives it away
    carrier = "We're sorry, your call cannot be completed as dialed."
    summary = run_batch(CFG, make_deps(server, tmp_path, transcript=carrier, llm_allowed=False))
    assert (summary.pending, summary.updated, summary.not_conversation, summary.skipped) == (1, 1, 1, 0)

    row = rows(server)["https://media.example.com/rec5.mp3"]
    assert (row["Caller_Tone"], row["Mentioned_Damage"]) == ("N/A", "N/A")
    assert row["Lead_Source"] == "Google Ads", "CallRail attribution untouched"
    assert row["AI_Processed_At"]
    assert run_batch(CFG, make_deps(server, tmp_path, llm_allowed=False)).pending == 0


def test_a_nine_second_call_is_closed_at_ingestion_from_its_duration_alone(server):
    callrail(server, 6, duration="9")
    row = rows(server)["https://media.example.com/rec6.mp3"]
    assert (row["Caller_Tone"], row["Mentioned_Damage"]) == ("N/A", "N/A")


# --- the real fetcher against a faked CallRail ------------------------------------------------------

FAKE_ACCOUNT = "123456789"  # obviously fake; the real account id lives only in worker/.env
APP_LINK = "https://app.callrail.com/calls/CAL0000000000000000000000000000AA/recording/redirect?access_key=k"
MP3 = b"ID3\x03\x00\x00\x00\x00\x00\x15" + b"\x00" * 60


def deps_with_callrail(base, tmp_path, handler):
    deps = make_deps(base, tmp_path)
    deps.fetcher = AudioFetcher("cr-key", httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False),
                                account_id=FAKE_ACCOUNT)
    return deps


def test_app_link_in_the_sheet_is_downloaded_through_the_documented_api_endpoint(server, tmp_path):
    callrail(server, 7, recording=APP_LINK, source="Google Ads")
    requested = []

    def handler(request):
        requested.append((request.url.host, request.url.path, request.headers.get("authorization")))
        if request.url.host == "api.callrail.com":
            return httpx.Response(302, headers={"location": "https://bucket.s3.amazonaws.com/a.mp3"})
        return httpx.Response(200, content=MP3, headers={"content-type": "audio/mpeg"})

    summary = run_batch(CFG, deps_with_callrail(server, tmp_path, handler))
    assert (summary.updated, summary.skipped) == (1, 0)
    assert requested == [
        ("api.callrail.com", f"/v3/a/{FAKE_ACCOUNT}/calls/CAL0000000000000000000000000000AA/recording.json",
         "Token token=cr-key"),
        ("bucket.s3.amazonaws.com", "/a.mp3", None),
    ]
    assert rows(server)[APP_LINK]["Caller_Tone"] == "Stressed"


def test_a_placeholder_page_instead_of_audio_is_rejected_with_a_readable_reason(server, tmp_path):
    callrail(server, 8, recording=APP_LINK)
    handler = lambda request: httpx.Response(200, content=b"Recording unavailable", headers={"content-type": "text/plain"})  # noqa: E731

    summary = run_batch(CFG, deps_with_callrail(server, tmp_path, handler))
    assert (summary.skipped, summary.updated) == (1, 0)
    entry = next(iter(json.loads((tmp_path / "state.json").read_text()).values()))
    assert "not audio" in entry["last_error"] and "text/plain" in entry["last_error"]
    assert "ffmpeg" not in entry["last_error"], "never reached the decoder"
    assert FAKE_ACCOUNT not in entry["last_error"]
    assert rows(server)[APP_LINK]["Caller_Tone"] == "", "nothing was guessed or written"


# --- "no longer available" through the real fetcher and the real Apps Script ---------------------------

GONE = {"error": "This call is no longer available."}
# callrail(): start 14:40 -07:00 = 21:40Z, 120 s long, so the call ends at 21:42Z.
CALL_ENDED = datetime(2026, 10, 2, 21, 42, 0, tzinfo=timezone.utc)


def unavailable_handler(account_ok=True, seen=None):
    def handler(request):
        if seen is not None:
            seen.append(request.url.path)
        if request.url.path.endswith("recording.json"):
            return httpx.Response(200, json=GONE)
        if request.url.path == f"/v3/a/{FAKE_ACCOUNT}.json":
            return httpx.Response(200, json={"id": "ACC1", "numeric_id": int(FAKE_ACCOUNT)}) if account_ok \
                else httpx.Response(404, json={"error": "Not found"})
        raise AssertionError(f"unexpected request {request.url}")
    return handler


def run_at(server, tmp_path, minutes_after_call, handler):
    deps = deps_with_callrail(server, tmp_path, handler)
    deps.clock = lambda: CALL_ENDED + timedelta(minutes=minutes_after_call)
    return run_batch(CFG, deps), deps


def test_a_fresh_call_whose_recording_is_not_ready_waits_and_is_then_retired_blank(server, tmp_path):
    callrail(server, 9, recording=APP_LINK, source="Google Ads")
    row = lambda: rows(server)[APP_LINK]  # noqa: E731
    seen = []

    # 5 minutes after the call: deferred. Nothing written, no account request, no failure recorded.
    summary, _ = run_at(server, tmp_path, 5, unavailable_handler(seen=seen))
    assert (summary.pending, summary.deferred, summary.unavailable, summary.skipped) == (1, 1, 0, 0)
    assert row()["AI_Processed_At"] == "" and row()["Caller_Tone"] == ""
    assert not any(p.endswith(f"{FAKE_ACCOUNT}.json") for p in seen), "the account was not even checked"
    assert not (tmp_path / "state.json").exists() or json.loads((tmp_path / "state.json").read_text()) == {}

    # Still pending on the next run (it was never closed or parked).
    summary, _ = run_at(server, tmp_path, 20, unavailable_handler())
    assert (summary.pending, summary.deferred) == (1, 1)

    # 31 minutes after the call: the account checks out, so the row is retired with the AI cells blank.
    summary, _ = run_at(server, tmp_path, 31, unavailable_handler(seen=seen))
    assert (summary.unavailable, summary.deferred, summary.skipped) == (1, 0, 0)
    assert row()["AI_Processed_At"], "stamped processed: it leaves the queue"
    assert row()["Caller_Tone"] == "" and row()["Mentioned_Damage"] == "", "AI cells stay blank, not N/A"
    assert row()["Lead_Source"] == "Google Ads", "CallRail attribution untouched"
    again, _ = run_at(server, tmp_path, 60, unavailable_handler())
    assert again.pending == 0


def test_an_old_call_is_never_retired_when_the_account_check_fails(server, tmp_path):
    callrail(server, 10, recording=APP_LINK)
    summary, _ = run_at(server, tmp_path, 120, unavailable_handler(account_ok=False))
    assert (summary.skipped, summary.unavailable) == (1, 0)
    assert rows(server)[APP_LINK]["AI_Processed_At"] == "", "a wrong key or account id cannot retire real calls"
    entry = next(iter(json.loads((tmp_path / "state.json").read_text()).values()))
    assert entry["failures"] == 1 and "account check failed" in entry["last_error"]
    assert FAKE_ACCOUNT not in entry["last_error"]


# --- call intent: the three kinds of call, end to end ---------------------------------------------


def run_one(server, tmp_path, n, transcript):
    """Create one CallRail row, run the real batch on it with a scripted model, return (summary, row)."""
    from transcripts import ANSWERS

    def generate(messages):
        keys = re.search(r"exactly these keys: ([a-z_, ]+)\.", messages[0]["content"]).group(1).split(", ")
        return json.dumps({k: ANSWERS[transcript][k] for k in keys})

    callrail(server, n, source="Google Ads")
    summary = run_batch(CFG, make_deps(server, tmp_path, transcript=transcript, generate=generate))
    return summary, rows(server)[f"https://media.example.com/rec{n}.mp3"]


def test_a_flatbed_quote_is_a_new_lead_a_delivery_check_and_a_gate_hours_call_are_not(server, tmp_path):
    from transcripts import ADJUSTER_STATUS, INSURANCE_QUOTE, STORAGE_HOURS

    s1, lead = run_one(server, tmp_path, 1, INSURANCE_QUOTE)
    assert (s1.updated, s1.operational, s1.not_conversation) == (1, 0, 0)
    assert lead["Call_Intent"] == "NEW_LEAD" and lead["Admin_Summary"] == ""
    assert lead["Caller_Tone"] == "Cooperative" and lead["Mentioned_Damage"] == "front bumper pushed in, not driveable"
    assert lead["Lead_Source"] == "Google Ads", "CallRail attribution untouched"

    s2, status = run_one(server, tmp_path, 2, ADJUSTER_STATUS)
    assert (s2.updated, s2.operational, s2.not_conversation) == (1, 1, 0)
    assert status["Call_Intent"] == "STATUS_CHECK"
    assert status["Admin_Summary"].startswith("Copart rep checking delivery")
    assert (status["Caller_Tone"], status["Mentioned_Damage"]) == ("N/A", "N/A")
    assert status["AI_Processed_At"], "it leaves the queue"

    s3, admin = run_one(server, tmp_path, 3, STORAGE_HOURS)
    assert (s3.updated, s3.operational) == (1, 1)
    assert admin["Call_Intent"] == "ADMIN_INQUIRY" and "storage gate hours" in admin["Admin_Summary"]
    assert (admin["Caller_Tone"], admin["Mentioned_Damage"]) == ("N/A", "N/A")

    # Dispatcher columns are untouched on every row, and nothing is queued again.
    for row in (lead, status, admin):
        assert row["Outcome"] == "" and row["Quoted_Price"] == "" and row["Notes_Comments"] == ""
    assert run_batch(CFG, make_deps(server, tmp_path, llm_allowed=False)).pending == 0


def test_the_conversion_filter_a_sheet_user_would_apply_separates_leads_from_check_ins(server, tmp_path):
    from transcripts import ADJUSTER_STATUS, INSURANCE_QUOTE, STORAGE_HOURS

    for n, transcript in enumerate((INSURANCE_QUOTE, ADJUSTER_STATUS, STORAGE_HOURS), start=1):
        run_one(server, tmp_path, n, transcript)
    everything = list(rows(server).values())
    sales = [r for r in everything if r["Call_Intent"] == "NEW_LEAD"]
    assert len(everything) == 3 and len(sales) == 1
