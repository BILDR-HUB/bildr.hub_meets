-- =====================================================================
-- bildr.hub meets – Cloudflare D1 (SQLite) schema
-- Futtatás: wrangler d1 execute bildr-meets-db --remote --file=schema.sql
-- =====================================================================

CREATE TABLE IF NOT EXISTS meetings (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL DEFAULT 'Untitled Meeting',
  source       TEXT NOT NULL DEFAULT 'upload',   -- 'bot' | 'upload' | 'voice_note'
  status       TEXT NOT NULL DEFAULT 'pending',  -- 'pending'|'recording'|'processing'|'completed'|'failed'
  company_id   TEXT,
  company_name TEXT,
  crm_note_id  TEXT,
  crm_task_ids TEXT DEFAULT '[]',               -- JSON array
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_meetings_status    ON meetings(status);
CREATE INDEX IF NOT EXISTS idx_meetings_created   ON meetings(created_at DESC);

CREATE TABLE IF NOT EXISTS transcripts (
  id                TEXT PRIMARY KEY,
  meeting_id        TEXT NOT NULL UNIQUE REFERENCES meetings(id) ON DELETE CASCADE,
  raw_text          TEXT,
  executive_summary TEXT,
  action_items      TEXT DEFAULT '[]',  -- JSON array
  diarized_text     TEXT,
  followup_email    TEXT,               -- JSON {subject, body}
  deep_analysis     TEXT,               -- JSON deep analysis object
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transcripts_meeting ON transcripts(meeting_id);
