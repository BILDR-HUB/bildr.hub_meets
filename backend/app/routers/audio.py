"""
routers/audio.py – Audio upload and processing pipeline.

Supports two modes:
  1. **Legacy (full upload):** POST /api/process-audio – one big file, full pipeline
  2. **Streaming (real-time):** The extension sends 30-second chunks during the meeting:
     - POST /api/audio-chunk   → instant STT, appends text to transcript
     - POST /api/audio-finalize → triggers LLM summary on already-transcribed text

This is the heart of the AI pipeline.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, BackgroundTasks, File, Form, HTTPException, UploadFile

from app.models.schemas import MeetingSource, MeetingStatus
from app.services.stt_service import transcribe, STTProvider
from app.services.llm_service import generate_summary, generate_followup_email, LLMProvider
from app.services.supabase_client import supabase_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["audio"])

# Max file size: 500 MB (long meetings can be large)
MAX_FILE_SIZE = 500 * 1024 * 1024
# Max chunk size: 25 MB (Groq Whisper limit)
MAX_CHUNK_SIZE = 25 * 1024 * 1024


@router.post("/process-audio")
async def process_audio(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    meeting_id: str | None = Form(None),
    user_id: str | None = Form(None),
    title: str | None = Form(None),
    source: str = Form("upload"),
    language: str = Form("hu"),
    stt_provider: str = Form("groq"),
    llm_provider: str = Form("gemini"),
):
    """
    Upload an audio file and trigger the transcription + summary pipeline.

    The file is uploaded to Supabase Storage, then the background task:
    1. Sends the audio to the STT provider (Groq Whisper or Deepgram)
    2. Feeds the transcript to the LLM (Gemini or GPT)
    3. Stores the results in the transcripts table

    Returns immediately with the meeting ID for polling.
    """
    # ── Validate file ────────────────────────────────────────────────
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    content_type = file.content_type or ""
    if not content_type.startswith(("audio/", "video/")):
        raise HTTPException(
            status_code=400,
            detail=f"Invalid content type: {content_type}. Expected audio/* or video/*",
        )

    # Read file content
    audio_bytes = await file.read()
    if len(audio_bytes) > MAX_FILE_SIZE:
        raise HTTPException(status_code=413, detail="File too large (max 500 MB)")

    if len(audio_bytes) == 0:
        raise HTTPException(status_code=400, detail="Empty file")

    logger.info(
        "Received audio: %s (%d KB, type=%s)",
        file.filename,
        len(audio_bytes) // 1024,
        content_type,
    )

    # ── Create or update meeting record ──────────────────────────────
    is_new_meeting = meeting_id is None
    if is_new_meeting:
        meeting_id = str(uuid.uuid4())

    meeting_title = title or f"Meeting {datetime.now().strftime('%Y-%m-%d %H:%M')}"

    try:
        meeting_source = MeetingSource(source)
    except ValueError:
        meeting_source = MeetingSource.upload

    if is_new_meeting:
        result = (
            supabase_admin.table("meetings")
            .insert({
                "id": meeting_id,
                "user_id": user_id or "00000000-0000-0000-0000-000000000001",
                "title": meeting_title,
                "source": meeting_source.value,
                "status": MeetingStatus.processing.value,
            })
            .execute()
        )
        if not result.data:
            raise HTTPException(status_code=500, detail="Failed to create meeting")
    else:
        supabase_admin.table("meetings").update(
            {"status": MeetingStatus.processing.value}
        ).eq("id", meeting_id).execute()

    # ── Create transcript record (placeholder) ───────────────────────
    # Audio is NOT persisted – only kept in memory for the pipeline.
    transcript_id = str(uuid.uuid4())
    supabase_admin.table("transcripts").insert({
        "id": transcript_id,
        "meeting_id": meeting_id,
    }).execute()

    # ── Kick off the background pipeline ─────────────────────────────
    background_tasks.add_task(
        _run_pipeline,
        meeting_id=meeting_id,
        transcript_id=transcript_id,
        audio_bytes=audio_bytes,
        filename=file.filename,
        language=language,
        source=meeting_source,
        stt_provider=STTProvider(stt_provider),
        llm_provider=LLMProvider(llm_provider),
    )

    return {
        "meeting_id": meeting_id,
        "transcript_id": transcript_id,
        "status": "processing",
        "message": "Audio received. Transcription and summary in progress.",
    }


# ── Streaming endpoints (real-time chunk processing) ────────────────

@router.post("/audio-chunk")
async def audio_chunk(
    file: UploadFile = File(...),
    meeting_id: str = Form(...),
    chunk_index: int = Form(0),
    language: str = Form("hu"),
    stt_provider: str = Form("groq"),
):
    """
    Receive a ~30-second audio chunk, transcribe it immediately,
    and append the text to the transcript in the DB.

    Called repeatedly by the extension during recording.
    """
    audio_bytes = await file.read()
    if len(audio_bytes) == 0:
        return {"status": "skipped", "reason": "empty chunk"}
    if len(audio_bytes) > MAX_CHUNK_SIZE:
        raise HTTPException(status_code=413, detail="Chunk too large (max 25 MB)")

    logger.info(
        "[Streaming] Chunk #%d for meeting %s (%d KB)",
        chunk_index, meeting_id, len(audio_bytes) // 1024,
    )

    # Transcribe this chunk immediately
    try:
        result = await transcribe(
            audio_bytes=audio_bytes,
            filename=file.filename or f"chunk_{chunk_index}.webm",
            language=language,
            provider=STTProvider(stt_provider),
            return_segments=True,
        )
    except Exception as e:
        logger.error("[Streaming] STT failed for chunk #%d: %s", chunk_index, e)
        raise HTTPException(status_code=500, detail=f"STT failed: {e}")

    if not result.text.strip():
        logger.info("[Streaming] Chunk #%d produced empty text, skipping", chunk_index)
        return {"status": "skipped", "reason": "no speech detected"}

    # Append to transcript in DB
    transcript_row = (
        supabase_admin.table("transcripts")
        .select("id, raw_text")
        .eq("meeting_id", meeting_id)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )

    if transcript_row.data:
        tid = transcript_row.data[0]["id"]
        existing_text = transcript_row.data[0].get("raw_text") or ""
        total_text = (existing_text + " " + result.text).strip()
        supabase_admin.table("transcripts").update({
            "raw_text": total_text,
        }).eq("id", tid).execute()
    else:
        tid = str(uuid.uuid4())
        total_text = result.text
        supabase_admin.table("transcripts").insert({
            "id": tid,
            "meeting_id": meeting_id,
            "raw_text": total_text,
        }).execute()

    logger.info(
        "[Streaming] Chunk #%d transcribed: +%d chars (total: %d)",
        chunk_index, len(result.text), len(total_text),
    )

    return {
        "status": "ok",
        "chunk_index": chunk_index,
        "chunk_text_length": len(result.text),
    }


@router.post("/audio-finalize")
async def audio_finalize(
    background_tasks: BackgroundTasks,
    meeting_id: str = Form(...),
    source: str = Form("bot"),
    language: str = Form("hu"),
    llm_provider: str = Form("gemini"),
):
    """
    Called when the meeting ends. The transcript is already in the DB
    (built up from chunks). This just triggers the LLM summary pipeline.

    Much faster than full processing – only LLM + CRM + email (~15-30 sec).
    Idempotent: returns early if already processing or completed.
    """
    # Check if already processing/completed (prevent duplicate pipeline runs)
    meeting_check = (
        supabase_admin.table("meetings")
        .select("status")
        .eq("id", meeting_id)
        .limit(1)
        .execute()
    )
    if meeting_check.data:
        status = meeting_check.data[0].get("status") if isinstance(meeting_check.data, list) else meeting_check.data.get("status")
        if status in ("completed", "done"):
            return {"status": "already_completed", "meeting_id": meeting_id}

    # Find the transcript
    transcript_row = (
        supabase_admin.table("transcripts")
        .select("id, raw_text")
        .eq("meeting_id", meeting_id)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )

    if not transcript_row.data or not transcript_row.data[0].get("raw_text"):
        raise HTTPException(status_code=404, detail="No transcript found for this meeting")

    transcript_id = transcript_row.data[0]["id"]
    raw_text = transcript_row.data[0]["raw_text"]

    logger.info(
        "[Finalize] Meeting %s – transcript ready (%d chars). Starting LLM pipeline...",
        meeting_id, len(raw_text),
    )

    # Update meeting status
    supabase_admin.table("meetings").update({
        "status": MeetingStatus.processing.value,
    }).eq("id", meeting_id).execute()

    try:
        meeting_source = MeetingSource(source)
    except ValueError:
        meeting_source = MeetingSource.bot

    # Run the LLM-only pipeline in background
    background_tasks.add_task(
        _run_summary_pipeline,
        meeting_id=meeting_id,
        transcript_id=transcript_id,
        raw_text=raw_text,
        source=meeting_source,
        llm_provider=LLMProvider(llm_provider),
    )

    return {
        "status": "finalizing",
        "meeting_id": meeting_id,
        "transcript_length": len(raw_text),
        "message": "Transcript ready. Generating summary...",
    }


# ── Summary-only pipeline (for streaming mode) ─────────────────────

async def _run_summary_pipeline(
    meeting_id: str,
    transcript_id: str,
    raw_text: str,
    source: MeetingSource,
    llm_provider: LLMProvider,
) -> None:
    """
    LLM-only pipeline: transcript already exists, just generate summary.
    Much faster than the full pipeline – no STT step needed.
    """
    meeting_row = (
        supabase_admin.table("meetings")
        .select("title")
        .eq("id", meeting_id)
        .single()
        .execute()
    )
    meeting_title = meeting_row.data.get("title", "Untitled") if meeting_row.data else "Untitled"
    is_multi_speaker = source == MeetingSource.bot

    try:
        # ── Step 1: LLM Summary ────────────────────────────────────
        logger.info("[Finalize] Generating summary for meeting %s...", meeting_id)
        summary = await generate_summary(
            transcript=raw_text,
            provider=llm_provider,
            is_multi_speaker=is_multi_speaker,
        )

        update_data = {
            "executive_summary": summary.executive_summary,
            "action_items": [item.model_dump() for item in summary.action_items],
        }
        if summary.diarized_transcript:
            update_data["diarized_text"] = summary.diarized_transcript
        supabase_admin.table("transcripts").update(update_data).eq("id", transcript_id).execute()
        logger.info("[Finalize] Summary complete for meeting %s", meeting_id)

        # ── Step 2: Follow-up email ────────────────────────────────
        email = None
        await asyncio.sleep(3)
        for attempt in range(3):
            try:
                email = await generate_followup_email(
                    meeting_title=meeting_title,
                    summary=summary,
                    provider=llm_provider,
                )
                supabase_admin.table("transcripts").update({
                    "followup_email": {"subject": email.subject, "body": email.body},
                }).eq("id", transcript_id).execute()
                logger.info("[Finalize] Email generated for meeting %s", meeting_id)
                break
            except Exception as email_err:
                if attempt < 2 and "429" in str(email_err):
                    await asyncio.sleep((attempt + 1) * 5)
                else:
                    logger.warning("[Finalize] Email failed: %s", email_err)
                    break

        # ── Done ───────────────────────────────────────────────────
        supabase_admin.table("meetings").update({
            "status": MeetingStatus.completed.value,
        }).eq("id", meeting_id).execute()
        logger.info("[Finalize] Meeting %s complete!", meeting_id)

    except Exception as e:
        logger.exception("[Finalize] Failed for meeting %s: %s", meeting_id, e)
        supabase_admin.table("meetings").update({
            "status": MeetingStatus.failed.value,
        }).eq("id", meeting_id).execute()


# ── Background pipeline (legacy full-file mode) ────────────────────

async def _run_pipeline(
    meeting_id: str,
    transcript_id: str,
    audio_bytes: bytes,
    filename: str,
    language: str,
    source: MeetingSource,
    stt_provider: STTProvider,
    llm_provider: LLMProvider,
) -> None:
    """
    Background task that runs the full AI pipeline:
    1. STT: audio → raw text (+ segments for multi-speaker)
    2. LLM: raw text → Hungarian summary + action items (+ speaker identification)
    3. Store results in Supabase
    """
    # Fetch meeting title for CRM
    meeting_row = (
        supabase_admin.table("meetings")
        .select("title")
        .eq("id", meeting_id)
        .single()
        .execute()
    )
    meeting_title = meeting_row.data.get("title", "Untitled") if meeting_row.data else "Untitled"

    # Bot recordings are multi-speaker → request segments for diarization
    is_multi_speaker = source == MeetingSource.bot

    try:
        # ── Step 1: Transcription ────────────────────────────────────
        logger.info("[Pipeline] Starting STT for meeting %s (multi_speaker=%s)...",
                    meeting_id, is_multi_speaker)
        result = await transcribe(
            audio_bytes=audio_bytes,
            filename=filename,
            language=language,
            provider=stt_provider,
            return_segments=is_multi_speaker,
        )
        logger.info(
            "[Pipeline] STT complete: %d chars for meeting %s",
            len(result.text),
            meeting_id,
        )

        # Save raw transcript immediately
        supabase_admin.table("transcripts").update({
            "raw_text": result.text,
        }).eq("id", transcript_id).execute()

        # For multi-speaker, send segmented text so LLM can identify speakers
        llm_input = result.as_segmented_text() if is_multi_speaker else result.text

        # ── Step 2: LLM Summary ─────────────────────────────────────
        logger.info("[Pipeline] Starting LLM summary for meeting %s (diarize=%s)...",
                    meeting_id, is_multi_speaker)
        summary = await generate_summary(
            transcript=llm_input,
            provider=llm_provider,
            is_multi_speaker=is_multi_speaker,
        )
        logger.info("[Pipeline] LLM summary complete for meeting %s", meeting_id)

        # ── Step 3: Store results in Supabase ────────────────────────
        update_data = {
            "executive_summary": summary.executive_summary,
            "action_items": [item.model_dump() for item in summary.action_items],
        }
        if summary.diarized_transcript:
            update_data["diarized_text"] = summary.diarized_transcript
        supabase_admin.table("transcripts").update(update_data).eq("id", transcript_id).execute()

        # ── Step 4: Generate follow-up email ────────────────────────
        logger.info("[Pipeline] Generating follow-up email for meeting %s...", meeting_id)
        # Small delay to avoid rate limiting on back-to-back LLM calls
        await asyncio.sleep(3)
        for attempt in range(3):
            try:
                email = await generate_followup_email(
                    meeting_title=meeting_title,
                    summary=summary,
                    provider=llm_provider,
                )
                supabase_admin.table("transcripts").update({
                    "followup_email": {"subject": email.subject, "body": email.body},
                }).eq("id", transcript_id).execute()
                logger.info("[Pipeline] Follow-up email generated for meeting %s", meeting_id)
                break
            except Exception as email_err:
                if attempt < 2 and "429" in str(email_err):
                    logger.info("[Pipeline] Rate limited, retrying in %ds...", (attempt + 1) * 5)
                    await asyncio.sleep((attempt + 1) * 5)
                else:
                    logger.warning("[Pipeline] Follow-up email failed: %s", email_err)
                    break

        # ── Done ─────────────────────────────────────────────────────
        supabase_admin.table("meetings").update({
            "status": MeetingStatus.completed.value,
        }).eq("id", meeting_id).execute()

        logger.info("[Pipeline] Meeting %s processing complete!", meeting_id)

    except Exception as e:
        logger.exception("[Pipeline] Failed for meeting %s: %s", meeting_id, e)

        supabase_admin.table("meetings").update({
            "status": MeetingStatus.failed.value,
        }).eq("id", meeting_id).execute()
