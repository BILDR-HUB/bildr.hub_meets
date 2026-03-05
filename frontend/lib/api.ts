/**
 * API client for the FastAPI backend.
 */

const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://localhost:8000";

interface Meeting {
  id: string;
  user_id: string;
  title: string;
  source: "bot" | "upload" | "voice_note";
  status: "pending" | "recording" | "processing" | "completed" | "failed";
  created_at: string;
  company_id: string | null;
  company_name: string | null;
}

interface CrmCompany {
  id: string;
  name: string;
  domain: string;
}

interface FollowUpEmail {
  subject: string;
  body: string;
}

interface Transcript {
  id: string;
  meeting_id: string;
  raw_text: string | null;
  executive_summary: string | null;
  action_items: ActionItem[];
  audio_url: string | null;
  diarized_text: string | null;
  followup_email: FollowUpEmail | null;
}

interface ActionItem {
  assignee: string | null;
  task: string;
  deadline: string | null;
  priority: string;
}

// ── Meetings ────────────────────────────────────────────────────────

export async function listMeetings(limit = 20): Promise<Meeting[]> {
  const res = await fetch(`${API_URL}/api/meetings?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to list meetings: ${res.status}`);
  const data = await res.json();
  return data.meetings;
}

export async function getMeeting(
  meetingId: string
): Promise<{ meeting: Meeting; transcript: Transcript | null }> {
  const res = await fetch(`${API_URL}/api/meetings/${meetingId}`);
  if (!res.ok) throw new Error(`Failed to get meeting: ${res.status}`);
  return res.json();
}

export async function getMeetingStatus(
  meetingId: string
): Promise<{ id: string; status: string; title: string }> {
  const res = await fetch(`${API_URL}/api/meetings/${meetingId}/status`);
  if (!res.ok) throw new Error(`Failed to get status: ${res.status}`);
  return res.json();
}

export async function deleteMeeting(meetingId: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/meetings/${meetingId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete meeting: ${res.status}`);
}

export async function updateMeetingTitle(
  meetingId: string,
  title: string
): Promise<void> {
  const res = await fetch(`${API_URL}/api/meetings/${meetingId}/title`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`Failed to update title: ${res.status}`);
}

// ── Audio upload ────────────────────────────────────────────────────

/**
 * Upload audio – works on both web (Blob/File) and React Native (file URI).
 * On web, pass a Blob directly via the `blob` option.
 * On native, pass a file URI string.
 */
export async function uploadAudio(
  fileUri: string,
  fileName: string,
  options: {
    title?: string;
    source?: string;
    language?: string;
    blob?: Blob;
  } = {}
): Promise<{ meeting_id: string; transcript_id: string; status: string }> {
  const formData = new FormData();

  if (options.blob) {
    // Web: use the Blob directly as a File
    const file = new File([options.blob], fileName, {
      type: options.blob.type || "audio/webm",
    });
    formData.append("file", file);
  } else {
    // React Native: use URI-based object
    formData.append("file", {
      uri: fileUri,
      name: fileName,
      type: "audio/webm",
    } as unknown as Blob);
  }

  if (options.title) formData.append("title", options.title);
  formData.append("source", options.source || "voice_note");
  formData.append("language", options.language || "hu");

  const res = await fetch(`${API_URL}/api/process-audio`, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed: ${res.status} ${text}`);
  }

  return res.json();
}

// ── Bot ─────────────────────────────────────────────────────────────

export async function startBot(
  meetUrl: string,
  botName = "Meeting Bot",
  title = "Untitled Meeting"
): Promise<Meeting> {
  const res = await fetch(`${API_URL}/api/bot/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      meet_url: meetUrl,
      bot_name: botName,
      title,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Bot start failed: ${res.status} ${text}`);
  }

  return res.json();
}

export async function stopBot(meetingId: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/bot/stop/${meetingId}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Bot stop failed: ${res.status}`);
}

// ── CRM ──────────────────────────────────────────────────────────────

export async function searchCompanies(search: string): Promise<CrmCompany[]> {
  const res = await fetch(
    `${API_URL}/api/crm/companies?search=${encodeURIComponent(search)}`
  );
  if (!res.ok) throw new Error(`Company search failed: ${res.status}`);
  const data = await res.json();
  return data.companies;
}

export async function createCompany(body: {
  name: string;
  domain?: string;
  contact_first_name?: string;
  contact_last_name?: string;
  contact_email?: string;
  contact_phone?: string;
}): Promise<{ company: CrmCompany; person_id: string | null }> {
  const res = await fetch(`${API_URL}/api/crm/companies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Create company failed: ${res.status}`);
  return res.json();
}

export async function linkMeetingToCompany(
  meetingId: string,
  companyId: string,
  companyName: string
): Promise<{ crm_note_id: string | null; crm_note_created: boolean; linked_tasks: number }> {
  const res = await fetch(`${API_URL}/api/meetings/${meetingId}/company`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ company_id: companyId, company_name: companyName }),
  });
  if (!res.ok) throw new Error(`Link company failed: ${res.status}`);
  return res.json();
}

export type { Meeting, Transcript, ActionItem, FollowUpEmail, CrmCompany };
