"""
ORCH MCP Server — Model Context Protocol for Cloud Agents
==========================================================
Exposes filesystem, sandbox, and memory tools via MCP over SSE.
Co-located with Ollama and Qdrant on the VPS for near-zero latency.
"""

import os
import json
import shutil
import subprocess
import uuid
from pathlib import Path
from datetime import datetime, timezone
from typing import Any

import httpx
from mcp.server import Server, NotificationOptions
from mcp.server.models import InitializationOptions
from mcp.types import Tool, TextContent, ImageContent, EmbeddedResource
import mcp.server.stdio
from agents import list_agents, get_agent

# ── Configuration ──────────────────────────────────────────────────

WORKSPACE = os.environ.get("MCP_WORKSPACE", "/workspace")
QDRANT_HOST = os.environ.get("QDRANT_HOST", "qdrant")
QDRANT_PORT = int(os.environ.get("QDRANT_PORT", "6333"))
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://ollama:11434")
DOCKER_SOCKET = "/var/run/docker.sock"

server = Server("orch-mcp")

# Ensure workspace exists
os.makedirs(WORKSPACE, exist_ok=True)
os.makedirs(f"{WORKSPACE}/scratch", exist_ok=True)

# ── Qdrant helpers ──────────────────────────────────────────────────

def get_qdrant_client():
    from qdrant_client import QdrantClient
    return QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT)

MESSAGES_COLLECTION = "agent_messages"

def ensure_messages_collection():
    from qdrant_client.models import VectorParams, Distance
    qdrant = get_qdrant_client()
    cols = [c.name for c in qdrant.get_collections().collections]
    if MESSAGES_COLLECTION not in cols:
        qdrant.create_collection(
            collection_name=MESSAGES_COLLECTION,
            vectors_config=VectorParams(size=4, distance=Distance.COSINE),
        )
        qdrant.create_payload_index(MESSAGES_COLLECTION, field_name="to_agent_id", field_schema="keyword")
        qdrant.create_payload_index(MESSAGES_COLLECTION, field_name="from_agent_id", field_schema="keyword")

async def embed_text(text: str) -> list[float]:
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(f"{OLLAMA_HOST}/api/embeddings", json={
            "model": "nomic-embed-text",
            "prompt": text,
        })
        resp.raise_for_status()
        return resp.json().get("embedding", [])

# ── Tool: read_file ─────────────────────────────────────────────────

async def tool_read_file(path: str) -> str:
    """Read the contents of a file within the workspace."""
    full_path = Path(WORKSPACE) / path.lstrip("/")
    if not full_path.resolve().is_relative_to(Path(WORKSPACE).resolve()):
        return f"Error: Path traversal denied: {path}"
    if not full_path.exists():
        return f"Error: File not found: {path}"
    try:
        content = full_path.read_text(encoding="utf-8", errors="replace")
        return content
    except Exception as e:
        return f"Error reading file: {e}"

# ── Tool: write_file ────────────────────────────────────────────────

async def tool_write_file(path: str, content: str) -> str:
    """Create or overwrite a file within the workspace."""
    full_path = Path(WORKSPACE) / path.lstrip("/")
    if not full_path.resolve().is_relative_to(Path(WORKSPACE).resolve()):
        return f"Error: Path traversal denied: {path}"
    try:
        full_path.parent.mkdir(parents=True, exist_ok=True)
        full_path.write_text(content, encoding="utf-8")
        return f"Written {len(content)} bytes to {path}"
    except Exception as e:
        return f"Error writing file: {e}"

# ── Tool: search_files ──────────────────────────────────────────────

async def tool_search_files(pattern: str, path: str = "") -> str:
    """Search for files matching a glob pattern within the workspace."""
    search_path = Path(WORKSPACE) / path.lstrip("/") if path else Path(WORKSPACE)
    if not search_path.resolve().is_relative_to(Path(WORKSPACE).resolve()):
        return "Error: Path traversal denied"
    try:
        matches = list(search_path.rglob(pattern))
        if not matches:
            return f"No files matching '{pattern}'"
        result = "\n".join(str(m.relative_to(Path(WORKSPACE))) for m in matches[:100])
        if len(matches) > 100:
            result += f"\n... and {len(matches) - 100} more"
        return result
    except Exception as e:
        return f"Error searching files: {e}"

# ── Tool: sandbox_exec ──────────────────────────────────────────────

SANDBOX_IMAGES = {
    "python": {"image": "python:3.11-slim", "cmd": ["python3", "-c"]},
    "node": {"image": "node:20-alpine", "cmd": ["node", "-e"]},
    "shell": {"image": "alpine:latest", "cmd": ["sh", "-c"]},
}

async def tool_sandbox_exec(language: str, code: str, timeout: int = 30) -> str:
    """Execute code in an isolated Docker sandbox container."""
    lang = SANDBOX_IMAGES.get(language)
    if not lang:
        return f"Unsupported language: {language}. Use: {', '.join(SANDBOX_IMAGES.keys())}"

    sandbox_id = uuid.uuid4().hex[:12]
    cmd = lang["cmd"] + [code]

    container_config = {
        "Image": lang["image"],
        "Cmd": cmd,
        "HostConfig": {
            "Memory": 256 * 1024 * 1024,
            "NetworkMode": "none",
            "ReadonlyRootfs": True,
            "Tmpfs": {"/tmp": "size=64m"},
        },
        "AttachStdout": True,
        "AttachStderr": True,
    }

    try:
        import docker
        client = docker.from_env()
        container = client.containers.run(
            image=lang["image"],
            command=cmd,
            network_disabled=True,
            read_only=True,
            mem_limit="256m",
            tmpfs={"/tmp": "size=64m"},
            detach=True,
            name=f"mcp-sandbox-{sandbox_id}",
        )
        result = container.wait(timeout=timeout)
        stdout = container.logs(stdout=True, stderr=False).decode("utf-8", errors="replace")
        stderr = container.logs(stdout=False, stderr=True).decode("utf-8", errors="replace")
        container.remove()
        output = stdout or stderr or "(no output)"
        return f"Exit code: {result['StatusCode']}\n{output}"
    except Exception as e:
        return f"Sandbox error: {e}"

# ── Tool: memory_search ─────────────────────────────────────────────

async def tool_memory_search(query: str, agent_id: str = "") -> str:
    """Search the Qdrant vector database for semantically similar memories."""
    try:
        embedding = await embed_text(query)
        if not embedding:
            return "Error: Failed to generate embedding"

        from qdrant_client.models import Filter, FieldCondition, MatchValue
        qdrant = get_qdrant_client()

        query_filter = None
        if agent_id:
            query_filter = Filter(
                must=[FieldCondition(key="agent_id", match=MatchValue(value=agent_id))]
            )

        results = qdrant.query_points(
            collection_name="agent_memories",
            query=embedding,
            limit=5,
            query_filter=query_filter,
            with_payload=True,
        )

        if not results.points:
            return "No matching memories found."

        output = []
        for r in results.points:
            payload = r.payload or {}
            output.append(
                f"[{payload.get('timestamp', '?')[:19]}] "
                f"({payload.get('role', '?')}) "
                f"{payload.get('content', '')[:200]}"
            )
        return "\n".join(output)
    except Exception as e:
        return f"Memory search error: {e}"

# ── Tool: memory_store ──────────────────────────────────────────────

async def tool_memory_store(agent_id: str, content: str, role: str = "observation") -> str:
    """Store a memory in the Qdrant vector database."""
    try:
        embedding = await embed_text(content)
        if not embedding:
            return "Error: Failed to generate embedding"

        from qdrant_client.models import PointStruct
        qdrant = get_qdrant_client()
        mem_id = str(uuid.uuid4())

        point = PointStruct(
            id=mem_id,
            vector=embedding,
            payload={
                "agent_id": agent_id,
                "content": content,
                "role": role,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        )
        qdrant.upsert(collection_name="agent_memories", points=[point])
        return f"Memory stored (id: {mem_id})"
    except Exception as e:
        return f"Memory store error: {e}"

# ── Tool: agent_think ───────────────────────────────────────────────

async def tool_agent_think(prompt: str, system: str = "") -> str:
    """Ask the deep Qwen 7B model to reason about a complex task."""
    body = {
        "model": "qwen2.5-coder:7b",
        "prompt": prompt,
        "system": system or "You are ORCH's deep reasoning engine. Think step by step.",
        "stream": False,
        "options": {"temperature": 0.1, "max_tokens": 4096},
    }
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(f"{OLLAMA_HOST}/api/generate", json=body)
            resp.raise_for_status()
            return resp.json().get("response", "")
    except Exception as e:
        return f"Think error: {e}"

# ── Tool: list_agents ──────────────────────────────────────────────

async def tool_list_agents() -> str:
    try:
        agents = list_agents()
        if not agents:
            return "No agents registered."
        lines = []
        for a in agents:
            lines.append(f"{a.id[:8]:>8s} | {a.name:20s} | {a.status:10s} | {a.provider:15s} | role={a.role}")
        header = "ID        | NAME                 | STATUS     | PROVIDER        | ROLE"
        sep = "-" * 80
        return header + "\n" + sep + "\n" + "\n".join(lines)
    except Exception as e:
        return f"list_agents error: {e}"

# ── Tool: send_message ─────────────────────────────────────────────

async def tool_send_message(from_agent: str, to_agent: str, content: str) -> str:
    try:
        import uuid
        from datetime import datetime, timezone
        from qdrant_client.models import PointStruct
        ensure_messages_collection()
        qdrant = get_qdrant_client()
        msg_id = str(uuid.uuid4())
        point = PointStruct(
            id=msg_id,
            vector=[0.0, 0.0, 0.0, 0.0],
            payload={
                "from_agent_id": from_agent,
                "to_agent_id": to_agent,
                "content": content,
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "read": False,
            },
        )
        qdrant.upsert(collection_name=MESSAGES_COLLECTION, points=[point])
        return f"Message sent to {to_agent} (id: {msg_id[:8]})"
    except Exception as e:
        return f"send_message error: {e}"

# ── Tool: read_messages ────────────────────────────────────────────

async def tool_read_messages(agent_id: str, mark_read: bool = True) -> str:
    try:
        from qdrant_client.models import Filter, FieldCondition, MatchValue
        ensure_messages_collection()
        qdrant = get_qdrant_client()
        results = qdrant.scroll(
            collection_name=MESSAGES_COLLECTION,
            scroll_filter=Filter(
                must=[FieldCondition(key="to_agent_id", match=MatchValue(value=agent_id))]
            ),
            limit=50,
            with_payload=True,
        )
        points = results[0]
        if not points:
            return "No messages."
        points.sort(key=lambda p: p.payload.get("timestamp", ""), reverse=True)
        lines = []
        for p in points:
            pl = p.payload or {}
            ts = pl.get("timestamp", "?")[:19]
            fr = pl.get("from_agent_id", "?")[:8]
            read = "+" if pl.get("read") else "o"
            txt = pl.get("content", "")[:150]
            lines.append(f"[{ts}] {read} from:{fr} {txt}")
        if mark_read:
            unread_ids = [p.id for p in points if not p.payload.get("read")]
            if unread_ids:
                qdrant.set_payload(
                    collection_name=MESSAGES_COLLECTION,
                    payload={"read": True},
                    points=unread_ids,
                )
        result = "\n".join(lines)
        unread = sum(1 for p in points if not p.payload.get("read"))
        return f"{len(points)} message(s), {unread} unread:\n\n{result}"
    except Exception as e:
        return f"read_messages error: {e}"

# ── Tool Registration ───────────────────────────────────────────────

@server.list_tools()
async def handle_list_tools() -> list[Tool]:
    return [
        Tool(
            name="read_file",
            description="Read a file from the workspace. Path is relative to workspace root.",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path to the file"},
                },
                "required": ["path"],
            },
        ),
        Tool(
            name="write_file",
            description="Create or overwrite a file in the workspace.",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Relative path to the file"},
                    "content": {"type": "string", "description": "File content"},
                },
                "required": ["path", "content"],
            },
        ),
        Tool(
            name="search_files",
            description="Search for files matching a glob pattern in the workspace.",
            inputSchema={
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Glob pattern (e.g. '*.py', '**/*.ts')"},
                    "path": {"type": "string", "description": "Optional subdirectory to search within"},
                },
                "required": ["pattern"],
            },
        ),
        Tool(
            name="sandbox_exec",
            description="Execute code in an isolated Docker sandbox. Languages: python, node, shell.",
            inputSchema={
                "type": "object",
                "properties": {
                    "language": {"type": "string", "description": "Language: python, node, or shell"},
                    "code": {"type": "string", "description": "Code to execute"},
                    "timeout": {"type": "integer", "description": "Max execution time in seconds", "default": 30},
                },
                "required": ["language", "code"],
            },
        ),
        Tool(
            name="memory_search",
            description="Search the vector database for semantically similar memories.",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "agent_id": {"type": "string", "description": "Optional: filter by agent"},
                },
                "required": ["query"],
            },
        ),
        Tool(
            name="memory_store",
            description="Store a memory in the vector database.",
            inputSchema={
                "type": "object",
                "properties": {
                    "agent_id": {"type": "string", "description": "Agent identifier"},
                    "content": {"type": "string", "description": "Memory content"},
                    "role": {"type": "string", "description": "Role: observation, user, assistant, system"},
                },
                "required": ["agent_id", "content"],
            },
        ),
        Tool(
            name="list_agents",
            description="List all registered agents with their status. Call this to discover peer agents.",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": [],
            },
        ),
        Tool(
            name="send_message",
            description="Send a message to another agent. They can read it with read_messages.",
            inputSchema={
                "type": "object",
                "properties": {
                    "from_agent": {"type": "string", "description": "Your agent ID (sender)"},
                    "to_agent": {"type": "string", "description": "Target agent ID"},
                    "content": {"type": "string", "description": "Message text"},
                },
                "required": ["from_agent", "to_agent", "content"],
            },
        ),
        Tool(
            name="read_messages",
            description="Read messages sent to your agent. Optionally mark them as read.",
            inputSchema={
                "type": "object",
                "properties": {
                    "agent_id": {"type": "string", "description": "Your agent ID"},
                    "mark_read": {"type": "boolean", "description": "Auto-mark as read", "default": True},
                },
                "required": ["agent_id"],
            },
        ),
        Tool(
            name="agent_think",
            description="Ask the deep Qwen 7B model to reason about a complex task.",
            inputSchema={
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "The reasoning task"},
                    "system": {"type": "string", "description": "Optional system prompt"},
                },
                "required": ["prompt"],
            },
        ),
    ]

@server.call_tool()
async def handle_call_tool(name: str, arguments: dict[str, Any]) -> list[TextContent]:
    result = ""
    try:
        if name == "read_file":
            result = await tool_read_file(arguments["path"])
        elif name == "write_file":
            result = await tool_write_file(arguments["path"], arguments["content"])
        elif name == "search_files":
            result = await tool_search_files(arguments["pattern"], arguments.get("path", ""))
        elif name == "sandbox_exec":
            result = await tool_sandbox_exec(
                arguments["language"], arguments["code"],
                arguments.get("timeout", 30),
            )
        elif name == "memory_search":
            result = await tool_memory_search(arguments["query"], arguments.get("agent_id", ""))
        elif name == "memory_store":
            result = await tool_memory_store(
                arguments["agent_id"], arguments["content"],
                arguments.get("role", "observation"),
            )
        elif name == "list_agents":
            result = await tool_list_agents()
        elif name == "send_message":
            result = await tool_send_message(
                arguments["from_agent"], arguments["to_agent"], arguments["content"],
            )
        elif name == "read_messages":
            result = await tool_read_messages(arguments["agent_id"], arguments.get("mark_read", True))
        elif name == "agent_think":
            result = await tool_agent_think(arguments["prompt"], arguments.get("system", ""))
        else:
            result = f"Unknown tool: {name}"
    except Exception as e:
        result = f"Tool error: {e}"

    return [TextContent(type="text", text=result)]

# ── Health endpoint for Docker ──────────────────────────────────────

async def health_check():
    """Simple health endpoint — returns OK if MCP server is running."""
    return {"status": "ok", "service": "mcp-server", "tools": len((await handle_list_tools()))}

# ── Entrypoint ──────────────────────────────────────────────────────

async def main():
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name="orch-mcp",
                server_version="0.1.0",
                capabilities=server.get_capabilities(
                    notification_options=NotificationOptions(),
                    experimental_capabilities={},
                ),
            ),
        )

if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
