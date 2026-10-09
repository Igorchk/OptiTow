"""Realistic call transcripts (speech-recognition style: no speaker labels, some disfluency)."""

# An insurance rep booking a flatbed: a sales call.
INSURANCE_QUOTE = (
    "Hi, this is Dana with Pacific Mutual claims. I've got a policyholder with a twenty twenty Tesla "
    "Model Y that was in a fender bender on Highway 99 northbound at Elverta. It's not driveable, "
    "the front bumper's pushed in. Can you send a flatbed? What's your rate for a flatbed to a body "
    "shop in Roseville and how soon can you have someone out there? It's Capital Collision on "
    "Sunrise. And we found you on Google Maps."
)

# An adjuster asking about a tow that already happened: not a sales call.
ADJUSTER_STATUS = (
    "Hey, this is Mike over at Copart Sacramento, calling for the adjuster on the Civic claim. You "
    "guys picked up a twenty nineteen Honda Civic yesterday from Elk Grove. Can you confirm it was "
    "dropped off at our yard and that the gate attendant signed the paperwork? I need to close out "
    "the PO today."
)

# A customer asking about the storage lot: not a sales call.
STORAGE_HOURS = (
    "Hi, what time does your storage lot gate close tonight? My car's at your yard on Elkhorn. And "
    "is there a storage fee if I pick it up tomorrow morning? I'd bring the title and my ID."
)

# What a competent model would answer for each (the LLM itself is not loaded in tests).
ANSWERS = {
    INSURANCE_QUOTE: {
        "call_intent": "NEW_LEAD", "admin_summary": None, "caller_tone": "Cooperative",
        "mentioned_damage": ["front bumper pushed in", "not driveable"], "lead_source": "Google Maps / Organic",
    },
    ADJUSTER_STATUS: {
        "call_intent": "STATUS_CHECK",
        "admin_summary": "Copart rep checking delivery and signed paperwork on a 2019 Civic to close out the PO.",
        "caller_tone": "N/A", "mentioned_damage": [], "lead_source": "Other",
    },
    STORAGE_HOURS: {
        "call_intent": "ADMIN_INQUIRY",
        "admin_summary": "Customer asking about storage gate hours and storage fees for pickup.",
        "caller_tone": "N/A", "mentioned_damage": [], "lead_source": "Other",
    },
}
