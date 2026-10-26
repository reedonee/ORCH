// ── ORCH Agent Mesh ─────────────────────────────────────────────
// Shared awareness between agents.
//
// ORCH's premise is several agents working on one codebase at once. That
// only beats "four separate terminals" if the agents know about each
// other. Previously they did not: there was an event bus, but nothing
// maintained a picture of who was doing what, and the only inter-agent
// channel was a substring scan of terminal output that fired whenever one
// agent's name appeared in another's stdout.
//
// This module owns three things:
//
//   1. STATUS   — what each agent says it is working on, right now
//   2. INBOX    — durable, addressed messages between agents
//   3. ACTIVITY — a derived digest, for the canvas flip view
//
// Status is self-reported rather than inferred. Guessing intent from
// terminal output is unreliable in exactly the cases that matter (a long
// build, a paused prompt), and an agent that says "refactoring the auth
// module" is far more useful to its peers than a scraped last line.

export type AgentPhase =
  | 'idle'        // no task
  | 'working'     // actively on something
  | 'blocked'     // waiting on input or another agent
  | 'done'        // finished, result available
  | 'failed';     // gave up

export interface AgentStatus {
  agentId: string;
  name: string;
  providerId: string;
  phase: AgentPhase;
  /** One line, present tense: "refactoring the auth module". */
  task: string;
  /** Longer detail, shown when the user asks for it. */
  detail?: string;
  /** 0-100 when the agent can estimate it. */
  progress?: number;
  /** Files this agent is touching — used for conflict detection. */
  files: string[];
  /** Free-form tags for grouping. */
  tags: string[];
  updatedAt: number;
  startedAt: number;
}

export interface AgentMessage {
  id: string;
  from: string;          // agentId
  fromName: string;
  /** Target agentId, or null to broadcast. */
  to: string | null;
  toName?: string;
  subject: string;
  body: string;
  /** A question expects a reply; a note does not. */
  kind: 'note' | 'question' | 'answer' | 'handoff';
  /** Set on an answer, pointing at the question it responds to. */
  replyTo?: string;
  createdAt: number;
  readAt?: number;
  /** True once delivered into the recipient's terminal. */
  delivered: boolean;
}

const MAX_MESSAGES = 1000;

export interface FileConflict {
  file: string;
  agents: Array<{ agentId: string; name: string }>;
}

export class AgentMesh {
  private statuses = new Map<string, AgentStatus>();
  private messages: AgentMessage[] = [];
  private nextMessageId = 1;

  /** Notified on every change so the main process can push to the UI. */
  onStatusChange: (status: AgentStatus) => void = () => {};
  onMessage: (message: AgentMessage) => void = () => {};

  // ── Status ────────────────────────────────────────────────────

  /** Register an agent as present. Called when a session is created. */
  register(agentId: string, name: string, providerId: string): AgentStatus {
    const existing = this.statuses.get(agentId);
    if (existing) return existing;
    const status: AgentStatus = {
      agentId, name, providerId,
      phase: 'idle',
      task: '',
      files: [],
      tags: [],
      updatedAt: Date.now(),
      startedAt: Date.now(),
    };
    this.statuses.set(agentId, status);
    this.onStatusChange(status);
    return status;
  }

  unregister(agentId: string): void {
    this.statuses.delete(agentId);
  }

  /** Update what an agent reports it is doing. Partial — omitted fields keep
   *  their previous value, so an agent can report progress without
   *  restating its whole task. */
  setStatus(
    agentId: string,
    patch: Partial<Pick<AgentStatus, 'phase' | 'task' | 'detail' | 'progress' | 'files' | 'tags'>>,
  ): AgentStatus | null {
    const status = this.statuses.get(agentId);
    if (!status) return null;

    if (patch.phase !== undefined) status.phase = patch.phase;
    if (patch.task !== undefined) status.task = patch.task.slice(0, 300);
    if (patch.detail !== undefined) status.detail = patch.detail.slice(0, 4000);
    if (patch.progress !== undefined) {
      status.progress = Math.max(0, Math.min(100, patch.progress));
    }
    if (patch.files !== undefined) status.files = patch.files.slice(0, 100);
    if (patch.tags !== undefined) status.tags = patch.tags.slice(0, 20);

    // Starting fresh work resets the clock, so "working for 40 minutes"
    // means this task, not this session.
    if (patch.phase === 'working' && patch.task) status.startedAt = Date.now();

    status.updatedAt = Date.now();
    this.onStatusChange(status);
    return status;
  }

  getStatus(agentId: string): AgentStatus | undefined {
    return this.statuses.get(agentId);
  }

  allStatuses(): AgentStatus[] {
    return [...this.statuses.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Agents touching the same file.
   *
   * This is the single most valuable thing shared awareness buys: two
   * agents editing one file will silently clobber each other, and neither
   * can detect it alone.
   */
  fileConflicts(): FileConflict[] {
    const byFile = new Map<string, Array<{ agentId: string; name: string }>>();
    for (const s of this.statuses.values()) {
      if (s.phase !== 'working') continue;
      for (const raw of s.files) {
        // Normalise separators so a Windows and POSIX spelling of the
        // same path are recognised as one file.
        const file = raw.replace(/\\/g, '/').toLowerCase();
        const list = byFile.get(file) ?? [];
        list.push({ agentId: s.agentId, name: s.name });
        byFile.set(file, list);
      }
    }
    return [...byFile.entries()]
      .filter(([, agents]) => agents.length > 1)
      .map(([file, agents]) => ({ file, agents }));
  }

  // ── Messaging ─────────────────────────────────────────────────

  send(msg: Omit<AgentMessage, 'id' | 'createdAt' | 'delivered'>): AgentMessage {
    const message: AgentMessage = {
      ...msg,
      id: `msg_${this.nextMessageId++}`,
      createdAt: Date.now(),
      delivered: false,
    };
    this.messages.push(message);
    if (this.messages.length > MAX_MESSAGES) {
      this.messages.splice(0, this.messages.length - MAX_MESSAGES);
    }
    this.onMessage(message);
    return message;
  }

  markDelivered(id: string): void {
    const m = this.messages.find((x) => x.id === id);
    if (m) m.delivered = true;
  }

  /** Messages addressed to an agent (or broadcast), newest last. */
  inbox(agentId: string, opts?: { unreadOnly?: boolean; limit?: number }): AgentMessage[] {
    const limit = opts?.limit ?? 50;
    return this.messages
      .filter((m) => (m.to === agentId || m.to === null) && m.from !== agentId)
      .filter((m) => !opts?.unreadOnly || !m.readAt)
      .slice(-limit);
  }

  markRead(agentId: string, ids?: string[]): number {
    let n = 0;
    for (const m of this.messages) {
      if (m.to !== agentId && m.to !== null) continue;
      if (ids && !ids.includes(m.id)) continue;
      if (!m.readAt) { m.readAt = Date.now(); n++; }
    }
    return n;
  }

  /** Whole conversation, for the activity view. */
  recentMessages(limit = 100): AgentMessage[] {
    return this.messages.slice(-limit);
  }

  // ── Digest ────────────────────────────────────────────────────

  /**
   * One-line summaries for the flip view.
   *
   * Deliberately terse: this renders on the back of every card at once,
   * so it has to be scannable in a second, not read.
   */
  digest(): Array<{
    agentId: string;
    name: string;
    providerId: string;
    phase: AgentPhase;
    task: string;
    detail?: string;
    progress?: number;
    files: string[];
    elapsedMs: number;
    unread: number;
    conflicts: string[];
  }> {
    const conflicts = this.fileConflicts();
    const now = Date.now();

    return this.allStatuses().map((s) => ({
      agentId: s.agentId,
      name: s.name,
      providerId: s.providerId,
      phase: s.phase,
      task: s.task || (s.phase === 'idle' ? 'Waiting for work' : ''),
      detail: s.detail,
      progress: s.progress,
      files: s.files,
      elapsedMs: now - s.startedAt,
      unread: this.inbox(s.agentId, { unreadOnly: true }).length,
      conflicts: conflicts
        .filter((c) => c.agents.some((a) => a.agentId === s.agentId))
        .map((c) => c.file),
    }));
  }

  reset(): void {
    this.statuses.clear();
    this.messages = [];
    this.nextMessageId = 1;
  }
}
