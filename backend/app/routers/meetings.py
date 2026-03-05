"""
routers/meetings.py – Meeting and transcript read endpoints.

These endpoints are used by the frontend to:
  - List all meetings for the current user
  - Get a single meeting's details + transcript
  - Poll for processing status
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.services.supabase_client import supabase_admin
from app.services.llm_service import ActionItem, FollowUpEmail, MeetingSummary
from app.services.twenty_crm_service import (
    link_note_to_company,
    link_tasks_to_company,
    push_meeting_to_crm,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/meetings", tags=["meetings"])


@router.get("")
async def list_meetings(
    user_id: str | None = Query(None),
    status: str | None = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
):
    """
    List meetings, optionally filtered by user_id and status.
    Returns newest first.
    """
    query = supabase_admin.table("meetings").select("*").order(
        "created_at", desc=True
    ).range(offset, offset + limit - 1)

    if user_id:
        query = query.eq("user_id", user_id)
    if status:
        query = query.eq("status", status)

    result = query.execute()
    return {"meetings": result.data, "count": len(result.data)}


@router.get("/{meeting_id}")
async def get_meeting(meeting_id: str):
    """Get a single meeting with its transcript."""
    meeting_result = (
        supabase_admin.table("meetings")
        .select("*")
        .eq("id", meeting_id)
        .single()
        .execute()
    )

    if not meeting_result.data:
        raise HTTPException(status_code=404, detail="Meeting not found")

    # Fetch the associated transcript
    transcript_result = (
        supabase_admin.table("transcripts")
        .select("*")
        .eq("meeting_id", meeting_id)
        .execute()
    )

    transcript = transcript_result.data[0] if transcript_result.data else None

    return {
        "meeting": meeting_result.data,
        "transcript": transcript,
    }


@router.get("/{meeting_id}/status")
async def get_meeting_status(meeting_id: str):
    """
    Lightweight status endpoint for frontend polling.
    Returns only the meeting status and basic info.
    """
    result = (
        supabase_admin.table("meetings")
        .select("id, status, title, updated_at")
        .eq("id", meeting_id)
        .single()
        .execute()
    )

    if not result.data:
        raise HTTPException(status_code=404, detail="Meeting not found")

    return result.data


@router.delete("/{meeting_id}")
async def delete_meeting(meeting_id: str):
    """Delete a meeting and its associated transcript."""
    # Check meeting exists
    meeting_result = (
        supabase_admin.table("meetings")
        .select("id")
        .eq("id", meeting_id)
        .single()
        .execute()
    )
    if not meeting_result.data:
        raise HTTPException(status_code=404, detail="Meeting not found")

    # Delete transcript first (foreign key)
    supabase_admin.table("transcripts").delete().eq("meeting_id", meeting_id).execute()
    # Delete meeting
    supabase_admin.table("meetings").delete().eq("id", meeting_id).execute()

    logger.info("Deleted meeting %s", meeting_id)
    return {"deleted": True, "meeting_id": meeting_id}


class UpdateTitleRequest(BaseModel):
    title: str


@router.patch("/{meeting_id}/title")
async def update_meeting_title(meeting_id: str, body: UpdateTitleRequest):
    """Update a meeting's title."""
    result = (
        supabase_admin.table("meetings")
        .select("id")
        .eq("id", meeting_id)
        .single()
        .execute()
    )
    if not result.data:
        raise HTTPException(status_code=404, detail="Meeting not found")

    supabase_admin.table("meetings").update({"title": body.title}).eq(
        "id", meeting_id
    ).execute()
    return {"meeting_id": meeting_id, "title": body.title}


class LinkCompanyRequest(BaseModel):
    company_id: str
    company_name: str


@router.patch("/{meeting_id}/company")
async def link_meeting_to_company(meeting_id: str, body: LinkCompanyRequest):
    """
    Link a meeting to a Twenty CRM company.
    If the meeting has no CRM note yet, creates the note now (with the company
    name in the title) and links everything to the company immediately.
    For legacy meetings that already have a crm_note_id, just links the
    existing note/tasks to the company.
    """
    # Fetch the meeting
    meeting_result = (
        supabase_admin.table("meetings")
        .select("id, title, crm_note_id, crm_task_ids")
        .eq("id", meeting_id)
        .single()
        .execute()
    )
    if not meeting_result.data:
        raise HTTPException(status_code=404, detail="Meeting not found")

    meeting = meeting_result.data
    note_id = meeting.get("crm_note_id")
    task_ids = meeting.get("crm_task_ids") or []
    crm_note_created = False

    if not note_id:
        # No CRM note yet – create it now using the company name in the title
        transcript_result = (
            supabase_admin.table("transcripts")
            .select("executive_summary, action_items, followup_email")
            .eq("meeting_id", meeting_id)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        transcript_data = transcript_result.data[0] if transcript_result.data else None

        if transcript_data and transcript_data.get("executive_summary"):
            summary = MeetingSummary(
                executive_summary=transcript_data["executive_summary"],
                action_items=[
                    ActionItem(**item)
                    for item in (transcript_data.get("action_items") or [])
                ],
            )
            followup = None
            if transcript_data.get("followup_email"):
                fe = transcript_data["followup_email"]
                followup = FollowUpEmail(
                    subject=fe.get("subject", ""),
                    body=fe.get("body", ""),
                )

            crm_result = await push_meeting_to_crm(
                meeting_id=meeting_id,
                meeting_title=meeting["title"],
                summary=summary,
                followup_email=followup,
                company_id=body.company_id,
                company_name=body.company_name,
            )
            note_id = crm_result.get("note_id")
            task_ids = crm_result.get("task_ids", [])
            crm_note_created = bool(note_id)
            logger.info(
                "CRM note created for meeting '%s' linked to '%s': %s",
                meeting["title"], body.company_name, note_id,
            )
    else:
        # Legacy: note already exists – just link it to the company
        await link_note_to_company(note_id, body.company_id)
        if task_ids:
            await link_tasks_to_company(task_ids, body.company_id)
        logger.info(
            "Linked existing CRM note %s to company '%s'",
            note_id, body.company_name,
        )

    # Update meeting with company info and CRM IDs
    update_data: dict = {
        "company_id": body.company_id,
        "company_name": body.company_name,
    }
    if note_id:
        update_data["crm_note_id"] = note_id
    if task_ids:
        update_data["crm_task_ids"] = task_ids
    supabase_admin.table("meetings").update(update_data).eq("id", meeting_id).execute()

    return {
        "meeting_id": meeting_id,
        "company_id": body.company_id,
        "company_name": body.company_name,
        "crm_note_id": note_id,
        "crm_note_created": crm_note_created,
        "linked_tasks": len(task_ids),
    }
