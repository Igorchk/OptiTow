import json

import httpx
import pytest

from webhook import (
    AudioFetcher,
    FetchError,
    RecordingUnavailable,
    PendingCall,
    WebhookClient,
    WebhookFatal,
    WebhookRejected,
    WebhookTransient,
    is_callrail_host,
    redact,
)

URL = "https://script.google.com/macros/s/ABC/exec"
ACCOUNT = "123456789"  # obviously fake: the real account id lives only in worker/.env
KEY = "cr-key-123"
# The first bytes of a real MP3 (ID3 tag): non-printable, unlike an error page.
MP3 = b"ID3\x03\x00\x00\x00\x00\x00\x15" + b"\x00" * 60
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
        return httpx.Response(200, content=MP3, headers={"content-type": "audio/mpeg"})

    path = fetcher(handler).fetch("https://media.example.com/rec/1.mp3?sig=abc", tmp_path, stem="a")
    assert path.read_bytes() == MP3 and path.suffix == ".mp3"
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


# --- documented API endpoint -------------------------------------------------------------------

APP_LINK = "https://app.callrail.com/calls/CAL01a0ffd019f479a5a54db4bd9eb6101d/recording/redirect"
API_LINK = f"https://api.callrail.com/v3/a/{ACCOUNT}/calls/CAL01a0ffd019f479a5a54db4bd9eb6101d/recording.json"


def api_fetcher(handler, **kwargs):
    return AudioFetcher(KEY, httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=False),
                        account_id=ACCOUNT, **kwargs)


def test_app_links_are_fetched_through_the_documented_api_endpoint(tmp_path):
    seen = []

    def handler(request):
        seen.append((str(request.url), request.headers.get("authorization")))
        if request.url.host == "api.callrail.com":
            return httpx.Response(302, headers={"location": "https://bucket.s3.amazonaws.com/rec.mp3?X-Amz-Sig=1"})
        return httpx.Response(200, content=MP3, headers={"content-type": "audio/mpeg"})

    api_fetcher(handler).fetch(APP_LINK + "?access_key=abc", tmp_path)
    assert seen == [(API_LINK, AUTH), ("https://bucket.s3.amazonaws.com/rec.mp3?X-Amz-Sig=1", None)], \
        "the app link is never requested, and the key never reaches the storage host"


def test_resolve_only_rewrites_callrail_app_links():
    f = AudioFetcher(KEY, account_id=ACCOUNT)
    assert f.resolve(APP_LINK) == API_LINK
    assert f.resolve(APP_LINK + "?access_key=abc") == API_LINK
    assert f.resolve(API_LINK) == API_LINK, "already the API endpoint"
    assert f.resolve("https://media.example.com/rec/CAL123/1.mp3") == "https://media.example.com/rec/CAL123/1.mp3"
    assert f.resolve("https://app.callrail.com/dashboard") == "https://app.callrail.com/dashboard", "no call id"
    assert f.resolve("https://callrail.com.evil.net/calls/CAL1/recording/redirect").startswith("https://callrail.com.evil")
    assert AudioFetcher(KEY).resolve(APP_LINK) == APP_LINK, "without an account id nothing is rewritten"


# --- reject non-audio before ffmpeg sees it -------------------------------------------------------


@pytest.mark.parametrize("ctype,body", [
    ("text/plain; charset=utf-8", b"Unauthorized"),
    ("text/html", b"<html><body>Sign in</body></html>"),
    ("application/xml", b"<error>nope</error>"),
    ("application/json", None),  # JSON without a "url" is handled (and rejected) earlier
])
def test_non_audio_content_types_are_rejected_with_a_clear_message(tmp_path, ctype, body):
    def handler(request):
        if body is None:
            return httpx.Response(200, json={"error": "nope"})
        return httpx.Response(200, content=body, headers={"content-type": ctype})

    with pytest.raises(FetchError) as err:
        fetcher(handler).fetch("https://media.example.com/a.mp3", tmp_path)
    assert not list(tmp_path.iterdir()), "nothing is left behind for ffmpeg"
    if body is not None:
        assert "not audio" in str(err.value) and ctype.split(";")[0] in str(err.value)


def test_the_rejection_shows_a_short_snippet_of_what_came_back(tmp_path):
    def handler(request):
        return httpx.Response(200, content=b"Recording\nnot   available " + b"x" * 200, headers={"content-type": "text/plain"})

    with pytest.raises(FetchError) as err:
        fetcher(handler).fetch("https://media.example.com/a.mp3", tmp_path)
    message = str(err.value)
    assert 'starting "Recording not available' in message and "\n" not in message and len(message) < 200


@pytest.mark.parametrize("ctype", ["audio/mpeg", "audio/x-wav", "video/mp4", "application/ogg"])
def test_audio_content_types_are_accepted(tmp_path, ctype):
    f = fetcher(lambda r: httpx.Response(200, content=MP3, headers={"content-type": ctype}))
    assert f.fetch("https://media.example.com/a", tmp_path).read_bytes() == MP3


@pytest.mark.parametrize("headers", [{"content-type": "application/octet-stream"}, {"content-type": "binary/octet-stream"}, {}])
def test_generic_or_missing_types_are_accepted_only_if_the_bytes_are_binary(tmp_path, headers):
    ok = fetcher(lambda r: httpx.Response(200, content=MP3, headers=headers))
    assert ok.fetch("https://media.example.com/a.mp3", tmp_path).read_bytes() == MP3
    page = fetcher(lambda r: httpx.Response(200, content=b"<html>Please sign in</html>", headers=headers))
    with pytest.raises(FetchError, match="not audio"):
        page.fetch("https://media.example.com/b.mp3", tmp_path, stem="page")
    assert [p.name for p in tmp_path.iterdir()] == ["call.mp3"], "the rejected page was not kept"


def test_account_number_is_masked_in_logged_urls():
    assert redact(API_LINK) == "https://api.callrail.com/v3/a/<account>/calls/CAL01a0ffd019f479a5a54db4bd9eb6101d/recording.json"
    assert ACCOUNT not in redact(API_LINK)


def test_http_errors_from_the_api_endpoint_do_not_leak_the_account_number(tmp_path):
    with pytest.raises(FetchError) as err:
        api_fetcher(lambda r: httpx.Response(401)).fetch(APP_LINK, tmp_path)
    assert "HTTP 401" in str(err.value) and ACCOUNT not in str(err.value)


# --- "This call is no longer available." -----------------------------------------------------------

GONE = {"error": "This call is no longer available."}


def test_a_vanished_call_is_recording_unavailable_once_the_account_checks_out(tmp_path):
    seen = []

    def handler(request):
        seen.append(str(request.url))
        if request.url.path.endswith("recording.json"):
            return httpx.Response(200, json=GONE)
        return httpx.Response(200, json={"id": "ACC1", "numeric_id": int(ACCOUNT)})

    f = api_fetcher(handler)
    with pytest.raises(RecordingUnavailable):
        f.fetch(APP_LINK, tmp_path)
    assert seen[-1] == f"https://api.callrail.com/v3/a/{ACCOUNT}.json"
    with pytest.raises(RecordingUnavailable):
        f.fetch(APP_LINK, tmp_path)
    assert sum(u.endswith(f"{ACCOUNT}.json") for u in seen) == 1, "the account is verified once per run"


def test_unavailable_with_a_bad_account_is_an_ordinary_retried_failure(tmp_path):
    def handler(request):
        if request.url.path.endswith("recording.json"):
            return httpx.Response(200, json=GONE)
        return httpx.Response(404, json={"error": "Not found"})

    with pytest.raises(FetchError) as err:
        api_fetcher(handler).fetch(APP_LINK, tmp_path)
    assert not isinstance(err.value, RecordingUnavailable)
    assert "account check failed" in str(err.value)


def test_other_json_errors_stay_ordinary_failures(tmp_path):
    def handler(request):
        return httpx.Response(200, json={"error": "Rate limited"})

    with pytest.raises(FetchError) as err:
        api_fetcher(handler).fetch(APP_LINK, tmp_path)
    assert not isinstance(err.value, RecordingUnavailable)
