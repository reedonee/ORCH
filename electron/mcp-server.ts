// ── ORCH MCP Server ─────────────────────────────────────────────
// SSE-based MCP server inside Electron's main process.
// Exposes canvas state, agent control, terminal ops, event bus,
// blackboard delegation, and memory recall as MCP tools.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import http from 'http';
import { EventBus } from './event-bus.js';
import { ArtifactRegistry } from './artifact-registry.js';

// ── Tool definitions ────────────────────────────────────────────

const TOOLS: Tool[] = [
  // ── Canvas tools ────────────────────────────────────────────
  {
    name: 'canvas_get_state',
    description: 'Get the full canvas state: all agents, positions, statuses, selected agent, viewport.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'canvas_get_elements',
    description: 'Get all canvas workspace elements: drawings, shapes, text notes, and images on the infinite canvas.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'canvas_get_agent',
    description: 'Get details about a specific agent: name, status, position, terminal output.',
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string', description: 'The agent ID' } },
      required: ['agentId'],
    },
  },
  {
    name: 'canvas_move_agent',
    description: 'Move an agent card to an absolute position on the canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID to move' },
        x: { type: 'number', description: 'Target X' },
        y: { type: 'number', description: 'Target Y' },
      },
      required: ['agentId', 'x', 'y'],
    },
  },
  {
    name: 'canvas_send_message',
    description: 'Type a message into an agent terminal and press Enter.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Target agent ID' },
        message: { type: 'string', description: 'Text to send' },
      },
      required: ['agentId', 'message'],
    },
  },
  {
    name: 'canvas_read_output',
    description: 'Read recent output from an agent terminal buffer.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent ID' },
        lines: { type: 'number', description: 'Recent lines (default 50, max 200)', default: 50 },
      },
      required: ['agentId'],
    },
  },
  {
    name: 'canvas_create_agent',
    description: 'Create a new agent card and start its terminal session.',
    inputSchema: {
      type: 'object',
      properties: {
        providerId: { type: 'string', description: 'Provider ID: hermes, claude-code, codex, opencode, cursor, antigravity' },
        name: { type: 'string', description: 'Optional custom agent name' },
        contextSnapshot: { type: 'string', description: 'Optional JSON context snapshot: shell path, env, artifact IDs for warm handoff' },
      },
      required: ['providerId'],
    },
  },
  {
    name: 'canvas_remove_agent',
    description: 'Remove an agent card and kill its terminal session.',
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string', description: 'Agent ID to remove' } },
      required: ['agentId'],
    },
  },
  {
    name: 'canvas_list_sessions',
    description: 'List all active PTY sessions and their statuses.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  // ── Event Bus tools ──────────────────────────────────────────
  {
    name: 'canvas_emit_event',
    description: 'Emit an event to the ORCH event bus. Other subscribed agents will be notified.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Event type (e.g. task_complete, file_created, error, status_change)' },
        data: { type: 'object', description: 'Event payload (arbitrary key-value pairs)', additionalProperties: true },
        sourceAgentId: { type: 'string', description: 'Your agent ID (the emitter)' },
        targetAgentId: { type: 'string', description: 'Optional: target a specific agent instead of broadcasting' },
      },
      required: ['type'],
    },
  },
  {
    name: 'canvas_get_events',
    description: 'Get recent events from the event bus. Filter by type, source, or time.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'number', description: 'Unix timestamp — only events after this time' },
        eventTypes: { type: 'array', items: { type: 'string' }, description: 'Filter by event types' },
        limit: { type: 'number', description: 'Max events to return (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'canvas_subscribe',
    description: 'Subscribe this agent to specific event types. Matching events trigger terminal notifications.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceAgentId: { type: 'string', description: 'Your agent ID' },
        eventTypes: { type: 'array', items: { type: 'string' }, description: 'Event types to subscribe to (empty = all events)' },
      },
      required: [],
    },
  },
  // ── Blackboard / Delegation tools ───────────────────────────
  {
    name: 'delegate_task',
    description: 'Post a task to the ORCH blackboard. Any available agent can claim it. Delegation depth is auto-tracked to prevent runaway chains (capped at 3).',
    inputSchema: {
      type: 'object',
      properties: {
        sourceAgentId: { type: 'string', description: 'Your agent ID (the delegator)' },
        title: { type: 'string', description: 'Short task title' },
        description: { type: 'string', description: 'Detailed task description with what needs to be done' },
        contextSnapshot: { type: 'string', description: 'Optional JSON context: shell path, relevant artifact IDs, environmental config for warm handoff' },
        parentTaskId: { type: 'string', description: 'Optional parent task ID if this is a sub-task' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization' },
      },
      required: ['sourceAgentId', 'title', 'description'],
    },
  },
  {
    name: 'claim_task',
    description: 'Claim a pending task from the blackboard. Only pending tasks can be claimed.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to claim' },
        claimantAgentId: { type: 'string', description: 'Your agent ID' },
      },
      required: ['taskId', 'claimantAgentId'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a claimed task as completed with a result summary.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to complete' },
        result: { type: 'string', description: 'Result summary of what was done' },
      },
      required: ['taskId', 'result'],
    },
  },
  {
    name: 'fail_task',
    description: 'Mark a claimed task as failed with an error description.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to fail' },
        error: { type: 'string', description: 'Error details' },
      },
      required: ['taskId', 'error'],
    },
  },
  {
    name: 'query_tasks',
    description: 'Query blackboard tasks. Filter by status, source, claimant, or tags.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['pending', 'in-progress', 'completed', 'failed', 'cancelled'], description: 'Filter by status' },
        sourceAgentId: { type: 'string', description: 'Filter by delegator agent ID' },
        claimantAgentId: { type: 'string', description: 'Filter by claimant agent ID' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'get_task',
    description: 'Get a single blackboard task by ID with full details.',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string', description: 'Task ID' } },
      required: ['taskId'],
    },
  },
  // ── Artifact / Memory tools ─────────────────────────────────
  {
    name: 'canvas_store_artifact',
    description: 'Store a structured artifact (file produced, summary, result, status update). Use instead of dumping raw terminal output for other agents to read.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceAgentId: { type: 'string', description: 'Your agent ID' },
        type: { type: 'string', enum: ['file', 'summary', 'status', 'error', 'result', 'message'], description: 'Artifact type' },
        title: { type: 'string', description: 'Short title' },
        description: { type: 'string', description: 'Detailed description (keep concise — this is what other agents see)' },
        data: { type: 'object', description: 'Structured payload (e.g. file paths, error details, test results)', additionalProperties: true },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for filtering' },
      },
      required: ['sourceAgentId', 'type', 'title'],
    },
  },
  {
    name: 'canvas_store_memory',
    description: 'Store an episodic memory artifact with structured intent/outcome/mutations. Richer than a basic artifact — used for contextual recall.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceAgentId: { type: 'string', description: 'Your agent ID' },
        taskIntent: { type: 'string', description: 'What you were trying to accomplish' },
        outcome: { type: 'string', enum: ['success', 'failure', 'cancelled', 'unknown'], description: 'How it went' },
        criticalFilesMutated: { type: 'array', items: { type: 'string' }, description: 'Files that were created/changed' },
        errorsEncountered: { type: 'array', items: { type: 'string' }, description: 'Errors you hit and solved' },
        workspaceKeywords: { type: 'array', items: { type: 'string' }, description: 'Keywords for contextual recall matching' },
        delegationDepth: { type: 'number', description: 'Current delegation depth (default 0)' },
        extraData: { type: 'object', description: 'Any extra structured data', additionalProperties: true },
      },
      required: ['sourceAgentId', 'taskIntent', 'outcome'],
    },
  },
  {
    name: 'canvas_get_artifacts',
    description: 'Query artifacts from the shared registry. Filter by agent, type, or tags.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Filter by source agent' },
        types: { type: 'array', items: { type: 'string' }, description: 'Filter by artifact types' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'canvas_get_artifact',
    description: 'Get a specific artifact by its ID.',
    inputSchema: {
      type: 'object',
      properties: { artifactId: { type: 'string', description: 'Artifact ID (e.g. art_42)' } },
      required: ['artifactId'],
    },
  },
  {
    name: 'canvas_recall',
    description: 'Contextual memory recall — find past artifacts and memories relevant to your current task keywords. Agents should call this at startup to understand what has already been done.',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to match against tags, titles, descriptions (e.g. ["electron", "sidecar", "voice"])' },
        agentId: { type: 'string', description: 'Optional: limit to a specific agent\'s artifacts' },
        types: { type: 'array', items: { type: 'string' }, description: 'Optional: filter by artifact types' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['keywords'],
    },
  },
  // ── Provider tools ─────────────────────────────────────────
  {
    name: 'list_providers',
    description: 'List all available providers and their statuses.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ── MCP Server ──────────────────────────────────────────────────

import type { PtySession } from './hibernation.js';

export class OrchMcpServer {
  private mcpServer: Server;
  private httpServer: http.Server | null = null;
  private transport: SSEServerTransport | null = null;
  private port = 0;
  private sessions: Map<string, PtySession>;
  public eventBus: EventBus;
  public artifactRegistry: ArtifactRegistry;

  // Callbacks wired by main.ts
  getCanvasState: () => Promise<any> = async () => ({});
  getCanvasElements: () => Promise<any[]> = async () => [];
  getAgent: (id: string) => Promise<any> = async () => ({});
  moveAgent: (id: string, x: number, y: number) => Promise<void> = async () => {};
  sendToAgent: (id: string, text: string) => Promise<void> = async () => {};
  readAgentOutput: (id: string, lines?: number) => Promise<string> = async () => '';
  createAgent: (providerId: string, name?: string, contextSnapshot?: string) => Promise<any> = async () => ({});
  removeAgent: (id: string) => Promise<void> = async () => {};
  /** Get the agent ID associated with a PTY session ID */
  getSessionAgentId: (sessionId: string) => string | undefined = () => undefined;
  /** Get available providers */
  getProviders: () => any[] = () => [];

  constructor(sessions: Map<string, PtySession>) {
    this.sessions = sessions;
    this.eventBus = new EventBus();
    this.artifactRegistry = new ArtifactRegistry();

    this.mcpServer = new Server(
      { name: 'orch-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    this.setupHandlers();
  }

  async start(): Promise<number> {
    return new Promise((resolve) => {
      this.httpServer = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        this.handleRequest(req, res);
      });

      this.httpServer.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address();
        this.port = typeof addr === 'object' ? addr.port : 0;
        console.log(`[MCP] Server on http://127.0.0.1:${this.port}/sse`);
        resolve(this.port);
      });
    });
  }

  async stop() {
    if (this.httpServer) this.httpServer.close();
    await this.mcpServer.close();
  }

  get url() { return `http://127.0.0.1:${this.port}/sse`; }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/sse') {
      this.transport = new SSEServerTransport('/messages', res);
      this.mcpServer.connect(this.transport).catch((err) =>
        console.error('[MCP] SSE error:', err)
      );
    } else if (req.method === 'POST' && url.pathname === '/messages') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (this.transport) {
          try {
            this.transport.handlePostMessage(req, res, JSON.parse(body));
          } catch { res.writeHead(400); res.end('Bad request'); }
        } else {
          res.writeHead(400); res.end('No SSE session');
        }
      });
    } else if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', port: this.port, tools: TOOLS.map((t) => t.name) }));
    } else {
      res.writeHead(404); res.end();
    }
  }

  // ── Scheduler: push event notifications to subscribed agents ──
  private scheduleEventNotification(event: import('./event-bus.js').OrchEvent): void {
    const subs = this.eventBus.findMatchingSubscriptions(event);
    for (const sub of subs) {
      // Find the PTY session for this subscribed agent
      for (const [, session] of this.sessions) {
        if (session.agentId === sub.agentId) {
          const summary = JSON.stringify(event.data).slice(0, 200);
          const msg = `\r\n\x1b[33m[ORCH] Event: ${event.type} from ${event.sourceAgentId} → ${summary}\x1b[0m\r\n`;
          session.pty.write(msg);
          break;
        }
      }
    }
  }

  private setupHandlers() {
    this.mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    this.mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        switch (name) {
          case 'canvas_get_state':
            return { content: [{ type: 'text' as const, text: JSON.stringify(await this.getCanvasState(), null, 2) }] };

          case 'canvas_get_elements':
            return { content: [{ type: 'text' as const, text: JSON.stringify(this.getCanvasElements(), null, 2) }] };

          case 'canvas_get_agent': {
            const agent = await this.getAgent(args.agentId as string);
            const output = await this.readAgentOutput(args.agentId as string);
            return {
              content: [
                { type: 'text' as const, text: JSON.stringify(agent, null, 2) },
                { type: 'text' as const, text: `\n--- Terminal output ---\n${output}` },
              ],
            };
          }

          case 'canvas_move_agent':
            await this.moveAgent(args.agentId as string, args.x as number, args.y as number);
            return { content: [{ type: 'text' as const, text: `Moved ${args.agentId} → (${args.x}, ${args.y})` }] };

          case 'canvas_send_message':
            await this.sendToAgent(args.agentId as string, args.message as string);
            return { content: [{ type: 'text' as const, text: `Message sent to ${args.agentId}` }] };

          case 'canvas_read_output':
            return { content: [{ type: 'text' as const, text: await this.readAgentOutput(args.agentId as string, (args.lines as number) || 50) }] };

          case 'canvas_create_agent':
            return { content: [{ type: 'text' as const, text: JSON.stringify(
              await this.createAgent(
                args.providerId as string,
                args.name as string | undefined,
                args.contextSnapshot as string | undefined,
              ), null, 2) }] };

          case 'canvas_remove_agent':
            await this.removeAgent(args.agentId as string);
            return { content: [{ type: 'text' as const, text: `Agent ${args.agentId} removed` }] };

          case 'canvas_list_sessions':
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify(
                  Array.from(this.sessions.entries()).map(([id, s]) => ({
                    id, agentId: s.agentId, name: s.name, kind: s.kind, bufferLength: s.buffer.length,
                  })),
                  null, 2,
                ),
              }],
            };

          // ── Event Bus tools ──────────────────────────────────
          case 'canvas_emit_event': {
            const event = this.eventBus.emit(
              args.type as string,
              (args.sourceAgentId as string) || 'orch',
              (args.data as Record<string, unknown>) || {},
              args.targetAgentId as string | undefined,
            );
            this.scheduleEventNotification(event);
            return { content: [{ type: 'text' as const, text: `Event ${event.id} emitted` }] };
          }

          case 'canvas_get_events': {
            const events = this.eventBus.getEvents({
              since: args.since as number | undefined,
              eventTypes: args.eventTypes as string[] | undefined,
              limit: (args.limit as number) || 20,
            });
            return { content: [{ type: 'text' as const, text: JSON.stringify(events, null, 2) }] };
          }

          case 'canvas_subscribe': {
            const agentId = (args.sourceAgentId as string) || 'orch';
            const types = args.eventTypes as string[];
            this.eventBus.subscribe(agentId, types || []);
            const label = types?.length ? types.join(', ') : 'all events';
            return { content: [{ type: 'text' as const, text: `Subscribed ${agentId} to ${label}` }] };
          }

          // ── Blackboard / Delegation tools ────────────────────
          case 'delegate_task': {
            const sourceAgentId = args.sourceAgentId as string;
            const title = args.title as string;
            const description = args.description as string;

            // Determine delegation depth: if parentTaskId is set, look it up
            let delegationDepth = 0;
            const parentTaskId = args.parentTaskId as string | undefined;
            if (parentTaskId) {
              const parent = this.eventBus.getTask(parentTaskId);
              if (parent) {
                delegationDepth = parent.delegationDepth + 1;
              }
            }

            const task = this.eventBus.postTask(
              title,
              description,
              sourceAgentId,
              (args.contextSnapshot as string) || JSON.stringify({}),
              parentTaskId,
              delegationDepth,
              (args.tags as string[]) || [],
            );

            if (!task) {
              return {
                content: [{ type: 'text' as const, text: `Delegation rejected: max depth (${this.eventBus.getMaxDelegationDepth()}) reached. Cannot delegate further.` }],
                isError: true,
              };
            }

            // Emit a delegation event visible to the frontend
            this.eventBus.emit('delegation_created', sourceAgentId, {
              taskId: task.id,
              title: task.title,
              delegationDepth: task.delegationDepth,
              parentTaskId,
            });

            return { content: [{ type: 'text' as const, text: JSON.stringify(task, null, 2) }] };
          }

          case 'claim_task': {
            const task = this.eventBus.claimTask(
              args.taskId as string,
              args.claimantAgentId as string,
            );
            if (!task) {
              return { content: [{ type: 'text' as const, text: 'Task not found or already claimed' }], isError: true };
            }
            return { content: [{ type: 'text' as const, text: JSON.stringify(task, null, 2) }] };
          }

          case 'complete_task': {
            const task = this.eventBus.completeTask(
              args.taskId as string,
              args.result as string,
            );
            if (!task) {
              return { content: [{ type: 'text' as const, text: 'Task not found' }], isError: true };
            }
            // Auto-store a memory artifact on completion
            this.artifactRegistry.storeMemory(
              task.claimantAgentId || 'unknown',
              task.title,
              'success',
              [], // files — would come from result parsing in production
              [],
              task.tags,
              task.delegationDepth,
              { taskId: task.id, result: (args.result as string).slice(0, 2000) },
            );
            return { content: [{ type: 'text' as const, text: JSON.stringify(task, null, 2) }] };
          }

          case 'fail_task': {
            const task = this.eventBus.failTask(
              args.taskId as string,
              args.error as string,
            );
            if (!task) {
              return { content: [{ type: 'text' as const, text: 'Task not found' }], isError: true };
            }
            // Auto-store a failure memory artifact
            this.artifactRegistry.storeMemory(
              task.claimantAgentId || 'unknown',
              task.title,
              'failure',
              [],
              [(args.error as string).slice(0, 500)],
              task.tags,
              task.delegationDepth,
              { taskId: task.id },
            );
            return { content: [{ type: 'text' as const, text: JSON.stringify(task, null, 2) }] };
          }

          case 'query_tasks': {
            const tasks = this.eventBus.queryTasks({
              status: args.status as any,
              sourceAgentId: args.sourceAgentId as string | undefined,
              claimantAgentId: args.claimantAgentId as string | undefined,
              tags: args.tags as string[] | undefined,
              limit: (args.limit as number) || 20,
            });
            return { content: [{ type: 'text' as const, text: JSON.stringify(tasks, null, 2) }] };
          }

          case 'get_task': {
            const task = this.eventBus.getTask(args.taskId as string);
            return { content: [{ type: 'text' as const, text: task ? JSON.stringify(task, null, 2) : 'Not found' }] };
          }

          // ── Artifact / Memory tools ──────────────────────────
          case 'canvas_store_artifact': {
            const artifact = this.artifactRegistry.create(
              args.sourceAgentId as string,
              args.type as any,
              args.title as string,
              (args.description as string) || '',
              (args.data as Record<string, unknown>) || {},
              (args.tags as string[]) || [],
            );
            this.eventBus.emit('artifact_created', args.sourceAgentId as string, {
              artifactId: artifact.id,
              type: artifact.type,
              title: artifact.title,
            });
            return { content: [{ type: 'text' as const, text: JSON.stringify(artifact, null, 2) }] };
          }

          case 'canvas_store_memory': {
            const memory = this.artifactRegistry.storeMemory(
              args.sourceAgentId as string,
              args.taskIntent as string,
              args.outcome as any,
              (args.criticalFilesMutated as string[]) || [],
              (args.errorsEncountered as string[]) || [],
              (args.workspaceKeywords as string[]) || [],
              (args.delegationDepth as number) || 0,
              (args.extraData as Record<string, unknown>) || {},
            );
            this.eventBus.emit('memory_created', args.sourceAgentId as string, {
              artifactId: memory.id,
              taskIntent: memory.data.taskIntent,
              outcome: memory.data.outcome,
            });
            return { content: [{ type: 'text' as const, text: JSON.stringify(memory, null, 2) }] };
          }

          case 'canvas_get_artifacts': {
            const artifacts = this.artifactRegistry.query({
              agentId: args.agentId as string | undefined,
              types: args.types as any[] | undefined,
              tags: args.tags as string[] | undefined,
              limit: (args.limit as number) || 20,
            });
            return { content: [{ type: 'text' as const, text: JSON.stringify(artifacts, null, 2) }] };
          }

          case 'canvas_get_artifact': {
            const a = this.artifactRegistry.getById(args.artifactId as string);
            return {
              content: [{ type: 'text' as const, text: a ? JSON.stringify(a, null, 2) : 'Not found' }],
            };
          }

          case 'canvas_recall': {
            const results = this.artifactRegistry. recall(
              args.keywords as string[],
              {
                agentId: args.agentId as string | undefined,
                types: args.types as any[] | undefined,
                limit: (args.limit as number) || 10,
              },
            );
            return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
          }

          // ── Provider tools ────────────────────────────────────
          case 'list_providers': {
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(this.getProviders?.() || [], null, 2) }],
            };
          }

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
      }
    });
  }
}
