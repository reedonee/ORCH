// ── ORCH File Sync Engine — Main Process ─────────────────────────
// Watches a local project folder with chokidar and syncs changes
// bidirectionally with the VPS over a dedicated WebSocket.
//
// Architecture:
//   chokidar (local) → debounce/dedup → WS → VPS /workspace/
//   VPS watchdog    → debounce/dedup → WS → local disk
//   EchoMutex breaks the feedback loop on both sides
//
// Design mirrors server/agent-core/filesync/sync_manager.py

import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import chokidar from 'chokidar';
import WebSocket from 'ws';
import { c as createTar } from 'tar';

// ── Types ──────────────────────────────────────────────────────────

export type SyncStatus = 'disconnected' | 'connecting' | 'uploading' | 'syncing' | 'error';

export interface SyncState {
  status: SyncStatus;
  workspaceId: string | null;
  localPath: string | null;
  lastSynced: number | null;
  error: string | null;
  pendingChanges: number;
}

// ── Ignore Rules (mirrors VPS sync_manager.py should_ignore) ──────

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg',
  '__pycache__', '.venv', 'venv', '.tox',
  'dist', 'build', '.next', '.turbo', '.output', 'out', 'target',
  'coverage', '.nyc_output', '.cache', '.parcel-cache',
  '.idea', '.vscode',
]);

const IGNORE_EXTS = new Set([
  '.pyc', '.pyo', '.so', '.dll', '.dylib',
  '.exe', '.bin', '.dmg', '.pkg', '.msi',
  '.DS_Store', 'Thumbs.db',
  '.jpg', '.jpeg', '.png', '.gif', '.ico', '.svg',
  '.mp4', '.mp3', '.wav', '.ogg', '.flac',
  '.zip', '.tar', '.gz', '.tgz', '.rar', '.7z',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
]);
const IGNORE_NAMES = new Set(['.DS_Store', 'Thumbs.db', '.env', '.env.local']);

function shouldIgnore(filePath: string): boolean {
  const parts = filePath.replace(/\\/g, '/').split('/');
  for (const part of parts) {
    if (IGNORE_DIRS.has(part)) return true;
  }
  const ext = path.extname(filePath).toLowerCase();
  if (IGNORE_EXTS.has(ext)) return true;
  if (IGNORE_NAMES.has(path.basename(filePath))) return true;
  return false;
}

// ── EchoMutex (mirrors VPS EchoMutex) ────────────────────────────

class EchoMutex {
  private muted = new Map<string, number>();
  private muteMs: number;

  constructor(muteMs = 2500) {
    this.muteMs = muteMs;
  }

  mute(filePath: string): void {
    this.muted.set(filePath.replace(/\\/g, '/'), Date.now() + this.muteMs);
  }

  isMuted(filePath: string): boolean {
    const norm = filePath.replace(/\\/g, '/');
    const expiry = this.muted.get(norm);
    if (!expiry) return false;
    if (Date.now() < expiry) return true;
    this.muted.delete(norm);
    return false;
  }

  clear(): void {
    this.muted.clear();
  }
}

// ── FileSyncEngine ─────────────────────────────────────────────────

export class FileSyncEngine extends EventEmitter {
  private status: SyncStatus = 'disconnected';
  private ws: WebSocket | null = null;
  private watcher: chokidar.FSWatcher | null = null;
  private echoMutex = new EchoMutex();
  private workspaceId: string | null = null;
  private localPath: string | null = null;
  private vpsBaseUrl: string | null = null;

  private outgoingBatch: Array<{
    path: string;
    content: string | null;
    mtime: number;
    size: number;
  }> = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly BATCH_WINDOW = 500; // ms
  private pendingCount = 0;
  private lastSynced: number | null = null;
  private lastError: string | null = null;

  constructor() {
    super();
  }

  /** Snapshot of current sync state for the renderer */
  get state(): SyncState {
    return {
      status: this.status,
      workspaceId: this.workspaceId,
      localPath: this.localPath,
      lastSynced: this.lastSynced,
      error: this.lastError,
      pendingChanges: this.pendingCount,
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Start sync for a workspace.
   * 1. Creates tar.gz of local project and uploads to VPS
   * 2. Opens dedicated WebSocket for live sync
   * 3. Starts chokidar to watch for local changes
   */
  async start(workspaceId: string, localPath: string, vpsBaseUrl: string): Promise<void> {
    this.workspaceId = workspaceId;
    this.localPath = path.resolve(localPath);
    this.vpsBaseUrl = vpsBaseUrl.replace(/\/+$/, '');
    this.lastError = null;

    if (!fs.existsSync(this.localPath)) {
      throw new Error(`Local path does not exist: ${this.localPath}`);
    }

    try {
      this.emit('log', `[FileSync] Starting sync for ${this.localPath} → ${workspaceId}`);

      await this.uploadArchive();
      await this.connectWs();
      this.startWatcher();

      this.setStatus('syncing');
      this.emit('state-changed', this.state);
    } catch (err: any) {
      this.lastError = err.message;
      this.setStatus('error');
      this.emit('state-changed', this.state);
      throw err;
    }
  }

  /** Stop sync — close watcher, disconnect WS, clear state */
  stop(): void {
    this.stopWatcher();
    this.disconnectWs();
    this.echoMutex.clear();
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.outgoingBatch = [];
    this.workspaceId = null;
    this.localPath = null;
    this.pendingCount = 0;
    this.lastSynced = null;
    this.lastError = null;
    this.setStatus('disconnected');
    this.emit('state-changed', this.state);
  }

  // ── Archive Upload ───────────────────────────────────────────────

  private async uploadArchive(): Promise<void> {
    this.setStatus('uploading');
    const outputPath = path.join(
      app.getPath('temp'),
      `orch-sync-${this.workspaceId}.tar.gz`,
    );

    this.emit('log', '[FileSync] Creating archive...');
    console.log(`[FileSync] Creating tar.gz at ${outputPath}`);

    // Create tar.gz with ignore exclusions
    await createTar(
      {
        gzip: true,
        file: outputPath,
        cwd: this.localPath!,
        portable: true,
        filter: (fp: string) => {
          const skip = shouldIgnore(fp);
          if (skip) console.log(`[FileSync] Excluding from archive: ${fp}`);
          return !skip;
        },
      },
      ['.'],
    );

    const stat = fs.statSync(outputPath);
    console.log(`[FileSync] Archive size: ${stat.size} bytes`);

    try {
      const archiveBuffer = fs.readFileSync(outputPath);
      const blob = new Blob([archiveBuffer]);

      const form = new FormData();
      form.append('workspace_id', this.workspaceId!);
      form.append('archive', blob, 'project.tar.gz');

      this.emit('log', `[FileSync] Uploading ${(stat.size / 1024).toFixed(1)} KB...`);

      const response = await fetch(`${this.vpsBaseUrl}/api/filesync/init`, {
        method: 'POST',
        body: form,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Upload failed (${response.status}): ${text.slice(0, 200)}`);
      }

      const result = await response.json() as {
        file_count: number;
        total_size: number;
        workspace_id: string;
      };

      this.emit(
        'log',
        `[FileSync] Uploaded ${result.file_count} files (${(result.total_size / 1024).toFixed(1)} KB)`,
      );
      console.log(
        `[FileSync] Uploaded ${result.file_count} files (${result.total_size} bytes) to workspace ${result.workspace_id}`,
      );
    } finally {
      try {
        fs.unlinkSync(outputPath);
      } catch {
        /* ignore */
      }
    }
  }

  // ── WebSocket ────────────────────────────────────────────────────

  private connectWs(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.setStatus('connecting');

      const wsUrl = `${this.vpsBaseUrl!.replace(/^http/, 'ws')}/ws/filesync/${this.workspaceId}`;
      this.emit('log', `[FileSync] Connecting to ${wsUrl}`);
      console.log(`[FileSync] Connecting to ${wsUrl}`);

      this.ws = new WebSocket(wsUrl);

      const timeout = setTimeout(() => {
        reject(new Error('WebSocket connection timeout (10s)'));
      }, 10000);

      this.ws.on('open', () => {
        clearTimeout(timeout);
        this.emit('log', '[FileSync] WebSocket connected');
        console.log('[FileSync] WebSocket connected');

        // Signal that initial archive is done and watcher is starting
        const initMsg = JSON.stringify({
          type: 'fs_init_complete',
          workspaceId: this.workspaceId,
        });
        this.ws!.send(initMsg);

        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleIncoming(msg);
        } catch (err) {
          console.error('[FileSync] Invalid WS message:', err);
        }
      });

      this.ws.on('error', (err: Error) => {
        clearTimeout(timeout);
        console.error('[FileSync] WS error:', err.message);
        this.lastError = err.message;
        this.setStatus('error');
        this.emit('state-changed', this.state);
        if (this.ws?.readyState !== WebSocket.OPEN) {
          reject(err);
        }
      });

      this.ws.on('close', () => {
        console.log('[FileSync] WebSocket closed');
        this.lastError = 'Connection closed';
        this.setStatus('disconnected');
        this.emit('state-changed', this.state);
      });
    });
  }

  private disconnectWs(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  // ── Incoming message handling (VPS → local disk) ────────────────

  private handleIncoming(msg: any): void {
    switch (msg.type) {
      case 'fs_ack':
        if (msg.init_complete) {
          this.emit('log', '[FileSync] VPS acknowledged init, sync active');
          this.lastSynced = Date.now();
        }
        break;

      case 'fs_change':
        this.applyChange(msg);
        break;

      case 'fs_batch':
        for (const change of msg.changes || []) {
          this.applyChange(change);
        }
        break;

      case 'fs_pong':
        break; // keepalive

      default:
        console.log('[FileSync] Unknown message type:', msg.type);
    }
  }

  private applyChange(change: {
    path: string;
    content: string | null;
    mtime: number;
  }): void {
    if (!this.localPath) return;

    const absPath = path.resolve(this.localPath, change.path);

    // Security: block path traversal
    if (!absPath.startsWith(this.localPath)) {
      console.warn(`[FileSync] Path traversal blocked: ${change.path}`);
      return;
    }

    // Mute so chokidar doesn't echo back
    this.echoMutex.mute(change.path);

    if (change.content === null) {
      // Delete
      try {
        if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
      } catch {
        /* ignore */
      }
    } else {
      // Write
      const dir = path.dirname(absPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (typeof change.content === 'string' && change.content.startsWith('base64:')) {
        const buf = Buffer.from(change.content.slice(7), 'base64');
        fs.writeFileSync(absPath, buf);
      } else {
        fs.writeFileSync(absPath, change.content!, 'utf-8');
      }

      // Preserve mtime
      if (change.mtime) {
        try {
          const mtimeSec = change.mtime / 1000;
          fs.utimesSync(absPath, mtimeSec, mtimeSec);
        } catch {
          /* ignore */
        }
      }
    }

    this.lastSynced = Date.now();
  }

  // ── Local file watcher (chokidar) ────────────────────────────────

  private startWatcher(): void {
    if (!this.localPath) return;

    this.watcher = chokidar.watch(this.localPath, {
      ignored: (testPath: string, stats?: fs.Stats) => {
        if (testPath === this.localPath) return false;
        const rel = path.relative(this.localPath!, testPath).replace(/\\/g, '/');
        if (!rel || rel === '') return false;
        // Skip dotfiles at root (only .orch-workspace.json is ours)
        return shouldIgnore(rel);
      },
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    this.watcher.on('add', (fp: string) => this.onLocalChange(fp, false));
    this.watcher.on('change', (fp: string) => this.onLocalChange(fp, false));
    this.watcher.on('unlink', (fp: string) => this.onLocalChange(fp, true));

    this.emit('log', `[FileSync] Watching ${this.localPath}`);
    console.log(`[FileSync] Watching ${this.localPath}`);
  }

  private stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private onLocalChange(filePath: string, isDeletion: boolean): void {
    if (!this.localPath) return;

    const relPath = path.relative(this.localPath, filePath).replace(/\\/g, '/');
    if (!relPath || relPath.startsWith('.')) return;

    // Echo check
    if (this.echoMutex.isMuted(relPath)) return;
    if (shouldIgnore(relPath)) return;

    // Ignore our own workspace file
    if (relPath === '.orch-workspace.json') return;

    if (isDeletion) {
      this.queueOutgoing({ path: relPath, content: null, mtime: 0, size: 0 });
      return;
    }

    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return;

      let content: string;
      if (stat.size === 0) {
        content = '';
      } else {
        try {
          content = fs.readFileSync(filePath, 'utf-8');
        } catch {
          // Binary
          const buf = fs.readFileSync(filePath);
          content = 'base64:' + buf.toString('base64');
        }
      }

      this.queueOutgoing({
        path: relPath,
        content,
        mtime: Math.floor(stat.mtimeMs),
        size: stat.size,
      });
    } catch {
      // File disappeared between event and read
    }
  }

  // ── Batching ─────────────────────────────────────────────────────

  private queueOutgoing(change: {
    path: string;
    content: string | null;
    mtime: number;
    size: number;
  }): void {
    this.outgoingBatch.push(change);
    this.pendingCount++;
    this.emit('state-changed', this.state);

    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.flushBatch(), this.BATCH_WINDOW);
    }
  }

  private flushBatch(): void {
    this.batchTimer = null;

    if (
      this.outgoingBatch.length === 0 ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) {
      this.pendingCount = 0;
      this.emit('state-changed', this.state);
      return;
    }

    // Deduplicate by path (latest wins)
    const deduped = new Map<string, (typeof this.outgoingBatch)[0]>();
    for (const ch of this.outgoingBatch) {
      deduped.set(ch.path, ch);
    }

    const changes = Array.from(deduped.values());
    this.outgoingBatch = [];
    this.pendingCount = 0;

    try {
      const payload =
        changes.length === 1
          ? { type: 'fs_change', workspaceId: this.workspaceId, ...changes[0] }
          : { type: 'fs_batch', workspaceId: this.workspaceId, changes };

      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      console.error('[FileSync] Send failed:', err);
    }

    this.emit('state-changed', this.state);
  }

  // ── Status helpers ───────────────────────────────────────────────

  private setStatus(s: SyncStatus): void {
    this.status = s;
    this.emit('state-changed', this.state);
  }
}

// ── Singleton (one active sync session) ────────────────────────────

export const fileSyncEngine = new FileSyncEngine();
