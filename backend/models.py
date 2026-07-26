import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from database import Base


class Project(Base):
    """
    One row per flowchart project. `blocks` and `connections` are stored as
    raw JSONB rather than normalized into their own tables — the whole
    canvas state is small, always read/written as a unit, and never
    queried by field, so normalizing would only add join complexity with
    no real benefit.
    """

    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    client_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False, default="Untitled")
    blocks: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    connections: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )


class FunctionDef(Base):
    """
    One row per saved, reusable function. Same shape/rationale as Project
    for `blocks`/`connections` (the function's body — its own mini
    flowchart), plus `params` (declared parameter names + optional
    defaults) as its own JSONB column since it's small, structured
    metadata read/written as a unit alongside the body.

    Private-only for now (no visibility/public column) — every function
    is scoped to client_id exactly like projects. Public sharing, if it
    ever happens, is a separate feature to layer on top of this later.
    """

    __tablename__ = "functions"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    client_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False, default="untitled_function")
    params: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    blocks: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    connections: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )