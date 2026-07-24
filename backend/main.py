import uuid
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_session, init_db
from models import Project
from schemas import ProjectOut, ProjectUpsert


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="NeuronBLK Sync API", lifespan=lifespan)

# Adjust to match your Vite/dev server origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/projects", response_model=list[ProjectOut])
async def list_projects(
    client_id: uuid.UUID = Query(...),
    session: AsyncSession = Depends(get_session),
):
    result = await session.execute(select(Project).where(Project.client_id == client_id))
    return result.scalars().all()


@app.get("/api/projects/{project_id}", response_model=ProjectOut)
async def get_project(project_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    project = await session.get(Project, project_id)
    if not project:
        raise HTTPException(404, "Project not found")
    return project


@app.put("/api/projects/{project_id}", response_model=ProjectOut)
async def upsert_project(
    project_id: uuid.UUID,
    payload: ProjectUpsert,
    session: AsyncSession = Depends(get_session),
):
    if payload.id != project_id:
        raise HTTPException(400, "Path id and body id must match")

    existing = await session.get(Project, project_id)

    if existing:
        # Last-write-wins by timestamp. `<` (not `<=`) so retries of the
        # same push from the sync queue are idempotent rather than no-ops
        # that look like failures.
        if payload.updated_at < existing.updated_at:
            return existing
        existing.name = payload.name
        existing.blocks = payload.blocks
        existing.connections = payload.connections
        existing.updated_at = payload.updated_at
        existing.client_id = payload.client_id
    else:
        existing = Project(
            id=payload.id,
            client_id=payload.client_id,
            name=payload.name,
            blocks=payload.blocks,
            connections=payload.connections,
            updated_at=payload.updated_at,
        )
        session.add(existing)

    await session.commit()
    await session.refresh(existing)
    return existing


@app.delete("/api/projects/{project_id}", status_code=204)
async def delete_project(project_id: uuid.UUID, session: AsyncSession = Depends(get_session)):
    project = await session.get(Project, project_id)
    if project:
        await session.delete(project)
        await session.commit()
    return None
