-- =====================================================================
-- Migration 004: Relax user_id FK for authless internal tool use
--
-- Az app jelenleg auth nélküli belső eszközként működik.
-- A meetings.user_id → profiles.id FK kényszert feloldjuk,
-- hogy ne kelljen Supabase auth felhasználó a pipeline futtatásához.
-- =====================================================================

-- 1. FK kényszer eltávolítása a meetings táblán
ALTER TABLE public.meetings
    DROP CONSTRAINT IF EXISTS meetings_user_id_fkey;

-- 2. user_id legyen nullable (opcionális fejléc)
ALTER TABLE public.meetings
    ALTER COLUMN user_id DROP NOT NULL;

-- 3. Alapértelmezett "anonymous" UUID beállítása
ALTER TABLE public.meetings
    ALTER COLUMN user_id SET DEFAULT '00000000-0000-0000-0000-000000000001'::uuid;

-- 4. RLS policy frissítése: service_role bypass (admin kulccsal minden látszik)
-- Az anonimizált meetingek láthatóak maradnak
DROP POLICY IF EXISTS "Users can view own meetings"    ON public.meetings;
DROP POLICY IF EXISTS "Users can create own meetings"  ON public.meetings;
DROP POLICY IF EXISTS "Users can update own meetings"  ON public.meetings;
DROP POLICY IF EXISTS "Users can delete own meetings"  ON public.meetings;

-- Nyílt RLS: mindenki lát mindent (belső eszköz, nincs nyilvános hozzáférés)
CREATE POLICY "Allow all for authenticated or anon"
    ON public.meetings FOR ALL
    USING (true)
    WITH CHECK (true);

-- Transcripts is
DROP POLICY IF EXISTS "Users can view own transcripts"   ON public.transcripts;
DROP POLICY IF EXISTS "Users can create own transcripts" ON public.transcripts;
DROP POLICY IF EXISTS "Users can update own transcripts" ON public.transcripts;
DROP POLICY IF EXISTS "Users can delete own transcripts" ON public.transcripts;

CREATE POLICY "Allow all for authenticated or anon"
    ON public.transcripts FOR ALL
    USING (true)
    WITH CHECK (true);
