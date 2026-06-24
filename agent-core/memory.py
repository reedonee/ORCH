"""
ORCH Memory — Qdrant-backed vector memory for agents
=====================================================
Stores and retrieves agent memories via text embeddings (Ollama).
"""

import uuid
import httpx
from datetime import datetime, timezone
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance, VectorParams, PointStruct, Filter, FieldCondition,
    MatchValue, Range as QdrantRange,
)
from pydantic import BaseModel

QDRANT_HOST = "qdrant"
QDRANT_PORT = 6333
OLLAMA_HOST = "http://ollama:11434"
EMBED_MODEL = "nomic-embed-text"
COLLECTION = "agent_memories"
EMBED_DIM = 768  # nomic-embed-text dimension

client = QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT)

# ── Models ──────────────────────────────────────────────────────────

class MemoryEntry(BaseModel):
    agent_id: str
    content: str
    role: str = "observation"  # user, assistant, system, observation
    metadata: dict = {}

class MemorySearch(BaseModel):
    agent_id: str | None = None
    query: str
    limit: int = 5

class MemoryResult(BaseModel):
    id: str
    agent_id: str
    content: str
    role: str
    score: float
    timestamp: str
    metadata: dict

# ── Collection Setup ────────────────────────────────────────────────

def ensure_collection():
    """Create the agent_memories collection if it doesn't exist."""
    collections = client.get_collections().collections
    existing = [c.name for c in collections]
    if COLLECTION not in existing:
        client.create_collection(
            collection_name=COLLECTION,
            vectors_config=VectorParams(size=EMBED_DIM, distance=Distance.COSINE),
        )
        # Create payload index for agent_id for fast filtering
        client.create_payload_index(
            collection_name=COLLECTION,
            field_name="agent_id",
            field_schema="keyword",
        )
        print(f"[Memory] Created collection '{COLLECTION}' with {EMBED_DIM}d vectors")
    else:
        print(f"[Memory] Collection '{COLLECTION}' exists")

# ── Embedding ───────────────────────────────────────────────────────

async def embed_text(text: str) -> list[float]:
    """Generate embedding via Ollama."""
    async with httpx.AsyncClient(timeout=30.0) as http:
        resp = await http.post(f"{OLLAMA_HOST}/api/embeddings", json={
            "model": EMBED_MODEL,
            "prompt": text,
        })
        resp.raise_for_status()
        data = resp.json()
        return data.get("embedding", [])

# ── CRUD ────────────────────────────────────────────────────────────

async def store_memory(entry: MemoryEntry) -> str:
    """Store a memory entry with its embedding."""
    mem_id = str(uuid.uuid4())
    embedding = await embed_text(entry.content)

    if not embedding:
        raise ValueError("Failed to generate embedding")

    point = PointStruct(
        id=mem_id,
        vector=embedding,
        payload={
            "agent_id": entry.agent_id,
            "content": entry.content,
            "role": entry.role,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            **entry.metadata,
        },
    )
    client.upsert(collection_name=COLLECTION, points=[point])
    return mem_id


async def search_memories(search: MemorySearch) -> list[MemoryResult]:
    """Search memories by semantic similarity, optionally filtered by agent."""
    embedding = await embed_text(search.query)
    if not embedding:
        return []

    query_filter = None
    if search.agent_id:
        query_filter = Filter(
            must=[FieldCondition(key="agent_id", match=MatchValue(value=search.agent_id))]
        )

    results = client.query_points(
        collection_name=COLLECTION,
        query=embedding,
        limit=search.limit,
        query_filter=query_filter,
        with_payload=True,
    )

    return [
        MemoryResult(
            id=res.id,
            agent_id=res.payload.get("agent_id", ""),
            content=res.payload.get("content", ""),
            role=res.payload.get("role", "observation"),
            score=res.score,
            timestamp=res.payload.get("timestamp", ""),
            metadata={k: v for k, v in res.payload.items()
                      if k not in ("agent_id", "content", "role", "timestamp")},
        )
        for res in results.points
    ]


async def get_agent_memories(agent_id: str, limit: int = 20) -> list[dict]:
    """Get the most recent memories for a specific agent."""
    results = client.scroll(
        collection_name=COLLECTION,
        scroll_filter=Filter(
            must=[FieldCondition(key="agent_id", match=MatchValue(value=agent_id))]
        ),
        limit=limit,
        with_payload=True,
    )
    # Sort by timestamp descending
    points = sorted(results[0], key=lambda p: p.payload.get("timestamp", ""), reverse=True)
    return [
        {
            "id": p.id,
            "content": p.payload.get("content", ""),
            "role": p.payload.get("role", ""),
            "timestamp": p.payload.get("timestamp", ""),
        }
        for p in points
    ]


def delete_agent_memories(agent_id: str) -> int:
    """Delete all memories for an agent. Returns count of deleted points."""
    result = client.delete(
        collection_name=COLLECTION,
        points_selector=Filter(
            must=[FieldCondition(key="agent_id", match=MatchValue(value=agent_id))]
        ),
    )
    # Qdrant returns DeleteResult with status
    return 1 if result.status == "completed" else 0


# ── Init ────────────────────────────────────────────────────────────

ensure_collection()
