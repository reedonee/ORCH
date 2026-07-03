<p align="center">
  <img src="ORCH LOGO1.ico" width="72" alt="ORCH" />
</p>

<h1 align="center">ORCH</h1>

<p align="center">
  <em>A multi-agent desktop workspace. Voice-controlled. VPS-powered.</em>
  <br/>
  <code>Ctrl+E → speak → agents spawn, code, build, deploy.</code>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/electron-35-blue?logo=electron" />
  <img src="https://img.shields.io/badge/react-19-purple?logo=react" />
  <img src="https://img.shields.io/badge/fastapi-blue?logo=fastapi" />
  <img src="https://img.shields.io/badge/ollama-black?logo=ollama" />
  <img src="https://img.shields.io/badge/python-3.11-yellow?logo=python" />
  <img src="https://img.shields.io/badge/license-MIT-green" />
</p>

---

## ✦ What is ORCH?

ORCH is a **real-time voice-controlled multi-agent desktop** that runs AI coding agents (Claude Code, Codex, Hermes, OpenCode) on an infinite canvas — each in its own terminal, all connected to your project files.

- **🎤 Voice-first** — Press `Ctrl+E`, speak, release. Local Whisper STT + Kokoro TTS. <100ms ack. No cloud dependency.
- **🧠 Dual-brain** — Fast local brain (qwen2.5:0.5b) for quick commands, deep brain (qwen2.5-coder:7b) on VPS for code.
- **☁️ Hybrid cloud** — Agents run locally or on a VPS via persistent tmux sessions. Files sync bidirectionally in real-time.
- **🔗 MCP-native** — Every agent auto-discovers the ORCH canvas tools (send_message, read_file, sandbox_exec, memory, agent_think).
- **🎨 Premium UI** — Infinite canvas, glassmorphic cards, cinema-mode layout, custom color themes.

## ✦ Quick start

```bash
npm install
npm run dev
```

Requires Python 3.11+ with `pip install faster-whisper kokoro-onnx silero-vad` for local voice.

## ✦ Architecture

```
┌─ LOCAL (Electron) ────────────────────────────┐
│  Canvas UI  │  PTY Agents  │  Voice STT/TTS   │
│  (faster-whisper + Kokoro)   Barge-in mic     │
└──────────────────────┬────────────────────────┘
                       │ HTTP/WS
                       ▼
┌─ VPS (Oracle ARM64) ──────────────────────────┐
│  agent-core (FastAPI)                          │
│    ├── qwen2.5:0.5b   ← fast voice brain      │
│    ├── qwen2.5-coder:7b ← deep code gen        │
│    ├── Qdrant          ← vector memory (RAG)   │
│    ├── Docker socket   ← code sandbox          │
│    └── MCP tools       ← filesystem, memory    │
└────────────────────────────────────────────────┘
```


<img width="1366" height="736" alt="image" src="https://github.com/user-attachments/assets/c68c0f16-9b60-4400-b2d0-5ce76be71b8a" />



<img width="1366" height="736" alt="image" src="https://github.com/user-attachments/assets/d1e018a7-1c3d-4f73-9d6f-3951cb10e238" />


<img width="1366" height="737" alt="image" src="https://github.com/user-attachments/assets/0dcf35fa-ed45-484e-b269-136a7cf25ea7" />




## ✦ Voice pipeline

```
Mic → AudioWorklet (50ms PCM) → Silero VAD → Whisper base.en
  → Local NLU parser → execute command → Kokoro TTS ack (<150ms)
  → VPS brain (fire-and-forget enhancement)
  → Groq fallback (optional, on STT failure)
```

## ✦ Project structure

```
├── electron/              # Electron main process
│   ├── main.ts            # Window, IPC, voice server bootstrap
│   ├── voice-server.py    # Local VAD → Whisper → TTS sidecar
│   ├── voice-server.ts    # IPC bridge to Python subprocess
│   ├── file-sync-engine.ts # Bidirectional VPS file sync
│   └── mcp-server.ts      # MCP tool server
├── src/                   # React renderer
│   ├── hooks/useVoiceInput.ts  # Audio capture + voice state machine
│   ├── lib/               # VPS client, agent commands, voice parser
│   ├── components/        # ChatBar, AgentCard, Canvas, Terminals
│   └── stores/            # Zustand stores (app, voice, workspace, etc.)
├── agent-core/            # VPS agent-core service (mirror of server/)
│   ├── main.py            # FastAPI: agents, voice, filesync, sessions
│   ├── sessions.py        # tmux session manager + tenant jailing
│   ├── mcp_server.py      # MCP tool definitions (10 tools)
│   ├── filesync/          # Bidirectional sync engine (watchdog)
│   ├── brain.py           # Dual-brain voice intelligence
│   └── memory.py          # Qdrant vector memory
└── server/                # VPS deployment files
    ├── docker-compose.yml
    └── Caddyfile
```

## ✦ First checkpoint

This repo is checkpoint `v0.1` — the voice engine is functional, VPS file sync works, and agents spawn in workspace-jailed tmux sessions. See [commit history](https://github.com/reedonee/ORCH/commits/main) for what's next.
