"""Strict Pydantic contract for what the local LLM may return.

The picklists below must match ``ENUMS`` in apps-script/Code.gs (tests/contract.test.js enforces it).
The Apps Script re-validates everything, so a model slip can never put a free-text value in a
picklist column.
"""

from __future__ import annotations

from typing import Annotated, Iterable, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, create_model

CallerTone = Literal[
    "Calm",
    "Stressed",
    "Frustrated",
    "Angry",
    "Confused",
    "Rushed",
    "Price Shopping",
    "Cooperative",
    "N/A",
]

LeadSource = Literal[
    "Google Ads",
    "Google Maps / Organic",
    "Repeat / Direct",
    "Motor Club Referral",
    "Website Form",
    "Other",
]

CALLER_TONES: tuple[str, ...] = get_args(CallerTone)
LEAD_SOURCES: tuple[str, ...] = get_args(LeadSource)

# A short phrase, not a sentence: keeps the sheet cell readable and the model on task.
DamageItem = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]

NO_DAMAGE = "None"

# Written to Caller_Tone and Mentioned_Damage when a call has no genuine two-way conversation
# (unanswered, dropped, carrier or voicemail prompts). Distinct from NO_DAMAGE, which means a real
# conversation in which no damage was mentioned.
NOT_APPLICABLE = "N/A"


class Enrichment(BaseModel):
    """Everything the AI may fill. Field names are the webhook's snake_case keys."""

    model_config = ConfigDict(extra="forbid")

    caller_tone: CallerTone = Field(description="The caller's overall emotional tone on the call.")
    mentioned_damage: list[DamageItem] = Field(
        max_length=8,
        description="Short phrases for vehicle damage or problems the caller states. [] if none.",
    )
    lead_source: LeadSource = Field(description="How the caller says they found the company.")


FIELD_NAMES: tuple[str, ...] = tuple(Enrichment.model_fields)


def model_for(fields: Iterable[str]) -> type[BaseModel]:
    """The strict model for just the fields a given row still needs.

    A row whose Lead_Source CallRail already filled gets a model with no ``lead_source`` at all,
    so the LLM is never asked for (and can never return) a value we would not write.
    """
    requested = set(fields)
    wanted = [name for name in FIELD_NAMES if name in requested]
    if requested - set(FIELD_NAMES) or not wanted:
        raise ValueError(f"model_for needs one or more of {FIELD_NAMES}, got {sorted(requested)}")
    return create_model(
        "EnrichmentPartial",
        __config__=ConfigDict(extra="forbid"),
        **{name: (Enrichment.model_fields[name].annotation, Enrichment.model_fields[name]) for name in wanted},
    )


def to_update_fields(result: BaseModel) -> dict[str, object]:
    """Webhook body fields for a validated result.

    Damage phrases are de-duplicated (case-insensitively), and "no damage mentioned" is written as
    the explicit "None" so the cell is distinguishable from "not processed yet".
    """
    data = result.model_dump()
    if data.get("caller_tone") == NOT_APPLICABLE:
        # The model found no real conversation, so nothing else it said about the call can be
        # trusted: damage is N/A and any lead-source guess is dropped, leaving the cell blank.
        if "mentioned_damage" in data:
            data["mentioned_damage"] = NOT_APPLICABLE
        data.pop("lead_source", None)
        return data
    if "mentioned_damage" in data:
        unique: dict[str, str] = {}
        for item in data["mentioned_damage"]:
            unique.setdefault(item.casefold(), item)
        data["mentioned_damage"] = list(unique.values()) or NO_DAMAGE
    return data


def not_applicable_fields(blank_fields: Iterable[str]) -> dict[str, object]:
    """Safe defaults for a call that never reached the LLM (unanswered, dropped, automated).

    Only the cells that are still blank are filled, and ``lead_source`` is never guessed. If there
    is nothing to fill, the row is just marked processed so it leaves the queue.
    """
    blank = set(blank_fields)
    fields: dict[str, object] = {
        name: NOT_APPLICABLE for name in ("caller_tone", "mentioned_damage") if name in blank
    }
    return fields or {"mark_processed": True}
