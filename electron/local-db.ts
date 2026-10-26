// ── Local Database Engine ────────────────────────────────────────
// JSON-file-backed local storage in Electron's userData directory.
// All I/O happens in the main process; renderer accesses via IPC.
//
// WRITE MODEL: the store is held in memory and flushed to disk on a
// debounced timer. Callers mutate through the exported functions and
// call save() as before — but save() no longer touches the filesystem
// synchronously. This matters because updateTerminalBuffer() runs on
// every PTY data chunk (hundreds/sec during a build); doing a
// readFileSync + JSON.parse + writeFileSync of a multi-megabyte store
// on each one froze the main process, and with it the entire UI.

import { app } from 'electron';
import path from 'path';
import fs from 'fs';

// ── Types ──────────────────────────────────────────────────────────

export interface TerminalHistoryEntry {
  sessionId: string;
  agentId: string;
  name: string;
  providerId: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  charCount: number;
  lineCount: number;
  snippet?: string;             // last 5 lines of output
  finalBuffer?: string;         // full buffer on close (truncated to 50KB)
}

export interface AgentLogEntry {
  id: string;
  agentId: string;
  name: string;
  providerId: string;
  event: 'spawned' | 'hibernated' | 'woken' | 'exited' | 'error' | 'approved' | 'denied';
  timestamp: string;
  detail?: string;
}

export interface SessionEventEntry {
  id: string;
  type: 'window_resize' | 'panel_arrange' | 'workspace_switch' | 'focus_change' | 'agent_spawn' | 'agent_remove' | 'tool_executed';
  timestamp: string;
  data: Record<string, any>;
}

export interface LocalSettings {
  workspaces: Record<string, any>;
  preferences: Record<string, any>;
  providers: Record<string, any>[];
  mcps: Record<string, any>[];
}

/** Mirror of Artifact shape from artifact-registry.ts — kept self-contained to avoid circular deps. */
export interface PersistedArtifact {
  id: string;
  agentId: string;
  type: string;
  title: string;
  description: string;
  data: Record<string, unknown>;
  tags: string[];
  timestamp: number;
}

interface LocalStore {
  terminalHistory: TerminalHistoryEntry[];
  agentLogs: AgentLogEntry[];
  sessionEvents: SessionEventEntry[];
  settings: LocalSettings;
  workspaces: Record<string, any>;
  artifacts: PersistedArtifact[];       // ← persisted artifact + memory store
}

// ── Engine ─────────────────────────────────────────────────────────

const DB_DIR = path.join(app.getPath('userData'), 'orch-local');
const DB_FILE = path.join(DB_DIR, 'store.json');
const MAX_TERMINAL_HISTORY = 200;   // keep last 200 terminal sessions
const MAX_AGENT_LOGS = 1000;
const MAX_SESSION_EVENTS = 500;
const MAX_BUFFER_BYTES = 50 * 1024; // 50KB cap per terminal buffer

function ensureDir(): void {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
}

/** In-memory authoritative copy. Populated on first load(), mutated in
 *  place by the exported writers, flushed to disk by scheduleFlush(). */
let cache: LocalStore | null = null;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let firstDirtyAt = 0;

const FLUSH_DEBOUNCE_MS = 750;   // quiet period before writing
const FLUSH_MAX_DELAY_MS = 5000; // hard ceiling — a busy terminal must not starve the flush

function readFromDisk(): LocalStore {
  ensureDir();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      terminalHistory: parsed.terminalHistory ?? [],
      agentLogs: parsed.agentLogs ?? [],
      sessionEvents: parsed.sessionEvents ?? [],
      settings: parsed.settings ?? {
        workspaces: {},
        preferences: {},
        providers: [],
        mcps: [],
      },
      workspaces: parsed.workspaces ?? {},
      artifacts: parsed.artifacts ?? [],
    };
  } catch {
    return {
      terminalHistory: [],
      agentLogs: [],
      sessionEvents: [],
      settings: {
        workspaces: {},
        preferences: {},
        providers: [],
        mcps: [],
      },
      workspaces: {},
      artifacts: [],
    };
  }
}

function load(): LocalStore {
  if (!cache) cache = readFromDisk();
  return cache;
}

/** Write the in-memory store to disk atomically. Synchronous by design —
 *  it runs at most every FLUSH_DEBOUNCE_MS, and on quit it must complete. */
function writeToDisk(store: LocalStore): void {
  ensureDir();
  const tmp = DB_FILE + '.tmp';
  // No pretty-printing: this file is machine-read only, and indentation
  // roughly doubles both the serialise cost and the bytes written.
  fs.writeFileSync(tmp, JSON.stringify(store), 'utf-8');
  fs.renameSync(tmp, DB_FILE);
}

/** Mark the store dirty and schedule a debounced flush. */
function save(store: LocalStore): void {
  cache = store;
  if (!dirty) {
    dirty = true;
    firstDirtyAt = Date.now();
  }
  if (flushTimer) clearTimeout(flushTimer);

  // Cap the debounce so continuous writes still reach disk periodically.
  const elapsed = Date.now() - firstDirtyAt;
  const delay = Math.max(0, Math.min(FLUSH_DEBOUNCE_MS, FLUSH_MAX_DELAY_MS - elapsed));

  flushTimer = setTimeout(flushLocalDb, delay);
  // Never hold the event loop open just for a pending flush.
  flushTimer.unref?.();
}

/** Force an immediate synchronous flush. Call on app quit. */
export function flushLocalDb(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!dirty || !cache) return;
  try {
    writeToDisk(cache);
    dirty = false;
  } catch (err) {
    console.error('[LocalDB] Flush failed:', err);
  }
}

// ── Public API ─────────────────────────────────────────────────────

export function initLocalDb(): void {
  ensureDir();
  cache = readFromDisk();
  rebuildTerminalIndex();
  // Write once at boot so the file always exists in a valid state.
  try { writeToDisk(cache); } catch (err) { console.error('[LocalDB] Init write failed:', err); }
  dirty = false;
  console.log(`[LocalDB] Initialised at ${DB_FILE}`);
}

// ── Terminal index ─────────────────────────────────────────────────
// updateTerminalBuffer() is the hottest write in the app. A linear
// find() over terminalHistory on every PTY chunk is avoidable, so keep
// a sessionId → entry map alongside the array.
let terminalIndex = new Map<string, TerminalHistoryEntry>();

function rebuildTerminalIndex(): void {
  terminalIndex = new Map();
  if (!cache) return;
  for (const entry of cache.terminalHistory) terminalIndex.set(entry.sessionId, entry);
}

function findTerminal(sessionId: string): TerminalHistoryEntry | undefined {
  if (terminalIndex.size === 0 && cache && cache.terminalHistory.length > 0) rebuildTerminalIndex();
  return terminalIndex.get(sessionId);
}

export function getDbPath(): string {
  return DB_FILE;
}

// ── Terminal History ────────────────────────────────────────────────

export function recordTerminalStart(
  sessionId: string,
  agentId: string,
  name: string,
  providerId: string,
): void {
  const store = load();
  const entry: TerminalHistoryEntry = {
    sessionId,
    agentId,
    name,
    providerId,
    startedAt: new Date().toISOString(),
    charCount: 0,
    lineCount: 0,
  };
  store.terminalHistory.push(entry);
  terminalIndex.set(sessionId, entry);
  // Trim oldest
  if (store.terminalHistory.length > MAX_TERMINAL_HISTORY) {
    store.terminalHistory = store.terminalHistory.slice(-MAX_TERMINAL_HISTORY);
    rebuildTerminalIndex();
  }
  save(store);
}

export function updateTerminalBuffer(
  sessionId: string,
  charCount: number,
  lineCount: number,
  lastChunk?: string,
): void {
  const store = load();
  const entry = findTerminal(sessionId);
  if (!entry) return;
  entry.charCount += charCount;
  entry.lineCount += lineCount;
  // Keep a rolling snippet (last ~5 lines)
  if (lastChunk) {
    const lines = lastChunk.split('\n').filter(Boolean).slice(-5);
    entry.snippet = lines.join('\n').slice(0, 500);
    // Cap the raw buffer stored
    const cap = MAX_BUFFER_BYTES;
    if (entry.finalBuffer && entry.finalBuffer.length > cap) {
      entry.finalBuffer = entry.finalBuffer.slice(-cap);
    }
  }
  save(store);
}

export function finaliseTerminal(
  sessionId: string,
  exitCode: number | null | undefined,
  fullBuffer?: string,
): void {
  const store = load();
  const entry = findTerminal(sessionId);
  if (!entry) return;
  entry.endedAt = new Date().toISOString();
  entry.exitCode = exitCode ?? null;
  if (fullBuffer) {
    entry.finalBuffer = fullBuffer.slice(-MAX_BUFFER_BYTES);
  }
  save(store);
}

export function listTerminalHistory(limit = 50): TerminalHistoryEntry[] {
  const store = load();
  return store.terminalHistory.slice(-limit).reverse();
}

// ── Agent Logs ─────────────────────────────────────────────────────

export function logAgentEvent(
  agentId: string,
  name: string,
  providerId: string,
  event: AgentLogEntry['event'],
  detail?: string,
): void {
  const store = load();
  store.agentLogs.push({
    id: `${agentId}-${Date.now()}`,
    agentId,
    name,
    providerId,
    event,
    timestamp: new Date().toISOString(),
    detail,
  });
  if (store.agentLogs.length > MAX_AGENT_LOGS) {
    store.agentLogs = store.agentLogs.slice(-MAX_AGENT_LOGS);
  }
  save(store);
}

export function listAgentLogs(agentId?: string, limit = 50): AgentLogEntry[] {
  const store = load();
  let logs = store.agentLogs;
  if (agentId) logs = logs.filter((l) => l.agentId === agentId);
  return logs.slice(-limit).reverse();
}

// ── Session Events ─────────────────────────────────────────────────

export function recordSessionEvent(
  type: SessionEventEntry['type'],
  data: Record<string, any> = {},
): void {
  const store = load();
  store.sessionEvents.push({
    id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    timestamp: new Date().toISOString(),
    data,
  });
  if (store.sessionEvents.length > MAX_SESSION_EVENTS) {
    store.sessionEvents = store.sessionEvents.slice(-MAX_SESSION_EVENTS);
  }
  save(store);
}

export function listSessionEvents(type?: string, limit = 30): SessionEventEntry[] {
  const store = load();
  let events = store.sessionEvents;
  if (type) events = events.filter((e) => e.type === type);
  return events.slice(-limit).reverse();
}

// ── Workspaces (local-only) ────────────────────────────────────────

export function upsertLocalWorkspace(
  id: string,
  data: Record<string, any>,
): void {
  const store = load();
  store.workspaces[id] = {
    ...data,
    updatedAt: new Date().toISOString(),
  };
  save(store);
}

export function listLocalWorkspaces(): Record<string, any>[] {
  const store = load();
  return Object.entries(store.workspaces)
    .map(([id, data]) => ({ id, ...(data as object) }))
    .sort((a, b) => ((b as any).updatedAt || '') > ((a as any).updatedAt || '') ? 1 : -1);
}

export function deleteLocalWorkspace(id: string): void {
  const store = load();
  delete store.workspaces[id];
  save(store);
}

// ── Settings ────────────────────────────────────────────────────────

export function saveLocalSettings(settings: Partial<LocalSettings>): void {
  const store = load();
  store.settings = { ...store.settings, ...settings };
  save(store);
}

export function getLocalSettings(): LocalSettings {
  const store = load();
  return store.settings;
}

// ── Stats ───────────────────────────────────────────────────────────

export function getLocalStats(): Record<string, any> {
  const store = load();
  return {
    totalTerminals: store.terminalHistory.length,
    totalAgentLogs: store.agentLogs.length,
    totalSessionEvents: store.sessionEvents.length,
    activeTerminals: store.terminalHistory.filter((e) => !e.endedAt).length,
    workspaces: Object.keys(store.workspaces).length,
    latestTerminal: store.terminalHistory[store.terminalHistory.length - 1] ?? null,
    dbPath: DB_FILE,
    dbSizeBytes: fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).size : 0,
  };
}

// ── Nuke (for testing/reset) ────────────────────────────────────────

export function resetLocalDb(): void {
  ensureDir();
  cache = {
    terminalHistory: [],
    agentLogs: [],
    sessionEvents: [],
    settings: { workspaces: {}, preferences: {}, providers: [], mcps: [] },
    workspaces: {},
    artifacts: [],
  };
  rebuildTerminalIndex();
  writeToDisk(cache);
  dirty = false;
}

// ── Artifact Persistence ─────────────────────────────────────────────
// Shared typed-artifact store used by ArtifactRegistry.
// Every write goes through load/save to stay consistent with the JSON file.

const MAX_ARTIFACTS = 2000;

/** Persist a single artifact (create or update by id). */
export function saveArtifact(artifact: PersistedArtifact): void {
  const store = load();
  const idx = store.artifacts.findIndex((a) => a.id === artifact.id);
  if (idx >= 0) {
    store.artifacts[idx] = artifact;
  } else {
    store.artifacts.push(artifact);
  }
  // Enforce cap — drop oldest when over limit
  if (store.artifacts.length > MAX_ARTIFACTS) {
    store.artifacts = store.artifacts.slice(store.artifacts.length - MAX_ARTIFACTS);
  }
  save(store);
}

/** Bulk-insert artifacts (used on rehydration — overwrites matching ids). */
export function saveArtifactsBulk(artifacts: PersistedArtifact[]): void {
  const store = load();
  for (const art of artifacts) {
    const idx = store.artifacts.findIndex((a) => a.id === art.id);
    if (idx >= 0) {
      store.artifacts[idx] = art;
    } else {
      store.artifacts.push(art);
    }
  }
  if (store.artifacts.length > MAX_ARTIFACTS) {
    store.artifacts = store.artifacts.slice(store.artifacts.length - MAX_ARTIFACTS);
  }
  save(store);
}

/** Load all persisted artifacts. Returns empty array if none exist. */
export function loadAllArtifacts(): PersistedArtifact[] {
  const store = load();
  return store.artifacts;
}

/** Delete a single artifact by id. */
export function deleteArtifact(id: string): void {
  const store = load();
  store.artifacts = store.artifacts.filter((a) => a.id !== id);
  save(store);
}

/** Delete all artifacts for an agent. Returns count deleted. */
export function deleteAgentArtifacts(agentId: string): number {
  const store = load();
  const before = store.artifacts.length;
  store.artifacts = store.artifacts.filter((a) => a.agentId !== agentId);
  const count = before - store.artifacts.length;
  save(store);
  return count;
}

/** Clear all artifacts (full reset). */
export function clearAllArtifacts(): void {
  const store = load();
  store.artifacts = [];
  save(store);
}
