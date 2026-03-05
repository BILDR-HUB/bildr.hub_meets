-- Add diarized_text column to transcripts for speaker-identified transcripts
ALTER TABLE public.transcripts ADD COLUMN IF NOT EXISTS diarized_text TEXT;
COMMENT ON COLUMN public.transcripts.diarized_text IS 'Speaker-identified transcript (e.g. "Péter: ...\nAnna: ...")';

-- Add followup_email column for generated follow-up emails
ALTER TABLE public.transcripts ADD COLUMN IF NOT EXISTS followup_email JSONB;
COMMENT ON COLUMN public.transcripts.followup_email IS 'Generated follow-up email JSON: {subject, body}';
