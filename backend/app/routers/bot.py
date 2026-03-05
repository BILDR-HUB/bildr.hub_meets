"""
routers/bot.py – Endpoints for meeting recording (extension + bot modes).
"""

from __future__ import annotations

import asyncio
import logging
import uuid

from fastapi import APIRouter, BackgroundTasks, HTTPException

from app.models.schemas import BotJoinRequest, MeetingRead, MeetingSource, MeetingStatus
from app.services.supabase_client import supabase_admin

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bot", tags=["bot"])

# Track running bots so we can stop them later
_running_bots: dict[str, asyncio.Task] = {}


@router.post("/join", response_model=MeetingRead)
async def bot_join_meeting(request: BotJoinRequest):
    """
    Create a meeting record for recording.

    The Chrome extension calls this when the user clicks "Felvétel indítása".
    No Playwright bot is spawned – the extension handles audio capture directly.
    """
    meeting_id = str(uuid.uuid4())

    result = (
        supabase_admin.table("meetings")
        .insert({
            "id": meeting_id,
            "user_id": "00000000-0000-0000-0000-000000000001",
            "title": request.title,
            "source": MeetingSource.bot.value,
            "status": MeetingStatus.recording.value,
            "meet_url": request.meet_url,
        })
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=500, detail="Failed to create meeting record")

    meeting_data = result.data[0]

    # Create transcript record so streaming chunks can append to it
    supabase_admin.table("transcripts").insert({
        "id": str(uuid.uuid4()),
        "meeting_id": meeting_id,
        "raw_text": "",
    }).execute()

    logger.info("Meeting %s created for extension recording: %s", meeting_id, request.title)

    return MeetingRead(
        id=meeting_data["id"],
        user_id=meeting_data.get("user_id", uuid.UUID(int=0)),
        title=meeting_data["title"],
        source=meeting_data["source"],
        status=MeetingStatus.recording,
        created_at=meeting_data["created_at"],
    )


@router.post("/stop/{meeting_id}")
async def bot_stop_meeting(meeting_id: str):
    """Stop a running recording and trigger processing."""
    supabase_admin.table("meetings").update(
        {"status": MeetingStatus.processing.value}
    ).eq("id", meeting_id).execute()

    return {"status": "stopped", "meeting_id": meeting_id}
