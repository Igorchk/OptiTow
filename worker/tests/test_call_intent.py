"""Call intent: NEW_LEAD vs STATUS_CHECK / ADMIN_INQUIRY.

The LLM is never loaded here. Its replies are scripted (see transcripts.ANSWERS), so these tests pin
what the worker does around the model: the prompt it sends, strict validation, and the rules that
turn an answer into sheet values. They cannot prove a real model classifies correctly; that needs a
live run (`main.py --dry-run -v`) on real recordings.
"""

import json

import pytest

from enricher import Enricher, build_messages
from schema import (
    CALL_INTENTS,
    OPERATIONAL_INTENTS,
    Enrichment,
    is_operational,
    model_for,
    to_update_fields,
)
from transcripts import ADJUSTER_STATUS, ANSWERS, INSURANCE_QUOTE, STORAGE_HOURS
from webhook import PendingCall

FULL = ["call_intent", "admin_summary", "caller_tone", "mentioned_damage", "lead_source"]


def scripted(transcript):
    """A stand-in LLM that answers the way the model should for a known transcript."""
    def generate(messages):
        assert transcript in messages[1]["content"], "the transcript must reach the model"
        return json.dumps(ANSWERS[transcript])
    return generate


def classify(transcript, fields=FULL, known_intent=None):
    result = Enricher(scripted(transcript)).enrich(transcript, fields)
    return to_update_fields(result, known_intent=known_intent)


# --- the three realistic calls -----------------------------------------------------------------


def test_an_insurance_rep_asking_for_a_flatbed_quote_is_a_new_lead_with_the_normal_extraction():
    out = classify(INSURANCE_QUOTE)
    assert out == {
        "call_intent": "NEW_LEAD",
        "caller_tone": "Cooperative",
        "mentioned_damage": ["front bumper pushed in", "not driveable"],
        "lead_source": "Google Maps / Organic",
    }
    assert "admin_summary" not in out
    assert not is_operational(out)


def test_an_adjuster_checking_a_delivery_is_a_status_check_with_no_tone_or_damage():
    out = classify(ADJUSTER_STATUS)
    assert out == {
        "call_intent": "STATUS_CHECK",
        "admin_summary": "Copart rep checking delivery and signed paperwork on a 2019 Civic to close out the PO.",
        "caller_tone": "N/A",
        "mentioned_damage": "N/A",
    }, "lead_source is never guessed for an operational call"
    assert is_operational(out)


def test_a_customer_asking_about_storage_gate_hours_is_an_admin_inquiry():
    out = classify(STORAGE_HOURS)
    assert out["call_intent"] == "ADMIN_INQUIRY"
    assert out["admin_summary"] == "Customer asking about storage gate hours and storage fees for pickup."
    assert (out["caller_tone"], out["mentioned_damage"]) == ("N/A", "N/A")
    assert "lead_source" not in out
    assert is_operational(out)


# --- schema ------------------------------------------------------------------------------------


def test_the_three_intents_and_which_are_operational():
    assert CALL_INTENTS == ("NEW_LEAD", "STATUS_CHECK", "ADMIN_INQUIRY")
    assert OPERATIONAL_INTENTS == ("STATUS_CHECK", "ADMIN_INQUIRY")


@pytest.mark.parametrize("bad", [
    {"call_intent": "SALES"},
    {"call_intent": "new_lead"},
    {"call_intent": None},
    {"admin_summary": "x" * 201},
    {"extra_key": 1},
])
def test_the_model_cannot_return_values_outside_the_contract(bad):
    good = {**ANSWERS[ADJUSTER_STATUS]}
    with pytest.raises(ValueError):
        Enrichment.model_validate({**good, **bad})


def test_the_summary_is_required_but_may_be_null_and_is_trimmed():
    base = {**ANSWERS[INSURANCE_QUOTE]}
    assert Enrichment.model_validate(base).admin_summary is None
    missing = {k: v for k, v in base.items() if k != "admin_summary"}
    with pytest.raises(ValueError):
        Enrichment.model_validate(missing)
    assert Enrichment.model_validate({**base, "admin_summary": "  Spaces.  "}).admin_summary == "Spaces."


# --- the prompt --------------------------------------------------------------------------------


def test_the_prompt_defines_all_three_intents_and_the_operational_rule():
    system, user = build_messages(ADJUSTER_STATUS, FULL)
    text = system["content"]
    for needle in ("NEW_LEAD", "STATUS_CHECK", "ADMIN_INQUIRY", "admin_summary", "Status checks and admin inquiries",
                   "closing out a claim", "choose NEW_LEAD"):
        assert needle in text, needle
    assert "exactly these keys: call_intent, admin_summary, caller_tone, mentioned_damage, lead_source" in text
    assert ADJUSTER_STATUS in user["content"]


def test_without_the_intent_field_the_prompt_has_no_operational_rule():
    text = build_messages("hi", ["caller_tone", "mentioned_damage"])[0]["content"]
    assert "call_intent" not in text and "Status checks and admin inquiries" not in text


def test_the_automated_audio_rule_names_the_intent_defaults():
    text = build_messages("x", FULL)[0]["content"]
    assert 'null for admin_summary' in text and '"NEW_LEAD" for call_intent' in text


# --- rules around the model's answer -----------------------------------------------------------


def test_a_status_check_cannot_carry_tone_damage_or_a_lead_source_even_if_the_model_slips():
    slip = {**ANSWERS[ADJUSTER_STATUS], "caller_tone": "Angry", "mentioned_damage": ["dented door"],
            "lead_source": "Google Ads"}
    out = to_update_fields(Enrichment.model_validate(slip))
    assert out["caller_tone"] == "N/A" and out["mentioned_damage"] == "N/A" and "lead_source" not in out
    assert out["call_intent"] == "STATUS_CHECK" and out["admin_summary"]


def test_a_new_lead_never_keeps_a_summary():
    out = to_update_fields(Enrichment.model_validate({**ANSWERS[INSURANCE_QUOTE], "admin_summary": "stray text"}))
    assert "admin_summary" not in out and out["call_intent"] == "NEW_LEAD"


@pytest.mark.parametrize("summary", [None, "", "   "])
def test_an_operational_intent_with_no_summary_is_treated_as_no_real_conversation(summary):
    # A genuine status call always has something to summarise; "no summary" is how the model signals
    # an automated recording. Nothing about intent is written, so the row is not mislabelled.
    slip = {**ANSWERS[ADJUSTER_STATUS], "admin_summary": summary}
    out = to_update_fields(Enrichment.model_validate(slip))
    assert out == {"caller_tone": "N/A", "mentioned_damage": "N/A"}


def test_a_new_lead_with_n_a_tone_is_still_the_no_conversation_path_and_drops_the_intent():
    out = to_update_fields(Enrichment.model_validate({**ANSWERS[INSURANCE_QUOTE], "caller_tone": "N/A"}))
    assert out == {"caller_tone": "N/A", "mentioned_damage": "N/A"}


def test_a_known_operational_intent_on_the_row_applies_even_when_the_model_was_not_asked_again():
    partial = model_for(["caller_tone", "mentioned_damage"]).model_validate(
        {"caller_tone": "Angry", "mentioned_damage": ["dent"]})
    out = to_update_fields(partial, known_intent="STATUS_CHECK")
    assert out == {"caller_tone": "N/A", "mentioned_damage": "N/A"}
    lead = to_update_fields(partial, known_intent="NEW_LEAD")
    assert lead == {"caller_tone": "Angry", "mentioned_damage": ["dent"]}


# --- which fields are asked for ----------------------------------------------------------------


def pending(call_intent):
    return PendingCall("c", "u", "", "", "", call_intent=call_intent)


def test_intent_is_requested_only_when_the_sheet_reports_a_blank_intent_cell():
    assert pending("").blank_fields() == ["caller_tone", "mentioned_damage", "lead_source", "call_intent", "admin_summary"]
    assert pending("STATUS_CHECK").blank_fields() == ["caller_tone", "mentioned_damage", "lead_source"]
    # An Apps Script from before this feature does not send the key at all: never ask for it.
    assert pending(None).blank_fields() == ["caller_tone", "mentioned_damage", "lead_source"]


def test_pending_items_without_the_key_parse_as_an_older_deployment():
    old = PendingCall.from_json({"call_id": "c1", "call_recording_url": "u"})
    new = PendingCall.from_json({"call_id": "c1", "call_recording_url": "u", "call_intent": ""})
    assert old.call_intent is None and new.call_intent == ""
