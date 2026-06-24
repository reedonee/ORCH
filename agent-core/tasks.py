"""
ORCH Tasks — Delegation & task tracking API
=============================================
Manages tasks that can be created, claimed by agents, and completed.
Used for agent-to-agent delegation and user-to-agent tasking.
"""

from datetime import datetime, timezone
from pydantic import BaseModel
from typing import Optional

tasks_db: dict[str, dict] = {}

# ── Models ──────────────────────────────────────────────────────────

class TaskCreate(BaseModel):
    title: str
    description: str = ""
    assigned_to: Optional[str] = None  # agent_id
    created_by: Optional[str] = None   # agent_id or "user"
    priority: int = 0
    delegation_depth: int = 0

class TaskResponse(BaseModel):
    id: str
    title: str
    description: str
    status: str  # pending, claimed, in_progress, completed, failed, cancelled
    assigned_to: Optional[str] = None
    created_by: Optional[str] = None
    priority: int = 0
    delegation_depth: int = 0
    result: Optional[str] = None
    created_at: str
    claimed_at: Optional[str] = None
    completed_at: Optional[str] = None

# ── CRUD ────────────────────────────────────────────────────────────

def create_task(data: TaskCreate) -> TaskResponse:
    import uuid
    now = datetime.now(timezone.utc).isoformat()
    task_id = str(uuid.uuid4())
    entry = {
        "id": task_id,
        "title": data.title,
        "description": data.description,
        "status": "pending",
        "assigned_to": data.assigned_to,
        "created_by": data.created_by,
        "priority": data.priority,
        "delegation_depth": data.delegation_depth,
        "result": None,
        "created_at": now,
        "claimed_at": None,
        "completed_at": None,
    }
    tasks_db[task_id] = entry
    return TaskResponse(**entry)

def list_tasks(status: str | None = None, assigned_to: str | None = None) -> list[TaskResponse]:
    results = []
    for t in tasks_db.values():
        if status and t["status"] != status:
            continue
        if assigned_to and t["assigned_to"] != assigned_to:
            continue
        results.append(TaskResponse(**t))
    return sorted(results, key=lambda t: (-t.priority, t.created_at or ""))

def get_task(task_id: str) -> TaskResponse | None:
    entry = tasks_db.get(task_id)
    return TaskResponse(**entry) if entry else None

def claim_task(task_id: str, agent_id: str) -> TaskResponse | None:
    entry = tasks_db.get(task_id)
    if not entry or entry["status"] != "pending":
        return None
    entry["status"] = "claimed"
    entry["assigned_to"] = agent_id
    entry["claimed_at"] = datetime.now(timezone.utc).isoformat()
    return TaskResponse(**entry)

def start_task(task_id: str) -> TaskResponse | None:
    entry = tasks_db.get(task_id)
    if not entry or entry["status"] not in ("claimed", "pending"):
        return None
    entry["status"] = "in_progress"
    return TaskResponse(**entry)

def complete_task(task_id: str, result: str = "") -> TaskResponse | None:
    entry = tasks_db.get(task_id)
    if not entry:
        return None
    entry["status"] = "completed"
    entry["result"] = result
    entry["completed_at"] = datetime.now(timezone.utc).isoformat()
    return TaskResponse(**entry)

def fail_task(task_id: str, error: str = "") -> TaskResponse | None:
    entry = tasks_db.get(task_id)
    if not entry:
        return None
    entry["status"] = "failed"
    entry["result"] = error
    entry["completed_at"] = datetime.now(timezone.utc).isoformat()
    return TaskResponse(**entry)

def cancel_task(task_id: str) -> TaskResponse | None:
    entry = tasks_db.get(task_id)
    if not entry or entry["status"] in ("completed", "failed", "cancelled"):
        return None
    entry["status"] = "cancelled"
    return TaskResponse(**entry)

def task_stats() -> dict:
    total = len(tasks_db)
    by_status: dict[str, int] = {}
    for t in tasks_db.values():
        s = t["status"]
        by_status[s] = by_status.get(s, 0) + 1
    return {"total": total, "by_status": by_status}
