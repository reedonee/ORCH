"""
ORCH File Sync — FastAPI Routes
================================
WebSocket endpoint for real-time bidirectional file sync and
HTTP endpoint for initial archive upload.

Routes:
    POST     /api/filesync/init            Upload initial project archive
    WebSocket /ws/filesync/{workspace_id}   Live file sync channel

Protocol (WebSocket):
    Electron → VPS:
        {"type": "fs_init_complete"}            — ready to start syncing
        {"type": "fs_change", "path": ..., ...} — single file change
        {"type": "fs_batch", "changes": [...]}  — batched file changes
        {"type": "fs_ping"}                     — keepalive

    VPS → Electron:
        {"type": "fs_change", "path": ..., ...} — single file change
        {"type": "fs_batch", "changes": [...]}  — batched file changes
        {"type": "fs_ack", "path": ..., "ok": true}
        {"type": "fs_pong"}                     — keepalive response

Echo muting:
    When VPS writes a file because Electron sent it, the path is added to an
    EchoMutex (2.5s mute). If the local watchdog fires for that path within
    the mute window, the event is suppressed — it is our own echo.

    Same logic applies on the Electron side: when it receives a VPS change
    and writes to disk, it mutes the path in chokidar.
"""

import asyncio
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, UploadFile, File, Form, HTTPException
from fastapi.responses import JSONResponse

from .sync_manager import (
    sync_manager,
    SyncSession,
    WORKSPACE_BASE,
    extract_archive_safely,
    sanitize_workspace_id,
    file_to_wire,
)
from .watcher import SyncFileWatcher

router = APIRouter()

# ── In-memory file size cap ──────────────────────────────────────────
MAX_ARCHIVE_SIZE = 200 * 1024 * 1024  # 200MB


# ═══════════════════════════════════════════════════════════════════════
#  POST /api/filesync/init
# ═══════════════════════════════════════════════════════════════════════

@router.post("/api/filesync/init")
async def init_file_sync(
    workspace_id: str = Form(...),
    archive: UploadFile = File(...),
):
    """
    Initialise a file sync session by uploading the project as a tar.gz.

    Steps:
        1. Validate workspace_id (alphanumeric + dash + underscore only)
        2. Read and validate archive size
        3. Extract archive safely to /workspace/{workspace_id}/
        4. Create a SyncSession (watchdog starts after fs_init_complete)
        5. Return extraction manifest
    """
    # ── Validate workspace_id ────────────────────────────────────
    try:
        ws_id = sanitize_workspace_id(workspace_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    # ── Read archive ─────────────────────────────────────────────
    try:
        archive_bytes = await archive.read()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to read archive: {e}")

    if len(archive_bytes) == 0:
        raise HTTPException(status_code=400, detail="Archive is empty")
    if len(archive_bytes) > MAX_ARCHIVE_SIZE:
        raise HTTPException(
            status_code=413,
            detail=f"Archive too large ({len(archive_bytes)} bytes, max {MAX_ARCHIVE_SIZE})",
        )

    # ── Determine workspace path ─────────────────────────────────
    workspace_path = WORKSPACE_BASE / ws_id

    # ── Extract safely ───────────────────────────────────────────
    try:
        manifest = extract_archive_safely(archive_bytes, workspace_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Archive extraction failed: {e}")

    file_count = len(manifest)
    total_size = sum(m["size"] for m in manifest)
    print(f"[filesync] Extracted {file_count} files ({total_size} bytes) to {workspace_path}")

    # ── Create SyncSession ───────────────────────────────────────
    loop = asyncio.get_running_loop()
    session = await sync_manager.create_session(ws_id, workspace_path, loop)

    # ── Build full manifest with hashes (optional — for reconnection diff) ──
    # For v1 we skip content hashing; the initial tar upload is the baseline.

    return {
        "status": "ok",
        "workspace_id": ws_id,
        "workspace_path": str(workspace_path),
        "file_count": file_count,
        "total_size": total_size,
        "manifest": manifest,
        "session_created": True,
    }


# ═══════════════════════════════════════════════════════════════════════
#  WebSocket /ws/filesync/{workspace_id}
# ═══════════════════════════════════════════════════════════════════════

BATCH_WINDOW = 0.5  # seconds — collect changes before flushing to Electron


@router.websocket("/ws/filesync/{workspace_id}")
async def file_sync_ws(websocket: WebSocket, workspace_id: str):
    """
    Bidirectional file sync WebSocket.

    Two concurrent tasks:
        receiver — reads incoming JSON messages from Electron
        sender   — drains the outgoing_queue and sends batched changes to Electron

    On disconnect, the session is cleaned up and watchdog stopped.
    """
    # ── Validate and find session ────────────────────────────────
    try:
        ws_id = sanitize_workspace_id(workspace_id)
    except ValueError:
        await websocket.close(code=4000, reason="Invalid workspace_id")
        return

    session = await sync_manager.get_session(ws_id)
    if not session:
        await websocket.close(code=4004, reason="Session not found — call /api/filesync/init first")
        return

    # ── Accept the WebSocket ─────────────────────────────────────
    await websocket.accept()
    session.websocket = websocket
    print(f"[filesync] WebSocket connected: {ws_id}")

    # ── Tasks ────────────────────────────────────────────────────

    async def receiver():
        """Read incoming messages from Electron."""
        try:
            while True:
                data = await websocket.receive_json()
                await session.handle_incoming(data)
        except WebSocketDisconnect:
            pass
        except Exception as e:
            print(f"[filesync] Receiver error: {e}")

    async def sender():
        """
        Drain outgoing_queue and send batched changes to Electron.

        Batches within a 500ms window, deduplicates by path (latest wins),
        then sends either a single fs_change or an fs_batch.
        """
        batch: list[dict] = []
        last_flush = time.monotonic()

        while session._running:
            try:
                # Wait for at least one event
                event = await asyncio.wait_for(
                    session.outgoing_queue.get(),
                    timeout=BATCH_WINDOW,
                )
                batch.append(event)
            except asyncio.TimeoutError:
                pass

            # Drain any additional events that arrived during our wait
            while not session.outgoing_queue.empty():
                try:
                    batch.append(session.outgoing_queue.get_nowait())
                except asyncio.QueueEmpty:
                    break

            if not batch:
                continue

            # Deduplicate by path (latest content wins)
            deduped: dict[str, dict] = {}
            for e in batch:
                deduped[e["path"]] = e
            unique_changes = list(deduped.values())

            # Send
            try:
                if len(unique_changes) == 1:
                    await websocket.send_json({
                        "type": "fs_change",
                        "workspaceId": ws_id,
                        **unique_changes[0],
                    })
                else:
                    await websocket.send_json({
                        "type": "fs_batch",
                        "workspaceId": ws_id,
                        "changes": unique_changes,
                    })
            except WebSocketDisconnect:
                break
            except Exception as e:
                print(f"[filesync] Sender error: {e}")
                break

            batch = []

    # ── Run both tasks concurrently ──────────────────────────────

    receiver_task = asyncio.create_task(receiver())
    sender_task = asyncio.create_task(sender())

    try:
        done, pending = await asyncio.wait(
            [receiver_task, sender_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()
        # Surface any exception from completed tasks
        for task in done:
            exc = task.exception()
            if exc and not isinstance(exc, (WebSocketDisconnect, asyncio.CancelledError)):
                raise exc
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[filesync] WebSocket error: {e}")
    finally:
        receiver_task.cancel()
        sender_task.cancel()
        session.websocket = None
        print(f"[filesync] WebSocket disconnected: {ws_id}")


# ═══════════════════════════════════════════════════════════════════════
#  GET /api/filesync/status — list active sync sessions
# ═══════════════════════════════════════════════════════════════════════

@router.get("/api/filesync/status")
async def file_sync_status():
    """List all active file sync sessions with their state."""
    sessions = await sync_manager.list_active()
    return {
        "active_sessions": len(sessions),
        "sessions": sessions,
    }


# ═══════════════════════════════════════════════════════════════════════
#  POST /api/filesync/{workspace_id}/stop — stop a sync session
# ═══════════════════════════════════════════════════════════════════════

@router.post("/api/filesync/{workspace_id}/stop")
async def stop_file_sync(workspace_id: str):
    """Stop and remove a file sync session."""
    try:
        ws_id = sanitize_workspace_id(workspace_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    await sync_manager.remove_session(ws_id)
    return {"status": "ok", "workspace_id": ws_id, "removed": True}
