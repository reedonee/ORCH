"""
ORCH Sandbox — Isolated code execution via Docker
====================================================
Spins up throwaway containers for safe code execution.
Uses the mounted Docker socket (/var/run/docker.sock).
Supports Python, Node.js, and shell scripts.
"""

import json
import uuid
import asyncio
from datetime import datetime, timezone
from pydantic import BaseModel
from typing import Optional

DOCKER_SOCKET = "/var/run/docker.sock"

# Available sandbox images and their run commands
SANDBOX_IMAGES = {
    "python": {
        "image": "python:3.11-slim",
        "cmd": ["python3", "-c"],
    },
    "node": {
        "image": "node:20-alpine",
        "cmd": ["node", "-e"],
    },
    "shell": {
        "image": "alpine:latest",
        "cmd": ["sh", "-c"],
    },
}

# ── Models ──────────────────────────────────────────────────────────

class SandboxExec(BaseModel):
    language: str = "python"  # python, node, shell
    code: str
    timeout: int = 30  # max execution seconds
    memory_mb: int = 256
    env: dict[str, str] = {}

class SandboxResult(BaseModel):
    id: str
    language: str
    stdout: str
    stderr: str
    exit_code: int
    duration_ms: int
    error: Optional[str] = None

# ── Docker HTTP Client ──────────────────────────────────────────────

async def docker_request(method: str, path: str, body: dict | None = None, stream: bool = False):
    """Make a request to the Docker Engine API via Unix socket."""
    import httpx
    transport = httpx.AsyncHTTPTransport(uds=DOCKER_SOCKET)
    url = f"http://localhost{path}"
    async with httpx.AsyncClient(transport=transport, timeout=60.0) as client:
        if method == "POST":
            resp = await client.post(url, json=body)
        elif method == "GET":
            resp = await client.get(url)
        elif method == "DELETE":
            resp = await client.delete(url)
        else:
            raise ValueError(f"Unsupported method: {method}")
        return resp

async def pull_image(image: str) -> bool:
    """Pull a Docker image if not already present."""
    # Check if image exists
    resp = await docker_request("GET", f"/images/{image}/json")
    if resp.status_code == 200:
        return True  # already exists

    # Pull it
    resp = await docker_request("POST", f"/images/create?fromImage={image}")
    return resp.status_code < 400

async def run_container(
    image: str,
    cmd: list[str],
    env: dict[str, str] | None = None,
    memory_mb: int = 256,
    timeout: int = 30,
) -> tuple[str, str, int]:
    """
    Run a container, wait for it, return (stdout, stderr, exit_code).
    """
    sandbox_id = uuid.uuid4().hex[:12]

    # Container config
    container_config = {
        "Image": image,
        "Cmd": cmd,
        "Env": [f"{k}={v}" for k, v in (env or {}).items()],
        "HostConfig": {
            "Memory": memory_mb * 1024 * 1024,
            "NetworkMode": "none",  # no network access for safety
            "ReadonlyRootfs": True,
            "Tmpfs": {"/tmp": "size=64m"},
        },
        "AttachStdout": True,
        "AttachStderr": True,
    }

    # Create container
    create_resp = await docker_request("POST", "/containers/create", body={
        **container_config,
        "name": f"orch-sandbox-{sandbox_id}",
    })

    if create_resp.status_code >= 400:
        error_detail = create_resp.text[:200]
        raise RuntimeError(f"Container create failed: {error_detail}")

    container_id = create_resp.json().get("Id", "")
    if not container_id:
        raise RuntimeError("No container ID returned")

    # Start container
    await docker_request("POST", f"/containers/{container_id}/start")

    # Wait for it to finish (with timeout)
    try:
        wait_resp = await docker_request(
            "POST",
            f"/containers/{container_id}/wait?condition=not-running",
        )
    except Exception:
        # Timeout — force kill
        await docker_request("POST", f"/containers/{container_id}/kill")
        raise TimeoutError(f"Sandbox execution timed out after {timeout}s")

    # Get logs
    stdout_resp = await docker_request(
        "GET",
        f"/containers/{container_id}/logs?stdout=true&stderr=false",
    )
    stderr_resp = await docker_request(
        "GET",
        f"/containers/{container_id}/logs?stdout=false&stderr=true",
    )

    # Parse Docker log format (8-byte header per frame)
    def parse_docker_logs(raw: bytes) -> str:
        result = []
        i = 0
        while i < len(raw):
            if i + 8 > len(raw):
                break
            frame_len = int.from_bytes(raw[i+4:i+8], byteorder="big")
            i += 8
            frame = raw[i:i+frame_len]
            result.append(frame.decode("utf-8", errors="replace"))
            i += frame_len
        return "".join(result)

    stdout = parse_docker_logs(stdout_resp.content)
    stderr = parse_docker_logs(stderr_resp.content)

    # Get exit code from inspect
    inspect_resp = await docker_request("GET", f"/containers/{container_id}/json")
    exit_code = 1
    if inspect_resp.status_code == 200:
        state = inspect_resp.json().get("State", {})
        exit_code = state.get("ExitCode", 1)

    # Clean up — remove the container
    await docker_request("DELETE", f"/containers/{container_id}")

    return stdout, stderr, exit_code


# ── Execute API ────────────────────────────────────────────────────

async def execute_sandbox(req: SandboxExec) -> SandboxResult:
    """Execute code in an isolated sandbox container."""
    import time

    lang_config = SANDBOX_IMAGES.get(req.language)
    if not lang_config:
        return SandboxResult(
            id="", language=req.language,
            stdout="", stderr="", exit_code=1,
            duration_ms=0,
            error=f"Unsupported language: {req.language}. Supported: {', '.join(SANDBOX_IMAGES.keys())}",
        )

    exec_id = uuid.uuid4().hex[:12]

    try:
        # Ensure image is pulled
        pulled = await pull_image(lang_config["image"])
        if not pulled:
            return SandboxResult(
                id=exec_id, language=req.language,
                stdout="", stderr="", exit_code=1,
                duration_ms=0,
                error=f"Failed to pull image {lang_config['image']}",
            )

        start = time.monotonic()

        if req.language == "shell":
            cmd = lang_config["cmd"] + [req.code]
        else:
            cmd = lang_config["cmd"] + [req.code]

        stdout, stderr, exit_code = await run_container(
            image=lang_config["image"],
            cmd=cmd,
            env=req.env,
            memory_mb=req.memory_mb,
            timeout=req.timeout,
        )

        duration = int((time.monotonic() - start) * 1000)

        return SandboxResult(
            id=exec_id,
            language=req.language,
            stdout=stdout,
            stderr=stderr,
            exit_code=exit_code,
            duration_ms=duration,
        )

    except TimeoutError as e:
        return SandboxResult(
            id=exec_id, language=req.language,
            stdout="", stderr="", exit_code=124,
            duration_ms=req.timeout * 1000,
            error=str(e),
        )
    except Exception as e:
        return SandboxResult(
            id=exec_id, language=req.language,
            stdout="", stderr="", exit_code=1,
            duration_ms=0,
            error=str(e),
        )
