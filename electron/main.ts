import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import { OrchMcpServer } from './mcp-server.js';
import { VoiceServer } from './voice-server.js';

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
    icon: icon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
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

// ── MCP Server ─── VPS-HOSTED ─────────────────────────────────────
// Local MCP server is disabled. All tools are served from the VPS:
//   GET  /api/mcp/tools   — list tools
//   POST /api/mcp/call    — invoke a tool
//   WS   /voice-ws        — state broadcasts
// The VPS workspace persists independently of the Electron app.

async function startMcpServer() {
  // Disabled — using VPS-hosted MCP instead
  console.log('[MCP] Using VPS-hosted MCP server (http://51.170.134.197:8000/api/mcp)');
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
  };
  hibernationManager.onWake = (sessionId, agentId) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('agent-status-changed', { agentId, status: 'active', sessionId });
    }
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
      env: shellEnv ? { ...process.env, ...shellEnv } : process.env,
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
      forwardOutput(sessionId, `\r\n[Process exited with code ${exitCode}]\r\n`);
      // Clean up temp MCP config directory
      if (mcpConfigDir) {
        try { fs.rmSync(mcpConfigDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    });

    sessions.set(sessionId, session);
    console.log(`[PTY] Created session ${sessionId} (shell=${shell})`);

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
    sessions.delete(sessionId);
    console.log(`[PTY] Closed session ${sessionId}`);
  }
  return { success: true };
});

ipcMain.handle('resize_terminal', async (_event, { sessionId, cols, rows }) => {
  const session = sessions.get(sessionId);
  if (session && session.pty) session.pty.resize(cols, rows);
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

// ── IPC: File Sync ────────────────────────────────────────────────

ipcMain.handle('filesync_start', async (_event, { workspaceId, localPath, vpsUrl }) => {
  const { fileSyncEngine } = await import('./file-sync-engine.js');
  await fileSyncEngine.start(workspaceId, localPath, vpsUrl);
  return { success: true };
});

ipcMain.handle('filesync_stop', async () => {
  const { fileSyncEngine } = await import('./file-sync-engine.js');
  fileSyncEngine.stop();
  return { success: true };
});

ipcMain.handle('filesync_get_state', async () => {
  const { fileSyncEngine } = await import('./file-sync-engine.js');
  return fileSyncEngine.state;
});

// ── IPC: Voice ───────────────────────────────────────────────────

ipcMain.handle('toggle_voice', async () => {
  console.log('[IPC] toggle_voice');
  return 'toggled';
});

// ── IPC: Window controls ─────────────────────────────────────────

ipcMain.handle('window_minimize', () => mainWindow?.minimize());
ipcMain.handle('window_maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.handle('window_close', () => mainWindow?.close());

// ── App lifecycle ────────────────────────────────────────────────

app.whenReady().then(() => {
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

  // Wire FileSyncEngine events to renderer
  import('./file-sync-engine.js').then(({ fileSyncEngine }) => {
    fileSyncEngine.on('state-changed', (state) => {
      mainWindow?.webContents.send('filesync_state_changed', state);
    });
    fileSyncEngine.on('log', (msg: string) => {
      console.log(msg);
    });
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('will-quit', () => {
  voiceServer?.stop();
  for (const [, s] of sessions) if (s.pty) s.pty.kill();
  sessions.clear();
  if (hibernationManager) hibernationManager.stop();
});
