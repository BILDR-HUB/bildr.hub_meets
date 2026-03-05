"""
twenty_crm_service.py – Twenty CRM integration.

After the AI pipeline generates a meeting summary and action items,
this service pushes the results into Twenty CRM via its GraphQL API:

  1. Creates a Note with the executive summary (bodyV2.markdown)
  2. Creates Task objects from each action item (status: TODO)
  3. Optionally links Notes/Tasks to People via NoteTarget/TaskTarget

Twenty CRM GraphQL endpoint: {TWENTY_API_URL}/graphql
Auth: Bearer token via Authorization header

Schema notes (from live introspection of crm.bildr.hu):
  - Note: title, bodyV2 { blocknote, markdown }
  - Task: title, bodyV2, dueAt, status (TODO|IN_PROGRESS|DONE), assigneeId
  - Linking: NoteTarget (noteId + targetPersonId/targetCompanyId/etc.)
             TaskTarget (taskId + targetPersonId/targetCompanyId/etc.)
"""

from __future__ import annotations

import logging
from datetime import datetime

import httpx

from app.core.config import settings
from app.services.llm_service import MeetingSummary

logger = logging.getLogger(__name__)

TIMEOUT = httpx.Timeout(30.0)


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {settings.twenty_api_key}",
        "Content-Type": "application/json",
    }


def _graphql_url() -> str:
    base = settings.twenty_api_url.rstrip("/")
    return f"{base}/graphql"


# ── Public API ───────────────────────────────────────────────────────


async def search_companies(search_term: str, limit: int = 10) -> list[dict]:
    """Search for companies in Twenty CRM by name (case-insensitive like)."""
    query = """
    query SearchCompanies($filter: CompanyFilterInput, $first: Int) {
      companies(filter: $filter, first: $first) {
        edges {
          node {
            id
            name
            domainName { primaryLinkUrl }
          }
        }
      }
    }
    """
    variables = {
        "filter": {
            "name": {"ilike": f"%{search_term}%"},
        },
        "first": limit,
    }

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(
                _graphql_url(),
                headers=_headers(),
                json={"query": query, "variables": variables},
            )
            response.raise_for_status()
            data = response.json()

            if "errors" in data:
                logger.error("Company search error: %s", data["errors"])
                return []

            edges = data.get("data", {}).get("companies", {}).get("edges", [])
            return [
                {
                    "id": edge["node"]["id"],
                    "name": edge["node"].get("name", ""),
                    "domain": (edge["node"].get("domainName") or {}).get("primaryLinkUrl", ""),
                }
                for edge in edges
            ]
    except Exception as e:
        logger.error("Company search failed: %s", e)
        return []


async def create_company(name: str, domain_name: str | None = None) -> dict | None:
    """Create a new company in Twenty CRM. Returns {id, name}."""
    mutation = """
    mutation CreateCompany($input: CompanyCreateInput!) {
      createCompany(data: $input) {
        id
        name
      }
    }
    """
    input_data: dict = {
        "name": name,
    }
    if domain_name:
        input_data["domainName"] = {"primaryLinkUrl": domain_name}

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(
                _graphql_url(),
                headers=_headers(),
                json={"query": mutation, "variables": {"input": input_data}},
            )
            response.raise_for_status()
            data = response.json()

            if "errors" in data:
                logger.error("Create company error: %s", data["errors"])
                return None

            record = data.get("data", {}).get("createCompany", {})
            company_id = record.get("id")
            logger.info("Created company '%s' -> %s", name, company_id)
            return {"id": company_id, "name": name}
    except Exception as e:
        logger.error("Create company failed: %s", e)
        return None


async def create_person(
    first_name: str,
    last_name: str,
    email: str | None = None,
    phone: str | None = None,
    company_id: str | None = None,
) -> str | None:
    """Create a person in Twenty CRM. Returns person ID."""
    mutation = """
    mutation CreatePerson($input: PersonCreateInput!) {
      createPerson(data: $input) {
        id
      }
    }
    """
    input_data: dict = {
        "name": {"firstName": first_name, "lastName": last_name},
    }
    if email:
        input_data["emails"] = {"primaryEmail": email}
    if phone:
        input_data["phones"] = {"primaryPhoneNumber": phone}
    if company_id:
        input_data["companyId"] = company_id

    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(
                _graphql_url(),
                headers=_headers(),
                json={"query": mutation, "variables": {"input": input_data}},
            )
            response.raise_for_status()
            data = response.json()

            if "errors" in data:
                logger.error("Create person error: %s", data["errors"])
                return None

            record = data.get("data", {}).get("createPerson", {})
            person_id = record.get("id")
            logger.info("Created person '%s %s' -> %s", first_name, last_name, person_id)
            return person_id
    except Exception as e:
        logger.error("Create person failed: %s", e)
        return None


async def link_note_to_company(note_id: str, company_id: str) -> str | None:
    """Link an existing Note to a Company via NoteTarget."""
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        return await _create_note_target(client, note_id, target_company_id=company_id)


async def link_tasks_to_company(task_ids: list[str], company_id: str) -> list[str]:
    """Link existing Tasks to a Company via TaskTarget. Returns created target IDs."""
    results = []
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        for task_id in task_ids:
            target_id = await _create_task_target(client, task_id, target_company_id=company_id)
            if target_id:
                results.append(target_id)
    return results


async def find_note_by_title(title: str) -> str | None:
    """Find a Note in Twenty CRM by exact title. Returns note ID."""
    query = """
    query FindNote($filter: NoteFilterInput) {
      notes(filter: $filter, first: 1) {
        edges { node { id } }
      }
    }
    """
    variables = {"filter": {"title": {"eq": title}}}
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(
                _graphql_url(), headers=_headers(),
                json={"query": query, "variables": variables},
            )
            response.raise_for_status()
            data = response.json()
            edges = data.get("data", {}).get("notes", {}).get("edges", [])
            if edges:
                return edges[0]["node"]["id"]
    except Exception as e:
        logger.warning("Note lookup failed for '%s': %s", title, e)
    return None


async def find_tasks_by_meeting_title(meeting_title: str) -> list[str]:
    """Find Task IDs in Twenty CRM that reference a meeting title in their body."""
    query = """
    query FindTasks($filter: TaskFilterInput) {
      tasks(filter: $filter, first: 50) {
        edges { node { id } }
      }
    }
    """
    variables = {
        "filter": {
            "bodyV2": {"markdown": {"ilike": f"%{meeting_title}%"}},
        }
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(
                _graphql_url(), headers=_headers(),
                json={"query": query, "variables": variables},
            )
            response.raise_for_status()
            data = response.json()
            edges = data.get("data", {}).get("tasks", {}).get("edges", [])
            return [edge["node"]["id"] for edge in edges]
    except Exception as e:
        logger.warning("Task lookup failed for '%s': %s", meeting_title, e)
    return []


async def push_meeting_to_crm(
    meeting_id: str,
    meeting_title: str,
    summary: MeetingSummary,
    followup_email: object | None = None,
    company_id: str | None = None,
    company_name: str | None = None,
) -> dict:
    """
    Push a processed meeting into Twenty CRM.

    Creates:
      - 1 Note with the executive summary (markdown body)
      - N Tasks from action items (status: TODO)

    If company_id and company_name are provided:
      - Note title: "{company_name} - meeting összefoglaló"
      - Note and tasks are immediately linked to the company

    Returns a dict with created record IDs.
    """
    if not settings.twenty_api_url or not settings.twenty_api_key:
        logger.warning("Twenty CRM not configured – skipping CRM push")
        return {"skipped": True}

    result: dict = {
        "note_id": None,
        "task_ids": [],
    }

    note_title = (
        f"{company_name} - meeting összefoglaló"
        if company_name
        else f"Meeting: {meeting_title}"
    )

    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        # ── 1. Create a Note ─────────────────────────────────────────
        note_id = await _create_note(
            client,
            title=note_title,
            markdown_body=_format_note_body(meeting_title, summary, followup_email),
        )
        result["note_id"] = note_id

        # ── 2. Link Note to company (if provided) ────────────────────
        if note_id and company_id:
            await _create_note_target(client, note_id, target_company_id=company_id)

        # ── 3. Create Tasks from action items ────────────────────────
        for item in summary.action_items:
            body_parts = [f"From meeting: {meeting_title}"]
            if item.assignee:
                body_parts.append(f"Assignee: {item.assignee}")
            if item.deadline:
                body_parts.append(f"Deadline: {item.deadline}")
            body_parts.append(f"Priority: {item.priority}")

            task_id = await _create_task(
                client,
                title=item.task,
                markdown_body="\n".join(body_parts),
                deadline=item.deadline,
            )
            if task_id:
                result["task_ids"].append(task_id)

                # Link task to company (if provided)
                if company_id:
                    await _create_task_target(client, task_id, target_company_id=company_id)

                # Try to link task to a Person if assignee name is given
                if item.assignee:
                    person_id = await find_person_by_name(client, item.assignee)
                    if person_id:
                        await _create_task_target(client, task_id, target_person_id=person_id)

        # ── 4. Try to link the Note to matched People ────────────────
        if note_id:
            for item in summary.action_items:
                if item.assignee:
                    person_id = await find_person_by_name(client, item.assignee)
                    if person_id:
                        await _create_note_target(client, note_id, target_person_id=person_id)

    logger.info(
        "CRM push complete for meeting '%s': note=%s, tasks=%d, company=%s",
        meeting_title,
        result["note_id"],
        len(result["task_ids"]),
        company_name,
    )
    return result


# ── Note creation (bodyV2 with markdown) ─────────────────────────────

async def _create_note(
    client: httpx.AsyncClient,
    title: str,
    markdown_body: str,
) -> str | None:
    """Create a Note with RichTextV2 markdown body."""
    mutation = """
    mutation CreateNote($input: NoteCreateInput!) {
      createNote(data: $input) {
        id
      }
    }
    """
    variables = {
        "input": {
            "title": title,
            "bodyV2": {
                "markdown": markdown_body,
            },
        }
    }
    return await _execute_mutation(client, mutation, variables, "createNote")


# ── NoteTarget linking ───────────────────────────────────────────────

async def _create_note_target(
    client: httpx.AsyncClient,
    note_id: str,
    target_person_id: str | None = None,
    target_company_id: str | None = None,
) -> str | None:
    """Link a Note to a Person or Company via NoteTarget."""
    mutation = """
    mutation CreateNoteTarget($input: NoteTargetCreateInput!) {
      createNoteTarget(data: $input) {
        id
      }
    }
    """
    input_data: dict = {"noteId": note_id}
    if target_person_id:
        input_data["targetPersonId"] = target_person_id
    if target_company_id:
        input_data["targetCompanyId"] = target_company_id

    variables = {"input": input_data}
    return await _execute_mutation(client, mutation, variables, "createNoteTarget")


# ── Task creation ────────────────────────────────────────────────────

async def _create_task(
    client: httpx.AsyncClient,
    title: str,
    markdown_body: str,
    deadline: str | None = None,
) -> str | None:
    """Create a Task with status TODO and optional dueAt."""
    mutation = """
    mutation CreateTask($input: TaskCreateInput!) {
      createTask(data: $input) {
        id
      }
    }
    """
    input_data: dict = {
        "title": title,
        "bodyV2": {
            "markdown": markdown_body,
        },
        "status": "TODO",
    }

    due_at = _parse_deadline(deadline)
    if due_at:
        input_data["dueAt"] = due_at

    variables = {"input": input_data}
    return await _execute_mutation(client, mutation, variables, "createTask")


# ── TaskTarget linking ───────────────────────────────────────────────

async def _create_task_target(
    client: httpx.AsyncClient,
    task_id: str,
    target_person_id: str | None = None,
    target_company_id: str | None = None,
) -> str | None:
    """Link a Task to a Person or Company via TaskTarget."""
    mutation = """
    mutation CreateTaskTarget($input: TaskTargetCreateInput!) {
      createTaskTarget(data: $input) {
        id
      }
    }
    """
    input_data: dict = {"taskId": task_id}
    if target_person_id:
        input_data["targetPersonId"] = target_person_id
    if target_company_id:
        input_data["targetCompanyId"] = target_company_id

    variables = {"input": input_data}
    return await _execute_mutation(client, mutation, variables, "createTaskTarget")


# ── Person lookup ────────────────────────────────────────────────────

async def find_person_by_name(
    client: httpx.AsyncClient,
    name: str,
) -> str | None:
    """
    Search for a Person in Twenty CRM by first name.
    Returns the person ID if found, None otherwise.
    """
    # Twenty stores Hungarian names as firstName=family, lastName=given
    parts = name.strip().split(maxsplit=1)
    first_name = parts[0] if parts else name

    query = """
    query FindPerson($filter: PersonFilterInput) {
      people(filter: $filter, first: 1) {
        edges {
          node {
            id
            name { firstName lastName }
          }
        }
      }
    }
    """
    variables = {
        "filter": {
            "name": {
                "firstName": {"eq": first_name},
            }
        }
    }

    try:
        response = await client.post(
            _graphql_url(),
            headers=_headers(),
            json={"query": query, "variables": variables},
        )
        response.raise_for_status()
        data = response.json()

        edges = data.get("data", {}).get("people", {}).get("edges", [])
        if edges:
            person_id = edges[0]["node"]["id"]
            logger.info("Found person '%s' -> %s", name, person_id)
            return person_id
    except Exception as e:
        logger.warning("Person lookup failed for '%s': %s", name, e)

    return None


# ── GraphQL helpers ──────────────────────────────────────────────────

async def _execute_mutation(
    client: httpx.AsyncClient,
    mutation: str,
    variables: dict,
    operation_name: str,
) -> str | None:
    """Execute a GraphQL mutation and return the created record ID."""
    try:
        response = await client.post(
            _graphql_url(),
            headers=_headers(),
            json={"query": mutation, "variables": variables},
        )
        response.raise_for_status()
        data = response.json()

        if "errors" in data:
            logger.error(
                "Twenty CRM GraphQL error (%s): %s",
                operation_name,
                data["errors"],
            )
            return None

        record = data.get("data", {}).get(operation_name, {})
        record_id = record.get("id")
        logger.info("Twenty CRM %s created: %s", operation_name, record_id)
        return record_id

    except httpx.HTTPStatusError as e:
        logger.error(
            "Twenty CRM HTTP error (%s): %d %s",
            operation_name,
            e.response.status_code,
            e.response.text[:200],
        )
    except Exception as e:
        logger.error("Twenty CRM request failed (%s): %s", operation_name, e)

    return None


def _parse_deadline(deadline: str | None) -> str | None:
    """Try to parse a deadline string into ISO 8601 format for Twenty.

    Supports Hungarian relative dates (holnap, holnapután, day names)
    and standard date formats.
    """
    if not deadline:
        return None

    dl = deadline.strip().lower()
    today = datetime.now()

    # Hungarian relative dates
    hu_relative = {
        "holnap": 1,
        "holnapután": 2,
        "holnaputan": 2,
        "ma": 0,
        "tegnapelőtt": -2,
        "tegnap": -1,
    }
    if dl in hu_relative:
        from datetime import timedelta
        dt = today + timedelta(days=hu_relative[dl])
        return dt.strftime("%Y-%m-%dT09:00:00Z")

    # Hungarian day names → next occurrence
    hu_days = {
        "hétfő": 0, "hétfon": 0, "hetfo": 0, "hetfon": 0,
        "kedd": 1, "kedden": 1,
        "szerda": 2, "szerdán": 2, "szerdan": 2,
        "csütörtök": 3, "csütörtökön": 3, "csutortok": 3,
        "péntek": 4, "pénteken": 4, "pentek": 4,
        "szombat": 5, "szombaton": 5,
        "vasárnap": 6, "vasarnap": 6,
    }
    # Also match with "jövő" prefix (jövő hétfőn = next Monday)
    stripped = dl.replace("jövő ", "").replace("jovo ", "").rstrip("n")
    for day_name, day_num in hu_days.items():
        if dl == day_name or stripped == day_name or stripped == day_name.rstrip("n"):
            from datetime import timedelta
            current_day = today.weekday()
            days_ahead = day_num - current_day
            if days_ahead <= 0:
                days_ahead += 7
            dt = today + timedelta(days=days_ahead)
            return dt.strftime("%Y-%m-%dT09:00:00Z")

    # Standard date formats
    for fmt in ("%Y-%m-%d", "%Y.%m.%d", "%m/%d/%Y", "%d/%m/%Y", "%B %d, %Y"):
        try:
            dt = datetime.strptime(deadline.strip(), fmt)
            return dt.isoformat() + "Z"
        except ValueError:
            continue

    logger.warning("Could not parse deadline: '%s'", deadline)
    return None


def _format_note_body(
    meeting_title: str,
    summary: MeetingSummary,
    followup_email: object | None = None,
) -> str:
    """Format the meeting summary as markdown for Twenty's RichTextV2."""
    lines = [
        f"# {meeting_title}",
        f"*Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')}*",
        "",
        "## Executive Summary",
        summary.executive_summary,
    ]

    if summary.action_items:
        lines.append("")
        lines.append("## Action Items")
        for i, item in enumerate(summary.action_items, 1):
            assignee = f" (@{item.assignee})" if item.assignee else ""
            deadline = f" – due: {item.deadline}" if item.deadline else ""
            priority_tag = f" [{item.priority.upper()}]" if item.priority != "medium" else ""
            lines.append(f"{i}. {item.task}{assignee}{deadline}{priority_tag}")

    if followup_email and hasattr(followup_email, "subject"):
        lines.append("")
        lines.append("## Follow-up Email")
        lines.append(f"**Tárgy:** {followup_email.subject}")
        lines.append("")
        lines.append(followup_email.body)

    return "\n".join(lines)
