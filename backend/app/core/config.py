"""Application configuration loaded from environment variables."""

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # ── Supabase ─────────────────────────────────────────────────────
    supabase_url: str = ""
    supabase_anon_key: str = ""
    supabase_service_role_key: str = ""

    # ── Database ─────────────────────────────────────────────────────
    database_url: str = "postgresql+asyncpg://postgres:postgres@localhost:5432/meeting_app"

    # ── Speech-to-Text ───────────────────────────────────────────────
    groq_api_key: str = ""
    deepgram_api_key: str = ""

    # ── LLM ──────────────────────────────────────────────────────────
    google_api_key: str = ""
    openai_api_key: str = ""

    # ── Twenty CRM ───────────────────────────────────────────────────
    twenty_api_url: str = ""      # e.g. https://crm.yourdomain.com
    twenty_api_key: str = ""      # Bearer token for Twenty GraphQL API

    # ── CORS ─────────────────────────────────────────────────────────
    cors_origins: list[str] = [
        "http://localhost:8081",
        "http://localhost:19006",
        "https://meet.google.com",
        "chrome-extension://*",
    ]

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()
