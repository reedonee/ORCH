// ── ORCH MCP Sync ───────────────────────────────────────────────
// The pieces that keep agents — the controller above all — in step with
// ORCH as it changes, and that let a model name things the way a person
// would instead of by internal id.
//
//   SyncJournal      every state change, numbered. A cursor is the last
//                    number you saw; asking "what since N" can never miss
//                    or repeat an event, which polling a snapshot can.
//   resolveAgentRef  "max", "Max - Claude Code", an id, "me", "orch".
//   identity         which agent a connection belongs to.
//
// Pure, no Electron or MCP SDK imports: tests/mcp-server.check.mts and
// tests/mcp-sync.check.mts drive it directly.

export interface SyncEvent {
  seq: number;
  at: number;
  /** agent_status, agent_message, approval_pending, agent_joined, … */
  type: string;
  /** The agent the event is about, when there is one. */
  agentId?: string;
  agentName?: string;
  /** One line a model can read without parsing `data`. */
  summary: string;
  data?: Record<string, unknown>;
  /** Only this agent should be told (a direct message). Omitted = everyone. */
  audience?: string;
}

export type SyncFilter = (e: SyncEvent) => boolean;

export interface SyncBatch {
  events: SyncEvent[];
  /** Pass this back next time. */
  cursor: number;
  /** True when events between your cursor and the oldest kept one were
   *  dropped: take a fresh snapshot rather than trusting the gap. */
  missed: boolean;
}

interface Waiter {
  cursor: number;
  filter?: SyncFilter;
  resolve: (batch: SyncBatch) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SyncJournal {
  private events: SyncEvent[] = [];
  private nextSeq = 1;
  private waiters = new Set<Waiter>();
  private listeners = new Set<(e: SyncEvent) => void>();
  private readonly max: number;

  constructor(max = 2000) {
    this.max = max;
  }

  /** Sequence number of the newest event (0 when empty). */
  get cursor(): number {
    return this.nextSeq - 1;
  }

  append(e: Omit<SyncEvent, 'seq' | 'at'>, now = Date.now()): SyncEvent {
    const event: SyncEvent = { ...e, seq: this.nextSeq++, at: now };
    this.events.push(event);
    if (this.events.length > this.max) this.events.splice(0, this.events.length - this.max);
    for (const w of [...this.waiters]) {
      const batch = this.since(w.cursor, w.filter);
      if (batch.events.length || batch.missed) this.settle(w, batch);
    }
    for (const l of this.listeners) {
      try { l(event); } catch { /* a listener must not break the journal */ }
    }
    return event;
  }

  since(cursor: number, filter?: SyncFilter, limit = 200): SyncBatch {
    const oldest = this.events[0]?.seq ?? this.nextSeq;
    const missed = cursor < oldest - 1;
    const newer = this.events.filter((e) => e.seq > cursor && (!filter || filter(e)));
    const events = newer.slice(-limit);
    // With a filter, unmatched events are still "seen": the cursor moves
    // to the head so they are not re-scanned forever.
    return { events, cursor: this.cursor, missed };
  }

  /** Resolve as soon as something newer than `cursor` matches, or with an
   *  empty batch at `timeoutMs`. This is what makes sync real-time without
   *  the caller spinning. */
  waitFor(cursor: number, timeoutMs: number, filter?: SyncFilter): Promise<SyncBatch> {
    const now = this.since(cursor, filter);
    if (now.events.length || now.missed || timeoutMs <= 0) return Promise.resolve(now);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        cursor, filter, resolve,
        timer: setTimeout(() => this.settle(waiter, this.since(cursor, filter)), timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  onAppend(listener: (e: SyncEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Release every pending wait — on shutdown, so no request hangs. */
  close(): void {
    for (const w of [...this.waiters]) this.settle(w, this.since(w.cursor, w.filter));
  }

  private settle(w: Waiter, batch: SyncBatch) {
    if (!this.waiters.delete(w)) return;
    clearTimeout(w.timer);
    w.resolve(batch);
  }
}

/** Events an agent should be told about: broadcast ones, and ones meant
 *  for it. Never its own echo. */
export function relevantTo(agentId: string | undefined): SyncFilter {
  return (e) => (!e.audience || e.audience === agentId) && !(e.type === 'agent_status' && e.agentId === agentId);
}

/** Render events as compact lines for a model's context window. */
export function formatEvents(events: SyncEvent[], max = 12): string {
  const shown = events.slice(-max);
  const lines = shown.map((e) => `- #${e.seq} ${e.summary}`);
  if (events.length > shown.length) lines.unshift(`- … ${events.length - shown.length} earlier`);
  return lines.join('\n');
}

// ── Naming agents ───────────────────────────────────────────────

export interface KnownAgent {
  agentId: string;
  name: string;
  providerId?: string;
}

/** Words a model uses for ORCH itself, or for whoever runs the canvas. */
export const ORCH_ALIASES = ['orch', 'controller', 'coordinator', 'master', 'user', 'human', 'operator'];
const SELF_ALIASES = ['me', 'self', 'myself', 'i'];

export type AgentRef =
  | { kind: 'agent'; agent: KnownAgent }
  | { kind: 'orch' }
  | { kind: 'unknown'; reason: string };

/** "Max - Claude Code" → "max". */
export function shortAgentName(name: string): string {
  return name.split(' - ')[0].trim().toLowerCase();
}

/**
 * Resolve how a model referred to an agent. Exact id first, then full
 * name, then short name, then a unique prefix of a short name; anything
 * ambiguous is refused rather than guessed, because acting on the wrong
 * agent is worse than asking again.
 */
export function resolveAgentRef(ref: unknown, agents: KnownAgent[], callerId?: string): AgentRef {
  if (typeof ref !== 'string' || !ref.trim()) return { kind: 'unknown', reason: 'no agent named' };
  const raw = ref.trim();
  const q = raw.toLowerCase().replace(/^@/, '');

  if (SELF_ALIASES.includes(q)) {
    const me = agents.find((a) => a.agentId === callerId);
    return me ? { kind: 'agent', agent: me } : { kind: 'unknown', reason: 'this connection is not linked to an agent' };
  }
  if (ORCH_ALIASES.includes(q)) return { kind: 'orch' };

  const byId = agents.find((a) => a.agentId === raw);
  if (byId) return { kind: 'agent', agent: byId };
  const byName = agents.filter((a) => a.name.toLowerCase() === q);
  if (byName.length === 1) return { kind: 'agent', agent: byName[0] };
  const byShort = agents.filter((a) => shortAgentName(a.name) === q);
  if (byShort.length === 1) return { kind: 'agent', agent: byShort[0] };
  if (byShort.length > 1) return { kind: 'unknown', reason: `"${raw}" matches ${byShort.length} agents; use the id` };
  const byPrefix = q.length >= 2 ? agents.filter((a) => shortAgentName(a.name).startsWith(q)) : [];
  if (byPrefix.length === 1) return { kind: 'agent', agent: byPrefix[0] };
  if (byPrefix.length > 1) return { kind: 'unknown', reason: `"${raw}" could be ${byPrefix.map((a) => a.name).join(' or ')}` };
  return { kind: 'unknown', reason: `no agent called "${raw}"` };
}

/** "Known agents: Max (id …), Sky (id …)" — appended to every miss so the
 *  model can correct itself in one step. */
export function knownAgentsLine(agents: KnownAgent[]): string {
  if (agents.length === 0) return 'There are no agents on the canvas.';
  return 'Known agents: ' + agents.map((a) => `${a.name} (id ${a.agentId})`).join(', ');
}

// ── Connection identity ─────────────────────────────────────────

/** Which agent a request belongs to: X-Orch-Agent-Id, else ?agent=. */
export function identityFromRequest(
  headers: Record<string, string | string[] | undefined>,
  url: URL,
): string | undefined {
  const h = headers['x-orch-agent-id'];
  const fromHeader = Array.isArray(h) ? h[0] : h;
  // Hermes sends the literal placeholder when ORCH_AGENT_ID is unset.
  const clean = (v: string | null | undefined) => (v && !v.includes('${') ? v.trim() : undefined) || undefined;
  return clean(fromHeader) ?? clean(url.searchParams.get('agent'));
}
