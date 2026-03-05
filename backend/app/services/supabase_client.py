"""
Supabase / local DB client.

In production: uses the Supabase service_role key to bypass RLS.
In local dev: uses direct PostgreSQL connection via local_db.
"""

import os

from app.core.config import settings

if settings.supabase_url and settings.supabase_service_role_key:
    # Production: use Supabase client
    from supabase import create_client
    supabase_admin = create_client(
        settings.supabase_url,
        settings.supabase_service_role_key,
    )
else:
    # Local development: use direct PostgreSQL
    from app.services.local_db import local_db
    supabase_admin = local_db  # type: ignore[assignment]
