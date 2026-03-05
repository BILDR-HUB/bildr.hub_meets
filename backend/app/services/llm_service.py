"""
llm_service.py – LLM-based meeting summary and action item extraction.

Supports two providers:
  1. Google Gemini 2.0 Flash (via google-genai SDK) – default
  2. OpenAI GPT-4o-mini – fallback

Both are prompted to return structured JSON with:
  - executive_summary: concise meeting summary
  - action_items: list of { assignee, task, deadline, priority }
"""

from __future__ import annotations

import json
import logging
from enum import Enum

from pydantic import BaseModel

from app.core.config import settings

logger = logging.getLogger(__name__)


# ── Output schema ────────────────────────────────────────────────────

class ActionItem(BaseModel):
    assignee: str | None = None
    task: str
    deadline: str | None = None
    priority: str = "medium"


class MeetingSummary(BaseModel):
    executive_summary: str
    action_items: list[ActionItem]
    diarized_transcript: str | None = None


class FollowUpEmail(BaseModel):
    subject: str
    body: str


class LLMProvider(str, Enum):
    gemini = "gemini"
    openai = "openai"


# ── System prompt (shared across providers) ──────────────────────────

SYSTEM_PROMPT = """Te egy tapasztalt meeting-elemző vagy. A nyers meeting átirat alapján készíts strukturált JSON választ.

FONTOS: Az összefoglaló és a feladatok leírása MINDIG magyar nyelven legyen, függetlenül az átirat nyelvétől.

A válasznak pontosan ezeket a mezőket kell tartalmaznia:

1. "executive_summary": Tömör, professzionális összefoglaló a megbeszélésről (3-8 mondat). Tartalmazza a fő témákat, döntéseket és eredményeket. MAGYARUL írd.

2. "action_items": JSON tömb a kinyert feladatokkal. Minden elem:
   - "assignee": A felelős személy neve (vagy null ha nem egyértelmű)
   - "task": A feladat egyértelmű leírása MAGYARUL
   - "deadline": Említett határidő (vagy null ha nincs)
   - "priority": "high", "medium" vagy "low" a kontextus alapján

Szabályok:
- KIZÁRÓLAG érvényes JSON-nel válaszolj. Nincs markdown, nincs code fence, nincs extra szöveg.
- Ha az átirat túl rövid vagy nem egyértelmű, akkor is adj érvényes JSON-t rövid összefoglalóval és üres action_items tömbbel.
- Legyél konkrét és végrehajtható a feladatleírásokban."""

DIARIZATION_PROMPT = """Te egy tapasztalt meeting-elemző vagy, aki képes megkülönböztetni a beszélőket.

Az alábbiakban egy többszereplős megbeszélés időbélyeges átiratát kapod. A feladatod:

1. "executive_summary": Tömör, professzionális összefoglaló MAGYARUL (3-8 mondat).

2. "action_items": JSON tömb a kinyert feladatokkal:
   - "assignee": A felelős személy neve (vagy null)
   - "task": A feladat leírása MAGYARUL
   - "deadline": Határidő (vagy null)
   - "priority": "high", "medium" vagy "low"

3. "diarized_transcript": Az átirat beszélő-azonosítással. Azonosítsd a különböző beszélőket a beszédmintázatok, szünetek és kontextus alapján. Formátum:
   **Beszélő neve/azonosítója:** Mit mondott.

   Ha a beszélgetésből kiderül a beszélők neve (pl. megszólítás, bemutatkozás), használd a nevüket.
   Ha nem derül ki, használj számozott azonosítókat: "1. beszélő", "2. beszélő" stb.
   Minden beszélőváltásnál új sorba írd.

Szabályok:
- KIZÁRÓLAG érvényes JSON-nel válaszolj.
- A diarized_transcript egy string mező, benne sortörésekkel (\\n).
- MAGYARUL írj mindent.
- Legyél konkrét és végrehajtható a feladatleírásokban."""


# ── Public API ───────────────────────────────────────────────────────

async def generate_summary(
    transcript: str,
    provider: LLMProvider = LLMProvider.gemini,
    is_multi_speaker: bool = False,
) -> MeetingSummary:
    """
    Generate a structured meeting summary from a raw transcript.

    Args:
        transcript: The raw transcribed text (or segmented text for diarization).
        provider: Which LLM provider to use.
        is_multi_speaker: If True, use diarization prompt for speaker identification.

    Returns:
        MeetingSummary with executive_summary, action_items, and optionally diarized_transcript.
    """
    if not transcript or not transcript.strip():
        return MeetingSummary(
            executive_summary="Nincs elérhető átirat.",
            action_items=[],
        )

    # Truncate extremely long transcripts to avoid token limits
    max_chars = 120_000  # ~30k tokens for Gemini Flash
    if len(transcript) > max_chars:
        logger.warning(
            "Transcript truncated from %d to %d chars", len(transcript), max_chars
        )
        transcript = transcript[:max_chars] + "\n\n[... átirat levágva ...]"

    prompt = DIARIZATION_PROMPT if is_multi_speaker else SYSTEM_PROMPT

    if provider == LLMProvider.gemini:
        raw_json = await _generate_gemini(transcript, prompt)
    elif provider == LLMProvider.openai:
        raw_json = await _generate_openai(transcript, prompt)
    else:
        raise ValueError(f"Unknown LLM provider: {provider}")

    return _parse_response(raw_json)


# ── Google Gemini ────────────────────────────────────────────────────

async def _generate_gemini(transcript: str, prompt: str = SYSTEM_PROMPT) -> str:
    """Call Gemini 2.0 Flash via the google-genai SDK."""
    if not settings.google_api_key:
        raise RuntimeError("GOOGLE_API_KEY is not configured")

    from google import genai

    client = genai.Client(api_key=settings.google_api_key)

    logger.info("Sending transcript (%d chars) to Gemini...", len(transcript))

    response = client.models.generate_content(
        model="gemini-2.0-flash",
        contents=[
            f"{prompt}\n\n--- ÁTIRAT KEZDETE ---\n{transcript}\n--- ÁTIRAT VÉGE ---"
        ],
        config={
            "response_mime_type": "application/json",
            "temperature": 0.3,
        },
    )

    result = response.text
    logger.info("Gemini response received: %d chars", len(result))
    return result


# ── OpenAI GPT-4o-mini ──────────────────────────────────────────────

async def _generate_openai(transcript: str, prompt: str = SYSTEM_PROMPT) -> str:
    """Call GPT-4o-mini via the OpenAI SDK."""
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured")

    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=settings.openai_api_key)

    logger.info("Sending transcript (%d chars) to GPT-4o-mini...", len(transcript))

    response = await client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": prompt},
            {
                "role": "user",
                "content": f"--- ÁTIRAT KEZDETE ---\n{transcript}\n--- ÁTIRAT VÉGE ---",
            },
        ],
        response_format={"type": "json_object"},
        temperature=0.3,
        max_tokens=4096,
    )

    result = response.choices[0].message.content or "{}"
    logger.info("OpenAI response received: %d chars", len(result))
    return result


# ── Response parsing ─────────────────────────────────────────────────

FOLLOWUP_EMAIL_PROMPT = """Te egy professzionális üzleti tanácsadó vagy, aki follow-up emaileket ír ügyfeleknek egy konzultációs megbeszélés után.

Az alábbi meeting összefoglaló és feladatlista alapján írj egy magyar nyelvű, udvarias follow-up emailt az ügyfélnek.

Az email felépítése:
1. Üdvözlés és köszönet a megbeszélésért
2. Rövid összefoglaló arról, miről beszéltetek (2-3 mondat, a lényeget kiemelve)
3. Milyen automatizációs / digitalizációs megoldásokat javasoltok nekik (a megbeszélés alapján konkrétan, pl. workflow automatizálás, adatfeldolgozás, CRM integráció, AI-alapú elemzés stb.)
4. Mi szükséges ahhoz, hogy el lehessen kezdeni a közös munkát (pl. hozzáférések, adatok, döntések)
5. Záró mondat: ha ez így rendben van, elkészítjük az árajánlatot

A válasz JSON formátumban:
- "subject": Az email tárgya (rövid, lényegre törő)
- "body": Az email teljes szövege (plain text, sortörésekkel)

Szabályok:
- KIZÁRÓLAG érvényes JSON. Nincs markdown fence.
- Tegezd az ügyfelet (informális de professzionális stílus).
- A "body" mezőben használj sortöréseket (\\n) a bekezdésekhez.
- NE használj markdown formázást a body-ban, csak sima szöveget.
- Az aláírás legyen: "Üdvözlettel,\\n[Név]\\nbildr.hub"
- Ahol a [Név] helyett ne írj konkrét nevet, hagyd így: [Név]"""


async def generate_followup_email(
    meeting_title: str,
    summary: MeetingSummary,
    provider: LLMProvider = LLMProvider.gemini,
) -> FollowUpEmail:
    """Generate a follow-up email based on the meeting summary."""
    context_parts = [
        f"Meeting címe: {meeting_title}",
        f"\nÖsszefoglaló:\n{summary.executive_summary}",
    ]

    if summary.action_items:
        context_parts.append("\nFeladatok:")
        for item in summary.action_items:
            assignee = f" ({item.assignee})" if item.assignee else ""
            deadline = f" - határidő: {item.deadline}" if item.deadline else ""
            context_parts.append(f"  - {item.task}{assignee}{deadline} [{item.priority}]")

    if summary.diarized_transcript:
        context_parts.append(f"\nBeszélgetés:\n{summary.diarized_transcript[:3000]}")

    context = "\n".join(context_parts)

    if provider == LLMProvider.gemini:
        raw_json = await _generate_gemini(context, FOLLOWUP_EMAIL_PROMPT)
    elif provider == LLMProvider.openai:
        raw_json = await _generate_openai(context, FOLLOWUP_EMAIL_PROMPT)
    else:
        raise ValueError(f"Unknown LLM provider: {provider}")

    return _parse_email_response(raw_json)


def _parse_email_response(raw_json: str) -> FollowUpEmail:
    """Parse the follow-up email JSON response."""
    try:
        cleaned = raw_json.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1]
            cleaned = cleaned.rsplit("```", 1)[0]
        data = json.loads(cleaned)
        return FollowUpEmail(**data)
    except (json.JSONDecodeError, KeyError, TypeError) as e:
        logger.error("Failed to parse email response: %s\nRaw: %s", e, raw_json[:500])
        return FollowUpEmail(
            subject="Follow-up: megbeszélés",
            body="Az email generálása sikertelen volt. Kérjük, próbáld újra.",
        )


def _parse_response(raw_json: str) -> MeetingSummary:
    """Parse the raw JSON string from the LLM into a MeetingSummary."""
    try:
        # Strip potential markdown fences
        cleaned = raw_json.strip()
        if cleaned.startswith("```"):
            cleaned = cleaned.split("\n", 1)[1]
            cleaned = cleaned.rsplit("```", 1)[0]

        data = json.loads(cleaned)
        return MeetingSummary(**data)
    except (json.JSONDecodeError, KeyError, TypeError) as e:
        logger.error("Failed to parse LLM response: %s\nRaw: %s", e, raw_json[:500])
        return MeetingSummary(
            executive_summary=f"Summary generation failed. Raw response: {raw_json[:200]}",
            action_items=[],
        )
