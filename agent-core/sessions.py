"""
ORCH Terminal Sessions — tmux-based headless PTY manager
===========================================================
Manages persistent terminal sessions for agents using tmux.
Sessions survive app restarts — attach/detach at will.
"""

import subprocess
import time

TMUX_SOCKET = "/tmp/orch-tmux"

def _tmux(*args: str) -> tuple[str, int]:
    """Run a tmux command. Returns (stdout, exit_code)."""
    try:
        r = subprocess.run(["tmux", "-S", TMUX_SOCKET] + list(args),
                           capture_output=True, text=True, timeout=10)
        return r.stdout.strip(), r.returncode
    except Exception:
        return "", 1

def session_exists(agent_id: str) -> bool:
    _, code = _tmux("has-session", "-t", agent_id)
    return code == 0

def create_session(agent_id: str, shell: str = "/bin/bash", tool: str = "") -> bool:
    """Create a detached tmux session.
    
    Args:
        agent_id: Unique session identifier
        shell: Shell to use (/bin/bash)
        tool: Pre-installed CLI to auto-start (claude, codex, opencode, interpreter)
    """
    kill_session(agent_id)
    _, code = _tmux("new-session", "-d", "-s", agent_id, shell)
    if code != 0:
        return False
    time.sleep(0.3)
    if tool:
        cmd = f"cd /workspace 2>/dev/null || mkdir -p /workspace && cd /workspace; {tool}"
        _tmux("send-keys", "-t", agent_id, cmd, "Enter")
        time.sleep(0.2)
    return session_exists(agent_id)

def kill_session(agent_id: str) -> bool:
    if not session_exists(agent_id):
        return True
    _, code = _tmux("kill-session", "-t", agent_id)
    return code == 0

def _translate_for_tmux(text: str) -> list[str]:
    """Convert xterm.js/readline key streams into tmux send-keys args."""
    parts: list[str] = []
    buf = ""
    i = 0
    while i < len(text):
        ch = text[i]

        # Control chars / Enter / Tab
        if ch == '\r' or ch == '\n':
            if buf:
                parts.append(buf)
                buf = ""
            parts.append("Enter")
            i += 1
            continue

        if ch == '\t':
            if buf:
                parts.append(buf)
                buf = ""
            parts.append("Tab")
            i += 1
            continue

        # Ctrl+C / Ctrl+D / Ctrl+Z / Ctrl+L common terminals
        if ch == '\x03':
            if buf:
                parts.append(buf)
                buf = ""
            parts.append("C-c")
            i += 1
            continue
        if ch == '\x04':
            if buf:
                parts.append(buf)
                buf = ""
            parts.append("C-d")
            i += 1
            continue
        if ch == '\x1a':
            if buf:
                parts.append(buf)
                buf = ""
            parts.append("C-z")
            i += 1
            continue
        if ch == '\x0c':
            if buf:
                parts.append(buf)
                buf = ""
            parts.append("C-l")
            i += 1
            continue
        if ch == '\x7f' or ch == '\b':
            if buf:
                parts.append(buf)
                buf = ""
            parts.append("BSpace" if ch == '\x7f' else "Backspace")
            i += 1
            continue

        # Escape sequences: ESC [ A/B/C/D for arrows, plus home/end variants
        if ch == '\x1b' and i + 2 < len(text) and text[i + 1] == '[':
            code = text[i + 2]
            if buf:
                parts.append(buf)
                buf = ""
            if code == 'A':
                parts.append("Up")
            elif code == 'B':
                parts.append("Down")
            elif code == 'C':
                parts.append("Right")
            elif code == 'D':
                parts.append("Left")
            elif code == 'H':
                parts.append("Home")
            elif code == 'F':
                parts.append("End")
            else:
                parts.append(text[i:i + 3])
            i += 3
            continue

        buf += ch
        i += 1

    if buf:
        parts.append(buf)
    return parts


def write_input(agent_id: str, text: str) -> bool:
    """Send keystrokes to the agent's terminal."""
    if not session_exists(agent_id):
        print(f"[sessions] write_input FAIL: {agent_id} not found")
        return False
    parts = _translate_for_tmux(text)
    if parts:
        _tmux("send-keys", "-t", agent_id, *parts)
        print(f"[sessions] wrote {len(text)} chars to {agent_id}: {repr(text[:50])}")
    return True

def read_buffer(agent_id: str, lines: int = 200) -> str:
    if not session_exists(agent_id):
        return ""
    output, _ = _tmux("capture-pane", "-t", agent_id, "-p", "-S", f"-{lines}", "-e")
    return output

def list_sessions() -> list[dict]:
    output, _ = _tmux("list-sessions", "-F", "#{session_name}:#{session_attached}")
    if not output:
        return []
    result = []
    for line in output.strip().split("\n"):
        if not line.strip():
            continue
        parts = line.split(":", 1)
        result.append({
            "agent_id": parts[0],
            "attached": parts[1] == "1" if len(parts) > 1 else False,
        })
    return result
