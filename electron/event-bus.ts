// ── ORCH Event Bus ──────────────────────────────────────────────
// Lightweight in-memory event system for agent orchestration.
// Agents emit events, subscribe to event types, and the scheduler
// pushes relevant notifications to subscribed agents' terminals.
//
// Blackboard (task board): agents post task packets here instead of
// talking peer-to-peer. Any available agent can claim a pending task,
// preventing chaotic loops and cross-agent conflicts.

export interface OrchEvent {
  id: string;
  type: string;
  sourceAgentId: string;
  targetAgentId?: string;
  data: Record<string, unknown>;
  timestamp: number;
}

interface Subscription {
  agentId: string;
  eventTypes: string[];
}

// ── Blackboard types ───────────────────────────────────────────

export type TaskStatus = 'pending' | 'in-progress' | 'completed' | 'failed' | 'cancelled';

export interface BlackboardTask {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  sourceAgentId: string;          // who posted it
  claimantAgentId?: string;       // who picked it up
  delegationDepth: number;        // how deep in the delegation tree
  parentTaskId?: string;          // what task spawned this one
  contextSnapshot: string;        // JSON: shell path, env config, relevant artifact IDs
  result?: string;                // stdout / summary on completion
  error?: string;                 // error details on failure
  createdAt: number;
  claimedAt?: number;
  completedAt?: number;
  tags: string[];
}

const MAX_EVENTS = 500;
const MAX_TASKS = 200;
const MAX_DELEGATION_DEPTH = 3;   // hard cap: agent → agent → agent, then stop

export class EventBus {
  private events: OrchEvent[] = [];
  private subscriptions: Subscription[] = [];
  private nextId = 1;
  private nextTaskId = 1;

  // ── Blackboard task store ─────────────────────────────────────
  private tasks: BlackboardTask[] = [];

  /** Emit an event — stored in the log and checked against subscriptions. */
  emit(type: string, sourceAgentId: string, data: Record<string, unknown> = {}, targetAgentId?: string): OrchEvent {
    const event: OrchEvent = {
      id: `evt_${this.nextId++}`,
      type,
      sourceAgentId,
      targetAgentId,
      data,
      timestamp: Date.now(),
    };
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    return event;
  }

  /** Register an agent's interest in specific event types. */
  subscribe(agentId: string, eventTypes: string[]): void {
    const existing = this.subscriptions.find((s) => s.agentId === agentId);
    if (existing) {
      existing.eventTypes = [...new Set([...existing.eventTypes, ...eventTypes])];
    } else {
      this.subscriptions.push({ agentId, eventTypes });
    }
  }

  /** Remove all subscriptions for an agent. */
  unsubscribe(agentId: string): void {
    this.subscriptions = this.subscriptions.filter((s) => s.agentId !== agentId);
  }

  /** Get events matching a filter. */
  getEvents(opts?: {
    since?: number;
    eventTypes?: string[];
    sourceAgentId?: string;
    targetAgentId?: string;
    limit?: number;
  }): OrchEvent[] {
    let filtered = this.events;

    if (opts?.since) filtered = filtered.filter((e) => e.timestamp > opts.since!);
    if (opts?.eventTypes) filtered = filtered.filter((e) => opts.eventTypes!.includes(e.type));
    if (opts?.sourceAgentId) filtered = filtered.filter((e) => e.sourceAgentId === opts.sourceAgentId);
    if (opts?.targetAgentId) filtered = filtered.filter((e) => e.targetAgentId === opts.targetAgentId);

    const limit = opts?.limit ?? 50;
    return filtered.slice(-limit);
  }

  /** Find subscriptions that match an event. */
  findMatchingSubscriptions(event: OrchEvent): Subscription[] {
    return this.subscriptions.filter((s) => {
      if (s.agentId === event.sourceAgentId) return false; // don't notify self
      if (event.targetAgentId && s.agentId !== event.targetAgentId) return false; // targeted
      return s.eventTypes.length === 0 || s.eventTypes.includes(event.type);
    });
  }

  // ── Blackboard: Task delegation ──────────────────────────────

  /** Post a task to the blackboard. Returns the task, or null if depth cap hit. */
  postTask(
    title: string,
    description: string,
    sourceAgentId: string,
    contextSnapshot: string = '{}',
    parentTaskId?: string,
    delegationDepth: number = 0,
    tags: string[] = [],
  ): BlackboardTask | null {
    // Hard cap on delegation depth to prevent runaway chains
    if (delegationDepth >= MAX_DELEGATION_DEPTH) {
      console.warn(`[Blackboard] Delegation depth cap (${MAX_DELEGATION_DEPTH}) reached for task "${title}"`);
      return null;
    }

    const task: BlackboardTask = {
      id: `task_${this.nextTaskId++}`,
      title,
      description,
      status: 'pending',
      sourceAgentId,
      delegationDepth,
      parentTaskId,
      contextSnapshot,
      createdAt: Date.now(),
      tags,
    };
    this.tasks.push(task);
    if (this.tasks.length > MAX_TASKS) {
      this.tasks.splice(0, this.tasks.length - MAX_TASKS);
    }

    // Emit event so subscribed agents see it
    this.emit('task_posted', sourceAgentId, {
      taskId: task.id,
      title: task.title,
      delegationDepth,
      tags,
    });

    return task;
  }

  /** Claim a pending task. Returns the task or null if already claimed. */
  claimTask(taskId: string, claimantAgentId: string): BlackboardTask | null {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    if (task.status !== 'pending') return null; // already taken

    task.status = 'in-progress';
    task.claimantAgentId = claimantAgentId;
    task.claimedAt = Date.now();

    this.emit('task_claimed', claimantAgentId, {
      taskId,
      title: task.title,
      claimantAgentId,
    });

    return task;
  }

  /** Complete a task with a result. */
  completeTask(taskId: string, result: string): BlackboardTask | null {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return null;

    task.status = 'completed';
    task.result = result;
    task.completedAt = Date.now();

    this.emit('task_completed', task.claimantAgentId || 'unknown', {
      taskId,
      title: task.title,
      sourceAgentId: task.sourceAgentId,
      result: result.slice(0, 500),
    });

    return task;
  }

  /** Mark a task as failed. */
  failTask(taskId: string, error: string): BlackboardTask | null {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return null;

    task.status = 'failed';
    task.error = error;
    task.completedAt = Date.now();

    this.emit('task_failed', task.claimantAgentId || 'unknown', {
      taskId,
      title: task.title,
      sourceAgentId: task.sourceAgentId,
      error: error.slice(0, 500),
    });

    return task;
  }

  /** Cancel a pending or in-progress task. */
  cancelTask(taskId: string): BlackboardTask | null {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    if (task.status === 'completed' || task.status === 'failed') return null;

    task.status = 'cancelled';
    task.completedAt = Date.now();

    this.emit('task_cancelled', 'orch', {
      taskId,
      title: task.title,
    });

    return task;
  }

  /** Query blackboard tasks with filters. */
  queryTasks(opts?: {
    status?: TaskStatus | TaskStatus[];
    sourceAgentId?: string;
    claimantAgentId?: string;
    tags?: string[];
    since?: number;
    limit?: number;
  }): BlackboardTask[] {
    let filtered = this.tasks;

    if (opts?.status) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      filtered = filtered.filter((t) => statuses.includes(t.status));
    }
    if (opts?.sourceAgentId) filtered = filtered.filter((t) => t.sourceAgentId === opts.sourceAgentId);
    if (opts?.claimantAgentId) filtered = filtered.filter((t) => t.claimantAgentId === opts.claimantAgentId);
    if (opts?.tags) filtered = filtered.filter((t) => opts.tags!.some((tag) => t.tags.includes(tag)));
    if (opts?.since) filtered = filtered.filter((t) => t.createdAt > opts.since!);

    const limit = opts?.limit ?? 20;
    return filtered.slice(-limit);
  }

  /** Get a single task by ID. */
  getTask(taskId: string): BlackboardTask | undefined {
    return this.tasks.find((t) => t.id === taskId);
  }

  /** Get the max configured delegation depth. */
  getMaxDelegationDepth(): number {
    return MAX_DELEGATION_DEPTH;
  }

  /** Clear all events, subscriptions, and tasks. */
  reset(): void {
    this.events = [];
    this.subscriptions = [];
    this.tasks = [];
  }
}
