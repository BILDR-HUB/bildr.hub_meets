"""
routers/crm.py – Twenty CRM company search and creation endpoints.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.services.twenty_crm_service import (
    create_company,
    create_person,
    search_companies,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/crm", tags=["crm"])


@router.get("/companies")
async def search_crm_companies(
    search: str = Query(..., min_length=1, description="Search term for company name"),
    limit: int = Query(10, ge=1, le=50),
):
    """Search for companies in Twenty CRM."""
    results = await search_companies(search, limit)
    return {"companies": results}


class CreateCompanyRequest(BaseModel):
    name: str
    domain: str | None = None
    contact_first_name: str | None = None
    contact_last_name: str | None = None
    contact_email: str | None = None
    contact_phone: str | None = None


@router.post("/companies")
async def create_crm_company(body: CreateCompanyRequest):
    """Create a new company in Twenty CRM, optionally with a contact person."""
    company = await create_company(body.name, body.domain)
    if not company:
        raise HTTPException(status_code=502, detail="Failed to create company in CRM")

    person_id = None
    if body.contact_first_name:
        person_id = await create_person(
            first_name=body.contact_first_name,
            last_name=body.contact_last_name or "",
            email=body.contact_email,
            phone=body.contact_phone,
            company_id=company["id"],
        )

    return {
        "company": company,
        "person_id": person_id,
    }
