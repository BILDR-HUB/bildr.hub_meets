/**
 * crm.ts – Twenty CRM GraphQL integration
 */

import type { MeetingSummary, ActionItem, FollowUpEmail } from "./llm";

export interface CrmCompany {
  id: string;
  name: string;
  domain: string;
}

function gqlUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/$/, "")}/graphql`;
}

function headers(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function gql<T>(
  apiUrl: string,
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(gqlUrl(apiUrl), {
    method: "POST",
    headers: headers(apiKey),
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Twenty CRM HTTP ${res.status}`);
  const data = (await res.json()) as { data?: T; errors?: unknown[] };
  if (data.errors?.length) throw new Error(`GraphQL: ${JSON.stringify(data.errors)}`);
  return data.data as T;
}

// ── List all companies (no filter) ────────────────────────────────────

export async function listAllCompanies(
  limit: number,
  apiUrl: string,
  apiKey: string,
): Promise<CrmCompany[]> {
  const q = `query ListCompanies($first: Int) {
    companies(first: $first, orderBy: { name: AscNullsLast }) {
      edges { node { id name domainName { primaryLinkUrl } } }
    }
  }`;
  const data = await gql<{
    companies: { edges: Array<{ node: { id: string; name: string; domainName?: { primaryLinkUrl?: string } } }> };
  }>(apiUrl, apiKey, q, { first: limit });
  return data.companies.edges.map((e) => ({
    id: e.node.id,
    name: e.node.name ?? "",
    domain: e.node.domainName?.primaryLinkUrl ?? "",
  }));
}

// ── Company search ────────────────────────────────────────────────────

export async function searchCompanies(
  search: string,
  limit: number,
  apiUrl: string,
  apiKey: string,
): Promise<CrmCompany[]> {
  const q = `query SearchCompanies($filter: CompanyFilterInput, $first: Int) {
    companies(filter: $filter, first: $first) {
      edges { node { id name domainName { primaryLinkUrl } } }
    }
  }`;
  const data = await gql<{
    companies: { edges: Array<{ node: { id: string; name: string; domainName?: { primaryLinkUrl?: string } } }> };
  }>(apiUrl, apiKey, q, {
    filter: { name: { ilike: `%${search}%` } },
    first: limit,
  });
  return data.companies.edges.map((e) => ({
    id: e.node.id,
    name: e.node.name ?? "",
    domain: e.node.domainName?.primaryLinkUrl ?? "",
  }));
}

// ── Company create ────────────────────────────────────────────────────

export async function createCompany(
  name: string,
  domain: string | undefined,
  apiUrl: string,
  apiKey: string,
): Promise<CrmCompany> {
  const mut = `mutation CreateCompany($input: CompanyCreateInput!) {
    createCompany(data: $input) { id name }
  }`;
  const input: Record<string, unknown> = { name };
  if (domain) input["domainName"] = { primaryLinkUrl: domain };
  const data = await gql<{ createCompany: { id: string; name: string } }>(
    apiUrl, apiKey, mut, { input },
  );
  return { id: data.createCompany.id, name: data.createCompany.name, domain: domain ?? "" };
}

// ── Person create ─────────────────────────────────────────────────────

export async function createPerson(
  firstName: string,
  lastName: string,
  email: string | undefined,
  phone: string | undefined,
  companyId: string,
  apiUrl: string,
  apiKey: string,
): Promise<string | null> {
  const mut = `mutation CreatePerson($input: PersonCreateInput!) {
    createPerson(data: $input) { id }
  }`;
  const input: Record<string, unknown> = {
    name: { firstName, lastName },
    companyId,
  };
  if (email) input["emails"] = { primaryEmail: email };
  if (phone) input["phones"] = { primaryPhoneNumber: phone };
  const data = await gql<{ createPerson: { id: string } }>(
    apiUrl, apiKey, mut, { input },
  );
  return data.createPerson.id ?? null;
}

// ── Note + Task creation with company linking ─────────────────────────

export async function pushMeetingToCrm(
  meetingTitle: string,
  summary: MeetingSummary,
  followupEmail: FollowUpEmail | null,
  companyId: string,
  companyName: string,
  apiUrl: string,
  apiKey: string,
): Promise<{ note_id: string | null; task_ids: string[] }> {
  const noteTitle = `${companyName} - meeting összefoglaló`;
  const noteBody = formatNoteBody(meetingTitle, summary, followupEmail);

  const result: { note_id: string | null; task_ids: string[] } = {
    note_id: null,
    task_ids: [],
  };

  // 1. Create Note
  const noteMut = `mutation CreateNote($input: NoteCreateInput!) {
    createNote(data: $input) { id }
  }`;
  try {
    const noteData = await gql<{ createNote: { id: string } }>(
      apiUrl, apiKey, noteMut,
      { input: { title: noteTitle, bodyV2: { markdown: noteBody } } },
    );
    result.note_id = noteData.createNote.id;

    // 2. Link Note to company
    if (result.note_id) {
      const targetMut = `mutation CreateNoteTarget($input: NoteTargetCreateInput!) {
        createNoteTarget(data: $input) { id }
      }`;
      await gql(apiUrl, apiKey, targetMut, {
        input: { noteId: result.note_id, targetCompanyId: companyId },
      });
    }
  } catch (e) {
    console.error("Note creation failed:", e);
  }

  // 3. Create Tasks
  for (const item of summary.action_items) {
    const taskMut = `mutation CreateTask($input: TaskCreateInput!) {
      createTask(data: $input) { id }
    }`;
    try {
      const body = [
        `From meeting: ${meetingTitle}`,
        item.assignee ? `Assignee: ${item.assignee}` : null,
        item.deadline ? `Deadline: ${item.deadline}` : null,
        `Priority: ${item.priority}`,
      ]
        .filter(Boolean)
        .join("\n");

      const taskData = await gql<{ createTask: { id: string } }>(
        apiUrl, apiKey, taskMut,
        { input: { title: item.task, bodyV2: { markdown: body }, status: "TODO" } },
      );
      const taskId = taskData.createTask.id;
      result.task_ids.push(taskId);

      // Link task to company
      const taskTargetMut = `mutation CreateTaskTarget($input: TaskTargetCreateInput!) {
        createTaskTarget(data: $input) { id }
      }`;
      await gql(apiUrl, apiKey, taskTargetMut, {
        input: { taskId, targetCompanyId: companyId },
      });
    } catch (e) {
      console.error("Task creation failed:", e);
    }
  }

  return result;
}

// ── Note body formatter ───────────────────────────────────────────────

function formatNoteBody(
  meetingTitle: string,
  summary: MeetingSummary,
  email: FollowUpEmail | null,
): string {
  const lines = [
    `# ${meetingTitle}`,
    `*Generálva: ${new Date().toISOString().replace("T", " ").slice(0, 16)}*`,
    "",
    "## Összefoglaló",
    summary.executive_summary,
  ];

  if (summary.action_items.length > 0) {
    lines.push("", "## Feladatok");
    summary.action_items.forEach((item, i) => {
      const assignee = item.assignee ? ` (@${item.assignee})` : "";
      const deadline = item.deadline ? ` – határidő: ${item.deadline}` : "";
      lines.push(`${i + 1}. ${item.task}${assignee}${deadline} [${item.priority.toUpperCase()}]`);
    });
  }

  if (email) {
    lines.push("", "## Follow-up email", `**Tárgy:** ${email.subject}`, "", email.body);
  }

  return lines.join("\n");
}

// ── Link existing note/tasks to company (legacy) ──────────────────────

export async function linkNoteToCompany(
  noteId: string,
  companyId: string,
  apiUrl: string,
  apiKey: string,
): Promise<void> {
  const mut = `mutation CreateNoteTarget($input: NoteTargetCreateInput!) {
    createNoteTarget(data: $input) { id }
  }`;
  await gql(apiUrl, apiKey, mut, { input: { noteId, targetCompanyId: companyId } });
}

export async function linkTasksToCompany(
  taskIds: string[],
  companyId: string,
  apiUrl: string,
  apiKey: string,
): Promise<void> {
  const mut = `mutation CreateTaskTarget($input: TaskTargetCreateInput!) {
    createTaskTarget(data: $input) { id }
  }`;
  for (const taskId of taskIds) {
    await gql(apiUrl, apiKey, mut, { input: { taskId, targetCompanyId: companyId } });
  }
}
