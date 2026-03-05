"""
stt_service.py – Speech-to-Text service.

Supports two providers:
  1. Groq API (Whisper large-v3) – default, fast and cheap
  2. Deepgram Nova-2 – optimized for Hungarian + English

The service accepts raw audio bytes (WebM) and returns the
transcribed text as a string.
"""

from __future__ import annotations

import logging
from enum import Enum

from app.core.config import settings

logger = logging.getLogger(__name__)


class STTProvider(str, Enum):
    groq = "groq"
    deepgram = "deepgram"


class TranscriptResult:
    """Holds both plain text and optional timestamped segments."""

    def __init__(self, text: str, segments: list[dict] | None = None):
        self.text = text
        self.segments = segments  # [{"start": 0.0, "end": 2.5, "text": "..."}]

    def as_segmented_text(self) -> str:
        """Format segments with timestamps for LLM speaker identification."""
        if not self.segments:
            return self.text
        lines = []
        for seg in self.segments:
            start = _fmt_time(seg["start"])
            end = _fmt_time(seg["end"])
            lines.append(f"[{start} - {end}] {seg['text'].strip()}")
        return "\n".join(lines)


def _fmt_time(seconds: float) -> str:
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m:02d}:{s:02d}"


async def transcribe(
    audio_bytes: bytes,
    filename: str = "audio.webm",
    language: str = "hu",
    provider: STTProvider = STTProvider.groq,
    return_segments: bool = False,
) -> TranscriptResult:
    """
    Transcribe audio bytes to text.

    Args:
        audio_bytes: Raw audio file content (WebM/opus).
        filename: Original filename (used for MIME type detection).
        language: ISO 639-1 language code ('hu', 'en', etc.).
        provider: Which STT provider to use.
        return_segments: If True, also return timestamped segments.

    Returns:
        TranscriptResult with text and optional segments.
    """
    if provider == STTProvider.groq:
        return await _transcribe_groq(audio_bytes, filename, language, return_segments)
    elif provider == STTProvider.deepgram:
        return await _transcribe_deepgram(audio_bytes, language)
    else:
        raise ValueError(f"Unknown STT provider: {provider}")


# ── Groq (Whisper large-v3) ─────────────────────────────────────────

async def _transcribe_groq(
    audio_bytes: bytes,
    filename: str,
    language: str,
    return_segments: bool = False,
) -> TranscriptResult:
    """Transcribe using Groq's Whisper large-v3 endpoint."""
    if not settings.groq_api_key:
        raise RuntimeError("GROQ_API_KEY is not configured")

    from groq import Groq

    client = Groq(api_key=settings.groq_api_key)

    logger.info("Sending %d bytes to Groq Whisper (lang=%s, segments=%s)...",
                len(audio_bytes), language, return_segments)

    transcription = client.audio.transcriptions.create(
        file=(filename, audio_bytes),
        model="whisper-large-v3",
        language=language,
        response_format="verbose_json",
        temperature=0.0,
    )

    text = transcription.text or ""
    segments = None

    if return_segments and hasattr(transcription, "segments") and transcription.segments:
        segments = [
            {
                "start": seg.start if hasattr(seg, "start") else seg.get("start", 0),
                "end": seg.end if hasattr(seg, "end") else seg.get("end", 0),
                "text": seg.text if hasattr(seg, "text") else seg.get("text", ""),
            }
            for seg in transcription.segments
        ]
        logger.info("Groq transcription complete: %d chars, %d segments", len(text), len(segments))
    else:
        logger.info("Groq transcription complete: %d chars", len(text))

    return TranscriptResult(text=text, segments=segments)


# ── Deepgram Nova-2 ─────────────────────────────────────────────────

async def _transcribe_deepgram(
    audio_bytes: bytes,
    language: str,
) -> str:
    """Transcribe using Deepgram Nova-2."""
    if not settings.deepgram_api_key:
        raise RuntimeError("DEEPGRAM_API_KEY is not configured")

    from deepgram import DeepgramClient

    client = DeepgramClient(settings.deepgram_api_key)

    source = {"buffer": audio_bytes, "mimetype": "audio/webm"}

    options = {
        "model": "nova-2",
        "language": language,
        "smart_format": True,
        "diarize": True,
        "punctuate": True,
        "paragraphs": True,
    }

    logger.info("Sending %d bytes to Deepgram Nova-2 (lang=%s)...", len(audio_bytes), language)

    response = await client.listen.asyncrest.v("1").transcribe_file(source, options)

    transcript = (
        response.results.channels[0].alternatives[0].paragraphs.transcript
        if response.results.channels[0].alternatives[0].paragraphs
        else response.results.channels[0].alternatives[0].transcript
    )

    logger.info("Deepgram transcription complete: %d chars", len(transcript))
    return TranscriptResult(text=transcript)
