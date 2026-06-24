"""
ORCH Brain — Self-Hosted Dual-Engine Intelligence Layer
=========================================================
Fast path: qwen2.5:1.5b (Ollama) for sub-200ms real-time voice
Deep path: qwen2.5-coder:7b (Ollama) for code generation & complex tasks
Optional: Gemini 1.5 Flash if API key is set
"""

import os
import json
import httpx

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_MODEL = "gemini-2.0-flash-lite"
OLLAMA_HOST = "http://ollama:11434"
FAST_MODEL = "qwen2.5:0.5b"       # fastest local voice brain (~576ms)
DEEP_MODEL = "qwen2.5-coder:7b"   # heavy code generation
EMBED_MODEL = "nomic-embed-text"   # text embeddings

# ── System prompt for the fast voice brain ─────────────────────────

VOICE_SYSTEM_PROMPT = """You are ORCH's real-time voice AI. Respond with JSON.

Rules:
- 1 short sentence response
- For commands, set "tool_call": {"name": X, "arguments": {...}}
- Available tools: spawn_agent, remove_agent, kill_all, arrange_agents, focus_agent, deep_code, memory_search
- For code/complex tasks, use deep_code tool
- If no action needed, set tool_call: null

Respond: {"text": "your reply", "tool_call": null or {...}}"""


# ── Ollama Helper ───────────────────────────────────────────────────

async def ollama_generate(model: str, prompt: str, system: str = "",
                          temperature: float = 0.2, max_tokens: int = 256,
                          format_json: bool = True, timeout: float = 10.0) -> str:
    """Call any Ollama model's generate endpoint."""
    body = {
        "model": model,
        "prompt": prompt,
        "system": system or "",
        "stream": False,
        "options": {"temperature": temperature, "max_tokens": max_tokens},
    }
    if format_json:
        body["format"] = "json"
    body["keep_alive"] = "5m"  # keep model loaded between requests

    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(f"{OLLAMA_HOST}/api/generate", json=body)
        resp.raise_for_status()
        return resp.json().get("response", "")


# ── Fast Local Brain (qwen2.5:1.5b) ───────────────────────────────

async def fast_local_brain(transcript: str, context: str = "") -> dict:
    """
    Fast local voice brain via qwen2.5:1.5b.
    Targets sub-200ms for short voice commands.
    Always available, no API keys needed.
    """
    prompt = f"User said: \"{transcript}\""
    if context:
        prompt += f"\nContext: {context}"
    prompt += "\n\nRespond in JSON format."

    try:
        raw = await ollama_generate(
            model=FAST_MODEL,
            prompt=prompt,
            system=VOICE_SYSTEM_PROMPT,
            temperature=0.2,
            max_tokens=256,
            format_json=True,
            timeout=5.0,
        )
        # Parse JSON from the response
        # Clean up markdown code blocks if present
        raw = raw.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1]
            raw = raw.rsplit("\n", 1)[0]
            if raw.endswith("```"):
                raw = raw[:-3]

        parsed = json.loads(raw)
        return {
            "text": parsed.get("text", "Got it."),
            "tool_call": parsed.get("tool_call"),
        }
    except Exception:
        return {"text": "Got it.", "tool_call": None}


# ── Gemini 1.5 Flash (Optional Cloud Path) ────────────────────────

def gemini_available() -> bool:
    return bool(GEMINI_API_KEY) and GEMINI_API_KEY != "placeholder"

async def gemini_fast(transcript: str, context: str = "") -> dict:
    """
    Cloud voice brain via Gemini 1.5 Flash.
    Only used if a valid API key is configured.
    Falls back to fast_local_brain on any error.
    """
    if not gemini_available():
        return await fast_local_brain(transcript, context)

    try:
        prompt = f"User said: \"{transcript}\""
        if context:
            prompt += f"\nContext: {context}"

        url = f"https://generativelanguage.googleapis.com/v1/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"
        body = {
            "contents": [{"parts": [{"text": prompt}]}],
            "system_instruction": {"parts": [{"text": VOICE_SYSTEM_PROMPT}]},
            "generation_config": {
                "temperature": 0.2,
                "max_output_tokens": 256,
                "response_mime_type": "application/json",
            },
        }

        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.post(url, json=body)
            resp.raise_for_status()
            data = resp.json()

        text = data["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(text.strip().removeprefix("```json").removesuffix("```").strip())
        return {
            "text": parsed.get("text", "Got it."),
            "tool_call": parsed.get("tool_call"),
        }
    except Exception:
        return await fast_local_brain(transcript, context)


# ── Deep Brain (qwen2.5-coder:7b) ─────────────────────────────────

async def qwen_deep(prompt: str, system: str = "") -> str:
    """Heavy code generation via qwen2.5-coder:7b."""
    try:
        return await ollama_generate(
            model=DEEP_MODEL,
            prompt=prompt,
            system=system or "You are ORCH's deep code engine. Generate high-quality, working code.",
            temperature=0.1,
            max_tokens=4096,
            format_json=False,
            timeout=120.0,
        )
    except Exception as e:
        return f"Deep task failed: {e}"


# ── Fallback Voice (qwen2.5-coder:7b) ─────────────────────────────

async def fallback_voice(transcript: str, context: str = "") -> dict:
    """
    Last-resort voice brain using the 7B model.
    Only used if both Gemini AND fast local brain fail.
    """
    prompt = f"User said: \"{transcript}\""
    if context:
        prompt += f"\nContext: {context}"
    prompt += "\n\nRespond in JSON format."

    try:
        raw = await ollama_generate(
            model=DEEP_MODEL,
            prompt=prompt,
            system=VOICE_SYSTEM_PROMPT,
            temperature=0.2,
            max_tokens=256,
            format_json=True,
            timeout=30.0,
        )
        raw = raw.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1]
            raw = raw.rsplit("\n", 1)[0]
            if raw.endswith("```"):
                raw = raw[:-3]
        parsed = json.loads(raw)
        return {
            "text": parsed.get("text", "Got it."),
            "tool_call": parsed.get("tool_call"),
        }
    except Exception:
        return {"text": "Got it.", "tool_call": None}


# ── Unified Interface ──────────────────────────────────────────────

async def process_voice(transcript: str, context: str = "") -> dict:
    """
    Route voice through the best available brain:
    1. qwen2.5:0.5b local fast brain (always available, ~600ms)
    2. Gemini 1.5 Flash if API key available AND responsive
    3. qwen2.5-coder:7b as last-resort fallback
    """
    # Tier 1: Fast local (always works, sub-1s)
    result = await fast_local_brain(transcript, context)

    # Tier 2: If local response was empty or Gemini might do better, try Gemini
    # (Gemini tries in parallel so it doesn't block if slow)
    if gemini_available() and (not result.get("text") or result.get("text") == "Got it."):
        gemini_result = await gemini_fast(transcript, context)
        if gemini_result.get("text") != "Got it." or gemini_result.get("tool_call"):
            return gemini_result

    return result


async def execute_tool_call(tool_call: dict) -> str:
    """Execute a tool call from the voice brain."""
    if not tool_call:
        return ""

    name = tool_call.get("name", "")
    args = tool_call.get("arguments", {})

    if name == "deep_code":
        task = args.get("task", "")
        result = await qwen_deep(task)
        return f"Deep code result: {result[:200]}..."
    elif name == "memory_search":
        query = args.get("query", "")
        try:
            from memory import search_memories, MemorySearch
            results = await search_memories(MemorySearch(query=query, limit=3))
            if results:
                return f"Found: {'; '.join(r.content for r in results)}"
        except Exception:
            pass
        return "No relevant memories found."
    else:
        return f"Tool call {name} forwarded to frontend"
