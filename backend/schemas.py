import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict


class ProjectUpsert(BaseModel):
    id: uuid.UUID
    client_id: uuid.UUID
    name: str
    blocks: list[dict[str, Any]]
    connections: list[dict[str, Any]]
    updated_at: datetime


class ProjectOut(BaseModel):
    id: uuid.UUID
    client_id: uuid.UUID
    name: str
    blocks: list[dict[str, Any]]
    connections: list[dict[str, Any]]
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)
