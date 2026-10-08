"""Cheap checks that keep unanswered calls and automated messages away from the LLM.

Two kinds of junk reach the worker: calls that were never a conversation (dropped, ringing out)
and recordings of a carrier or voicemail system speaking. Left alone, the model invents a caller
emotion for them. Both are caught here, before any model runs, and recorded as ``N/A``.

Everything is deliberately conservative about *real* calls: a customer who happens to say
"I left a voicemail", or a voicemail greeting followed by a genuine customer message, is analyzed.
"""

from __future__ import annotations

import re

# Calls with less talk time than this are not conversations. Keep equal to CONFIG.MIN_LIVE_CALL_SEC
# in apps-script/Code.gs (tests/contract.test.js enforces it).
MIN_LIVE_CALL_SEC = 15

# A transcript shorter than this has no dialogue (silence, a click, or Whisper's filler on silence).
MIN_TRANSCRIPT_CHARS = 20

# After removing sentences that contain carrier phrases, fewer words than this means the audio was
# the machine talking, not a customer. Raise it if real voicemails are being caught; lower it if
# carrier boilerplate is getting through.
MIN_HUMAN_WORDS = 12

# Phrases are matched on lowercase text with apostrophes and punctuation removed ("can't" -> "cant").
AUTOMATED_PHRASES: dict[str, str] = {
    "cannot_be_completed": r"\b(cannot|can not|cant|could not|couldnt|unable to be) (be )?completed\b",
    "not_available": r"\b(is|are) (not|currently not|temporarily not) available\b|\bis unavailable\b|\bisnt available\b",
    "mailbox_full": r"\bmailbox (is|has) (full|not been set up|not set up)\b",
    "leave_message": r"\bplease leave (a |your )?(message|name)\b|\bleave your message\b",
    "not_in_service": r"\b(not in service|no longer in service|has been disconnected|been disconnected)\b",
    "number_dialed": r"\bnumber you (have )?(dialed|called|reached)\b|\bnumber you are (trying to reach|calling)\b",
    "tone_or_beep": r"\b(at|after) the (tone|beep)\b",
    "person_unreachable": r"\b(person|party|subscriber) (you are (trying to reach|calling)|you (have )?called)\b",
    "call_forwarded": r"\byour call (has been|is being) forwarded\b|\bplease stay on the line\b",
    "ivr_menu": r"\bpress (the )?(one|two|three|1|2|3|pound|star)\b",
    "voicemail_system": r"\b(voice ?mail (box|service|system)|reached the voice ?mail)\b",
    "recording_notice": r"\bthis is a recording\b|\bcheck the number and try again\b|\btry your call again\b",
}
_COMPILED = {name: re.compile(pattern) for name, pattern in AUTOMATED_PHRASES.items()}

_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")
# Whisper punctuates reliably, but if it ever doesn't, treat long runs as several chunks so one
# carrier phrase cannot condemn an entire unpunctuated transcript.
_MAX_SENTENCE_WORDS = 30
_CHUNK_WORDS = 15


def _normalize(text: str) -> str:
    text = text.lower().replace("’", "'").replace("'", "")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", text)).strip()


def _sentences(transcript: str) -> list[str]:
    out: list[str] = []
    for sentence in _SENTENCE_SPLIT.split(transcript):
        words = sentence.split()
        if len(words) > _MAX_SENTENCE_WORDS:
            out.extend(" ".join(words[i:i + _CHUNK_WORDS]) for i in range(0, len(words), _CHUNK_WORDS))
        elif words:
            out.append(sentence)
    return out


def automated_phrases_in(text: str) -> list[str]:
    """Names of the carrier/voicemail/IVR phrase patterns found in ``text``."""
    normalized = _normalize(text)
    return [name for name, pattern in _COMPILED.items() if pattern.search(normalized)]


def is_short_call(duration_sec: float | int | None) -> bool:
    """True if CallRail's total duration alone proves there was no real conversation.

    Total duration includes ringing, so it only ever *overstates* talk time: a call under the
    threshold in total can never have had a long enough conversation.
    """
    return duration_sec is not None and duration_sec < MIN_LIVE_CALL_SEC


def classify_transcript(transcript: str) -> str | None:
    """Why a transcript is not a genuine conversation, or None if it should be analyzed.

    * ``"no_dialogue"``: effectively empty.
    * ``"automated_message"``: carrier phrases, and not enough human speech left once the sentences
      containing them are set aside. A voicemail greeting followed by a real customer message keeps
      its message, so it is analyzed.
    """
    if len(transcript.strip()) < MIN_TRANSCRIPT_CHARS:
        return "no_dialogue"

    human_words = 0
    any_hit = False
    for sentence in _sentences(transcript):
        if automated_phrases_in(sentence):
            any_hit = True
        else:
            human_words += len(_normalize(sentence).split())
    if any_hit and human_words < MIN_HUMAN_WORDS:
        return "automated_message"
    return None
