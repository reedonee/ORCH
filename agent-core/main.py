"""
ORCH Agent Core — VPS Brain
FastAPI service that connects the Electron frontend to Ollama LLM,
Qdrant vector DB, and provides the voice intelligence layer.
"""

import json
import base64
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi import WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from typing import List

# ── WebSocket Connection Manager ────────────────────────────────────

class ConnectionManager:
    """Manages WebSocket connections for real-time state broadcasts."""
    def __init__(self):
        self.active: List[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)

    async def broadcast(self, event: str, data: dict):
        """Push an event to all connected clients."""
        message = {"event": event, **data}
        dead = []
        for ws in self.active:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)

manager = ConnectionManager()

# ── Import memory module ────────────────────────────────────────────
from memory import (
    MemoryEntry, MemorySearch, MemoryResult,
    store_memory, search_memories, get_agent_memories, delete_agent_memories,
    client as qdrant_client, ensure_collection, COLLECTION,
)
from agents import (
    AgentCreate, AgentUpdate, AgentResponse,
    create_agent, list_agents, get_agent, update_agent, delete_agent, count_agents,
)
from tasks import (
    TaskCreate, TaskResponse,
    create_task, list_tasks, get_task,
    claim_task, start_task, complete_task, fail_task, cancel_task, task_stats,
)
from sandbox import (
    SandboxExec, SandboxResult, execute_sandbox,
)
from brain import process_voice as brain_process_voice, execute_tool_call, gemini_available
from mcp_server import handle_list_tools, handle_call_tool
from tts import synthesize_sync, synthesize
from sessions import create_session, kill_session, write_input, read_buffer, list_sessions, session_exists

# ── STT Correction Model ────────────────────────────────────────────

class SttCorrectRequest(BaseModel):
    text: str
    context: str = ""

class TtsRequest(BaseModel):
    text: str
    voice: str = "af_bella"
    speed: float = 1.0

OLLAMA_HOST = "http://ollama:11434"
LLM_MODEL = "qwen2.5-coder:7b"

app = FastAPI(title="ORCH Agent Core")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Models ──────────────────────────────────────────────────────────

class VoiceRequest(BaseModel):
    transcript: str
    context: str | None = ""

class VoiceResponse(BaseModel):
    response: str
    action: dict | None = None

class ChatRequest(BaseModel):
    messages: list[dict]
    stream: bool = False

class GenerateRequest(BaseModel):
    prompt: str
    system: str = ""

# ── System Prompt for Voice Brain ───────────────────────────────────

SYSTEM_PROMPT = """You are ORCH's voice intelligence layer, running inside a multi-agent desktop app.

Your job: listen to the user's voice command, understand what they want,
and respond appropriately.

Available actions you can trigger:
- spawn_agent: {"type": "spawn_agent", "provider": "provider_id", "name": "optional name"}
- remove_agent: {"type": "remove_agent", "name": "agent_name"}
- arrange_agents: {"type": "arrange_agents", "layout": "grid|horizontal|vertical"}
- kill_all: {"type": "kill_all"}
- focus_agent: {"type": "focus_agent", "name": "agent_name"}

Rules:
1. Always respond conversationally in character as ORCH's voice.
2. If the user asks about something on the canvas, describe what you see.
3. If the user gives a command, set the "action" field.
4. If no action is needed, omit the action field.
5. Keep responses short and natural (1-2 sentences).
6. The user may refer to agents by name, role, or number.

Respond ONLY with valid JSON: {"response": "your reply", "action": null or {...}}"""

# ── Ollama Helper ───────────────────────────────────────────────────

async def ollama_generate(prompt: str, system: str = "", format_json: bool = True) -> str:
    """Call Ollama's generate endpoint."""
    body = {
        "model": LLM_MODEL,
        "prompt": prompt,
        "system": system or SYSTEM_PROMPT,
        "stream": False,
        "options": {"temperature": 0.3, "max_tokens": 512},
    }
    if format_json:
        body["format"] = "json"

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(f"{OLLAMA_HOST}/api/generate", json=body)
        resp.raise_for_status()
        data = resp.json()
        return data.get("response", "")

async def ollama_chat(messages: list[dict], system: str = "") -> str:
    """Call Ollama's chat endpoint."""
    body = {
        "model": LLM_MODEL,
        "messages": messages,
        "stream": False,
        "options": {"temperature": 0.3},
    }
    if system:
        body["system"] = system

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(f"{OLLAMA_HOST}/api/chat", json=body)
        resp.raise_for_status()
        data = resp.json()
        return data.get("message", {}).get("content", "")

# ── Endpoints ───────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    """Health check — also confirms Ollama is reachable."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{OLLAMA_HOST}/api/tags")
            ollama_ok = r.status_code == 200
    except Exception:
        ollama_ok = False

    return {
        "status": "ok",
        "service": "agent-core",
        "ollama": ollama_ok,
        "model": LLM_MODEL,
        "gemini": gemini_available(),
    }


@app.websocket("/voice-ws")
async def voice_ws(websocket: WebSocket):
    """
    Real-time voice + state broadcast channel.
    Uses connection manager for multi-client broadcasts.
    """
    await manager.connect(websocket)
    await websocket.send_json({"event": "connected", "brain": "gemini" if gemini_available() else "qwen", "mcp": True})

    try:
        while True:
            data = await websocket.receive_json()
            event = data.get("event", "")

            if event == "transcript":
                text = data.get("text", "")
                context = data.get("context", "")
                result = await brain_process_voice(text, context)

                response = {"event": "response", "text": result.get("text", "")}
                if result.get("tool_call"):
                    response["tool_call"] = result["tool_call"]
                    tool_result = await execute_tool_call(result["tool_call"])
                    if tool_result:
                        response["tool_result"] = tool_result
                        await manager.broadcast("tool_executed", {
                            "tool": result["tool_call"].get("name", ""),
                            "result": tool_result[:200],
                        })

                await websocket.send_json(response)

            elif event == "ping":
                await websocket.send_json({"event": "pong"})

    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        try:
            await websocket.send_json({"event": "error", "data": str(e)})
        except Exception:
            pass
        manager.disconnect(websocket)


@app.post("/api/voice/process", response_model=VoiceResponse)
async def process_voice(req: VoiceRequest):
    """
    Dual-engine voice intelligence endpoint.
    Fast path: Gemini 1.5 Flash (<200ms) if API key available.
    Deep path: Qwen (Ollama) as fallback.
    """
    if not req.transcript.strip():
        return VoiceResponse(response="I didn't catch that.", action=None)

    try:
        # Route through the fastest available brain
        result = await brain_process_voice(req.transcript, req.context or "")

        # Execute any tool call from Gemini
        action = None
        if result.get("tool_call"):
            tc = result["tool_call"]
            # Map Gemini tool calls to the VoiceAction format
            action = {
                "type": tc.get("name", ""),
                **tc.get("arguments", {}),
            }
            # Execute deep tasks (code gen, memory search) server-side
            tool_result = await execute_tool_call(tc)
            if tool_result:
                result["text"] += f" ({tool_result[:100]})"

        return VoiceResponse(
            response=result.get("text", "Got it."),
            action=action,
        )
    except Exception as e:
        return VoiceResponse(
            response=f"I heard: {req.transcript}",
            action=None,
        )


@app.post("/api/chat")
async def chat(req: ChatRequest):
    """Generic chat endpoint for the agent terminal — passes through to Ollama."""
    try:
        content = await ollama_chat(req.messages)
        return {"role": "assistant", "content": content}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/generate")
async def generate(req: GenerateRequest):
    """Generic generate endpoint."""
    try:
        text = await ollama_generate(req.prompt, req.system)
        return {"response": text}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


# ── Deploy & Management Endpoints ─────────────────────────────────

import subprocess
import os

DEPLOY_SECRET = os.environ.get("ORCH_DEPLOY_SECRET", "")


@app.on_event("startup")
async def startup():
    """Initialize services on startup."""
    ensure_collection()
    print("[Startup] Memory collection ready")


# ── Memory Endpoints ────────────────────────────────────────────────


@app.post("/api/memory")
async def api_store_memory(entry: MemoryEntry):
    """Store a memory for an agent."""
    try:
        mem_id = await store_memory(entry)
        return {"id": mem_id, "success": True}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/memory/search", response_model=list[MemoryResult])
async def api_search_memories(search: MemorySearch):
    """Search memories by semantic similarity."""
    try:
        results = await search_memories(search)
        return results
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/memory/agent/{agent_id}")
async def api_get_agent_memories(agent_id: str, limit: int = 20):
    """Get recent memories for an agent."""
    try:
        memories = await get_agent_memories(agent_id, limit)
        return {"agent_id": agent_id, "memories": memories}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/memory/agent/{agent_id}")
async def api_delete_agent_memories(agent_id: str):
    """Delete all memories for an agent."""
    try:
        count = delete_agent_memories(agent_id)
        return {"success": True, "deleted": count}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/memory/stats")
async def api_memory_stats():
    """Get memory collection statistics."""
    try:
        info = qdrant_client.get_collection(COLLECTION)
        count = qdrant_client.count(COLLECTION)
        return {
            "collection": COLLECTION,
            "vectors": count.count,
            "status": info.status,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Agent Lifecycle Endpoints ────────────────────────────────────────

@app.get("/api/agents/stats")
async def api_agent_stats():
    return count_agents()


@app.get("/api/agents", response_model=list[AgentResponse])
async def api_list_agents():
    return list_agents()

@app.post("/api/agents", response_model=AgentResponse)
async def api_create_agent(data: AgentCreate):
    return create_agent(data)

@app.get("/api/agents/{agent_id}", response_model=AgentResponse)
async def api_get_agent(agent_id: str):
    agent = get_agent(agent_id)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent

@app.patch("/api/agents/{agent_id}", response_model=AgentResponse)
async def api_update_agent(agent_id: str, data: AgentUpdate):
    agent = update_agent(agent_id, data)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent

@app.delete("/api/agents/{agent_id}")
async def api_delete_agent(agent_id: str):
    if not delete_agent(agent_id):
        raise HTTPException(status_code=404, detail="Agent not found")
    # Also kill tmux session if it exists
    kill_session(agent_id)
    return {"success": True}


# ── Terminal Endpoints (VPS tmux sessions) ───────────────────────────


@app.post("/api/agents/{agent_id}/terminal")
async def api_agent_terminal_create(agent_id: str, req: dict = {}):
    """Create a persistent tmux session for an agent. Optionally start a pre-installed tool.
    Body (optional): {"tool": "claude"} to auto-start a CLI.
    """
    tool = req.get("tool", "") if req else ""
    ok = create_session(agent_id, tool=tool)
    return {"agent_id": agent_id, "created": ok, "tool": tool if tool else None}


@app.get("/api/agents/{agent_id}/terminal")
async def api_agent_terminal(agent_id: str):
    """Get a snapshot of the agent's terminal buffer (last 200 lines)."""
    exists = session_exists(agent_id)
    if not exists:
        return {"agent_id": agent_id, "lines": [], "total_lines": 0, "session": "stopped"}
    
    content = read_buffer(agent_id, 200)
    lines = content.split("\n") if content else []
    return {
        "agent_id": agent_id,
        "lines": lines,
        "content": content,
        "total_lines": len(lines),
        "session": "running",
    }


@app.post("/api/agents/{agent_id}/terminal/input")
async def api_agent_input(agent_id: str, body: dict):
    """Send keystrokes to the agent's terminal. Body: {"text": "..."}"""
    text = body.get("text", "")
    if not text:
        return {"sent": False, "error": "empty text"}
    
    print(f"[API] terminal input for {agent_id}: {repr(text[:80])}", flush=True)
    # Ensure session exists
    exists = session_exists(agent_id)
    if not exists:
        create_session(agent_id)
    
    ok = write_input(agent_id, text)
    return {"sent": ok, "text": text}


@app.get("/api/sessions")
async def api_list_vps_sessions():
    """List all active VPS terminal sessions."""
    return {"sessions": list_sessions()}


# ── Task Delegation Endpoints ───────────────────────────────────────


@app.post("/api/tasks", response_model=TaskResponse)
async def api_create_task(data: TaskCreate):
    return create_task(data)

@app.get("/api/tasks/stats")
async def api_task_stats():
    return task_stats()


@app.get("/api/tasks", response_model=list[TaskResponse])
async def api_list_tasks(status: str | None = None, assigned_to: str | None = None):
    return list_tasks(status=status, assigned_to=assigned_to)

@app.get("/api/tasks/{task_id}", response_model=TaskResponse)
async def api_get_task(task_id: str):
    task = get_task(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task

@app.post("/api/tasks/{task_id}/claim", response_model=TaskResponse)
async def api_claim_task(task_id: str, agent_id: str):
    task = claim_task(task_id, agent_id)
    if not task:
        raise HTTPException(status_code=409, detail="Task cannot be claimed")
    return task

@app.post("/api/tasks/{task_id}/start", response_model=TaskResponse)
async def api_start_task(task_id: str):
    task = start_task(task_id)
    if not task:
        raise HTTPException(status_code=409, detail="Task cannot be started")
    return task

@app.post("/api/tasks/{task_id}/complete", response_model=TaskResponse)
async def api_complete_task(task_id: str, result: str = ""):
    task = complete_task(task_id, result)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task

@app.post("/api/tasks/{task_id}/fail", response_model=TaskResponse)
async def api_fail_task(task_id: str, error: str = ""):
    task = fail_task(task_id, error)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task

@app.post("/api/tasks/{task_id}/cancel", response_model=TaskResponse)
async def api_cancel_task(task_id: str):
    task = cancel_task(task_id)
    if not task:
        raise HTTPException(status_code=409, detail="Task cannot be cancelled")
    return task


# ── Sandbox Endpoints ───────────────────────────────────────────────

@app.post("/api/sandbox/exec", response_model=SandboxResult)
async def api_sandbox_exec(req: SandboxExec):
    """Execute code in an isolated Docker container."""
    result = await execute_sandbox(req)
    return result


@app.get("/api/sandbox/languages")
async def api_sandbox_languages():
    """List available sandbox languages."""
    from sandbox import SANDBOX_IMAGES
    return {
        lang: config["image"]
        for lang, config in SANDBOX_IMAGES.items()
    }


# ── MCP Tool Endpoints ──────────────────────────────────────────────


@app.post("/api/tts")
async def api_tts(req: TtsRequest):
    """Synthesize speech from text using Kokoro TTS on VPS. Returns base64 PCM."""
    try:
        pcm_bytes = synthesize_sync(req.text, voice=req.voice, speed=req.speed)
        b64 = base64.b64encode(pcm_bytes).decode()
        return {
            "audio": b64,
            "sample_rate": 24000,
            "format": "f32",
            "duration_ms": int(len(pcm_bytes) / 4 / 24000 * 1000),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"TTS error: {e}")


@app.post("/api/stt/correct")
async def api_stt_correct(req: SttCorrectRequest):
    """Correct STT transcription errors using qwen2.5:0.5b."""
    if not req.text.strip():
        return {"corrected": "", "original": ""}

    prompt = f"""Fix transcription errors in this voice command. Return ONLY the corrected text, nothing else.

Common STT misrecognitions:
- "a cloud" → "Claude"
- "codec" / "codecs" → "Codex"
- "herms" / "hermez" → "Hermes"
- "clod" / "clawed" → "Claude"
- "a cloud called" → "Claude Code"
- "a cloud cold" → "Claude Code"
- "open hermes" → "open Hermes"
- "spawn a hermes" → "spawn a Hermes"
- Agent names: "zuma" "astra" "chase" "max" "sky" "zed" "eve" "blade"
- Numbers may be misheard

Example fixes:
- "open a cloud code agent" → "open Claude Code agent"
- "spawn a herms developer" → "spawn a Hermes developer"
- "close all agents" → "close all agents" (already correct)
- "kill all the agents" → "kill all agents"

Original: "{req.text}"
Corrected:"""

    try:
        from brain import ollama_generate as og
        corrected = await og("qwen2.5:0.5b", prompt, system="You fix voice transcription errors. Output only the corrected text.", temperature=0.1, max_tokens=128, format_json=False, timeout=10.0)
        corrected = corrected.strip().strip('"').strip("'")
        if not corrected:
            corrected = req.text
    except Exception:
        corrected = req.text

    return {"corrected": corrected, "original": req.text}


@app.get("/api/mcp/tools")
async def mcp_list_tools():
    """List all available MCP tools with their JSON schemas."""
    tools = await handle_list_tools()
    return {
        "tools": [
            {
                "name": t.name,
                "description": t.description,
                "inputSchema": t.inputSchema,
            }
            for t in tools
        ]
    }


@app.post("/api/mcp/call")
async def mcp_call_tool(request: Request):
    """Call an MCP tool by name with arguments. Body: {"name":"...", "arguments":{...}}"""
    body = await request.json()
    name = body.get("name", "")
    args = body.get("arguments", {})
    result = await handle_call_tool(name, args)
    return {
        "tool": name,
        "result": result[0].text if result else "No result",
    }


@app.post("/api/deploy")
async def deploy(secret: str = ""):
    """Trigger deployment. Returns current git status — run deploy.sh on host to actually rebuild."""
    if not DEPLOY_SECRET or secret != DEPLOY_SECRET:
        raise HTTPException(status_code=403, detail="Invalid deploy secret")
    try:
        result = subprocess.run(
            ["git", "log", "--oneline", "-3"],
            capture_output=True, text=True, timeout=10, cwd="/app"
        )
        status = subprocess.run(
            ["git", "status", "--short"],
            capture_output=True, text=True, timeout=10, cwd="/app"
        )
        return {
            "success": True,
            "message": "Run 'cd ~/orch && ./deploy.sh' on the VPS host to rebuild.",
            "git_log": result.stdout.strip().split("\n"),
            "git_status": status.stdout.strip() or "clean",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/models")
async def list_models():
    """List available Ollama models."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{OLLAMA_HOST}/api/tags")
            return resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))
