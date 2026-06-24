# ── ORCH LLM Client — Ollama proxy ────────────────────────────

import json
import logging
from typing import Any

import httpx

log = logging.getLogger("agent-core.llm")


class LLMClient:
    """Async client for Ollama LLM API."""

    def __init__(self, host: str = "http://ollama:11434", model: str = "qwen2.5-coder:7b"):
        self.base_url = host.rstrip("/")
        self.model = model
        self._client = httpx.AsyncClient(timeout=120.0)

    async def ping(self) -> bool:
        """Check if Ollama is reachable."""
        try:
            r = await self._client.get(f"{self.base_url}/api/tags", timeout=5.0)
            return r.status_code == 200
        except Exception:
            return False

    async def chat(self, messages: list[dict], stream: bool = False) -> str:
        """Send a chat completion request to Ollama."""
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": stream,
            "options": {
                "temperature": 0.7,
                "top_p": 0.9,
                "num_predict": 4096,
            },
        }

        try:
            r = await self._client.post(
                f"{self.base_url}/api/chat",
                json=payload,
            )
            r.raise_for_status()

            if stream:
                # Streaming mode — concatenate response chunks
                full_text = ""
                for line in r.iter_lines():
                    if line:
                        try:
                            chunk = json.loads(line)
                            if "message" in chunk and "content" in chunk["message"]:
                                full_text += chunk["message"]["content"]
                            if chunk.get("done"):
                                break
                        except json.JSONDecodeError:
                            continue
                return full_text.strip()
            else:
                data = r.json()
                return data.get("message", {}).get("content", "").strip()

        except httpx.HTTPStatusError as e:
            log.error(f"LLM HTTP error: {e.response.status_code} {e.response.text[:200]}")
            raise
        except Exception as e:
            log.error(f"LLM error: {e}")
            raise

    async def generate(self, prompt: str, system: str | None = None) -> str:
        """Simple text generation (no chat history)."""
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        return await self.chat(messages)
