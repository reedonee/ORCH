<p align="center">
  <img src="ORCH LOGO1.ico" width="72" alt="ORCH" />
</p>

<h1 align="center">ORCH</h1>

<p align="center">
  <em>A multi-agent desktop workspace. Voice-controlled. Fully local.</em>
  <br/>
  <code>Ctrl+E → speak → agents spawn, code, build, deploy.</code>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/electron-35-blue?logo=electron" />
  <img src="https://img.shields.io/badge/react-19-purple?logo=react" />
  <img src="https://img.shields.io/badge/python-3.11-yellow?logo=python" />
  <img src="https://img.shields.io/badge/license-MIT-green" />
</p>

---

## ✦ What is ORCH?

ORCH is a **real-time voice-controlled multi-agent desktop** that runs AI coding agents (Claude Code, Codex, Hermes, OpenCode) on an infinite canvas — each in its own terminal, all connected to your project files.

- **🎤 Voice-first** — Hold `Ctrl+E`, speak, release. Local Parakeet/Whisper STT + Kokoro TTS. Streaming synthesis with real barge-in. No cloud dependency.
- **🧠 Smart arrange** — Six layout modes over an engine that picks a grid shape from your window's aspect ratio and moves each card to the nearest slot, so tidying settles rather than reshuffles.
- **🔗 MCP-native** — Every agent auto-discovers the ORCH canvas tools (canvas state, agent messaging, blackboard delegation, memory recall, layout control) over an authenticated local MCP server.
- **🎨 Premium UI** — Infinite canvas, glassmorphic cards, GPU-accelerated terminals, custom color themes.

## ✦ Quick start

```bash
npm install
npm run dev
```

**Voice** needs a Python 3.11 environment with the sidecar's dependencies:

```bash
uv venv --python 3.11 .venv-voice
uv pip install -r electron/requirements-voice.txt
```

ORCH auto-detects `.venv-voice/` (override with `ORCH_PYTHON`). On first
launch the sidecar downloads ~1&nbsp;GB of STT/TTS models into
`electron/voice-models/`; the UI stays usable while that happens.

```bash
npm test        # layout engine, voice parser, sidecar logic
npm run typecheck
```

## ✦ Architecture

Everything runs on your machine. There is no server component.

```
┌─ Electron main ──────────────────────────────┐
│  PTY sessions (node-pty)   │  MCP server (HTTP) │
│  Local JSON store          │  Event bus         │
│  Voice sidecar supervisor  │  Artifact registry │
└─────────────┬──────────────────────────┘
                │ IPC
┌─────────────┴──────────────────────────┐
│  React renderer                                 │
│  Infinite canvas │ xterm.js (WebGL) │ Layout      │
└────────────────────────────────────────┘
                │ stdin/stdout JSON lines
┌─────────────┴──────────────────────────┐
│  Python voice sidecar                           │
│  Silero VAD → Parakeet/Whisper → Kokoro TTS      │
└────────────────────────────────────────┘
```

Supabase is used only for optional account sync (workspaces, preferences,
feedback). ORCH runs fully offline without it.

<img width="1366" height="736" alt="image" src="https://github.com/user-attachments/assets/c68c0f16-9b60-4400-b2d0-5ce76be71b8a" />



<img width="1366" height="736" alt="image" src="https://github.com/user-attachments/assets/d1e018a7-1c3d-4f73-9d6f-3951cb10e238" />


<img width="1366" height="737" alt="image" src="https://github.com/user-attachments/assets/0dcf35fa-ed45-484e-b269-136a7cf25ea7" />




## ✦ Voice pipeline

```
Mic → AudioWorklet (50ms PCM) → Silero VAD → Parakeet STT (Whisper fallback)
  → Local NLU parser → execute command
  → Kokoro TTS, synthesized per sentence and streamed
  → Renderer schedules spans gaplessly on one AudioContext
  → Barge-in: speaking over ORCH cancels synthesis mid-utterance
  → Groq fallback (optional, on STT failure)
```

Synthesis runs on its own thread inside the sidecar, so an `interrupt`
is never queued behind the speech it is cancelling.

## ✦ Agents work together

Agents on the canvas are aware of each other. Every agent ORCH launches
(Claude Code, Codex, Hermes, OpenCode) is connected to ORCH's MCP server
**as itself**: its identity rides on the connection, so no tool ever asks
a model for an id it cannot know, and the server's instructions tell it
who it is and what ORCH is before its first turn. A green dot on the card
means the agent is connected.

| Tool | What it does |
|---|---|
| `orch_whoami` | Who you are, your role, and what is happening on the canvas |
| `orch_snapshot` | Every agent with its id, activity, connection, and prompts waiting on the user |
| `orch_wait_for_events` | Real-time sync: returns the moment something changes, with a cursor so nothing is missed |
| `agent_set_status` | Report phase, current task, and which files you're editing |
| `agent_roster` | See every agent, what they're doing, and file collisions |
| `agent_send` | Message another agent by name, broadcast, or `to: "orch"` for the controller / user |
| `agent_inbox` | Read what others sent you |

**The controller.** Click the crown on a card (or say "make Max the
controller") and that agent coordinates the rest. It is briefed, kept in
sync through `orch_wait_for_events` and a summary of changes on every ORCH
reply, and — when it is idle — nudged with an `[ORCH sync]` line as soon
as another agent finishes, fails, gets blocked, messages it, or is waiting
on the user. It cannot answer other agents' permission prompts; only the
user can.

Because agents declare the files they're touching, ORCH detects when two
are about to edit the same file and warns both — the failure mode that no
single agent can see on its own.

**Hold `Tab`** and every card flips to show what its agent is working on,
how long it's been at it, progress, and any file conflicts. `Shift+Tab`
pins it open; `Esc` releases.

## ✦ Agents can drive the app

An agent isn't limited to its terminal. It can do what you can:

| Tool | What it does |
|---|---|
| `canvas_add_file` | Put a generated image, video, PDF or any file on the canvas |
| `canvas_add_note` | Leave a text note |
| `canvas_arrange` | Re-run the layout engine |
| `app_action` | Open the browser, play music, select an agent, switch theme, notify… |
| `list_app_actions` | Discover the full action set |

So "generate a 4K wallpaper and put it on the canvas" is one task: the
agent writes the file, calls `canvas_add_file`, and it appears as a node.
Images and video render inline; everything else becomes a file card.

Generated media is copied into the app's asset store and served over a
dedicated `orch-asset://` scheme, so a node keeps working after the agent
cleans up its temp directory — and the renderer never needs filesystem
access.

## ✦ Layout modes

`Ctrl+K` → search "layout", or say them out loud.

| Mode | What it does |
|---|---|
| **grid** | Even cells; column count chosen from the window's aspect ratio |
| **focus** | Selected agent large, the rest in a side rail |
| **stage** | Browser left, agents gridded right |
| **split** | Two balanced columns for side-by-side comparison |
| **rail** | Single horizontal strip |
| **constellation** | Bands clustered by delegation relationships |

Every mode is overlap-free by construction and assigns each card to its
nearest slot, so repeated tidies are stable.

## ✦ Project structure

```
├── electron/              # Electron main process
│   ├── main.ts            # Window, IPC, PTY sessions, security
│   ├── voice-server.py    # Local VAD → STT → streaming TTS sidecar
│   ├── voice-server.ts    # Sidecar supervisor + protocol bridge
│   ├── mcp-server.ts      # Authenticated multi-session MCP server
│   ├── event-bus.ts       # Events + blackboard task delegation
│   ├── artifact-registry.ts # Episodic memory with fuzzy recall
│   ├── hibernation.ts     # Idle session reclamation
│   └── local-db.ts        # Debounced JSON store
├── src/                   # React renderer
│   ├── lib/layout-modes.ts  # Layout engine (pure geometry)
│   ├── lib/voice-audio.ts   # Gapless TTS playback scheduler
│   ├── lib/voice-parser.ts  # Local NLU
│   ├── hooks/useVoiceInput.ts
│   ├── components/        # Canvas, AgentCard, terminals, dialogs
│   └── stores/            # Zustand stores
├── tests/                 # Layout, parser, and sidecar checks
└── supabase/migrations/   # Schema + RLS policies
```

## ✦ Security notes

- The MCP server binds to loopback **and** requires a per-launch bearer
  token; browser `Origin` requests are refused outright. Loopback alone is
  not a trust boundary when the tools can spawn processes.
- `<webview>` attachments are sanitised (no preload, no node integration),
  `window.open` is denied, and shell navigation is pinned to the app origin.
- Feedback rows are restricted by Postgres RLS (migration `003`). The
  in-app admin unlock is a UI convenience, not an access control.
