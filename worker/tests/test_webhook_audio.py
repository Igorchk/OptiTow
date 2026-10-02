import json

import httpx
import pytest

from webhook import (
    AudioFetcher,
    FetchError,
    PendingCall,
    WebhookClient,
    WebhookFatal,
    WebhookRejected,
    WebhookTransient,
    is_callrail_host,
    redact,
)

URL = "https://script.google.com/macros/s/ABC/exec"
KEY = "cr-key-123"
AUTH = f"Token token={KEY}"


# --- webhook client -----------------------------------------------------------


def client_for(handler):
    return WebhookClient(URL, "s3cret", httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True))


def json_response(body, status=200):
    return httpx.Response(status, json=body)


def test_pending_posts_token_and_parses_items():
    seen = {}

    def handler(request):
        seen["query"] = dict(request.url.params)
        seen["body"] = json.loads(request.content)
        return json_response({"ok": True, "items": [{
            "call_id": "c1", "call_recording_url": "https://x/r", "lead_source": "", "caller_tone": "Calm",
            "mentioned_damage": "", "call_duration_sec": 90, "customer_phone": "916-555-0199"}]})

    items = client_for(handler).pending(10)
    assert seen["query"] == {"source": "ai"}
    assert seen["body"] == {"token": "s3cret", "action": "pending", "limit": 10}
    assert items[0].call_id == "c1"
    assert items[0].blank_fields() == ["mentioned_damage", "lead_source"]


def test_blank_fields_treats_whitespace_as_blank():
    call = PendingCall("c", "u", "  ", "x", "Other")
    assert call.blank_fields() == ["caller_tone"]


def test_update_sends_recording_url_and_returns_warnings():
    seen = {}

    def handler(request):
        seen.update(json.loads(request.content))
        return json_response({"ok": True, "warnings": ["Ignored Lead_Source: already set."]})

    call = PendingCall("c1", "https://x/r", "", "", "")
    warnings = client_for(handler).update(call, {"caller_tone": "Calm"})
    assert seen["call_id"] == "c1" and seen["call_recording_url"] == "https://x/r"
    assert seen["action"] == "update" and seen["caller_tone"] == "Calm"
    assert warnings == ["Ignored Lead_Source: already set."]


@pytest.mark.parametrize("code,exc", [
    ("UNAUTHORIZED", WebhookFatal), ("SERVER_MISCONFIGURED", WebhookFatal),
    ("BAD_REQUEST", WebhookRejected), ("NOT_FOUND", WebhookRejected),
    ("BUSY", WebhookTransient), ("INTERNAL", WebhookTransient), ("BRAND_NEW", WebhookTransient),
])
def test_error_codes_map_to_the_right_reaction(code, exc):
    client = client_for(lambda r: json_response({"ok": False, "code": code, "error": "nope"}))
    with pytest.raises(exc):
        client.pending(1)


def test_non_json_reply_is_fatal_and_server_errors_are_transient():
    with pytest.raises(WebhookFatal):
        client_for(lambda r: httpx.Response(200, text="<html>Sign in</html>")).pending(1)
    with pytest.raises(WebhookTransient):
        client_for(lambda r: httpx.Response(503, text="x")).pending(1)


def test_network_errors_are_transient():
    def handler(request):
        raise httpx.ConnectError("down")

    with pytest.raises(WebhookTransient):
        client_for(handler).pending(1)


def test_apps_script_post_redirect_is_followed():
    def handler(request):
        if request.url.host == "script.google.com":
            return httpx.Response(302, headers={"location": "https://script.googleusercontent.com/macros/echo?x=1"})
        assert request.method == "GET", "302 after POST must be followed as GET"
        return json_response({"ok": True, "items": []})

    assert client_for(handler).pending(1) == []


# --- audio fetching -----------------------------------------------------------


def fetcher(handler, **kwargs):
    return AudioFetcher(KEY, httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False), **kwargs)


def test_direct_third_party_url_is_fetched_without_the_api_key(tmp_path):
    seen = []

    def handler(request):
        seen.append((str(request.url.host), request.headers.get("authorization")))
        return httpx.Response(200, content=b"ID3audio", headers={"content-type": "audio/mpeg"})

    path = fetcher(handler).fetch("https://media.example.com/rec/1.mp3?sig=abc", tmp_path, stem="a")
    assert path.read_bytes() == b"ID3audio" and path.suffix == ".mp3"
    assert seen == [("media.example.com", None)]


def test_callrail_api_url_is_authenticated_and_json_url_is_followed_without_the_key(tmp_path):
    seen = []

    def handler(request):
        seen.append((request.url.host, request.headers.get("authorization")))
        if request.url.host == "api.callrail.com":
            return httpx.Response(200, json={"url": "https://bucket.s3.amazonaws.com/rec.mp3?X-Amz-Sig=1"})
        return httpx.Response(200, content=b"audio", headers={"content-type": "audio/mpeg"})

    fetcher(handler).fetch("https://api.callrail.com/v3/a/ACC/calls/CAL1/recording.json", tmp_path)
    assert seen == [("api.callrail.com", AUTH), ("bucket.s3.amazonaws.com", None)]


def test_other_callrail_hosts_try_anonymous_first_then_authenticate_on_401(tmp_path):
    seen = []

    def handler(request):
        auth = request.headers.get("authorization")
        seen.append(auth)
        if auth is None:
            return httpx.Response(401)
        return httpx.Response(200, content=b"audio", headers={"content-type": "audio/mpeg"})

    fetcher(handler).fetch("https://app.callrail.com/calls/CAL1/recording/redirect?access_key=k", tmp_path)
    assert seen == [None, AUTH]


def test_api_key_never_follows_a_redirect_to_another_host(tmp_path):
    seen = []

    def handler(request):
        seen.append((request.url.host, request.headers.get("authorization")))
        if request.url.host == "api.callrail.com":
            return httpx.Response(302, headers={"location": "https://evil.example.net/steal"})
        return httpx.Response(200, content=b"audio", headers={"content-type": "audio/mpeg"})

    fetcher(handler).fetch("https://api.callrail.com/v3/a/A/calls/C/recording", tmp_path)
    assert seen == [("api.callrail.com", AUTH), ("evil.example.net", None)]


def test_lookalike_hosts_are_not_treated_as_callrail():
    assert is_callrail_host("api.callrail.com") and is_callrail_host("callrail.com")
    assert not is_callrail_host("callrail.com.evil.net")
    assert not is_callrail_host("evilcallrail.com")
    assert not is_callrail_host(None)


def test_refuses_http_and_reports_errors(tmp_path):
    f = fetcher(lambda r: httpx.Response(200, content=b"x"))
    with pytest.raises(FetchError, match="non-https"):
        f.fetch("http://media.example.com/a.mp3", tmp_path)
    with pytest.raises(FetchError, match="HTTP 404"):
        fetcher(lambda r: httpx.Response(404)).fetch("https://media.example.com/a.mp3", tmp_path)
    with pytest.raises(FetchError, match="empty"):
        fetcher(lambda r: httpx.Response(200, content=b"", headers={"content-type": "audio/mpeg"})).fetch(
            "https://media.example.com/a.mp3", tmp_path)


def test_size_cap_and_redirect_loops(tmp_path):
    big = fetcher(lambda r: httpx.Response(200, content=b"x" * 100, headers={"content-type": "audio/mpeg"}), max_bytes=10)
    with pytest.raises(FetchError, match="larger"):
        big.fetch("https://media.example.com/a.mp3", tmp_path)
    assert not list(tmp_path.iterdir()), "partial file removed"
    loop = fetcher(lambda r: httpx.Response(302, headers={"location": "https://media.example.com/again"}))
    with pytest.raises(FetchError, match="too many redirects"):
        loop.fetch("https://media.example.com/a.mp3", tmp_path)


def test_network_failure_is_a_fetch_error(tmp_path):
    def handler(request):
        raise httpx.ReadTimeout("slow")

    with pytest.raises(FetchError, match="network"):
        fetcher(handler).fetch("https://media.example.com/a.mp3", tmp_path)


def test_redact_drops_the_query_string():
    assert redact("https://app.callrail.com/calls/1/recording?access_key=SECRET") == \
        "https://app.callrail.com/calls/1/recording"
