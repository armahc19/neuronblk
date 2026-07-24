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
