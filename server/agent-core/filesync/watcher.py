"""
ORCH File Sync — Watchdog Wrapper
==================================
Wraps the watchdog library to monitor a workspace directory for changes
and queue them for transmission to Electron.

Runs in a dedicated thread so it doesn't block the asyncio event loop.
Uses callback-style dispatch to bridge into the async world.
"""

import os
import time
import threading
from pathlib import Path
from typing import Optional

from watchdog.observers import Observer
from watchdog.events import (
    FileSystemEventHandler,
    FileCreatedEvent,
    FileModifiedEvent,
    FileDeletedEvent,
    FileMovedEvent,
)

from .sync_manager import SyncSession, should_ignore, file_to_wire


class SyncFileEventHandler(FileSystemEventHandler):
    """
    Watchdog event handler that filters, mutes echoes, and queues changes.

    This runs in the watchdog's thread. We use file_to_wire() to read the file
    content and queue it via the session's thread-safe put_nowait().
    """

    def __init__(self, session: SyncSession):
        super().__init__()
        self.session = session

    def _rel_path(self, abs_path: str) -> Optional[str]:
        """Convert an absolute path to workspace-relative. None if outside."""
        try:
            p = Path(abs_path).resolve()
            return str(p.relative_to(self.session.workspace_path.resolve())).replace("\\", "/")
        except (ValueError, RuntimeError):
            return None

    def _queue_event(self, src_path: str, is_deletion: bool = False):
        """Process a filesystem event and queue it for transmission."""
        if not self.session._running:
            return

        rel_path = self._rel_path(src_path)
        if not rel_path:
            return

        # Check echo mutex — if we just wrote this file due to an incoming
        # change from Electron, suppress the echo.
        if self.session.echo_mutex.is_muted(rel_path):
            return

        abs_path = Path(src_path).resolve()

        if is_deletion or not abs_path.exists():
            # File deleted
            self.session.queue_change(rel_path, None, 0, 0)
            return

        # Read and queue
        payload = file_to_wire(abs_path, rel_path)
        if payload:
            self.session.queue_change(
                payload["path"],
                payload["content"],
                payload["mtime"],
                payload["size"],
            )

    def on_created(self, event: FileCreatedEvent):
        if not event.is_directory:
            self._queue_event(event.src_path)

    def on_modified(self, event: FileModifiedEvent):
        if not event.is_directory:
            self._queue_event(event.src_path)

    def on_deleted(self, event: FileDeletedEvent):
        if not event.is_directory:
            self._queue_event(event.src_path, is_deletion=True)

    def on_moved(self, event: FileMovedEvent):
        # Treat as delete of source + create of destination
        if not event.is_directory:
            self._queue_event(event.src_path, is_deletion=True)
            self._queue_event(event.dest_path)


class SyncFileWatcher:
    """
    Manages a watchdog Observer in a dedicated thread.

    Usage::
        watcher = SyncFileWatcher(session)
        watcher.start()
        ...
        watcher.stop()
    """

    def __init__(self, session: SyncSession):
        self.session = session
        self.observer: Optional[Observer] = None
        self._thread: Optional[threading.Thread] = None

    def start(self):
        """Start watching the session's workspace directory in a background thread."""
        watch_path = str(self.session.workspace_path.resolve())
        if not os.path.isdir(watch_path):
            os.makedirs(watch_path, exist_ok=True)
            print(f"[filesync] Created workspace directory: {watch_path}")

        event_handler = SyncFileEventHandler(self.session)

        self.observer = Observer()
        self.observer.schedule(event_handler, watch_path, recursive=True)
        self.observer.start()
        print(f"[filesync] Watchdog started on {watch_path}")

    def stop(self):
        """Stop the watchdog and join the thread."""
        if self.observer:
            self.observer.stop()
            self.observer.join(timeout=5)
            self.observer = None
            print(f"[filesync] Watchdog stopped for {self.session.workspace_id}")
