"""Apps Script webhook client and CallRail audio download.

Apps Script always answers HTTP 200 (errors are in the JSON body), and answers a POST through a
302 redirect that httpx follows, so success is `ok`, never the status code.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx

log = logging.getLogger("worker.webhook")


# ---------------------------------------------------------------------------
# Webhook
# ---------------------------------------------------------------------------


class WebhookFatal(Exception):
    """Credentials or deployment are wrong: every request would fail, so stop the whole run."""


class WebhookTransient(Exception):
    """Busy sheet, network trouble, server hiccup: stop this run and let the next one retry."""


class WebhookRejected(Exception):
    """The server will never accept this one request; skip the row."""


@dataclass(frozen=True)
class PendingCall:
    call_id: str
    call_recording_url: str
    caller_tone: str
    mentioned_damage: str
    lead_source: str
    customer_phone: str = ""
    date_time: str = ""
    call_duration_sec: float | None = None

    @classmethod
    def from_json(cls, raw: dict) -> "PendingCall":
        text = lambda key: "" if raw.get(key) is None else str(raw[key])  # noqa: E731
        return cls(
            call_id=text("call_id"),
            call_recording_url=text("call_recording_url"),
            caller_tone=text("caller_tone"),
            mentioned_damage=text("mentioned_damage"),
            lead_source=text("lead_source"),
            customer_phone=text("customer_phone"),
            date_time=text("date_time"),
            call_duration_sec=raw.get("call_duration_sec"),
        )

    def minutes_since_call_ended(self, now: datetime) -> float | None:
        """Minutes since the call ended (its start plus its duration), or None if the start is unknown.

        A recording only exists once the call is over, so the clock that matters for "is the audio
        ready yet" starts at the end, not at the start of a long call.
        """
        try:
            started = datetime.fromisoformat(self.date_time.replace("Z", "+00:00"))
        except ValueError:
            return None
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        ended = started + timedelta(seconds=max(self.call_duration_sec or 0, 0))
        return (now - ended).total_seconds() / 60

    def blank_fields(self) -> list[str]:
        """Which AI cells are still empty (and so may be filled)."""
        blanks = []
        if not self.caller_tone.strip():
            blanks.append("caller_tone")
        if not self.mentioned_damage.strip():
            blanks.append("mentioned_damage")
        if not self.lead_source.strip():
            blanks.append("lead_source")
        return blanks


class WebhookClient:
    def __init__(self, url: str, secret: str, client: httpx.Client | None = None) -> None:
        self._url = url
        self._secret = secret
        self._client = client or httpx.Client(timeout=60, follow_redirects=True)

    def pending(self, limit: int) -> list[PendingCall]:
        body = self._post({"action": "pending", "limit": limit})
        return [PendingCall.from_json(item) for item in body.get("items", [])]

    def update(self, call: PendingCall, fields: dict[str, object]) -> list[str]:
        """Write AI fields for one row; returns the server's warnings (e.g. 'already set')."""
        payload = {
            "action": "update",
            "call_id": call.call_id,
            # The recording URL re-finds the row if an app sync re-keyed its call_id meanwhile.
            "call_recording_url": call.call_recording_url,
            **fields,
        }
        return list(self._post(payload).get("warnings") or [])

    def _post(self, payload: dict) -> dict:
        try:
            response = self._client.post(
                self._url,
                params={"source": "ai"},
                content=json.dumps({"token": self._secret, **payload}),
                headers={"Content-Type": "text/plain;charset=utf-8"},
            )
        except httpx.HTTPError as exc:
            raise WebhookTransient(f"network error: {type(exc).__name__}") from exc

        if response.status_code >= 500:
            raise WebhookTransient(f"HTTP {response.status_code}")
        try:
            body = response.json()
        except ValueError:
            # Usually a Google sign-in page: the deployment is not set to "Anyone".
            raise WebhookFatal("Webhook returned non-JSON. Check the web app deployment access.") from None
        if not isinstance(body, dict):
            raise WebhookFatal("Webhook returned an unexpected JSON shape.")
        if body.get("ok"):
            return body

        code, message = body.get("code"), body.get("error") or "unknown error"
        if code in ("UNAUTHORIZED", "SERVER_MISCONFIGURED"):
            raise WebhookFatal(f"{code}: {message}")
        if code in ("BAD_REQUEST", "NOT_FOUND"):
            raise WebhookRejected(f"{code}: {message}")
        raise WebhookTransient(f"{code}: {message}")  # BUSY, INTERNAL, anything new


# ---------------------------------------------------------------------------
# Audio
# ---------------------------------------------------------------------------


class FetchError(Exception):
    pass


class RecordingUnavailable(FetchError):
    """CallRail answered "This call is no longer available." for this recording.

    On its own this is only a claim: a call that ended minutes ago may just not have its audio
    yet, and a wrong account id or key can produce the same answer. The batch decides from the call's
    age and `AudioFetcher.verify_account()` whether to wait, retire the row, or count a failure.
    """


_UNAVAILABLE_MESSAGE = "no longer available"


def describe_json(data: object, account_id: str = "") -> str:
    """What an unexpected CallRail JSON reply looked like, safe to log.

    Lists the top-level field names with their types (never their values, which could be URLs, ids
    or personal data), plus CallRail's own `error`/`message` text with URLs and the account id removed
    and the length capped. One log line is then enough to see a renamed or missing field.
    """
    if not isinstance(data, dict):
        return f"a JSON {type(data).__name__}, not an object"
    fields = ", ".join(f"{name}:{'null' if value is None else type(value).__name__}"
                       for name, value in sorted(data.items(), key=lambda item: str(item[0]))) or "none"
    parts = [f"fields: {fields}"]
    for key in ("error", "message"):
        text = data.get(key)
        if isinstance(text, str) and text.strip():
            text = re.sub(r"https?://\S+", "<url>", text)
            if account_id:
                text = text.replace(account_id, "<account>")
            text = re.sub(r"\s+", " ", text).strip()[:100]
            parts.append(f'{key}: "{text}"')
    return "; ".join(parts)


CALLRAIL_API_HOST = "api.callrail.com"
MAX_AUDIO_BYTES = 200 * 1024 * 1024
MAX_HOPS = 6


def is_callrail_host(host: str | None) -> bool:
    host = (host or "").lower()
    return host == "callrail.com" or host.endswith(".callrail.com")


def redact(url: str) -> str:
    """Host + path only: recording URLs can carry access keys in the query string.

    The CallRail account number in API paths is masked too, so it never lands in the logs.
    """
    parts = urlsplit(url)
    path = re.sub(r"/a/\d+/", "/a/<account>/", parts.path)
    return f"{parts.scheme}://{parts.netloc}{path}"


_CALL_ID = re.compile(r"/calls/(CAL[0-9A-Za-z]+)")

# Content types that really are audio, even from storage that labels everything octet-stream.
_AMBIGUOUS_TYPES = ("", "application/octet-stream", "binary/octet-stream", "application/x-octet-stream")
_AUDIO_TYPES = ("application/ogg",)


class AudioFetcher:
    """Downloads a call recording.

    Handles both shapes CallRail hands out:
      * a direct/signed media URL (sometimes behind redirects), and
      * the authenticated API URL (``api.callrail.com/.../recording.json``), which answers with
        JSON ``{"url": "<media url>"}``.

    When an account id is configured, a CallRail *app* link (``app.callrail.com/calls/CAL…/recording/
    redirect``) is rewritten to the documented API endpoint
    ``api.callrail.com/v3/a/{account}/calls/{CAL…}/recording.json``, which is the supported way to get
    the audio and answers with a redirect to the MP3. The bare app link needs a browser session and
    answers with a placeholder page instead of audio.

    The API key is only ever sent to ``*.callrail.com``: to api.callrail.com straight away, and to
    other CallRail hosts only after they answer 401/403. Redirects are followed by hand so the
    key can never leak to a third-party host (e.g. a storage bucket) mid-chain.
    """

    def __init__(
        self,
        api_key: str,
        client: httpx.Client | None = None,
        max_bytes: int = MAX_AUDIO_BYTES,
        account_id: str = "",
    ) -> None:
        self._api_key = api_key
        self._client = client or httpx.Client(timeout=120, follow_redirects=False)
        self._max_bytes = max_bytes
        self._account_id = account_id.strip()
        self._account_verified = False

    def resolve(self, url: str) -> str:
        """The URL to request: CallRail app links become the documented API endpoint."""
        parts = urlsplit(url)
        match = _CALL_ID.search(parts.path)
        if (self._account_id and match and parts.scheme == "https" and is_callrail_host(parts.hostname)
                and parts.hostname != CALLRAIL_API_HOST):
            api_url = f"https://{CALLRAIL_API_HOST}/v3/a/{self._account_id}/calls/{match.group(1)}/recording.json"
            log.debug("Fetching %s through the recording API (%s)", match.group(1), redact(api_url))
            return api_url
        return url

    def fetch(self, url: str, dest_dir: Path, stem: str = "call") -> Path:
        current = self.resolve(url)
        for _ in range(MAX_HOPS):
            parts = urlsplit(current)
            if parts.scheme != "https" or not parts.hostname:
                raise FetchError(f"refusing non-https audio URL {redact(current)}")
            callrail = is_callrail_host(parts.hostname)

            response = self._get(current, authed=parts.hostname == CALLRAIL_API_HOST)
            if response.status_code in (401, 403) and callrail and parts.hostname != CALLRAIL_API_HOST:
                response.close()
                response = self._get(current, authed=True)

            try:
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        raise FetchError("redirect without a Location header")
                    current = urljoin(current, location)
                    continue
                if response.status_code != 200:
                    raise FetchError(f"HTTP {response.status_code} from {redact(current)}")

                content_type = response.headers.get("content-type", "").split(";")[0].strip().lower()
                if content_type in ("application/json", "text/json"):
                    response.read()
                    body = response.json()
                    media_url = body.get("url") if isinstance(body, dict) else None
                    if not media_url:
                        error = str(body.get("error", "")) if isinstance(body, dict) else ""
                        shape = describe_json(body, self._account_id)
                        if parts.hostname == CALLRAIL_API_HOST and _UNAVAILABLE_MESSAGE in error.lower():
                            raise RecordingUnavailable(f"CallRail says the call is no longer available ({shape})")
                        raise FetchError(f"recording reply had no 'url' ({shape})")
                    current = urljoin(current, str(media_url))
                    continue
                return self._save(response, content_type, parts.path, dest_dir, stem)
            finally:
                response.close()
        raise FetchError("too many redirects fetching audio")

    def verify_account(self) -> None:
        """Prove the key and account id are good, so "no longer available" means the call, not our setup.

        CallRail answers that message with HTTP 200, so a wrong account could look the same. Checked
        once per run, and only when a row is about to be retired; any failure is an ordinary
        (retried) FetchError, never an orphan verdict.
        """
        if self._account_verified:
            return
        url = f"https://{CALLRAIL_API_HOST}/v3/a/{self._account_id}.json"
        response = self._get(url, authed=True)
        try:
            ok = response.status_code == 200
            if ok:
                response.read()
                ok = "error" not in (response.json() if isinstance(response.json(), dict) else {})
        except ValueError:
            ok = False
        finally:
            response.close()
        if not ok:
            raise FetchError("call unavailable, but the CallRail account check failed (key or account id wrong?)")
        self._account_verified = True

    def _get(self, url: str, authed: bool) -> httpx.Response:
        headers = {"Authorization": f"Token token={self._api_key}"} if authed else {}
        try:
            return self._client.send(self._client.build_request("GET", url, headers=headers), stream=True)
        except httpx.HTTPError as exc:
            raise FetchError(f"network error fetching {redact(url)}: {type(exc).__name__}") from exc

    def _save(self, response: httpx.Response, content_type: str, url_path: str, dest_dir: Path, stem: str) -> Path:
        declared = response.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > self._max_bytes:
            raise FetchError(f"audio larger than {self._max_bytes} bytes")
        # Audio and video containers are trusted by type; a generic type has to look like binary data.
        trusted = content_type.startswith(("audio/", "video/")) or content_type in _AUDIO_TYPES
        if not trusted and content_type not in _AMBIGUOUS_TYPES:
            raise FetchError(self._not_audio(content_type, response))

        suffix = mimetypes.guess_extension(content_type) if content_type.startswith(("audio/", "video/")) else None
        suffix = suffix or Path(url_path).suffix or ".mp3"
        path = dest_dir / f"{stem}{suffix}"
        size = 0
        try:
            with path.open("wb") as out:
                for chunk in response.iter_bytes():
                    if size == 0 and not trusted and _looks_like_text(chunk):
                        raise FetchError(self._not_audio(content_type, response, chunk))
                    size += len(chunk)
                    if size > self._max_bytes:
                        raise FetchError(f"audio larger than {self._max_bytes} bytes")
                    out.write(chunk)
            if size == 0:
                raise FetchError("empty audio response")
        except FetchError:
            path.unlink(missing_ok=True)
            raise
        return path

    @staticmethod
    def _not_audio(content_type: str, response: httpx.Response, head: bytes | None = None) -> str:
        """A clear reason plus a short look at what came back instead of audio."""
        if head is None:
            try:
                head = next(response.iter_bytes(), b"")
            except httpx.HTTPError:
                head = b""
        snippet = re.sub(r"\s+", " ", head[:80].decode("utf-8", "replace")).strip()
        shown = f' starting "{snippet}"' if snippet and _looks_like_text(head) else ""
        size = response.headers.get("content-length") or len(head)
        return f"response is not audio (content-type {content_type or 'missing'}, {size} bytes{shown})"


def _looks_like_text(head: bytes) -> bool:
    """True if the first bytes are all printable ASCII/whitespace: an error page, not an audio file.

    MP3, WAV, MP4, OGG and FLAC all carry non-printable bytes in their first few dozen bytes.
    """
    sample = head[:64]
    return bool(sample) and all(b in (9, 10, 13) or 32 <= b < 127 for b in sample)
