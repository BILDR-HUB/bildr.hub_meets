-- =====================================================================
-- AI Meeting Note-Taker – Initial Database Schema
-- Supabase-compatible PostgreSQL migration
-- =====================================================================

-- ── Extensions ──────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";


-- ── Custom ENUM types ───────────────────────────────────────────────

CREATE TYPE meeting_source AS ENUM ('bot', 'upload', 'voice_note');
CREATE TYPE meeting_status AS ENUM ('pending', 'recording', 'processing', 'completed', 'failed');


-- =====================================================================
-- 1. PROFILES (public mirror of auth.users)
-- =====================================================================

CREATE TABLE public.profiles (
    id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    full_name   TEXT,
    avatar_url  TEXT,
    email       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.profiles IS 'Public user profiles linked to Supabase Auth.';

-- Auto-create a profile row when a new user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.profiles (id, full_name, email, avatar_url)
    VALUES (
        NEW.id,
        COALESCE(NEW.raw_user_meta_data ->> 'full_name', ''),
        NEW.email,
        COALESCE(NEW.raw_user_meta_data ->> 'avatar_url', '')
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_user();

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TRIGGER profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at();


-- =====================================================================
-- 2. MEETINGS
-- =====================================================================

CREATE TABLE public.meetings (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT 'Untitled Meeting',
    source      meeting_source NOT NULL DEFAULT 'upload',
    status      meeting_status NOT NULL DEFAULT 'pending',
    meet_url    TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_meetings_user_id ON public.meetings(user_id);
CREATE INDEX idx_meetings_status  ON public.meetings(status);
CREATE INDEX idx_meetings_created ON public.meetings(created_at DESC);

COMMENT ON TABLE public.meetings IS 'Each row represents a meeting session (bot, upload, or voice note).';

CREATE TRIGGER meetings_updated_at
    BEFORE UPDATE ON public.meetings
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at();


-- =====================================================================
-- 3. TRANSCRIPTS
-- =====================================================================

CREATE TABLE public.transcripts (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    meeting_id        UUID NOT NULL UNIQUE REFERENCES public.meetings(id) ON DELETE CASCADE,
    raw_text          TEXT,
    executive_summary TEXT,
    action_items      JSONB DEFAULT '[]'::jsonb,
    audio_url         TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_transcripts_meeting_id ON public.transcripts(meeting_id);

COMMENT ON TABLE public.transcripts IS 'Transcript, summary, and action items for each meeting.';

CREATE TRIGGER transcripts_updated_at
    BEFORE UPDATE ON public.transcripts
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at();


-- =====================================================================
-- 4. ROW LEVEL SECURITY (RLS)
-- =====================================================================

-- ── Enable RLS on all tables ────────────────────────────────────────
ALTER TABLE public.profiles    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meetings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transcripts ENABLE ROW LEVEL SECURITY;

-- ── Profiles policies ───────────────────────────────────────────────

-- Users can read their own profile
CREATE POLICY "Users can view own profile"
    ON public.profiles FOR SELECT
    USING (auth.uid() = id);

-- Users can update their own profile
CREATE POLICY "Users can update own profile"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id)
    WITH CHECK (auth.uid() = id);

-- ── Meetings policies ───────────────────────────────────────────────

-- Users can view their own meetings
CREATE POLICY "Users can view own meetings"
    ON public.meetings FOR SELECT
    USING (auth.uid() = user_id);

-- Users can create meetings (user_id must match auth user)
CREATE POLICY "Users can create own meetings"
    ON public.meetings FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can update their own meetings
CREATE POLICY "Users can update own meetings"
    ON public.meetings FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Users can delete their own meetings
CREATE POLICY "Users can delete own meetings"
    ON public.meetings FOR DELETE
    USING (auth.uid() = user_id);

-- ── Transcripts policies ────────────────────────────────────────────
-- Access is derived through the meetings table ownership

-- Users can view transcripts of their own meetings
CREATE POLICY "Users can view own transcripts"
    ON public.transcripts FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.meetings m
            WHERE m.id = meeting_id
              AND m.user_id = auth.uid()
        )
    );

-- Users can create transcripts for their own meetings
CREATE POLICY "Users can create own transcripts"
    ON public.transcripts FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.meetings m
            WHERE m.id = meeting_id
              AND m.user_id = auth.uid()
        )
    );

-- Users can update transcripts of their own meetings
CREATE POLICY "Users can update own transcripts"
    ON public.transcripts FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.meetings m
            WHERE m.id = meeting_id
              AND m.user_id = auth.uid()
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.meetings m
            WHERE m.id = meeting_id
              AND m.user_id = auth.uid()
        )
    );

-- Users can delete transcripts of their own meetings
CREATE POLICY "Users can delete own transcripts"
    ON public.transcripts FOR DELETE
    USING (
        EXISTS (
            SELECT 1 FROM public.meetings m
            WHERE m.id = meeting_id
              AND m.user_id = auth.uid()
        )
    );


-- =====================================================================
-- 5. SERVICE ROLE POLICIES (for backend server-side operations)
-- =====================================================================
-- The service_role key bypasses RLS by default in Supabase,
-- so the backend can freely insert/update transcripts and meetings
-- during the AI pipeline processing. No extra policies needed.


-- =====================================================================
-- 6. SUPABASE STORAGE BUCKET (run via Supabase Dashboard or API)
-- =====================================================================
-- Create a storage bucket named 'meeting-audio' with the following SQL:

INSERT INTO storage.buckets (id, name, public)
VALUES ('meeting-audio', 'meeting-audio', false)
ON CONFLICT (id) DO NOTHING;

-- Storage policy: users can upload to their own folder
CREATE POLICY "Users can upload own audio"
    ON storage.objects FOR INSERT
    WITH CHECK (
        bucket_id = 'meeting-audio'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- Storage policy: users can read their own audio files
CREATE POLICY "Users can read own audio"
    ON storage.objects FOR SELECT
    USING (
        bucket_id = 'meeting-audio'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- Storage policy: users can delete their own audio files
CREATE POLICY "Users can delete own audio"
    ON storage.objects FOR DELETE
    USING (
        bucket_id = 'meeting-audio'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );
