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
    full = {"caller_tone": "Stressed", "mentioned_damage": ["flat tire"], "lead_source": "Google Maps / Organic"}
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


def make_deps(base, tmp_path, transcript=None, fetcher=None, llm_allowed=True):
    @contextlib.contextmanager
    def whisper():
        yield SpeechModel() if transcript is None else SpeechModel(transcript)

    @contextlib.contextmanager
    def llm():
        if not llm_allowed:
            raise AssertionError("the LLM must not be loaded for this call")
        yield Enricher(scripted_llm)

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
