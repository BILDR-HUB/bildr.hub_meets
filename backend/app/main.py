"""Meeting Note-Taker – FastAPI entrypoint."""

import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    datefmt="%H:%M:%S",
)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.routers import audio, bot, crm, meetings

app = FastAPI(
    title="AI Meeting Note-Taker",
    version="0.1.0",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins (extension runs from meet.google.com)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Routers ──────────────────────────────────────────────────────────
app.include_router(audio.router)
app.include_router(bot.router)
app.include_router(crm.router)
app.include_router(meetings.router)


@app.get("/api/health")
async def health_check():
    return {"status": "ok"}
