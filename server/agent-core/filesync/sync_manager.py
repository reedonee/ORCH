"""
ORCH File Sync — Session Manager
=================================
Core state management for bidirectional file sync.

EchoMutex
  Prevents sync feedback loops. When side A writes a file because side B sent
  a change, the path is temporarily muted. If the local filesystem watcher
  fires for that path within the mute window, the event is suppressed — it
  was our own echo.

SyncSession
  One per active workspace. Owns the echo mutex, the outgoing event queue,
  the watchdog watcher, and the active WebSocket reference.

SyncManager
  Registry of all active SyncSessions, keyed by workspace_id.
"""

import time
import threading
import asyncio
import base64
import re
import os
from pathlib import Path
from typing import Optional

# ── Constants ────────────────────────────────────────────────────────

WORKSPACE_BASE = Path("/workspace")

# Files and directories to never sync (matching across all path parts)
IGNORE_DIRS: set[str] = {
    "node_modules", ".git", ".svn", ".hg",
    "__pycache__", ".venv", "venv", ".tox",
    "dist", "build", ".next", ".turbo", ".output", "out", "target",
    "coverage", ".nyc_output", ".cache", ".parcel-cache",
    ".idea", ".vscode",
    ".gitlab-ci.yml",  # not a dir but cheap check
}
IGNORE_EXTS: set[str] = {
    ".pyc", ".pyo", ".so", ".dll", ".dylib",
    ".exe", ".bin", ".dmg", ".pkg", ".msi",
    ".DS_Store", "Thumbs.db",
    ".jpg", ".jpeg", ".png", ".gif", ".ico", ".svg",
    ".mp4", ".mp3", ".wav", ".ogg", ".flac",
    ".zip", ".tar", ".gz", ".tgz", ".rar", ".7z",
    ".ttf", ".otf", ".woff", ".woff2", ".eot",
}
IGNORE_NAMES: set[str] = {
    ".DS_Store", "Thumbs.db", ".gitignore",
    ".env", ".env.local", ".env.*.local",
}

MAX_TEXT_FILE_BYTES = 512 * 1024  # 512KB — larger files treated as binary


def should_ignore(path: Path) -> bool:
    """Check if a path should be excluded from sync."""
    for part in path.parts:
        if part in IGNORE_DIRS:
            return True
    if path.suffix.lower() in IGNORE_EXTS:
        return True
    if path.name in IGNORE_NAMES:
        return True
    return False


def sanitize_workspace_id(ws_id: str) -> str:
    """Prevent path traversal in workspace IDs — only alphanumeric + dash + underscore."""
    if not re.match(r'^[a-zA-Z0-9_-]{1,64}$', ws_id):
        raise ValueError(f"Invalid workspace_id: {ws_id!r}")
    return ws_id


# ── EchoMutex ────────────────────────────────────────────────────────

class EchoMutex:
    """
    Thread-safe per-path mute to prevent sync feedback loops.

    Usage:
        When we WRITE a file because the remote sent it:
            mutex.mute("src/app.ts")

        When our local watcher FIRES for "src/app.ts":
            if mutex.is_muted("src/app.ts"):
                return  # skip — it's our own echo
    """

    def __init__(self, mute_ms: int = 2500):
        self._muted: dict[str, float] = {}  # path → expiry timestamp
        self._lock = threading.Lock()
        self.mute_ms = mute_ms

    def mute(self, path: str):
        """Mute a path for the configured duration after we write it."""
        expires = time.monotonic() + (self.mute_ms / 1000)
        with self._lock:
            self._muted[path.replace("\\", "/")] = expires

    def is_muted(self, path: str) -> bool:
        """Check if a path is currently muted (was just echoed from remote)."""
        path = path.replace("\\", "/")
        now = time.monotonic()
        with self._lock:
            expiry = self._muted.get(path, 0)
            if now < expiry:
                return True
            # Expired — clean up
            self._muted.pop(path, None)
            return False

    def clear(self):
        """Unmute all paths (called on disconnect)."""
        with self._lock:
            self._muted.clear()


# ── Safe Tar Extraction ──────────────────────────────────────────────

def extract_archive_safely(
    archive_bytes: bytes,
    target_dir: Path,
) -> list[dict]:
    """
    Extract a tar.gz archive while preventing path traversal attacks.

    Returns a manifest of extracted files::
        [{"path": "src/main.py", "size": 2048, "mtime": 1712345678}, ...]
    """
    import tarfile
    import io

    target_dir = target_dir.resolve()
    target_dir.mkdir(parents=True, exist_ok=True)
    manifest: list[dict] = []

    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as tar:
        for member in tar.getmembers():
            # 1. Reject absolute paths
            if os.path.isabs(member.name):
                print(f"[filesync] Skipping absolute path: {member.name}")
                continue

            # 2. Resolve relative to target dir and verify it's inside
            try:
                member_path = (target_dir / member.name).resolve()
                member_path.relative_to(target_dir)
            except (ValueError, RuntimeError):
                print(f"[filesync] Blocked path traversal: {member.name}")
                continue

            # 3. Skip symlinks and hardlinks for safety
            if member.issym() or member.islnk() or not member.isfile():
                continue

            # 4. Skip ignored paths
            if should_ignore(member_path):
                continue

            # 5. Extract
            member_path.parent.mkdir(parents=True, exist_ok=True)
            tar.extract(member, path=target_dir)

            manifest.append({
                "path": member.name,
                "size": member.size,
                "mtime": member.mtime,
            })

    return manifest


# ── Read file to wire format ────────────────────────────────────────

def file_to_wire(path: Path, rel_path: str) -> Optional[dict]:
    """
    Read a file and return a wire-format payload.
    Returns None if the file should be skipped (binary, too large, ignored).
    """
    if should_ignore(path):
        return None

    try:
        stat = path.stat()
        if stat.st_size == 0:
            return {
                "path": rel_path,
                "content": "",
                "mtime": int(stat.st_mtime * 1000),
                "size": 0,
            }

        if stat.st_size > MAX_TEXT_FILE_BYTES:
            # Read as binary and base64
            raw = path.read_bytes()
            return {
                "path": rel_path,
                "content": "base64:" + base64.b64encode(raw).decode("ascii"),
                "mtime": int(stat.st_mtime * 1000),
                "size": stat.st_size,
            }

        # Try text
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            # Binary file — base64
            raw = path.read_bytes()
            content = "base64:" + base64.b64encode(raw).decode("ascii")

        return {
            "path": rel_path,
            "content": content,
            "mtime": int(stat.st_mtime * 1000),
            "size": stat.st_size,
        }
    except (OSError, PermissionError):
        return None


# ── Write wire format to disk ───────────────────────────────────────

def wire_to_file(abs_path: Path, content: Optional[str], mtime: int) -> bool:
    """Write a wire-format payload to disk. Returns True on success."""
    try:
        abs_path.parent.mkdir(parents=True, exist_ok=True)

        if content is None:
            # Delete
            if abs_path.exists():
                abs_path.unlink()
            return True

        if content.startswith("base64:"):
            raw = base64.b64decode(content[7:])
            abs_path.write_bytes(raw)
        else:
            abs_path.write_text(content, encoding="utf-8")

        # Preserve mtime if provided
        if mtime:
            os.utime(abs_path, (mtime / 1000, mtime / 1000))

        return True
    except (OSError, PermissionError) as e:
        print(f"[filesync] Write failed for {abs_path}: {e}")
        return False


# ── SyncSession ──────────────────────────────────────────────────────

class SyncSession:
    """
    Manages one bidirectional file sync session for a workspace.

    Threading model:
        - The watchdog runs in a dedicated thread (SyncFileWatcher)
        - The WebSocket send/recv runs on the asyncio event loop
        - The outgoing_queue bridges the thread → asyncio boundary
    """

    def __init__(
        self,
        workspace_id: str,
        workspace_path: Path,
        loop: asyncio.AbstractEventLoop,
    ):
        self.workspace_id = sanitize_workspace_id(workspace_id)
        self.workspace_path = workspace_path
        self.loop = loop
        self.echo_mutex = EchoMutex()

        # Outgoing changes (watchdog thread → WS sender task)
        self.outgoing_queue: asyncio.Queue = asyncio.Queue()

        # Active WebSocket (set when WS connects)
        self.websocket: Optional["WebSocket"] = None  # type: ignore  # noqa: F821

        # Watchdog (created on fs_init_complete, runs in thread)
        self.watcher: Optional["SyncFileWatcher"] = None  # type: ignore  # noqa: F821

        # State
        self.initial_sync_done = False
        self.created_at = time.time()
        self._running = True

    async def handle_incoming(self, message: dict) -> None:
        """
        Handle an incoming message from Electron over the WebSocket.
        Messages: fs_change, fs_batch, fs_init_complete, fs_ping
        """
        msg_type = message.get("type", "")

        if msg_type == "fs_init_complete":
            # Electron signals that initial tar sync is done and local
            # watcher is active. Now we can safely start the VPS watchdog.
            self.initial_sync_done = True
            print(f"[filesync] fs_init_complete for {self.workspace_id}")
            if self.websocket:
                await self.websocket.send_json({
                    "type": "fs_ack",
                    "workspaceId": self.workspace_id,
                    "init_complete": True,
                })

        elif msg_type == "fs_change":
            await self._apply_change(message)

        elif msg_type == "fs_batch":
            for change in message.get("changes", []):
                await self._apply_change(change)

        elif msg_type == "fs_ping":
            if self.websocket:
                await self.websocket.send_json({
                    "type": "fs_pong",
                    "workspaceId": self.workspace_id,
                })

    async def _apply_change(self, change: dict) -> None:
        """Apply a single file change from Electron to local disk."""
        path = change.get("path", "")
        content = change.get("content")  # None = delete
        mtime = change.get("mtime", 0)

        if not path:
            return

        abs_path = (self.workspace_path / path).resolve()

        # Security: ensure resolved path is within workspace
        try:
            abs_path.relative_to(self.workspace_path.resolve())
        except (ValueError, RuntimeError):
            print(f"[filesync] Path traversal blocked: {path}")
            return

        # Write to disk
        if should_ignore(abs_path):
            return

        ok = wire_to_file(abs_path, content, mtime)
        if ok:
            # Mute the path so our watchdog doesn't echo it back
            self.echo_mutex.mute(path)

    def queue_change(self, path: str, content: Optional[str], mtime: int, size: int) -> None:
        """
        Queue a file change for sending to Electron.
        Called from the watchdog thread — thread-safe via put_nowait.
        """
        try:
            self.outgoing_queue.put_nowait({
                "path": path,
                "content": content,
                "mtime": mtime,
                "size": size,
            })
        except asyncio.QueueFull:
            print(f"[filesync] Queue full, dropping change for {path}")

    def stop(self) -> None:
        """Stop the session — kill watchdog, clear state."""
        self._running = False
        if self.watcher:
            try:
                self.watcher.stop()
            except Exception:
                pass
        self.echo_mutex.clear()
        self.websocket = None


# ── SyncManager ──────────────────────────────────────────────────────

class SyncManager:
    """Registry of active file sync sessions."""

    def __init__(self):
        self._sessions: dict[str, SyncSession] = {}
        self._lock = asyncio.Lock()

    async def create_session(
        self,
        workspace_id: str,
        workspace_path: Path,
        loop: asyncio.AbstractEventLoop,
    ) -> SyncSession:
        """Create a new sync session for a workspace."""
        async with self._lock:
            # Kill existing session if any
            existing = self._sessions.get(workspace_id)
            if existing:
                existing.stop()
            session = SyncSession(workspace_id, workspace_path, loop)
            self._sessions[workspace_id] = session
            return session

    async def get_session(self, workspace_id: str) -> Optional[SyncSession]:
        async with self._lock:
            return self._sessions.get(workspace_id)

    async def remove_session(self, workspace_id: str) -> None:
        async with self._lock:
            session = self._sessions.pop(workspace_id, None)
            if session:
                session.stop()

    async def list_active(self) -> list[dict]:
        """List all active sessions for status reporting."""
        async with self._lock:
            return [
                {
                    "workspace_id": s.workspace_id,
                    "workspace_path": str(s.workspace_path),
                    "connected": s.websocket is not None,
                    "initial_sync_done": s.initial_sync_done,
                    "uptime_seconds": int(time.time() - s.created_at),
                }
                for s in self._sessions.values()
            ]


# ── Singleton ────────────────────────────────────────────────────────

sync_manager = SyncManager()
