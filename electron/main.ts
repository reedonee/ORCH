import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { autoUpdater } from 'electron-updater';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import { OrchMcpServer } from './mcp-server.js';
import { VoiceServer } from './voice-server.js';
import {
  initLocalDb, getDbPath,
  recordTerminalStart, updateTerminalBuffer, finaliseTerminal, listTerminalHistory,
  logAgentEvent, listAgentLogs,
  recordSessionEvent, listSessionEvents,
  upsertLocalWorkspace, listLocalWorkspaces, deleteLocalWorkspace,
  saveLocalSettings, getLocalSettings,
  getLocalStats, resetLocalDb,
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

// PtySession type now lives in hibernation.ts — re-exported for convenience
import { HibernationManager } from './hibernation.js';
import type { PtySession } from './hibernation.js';

const sessions = new Map<string, PtySession>();
const MAX_BUF_LINES = 2000;

let mcpServer: OrchMcpServer | null = null;
let hibernationManager: HibernationManager | null = null;
let voiceServer: VoiceServer | null = null;

function getPty(): typeof import('node-pty') {
  if (!pty) {
    pty = require('node-pty');
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

// ── MCP Agent Config Injection ────────────────────────────────
// Writes temp config files so spawned agents auto-discover the
// ORCH MCP server (SSE transport) without manual setup.

function writeMcpAgentConfig(providerId: string, mcpUrl: string, sessionId: string): string | null {
  if (!mcpUrl) return null;
  const dir = path.join(os.tmpdir(), 'orch-mcp', sessionId);

  switch (providerId) {
    case 'claude-code':
    case 'hermes': {
      // Claude Code reads .claude/settings.json from the cwd or parent dirs
      // Hermes also supports a project-level config
      const configDir = path.join(dir, '.claude');
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(
        path.join(configDir, 'settings.json'),
        JSON.stringify({
          mcpServers: {
            orch: { url: mcpUrl },
          },
        }, null, 2),
        'utf-8',
      );
      console.log(`[MCP] Wrote agent config for ${providerId} → ${path.join(configDir, 'settings.json')}`);
      return dir;
    }
    default:
      return null;
  }
}

function getMcpPreamble(providerId: string, mcpUrl: string): string {
  if (!mcpUrl) return '';
  const url = mcpUrl.replace('/sse', '');
  if (providerId === 'opencode') {
    return `\r\n\x1b[33m⚡ ORCH MCP: ${mcpUrl}\x1b[0m\r\n\x1b[33m  Registered ORCH canvas tools. Use canvas_send_message to talk to other agents.\x1b[0m\r\n`;
  }
  if (providerId === 'hermes') {
    return `\r\n\x1b[33m⚡ ORCH MCP: ${mcpUrl}\x1b[0m\r\n\x1b[33m  Registered ORCH canvas tools. Use canvas_get_state, canvas_send_message, etc.\x1b[0m\r\n`;
  }
  return `\r\n\x1b[33m⚡ ORCH MCP: ${mcpUrl}\x1b[0m\r\n`;
}

// Register ORCH MCP server with an agent via its CLI
async function registerAgentMcp(providerId: string, mcpUrl: string): Promise<void> {
  if (!mcpUrl) return;

  let cmd: string;
  switch (providerId) {
    case 'opencode':
      cmd = `opencode mcp add orch --url "${mcpUrl}"`;
      break;
    case 'hermes':
      cmd = `hermes mcp add orch --url "${mcpUrl}"`;
      break;
    case 'claude-code':
      // Claude Code uses temp config file instead of CLI command
      return;
    default:
      return;
  }

  try {
    await new Promise<void>((resolve) => {
      exec(cmd, { timeout: 5000 }, (err) => {
        if (err) {
          // "already exists" is fine
          if ((err.message || '').includes('already exists')) {
            resolve();
          } else {
            console.warn(`[MCP] ${providerId} registration:`, err.message?.slice(0, 100));
            resolve();
          }
        } else {
          resolve();
        }
      });
    });
    console.log(`[MCP] Registered ORCH server with ${providerId}`);
  } catch {
    // non-fatal
  }
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

// ── MCP Server ─── LOCAL-ONLY ─────────────────────────────────────
// MCP server runs locally. All tools serve from the local machine.

async function startMcpServer() {
  if (mcpServer) return;
  const server = new OrchMcpServer(sessions);
  mcpServer = server;

  // Wire canvas callbacks from main process state
  // These let MCP tools access the live canvas and PTY sessions.
  // Output is compressed markdown — not raw JSON — to save context
  // window tokens on free-tier LLMs.
  server.getCanvasState = async () => {
    const now = Date.now();
    const items = Array.from(sessions.entries());
    const active = items.filter(([, s]) => !s.hibernating);
    const sleeping = items.filter(([, s]) => s.hibernating);

    // Build a compact agent table
    const agentRows = items.map(([id, s]) => {
      const idleSecs = Math.round((now - s.lastActivity) / 1000);
      const idleStr = idleSecs < 60 ? `${idleSecs}s` : `${Math.floor(idleSecs / 60)}m ${idleSecs % 60}s`;
      const bufLen = s.buffer.length;
      const statusIcon = s.hibernating ? '💤' : '▶';
      return `| ${s.name} | ${s.providerId || 'shell'} | ${statusIcon} ${s.hibernating ? 'sleeping' : 'active'} | ${idleStr} | ${bufLen} lines |`;
    });

    const summary = [
      `## Canvas: ${items.length} agent(s) — ${active.length} active, ${sleeping.length} sleeping`,
      '',
      '| Agent | Provider | Status | Idle | Buffer |',
      '|---|---|---|---|---|',
      ...agentRows,
      '',
      '### Activity',
      ...items.map(([id, s]) => {
        if (s.hibernating) return `- ${s.name} (${s.providerId || 'shell'}): 💤 sleeping, ${s.buffer.length} lines cached`;
        const idleSecs = Math.round((now - s.lastActivity) / 1000);
        return `- ${s.name} (${s.providerId || 'shell'}): ▶ active, idle ${idleSecs}s, ${s.buffer.length} lines`;
      }),
      '',
    ].join('\n');

    return summary;
  };

  server.getCanvasElements = async () => {
    // Forward to renderer via IPC — the canvas elements live in React
    if (mainWindow && !mainWindow.isDestroyed()) {
      return mainWindow.webContents.executeJavaScript(
        'window.__orchGetCanvasElements ? window.__orchGetCanvasElements() : []'
      ).catch(() => []);
    }
    return [];
  };

  server.getAgent = async (id: string) => {
    for (const [, session] of sessions) {
      if (session.agentId === id) {
        const now = Date.now();
        const idleSecs = Math.round((now - session.lastActivity) / 1000);
        const idleStr = idleSecs < 60 ? `${idleSecs}s` : `${Math.floor(idleSecs / 60)}m ${idleSecs % 60}s`;
        const created = new Date(session.createdAt).toISOString().replace('T', ' ').slice(0, 19);
        const statusIcon = session.hibernating ? '💤' : '▶';
        return [
          `## Agent: ${session.name} (${session.providerId || 'shell'})`,
          `- Status: ${statusIcon} ${session.hibernating ? 'sleeping' : 'active'} • Idle: ${idleStr} • Buffer: ${session.buffer.length} lines`,
          `- Shell: ${session.shell} • Kind: ${session.kind}`,
          `- Started: ${created}`,
          session.delegationDepth > 0 ? `- Delegation depth: ${session.delegationDepth}` : '',
          session.contextSnapshot !== '{}' ? `- Context: ${session.contextSnapshot.slice(0, 200)}` : '',
        ].filter(Boolean).join('\n');
      }
    }
    return null;
  };

  server.moveAgent = async (id: string, x: number, y: number) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mcp-move-agent', { agentId: id, x, y });
    }
  };

  server.sendToAgent = async (id: string, text: string) => {
    for (const [, session] of sessions) {
      if (session.agentId === id && session.pty) {
        session.pty.write(text + '\n');
        return;
      }
    }
  };

  server.readAgentOutput = async (id: string, lines?: number) => {
    for (const [, session] of sessions) {
      if (session.agentId === id) {
        return session.buffer.slice(-(lines || 50)).join('');
      }
    }
    return '';
  };

  server.createAgent = async (providerId: string, name?: string, contextSnapshot?: string) => {
    // For now, emit an IPC to the renderer so the React side can handle it
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mcp-create-agent', { providerId, name, contextSnapshot });
    }
    return { providerId, name, status: 'pending' };
  };

  server.removeAgent = async (id: string) => {
    for (const [sessionId, session] of sessions) {
      if (session.agentId === id) {
        if (session.pty) {
          try { session.pty.kill(); } catch { /* ignore */ }
        }
        sessions.delete(sessionId);
        const fullOutput = session.buffer.join('');
        finaliseTerminal(sessionId, null, fullOutput);
        return;
      }
    }
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

  await server.start();
  console.log(`[MCP] Server started on ${server.url}`);
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
        (data) => forwardOutput(sessionId, data),
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

ipcMain.handle('voice_start_listening', async () => {
  if (!voiceServer?.isReady()) return;
  voiceServer.setCallbacks({
    onPartial: (text) => mainWindow?.webContents.send('voice_partial', text),
    onFinal: (text) => mainWindow?.webContents.send('voice_final', text),
    onAudio: (id, pcmBase64) => mainWindow?.webContents.send('voice_audio', { id, data: pcmBase64 }),
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

// ── IPC: Agents ──────────────────────────────────────────────────

ipcMain.handle('register_agent', async (_event, { agent }) => {
  console.log('[IPC] register_agent:', agent.id, agent.name);
  return { success: true };
});

ipcMain.handle('remove_agent', async (_event, { agentId }) => {
  console.log('[IPC] remove_agent:', agentId);
  for (const [id, s] of sessions) {
    if (s.agentId === agentId) {
      s.pty.kill();
      sessions.delete(id);
    }
  }
  return { success: true };
});

ipcMain.handle('list_agents', async () => {
  return [];
});

ipcMain.handle('coordinator_start', async () => {
  console.log('[IPC] coordinator_start');
  return { success: true };
});

ipcMain.handle('coordinator_stop', async () => {
  console.log('[IPC] coordinator_stop');
  return { success: true };
});

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

ipcMain.handle('install_provider', async (event, { providerId, command, packageName }) => {
  console.log(`[Install] Starting install for ${providerId} (${packageName || command})`);

  // Build the install command based on provider
  let installCmd = '';
  let installArgs: string[] = [];

  if (providerId === 'hermes') {
    installCmd = 'npm';
    installArgs = ['install', '-g', 'hermes-agent'];
  } else if (providerId === 'claude-code') {
    installCmd = 'npm';
    installArgs = ['install', '-g', '@anthropic-ai/claude-code'];
  } else if (providerId === 'codex') {
    // Codex uses npx so it auto-installs — mark as available
    return { success: true, message: 'Codex runs via npx — no install needed' };
  } else if (providerId === 'opencode') {
    installCmd = 'npm';
    installArgs = ['install', '-g', 'opencode'];
  } else {
    // Generic: try npm install -g <packageName>
    installCmd = 'npm';
    installArgs = ['install', '-g', packageName || command];
  }

  try {
    const { spawn } = require('child_process');
    const child = spawn(installCmd, installArgs, {
      shell: true,
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

ipcMain.handle('save_canvas_asset', async (event, { data, ext }) => {
  const { app } = require('electron');
  const fs = require('fs');
  const path = require('path');
  const assetsDir = path.join(app.getPath('userData'), 'canvas_assets');
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }
  const name = `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext || 'png'}`;
  const filePath = path.join(assetsDir, name);
  const buffer = Buffer.from(data, 'base64');
  fs.writeFileSync(filePath, buffer);
  return { success: true, path: filePath };
});

// ── IPC: MCP info ────────────────────────────────────────────────

ipcMain.handle('get-mcp-url', async () => {
  return mcpServer ? mcpServer.url : null;
});

// ── IPC: Terminal (node-pty) ─────────────────────────────────────

ipcMain.handle('create_terminal', async (_event, { agentId, name, command, args, env, kind, providerId, delegationDepth, contextSnapshot }) => {
  const sessionId = `${agentId || name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  let shell = command || (process.platform === 'win32' ? 'cmd.exe' : '/bin/bash');
  let shellArgs = args || [];
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
    // ── Inject MCP agent config ───────────────────────────────
    const mcpUrl = mcpServer?.url || '';
    const mcpConfigDir = writeMcpAgentConfig(providerId, mcpUrl, sessionId);
    const cwd = mcpConfigDir || process.cwd();
    const preamble = getMcpPreamble(providerId, mcpUrl);

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
      mcpConfigDir,
      delegationDepth: delegationDepth || 0,
      contextSnapshot: contextSnapshot || JSON.stringify({}),
    };

    // Write MCP preamble so the agent sees the connection info
    if (preamble) {
      forwardOutput(sessionId, preamble);
    }

    ptyProcess.onData((rawChunk: string) => {
      session.lastActivity = Date.now();
      session.buffer.push(rawChunk);
      if (session.buffer.length > MAX_BUF_LINES) {
        session.buffer.splice(0, session.buffer.length - MAX_BUF_LINES);
      }
      // ── Track buffer in local DB ──────────────────────────
      const chunkLines = rawChunk.split('\n');
      updateTerminalBuffer(sessionId, rawChunk.length, chunkLines.length - 1, rawChunk.slice(-200));
      // Forward raw output to UI immediately (renders ANSI for the terminal emulator)
      forwardOutput(sessionId, rawChunk);

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
      // Flush any remaining line buffer
      if (mcpServer && sessionLineBuffers[sessionId]?.trim()) {
        mcpServer.eventBus.emit('terminal_line', session.agentId, {
          sessionId,
          data: sessionLineBuffers[sessionId].trim().slice(0, 1000),
          lineCount: session.buffer.length,
        });
      }
      delete sessionLineBuffers[sessionId];
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
      // Clean up temp MCP config directory
      if (mcpConfigDir) {
        try { fs.rmSync(mcpConfigDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    sessions.set(sessionId, session);
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

    // ── Register MCP for all CLI agents ──────────────────────
    if (mcpUrl) {
      setTimeout(() => registerAgentMcp(providerId, mcpUrl), 2000);
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
  for (const [, session] of sessions) {
    if (session.agentId === agentId && session.pty) {
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
  if (!session) throw new Error(`Session ${sessionId} not found`);
  // Touch activity — prevents auto-hibernation while user is typing
  if (session.pty) {
    session.lastActivity = Date.now();
    session.pty.write(data);
  }
  return { success: true };
});

ipcMain.handle('read_terminal', async (_event, { sessionId }) => {
  const session = sessions.get(sessionId);
  if (!session) return [];
  const raw = session.buffer.join('');
  return raw.split('\n').slice(-200);
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
  if (session && session.pty) session.pty.resize(cols, rows);
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
ipcMain.handle('open-auth-url', async (_event, { url }: { url: string }) => {
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// ── App lifecycle ────────────────────────────────────────────────

app.whenReady().then(() => {
  // ── Initialise local database ──────────────────────────
  initLocalDb();

  createWindow();
  // Start voice server
  voiceServer = new VoiceServer();
  voiceServer.setCallbacks({
    onPartial: (text) => mainWindow?.webContents.send('voice_partial', text),
    onFinal: (text) => mainWindow?.webContents.send('voice_final', text),
    onAudio: (id, pcmBase64) => mainWindow?.webContents.send('voice_audio', { id, data: pcmBase64 }),
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
    if (s.pty) s.pty.kill();
    const fullOutput = s.buffer.join('');
    finaliseTerminal(id, null, fullOutput);
  }
  sessions.clear();
  if (hibernationManager) hibernationManager.stop();
});
