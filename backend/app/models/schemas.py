"""Pydantic schemas for request / response validation."""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


# ── Enums ────────────────────────────────────────────────────────────

class MeetingSource(str, Enum):
    bot = "bot"
    upload = "upload"
    voice_note = "voice_note"


class MeetingStatus(str, Enum):
    pending = "pending"
    recording = "recording"
    processing = "processing"
    completed = "completed"
    failed = "failed"


# ── Action item (stored in JSONB) ────────────────────────────────────

class ActionItem(BaseModel):
    assignee: str | None = None
    task: str
    deadline: str | None = None
    priority: str = "medium"


# ── Meeting ──────────────────────────────────────────────────────────

class MeetingCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=300)
    source: MeetingSource
    meet_url: str | None = None


class MeetingRead(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    title: str
    source: MeetingSource
    status: MeetingStatus
    created_at: datetime


# ── Transcript ───────────────────────────────────────────────────────

class TranscriptRead(BaseModel):
    id: uuid.UUID
    meeting_id: uuid.UUID
    raw_text: str | None = None
    executive_summary: str | None = None
    action_items: list[ActionItem] = []
    audio_url: str | None = None


# ── Bot trigger ──────────────────────────────────────────────────────

class BotJoinRequest(BaseModel):
    meet_url: str = Field(..., pattern=r"https://meet\.google\.com/.+")
    bot_name: str = "Meeting Bot"
    title: str = "Untitled Meeting"
    extension_mode: bool = False  # True = Chrome extension records, no Playwright bot
