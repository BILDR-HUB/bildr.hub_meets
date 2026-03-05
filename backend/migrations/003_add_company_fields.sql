-- Add company linking and CRM ID tracking fields to meetings
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS company_id TEXT;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS company_name TEXT;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS crm_note_id TEXT;
ALTER TABLE public.meetings ADD COLUMN IF NOT EXISTS crm_task_ids JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.meetings.company_id IS 'Twenty CRM Company ID';
COMMENT ON COLUMN public.meetings.company_name IS 'Denormalized company name for display';
COMMENT ON COLUMN public.meetings.crm_note_id IS 'Twenty CRM Note ID created by pipeline';
COMMENT ON COLUMN public.meetings.crm_task_ids IS 'Twenty CRM Task IDs created by pipeline';
