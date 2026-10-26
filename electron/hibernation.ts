// ── ORCH Hibernation Manager ────────────────────────────────────
// Manages PTY session lifecycle: hibernation (kill + save state) and
// wake (spawn + replay buffer). Enforces max concurrent processes.

import type { IPty } from 'node-pty';

export interface PtySession {
  pty: IPty | null;           // null when hibernating
  agentId: string;
  name: string;
  kind: string;
  buffer: string[];
  createdAt: number;
  lastActivity: number;       // updated on every data/input
  hibernating: boolean;
  // Resurrection info
  shell: string;
  shellArgs: string[];
  shellEnv: Record<string, string> | undefined;
  providerId: string;
  // Delegation / memory tracking
  delegationDepth: number;    // how deep in the delegation tree
  contextSnapshot: string;    // JSON: shell path, env config, relevant artifact IDs
}

export interface SessionStats {
  total: number;
  active: number;
  hibernating: number;
  sessions: Array<{ id: string; agentId: string; name: string; status: string; idleSeconds: number }>;
}

// ── Tuning ──────────────────────────────────────────────────────
//
// IMPORTANT: "hibernation" here means KILLING the process and later
// spawning a fresh shell. For a CLI coding agent that is termination,
// not suspension: the conversation, the working directory and any
// in-flight task are gone and cannot be recovered by wake().
//
// That makes an aggressive default actively destructive, which is why
// this is opt-in (Settings) and why the idle window is long. Treat these
// numbers as "reclaim resources from something the user has clearly
// abandoned", not "manage a working set".
const IDLE_TIMEOUT_MS = 30 * 60_000;  // 30 min idle before reclaiming
const MAX_ACTIVE = 12;                // concurrent PTY processes before eviction
const CHECK_INTERVAL_MS = 30_000;     // check every 30s
const REPLAY_MAX_CHARS = 200_000;     // scrollback replayed into the view on wake

export class HibernationManager {
  private sessions: Map<string, PtySession>;
  private getPty: () => typeof import('node-pty');
  private interval: ReturnType<typeof setInterval> | null = null;

  // Callbacks wired by main.ts
  onHibernate: (sessionId: string, agentId: string) => void = () => {};
  onWake: (sessionId: string, agentId: string) => void = () => {};

  constructor(sessions: Map<string, PtySession>, getPty: () => typeof import('node-pty')) {
    this.sessions = sessions;
    this.getPty = getPty;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.checkIdleSessions(), CHECK_INTERVAL_MS);
    console.log(`[Hibernation] Manager started (${IDLE_TIMEOUT_MS / 60_000}min idle timeout, max ${MAX_ACTIVE} active)`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /** Mark a session as having recent activity. */
  touch(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  /** Try to create a new active session — may auto-hibernate the oldest. */
  ensureSlot(): boolean {
    const active = this.getActiveCount();
    if (active < MAX_ACTIVE) return true;

    // Hibernate the oldest-active session
    const oldest = this.findLeastRecentlyUsed();
    if (oldest) {
      this.hibernate(oldest);
      return true;
    }
    return false;
  }

  /** Hibernate a specific session. */
  hibernate(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.hibernating || !session.pty) return false;

    console.log(`[Hibernation] Hibernating ${sessionId} (${session.name})`);
    try {
      session.pty.kill();
    } catch { /* already dead */ }
    session.pty = null;
    session.hibernating = true;
    session.lastActivity = Date.now();

    this.onHibernate(sessionId, session.agentId);
    return true;
  }

  /** Wake a hibernating session — spawns a new PTY and replays buffer. */
  async wake(sessionId: string, onData: (data: string) => void, onExit: (code: number, signal: number | undefined) => void): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.hibernating) return false;

    // Enforce max active
    if (!this.ensureSlot()) {
      console.warn(`[Hibernation] Cannot wake ${sessionId} — max active reached`);
      return false;
    }

    console.log(`[Hibernation] Waking ${sessionId} (${session.name})`);
    try {
      const pty = this.getPty();
      const shell = session.shell;
      const shellArgs = session.shellArgs;
      const shellEnv = session.shellEnv;

      const ptyProcess = pty.spawn(shell, shellArgs, {
        name: 'xterm-256color',
        cols: 140,
        rows: 40,
        cwd: process.cwd(),
        env: shellEnv ? { ...process.env, ...shellEnv } : process.env,
      });

      session.pty = ptyProcess;
      session.hibernating = false;
      session.lastActivity = Date.now();

      // Wire data forwarding
      ptyProcess.onData((data: string) => {
        session.lastActivity = Date.now();
        session.buffer.push(data);
        if (session.buffer.length > 2000) {
          session.buffer.splice(0, session.buffer.length - 2000);
        }
        onData(data);
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`[PTY] Session ${sessionId} exited (code=${exitCode}, signal=${signal})`);
        this.sessions.delete(sessionId);
        onExit(exitCode, signal);
      });

      // Surface the scrollback the user had before the process was killed.
      //
      // The previous implementation read session.buffer into `savedOutput`
      // and then never used it — it wrote a bare '\r\n' into the PTY,
      // which replays nothing and instead sends a stray keystroke to the
      // freshly spawned shell. Replay belongs on the *display* path:
      // writing history into the PTY would execute it.
      const savedOutput = session.buffer.join('');
      if (savedOutput) {
        onData(
          '\r\n\x1b[2m── previous output (process was stopped; this is a new shell) ──\x1b[0m\r\n' +
          savedOutput.slice(-REPLAY_MAX_CHARS) +
          '\r\n\x1b[2m── end of replay ──\x1b[0m\r\n',
        );
      }

      this.onWake(sessionId, session.agentId);
      return true;
    } catch (err) {
      console.error(`[Hibernation] Wake failed for ${sessionId}:`, err);
      session.hibernating = true; // Still sleeping
      return false;
    }
  }

  /** Get statistics about session resource usage. */
  getStats(): SessionStats {
    const active: string[] = [];
    const hibernating: string[] = [];
    const sessions: SessionStats['sessions'] = [];

    const now = Date.now();
    for (const [id, s] of this.sessions) {
      const idleSeconds = Math.round((now - s.lastActivity) / 1000);
      sessions.push({
        id,
        agentId: s.agentId,
        name: s.name,
        status: s.hibernating ? 'sleeping' : 'active',
        idleSeconds,
      });
      if (s.hibernating) {
        hibernating.push(id);
      } else {
        active.push(id);
      }
    }

    return {
      total: this.sessions.size,
      active: active.length,
      hibernating: hibernating.length,
      sessions,
    };
  }

  /** Number of currently active (non-hibernating) sessions. */
  getActiveCount(): number {
    let count = 0;
    for (const [, s] of this.sessions) {
      if (!s.hibernating) count++;
    }
    return count;
  }

  /** Find the least-recently-used active session.
   *
   *  Previously this picked the oldest-CREATED session, so the first agent
   *  you spawned was the first one killed — even if it was the one you
   *  were actively working in. Evicting by last activity is what the name
   *  "idle" implies and what the user expects. */
  private findLeastRecentlyUsed(): string | null {
    let lruId: string | null = null;
    let lruTime = Infinity;
    for (const [id, s] of this.sessions) {
      if (s.hibernating || !s.pty) continue;
      if (s.lastActivity < lruTime) {
        lruTime = s.lastActivity;
        lruId = id;
      }
    }
    return lruId;
  }

  /** Auto-hibernate sessions that have been idle too long. */
  private checkIdleSessions(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.hibernating) continue;
      if (!s.pty) {
        s.hibernating = true;
        continue;
      }
      const idleTime = now - s.lastActivity;
      if (idleTime > IDLE_TIMEOUT_MS) {
        console.log(`[Hibernation] Auto-hibernating ${id} (idle ${Math.round(idleTime / 1000)}s)`);
        this.hibernate(id);
      }
    }
  }
}
