"""
ORCH Agents — Lifecycle management API
========================================
Tracks agents registered with the orchestrator.
Agent execution (PTY) happens on the Electron client — the VPS
stores metadata and status as a registry.
"""

from datetime import datetime, timezone
from pydantic import BaseModel
from typing import Optional

# ── In-memory store (simple for now; can move to Qdrant or DB later) ──
agents_db: dict[str, dict] = {}

# ── Models ──────────────────────────────────────────────────────────

class AgentCreate(BaseModel):
    name: str
    role: str = "assistant"
    provider: str = "hermes"
    color: str = "#F4A261"

class AgentUpdate(BaseModel):
    status: Optional[str] = None
    role: Optional[str] = None
    name: Optional[str] = None

class AgentResponse(BaseModel):
    id: str
    name: str
    role: str
    status: str
    provider: str
    color: str
    created_at: str
    updated_at: str
    metadata: dict = {}

# ── CRUD ────────────────────────────────────────────────────────────

def create_agent(data: AgentCreate) -> AgentResponse:
    import uuid
    now = datetime.now(timezone.utc).isoformat()
    agent_id = str(uuid.uuid4())
    entry = {
        "id": agent_id,
        "name": data.name,
        "role": data.role,
        "status": "idle",
        "provider": data.provider,
        "color": data.color,
        "created_at": now,
        "updated_at": now,
        "metadata": {},
    }
    agents_db[agent_id] = entry
    return AgentResponse(**entry)

def list_agents() -> list[AgentResponse]:
    return [AgentResponse(**a) for a in agents_db.values()]

def get_agent(agent_id: str) -> AgentResponse | None:
    entry = agents_db.get(agent_id)
    return AgentResponse(**entry) if entry else None

def update_agent(agent_id: str, data: AgentUpdate) -> AgentResponse | None:
    entry = agents_db.get(agent_id)
    if not entry:
        return None
    if data.status is not None:
        entry["status"] = data.status
    if data.role is not None:
        entry["role"] = data.role
    if data.name is not None:
        entry["name"] = data.name
    entry["updated_at"] = datetime.now(timezone.utc).isoformat()
    return AgentResponse(**entry)

def delete_agent(agent_id: str) -> bool:
    return agents_db.pop(agent_id, None) is not None

def count_agents() -> dict:
    total = len(agents_db)
    by_status: dict[str, int] = {}
    for a in agents_db.values():
        s = a["status"]
        by_status[s] = by_status.get(s, 0) + 1
    return {"total": total, "by_status": by_status}
