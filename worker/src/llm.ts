/**
 * llm.ts – LLM summary + follow-up email via Google Gemini
 */

export interface ActionItem {
  task: string;
  assignee: string | null;
  deadline: string | null;
  priority: "high" | "medium" | "low";
}

export interface MeetingSummary {
  executive_summary: string;
  action_items: ActionItem[];
  diarized_transcript: string | null;
}

export interface FollowUpEmail {
  subject: string;
  body: string;
}

const SUMMARY_PROMPT = `Te egy tapasztalt meeting-elemző vagy. A nyers meeting átirat alapján készíts strukturált JSON választ.

FONTOS: Az összefoglaló és a feladatok leírása MINDIG magyar nyelven legyen.

Pontosan ezt a JSON struktúrát add vissza, semmi mást:
{
  "executive_summary": "Tömör, professzionális összefoglaló (3-8 mondat magyarul)",
  "action_items": [
    {
      "task": "Elvégzendő feladat leírása",
      "assignee": "Felelős neve vagy null",
      "deadline": "Határidő szövegesen vagy null",
      "priority": "high|medium|low"
    }
  ]
}`;

export async function generateSummary(
  transcript: string,
  googleApiKey: string,
): Promise<MeetingSummary> {
  const prompt = `${SUMMARY_PROMPT}\n\nMeeting átirat:\n${transcript}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${googleApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.3,
        },
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    candidates: Array<{
      content: { parts: Array<{ text: string }> };
    }>;
  };

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  const parsed = JSON.parse(rawText) as {
    executive_summary?: string;
    action_items?: ActionItem[];
  };

  return {
    executive_summary: parsed.executive_summary ?? "",
    action_items: parsed.action_items ?? [],
    diarized_transcript: null,
  };
}

const EMAIL_PROMPT = `Írj egy rövid, professzionális follow-up emailt a meeting után magyarul.
Pontosan ezt a JSON struktúrát add vissza:
{"subject": "Email tárgya", "body": "Email törzse"}`;

export async function generateFollowUpEmail(
  meetingTitle: string,
  summary: MeetingSummary,
  googleApiKey: string,
): Promise<FollowUpEmail> {
  const prompt = `${EMAIL_PROMPT}

Meeting: ${meetingTitle}
Összefoglaló: ${summary.executive_summary}
Feladatok: ${summary.action_items.map((i) => `- ${i.task}`).join("\n")}`;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${googleApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.5,
        },
      }),
    },
  );

  if (!response.ok) throw new Error(`Email gen failed: ${response.status}`);

  const data = (await response.json()) as {
    candidates: Array<{
      content: { parts: Array<{ text: string }> };
    }>;
  };

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
  const parsed = JSON.parse(rawText) as {
    subject?: string;
    body?: string;
  };

  return {
    subject: parsed.subject ?? `Follow-up: ${meetingTitle}`,
    body: parsed.body ?? "",
  };
}
