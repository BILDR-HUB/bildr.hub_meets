/**
 * llm.ts – LLM summary + follow-up email via Google Gemini
 */

export interface ActionItem {
  task: string;
  assignee: string | null;
  deadline: string | null;
  priority: "high" | "medium" | "low";
}

export interface SummarySection {
  title: string;
  points: string[];
}

export interface DeepAnalysis {
  decisions: string[];            // Meghozott döntések
  risks: string[];                // Kockázatok, aggályok
  financials: string[];           // Pénzügyi vonatkozások (árak, budget, költségek)
  next_steps: string[];           // Konkrét következő lépések
  sentiment: "positive" | "neutral" | "negative" | "mixed";
  sentiment_notes: string;        // Hangulat részletezés
  key_quotes: string[];           // Fontos idézetek a meetingből
  participants: string[];         // Résztvevők nevei
  meeting_type: string;           // pl. "sales", "project_kickoff", "support", "brainstorm", "standup"
  topics_discussed: string[];     // Főbb témák egyszerű listája
  open_questions: string[];       // Nyitott kérdések amik nem kaptak választ
}

export interface MeetingSummary {
  sections: SummarySection[];
  executive_summary: string; // derived plain text for CRM / backward compat
  action_items: ActionItem[];
  diarized_transcript: string | null;
  deep_analysis: DeepAnalysis | null;
}

export interface FollowUpEmail {
  subject: string;
  body: string;
}

// ── Gemini helper with 429 retry ──────────────────────────────────────

async function geminiPost(
  googleApiKey: string,
  body: object,
  retries = 3,
): Promise<Response> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${googleApiKey}`;
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status !== 429) return res;
    const wait = (i + 1) * 8000; // 8s, 16s, 24s
    console.warn(`[Gemini] 429 rate limit, retrying in ${wait / 1000}s...`);
    await new Promise((r) => setTimeout(r, wait));
  }
  throw new Error("Gemini rate limit: all retries exhausted");
}

// ── Summary ───────────────────────────────────────────────────────────

const SUMMARY_PROMPT = `Te egy tapasztalt üzleti tanácsadó és meeting-elemző vagy. A nyers meeting átirat alapján készíts MÉLYELEMZÉST, nem csak összefoglalót.

FONTOS: Minden szöveg MINDIG magyar nyelven legyen.

Az összefoglalót alfejezetek szerint strukturáld. Az alábbi témák közül csak azokat add vissza, amelyek ténylegesen szerepelnek a meetingben:
- "Bemutatkozás" – ki vett részt, milyen cégek/személyek mutatkoztak be, mi a kontextus
- "Folyamat" – a megbeszélés fő tartalma, téma, feladat, probléma, megoldás
- "Árazás" – konkrét árak, költségek, ajánlatok, budget, díjak, fizetési feltételek
- Ha egyéb fontos téma merül fel (pl. "Technológia", "Határidők", "Jogi kérdések"), azt is add hozzá

Minden alfejezet 2–5 rövid, konkrét bullet pointot tartalmazzon.

A "deep_analysis" mezőben adj RÉSZLETES üzleti elemzést:
- decisions: Milyen döntések születtek? (üres tömb ha nincs)
- risks: Milyen kockázatok, aggályok merültek fel? Implicit veszélyek?
- financials: Minden pénzügyi vonatkozás – árak, budget, költségbecslés, fizetési feltételek, bevétel, megtérülés
- next_steps: Konkrét következő lépések időrendben
- sentiment: A meeting általános hangulata ("positive" / "neutral" / "negative" / "mixed")
- sentiment_notes: 1-2 mondat a hangulatról, miért érzed ezt
- key_quotes: 2-4 fontos, szó szerinti vagy közel szó szerinti idézet a meetingből
- participants: A meetingben résztvevő személyek nevei (ha kiderülnek)
- meeting_type: Típus kategória (sales/project_kickoff/support/brainstorm/standup/review/interview/internal/other)
- topics_discussed: A főbb témák egyszerű listája (3-8 téma)
- open_questions: Nyitva maradt kérdések, amikre nem született válasz

Pontosan ezt a JSON struktúrát add vissza, semmi mást:
{
  "sections": [
    {"title": "Bemutatkozás", "points": ["pont 1", "pont 2"]},
    {"title": "Folyamat", "points": ["pont 1", "pont 2", "pont 3"]}
  ],
  "action_items": [
    {"task": "Feladat leírása", "assignee": "Felelős neve vagy null", "deadline": "Határidő vagy null", "priority": "high|medium|low"}
  ],
  "deep_analysis": {
    "decisions": ["Döntés 1"],
    "risks": ["Kockázat 1"],
    "financials": ["Pénzügyi pont 1"],
    "next_steps": ["Következő lépés 1"],
    "sentiment": "positive",
    "sentiment_notes": "A meeting pozitív volt mert...",
    "key_quotes": ["Idézet 1"],
    "participants": ["Név 1"],
    "meeting_type": "sales",
    "topics_discussed": ["Téma 1", "Téma 2"],
    "open_questions": ["Kérdés 1"]
  }
}`;

export async function generateSummary(
  transcript: string,
  googleApiKey: string,
): Promise<MeetingSummary> {
  const prompt = `${SUMMARY_PROMPT}\n\nMeeting átirat:\n${transcript}`;

  const response = await geminiPost(googleApiKey, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.3,
    },
  });

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
    sections?: SummarySection[];
    action_items?: ActionItem[];
    deep_analysis?: DeepAnalysis;
  };

  const sections = parsed.sections ?? [];

  // Derive plain text from sections for CRM / backward compat
  const executive_summary = sections
    .map((s) => `${s.title}:\n${s.points.map((p) => `- ${p}`).join("\n")}`)
    .join("\n\n");

  return {
    sections,
    executive_summary,
    action_items: parsed.action_items ?? [],
    diarized_transcript: null,
    deep_analysis: parsed.deep_analysis ?? null,
  };
}

// ── Meeting question ──────────────────────────────────────────────────

export async function generateMeetingQuestion(
  transcript: string,
  googleApiKey: string,
): Promise<string | null> {
  if (transcript.length < 50) return null;

  const prompt = `Te egy tapasztalt projekt menedzser vagy, aki éppen meghallgat egy meetinget. Egyetlen kérdést teszel fel, ami segít mélyebben megérteni:
- mi a valódi probléma amit meg akarnak oldani
- mit akar konkrétan a megrendelő/ügyfél
- mi a következő lépés vagy döntés ami szükséges

A kérdés legyen:
- Emberi, közvetlen hangvételű
- Fókuszált az üzleti folyamatra, nem a technológiára
- Max 2 mondat
- Magyar nyelven

Csak a kérdést add vissza, semmi mást.

Meeting átirat (utolsó részlet):
${transcript.slice(-2000)}`;

  try {
    const response = await geminiPost(googleApiKey, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 120 },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
    };
    return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
  } catch {
    return null;
  }
}

// ── Follow-up email ───────────────────────────────────────────────────

const EMAIL_PROMPT = `Írj egy professzionális, személyes hangvételű follow-up emailt a meeting után, magyarul.
Az email legyen konkrét: hivatkozzon a megbeszélt témákra, döntésekre, következő lépésekre.
Ne legyen sablon jellegű – tükrözze azt, ami ténylegesen elhangzott.

Az email szerkezete:
1. Köszönő mondat + rövid utalás a megbeszélés fő témájára
2. A megbeszélt főbb pontok összefoglalása (2-4 bullet point, teljes mondatokban)
3. Következő lépések / feladatok egyértelmű felsorolása felelőssel és határidővel ha van
4. Lezárás és köszönetnyilvánítás

Pontosan ezt a JSON struktúrát add vissza, semmi mást:
{"subject": "Konkrét, személyre szabott email tárgy", "body": "Email törzse (sortörésekkel formázva, HTML nélkül)"}`;

export async function generateFollowUpEmail(
  meetingTitle: string,
  summary: MeetingSummary,
  googleApiKey: string,
): Promise<FollowUpEmail> {
  const sectionsText = summary.sections.length > 0
    ? summary.sections.map((s) => `${s.title}:\n${s.points.map((p) => `- ${p}`).join("\n")}`).join("\n\n")
    : summary.executive_summary;

  const actionItemsText = summary.action_items.length > 0
    ? summary.action_items.map((i) => `- ${i.task}${i.assignee ? ` (${i.assignee})` : ""}${i.deadline ? ` – határidő: ${i.deadline}` : ""}`).join("\n")
    : "Nincsenek konkrét feladatok.";

  const prompt = `${EMAIL_PROMPT}

Meeting címe: ${meetingTitle}

Megbeszélt témák:
${sectionsText}

Feladatok:
${actionItemsText}`;

  const response = await geminiPost(googleApiKey, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.5,
    },
  });

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
