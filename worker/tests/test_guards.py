import pytest

from guards import (
    AUTOMATED_PHRASES,
    MIN_HUMAN_WORDS,
    MIN_LIVE_CALL_SEC,
    MIN_TRANSCRIPT_CHARS,
    automated_phrases_in,
    classify_transcript,
    is_short_call,
)

# One short fragment per phrase family. Each, on its own, is a machine talking.
FRAGMENTS = {
    "cannot_be_completed": "Sorry, your call cannot be completed as dialed.",
    "not_available": "The person you are trying to reach is not available.",
    "mailbox_full": "The mailbox is full.",
    "leave_message": "Please leave a message after the tone.",
    "not_in_service": "The number you have dialed is not in service.",
    "ivr_menu": "For service, press 1.",
    "call_forwarded": "Your call has been forwarded.",
    "recording_notice": "This is a recording.",
}

CUSTOMER = (
    "Hi, my truck broke down on the westbound shoulder near the Madison exit and the front tire "
    "is completely flat, I need a tow as soon as you can get here, please call me back."
)


@pytest.mark.parametrize("name,text", FRAGMENTS.items())
def test_each_automated_fragment_is_caught_on_its_own(name, text):
    assert classify_transcript(text) == "automated_message"


def test_every_phrase_family_is_covered_by_a_fragment_or_a_pattern_test():
    covered = {"cannot_be_completed", "not_available", "mailbox_full", "leave_message", "not_in_service",
               "ivr_menu", "call_forwarded", "recording_notice"}
    assert covered <= set(AUTOMATED_PHRASES)


@pytest.mark.parametrize("text", [
    "your call can't be completed",
    "your call can’t be completed",  # curly apostrophe from the transcriber
    "YOUR CALL CANNOT BE COMPLETED AS DIALED",
    "the subscriber you have called is unavailable",
    "the number you are calling is not in service",
])
def test_spelling_variants_are_matched(text):
    assert automated_phrases_in(text)


def test_a_stack_of_carrier_sentences_is_automated():
    stacked = " ".join(FRAGMENTS.values())
    assert classify_transcript(stacked) == "automated_message"


@pytest.mark.parametrize("text", ["", "   ", "Thank you.", "Hmm.", "Hello? Hello?"])
def test_empty_and_tiny_transcripts_have_no_dialogue(text):
    assert len(text.strip()) < MIN_TRANSCRIPT_CHARS
    assert classify_transcript(text) == "no_dialogue"


def test_a_greeting_followed_by_a_real_customer_message_is_analyzed():
    greeting = f"{FRAGMENTS['not_available']} {FRAGMENTS['leave_message']}"
    assert len(CUSTOMER.split()) >= MIN_HUMAN_WORDS
    assert classify_transcript(f"{greeting} {CUSTOMER}") is None


def test_a_greeting_followed_by_a_hang_up_is_automated():
    greeting = f"{FRAGMENTS['not_available']} {FRAGMENTS['leave_message']}"
    assert classify_transcript(f"{greeting} Hello? Okay.") == "automated_message"


def test_real_conversations_are_never_flagged():
    assert classify_transcript(CUSTOMER) is None
    chat = ("Dispatcher: Recovery Towing, how can I help? Caller: My Camry won't start in my driveway. "
            "Dispatcher: Okay, we can send a truck, it's two hundred twenty dollars. Caller: That works.")
    assert classify_transcript(chat) is None


@pytest.mark.parametrize("text", [
    "Hi yes I left you a voicemail earlier about my truck, can you call me back please.",
    "I can't press the brake pedal at all and the car just keeps rolling toward the ditch.",
    "She said you were available all night, so can you come out to the Rio Linda yard now.",
])
def test_ordinary_speech_that_resembles_the_phrases_is_not_flagged(text):
    assert classify_transcript(text) is None


def test_one_stray_phrase_inside_a_long_real_conversation_is_not_flagged():
    assert classify_transcript(f"{CUSTOMER} {FRAGMENTS['not_available']} {CUSTOMER}") is None


def test_unpunctuated_transcripts_are_judged_in_chunks_not_all_or_nothing():
    run_on = (CUSTOMER.replace(",", "").replace(".", "") + " your call cannot be completed "
              + CUSTOMER.replace(",", "").replace(".", ""))
    assert len(run_on.split()) > 60 and "." not in run_on
    assert classify_transcript(run_on) is None


def test_short_call_threshold():
    assert MIN_LIVE_CALL_SEC == 15
    assert [is_short_call(x) for x in (None, 0, 8, 14, 14.9, 15, 16, 145)] == \
        [False, True, True, True, True, False, False, False]
