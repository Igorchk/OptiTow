"""Apps Script webhook client and CallRail audio download.

Apps Script always answers HTTP 200 (errors are in the JSON body), and answers a POST through a
302 redirect that httpx follows, so success is `ok`, never the status code.
"""

from __future__ import annotations

import json
import logging
import mimetypes
from dataclasses import dataclass
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


CALLRAIL_API_HOST = "api.callrail.com"
MAX_AUDIO_BYTES = 200 * 1024 * 1024
MAX_HOPS = 6


def is_callrail_host(host: str | None) -> bool:
    host = (host or "").lower()
    return host == "callrail.com" or host.endswith(".callrail.com")


def redact(url: str) -> str:
    """Host + path only: recording URLs can carry access keys in the query string."""
    parts = urlsplit(url)
    return f"{parts.scheme}://{parts.netloc}{parts.path}"


class AudioFetcher:
    """Downloads a call recording.

    Handles both shapes CallRail hands out:
      * a direct/signed media URL (sometimes behind redirects), and
      * the authenticated API URL (``api.callrail.com/.../recording.json``), which answers with
        JSON ``{"url": "<media url>"}``.

    The API key is only ever sent to ``*.callrail.com``: to api.callrail.com straight away, and to
    other CallRail hosts only after they answer 401/403. Redirects are followed by hand so the
    key can never leak to a third-party host (e.g. a storage bucket) mid-chain.
    """

    def __init__(self, api_key: str, client: httpx.Client | None = None, max_bytes: int = MAX_AUDIO_BYTES) -> None:
        self._api_key = api_key
        self._client = client or httpx.Client(timeout=120, follow_redirects=False)
        self._max_bytes = max_bytes

    def fetch(self, url: str, dest_dir: Path, stem: str = "call") -> Path:
        current = url
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
                    media_url = response.json().get("url")
                    if not media_url:
                        raise FetchError("recording JSON had no 'url'")
                    current = urljoin(current, str(media_url))
                    continue
                return self._save(response, content_type, parts.path, dest_dir, stem)
            finally:
                response.close()
        raise FetchError("too many redirects fetching audio")

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
        suffix = mimetypes.guess_extension(content_type) if content_type.startswith(("audio/", "video/")) else None
        suffix = suffix or Path(url_path).suffix or ".mp3"
        path = dest_dir / f"{stem}{suffix}"
        size = 0
        with path.open("wb") as out:
            for chunk in response.iter_bytes():
                size += len(chunk)
                if size > self._max_bytes:
                    path.unlink(missing_ok=True)
                    raise FetchError(f"audio larger than {self._max_bytes} bytes")
                out.write(chunk)
        if size == 0:
            path.unlink(missing_ok=True)
            raise FetchError("empty audio response")
        return path
