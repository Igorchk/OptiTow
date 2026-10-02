import json

import pytest
from pydantic import ValidationError

from enricher import Enricher, EnrichmentError, build_messages, extract_json
from schema import CALLER_TONES, LEAD_SOURCES, Enrichment, model_for, to_update_fields

ALL = ["caller_tone", "mentioned_damage", "lead_source"]


def reply(**overrides):
    body = {"caller_tone": "Calm", "mentioned_damage": ["flat tire"], "lead_source": "Google Ads"}
    body.update(overrides)
    return json.dumps(body)


# --- schema -----------------------------------------------------------------


def test_picklists_are_the_agreed_values():
    assert CALLER_TONES == ("Calm", "Stressed", "Frustrated", "Angry", "Confused", "Rushed",
                            "Price Shopping", "Cooperative")
    assert LEAD_SOURCES == ("Google Ads", "Google Maps / Organic", "Repeat / Direct",
                            "Motor Club Referral", "Website Form", "Other")


@pytest.mark.parametrize("bad", [
    {"caller_tone": "Hysterical"},
    {"lead_source": "Billboard"},
    {"mentioned_damage": ["x" * 81]},
    {"mentioned_damage": ["a"] * 9},
    {"mentioned_damage": [""]},
    {"mentioned_damage": "flat tire"},
])
def test_enrichment_rejects_invalid_values(bad):
    data = json.loads(reply(**bad))
    with pytest.raises(ValidationError):
        Enrichment.model_validate(data)


def test_enrichment_rejects_missing_and_extra_keys():
    with pytest.raises(ValidationError):
        Enrichment.model_validate({"caller_tone": "Calm"})
    with pytest.raises(ValidationError):
        Enrichment.model_validate({**json.loads(reply()), "quoted_price": 1})


def test_model_for_only_contains_requested_fields():
    model = model_for(["caller_tone", "mentioned_damage"])
    assert list(model.model_fields) == ["caller_tone", "mentioned_damage"]
    with pytest.raises(ValidationError):  # lead_source is not part of this row's contract
        model.model_validate(json.loads(reply()))
    assert model.model_validate({"caller_tone": "Rushed", "mentioned_damage": []})


def test_model_for_rejects_unknown_or_empty():
    with pytest.raises(ValueError):
        model_for([])
    with pytest.raises(ValueError):
        model_for(["quoted_price"])


def test_update_fields_write_none_for_no_damage_and_dedupe():
    assert to_update_fields(Enrichment.model_validate(json.loads(reply(mentioned_damage=[])))) ["mentioned_damage"] == "None"
    out = to_update_fields(Enrichment.model_validate(
        json.loads(reply(mentioned_damage=["Flat tire", " flat tire ", "dented door"]))))
    assert out["mentioned_damage"] == ["Flat tire", "dented door"]


# --- prompting ---------------------------------------------------------------


def test_prompt_only_covers_requested_fields_and_treats_transcript_as_data():
    system, user = build_messages("hello there", ["caller_tone"])
    assert "caller_tone" in system["content"]
    assert "lead_source" not in system["content"]
    assert "mentioned_damage" not in system["content"]
    assert "untrusted" in system["content"].lower()
    assert "<transcript>\nhello there\n</transcript>" == user["content"]


def test_prompt_lists_every_lead_source_when_needed():
    system = build_messages("x", ["lead_source"])[0]["content"]
    for value in LEAD_SOURCES:
        assert value in system


def test_long_transcripts_are_truncated():
    user = build_messages("a" * 50_000, ["caller_tone"])[1]["content"]
    assert len(user) < 21_000


# --- extraction & retry --------------------------------------------------------


def test_extract_json_tolerates_surrounding_text():
    assert extract_json('Sure! {"a": 1} hope that helps') == {"a": 1}
    with pytest.raises(ValueError):
        extract_json("no json here")


def test_enrich_returns_validated_result_first_try():
    calls = []

    def generate(messages):
        calls.append(messages)
        return reply()

    result = Enricher(generate).enrich("t", ALL)
    assert result.caller_tone == "Calm"
    assert len(calls) == 1


def test_enrich_retries_once_with_error_feedback_then_succeeds():
    seen = []
    outputs = iter(['{"caller_tone": "Hysterical"', reply()])  # truncated/invalid, then valid

    def generate(messages):
        seen.append(messages)
        return next(outputs)

    result = Enricher(generate).enrich("t", ALL)
    assert result.lead_source == "Google Ads"
    assert len(seen) == 2
    retry = seen[1]
    assert retry[2] == {"role": "assistant", "content": '{"caller_tone": "Hysterical"'}
    assert "invalid" in retry[3]["content"].lower()


def test_enrich_schema_failure_feeds_validation_error_back():
    seen = []
    outputs = iter([reply(caller_tone="Hysterical"), reply()])

    def generate(messages):
        seen.append(messages)
        return next(outputs)

    Enricher(generate).enrich("t", ALL)
    assert "caller_tone" in seen[1][3]["content"]


def test_enrich_gives_up_after_one_retry():
    calls = []

    def generate(messages):
        calls.append(1)
        return reply(caller_tone="Hysterical")

    with pytest.raises(EnrichmentError):
        Enricher(generate).enrich("t", ALL)
    assert len(calls) == 2, "one try plus exactly one retry"
