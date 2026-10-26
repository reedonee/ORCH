import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { exec, execFile, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import { OrchMcpServer, type SyncEvent } from './mcp-server.js';
import { mcpLaunchArgs, mcpLaunchEnv, CLI_REGISTERED_PROVIDERS, HERMES_ORCH_ENTRY } from './mcp-agent-config.js';
import { VoiceServer } from './voice-server.js';
import {
  initLocalDb, getDbPath,
  recordTerminalStart, updateTerminalBuffer, finaliseTerminal, listTerminalHistory,
  logAgentEvent, listAgentLogs,
  recordSessionEvent, listSessionEvents,
  upsertLocalWorkspace, listLocalWorkspaces, deleteLocalWorkspace,
  saveLocalSettings, getLocalSettings,
  getLocalStats, resetLocalDb, flushLocalDb,
} from './local-db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;

const VITE_DEV_URL = process.env['VITE_DEV_SERVER_URL'];

// ── PTY Session Manager ─────────────────────────────────────────
import type { IPty } from 'node-pty';
let pty: typeof import('node-pty') | null = null;

// Per-session line buffer to resolve chunk fragmentation for event bus
const sessionLineBuffers: Record<string, string> = {};

/** Banners emitted before their session log was opened. */
const queuedPreambles = new Map<string, string>();

// PtySession type now lives in hibernation.ts — re-exported for convenience
import {
  openSessionLog, appendSessionLog, closeSessionLog,
  readSessionTail, readSessionRange, readSessionFull,
  searchSessionLog, sessionLogStats, listSessionLogs,
  pruneSessionLogs, flushSessionLogs, getTranscriptDir, stripAnsi,
} from './session-log.js';
import {
  installDiagnostics, recordCrash, listCrashReports,
  clearCrashReports, getCrashReportsDir,
} from './diagnostics.js';
import { HibernationManager } from './hibernation.js';
import type { PtySession } from './hibernation.js';
import {
  ApprovalTracker, approvalKeys, shouldAutoApprove, stripPermissionBypass, terminalText,
  type ApprovalDecision, type ApprovalMode, type PendingApproval,
} from './agent-approvals.js';

const sessions = new Map<string, PtySession>();
/** Permission-prompt state per PTY session. See agent-approvals.ts. */
const approvalTrackers = new Map<string, ApprovalTracker>();
const MAX_BUF_LINES = 2000;

let mcpServer: OrchMcpServer | null = null;
let hibernationManager: HibernationManager | null = null;
let voiceServer: VoiceServer | null = null;

function getPty(): typeof import('node-pty') {
  if (!pty) {
    pty = require('node-pty') as typeof import('node-pty');
  }
  return pty;
}

function forwardOutput(sessionId: string, data: string) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(`term_out_${sessionId}`, data);
}

// ── Resolve command path (Windows: search PATH via where) ──────
function resolveCommand(cmd: string): Promise<string> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(cmd);
    if (cmd.includes('\\') || cmd.includes('/') || path.extname(cmd)) return resolve(cmd);

    let resolved = false;
    const child = exec(`where ${cmd}`, { encoding: 'utf8', timeout: 800 }, (err, stdout) => {
      if (resolved) return;
      resolved = true;
      if (err || !stdout) return resolve(cmd);
      const line = stdout.split('\n')[0]?.trim();
      resolve(line && line.length > 0 ? line : cmd);
    });
    setTimeout(() => {
      if (resolved) return;
      resolved = true;
      child.kill();
      resolve(cmd);
    }, 800);
  });
}

/**
 * Banner printed into a freshly spawned agent terminal.
 *
 * Tool descriptions alone are not enough: an agent that has never seen
 * ORCH has no reason to think reporting its status matters, or that
 * putting a generated file on the canvas is even possible. Most models
 * only use a tool when the surrounding context suggests it. This is the
 * cheapest place to establish that expectation — the agent reads it as
 * part of its terminal scrollback before its first turn.
 */
function getMcpPreamble(providerId: string, mcpUrl: string, agentName: string, agentId: string): string {
  if (!mcpUrl) return '';

  const C = (code: string, text: string) => `\x1b[${code}m${text}\x1b[0m`;
  const dim = (t: string) => C('2', t);
  const amber = (t: string) => C('33', t);
  const cyan = (t: string) => C('36', t);

  const lines = [
    '',
    amber(`⚡ ORCH — you are "${agentName}" on a shared canvas`),
    dim(`   agent id: ${agentId}`),
    '',
    cyan('   You are not alone.') + ' Other agents work on this project at the',
    '   same time. Keep them in the loop:',
    '',
    `   ${amber('agent_set_status')}  say what you are doing, and which files you`,
    '                     are touching. Do this when you start, at each',
    '                     milestone, and when you finish or get stuck.',
    `   ${amber('agent_roster')}      see who else is working and on what - check`,
    '                     this BEFORE you start, to avoid colliding.',
    `   ${amber('agent_send')}        message another agent (or broadcast).`,
    `   ${amber('agent_inbox')}       read what they sent you.`,
    '',
    cyan('   You can act on the app itself:'),
    `   ${amber('canvas_add_file')}   put something you made — an image, video, PDF,`,
    '                     any file — onto the canvas so the user SEES it.',
    `   ${amber('canvas_add_note')}   leave a note on the canvas.`,
    `   ${amber('app_action')}        do anything the user could do by hand.`,
    `   ${amber('list_app_actions')}  see the full list.`,
    '',
    dim('   If the user asks you to produce something visual, generate the'),
    dim('   file, then call canvas_add_file with its absolute path.'),
    '',
  ];

  return lines.join('\r\n') + '\r\n';
}

/** One registration attempt per provider per app launch. */
const mcpRegistrations = new Map<string, Promise<void>>();
/** Providers whose config ORCH wrote this run, to undo on quit. */
const mcpRegistered = new Set<string>();

/** Run a CLI without a shell, bounded, with stdin closed: nothing will
 *  answer a prompt, so a CLI that asks must fail fast rather than hang. */
async function runCli(command: string, args: string[], timeout: number): Promise<Error | null> {
  const file = await resolveCommand(command).catch(() => command);
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout, killSignal: 'SIGKILL', windowsHide: true },
      (err) => resolve(err ?? null));
    try { child.stdin?.end(); } catch { /* already closed */ }
  });
}

/**
 * Register the ORCH MCP server with a CLI that has no per-invocation
 * option. Today that is Hermes alone.
 *
 * `hermes config set` writes HERMES_ORCH_ENTRY, whose values are ${ENV}
 * placeholders resolved per agent at launch — so one write per run serves
 * every Hermes agent, and the entry never holds a stale port or token.
 * This replaces `hermes mcp add`, which is interactive and never once
 * registered anything (it blocked on a tool picker until killed).
 *
 * Bounded, so a CLI that stalls can delay a spawn but never wedge it.
 */
async function registerAgentMcp(providerId: string): Promise<void> {
  if (providerId !== 'hermes') return;
  const err = await runCli('hermes',
    ['config', 'set', '--force', 'mcp_servers.orch', JSON.stringify(HERMES_ORCH_ENTRY)], 20000);
  if (!err) {
    mcpRegistered.add(providerId);
    console.log('[MCP] Registered ORCH server with hermes');
  } else {
    console.warn('[MCP] hermes registration failed:', (err.message || '').split('\n')[0].slice(0, 160));
  }
}

/** Register once per launch, sharing the in-flight attempt. */
function ensureAgentMcpRegistered(providerId: string): Promise<void> {
  if (!mcpServer || !CLI_REGISTERED_PROVIDERS.includes(providerId)) return Promise.resolve();
  let inFlight = mcpRegistrations.get(providerId);
  if (!inFlight) {
    inFlight = registerAgentMcp(providerId);
    mcpRegistrations.set(providerId, inFlight);
  }
  return inFlight;
}

/** Undo registrations on quit. Outside ORCH the ${ENV} placeholders are
 *  unset and Hermes would report a server it cannot reach. Detached: quit
 *  must not wait on another CLI. */
function unregisterAgentMcp(): void {
  if (!mcpRegistered.has('hermes')) return;
  try {
    const child = spawn('hermes', ['config', 'unset', 'mcp_servers.orch'],
      { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
    child.on('error', () => { /* hermes gone; nothing to undo */ });
    child.unref();
  } catch { /* best effort */ }
}


/**
 * Decide where an agent should run.
 *
 * Order: the workspace the renderer asked for, then the last workspace
 * ORCH opened, then the user's home directory. Home is a deliberate last
 * resort — it is somewhere the user can actually navigate from, unlike
 * Electron's install directory.
 */
function resolveAgentCwd(requested?: string | null): string {
  const candidates = [
    requested,
    getLocalSettings()?.preferences?.lastWorkspacePath as string | undefined,
    app.getPath('home'),
  ];
  for (const c of candidates) {
    if (!c || typeof c !== 'string') continue;
    try {
      if (fs.existsSync(c) && fs.statSync(c).isDirectory()) return c;
    } catch { /* unreadable — try the next candidate */ }
  }
  return process.cwd();
}

// ── Window ───────────────────────────────────────────────────────

function createWindow() {
  const icoPath = path.join(__dirname, '../ORCH LOGO1.ico');
  const icon = require('fs').existsSync(icoPath) ? icoPath : undefined;
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    transparent: false,
    backgroundColor: '#0E1A14',
    title: 'ORCH - Agentic OS',
    icon: icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });

  if (VITE_DEV_URL) {
    mainWindow.loadURL(VITE_DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  // ── Renderer hardening ─────────────────────────────────────
  // webviewTag is enabled for the in-app browser panel. Without an
  // attach guard, any script that manages to run in the renderer could
  // attach a <webview> carrying its own preload or nodeIntegration and
  // escape the sandbox, so strip those attributes centrally.
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    delete (webPreferences as Record<string, unknown>).preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    console.log('[Security] webview attach sanitised:', params.src?.slice(0, 80));
  });

  // window.open / target=_blank from any page must not spawn an
  // uncontrolled Electron window. Hand http(s) to the real browser and
  // refuse everything else.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    } else {
      console.warn('[Security] Blocked window.open for non-http URL:', url.slice(0, 80));
    }
    return { action: 'deny' };
  });

  // Keep the app shell itself pinned to its own origin; in-app browsing
  // belongs in the webview, not in the window hosting the React app.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = VITE_DEV_URL ? url.startsWith(VITE_DEV_URL) : url.startsWith('file://');
    if (!allowed) {
      event.preventDefault();
      console.warn('[Security] Blocked shell navigation to:', url.slice(0, 80));
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    for (const [id, s] of sessions) {
      if (s.pty) s.pty.kill();
      sessions.delete(id);
    }
  });

  // ── Start MCP server + Hibernation after window is ready ────
  mainWindow.webContents.on('did-finish-load', async () => {
    await startMcpServer();
    // Hibernation no longer auto-starts — user enables in Settings
  });
}

/** Bus event types the renderer subscribes to. Deliberately a whitelist:
 *  terminal_line fires per output line and must never reach the renderer
 *  as an IPC message — that is what term_out_<sessionId> is for. */
const FORWARDED_EVENT_TYPES = new Set([
  'delegation_created',
  'task_posted',
  'task_claimed',
  'task_completed',
  'task_failed',
  'task_cancelled',
  'artifact_created',
  'memory_created',
]);

// ── Renderer bridge ──────────────────────────────────────────────
// The canvas lives in React state, so canvas-facing MCP tools have to
// ask the renderer. window.__orchBridge.call(method, args) is the only
// entry point; args travel as a JSON literal rather than being spliced
// into source text positionally.

/** Render a value as a JS literal for embedding in an executeJavaScript
 *  snippet. JSON is a syntactic subset of JS expressions, and U+2028/29
 *  have been legal inside string literals since ES2019, so JSON.stringify
 *  alone is sufficient and safe here. */
function toJsLiteral(value: unknown): string {
  return JSON.stringify(value ?? null);
}

async function callBridge<T>(method: string, args: Record<string, unknown>, fallback: T): Promise<T> {
  if (!mainWindow || mainWindow.isDestroyed()) return fallback;
  const code = `(window.__orchBridge && window.__orchBridge.call)
    ? window.__orchBridge.call(${toJsLiteral(method)}, ${toJsLiteral(args)})
    : ${toJsLiteral(fallback)}`;
  try {
    return await mainWindow.webContents.executeJavaScript(code) as T;
  } catch (err) {
    console.warn(`[Bridge] ${method} failed:`, err);
    return fallback;
  }
}

// ── MCP Server ─── LOCAL-ONLY ─────────────────────────────────────
// MCP server runs locally. All tools serve from the local machine.

async function startMcpServer() {
  if (mcpServer) return;
  const server = new OrchMcpServer(sessions);
  mcpServer = server;

  // Wire canvas callbacks from main process state. The server builds its
  // own snapshot from the mesh plus this runtime view; output is compact
  // markdown to save the reading model's context window.
  server.getAgentRuntime = () => {
    const now = Date.now();
    const out = [];
    for (const [sessionId, s] of sessions) {
      const pending = approvalTrackers.get(sessionId)?.pending;
      out.push({
        agentId: s.agentId, name: s.name, providerId: s.providerId,
        terminal: s.hibernating ? 'sleeping' as const : 'running' as const,
        idleMs: now - s.lastActivity,
        approval: pending ? { kind: pending.kind, detail: pending.detail } : null,
      });
    }
    return out;
  };

  server.getCanvasElements = async () => {
    return callBridge('getCanvasElements', {}, []);
  };

  server.moveAgent = async (id: string, x: number, y: number) => {
    await callBridge('moveAgent', { id, x, y }, null);
  };

  server.sendToAgent = async (id: string, text: string) => {
    for (const [sessionId, session] of sessions) {
      if (session.agentId !== id) continue;
      if (!session.pty) return { ok: false, reason: 'its terminal is asleep — wake it from its card first' };
      // Typing into an open permission prompt would answer it; only the
      // user may do that.
      if (approvalTrackers.get(sessionId)?.pending) {
        return { ok: false, reason: 'it is waiting on a permission prompt only the user can answer' };
      }
      typeIntoAgent(sessionId, text);
      return { ok: true };
    }
    return { ok: false, reason: 'it has no running terminal' };
  };

  server.readAgentOutput = async (id: string, lines?: number) => {
    for (const [, session] of sessions) {
      if (session.agentId !== id) continue;
      // Plain text for a model to read: ConPTY's cursor codes become the
      // spaces and newlines they stand for, and runs of blank lines (TUI
      // repaints) collapse.
      const clean = terminalText(session.buffer.join(''))
        .split('\n').map((l) => l.trimEnd())
        .filter((l, i, all) => l !== '' || (i > 0 && all[i - 1] !== ''));
      return clean.slice(-(lines || 50)).join('\n');
    }
    return '';
  };

  server.notifyAgentView = (agentId: string, text: string) => {
    for (const [sessionId, session] of sessions) {
      if (session.agentId !== agentId) continue;
      forwardOutput(sessionId, text);
      appendSessionLog(sessionId, text);
    }
  };

  server.onUserMessage = (message) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('orch_user_message', {
        from: message.fromName, subject: message.subject, body: message.body, kind: message.kind,
      });
    }
  };

  server.onAgentConnection = (agentId, info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mcp_connection', { agentId, ...info });
    }
  };

  server.createAgent = async (providerId: string, name?: string, contextSnapshot?: string) => {
    // The renderer owns agent creation end-to-end (it mints the id, creates
    // the PTY, and places the card via the layout engine), so delegate
    // rather than half-creating the session here.
    return callBridge('createAgent', { providerId, name: name ?? null, contextSnapshot: contextSnapshot ?? null },
      { error: 'renderer unavailable' });
  };

  server.removeAgent = async (id: string) => {
    // Let the renderer drop the card; it calls back into remove_agent,
    // which runs destroySession() for full PTY + DB + config cleanup.
    await callBridge('removeAgent', { id }, null);
    // Defensive: if the card was already gone, still reap any orphan session.
    for (const [sessionId, session] of sessions) {
      if (session.agentId === id) destroySession(sessionId, session);
    }
  };

  server.arrange = async (mode: string) => {
    return callBridge('arrange', { mode }, { error: 'renderer unavailable' });
  };

  server.addCanvasFile = async (opts) => {
    // Validate in the main process, where the filesystem actually is.
    // The renderer cannot stat a path, so without this an agent could
    // "add" a file that does not exist and get a node showing nothing.
    if (!opts.path) return { error: 'path is required' };
    const abs = path.resolve(opts.path);
    if (!fs.existsSync(abs)) {
      return { error: `File not found: ${abs}. Create it first, then add it to the canvas.` };
    }
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return { error: `Not a file: ${abs}` };

    const ext = path.extname(abs).toLowerCase().replace('.', '');
    const kind = classifyFile(ext);

    // Images and videos are shown inline, so they need a URL the renderer
    // can load. file:// is blocked for renderer content, and copying into
    // userData keeps the node working even if the agent later deletes or
    // moves its output.
    let assetUrl: string | null = null;
    if (kind === 'image' || kind === 'video') {
      try {
        assetUrl = await cacheCanvasAsset(abs, ext);
      } catch (err) {
        console.warn('[Canvas] asset cache failed:', err);
      }
    }

    return callBridge('addFile', {
      agentId: opts.agentId,
      path: abs,
      assetUrl,
      kind,
      ext,
      sizeBytes: stat.size,
      title: opts.title ?? path.basename(abs),
      x: opts.x, y: opts.y, width: opts.width, height: opts.height,
    }, { error: 'renderer unavailable' });
  };

  server.addCanvasNote = async (opts) =>
    callBridge('addNote', { ...opts }, { error: 'renderer unavailable' });

  server.appAction = async (action: string, params: Record<string, unknown>) => {
    // A few actions belong to the main process; everything else is UI.
    if (action === 'speak') {
      voiceServer?.speak('agent', String(params.text ?? ''));
      return { ok: true, action };
    }
    return callBridge('appAction', { action, params }, { error: 'renderer unavailable' });
  };

  // ── Mesh → UI ────────────────────────────────────────────────
  // The server owns the mesh callbacks (it journals them for sync) and
  // passes each one on here.
  server.onMeshStatus = (status) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('agent-status-report', status);
  };

  server.onMeshMessage = (message) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent-message', message);
    }
    deliverMeshMessage(message);
  };

  server.getSessionAgentId = (sessionId: string) => {
    const session = sessions.get(sessionId);
    return session?.agentId;
  };

  server.getProviders = () => {
    // Return configured providers — reads from local settings
    const settings = getLocalSettings();
    return settings.providers || [];
  };

  // ── EventBus → renderer ────────────────────────────────────
  // The blackboard emits onto an in-process bus; the canvas draws
  // delegation links from IPC. Without this forwarder the two never
  // meet and delegation links never appear.
  server.onBusEvent = (event) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!FORWARDED_EVENT_TYPES.has(event.type)) return;
    mainWindow.webContents.send(event.type, {
      ...event.data,
      sourceAgentId: event.sourceAgentId,
      timestamp: event.timestamp,
    });
  };

  await server.start();
  // Token-free URLs only: logs end up in bug reports and screenshots.
  console.log(`[MCP] Server started on ${server.publicUrl}`);
  console.log(`[MCP] Streamable endpoint for agents: ${server.streamUrlNoToken}`);

  // Start CLI registration now rather than on first spawn, so the common
  // case never waits for it.
  for (const providerId of CLI_REGISTERED_PROVIDERS) {
    void ensureAgentMcpRegistered(providerId);
  }
}


// ── Canvas file support ─────────────────────────────────────────

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac']);
const TEXT_EXT  = new Set(['txt', 'md', 'json', 'yaml', 'yml', 'csv', 'log', 'ts', 'tsx',
                           'js', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'sh', 'html', 'css']);

export type CanvasFileKind = 'image' | 'video' | 'audio' | 'text' | 'pdf' | 'file';

function classifyFile(ext: string): CanvasFileKind {
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'file';
}

/**
 * Copy an agent-produced file into the app's asset store and return a URL
 * the renderer can load.
 *
 * Copying rather than referencing in place is deliberate: agents write to
 * temp directories and clean up after themselves, and a canvas node whose
 * image vanished an hour later would be worse than useless.
 */
async function cacheCanvasAsset(absPath: string, ext: string): Promise<string> {
  const dir = path.join(app.getPath('userData'), 'canvas_assets');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const name = `asset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const dest = path.join(dir, name);
  await fs.promises.copyFile(absPath, dest);

  // orch-asset:// is registered as a privileged scheme at startup so the
  // renderer can load these without weakening webSecurity.
  return `orch-asset://${encodeURIComponent(name)}`;
}

/**
 * Deliver a mesh message into the recipient's terminal.
 *
 * Written as a visible, clearly-marked block rather than as raw keystrokes
 * so it reads as an incoming message and cannot be mistaken for the user
 * typing. Broadcasts reach everyone except the sender.
 */
function deliverMeshMessage(message: import('./agent-mesh.js').AgentMessage): void {
  if (!mcpServer) return;

  const banner =
    `\r\n\x1b[36m╭─ ORCH · ${message.kind} from ${message.fromName}\x1b[0m\r\n` +
    `\x1b[36m│\x1b[0m \x1b[1m${message.subject}\x1b[0m\r\n` +
    message.body.split('\n').map((l) => `\x1b[36m│\x1b[0m ${l}`).join('\r\n') + '\r\n' +
    `\x1b[36m╰─ reply with agent_send (replyTo: ${message.id})\x1b[0m\r\n`;

  for (const [sessionId, session] of sessions) {
    if (session.agentId === message.from) continue;
    if (message.to !== null && session.agentId !== message.to) continue;
    // Write to the VIEW, not the PTY. Injecting into stdin would submit
    // the text as if the user had typed it, firing off a half-formed
    // prompt; the agent reads its inbox through agent_inbox instead.
    forwardOutput(sessionId, banner);
    appendSessionLog(sessionId, banner);
  }
  mcpServer.mesh.markDelivered(message.id);
}

// ── Hibernation Manager ──────────────────────────────────────────

function startHibernationManager() {
  if (hibernationManager) return;
  hibernationManager = new HibernationManager(sessions, getPty);

  // Notify renderer when an agent hibernates or wakes
  hibernationManager.onHibernate = (sessionId, agentId) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent-status-changed', { agentId, status: 'sleeping', sessionId });
    }
    const session = sessions.get(sessionId);
    logAgentEvent(agentId, session?.name || 'unknown', session?.providerId || '', 'hibernated');
    recordSessionEvent('focus_change', { sessionId, agentId, action: 'hibernate' });
  };
  hibernationManager.onWake = (sessionId, agentId) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent-status-changed', { agentId, status: 'active', sessionId });
    }
    const session = sessions.get(sessionId);
    logAgentEvent(agentId, session?.name || 'unknown', session?.providerId || '', 'woken');
    recordSessionEvent('focus_change', { sessionId, agentId, action: 'wake' });
  };

  hibernationManager.start();
  console.log('[Hibernation] Manager initialised');
}

// ── IPC: Hibernation ─────────────────────────────────────────────

ipcMain.handle('get_memory_artifacts', async (_event, { agentId, limit }) => {
  if (!mcpServer) return [];
  return mcpServer.artifactRegistry.getByAgent(agentId || '', limit || 20);
});

ipcMain.handle('recall_memories', async (_event, { keywords, agentId, limit }) => {
  if (!mcpServer) return [];
  return mcpServer.artifactRegistry.recall(keywords || [], { agentId, limit: limit || 10 });
});

ipcMain.handle('query_delegation_tasks', async (_event, { status, limit }) => {
  if (!mcpServer) return [];
  return mcpServer.eventBus.queryTasks({ status, limit: limit || 20 });
});

ipcMain.handle('hibernate_agent', async (_event, { agentId }) => {
  if (!hibernationManager) return { success: false, error: 'not started' };
  // Find session by agentId
  for (const [sessionId, s] of sessions) {
    if (s.agentId === agentId) {
      const ok = hibernationManager.hibernate(sessionId);
      return { success: ok };
    }
  }
  return { success: false, error: 'agent not found' };
});

ipcMain.handle('wake_agent', async (_event, { agentId }) => {
  if (!hibernationManager || !mainWindow || mainWindow.isDestroyed()) {
    return { success: false, error: 'not ready' };
  }
  for (const [sessionId, s] of sessions) {
    if (s.agentId === agentId) {
      const ok = await hibernationManager.wake(
        sessionId,
        (data) => { forwardOutput(sessionId, data); trackApprovals(sessionId, data); },
        (exitCode, signal) => {
          forwardOutput(sessionId, `\r\n[Process exited with code ${exitCode}]\r\n`);
        },
      );
      return { success: ok };
    }
  }
  return { success: false, error: 'agent not found' };
});

ipcMain.handle('get_resource_stats', async () => {
  if (!hibernationManager) return { total: 0, active: 0, hibernating: 0, sessions: [] };
  return hibernationManager.getStats();
});

ipcMain.handle('set_hibernation_enabled', async (_event, { enabled }) => {
  if (enabled) {
    if (!hibernationManager) {
      // Lazy start — manager was never auto-initialized
      startHibernationManager();
      console.log('[Hibernation] Started on demand');
    } else {
      hibernationManager.start();
      console.log('[Hibernation] Enabled');
    }
  } else {
    if (hibernationManager) {
      hibernationManager.stop();
      // Wake all sleeping sessions
      for (const [sessionId, s] of sessions) {
        if (s.hibernating && s.pty === null) {
          s.hibernating = false;
        }
      }
      console.log('[Hibernation] Disabled — all agents set active');
    }
  }
});

// ── IPC: Voice ────────────────────────────────────────────────────

ipcMain.handle('voice_is_ready', async () => {
  return voiceServer?.isReady() ?? false;
});

ipcMain.handle('voice_model_status', async () => {
  const modelsDir = path.join(__dirname, '../electron/voice-models');
  const parakeetDir = path.join(modelsDir, 'parakeet');
  const kokoroDir = path.join(modelsDir, 'kokoro');

  const status = {
    serverRunning: voiceServer?.isReady() ?? false,
    models: {
      parakeet: {
        present:
          fs.existsSync(path.join(parakeetDir, 'encoder.int8.onnx')) &&
          fs.existsSync(path.join(parakeetDir, 'decoder.int8.onnx')) &&
          fs.existsSync(path.join(parakeetDir, 'joiner.int8.onnx')) &&
          fs.existsSync(path.join(parakeetDir, 'tokens.txt')),
        path: parakeetDir,
      },
      kokoro: {
        present:
          fs.existsSync(path.join(kokoroDir, 'kokoro-v1.0.onnx')) &&
          fs.existsSync(path.join(kokoroDir, 'voices-v1.0.bin')),
        path: kokoroDir,
      },
      whisper: {
        // Whisper models are cached by faster-whisper in ~/.cache/huggingface/
        present: false, // can't easily check — will be downloaded on first use
        path: path.join(os.homedir(), '.cache', 'huggingface', 'hub'),
      },
    },
  };
  // Check whisper model directory
  const whisperCache = path.join(os.homedir(), '.cache', 'huggingface', 'hub');
  if (fs.existsSync(whisperCache)) {
    try {
      const dirs = fs.readdirSync(whisperCache);
      status.models.whisper.present = dirs.some((d) =>
        d.toLowerCase().includes('whisper')
      );
    } catch { /* ignore */ }
  }
  return status;
});

ipcMain.handle('voice_start_listening', async () => {
  if (!voiceServer?.isReady()) return;
  voiceServer.setCallbacks({
    onPartial: (text) => mainWindow?.webContents.send('voice_partial', text),
    onFinal: (text) => mainWindow?.webContents.send('voice_final', text),
    onAudio: (chunk) => mainWindow?.webContents.send('voice_audio', chunk),
    onStateChange: (state) => mainWindow?.webContents.send('voice_state', state),
    onError: (msg) => mainWindow?.webContents.send('voice_error', msg),
    onStatus: (msg) => mainWindow?.webContents.send('voice_status', msg),
  });
});

ipcMain.handle('voice_send_audio', async (_event, { data }) => {
  if (!data) return;
  voiceServer?.sendAudio(data);
});

ipcMain.handle('voice_stop_listening', async () => {
  voiceServer?.stopListening();
});

ipcMain.handle('voice_speak', async (_event, { id, text }) => {
  voiceServer?.speak(id, text);
});

ipcMain.handle('voice_speak_ack', async (_event, { id, phrase }) => {
  voiceServer?.speakAck(id, phrase);
});

ipcMain.handle('voice_interrupt', async () => {
  voiceServer?.interrupt();
});

ipcMain.handle('voice_configure', async (_event, { voice, speed }) => {
  voiceServer?.configure({ voice, speed });
  return { success: true };
});

// ── IPC: Agents ──────────────────────────────────────────────────

ipcMain.handle('register_agent', async (_event, { agent }) => {
  console.log('[IPC] register_agent:', agent.id, agent.name);
  return { success: true };
});

ipcMain.handle('remove_agent', async (_event, { agentId }) => {
  console.log('[IPC] remove_agent:', agentId);
  let removed = 0;
  for (const [id, s] of sessions) {
    if (s.agentId !== agentId) continue;
    destroySession(id, s);
    removed++;
  }
  return { success: true, removed };
});

/** Tear a session down completely: kill the PTY, finalise its DB row,
 *  drop its event-bus subscription, and remove the temp MCP config dir.
 *  Every removal path must go through here or processes leak. */
function destroySession(sessionId: string, session: PtySession): void {
  if (session.pty) {
    try { session.pty.kill(); } catch { /* already dead */ }
    session.pty = null;
  }
  sessions.delete(sessionId);
  delete sessionLineBuffers[sessionId];

  const fullOutput = session.buffer.join('');
  finaliseTerminal(sessionId, null, fullOutput);
  logAgentEvent(session.agentId, session.name, session.providerId, 'exited', 'removed');

  if (approvalTrackers.get(sessionId)?.pending) sendApproval(session.agentId, null);
  approvalTrackers.delete(sessionId);

  if (mcpServer) {
    mcpServer.eventBus.unsubscribe(session.agentId);
    mcpServer.mesh.unregister(session.agentId);
    mcpServer.recordAgentRemoved(session.agentId, session.name);
  }
  if (controllerPush.agentId === session.agentId) setController(null);

  console.log(`[PTY] Destroyed session ${sessionId} (${session.name})`);
}

ipcMain.handle('list_agents', async () => {
  return [];
});

/**
 * Type a prompt into an agent and submit it, as the user would.
 *
 * Text and Enter go in separate writes: a TUI that sees "text\r" arrive in
 * one chunk can take it for a paste and insert the newline instead of
 * submitting. A bare "\n" (what this used to send) is a newline, not
 * Enter, to Claude Code and Codex — so prompts were typed and never sent.
 */
function typeIntoAgent(sessionId: string, text: string): void {
  const session = sessions.get(sessionId);
  if (!session?.pty) return;
  noteApprovalInput(sessionId, text);
  session.pty.write(text.replace(/\r?\n/g, ' '));
  session.lastActivity = Date.now();
  setTimeout(() => {
    const s = sessions.get(sessionId);
    if (s?.pty) s.pty.write('\r');
  }, 120);
}

// ── Controller ────────────────────────────────────────────────────
// The user picks one agent to coordinate the rest. The MCP server gives it
// a controller brief, a live journal (orch_wait_for_events) and a sync
// footer on every reply. That keeps it current WHILE it is working; an
// idle controller sitting at its prompt makes no calls, so the events
// that need a decision are also typed into it as a one-line nudge — only
// once its terminal has been quiet for a while, never over the user's
// typing or an open permission prompt, and coalesced so a burst of events
// is one message.

/** Events worth interrupting an idle controller for. */
function pushworthy(e: SyncEvent): boolean {
  if (e.type === 'agent_status') {
    const phase = (e.data as { phase?: string } | undefined)?.phase;
    return phase === 'done' || phase === 'failed' || phase === 'blocked';
  }
  if (e.type === 'agent_message') return e.audience === controllerPush.agentId;
  return ['approval_pending', 'agent_exited', 'task_completed', 'task_failed', 'mcp_disconnected'].includes(e.type);
}

const CONTROLLER_QUIET_MS = 4000;
const CONTROLLER_MIN_GAP_MS = 10_000;

const controllerPush = {
  agentId: null as string | null,
  enabled: true,
  queue: [] as SyncEvent[],
  lastPush: 0,
  timer: null as ReturnType<typeof setTimeout> | null,
  unsubscribe: null as (() => void) | null,
};

function controllerSessionId(): string | undefined {
  for (const [sessionId, s] of sessions) if (s.agentId === controllerPush.agentId && s.pty) return sessionId;
  return undefined;
}

function scheduleControllerPush(delay: number) {
  if (controllerPush.timer) return;
  controllerPush.timer = setTimeout(flushControllerPush, delay);
}

function flushControllerPush() {
  controllerPush.timer = null;
  if (!controllerPush.agentId || !controllerPush.enabled || controllerPush.queue.length === 0) return;
  const sessionId = controllerSessionId();
  if (!sessionId) { controllerPush.queue = []; return; }
  const session = sessions.get(sessionId)!;
  const now = Date.now();
  const quietFor = now - session.lastActivity;
  const busy = quietFor < CONTROLLER_QUIET_MS || approvalTrackers.get(sessionId)?.pending;
  const tooSoon = now - controllerPush.lastPush < CONTROLLER_MIN_GAP_MS;
  if (busy || tooSoon) {
    scheduleControllerPush(Math.max(1000, busy ? CONTROLLER_QUIET_MS - quietFor : CONTROLLER_MIN_GAP_MS - (now - controllerPush.lastPush)));
    return;
  }
  // Drop what the controller already learned over MCP while it waited:
  // a controller looping on orch_wait_for_events must not be told again.
  const seen = mcpServer?.seenCursor(controllerPush.agentId) ?? 0;
  const events = controllerPush.queue.splice(0).filter((e) => e.seq > seen);
  if (events.length === 0) return;
  const shown = events.slice(-4).map((e) => e.summary).join('; ');
  const more = events.length > 4 ? ` (+${events.length - 4} more)` : '';
  const cursor = events[events.length - 1].seq;
  controllerPush.lastPush = now;
  typeIntoAgent(sessionId,
    `[ORCH sync] ${shown}${more}. As controller, decide what to do next; ` +
    `orch_wait_for_events { "cursor": ${cursor} } continues from here.`);
}

function setController(agentId: string | null, enabled = true): { success: boolean; error?: string } {
  if (agentId && ![...sessions.values()].some((s) => s.agentId === agentId)) {
    return { success: false, error: 'no such agent' };
  }
  const previous = controllerPush.agentId;
  controllerPush.agentId = agentId;
  controllerPush.enabled = enabled;
  controllerPush.queue = [];
  controllerPush.unsubscribe?.();
  controllerPush.unsubscribe = null;
  mcpServer?.setController(agentId);

  if (agentId && mcpServer) {
    controllerPush.unsubscribe = mcpServer.journal.onAppend((e) => {
      if (e.agentId === controllerPush.agentId || !pushworthy(e)) return;
      controllerPush.queue.push(e);
      scheduleControllerPush(1500);
    });
    // Brief it now, as the user's own instruction: its MCP instructions
    // were fixed when it connected, before it had the role.
    const sessionId = controllerSessionId();
    if (sessionId && agentId !== previous) {
      controllerPush.lastPush = Date.now();
      typeIntoAgent(sessionId,
        'You are now the ORCH controller: you coordinate the other agents on this canvas. ' +
        'Call orch_whoami for your brief, then orch_snapshot, and keep in sync with orch_wait_for_events.');
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('controller_changed', { agentId });
  }
  console.log(`[Controller] ${agentId ? `set to ${agentId}` : 'cleared'}`);
  return { success: true };
}

ipcMain.handle('controller_set', async (_event, { agentId, push }: { agentId: string | null; push?: boolean }) =>
  setController(typeof agentId === 'string' && agentId ? agentId : null, push !== false));

ipcMain.handle('controller_get', async () => ({ agentId: controllerPush.agentId, push: controllerPush.enabled }));

// Kept for the store's existing toggle, which predates a real controller.
ipcMain.handle('coordinator_start', async () => ({ success: true, controller: controllerPush.agentId }));
ipcMain.handle('coordinator_stop', async () => setController(null));

// ── IPC: Providers ───────────────────────────────────────────────

ipcMain.handle('list_provider_statuses', async (_event, { providers }) => {
  const results = [];
  for (const p of providers) {
    const resolved = await resolveCommand(p.command).catch(() => p.command);
    const available = resolved !== p.command || p.command === 'cmd.exe' || p.command === 'powershell.exe' || p.command === 'wsl.exe';
    results.push({
      provider: p.id,
      display_name: p.name,
      available,
      source: available ? 'system-fallback' : 'system-fallback',
      version: null,
      path: available ? resolved : null,
      error: available ? null : 'Not found in PATH',
    });
  }
  return results;
});

ipcMain.handle('probe_provider', async (_event, { providerId, displayName, command }) => {
  const resolved = await resolveCommand(command).catch(() => command);
  const available = resolved !== command
    || command === 'cmd.exe' || command === 'powershell.exe'
    || command === 'wsl.exe' || command === 'bash.exe';
  return {
    provider: providerId,
    display_name: displayName,
    available,
    source: 'system-fallback',
    version: null,
    path: available ? resolved : null,
    error: available ? null : 'Not found in PATH',
  };
});

/** The only packages ORCH will ever install, keyed by provider id. The
 *  renderer names a provider, never a package: this used to fall through
 *  to `npm install -g <whatever the renderer sent>` under `shell: true`,
 *  so any string reaching the IPC call was a shell command. */
const PROVIDER_PACKAGES: Record<string, string> = {
  'hermes': 'hermes-agent',
  'claude-code': '@anthropic-ai/claude-code',
  'opencode': 'opencode',
};

/** How to run npm without a shell. On Windows npm is a .cmd shim, and
 *  Node refuses to spawn .cmd files without `shell: true`, so run npm's
 *  own JS entry point with the node.exe installed beside it. */
async function npmInvocation(): Promise<{ file: string; prefixArgs: string[] } | null> {
  if (process.platform !== 'win32') return { file: 'npm', prefixArgs: [] };
  const resolved = await resolveCommand('npm').catch(() => 'npm');
  if (resolved === 'npm') return null;
  const dir = path.dirname(resolved);
  const node = path.join(dir, 'node.exe');
  const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(node) || !fs.existsSync(cli)) return null;
  return { file: node, prefixArgs: [cli] };
}

ipcMain.handle('install_provider', async (_event, { providerId }: { providerId: string }) => {
  if (providerId === 'codex') {
    // Codex uses npx so it auto-installs — mark as available
    return { success: true, message: 'Codex runs via npx — no install needed' };
  }
  const pkg = Object.hasOwn(PROVIDER_PACKAGES, providerId) ? PROVIDER_PACKAGES[providerId] : undefined;
  if (!pkg) {
    console.warn('[Install] Refused install for unknown provider:', String(providerId).slice(0, 40));
    return { success: false, message: `No installer for provider "${providerId}"` };
  }
  console.log(`[Install] Starting install for ${providerId} (${pkg})`);

  try {
    const npm = await npmInvocation();
    if (!npm) return { success: false, message: 'npm not found in PATH' };
    const child = spawn(npm.file, [...npm.prefixArgs, 'install', '-g', pkg], {
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      // Parse npm progress lines for percentage
      const progressMatch = text.match(/(\d+)\/(\d+)/);
      if (progressMatch) {
        const pct = Math.round((parseInt(progressMatch[1]) / parseInt(progressMatch[2])) * 100);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('install_progress', {
            providerId,
            phase: 'installing',
            percent: Math.min(pct, 99),
            message: text.trim().slice(0, 80),
          });
        }
      }
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    return new Promise((resolve) => {
      child.on('close', (code: number) => {
        const success = code === 0;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('install_progress', {
            providerId,
            phase: success ? 'done' : 'error',
            percent: success ? 100 : 0,
            message: success ? 'Install complete' : (stderr || 'Unknown error').trim().slice(0, 200),
          });
        }
        resolve({ success, message: success ? `${providerId} installed` : stderr.trim().slice(0, 200) });
      });
    });
  } catch (err: any) {
    return { success: false, message: err.message };
  }
});

// ── IPC: Canvas Assets ──────────────────────────────────────────

/** Persist a pasted or dropped asset and return a URL the renderer can load.
 *
 *  Returning only a filesystem path (as this used to) is useless to the
 *  renderer: `file://` is blocked for renderer content, so every dropped
 *  or pasted image silently failed to display and fell back to a generic
 *  file card. The orch-asset:// scheme resolves inside the asset store. */
ipcMain.handle('save_canvas_asset', async (_event, { data, ext }) => {
  try {
    const assetsDir = path.join(app.getPath('userData'), 'canvas_assets');
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

    const safeExt = String(ext || 'png').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'png';
    const name = `asset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.${safeExt}`;
    const filePath = path.join(assetsDir, name);
    await fs.promises.writeFile(filePath, Buffer.from(data, 'base64'));

    const stat = await fs.promises.stat(filePath);
    return {
      success: true,
      path: filePath,
      url: `orch-asset://${encodeURIComponent(name)}`,
      sizeBytes: stat.size,
      ext: safeExt,
    };
  } catch (err: any) {
    console.error('[Asset] save failed:', err);
    return { success: false, error: err?.message ?? String(err) };
  }
});

// ── IPC: MCP info ────────────────────────────────────────────────

ipcMain.handle('get-mcp-url', async () => {
  return mcpServer ? mcpServer.url : null;
});

// ── IPC: Terminal (node-pty) ─────────────────────────────────────

// ── Approvals ──────────────────────────────────────────────────

function sendApproval(agentId: string, pending: PendingApproval | null) {
  mcpServer?.recordApproval(agentId, pending);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('agent_approval', { agentId, pending });
  }
}

/** Press the CLI's own keys for a decision on the session's open prompt. */
function answerApproval(sessionId: string, decision: ApprovalDecision, by: 'user' | 'auto'): boolean {
  const tracker = approvalTrackers.get(sessionId);
  const session = sessions.get(sessionId);
  if (!tracker?.pending || !session?.pty) return false;
  const keys = approvalKeys(tracker.providerId, decision, tracker.pending.kind);
  if (!keys) return false;
  logAgentEvent(session.agentId, session.name, session.providerId,
    decision === 'approve' ? 'approved' : 'denied', `${by}: ${tracker.pending.detail}`);
  tracker.noteInput(keys);
  session.pty.write(keys);
  session.lastActivity = Date.now();
  sendApproval(tracker.agentId, null);
  return true;
}

function trackApprovals(sessionId: string, rawChunk: string) {
  const tracker = approvalTrackers.get(sessionId);
  const found = tracker?.feed(rawChunk);
  if (!tracker || !found) return;
  if (shouldAutoApprove(tracker.mode, found)) {
    // Let the TUI finish painting the prompt first: a key that arrives
    // mid-render can be dropped, leaving the agent waiting on nobody.
    setTimeout(() => {
      if (tracker.pending?.since === found.since && tracker.stillLive()) answerApproval(sessionId, 'approve', 'auto');
    }, 300);
    return;
  }
  sendApproval(tracker.agentId, found);
}

const isDecision = (d: unknown): d is ApprovalDecision => d === 'approve' || d === 'deny';
const isMode = (m: unknown): m is ApprovalMode => m === 'auto' || m === 'manual';

ipcMain.handle('approval_respond', async (_event, { agentId, decision }) => {
  if (!isDecision(decision)) return { success: false, error: 'bad decision' };
  for (const [sessionId, tracker] of approvalTrackers) {
    if (tracker.agentId === agentId && tracker.pending) {
      return { success: answerApproval(sessionId, decision, 'user') };
    }
  }
  return { success: false, error: 'nothing pending' };
});

ipcMain.handle('approval_set_mode', async (_event, { agentId, mode }) => {
  if (!isMode(mode)) return { success: false, error: 'bad mode' };
  let found = false;
  for (const [sessionId, tracker] of approvalTrackers) {
    if (tracker.agentId !== agentId) continue;
    found = true;
    tracker.mode = mode;
    // Switching to auto while a prompt is up is the user saying yes to it.
    if (tracker.pending && shouldAutoApprove(mode, tracker.pending)) answerApproval(sessionId, 'approve', 'user');
  }
  return { success: found };
});

ipcMain.handle('approval_list', async () =>
  [...approvalTrackers.values()].flatMap((t) => (t.pending ? [t.pending] : [])));

ipcMain.handle('create_terminal', async (_event, { agentId, name, command, args, env, kind, providerId, delegationDepth, contextSnapshot, cwd: requestedCwd, approvalMode }) => {
  const sessionId = `${agentId || name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  let shell = command || (process.platform === 'win32' ? 'cmd.exe' : '/bin/bash');
  // Agents keep their permission prompts so ORCH can put them to the user.
  // Stripped here, not in the provider list, because six call sites spawn
  // agents and older saved settings still carry the flag.
  let shellArgs = stripPermissionBypass(args || []);
  const shellEnv = env || undefined;

  if (process.platform === 'win32' && shell !== 'cmd.exe') {
    const resolved = await resolveCommand(shell);
    if (resolved !== shell) {
      shell = resolved;
      console.log(`[PTY] Resolved '${command || name}' → ${shell}`);
    }
    // On Windows, node-pty can only spawn .exe files directly.
    // .cmd, .bat, .ps1, and extensionless scripts must go through cmd.exe /c.
    if (!shell.toLowerCase().endsWith('.exe')) {
      console.log(`[PTY] Wrapping in cmd.exe /c (not a native .exe)`);
      shellArgs = ['/c', shell, ...shellArgs];
      shell = 'cmd.exe';
    }
  }

  try {
    // ── Working directory ─────────────────────────────────────
    // The agent MUST start in the user's workspace. Previously the MCP
    // config injection hijacked cwd: claude-code and hermes were launched
    // inside an empty temp directory (os.tmpdir()/orch-mcp/<session>), so
    // the agent could not see the project at all, and every other provider
    // fell back to process.cwd() — which is Electron's own directory and
    // only looked correct because ORCH happened to be running from the
    // repo it was working on.
    const mcpUrl = mcpServer?.url || '';

    // Registration has to land BEFORE the CLI starts — it reads its
    // config at launch. This used to fire two seconds AFTER spawn, so
    // the server was only ever picked up by the NEXT agent of that type.
    // Capped so a CLI that stalls on the handshake delays the spawn
    // rather than blocking it.
    if (CLI_REGISTERED_PROVIDERS.includes(providerId)) {
      await Promise.race([
        ensureAgentMcpRegistered(providerId),
        new Promise((r) => setTimeout(r, 6000)),
      ]);
    }

    const cwd = resolveAgentCwd(requestedCwd);
    const preamble = getMcpPreamble(providerId, mcpUrl, name, agentId || name);

    // Point this launch at the live MCP endpoint, carrying the agent's
    // identity. Appended last so a user-supplied arg cannot be separated
    // from its flag.
    const extraArgs = mcpLaunchArgs(
      providerId,
      mcpServer?.streamUrlNoToken || '',
      mcpServer?.token || '',
      agentId || name,
    );
    const mcpEnv = mcpLaunchEnv(
      providerId,
      mcpServer?.streamUrlNoToken || '',
      mcpServer?.token || '',
      agentId || name,
    );
    if (extraArgs.length > 0) {
      shellArgs = [...shellArgs, ...extraArgs];
      console.log(`[MCP] ${providerId}: injected MCP config for this launch`);
    }

    const p = getPty();
    const ptyProcess = p.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: 140,
      rows: 40,
      cwd,
      env: {
        ...process.env,
        ...shellEnv,
        COLORTERM: 'truecolor',
        TERM: 'xterm-256color',
        // Every mesh tool is keyed by agent id. Without this the agent
        // has no way to identify itself and agent_set_status / agent_send
        // are unusable from inside the terminal.
        ORCH_AGENT_ID: agentId || name,
        ORCH_AGENT_NAME: name,
        ORCH_SESSION_ID: sessionId,
        ORCH_MCP_URL: mcpServer?.url || '',
        // Codex and Hermes read the bearer token from here rather than
        // from a config file, so no credential is written to disk.
        ORCH_MCP_TOKEN: mcpServer?.token || '',
        // Per-agent endpoint (ORCH_MCP_HTTP_URL) and, for OpenCode, its
        // inline config.
        ...mcpEnv,
      },
    });

    const session: PtySession = {
      pty: ptyProcess,
      agentId: agentId || name,
      name,
      kind: kind || 'shell',
      buffer: [],
      createdAt: Date.now(),
      lastActivity: Date.now(),
      hibernating: false,
      shell,
      shellArgs,
      shellEnv,
      providerId: providerId || '',
      delegationDepth: delegationDepth || 0,
      contextSnapshot: contextSnapshot || JSON.stringify({}),
    };

    // Banner for the USER, not the agent.
    //
    // forwardOutput writes to the xterm view only — a CLI agent never
    // reads what is painted on its own display, so this cannot brief the
    // agent. Agents discover ORCH's tools through MCP tool descriptions,
    // which is the channel that actually reaches a model's context.
    if (preamble) {
      forwardOutput(sessionId, preamble);
      queuedPreambles.set(sessionId, preamble);
    }

    ptyProcess.onData((rawChunk: string) => {
      session.lastActivity = Date.now();
      // Byte-exact capture first, before any cap or transform can lose it.
      appendSessionLog(sessionId, rawChunk);
      session.buffer.push(rawChunk);
      if (session.buffer.length > MAX_BUF_LINES) {
        session.buffer.splice(0, session.buffer.length - MAX_BUF_LINES);
      }
      // ── Track buffer in local DB ──────────────────────────
      const chunkLines = rawChunk.split('\n');
      updateTerminalBuffer(sessionId, rawChunk.length, chunkLines.length - 1, rawChunk.slice(-200));
      // Forward raw output to UI immediately (renders ANSI for the terminal emulator)
      forwardOutput(sessionId, rawChunk);
      trackApprovals(sessionId, rawChunk);

      // ── Cleaned event bus emission (line-buffered, ANSI-stripped) ──
      if (!mcpServer) return;

      // Strip ANSI escape codes
      const clean = rawChunk.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

      // Append to per-session line buffer (resolves chunk fragmentation)
      sessionLineBuffers[sessionId] = (sessionLineBuffers[sessionId] || '') + clean;

      // Extract complete lines, keep partial tail in buffer
      const lines = sessionLineBuffers[sessionId].split('\n');
      sessionLineBuffers[sessionId] = lines.pop() || '';

      // Emit one event per complete line
      for (const line of lines) {
        const trimmed = line.replace(/\r/g, '').trim();
        if (trimmed) {
          mcpServer.eventBus.emit('terminal_line', session.agentId, {
            sessionId,
            data: trimmed.slice(0, 1000),
            lineCount: session.buffer.length,
          });

          // ── 2. Auto-routing: if line mentions another agent by name, notify ──
          // SAFE: emit via EventBus + IPC (NOT pty.write which causes echo loops)
          const lowerLine = trimmed.toLowerCase();
          // Skip forwarded/injected messages to prevent echo loops
          if (trimmed.startsWith('[Orch]')) continue;
          for (const [otherId, otherSession] of sessions) {
            if (otherId === sessionId) continue;
            const otherName = otherSession.name.toLowerCase();
            if (lowerLine.includes(otherName) && lowerLine.length < 200) {
              mcpServer.eventBus.emit('agent_notification', session.agentId, {
                from: session.name,
                fromAgentId: session.agentId,
                to: otherSession.name,
                toAgentId: otherId,
                message: trimmed.slice(0, 300),
              }, otherId);
              // Also notify the frontend UI via IPC
              const notif = `[Orch] ${session.name} mentioned ${otherSession.name}: ${trimmed.slice(0, 100)}`;
              if (mainWindow) {
                mainWindow.webContents.send('agent_notification', {
                  type: 'mention',
                  from: session.name,
                  to: otherSession.name,
                  text: trimmed.slice(0, 300),
                });
              }
            }
          }
        }
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`[PTY] Session ${sessionId} exited (code=${exitCode}, signal=${signal})`);
      sessions.delete(sessionId);
      if (approvalTrackers.get(sessionId)?.pending) sendApproval(session.agentId, null);
      approvalTrackers.delete(sessionId);
      mcpServer?.recordAgentExit(session.agentId, exitCode ?? null);
      // Flush any remaining line buffer
      if (mcpServer && sessionLineBuffers[sessionId]?.trim()) {
        mcpServer.eventBus.emit('terminal_line', session.agentId, {
          sessionId,
          data: sessionLineBuffers[sessionId].trim().slice(0, 1000),
          lineCount: session.buffer.length,
        });
      }
      delete sessionLineBuffers[sessionId];
      closeSessionLog(sessionId);
      // Emit exit event
      if (mcpServer) {
        mcpServer.eventBus.emit('terminal_exit', session.agentId, {
          sessionId,
          exitCode,
          signal,
        });
        // ── 3. Agent summary: store episodic memory on exit ──
        const fullOutput = session.buffer.join('').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim().slice(0, 5000);
        if (fullOutput) {
          // Auto-detect intent from first meaningful line
          const lines = fullOutput.split('\n').filter(l => l.trim() && !l.startsWith('['));
          const firstCmd = lines.find(l => l.startsWith('$') || l.includes('--')) || lines[0] || 'unknown task';
          const intent = firstCmd.slice(0, 120);
          // Check for error keywords
          const hasErrors = /\berror\b|\bfailed\b|\bexception\b|\btraceback\b/i.test(fullOutput);
          // Extract file paths from output (crude regex)
          const fileMatches = fullOutput.match(/(?:^|\s)(?:\.\/|\.\.\/|\/|[a-zA-Z]:\\)[\w.\-/\\]+/gm) || [];
          const mutatedFiles = [...new Set(fileMatches.map(f => f.trim()).filter(f => f.length > 2))].slice(0, 10);
          // Extract error messages
          const errorMatches = fullOutput.match(/(?:Error|error|ERROR|Failed|failed|FAILED|Exception|exception)[^.\n]*/g) || [];
          const errors = errorMatches.slice(0, 5).map(e => e.trim());

          mcpServer.artifactRegistry.storeMemory(
            session.agentId,
            intent,
            hasErrors ? 'failure' : (exitCode === 0 ? 'success' : 'failure'),
            mutatedFiles,
            errors,
            [session.providerId || 'agent', session.name.toLowerCase()],
            session.delegationDepth || 0,
            { output: fullOutput.slice(0, 3000), exitCode, signal, duration: Date.now() - session.createdAt },
          );
        }
      }
      forwardOutput(sessionId, `
\n[Process exited with code ${exitCode}]
\n`);
      // ── Finalise terminal in local DB ────────────────
      const fullOutput = session.buffer.join('');
      finaliseTerminal(sessionId, exitCode, fullOutput);
      logAgentEvent(session.agentId, session.name, session.providerId, 'exited', `exitCode=${exitCode}`);
    });

    sessions.set(sessionId, session);
    approvalTrackers.set(sessionId, new ApprovalTracker(
      session.agentId, name, session.providerId, isMode(approvalMode) ? approvalMode : 'manual',
    ));
    openSessionLog(sessionId);
    // The banner was emitted before the log existed; record it now so the
    // transcript matches what the user actually saw.
    const queued = queuedPreambles.get(sessionId);
    if (queued) {
      appendSessionLog(sessionId, queued);
      queuedPreambles.delete(sessionId);
    }
    mcpServer?.mesh.register(session.agentId, session.name, session.providerId);
    console.log(`[PTY] Created session ${sessionId} (shell=${shell})`);

    // ── Record terminal start in local DB ──────────────
    recordTerminalStart(sessionId, session.agentId, session.name, session.providerId);
    logAgentEvent(session.agentId, session.name, session.providerId, 'spawned', shell);

    // ── 1. Auto-subscribe this agent to other agents' terminal events ──
    if (mcpServer) {
      mcpServer.eventBus.subscribe(session.agentId, ['terminal_line', 'terminal_exit']);
      mcpServer.eventBus.emit('agent_created', session.agentId, {
        sessionId,
        name: session.name,
        providerId: session.providerId,
      });
    }

    return sessionId;
  } catch (err) {
    console.error(`[PTY] Failed to create terminal:`, err);
    throw err;
  }
});

ipcMain.handle('interrupt_agent', async (_event, { agentId }) => {
  // Send SIGINT (Ctrl+C = \x03) to the agent's PTY
  let interrupted = false;
  for (const [sessionId, session] of sessions) {
    if (session.agentId === agentId && session.pty) {
      noteApprovalInput(sessionId, '\x03');
      session.pty.write('\x03');
      session.lastActivity = Date.now();
      interrupted = true;
      console.log(`[BargeIn] Interrupted agent ${session.name} (${agentId})`);
      break;
    }
  }
  return { success: interrupted, agentId };
});

ipcMain.handle('write_terminal', async (_event, { sessionId, data }) => {
  const session = sessions.get(sessionId);
  // Writing to a dead session is an ordinary race (the user types as the
  // agent exits), not an exceptional condition. Throwing here logged a
  // stack trace in the main process for something entirely routine.
  if (!session) return { success: false, reason: 'no-session' };
  // Touch activity — prevents auto-hibernation while user is typing
  if (session.pty) {
    session.lastActivity = Date.now();
    noteApprovalInput(sessionId, data);
    session.pty.write(data);
  }
  return { success: true };
});

/** Typing into the terminal answers an open prompt the usual way; take it
 *  off the card so the card never offers to answer it a second time. */
function noteApprovalInput(sessionId: string, data: string) {
  const tracker = approvalTrackers.get(sessionId);
  if (tracker?.noteInput(data)) sendApproval(tracker.agentId, null);
}

/** Raw scrollback for terminal restore.
 *
 *  Returns a single verbatim string, not an array of lines. The previous
 *  implementation did `buffer.join('').split('\n').slice(-200)`, which
 *  both truncated to 200 lines and destroyed lone carriage returns — the
 *  mechanism every progress bar, spinner and TUI redraw relies on — so a
 *  restored terminal showed mangled output. */
ipcMain.handle('read_terminal', async (_event, { sessionId, maxBytes }) => {
  return readSessionTail(sessionId, typeof maxBytes === 'number' ? maxBytes : undefined);
});

// ── IPC: Session transcripts ─────────────────────────────────────

ipcMain.handle('transcript_read', async (_event, { sessionId, offset, length }) => {
  return readSessionRange(sessionId, offset ?? 0, length);
});

ipcMain.handle('transcript_full', async (_event, { sessionId, plain }) => {
  const text = readSessionFull(sessionId);
  return plain ? stripAnsi(text) : text;
});

ipcMain.handle('transcript_search', async (_event, { sessionId, query, caseSensitive, regex, limit }) => {
  return searchSessionLog(sessionId, query, { caseSensitive, regex, limit });
});

ipcMain.handle('transcript_stats', async (_event, { sessionId }) => {
  return sessionLogStats(sessionId);
});

ipcMain.handle('transcript_list', async () => listSessionLogs());

ipcMain.handle('transcript_dir', async () => getTranscriptDir());

ipcMain.handle('transcript_export', async (_event, { sessionId, plain }) => {
  if (!mainWindow) return { success: false, error: 'no window' };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export terminal transcript',
    defaultPath: `orch-${sessionId}-${stamp}.${plain ? 'txt' : 'log'}`,
    filters: plain
      ? [{ name: 'Text', extensions: ['txt'] }]
      : [{ name: 'Raw terminal log', extensions: ['log'] }],
  });
  if (result.canceled || !result.filePath) return { success: false, canceled: true };
  try {
    const text = readSessionFull(sessionId);
    fs.writeFileSync(result.filePath, plain ? stripAnsi(text) : text, 'utf-8');
    return { success: true, path: result.filePath };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('close_terminal', async (_event, { sessionId }) => {
  const session = sessions.get(sessionId);
  if (session) {
    if (session.pty) {
      try { session.pty.kill(); } catch { /* already dead */ }
    }
    // Finalise if not already done
    const fullOutput = session.buffer.join('');
    finaliseTerminal(sessionId, null, fullOutput);
    sessions.delete(sessionId);
    console.log(`[PTY] Closed session ${sessionId}`);
  }
  return { success: true };
});

ipcMain.handle('resize_terminal', async (_event, { sessionId, cols, rows }) => {
  const session = sessions.get(sessionId);
  if (!session?.pty) return { success: false, reason: 'no-session' };
  // A ResizeObserver can fire after the shell has exited but before the
  // renderer has torn the terminal down, and node-pty throws rather than
  // no-oping ("Cannot resize a pty that has already exited").
  try {
    session.pty.resize(Math.max(1, cols), Math.max(1, rows));
  } catch {
    return { success: false, reason: 'exited' };
  }
  recordSessionEvent('window_resize', { sessionId, cols, rows });
  return { success: true };
});

ipcMain.handle('list_terminals', async () => {
  return Array.from(sessions.entries()).map(([id, s]) => ({
    id,
    name: s.name,
    agentId: s.agentId,
    cols: s.pty ? s.pty.cols : 140,
    rows: s.pty ? s.pty.rows : 40,
    status: s.hibernating ? ('sleeping' as const) : ('running' as const),
  }));
});

// ── IPC: Workspace (Folder-Centric) ──────────────────────────────

ipcMain.handle('workspace_select_folder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select or Create Workspace Folder',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('workspace_write_file', async (_event, { workspacePath, data }) => {
  const filePath = path.join(workspacePath, '.orch-workspace.json');
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return { success: true, filePath };
});

ipcMain.handle('workspace_read_file', async (_event, { workspacePath }) => {
  const filePath = path.join(workspacePath, '.orch-workspace.json');
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content);
});

ipcMain.handle('workspace_get_recent', async () => {
  const recentPath = path.join(app.getPath('userData'), 'recent-workspaces.json');
  if (!fs.existsSync(recentPath)) return [];
  const content = fs.readFileSync(recentPath, 'utf-8');
  return JSON.parse(content);
});

ipcMain.handle('workspace_save_recent', async (_event, { workspaces }) => {
  const recentPath = path.join(app.getPath('userData'), 'recent-workspaces.json');
  const dir = path.dirname(recentPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(recentPath, JSON.stringify(workspaces, null, 2), 'utf-8');
  return { success: true };
});

ipcMain.handle('workspace_exists', async (_event, { workspacePath }) => {
  const filePath = path.join(workspacePath, '.orch-workspace.json');
  return fs.existsSync(filePath);
});

// ── IPC: Voice ───────────────────────────────────

ipcMain.handle('toggle_voice', async () => {
  console.log('[IPC] toggle_voice');
  return 'toggled';
});

// ── IPC: Browser ──────────────────────────────────────────────────

ipcMain.handle('browser_navigate', async (_event, { id, url }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(`browser_nav_${id}`, url);
  }
  return { success: true };
});

ipcMain.handle('browser_go_back', async (_event, { id }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(`browser_back_${id}`, true);
  }
  return { success: true };
});

ipcMain.handle('browser_go_forward', async (_event, { id }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(`browser_fwd_${id}`, true);
  }
  return { success: true };
});

ipcMain.handle('browser_refresh', async (_event, { id }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(`browser_refresh_${id}`, true);
  }
  return { success: true };
});

// ── IPC: Music Player (YouTube / SoundCloud via play-dl) ────────

ipcMain.handle('music_resolve_url', async (_event, { url }) => {
  try {
    const playdl = require('play-dl');
    // Try YouTube first
    const isSc = url.includes('soundcloud.com');
    if (!isSc) {
      try {
        const resolved = await playdl.video_info(url);
        const info = resolved.video_details;
        const stream = await playdl.stream(url, { quality: 0 }).catch(() => null);
        return {
          success: true,
          data: {
            title: info.title,
            duration: info.durationInSec,
            thumb: info.thumbnails[info.thumbnails.length - 1]?.url || '',
            channel: info.channel?.name || '',
            url: stream?.url || '',
            source: 'youtube' as const,
          },
        };
      } catch {
        // fall through to SoundCloud attempt
      }
    }
    // SoundCloud
    const scInfo = await playdl.soundcloud(url);
    const stream = await playdl.stream(url, { quality: 0 }).catch(() => null);
    return {
      success: true,
      data: {
        title: scInfo.name,
        duration: scInfo.durationInSec || 0,
        thumb: scInfo.thumbnail || '',
        channel: scInfo.user?.name || '',
        url: stream?.url || '',
        source: 'soundcloud' as const,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message || 'Failed to resolve' };
  }
});

ipcMain.handle('music_search', async (_event, { query, source }) => {
  try {
    const playdl = require('play-dl');
    const isSc = source === 'soundcloud';
    const so = isSc ? { soundcloud: 'tracks' as const } : { youtube: 'video' as const };
    const results = await playdl.search(query, { limit: 10, source: so });
    const tracks = results.map((r: any) => {
      if (isSc) {
        return {
          id: String(r.id),
          title: r.name,
          duration: r.durationInSec || 0,
          thumb: r.thumbnail || '',
          channel: r.user?.name || '',
          url: r.url || r.permalink || '',
          source: 'soundcloud' as const,
        };
      }
      return {
        id: r.id,
        title: r.title,
        duration: r.durationInSec || 0,
        thumb: r.thumbnails?.[r.thumbnails.length - 1]?.url || '',
        channel: r.channel?.name || '',
        url: r.url,
        source: 'youtube' as const,
      };
    });
    return { success: true, data: tracks };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('music_playlist', async (_event, { url }) => {
  try {
    const playdl = require('play-dl');
    const playlist = await playdl.playlist_info(url, { incomplete: true });
    const tracks = await playlist.all_videos();
    const items = tracks.map((v: any) => ({
      id: v.id,
      title: v.title,
      duration: v.durationInSec || 0,
      thumb: v.thumbnails?.[v.thumbnails.length - 1]?.url || '',
      channel: v.channel?.name || '',
      url: v.url,
      source: 'youtube' as const,
    }));
    return { success: true, data: { title: playlist.title || 'Playlist', tracks: items }, type: 'playlist' };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('music_stream_url', async (_event, { url }) => {
  try {
    const playdl = require('play-dl');
    const stream = await playdl.stream(url, { quality: 0 });
    return { success: true, data: { url: stream.url, type: stream.type || 'audio' } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('music_sc_auth_url', async () => {
  // SoundCloud OAuth — return the authorization URL
  const clientId = 'YOUR_SOUNDCLOUD_CLIENT_ID'; // Replace or use env
  const redirectUri = 'orch://soundcloud/callback';
  const url = `https://soundcloud.com/connect?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=non-expiring`;
  return { success: true, data: { authUrl: url } };
});

ipcMain.handle('music_sc_auth_token', async (_event, { code }) => {
  try {
    const playdl = require('play-dl');
    // Exchange code for token
    const token = await playdl.soundcloud_token(code);
    return { success: true, data: { token } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('music_sc_user', async (_event, { token }) => {
  try {
    const playdl = require('play-dl');
    const sc = await playdl.soundcloud(token);
    const me = await sc.getMe();
    return { success: true, data: { id: me.id, username: me.username, avatar: me.avatar_url } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// ── IPC: Window controls ─────────────────────────────────────────

ipcMain.handle('window_minimize', () => mainWindow?.minimize());
ipcMain.handle('window_maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.handle('window_close', () => mainWindow?.close());

// ── IPC: Local Database ──────────────────────────────────────────

// ── IPC: Diagnostics ─────────────────────────────────────────────

ipcMain.handle('diagnostics_list', async (_event, { limit }) => listCrashReports(limit ?? 20));

ipcMain.handle('diagnostics_clear', async () => ({ cleared: clearCrashReports() }));

ipcMain.handle('diagnostics_dir', async () => getCrashReportsDir());

ipcMain.handle('diagnostics_open_dir', async () => {
  await shell.openPath(getCrashReportsDir());
  return { success: true };
});

/** Renderer-side errors (ErrorBoundary, window.onerror) land here so the
 *  main process is the single place crash history lives. */
ipcMain.handle('diagnostics_report', async (_event, { message, stack, context }) => {
  const err = new Error(String(message ?? 'Renderer error'));
  err.stack = stack;
  const report = recordCrash('renderer-error', err, context);
  return { success: true, id: report?.id };
});

ipcMain.handle('local_db_get_stats', async () => {
  return getLocalStats();
});

ipcMain.handle('local_db_get_path', async () => {
  return getDbPath();
});

// Terminal History
ipcMain.handle('local_db_record_terminal_start', async (_event, { sessionId, agentId, name, providerId }) => {
  recordTerminalStart(sessionId, agentId, name, providerId);
  return { success: true };
});

ipcMain.handle('local_db_update_terminal_buffer', async (_event, { sessionId, charCount, lineCount, lastChunk }) => {
  updateTerminalBuffer(sessionId, charCount, lineCount, lastChunk);
  return { success: true };
});

ipcMain.handle('local_db_finalise_terminal', async (_event, { sessionId, exitCode, fullBuffer }) => {
  finaliseTerminal(sessionId, exitCode, fullBuffer);
  return { success: true };
});

ipcMain.handle('local_db_list_terminal_history', async (_event, { limit }) => {
  return listTerminalHistory(limit ?? 50);
});

// Agent Logs
ipcMain.handle('local_db_log_agent_event', async (_event, { agentId, name, providerId, event, detail }) => {
  logAgentEvent(agentId, name, providerId, event, detail);
  return { success: true };
});

ipcMain.handle('local_db_list_agent_logs', async (_event, { agentId, limit }) => {
  return listAgentLogs(agentId, limit ?? 50);
});

// Session Events
ipcMain.handle('local_db_record_session_event', async (_event, { type, data }) => {
  recordSessionEvent(type, data);
  return { success: true };
});

ipcMain.handle('local_db_list_session_events', async (_event, { type, limit }) => {
  return listSessionEvents(type, limit ?? 30);
});

// Workspaces (local)
ipcMain.handle('local_db_upsert_workspace', async (_event, { id, data }) => {
  upsertLocalWorkspace(id, data);
  return { success: true };
});

ipcMain.handle('local_db_list_workspaces', async () => {
  return listLocalWorkspaces();
});

ipcMain.handle('local_db_delete_workspace', async (_event, { id }) => {
  deleteLocalWorkspace(id);
  return { success: true };
});

// Settings (local)
ipcMain.handle('local_db_save_settings', async (_event, { settings }) => {
  saveLocalSettings(settings);
  return { success: true };
});

ipcMain.handle('local_db_get_settings', async () => {
  return getLocalSettings();
});

// ── Auto-Updater ───────────────────────────────────────────────────
// Checks public GitHub releases for new desktop versions. The
// frontend uses `check-for-updates` on startup (silent) and
// `trigger-update` when the user clicks "Install update".

autoUpdater.autoDownload = false;           // we control the download
autoUpdater.autoInstallOnAppQuit = true;    // install on graceful exit

autoUpdater.on('update-available', (info) => {
  const version = info.version;
  console.log(`[Updater] Update v${version} available`);
  mainWindow?.webContents.send('update-status', {
    status: 'available',
    version,
    percent: 0,
  });
});

autoUpdater.on('download-progress', (progress) => {
  const percent = Math.round(progress.percent);
  mainWindow?.webContents.send('update-status', {
    status: 'downloading',
    version: null,
    percent,
  });
});

autoUpdater.on('update-downloaded', (info) => {
  console.log(`[Updater] v${info.version} downloaded — ready to install`);
  mainWindow?.webContents.send('update-status', {
    status: 'ready',
    version: info.version,
    percent: 100,
  });
});

autoUpdater.on('error', (err) => {
  console.warn('[Updater] Error:', err.message?.slice(0, 120));
  mainWindow?.webContents.send('update-status', {
    status: 'idle',
    version: null,
    percent: 0,
  });
});

// ── IPC: Frontend triggers ────────────────────────────────────────

ipcMain.handle('check-for-updates', async () => {
  try {
    mainWindow?.webContents.send('update-status', {
      status: 'checking', version: null, percent: 0,
    });
    const result = await autoUpdater.checkForUpdates();
    if (!result || !result.updateInfo) {
      // No update found — back to idle
      mainWindow?.webContents.send('update-status', {
        status: 'idle', version: null, percent: 0,
      });
    }
    return { success: true, updateInfo: result?.updateInfo || null };
  } catch (err: any) {
    console.warn('[Updater] check failed:', err.message?.slice(0, 120));
    mainWindow?.webContents.send('update-status', {
      status: 'idle', version: null, percent: 0,
    });
    return { success: false, error: err.message };
  }
});

ipcMain.handle('trigger-update', async () => {
  try {
    mainWindow?.webContents.send('update-status', {
      status: 'downloading', version: null, percent: 0,
    });
    await autoUpdater.downloadUpdate();
    // download triggers update-downloaded which sends 'ready'
    return { success: true };
  } catch (err: any) {
    console.warn('[Updater] download failed:', err.message?.slice(0, 120));
    mainWindow?.webContents.send('update-status', {
      status: 'idle', version: null, percent: 0,
    });
    return { success: false, error: err.message };
  }
});

// ── Custom Protocol (orch://) for OAuth callbacks ────────────────
// Registers the orch:// scheme so Google OAuth can redirect back
// to the desktop app after authentication.

const ORCH_PROTOCOL = 'orch';

if (!app.isPackaged) {
  // Dev mode: register on first instance only
  app.setAsDefaultProtocolClient(ORCH_PROTOCOL);
} else {
  // Production: register after app is ready
  app.setAsDefaultProtocolClient(ORCH_PROTOCOL);
}

// Handle protocol URL on Windows (second-instance event)
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // Windows sends protocol URLs as command-line args to the second instance
    const url = argv.find((arg) => arg.startsWith(`${ORCH_PROTOCOL}://`));
    if (url) handleAuthCallback(url);
    // Focus the existing window
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// Handle protocol URL on macOS
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (url.startsWith(`${ORCH_PROTOCOL}://`)) {
    handleAuthCallback(url);
  }
});

/** Extract auth code from orch://auth/callback?code=... and forward to renderer */
function handleAuthCallback(url: string) {
  try {
    const parsed = new URL(url);
    const code = parsed.searchParams.get('code');
    if (code && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('orch-auth-callback', { code });
    }
  } catch (err) {
    console.warn('[Auth] Failed to parse callback URL:', url);
  }
}

// ── IPC: Open system browser for OAuth ────────────────────────────
// openExternal hands the URL to the OS, which will happily launch file:,
// UNC paths and any registered protocol handler. OAuth only ever needs
// https, so refuse everything else.
ipcMain.handle('open-auth-url', async (_event, { url }: { url: string }) => {
  try {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return { success: false, error: 'Invalid URL' }; }
    if (parsed.protocol !== 'https:') {
      console.warn('[Security] Blocked open-auth-url for non-https URL:', String(url).slice(0, 80));
      return { success: false, error: 'Only https URLs are allowed' };
    }
    await shell.openExternal(parsed.toString());
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// ── App lifecycle ────────────────────────────────────────────────

// Installed before anything else can throw.
installDiagnostics(() => mainWindow);

// Agent-produced images and videos are served over a dedicated scheme
// rather than file://. file:// is blocked for renderer content, and
// disabling webSecurity to allow it would expose the whole filesystem to
// anything running in the renderer. This scheme resolves ONLY inside the
// app's own canvas_assets directory.
protocol.registerSchemesAsPrivileged([
  { scheme: 'orch-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false } },
]);

app.whenReady().then(() => {
  // ── Serve canvas assets ────────────────────────────────
  protocol.handle('orch-asset', async (request) => {
    try {
      const name = decodeURIComponent(new URL(request.url).hostname || '');
      // Reject anything with a path separator: the asset store is flat,
      // and a name like "..%2F..%2Fsecrets" must not escape it.
      if (!name || /[/\\]/.test(name) || name.includes('..')) {
        return new Response('Bad asset name', { status: 400 });
      }
      const dir = path.join(app.getPath('userData'), 'canvas_assets');
      const file = path.join(dir, name);
      // Belt and braces: confirm the resolved path is still inside the store.
      if (!path.resolve(file).startsWith(path.resolve(dir))) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!fs.existsSync(file)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    } catch (err) {
      console.error('[Asset] serve failed:', err);
      return new Response('Error', { status: 500 });
    }
  });

  // ── Initialise local database ──────────────────────────
  initLocalDb();
  pruneSessionLogs();

  createWindow();
  // Start voice server
  voiceServer = new VoiceServer();
  voiceServer.setCallbacks({
    onPartial: (text) => mainWindow?.webContents.send('voice_partial', text),
    onFinal: (text) => mainWindow?.webContents.send('voice_final', text),
    onAudio: (chunk) => mainWindow?.webContents.send('voice_audio', chunk),
    onStateChange: (state) => mainWindow?.webContents.send('voice_state', state),
    onError: (msg) => mainWindow?.webContents.send('voice_error', msg),
    onStatus: (msg) => mainWindow?.webContents.send('voice_status', msg),
  });
  voiceServer.start();

  console.log('[Main] ORCH ready — local-only mode');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('will-quit', () => {
  voiceServer?.stop();
  for (const [id, s] of sessions) {
    if (s.pty) { try { s.pty.kill(); } catch { /* already dead */ } }
    const fullOutput = s.buffer.join('');
    finaliseTerminal(id, null, fullOutput);
  }
  sessions.clear();
  if (hibernationManager) hibernationManager.stop();
  mcpServer?.stop();
  unregisterAgentMcp();
  // The store is flushed on a debounce; force the final write before exit
  // or the last few seconds of session history are lost.
  flushLocalDb();
  flushSessionLogs();
});
