/**
 * bildr.hub meets – Cloudflare Worker
 * TypeScript/Hono backend replacing FastAPI
 *
 * Bindings required (wrangler secret put):
 *   DB              – D1 database
 *   GROQ_API_KEY    – Groq Whisper STT
 *   GOOGLE_API_KEY  – Gemini LLM
 *   TWENTY_API_URL  – Twenty CRM base URL
 *   TWENTY_API_KEY  – Twenty CRM Bearer token
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { transcribeAudio } from "./stt";
import { generateSummary, generateFollowUpEmail, generateMeetingQuestion, type MeetingSummary } from "./llm";
import {
  searchCompanies,
  createCompany,
  createPerson,
  pushMeetingToCrm,
  linkNoteToCompany,
  linkTasksToCompany,
} from "./crm";

// ── Env types ─────────────────────────────────────────────────────────

export interface Env {
  DB: D1Database;
  GROQ_API_KEY: string;
  GOOGLE_API_KEY: string;
  TWENTY_API_URL: string;
  TWENTY_API_KEY: string;
}

// ── DB helpers ────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

async function getMeeting(db: D1Database, id: string) {
  return db.prepare("SELECT * FROM meetings WHERE id = ?").bind(id).first<{
    id: string;
    title: string;
    source: string;
    status: string;
    company_id: string | null;
    company_name: string | null;
    crm_note_id: string | null;
    crm_task_ids: string;
    created_at: string;
    updated_at: string;
  }>();
}

async function setMeetingStatus(db: D1Database, id: string, status: string) {
  await db
    .prepare("UPDATE meetings SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, now(), id)
    .run();
}

// ── App ───────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

// CORS – allow frontend + Chrome extension
app.use("*", async (c, next) => {
  const origin = c.req.header("Origin") ?? "";
  const allowed =
    origin === "https://meets.bildr.hu" ||
    origin === "https://office.bildr.hu" ||
    origin.startsWith("http://localhost") ||
    origin.startsWith("chrome-extension://");

  if (allowed) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    c.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
    c.header("Access-Control-Max-Age", "86400");
  }

  if (c.req.method === "OPTIONS") return c.text("", 204);
  return next();
});

// ── Health ────────────────────────────────────────────────────────────

app.get("/api/health", (c) => c.json({ status: "ok" }));

// ── Meetings ──────────────────────────────────────────────────────────

app.get("/api/meetings", async (c) => {
  const limit = Number(c.req.query("limit") ?? 20);
  const offset = Number(c.req.query("offset") ?? 0);
  const status = c.req.query("status");

  let query = "SELECT * FROM meetings";
  const params: (string | number)[] = [];

  if (status) {
    query += " WHERE status = ?";
    params.push(status);
  }

  query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const result = await c.env.DB.prepare(query)
    .bind(...params)
    .all<{ id: string; title: string; source: string; status: string; company_id: string | null; company_name: string | null; created_at: string }>();

  return c.json({ meetings: result.results, count: result.results.length });
});

app.get("/api/meetings/:id", async (c) => {
  const id = c.req.param("id");
  const meeting = await getMeeting(c.env.DB, id);
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  const transcript = await c.env.DB.prepare(
    "SELECT * FROM transcripts WHERE meeting_id = ?",
  )
    .bind(id)
    .first<{
      id: string;
      meeting_id: string;
      raw_text: string | null;
      executive_summary: string | null;
      action_items: string;
      diarized_text: string | null;
      followup_email: string | null;
      deep_analysis: string | null;
    }>();

  const parsedTranscript = transcript
    ? {
        ...transcript,
        action_items: JSON.parse(transcript.action_items ?? "[]"),
        followup_email: transcript.followup_email
          ? JSON.parse(transcript.followup_email)
          : null,
        deep_analysis: transcript.deep_analysis
          ? JSON.parse(transcript.deep_analysis)
          : null,
      }
    : null;

  return c.json({ meeting, transcript: parsedTranscript });
});

app.get("/api/meetings/:id/status", async (c) => {
  const id = c.req.param("id");
  const meeting = await c.env.DB.prepare(
    "SELECT id, status, title, updated_at FROM meetings WHERE id = ?",
  )
    .bind(id)
    .first();
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);
  return c.json(meeting);
});

app.delete("/api/meetings/:id", async (c) => {
  const id = c.req.param("id");
  const meeting = await getMeeting(c.env.DB, id);
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  await c.env.DB.prepare("DELETE FROM transcripts WHERE meeting_id = ?").bind(id).run();
  await c.env.DB.prepare("DELETE FROM meetings WHERE id = ?").bind(id).run();

  return c.json({ deleted: true, meeting_id: id });
});

app.patch("/api/meetings/:id/title", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ title: string }>();
  const meeting = await getMeeting(c.env.DB, id);
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  await c.env.DB.prepare(
    "UPDATE meetings SET title = ?, updated_at = ? WHERE id = ?",
  )
    .bind(body.title, now(), id)
    .run();

  return c.json({ meeting_id: id, title: body.title });
});

app.patch("/api/meetings/:id/company", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ company_id: string; company_name: string }>();
  const meeting = await getMeeting(c.env.DB, id);
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  let noteId = meeting.crm_note_id;
  let taskIds: string[] = JSON.parse(meeting.crm_task_ids ?? "[]");
  let crmNoteCreated = false;

  const hasCrmConfig = c.env.TWENTY_API_URL && c.env.TWENTY_API_KEY;

  if (!noteId && hasCrmConfig) {
    // No CRM note yet – fetch transcript and create now
    const transcript = await c.env.DB.prepare(
      "SELECT executive_summary, action_items, followup_email FROM transcripts WHERE meeting_id = ?",
    )
      .bind(id)
      .first<{
        executive_summary: string | null;
        action_items: string;
        followup_email: string | null;
      }>();

    if (transcript?.executive_summary) {
      // executive_summary may be a JSON sections array (new format) or plain text (old)
      let execSummaryText = transcript.executive_summary;
      let sections: import("./llm").SummarySection[] = [];
      try {
        const parsed = JSON.parse(transcript.executive_summary);
        if (Array.isArray(parsed)) {
          sections = parsed;
          execSummaryText = parsed
            .map((s: import("./llm").SummarySection) => `${s.title}:\n${s.points.map((p: string) => `- ${p}`).join("\n")}`)
            .join("\n\n");
        }
      } catch { /* plain text, use as-is */ }

      const summary: MeetingSummary = {
        sections,
        executive_summary: execSummaryText,
        action_items: JSON.parse(transcript.action_items ?? "[]"),
        diarized_transcript: null,
        deep_analysis: null,
      };
      const followup = transcript.followup_email
        ? JSON.parse(transcript.followup_email)
        : null;

      try {
        const crmResult = await pushMeetingToCrm(
          meeting.title,
          summary,
          followup,
          body.company_id,
          body.company_name,
          c.env.TWENTY_API_URL,
          c.env.TWENTY_API_KEY,
        );
        noteId = crmResult.note_id;
        taskIds = crmResult.task_ids;
        crmNoteCreated = Boolean(noteId);
      } catch (e) {
        console.error("CRM push failed:", e);
      }
    }
  } else if (noteId && hasCrmConfig) {
    // Legacy: note exists, just link
    await linkNoteToCompany(noteId, body.company_id, c.env.TWENTY_API_URL, c.env.TWENTY_API_KEY);
    if (taskIds.length > 0) {
      await linkTasksToCompany(taskIds, body.company_id, c.env.TWENTY_API_URL, c.env.TWENTY_API_KEY);
    }
  }

  // Update meeting record
  await c.env.DB.prepare(
    `UPDATE meetings SET
      company_id = ?, company_name = ?,
      crm_note_id = ?, crm_task_ids = ?,
      updated_at = ?
     WHERE id = ?`,
  )
    .bind(
      body.company_id,
      body.company_name,
      noteId,
      JSON.stringify(taskIds),
      now(),
      id,
    )
    .run();

  return c.json({
    meeting_id: id,
    company_id: body.company_id,
    company_name: body.company_name,
    crm_note_id: noteId,
    crm_note_created: crmNoteCreated,
    linked_tasks: taskIds.length,
  });
});

// ── Meetings: create (for streaming / extension use) ─────────────────

app.post("/api/meetings", async (c) => {
  const body = await c.req.json<{ title?: string; source?: string }>().catch(() => ({}));
  const title = body.title ?? `Meeting ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  const source = body.source ?? "extension";
  const meetingId = uuid();
  const transcriptId = uuid();

  await c.env.DB.prepare(
    "INSERT INTO meetings (id, title, source, status, created_at, updated_at) VALUES (?, ?, ?, 'recording', ?, ?)",
  )
    .bind(meetingId, title, source, now(), now())
    .run();

  await c.env.DB.prepare(
    "INSERT INTO transcripts (id, meeting_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
  )
    .bind(transcriptId, meetingId, now(), now())
    .run();

  return c.json({ id: meetingId, title, source, status: "recording" });
});

// ── Audio: full upload pipeline ───────────────────────────────────────

app.post("/api/process-audio", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ error: "No file provided" }, 400);

  const title =
    (formData.get("title") as string | null) ??
    `Meeting ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  const source = (formData.get("source") as string | null) ?? "upload";
  const language = (formData.get("language") as string | null) ?? "hu";

  const meetingId = uuid();
  const transcriptId = uuid();

  // Create DB records
  await c.env.DB.prepare(
    "INSERT INTO meetings (id, title, source, status, created_at, updated_at) VALUES (?, ?, ?, 'processing', ?, ?)",
  )
    .bind(meetingId, title, source, now(), now())
    .run();

  await c.env.DB.prepare(
    "INSERT INTO transcripts (id, meeting_id, created_at, updated_at) VALUES (?, ?, ?, ?)",
  )
    .bind(transcriptId, meetingId, now(), now())
    .run();

  // Run pipeline in background (Worker stays alive after response)
  const audioBuffer = await file.arrayBuffer();
  c.executionCtx.waitUntil(
    runFullPipeline(
      c.env,
      meetingId,
      transcriptId,
      audioBuffer,
      file.name,
      language,
      title,
    ),
  );

  return c.json({
    meeting_id: meetingId,
    transcript_id: transcriptId,
    status: "processing",
    message: "Audio received. Transcription and summary in progress.",
  });
});

// ── Audio: streaming chunk ────────────────────────────────────────────

app.post("/api/audio-chunk", async (c) => {
  const formData = await c.req.formData();
  const file = formData.get("file") as File | null;
  if (!file) return c.json({ status: "skipped", reason: "no file" });

  const meetingId = formData.get("meeting_id") as string;
  const chunkIndex = Number(formData.get("chunk_index") ?? 0);
  const language = (formData.get("language") as string | null) ?? "hu";

  const audioBytes = await file.arrayBuffer();
  if (audioBytes.byteLength === 0) return c.json({ status: "skipped", reason: "empty" });

  let text: string;
  try {
    const result = await transcribeAudio(audioBytes, file.name, language, c.env.GROQ_API_KEY);
    text = result.text.trim();
  } catch (e) {
    return c.json({ error: `STT failed: ${e}` }, 500);
  }

  if (!text) return c.json({ status: "skipped", reason: "no speech" });

  // Append to transcript
  const existing = await c.env.DB.prepare(
    "SELECT id, raw_text FROM transcripts WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(meetingId)
    .first<{ id: string; raw_text: string | null }>();

  if (existing) {
    const combined = ((existing.raw_text ?? "") + " " + text).trim();
    await c.env.DB.prepare(
      "UPDATE transcripts SET raw_text = ?, updated_at = ? WHERE id = ?",
    )
      .bind(combined, now(), existing.id)
      .run();
  } else {
    await c.env.DB.prepare(
      "INSERT INTO transcripts (id, meeting_id, raw_text, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(uuid(), meetingId, text, now(), now())
      .run();
  }

  // Every 2nd chunk: generate an AI question based on accumulated transcript
  let aiQuestion: string | null = null;
  if (chunkIndex % 2 === 1 && c.env.GOOGLE_API_KEY) {
    const accumulated = existing
      ? ((existing.raw_text ?? "") + " " + text).trim()
      : text;
    if (accumulated.length >= 50) {
      try {
        aiQuestion = await generateMeetingQuestion(accumulated, c.env.GOOGLE_API_KEY);
      } catch (e) {
        console.warn("[Question gen] failed:", e);
      }
    }
  }

  return c.json({ status: "ok", chunk_index: chunkIndex, chunk_text_length: text.length, question: aiQuestion });
});

// ── Audio: finalize (streaming mode) ─────────────────────────────────

app.post("/api/audio-finalize", async (c) => {
  const formData = await c.req.formData();
  const meetingId = formData.get("meeting_id") as string;
  const language = (formData.get("language") as string | null) ?? "hu";

  const transcript = await c.env.DB.prepare(
    "SELECT id, raw_text FROM transcripts WHERE meeting_id = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(meetingId)
    .first<{ id: string; raw_text: string | null }>();

  const meeting = await getMeeting(c.env.DB, meetingId);
  if (!meeting) return c.json({ error: "Meeting not found" }, 404);

  if (!transcript?.raw_text) {
    await setMeetingStatus(c.env.DB, meetingId, "failed");
    return c.json({ error: "No speech detected in recording", status: "failed" }, 422);
  }

  await setMeetingStatus(c.env.DB, meetingId, "processing");

  c.executionCtx.waitUntil(
    runSummaryPipeline(
      c.env,
      meetingId,
      transcript.id,
      transcript.raw_text,
      meeting.title,
    ),
  );

  return c.json({
    status: "finalizing",
    meeting_id: meetingId,
    transcript_length: transcript.raw_text.length,
  });
});

// ── CRM: companies ────────────────────────────────────────────────────

app.get("/api/crm/companies", async (c) => {
  const search = c.req.query("search") ?? "";
  const limit = Number(c.req.query("limit") ?? 10);

  if (!search) return c.json({ companies: [] });

  const companies = await searchCompanies(
    search, limit, c.env.TWENTY_API_URL, c.env.TWENTY_API_KEY,
  );
  return c.json({ companies });
});

app.post("/api/crm/companies", async (c) => {
  const body = await c.req.json<{
    name: string;
    domain?: string;
    contact_first_name?: string;
    contact_last_name?: string;
    contact_email?: string;
    contact_phone?: string;
  }>();

  const company = await createCompany(
    body.name, body.domain, c.env.TWENTY_API_URL, c.env.TWENTY_API_KEY,
  );

  let personId: string | null = null;
  if (body.contact_first_name) {
    personId = await createPerson(
      body.contact_first_name,
      body.contact_last_name ?? "",
      body.contact_email,
      body.contact_phone,
      company.id,
      c.env.TWENTY_API_URL,
      c.env.TWENTY_API_KEY,
    );
  }

  return c.json({ company, person_id: personId });
});

// ── Bot (not supported in Workers – needs Playwright on VPS) ──────────

app.post("/api/bot/join", (c) =>
  c.json({ error: "Bot requires a VPS with Playwright. Not available in Worker mode." }, 501),
);
app.post("/api/bot/stop/:id", (c) =>
  c.json({ error: "Bot not available in Worker mode." }, 501),
);

// ── Background pipeline functions ─────────────────────────────────────

async function runFullPipeline(
  env: Env,
  meetingId: string,
  transcriptId: string,
  audioBuffer: ArrayBuffer,
  filename: string,
  language: string,
  meetingTitle: string,
): Promise<void> {
  try {
    // Step 1: STT
    const sttResult = await transcribeAudio(audioBuffer, filename, language, env.GROQ_API_KEY);
    await env.DB.prepare(
      "UPDATE transcripts SET raw_text = ?, updated_at = ? WHERE id = ?",
    )
      .bind(sttResult.text, now(), transcriptId)
      .run();

    // Step 2: LLM Summary
    await runSummaryPipeline(env, meetingId, transcriptId, sttResult.text, meetingTitle);
  } catch (e) {
    console.error(`[Pipeline] Failed for meeting ${meetingId}:`, e);
    await setMeetingStatus(env.DB, meetingId, "failed");
  }
}

async function runSummaryPipeline(
  env: Env,
  meetingId: string,
  transcriptId: string,
  rawText: string,
  meetingTitle: string,
): Promise<void> {
  try {
    // Step 1: Generate summary
    const summary = await generateSummary(rawText, env.GOOGLE_API_KEY);
    // Store sections as JSON in executive_summary; plain text fallback derived in llm.ts
    const summaryToStore = summary.sections.length > 0
      ? JSON.stringify(summary.sections)
      : summary.executive_summary;
    const deepAnalysisJson = summary.deep_analysis ? JSON.stringify(summary.deep_analysis) : null;
    await env.DB.prepare(
      "UPDATE transcripts SET executive_summary = ?, action_items = ?, deep_analysis = ?, updated_at = ? WHERE id = ?",
    )
      .bind(
        summaryToStore,
        JSON.stringify(summary.action_items),
        deepAnalysisJson,
        now(),
        transcriptId,
      )
      .run();

    // Step 2: Generate follow-up email
    let emailJson: string | null = null;
    try {
      const email = await generateFollowUpEmail(meetingTitle, summary, env.GOOGLE_API_KEY);
      emailJson = JSON.stringify(email);
      await env.DB.prepare(
        "UPDATE transcripts SET followup_email = ?, updated_at = ? WHERE id = ?",
      )
        .bind(emailJson, now(), transcriptId)
        .run();
    } catch (e) {
      console.warn("Follow-up email generation failed:", e);
    }

    // Mark as completed
    await setMeetingStatus(env.DB, meetingId, "completed");
    console.log(`[Pipeline] Meeting ${meetingId} complete!`);
  } catch (e) {
    console.error(`[Summary pipeline] Failed for meeting ${meetingId}:`, e);
    await setMeetingStatus(env.DB, meetingId, "failed");
  }
}

export default app;
