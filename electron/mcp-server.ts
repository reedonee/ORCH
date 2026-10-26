// ── ORCH MCP Server ─────────────────────────────────────────────
// MCP server inside Electron's main process. Exposes canvas state,
// agent control, terminal ops, event bus, blackboard delegation, and
// memory recall as MCP tools.
//
// Two transports are served, because agent CLIs disagree about which
// one exists:
//   /mcp  Streamable HTTP — the current spec, and the ONLY remote
//         transport Codex speaks (`codex mcp add --url`).
//   /sse  The 2024 SSE transport, deprecated but still what some
//         clients register.
// Serving only /sse is why Codex reported it had no canvas tools.
//
// Every connection is bound to the agent it belongs to (?agent= or
// X-Orch-Agent-Id, set per launch by mcp-agent-config.ts). That identity
// is what makes the tools usable by a model:
//   - it never has to supply its own id (it cannot know it — a real
//     Claude Code session guessed its display name and every call failed);
//   - the server's MCP `instructions` tell it who it is, what ORCH is,
//     and who the controller is, before its first turn;
//   - each tool reply carries a short footer of what changed since its
//     last call, so the controller stays in sync without polling.
//
// Real-time sync (mcp-sync.ts): every state change is journalled with a
// sequence number. orch_wait_for_events long-polls on it, orch://events
// and orch://snapshot push resources/updated to subscribed clients.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import http from 'http';
import { randomBytes, randomUUID } from 'crypto';
import { EventBus, type OrchEvent } from './event-bus.js';
import { ArtifactRegistry } from './artifact-registry.js';
import { AgentMesh, type AgentMessage, type AgentStatus } from './agent-mesh.js';
import {
  SyncJournal, formatEvents, identityFromRequest, knownAgentsLine, relevantTo,
  resolveAgentRef, shortAgentName, type KnownAgent, type SyncEvent,
} from './mcp-sync.js';

export const ORCH_MCP_VERSION = '2.0.0';

/** Collect a request body and parse it as JSON. */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('error', reject);
    req.on('end', () => {
      if (!body) { resolve(undefined); return; }
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
  });
}

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] });
const fail = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }], isError: true });
const json = (v: unknown): CallToolResult => text(JSON.stringify(v, null, 2));

// ── Tool definitions ────────────────────────────────────────────
// Parameters that name the CALLER (sourceAgentId, claimantAgentId) are
// optional in the published schema and filled in from the connection;
// parameters that name ANOTHER agent accept an id or a name. Both are
// applied by finaliseTools() below so no definition can forget them.

const TOOL_DEFS: Tool[] = [
  // ── Orientation and sync ────────────────────────────────────
  {
    name: 'orch_whoami',
    description: 'Start here. Who you are on the ORCH canvas (your name and agent id), whether you are the controller, who else is working, and what is waiting on the user. Call this at the start of a task.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'orch_snapshot',
    description: 'Complete live picture of ORCH right now: every agent with its id, what it is doing, whether its terminal is running, whether it is connected to ORCH, permission prompts waiting on the user, open blackboard tasks and file conflicts. Returns a cursor to pass to orch_wait_for_events.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'orch_wait_for_events',
    description: 'Real-time sync. Waits until something changes on the canvas — an agent starts, finishes, gets blocked or fails, a message arrives, a permission prompt opens, an agent joins or leaves, a task moves — and returns those events at once (or an empty list on timeout). Pass back the cursor it returns and nothing is ever missed or repeated. The controller should loop on this while coordinating.',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: { type: 'number', description: 'The cursor from your last orch_snapshot / orch_wait_for_events. Omit to continue from where your last ORCH call left off.' },
        timeoutSeconds: { type: 'number', description: 'How long to wait for something to happen (default 25, max 55).' },
        types: { type: 'array', items: { type: 'string' }, description: 'Only these event types (e.g. ["approval_pending","agent_status"]). Omit for all.' },
        agent: { type: 'string', description: 'Only events about this agent.' },
      },
      required: [],
    },
  },
  // ── Canvas tools ────────────────────────────────────────────
  {
    name: 'canvas_get_state',
    description: 'Same as orch_snapshot: every agent on the canvas with its id, status and activity.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'canvas_get_elements',
    description: 'Get all canvas workspace elements: drawings, shapes, text notes, and images on the infinite canvas.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'canvas_get_agent',
    description: 'Details about one agent: name, provider, what it reports doing, and its recent terminal output.',
    inputSchema: {
      type: 'object',
      properties: { agentId: { type: 'string', description: 'The agent' } },
      required: ['agentId'],
    },
  },
  {
    name: 'canvas_move_agent',
    description: 'Move an agent card to an absolute position on the canvas.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent to move' },
        x: { type: 'number', description: 'Target X' },
        y: { type: 'number', description: 'Target Y' },
      },
      required: ['agentId', 'x', 'y'],
    },
  },
  {
    name: 'canvas_send_message',
    description: 'Type a prompt into another agent\'s terminal as if the user typed it, and submit it. Use this to give an agent work. For a note it can read when ready, use agent_send instead.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Target agent' },
        message: { type: 'string', description: 'Text to type and submit' },
      },
      required: ['agentId', 'message'],
    },
  },
  {
    name: 'canvas_read_output',
    description: 'Read an agent\'s recent terminal output as plain text.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Agent' },
        lines: { type: 'number', description: 'Recent lines (default 50, max 400)', default: 50 },
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
      properties: { agentId: { type: 'string', description: 'Agent to remove' } },
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
    description: 'Get recent raw events from the event bus. For keeping in sync, orch_wait_for_events is better: it waits for changes and never misses one.',
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
    description: 'Subscribe to event types. Matching events are shown in your terminal for the user to see. To act on events yourself, use orch_wait_for_events.',
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
        sourceAgentId: { type: 'string', description: 'Filter by delegator agent' },
        claimantAgentId: { type: 'string', description: 'Filter by claimant agent' },
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
    description: 'Contextual memory recall — find past artifacts and memories relevant to your current task keywords. Call this at startup to understand what has already been done.',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: { type: 'array', items: { type: 'string' }, description: 'Keywords to match against tags, titles, descriptions (e.g. ["electron", "sidecar", "voice"])' },
        agentId: { type: 'string', description: 'Optional: limit to one agent\'s artifacts' },
        types: { type: 'array', items: { type: 'string' }, description: 'Optional: filter by artifact types' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['keywords'],
    },
  },
  // ── Agent mesh: shared awareness ────────────────────────────
  {
    name: 'agent_set_status',
    description: 'Report what you are working on so every other agent, the controller and the user can see it. Call it when you start a task, at milestones, and when you finish or get blocked. An agent that never reports is invisible to its peers and to conflict detection.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceAgentId: { type: 'string', description: 'Your agent ID' },
        phase: { type: 'string', enum: ['idle', 'working', 'blocked', 'done', 'failed'], description: 'Your current phase' },
        task: { type: 'string', description: 'One line, present tense: "refactoring the auth module"' },
        detail: { type: 'string', description: 'Optional longer explanation' },
        progress: { type: 'number', description: 'Optional 0-100' },
        files: { type: 'array', items: { type: 'string' }, description: 'Files you are editing. Used to warn when two agents touch the same file.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional grouping tags' },
      },
      required: ['sourceAgentId', 'phase'],
    },
  },
  {
    name: 'agent_roster',
    description: 'See every agent on the canvas, what each is working on, how long they have been at it, and any file conflicts with your own work. Call this before starting a task to avoid duplicating or colliding with another agent.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'agent_send',
    description: 'Send a message to another agent by name (e.g. "Max"), to everyone (omit "to"), or to ORCH itself with to: "orch" — that reaches the controller agent, or the user when there is no controller. Use it to hand off work, ask a question, report a result, or warn about a shared file.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceAgentId: { type: 'string', description: 'Your agent ID' },
        to: { type: 'string', description: 'Recipient: an agent name or id, or "orch" for the controller / user. Omit to broadcast to every agent.' },
        subject: { type: 'string', description: 'Short subject line' },
        body: { type: 'string', description: 'Message body — this is what the other agent reads' },
        kind: { type: 'string', enum: ['note', 'question', 'answer', 'handoff'], description: 'note (FYI), question (expects a reply), answer, or handoff (transferring work)' },
        replyTo: { type: 'string', description: 'Message ID this answers' },
      },
      required: ['sourceAgentId', 'subject', 'body'],
    },
  },
  {
    name: 'agent_inbox',
    description: 'Read messages other agents (or the controller) sent you. Check this when you start work, after long operations, and whenever a reply says you have unread messages.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceAgentId: { type: 'string', description: 'Your agent ID' },
        unreadOnly: { type: 'boolean', description: 'Only unread messages (default true)' },
        markRead: { type: 'boolean', description: 'Mark returned messages as read (default true)' },
      },
      required: ['sourceAgentId'],
    },
  },
  // ── App actions ─────────────────────────────────────────────
  {
    name: 'canvas_add_file',
    description: 'Put a file you produced onto the ORCH canvas as a visible node. Images and videos render inline; other types appear as a file card the user can open. Use this whenever you generate a wallpaper, diagram, video, PDF, or any artefact the user asked to SEE rather than just save.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceAgentId: { type: 'string', description: 'Your agent ID' },
        path: { type: 'string', description: 'Absolute path to the file you created' },
        title: { type: 'string', description: 'Label shown on the canvas' },
        x: { type: 'number', description: 'Optional canvas X; omit to place it automatically' },
        y: { type: 'number', description: 'Optional canvas Y' },
        width: { type: 'number', description: 'Optional display width' },
        height: { type: 'number', description: 'Optional display height' },
      },
      required: ['sourceAgentId', 'path'],
    },
  },
  {
    name: 'canvas_add_note',
    description: 'Place a text note on the canvas — a summary, a plan, a warning for the user or another agent.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceAgentId: { type: 'string', description: 'Your agent ID' },
        text: { type: 'string', description: 'Note content' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['sourceAgentId', 'text'],
    },
  },
  {
    name: 'app_action',
    description: 'Perform an ORCH UI action — anything the user could do by hand. Actions: open_browser (url), close_browser, play_music (query|url), pause_music, open_settings, select_agent (agentId), set_theme (theme), toggle_flip_view, save_workspace, notify (message), speak (text). Use list_app_actions to see the full set with their parameters.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceAgentId: { type: 'string', description: 'Your agent ID' },
        action: { type: 'string', description: 'Action name' },
        params: { type: 'object', description: 'Action parameters', additionalProperties: true },
      },
      required: ['sourceAgentId', 'action'],
    },
  },
  {
    name: 'list_app_actions',
    description: 'List every app action available through app_action, with its parameters.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  // ── Layout tools ───────────────────────────────────────────
  {
    name: 'canvas_arrange',
    description: 'Re-run the ORCH layout engine to tidy every node on the canvas. Modes: grid (uniform cells), focus (one agent large, rest in a rail), stage (browser left, agents right), split (two balanced columns), rail (horizontal strip), constellation (relationship-aware clustering by delegation links).',
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['grid', 'focus', 'stage', 'split', 'rail', 'constellation'],
          description: 'Layout mode to apply (default: grid)',
        },
      },
      required: [],
    },
  },
  // ── Provider tools ─────────────────────────────────────────
  {
    name: 'list_providers',
    description: 'List all available providers and their statuses.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

/** Parameters naming the caller. Filled from the connection's identity. */
const SELF_FIELDS = ['sourceAgentId', 'claimantAgentId'] as const;

/** Parameters naming another agent, per tool. Accept an id or a name. */
const AGENT_REF_FIELDS: Record<string, string[]> = {
  canvas_get_agent: ['agentId'],
  canvas_move_agent: ['agentId'],
  canvas_send_message: ['agentId'],
  canvas_read_output: ['agentId'],
  canvas_remove_agent: ['agentId'],
  canvas_emit_event: ['targetAgentId'],
  canvas_get_artifacts: ['agentId'],
  canvas_recall: ['agentId'],
  agent_send: ['to'],
  orch_wait_for_events: ['agent'],
};

/** Filters on query tools that name an agent but are not the caller. */
const AGENT_FILTER_FIELDS: Record<string, string[]> = {
  query_tasks: ['sourceAgentId', 'claimantAgentId'],
};

const READ_ONLY = new Set([
  'orch_whoami', 'orch_snapshot', 'orch_wait_for_events', 'canvas_get_state', 'canvas_get_elements',
  'canvas_get_agent', 'canvas_read_output', 'canvas_list_sessions', 'canvas_get_events', 'query_tasks',
  'get_task', 'canvas_get_artifacts', 'canvas_get_artifact', 'canvas_recall', 'agent_roster',
  'list_app_actions', 'list_providers',
]);
const DESTRUCTIVE = new Set(['canvas_remove_agent']);

/** Apply the identity and naming conventions to every definition. */
function finaliseTools(defs: Tool[]): Tool[] {
  return defs.map((def) => {
    const props = { ...(def.inputSchema.properties ?? {}) } as Record<string, Record<string, unknown>>;
    let required = [...(def.inputSchema.required ?? [])];
    const filters = AGENT_FILTER_FIELDS[def.name] ?? [];
    for (const f of SELF_FIELDS) {
      if (!props[f] || filters.includes(f)) continue;
      props[f] = { ...props[f], description: 'Optional — ORCH already knows which agent you are and fills this in.' };
      required = required.filter((r) => r !== f);
    }
    for (const f of [...(AGENT_REF_FIELDS[def.name] ?? []), ...filters]) {
      if (props[f]) props[f] = { ...props[f], description: `${props[f].description ?? 'Agent'} — an agent name (e.g. "Max") or id.` };
    }
    return {
      ...def,
      inputSchema: { ...def.inputSchema, properties: props, required },
      annotations: {
        title: def.name.replace(/_/g, ' '),
        readOnlyHint: READ_ONLY.has(def.name),
        destructiveHint: DESTRUCTIVE.has(def.name),
        openWorldHint: false,
      },
    };
  });
}

export const TOOLS: Tool[] = finaliseTools(TOOL_DEFS);
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** Documentation returned by list_app_actions. Kept beside the tool so it
 *  cannot drift from what appAction actually implements. */
const APP_ACTION_HELP = [
  '# ORCH app actions',
  '',
  'Call with: app_action { action, params }',
  '',
  '| Action | Params | Effect |',
  '|---|---|---|',
  '| open_browser | url? | Open the in-app browser panel |',
  '| close_browser | - | Close it |',
  '| play_music | query? url? | Open the player and start something |',
  '| pause_music | - | Pause playback |',
  '| next_track / prev_track | - | Skip |',
  '| select_agent | agentId or name | Focus an agent card |',
  '| arrange | mode | grid, focus, stage, split, rail, constellation |',
  '| set_theme | theme | Switch the colour theme |',
  '| toggle_flip_view | on? | Show every agent card back-side summary |',
  '| save_workspace | - | Persist the workspace now |',
  '| notify | message, tone? | Show a toast to the user |',
  '| speak | text | Say something out loud via TTS |',
  '',
  'Anything a user can do from the UI should be reachable here. If an',
  'action you need is missing, say so in your reply rather than trying',
  'to script the UI another way.',
].join('\n');

// ── Argument preparation ────────────────────────────────────────
// The low-level SDK Server does not validate arguments against the
// schema, so a missing field used to surface as "Cannot read properties
// of undefined" — or worse, as a silent no-op. Check here, coerce the
// obvious near-misses models produce, and say exactly what was expected.

function describeParams(tool: Tool): string {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
  const req = new Set(tool.inputSchema.required ?? []);
  const parts = Object.entries(props).map(([k, v]) => `${k}${req.has(k) ? '' : '?'}: ${v.type ?? 'any'}`);
  return `${tool.name}(${parts.join(', ')})`;
}

function coerce(value: unknown, type: string | undefined): unknown {
  if (value === undefined || value === null) return value;
  if (type === 'number' && typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  if (type === 'boolean' && typeof value === 'string') return value === 'true' ? true : value === 'false' ? false : value;
  if (type === 'array' && typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return parsed; } catch { /* not JSON */ }
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (type === 'object' && typeof value === 'string') {
    try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') return parsed; } catch { /* leave it */ }
  }
  return value;
}

// ── Sessions ────────────────────────────────────────────────────

interface McpSession {
  id: string;
  transport: 'stream' | 'sse';
  /** The canvas agent this connection belongs to, if launched by ORCH. */
  agentId?: string;
  client?: string;
  connectedAt: number;
  lastSeen: number;
  /** Journal cursor this session has been shown, via footers or sync tools. */
  seen: number;
  /** Role the session was last told about, to announce changes once. */
  toldController: boolean;
  subscriptions: Set<string>;
  server: Server;
  notifyTimer?: ReturnType<typeof setTimeout>;
}

const RESOURCES = [
  { uri: 'orch://snapshot', name: 'ORCH snapshot', mimeType: 'text/markdown',
    description: 'Live state of the canvas: agents, activity, approvals, tasks. Subscribe for updates.' },
  { uri: 'orch://events', name: 'ORCH event journal', mimeType: 'application/json',
    description: 'The most recent sync events with their cursor. Subscribe for updates.' },
];

/** Approval and terminal state per agent, supplied by main.ts. */
export interface AgentRuntime {
  agentId: string;
  name: string;
  providerId: string;
  terminal: 'running' | 'sleeping';
  idleMs: number;
  approval?: { kind: string; detail: string } | null;
}

// ── MCP Server ──────────────────────────────────────────────────

import type { PtySession } from './hibernation.js';

export class OrchMcpServer {
  private httpServer: http.Server | null = null;
  /** One transport per connected agent, keyed by the SDK's session id.
   *  A single shared transport meant each new agent silently displaced the
   *  previous one — on a canvas built for N concurrent agents, only the
   *  most recent connection worked. */
  private transports = new Map<string, SSEServerTransport>();
  /** Streamable HTTP sessions, keyed by the transport's own session id. */
  private streamTransports = new Map<string, StreamableHTTPServerTransport>();
  /** Every live MCP session, either transport. */
  private mcpSessions = new Map<string, McpSession>();
  /** Random per-launch bearer token. The HTTP listener is loopback-only,
   *  but loopback is not a trust boundary: any local process (or a web page
   *  probing localhost ports) could otherwise drive canvas_create_agent and
   *  execute commands on this machine. */
  private readonly authToken = randomBytes(24).toString('hex');
  private port = 0;
  private sessions: Map<string, PtySession>;
  public eventBus: EventBus;
  public artifactRegistry: ArtifactRegistry;
  public mesh: AgentMesh;
  public journal: SyncJournal;
  /** The agent coordinating the others, chosen by the user. */
  private controllerId: string | null = null;
  private seenAgents = new Set<string>();

  // Callbacks wired by main.ts
  getCanvasElements: () => Promise<any[]> = async () => [];
  moveAgent: (id: string, x: number, y: number) => Promise<void> = async () => {};
  /** Type into an agent's terminal and submit. Returns why it could not. */
  sendToAgent: (id: string, text: string) => Promise<{ ok: boolean; reason?: string }> = async () => ({ ok: false, reason: 'not wired' });
  readAgentOutput: (id: string, lines?: number) => Promise<string> = async () => '';
  createAgent: (providerId: string, name?: string, contextSnapshot?: string) => Promise<any> = async () => ({});
  removeAgent: (id: string) => Promise<void> = async () => {};
  /** Get the agent ID associated with a PTY session ID */
  getSessionAgentId: (sessionId: string) => string | undefined = () => undefined;
  /** Get available providers */
  getProviders: () => any[] = () => [];
  /** Terminal + approval state of every agent with a session. */
  getAgentRuntime: () => AgentRuntime[] = () => [];
  /** Ask the canvas to re-run the layout engine in a given mode. */
  arrange: (mode: string) => Promise<any> = async () => ({});
  /** Place a produced file on the canvas. */
  addCanvasFile: (opts: {
    agentId: string; path: string; title?: string;
    x?: number; y?: number; width?: number; height?: number;
  }) => Promise<any> = async () => ({ error: 'not wired' });
  /** Place a text note on the canvas. */
  addCanvasNote: (opts: { agentId: string; text: string; x?: number; y?: number }) => Promise<any> =
    async () => ({ error: 'not wired' });
  /** Run a named UI action. */
  appAction: (action: string, params: Record<string, unknown>) => Promise<any> =
    async () => ({ error: 'not wired' });
  /** Show text in an agent's terminal VIEW. Never its stdin: typing into
   *  an agent submits a half-formed prompt as if the user had sent it. */
  notifyAgentView: (agentId: string, text: string) => void = () => {};
  /** A message addressed to ORCH with no controller to take it. */
  onUserMessage: (message: AgentMessage) => void = () => {};
  /** An agent's first connection opened, or its last one closed. */
  onAgentConnection: (agentId: string, info: { connected: boolean; client?: string }) => void = () => {};
  /** Pass-throughs for main.ts, which used to own these callbacks directly. */
  onMeshStatus: (status: AgentStatus) => void = () => {};
  onMeshMessage: (message: AgentMessage) => void = () => {};
  onBusEvent: (event: OrchEvent) => void = () => {};

  constructor(sessions: Map<string, PtySession>) {
    this.sessions = sessions;
    this.eventBus = new EventBus();
    this.artifactRegistry = new ArtifactRegistry();
    this.mesh = new AgentMesh();
    this.journal = new SyncJournal();

    this.mesh.onStatusChange = (status) => {
      this.journalStatus(status);
      this.onMeshStatus(status);
    };
    this.mesh.onMessage = (message) => {
      this.journal.append({
        type: 'agent_message', agentId: message.from, agentName: message.fromName,
        audience: message.to ?? undefined,
        summary: `${message.kind === 'question' ? 'Question' : 'Message'} from ${message.fromName} to ${message.toName ?? 'everyone'}: ${message.subject}`,
        data: { messageId: message.id, to: message.to, kind: message.kind },
      });
      this.onMeshMessage(message);
    };
    this.eventBus.onEmit = (event) => {
      this.journalBusEvent(event);
      this.onBusEvent(event);
    };
    this.journal.onAppend(() => this.scheduleResourceUpdates());
  }

  async start(): Promise<number> {
    return new Promise((resolve) => {
      this.httpServer = http.createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
        this.handleRequest(req, res);
      });
      // A long-poll holds its request open for up to a minute; Node's
      // default request timeout must not cut it off first.
      this.httpServer.requestTimeout = 0;
      this.httpServer.headersTimeout = 30_000;

      this.httpServer.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address();
        this.port = addr && typeof addr === 'object' ? addr.port : 0;
        console.log(`[MCP] Server on http://127.0.0.1:${this.port}  (/mcp streamable, /sse legacy)`);
        resolve(this.port);
      });
    });
  }

  async stop() {
    this.journal.close();
    if (this.httpServer) this.httpServer.close();
    await Promise.allSettled([...this.mcpSessions.values()].map((s) => s.server.close()));
    this.mcpSessions.clear();
    this.transports.clear();
    this.streamTransports.clear();
  }

  /** Legacy SSE URL including the per-launch auth token. */
  get url() { return `http://127.0.0.1:${this.port}/sse?token=${this.authToken}`; }

  /** Streamable HTTP endpoint with the token in the query, for clients
   *  that cannot set headers. */
  get streamUrl() { return `http://127.0.0.1:${this.port}/mcp?token=${this.authToken}`; }

  /** Streamable HTTP endpoint with no credential in it, for clients that
   *  supply the bearer token from a header or the environment. */
  get streamUrlNoToken() { return `http://127.0.0.1:${this.port}/mcp`; }

  /** The per-launch bearer token, for env-var based auth. */
  get token() { return this.authToken; }

  /** Token-free URL, for display in settings/logs. */
  get publicUrl() { return `http://127.0.0.1:${this.port}/sse`; }

  // ── Controller ──────────────────────────────────────────────

  get controller(): string | null { return this.controllerId; }

  setController(agentId: string | null): void {
    if (agentId === this.controllerId) return;
    const prev = this.controllerId;
    this.controllerId = agentId;
    const name = agentId ? this.nameOf(agentId) : null;
    this.journal.append({
      type: 'controller_changed', agentId: agentId ?? undefined, agentName: name ?? undefined,
      summary: name ? `${name} is now the controller` : `${prev ? this.nameOf(prev) : 'The controller'} is no longer the controller`,
      data: { controller: agentId, previous: prev },
    });
  }

  // ── Journal feeds from main.ts ──────────────────────────────

  recordApproval(agentId: string, pending: { kind: string; detail: string } | null): void {
    const name = this.nameOf(agentId);
    this.journal.append(pending
      ? {
          type: 'approval_pending', agentId, agentName: name,
          summary: pending.kind === 'trust'
            ? `${name} is waiting for the user to trust its folder`
            : `${name} is waiting for the user to approve: ${pending.detail}`,
          data: { kind: pending.kind, detail: pending.detail },
        }
      : { type: 'approval_resolved', agentId, agentName: name, summary: `${name}'s permission prompt was answered` });
  }

  recordAgentExit(agentId: string, exitCode: number | null): void {
    const name = this.nameOf(agentId);
    this.journal.append({
      type: 'agent_exited', agentId, agentName: name,
      summary: `${name}'s terminal exited${exitCode !== null ? ` (code ${exitCode})` : ''}`,
      data: { exitCode },
    });
    this.closeAgentSessions(agentId);
  }

  recordAgentRemoved(agentId: string, name: string): void {
    this.closeAgentSessions(agentId);
    this.seenAgents.delete(agentId);
    if (this.controllerId === agentId) this.setController(null);
    this.journal.append({ type: 'agent_left', agentId, agentName: name, summary: `${name} left the canvas` });
  }

  /** A CLI that exits drops its HTTP connection without the DELETE that
   *  would end its MCP session, so the server would think it is still
   *  connected. The agent's terminal is the authoritative signal. */
  private closeAgentSessions(agentId: string): void {
    for (const [id, session] of [...this.mcpSessions]) {
      if (session.agentId !== agentId) continue;
      const stream = this.streamTransports.get(id);
      this.streamTransports.delete(id);
      this.transports.delete(id);
      this.closeSession(id);
      void (stream ?? session.server).close().catch(() => { /* already gone */ });
    }
  }

  private journalStatus(s: AgentStatus): void {
    if (!this.seenAgents.has(s.agentId)) {
      this.seenAgents.add(s.agentId);
      this.journal.append({
        type: 'agent_joined', agentId: s.agentId, agentName: s.name,
        summary: `${s.name} (${s.providerId || 'shell'}) joined the canvas`,
        data: { providerId: s.providerId },
      });
      return;
    }
    const verb: Record<string, string> = {
      working: 'is working on', blocked: 'is blocked', done: 'finished', failed: 'failed', idle: 'is idle',
    };
    const what = s.task && s.task !== 'Waiting for work' ? `${s.phase === 'working' ? '' : ': '}${s.task}` : '';
    this.journal.append({
      type: 'agent_status', agentId: s.agentId, agentName: s.name,
      summary: `${s.name} ${verb[s.phase] ?? s.phase}${what ? (s.phase === 'working' ? ' ' + what : what) : ''}` +
        (s.progress !== undefined ? ` (${s.progress}%)` : ''),
      data: { phase: s.phase, task: s.task, files: s.files, progress: s.progress },
    });
  }

  private journalBusEvent(e: OrchEvent): void {
    const who = this.nameOf(e.sourceAgentId);
    const d = e.data as Record<string, unknown>;
    const summaries: Record<string, string> = {
      task_posted: `${who} posted task "${d.title ?? d.taskId}"`,
      task_claimed: `${this.nameOf(String(d.claimantAgentId ?? e.sourceAgentId))} claimed task "${d.title ?? d.taskId}"`,
      task_completed: `Task "${d.title ?? d.taskId}" completed`,
      task_failed: `Task "${d.title ?? d.taskId}" failed`,
      task_cancelled: `Task "${d.title ?? d.taskId}" was cancelled`,
      artifact_created: `${who} stored ${d.type ?? 'an'} artifact "${d.title ?? d.artifactId}"`,
    };
    // Per-line terminal output, spawn bookkeeping and the name-mention
    // heuristic are deliberately not journalled: they would drown out
    // every event a coordinator actually needs.
    const summary = summaries[e.type];
    if (!summary) return;
    this.journal.append({ type: e.type, agentId: e.sourceAgentId, agentName: who, summary, data: d });
  }

  // ── Who is who ──────────────────────────────────────────────

  private knownAgents(): KnownAgent[] {
    const byId = new Map<string, KnownAgent>();
    for (const s of this.mesh.allStatuses()) byId.set(s.agentId, { agentId: s.agentId, name: s.name, providerId: s.providerId });
    for (const r of this.getAgentRuntime()) {
      if (!byId.has(r.agentId)) byId.set(r.agentId, { agentId: r.agentId, name: r.name, providerId: r.providerId });
    }
    return [...byId.values()];
  }

  private nameOf(agentId: string | undefined): string {
    if (!agentId) return 'someone';
    return this.knownAgents().find((a) => a.agentId === agentId)?.name ?? agentId;
  }

  /** Newest journal event this agent has already been shown over MCP
   *  (sync tools or reply footers). Main's controller nudge skips anything
   *  at or below it, so the controller is never told the same thing twice. */
  seenCursor(agentId: string): number {
    let seen = 0;
    for (const s of this.mcpSessions.values()) if (s.agentId === agentId) seen = Math.max(seen, s.seen);
    return seen;
  }

  private connectedAgentIds(): Set<string> {
    return new Set([...this.mcpSessions.values()].map((s) => s.agentId).filter((a): a is string => !!a));
  }

  // ── HTTP ────────────────────────────────────────────────────

  /** Reject anything that is not an authenticated local caller.
   *  Returns true when the request has been rejected and answered. */
  private rejectUnauthorised(req: http.IncomingMessage, res: http.ServerResponse, url: URL): boolean {
    // Browsers attach Origin on cross-site requests. A real MCP client never
    // sends one, so its presence means a web page is probing us.
    const origin = req.headers.origin;
    if (origin) {
      res.writeHead(403); res.end('Forbidden: browser origins are not permitted');
      return true;
    }
    const header = req.headers.authorization;
    const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    const token = bearer ?? url.searchParams.get('token') ?? undefined;
    if (token !== this.authToken) {
      // JSON-RPC shaped, so a client shows a reason rather than a bare 401.
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32001, message: 'ORCH MCP: missing or wrong token. Restart the agent from ORCH so it gets the current one.' },
      }));
      return true;
    }
    return false;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // Unauthenticated liveness probe. Deliberately leaks nothing beyond
    // "an ORCH MCP server is here" — no port list, no tool names, no token.
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', name: 'orch-mcp', version: ORCH_MCP_VERSION }));
      return;
    }

    if (this.rejectUnauthorised(req, res, url)) return;

    if (url.pathname === '/mcp') {
      void this.handleStreamable(req, res, url);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/sse') {
      // One Server + one transport per connection, so N agents can be
      // connected simultaneously without displacing each other.
      const transport = new SSEServerTransport('/messages', res);
      const sessionId = transport.sessionId;
      const session = this.openSession(sessionId, 'sse', identityFromRequest(req.headers, url));
      this.transports.set(sessionId, transport);

      const cleanup = () => {
        if (!this.transports.delete(sessionId)) return;
        this.closeSession(sessionId);
      };
      transport.onclose = cleanup;
      res.on('close', cleanup);

      session.server.connect(transport).catch((err) => {
        console.error('[MCP] SSE connect error:', err);
        cleanup();
      });

    } else if (req.method === 'POST' && url.pathname === '/messages') {
      // Route by sessionId so a POST reaches the transport that owns it.
      const sessionId = url.searchParams.get('sessionId');
      const transport = sessionId ? this.transports.get(sessionId) : undefined;
      if (!transport) {
        res.writeHead(404); res.end('No such MCP session');
        return;
      }
      const session = this.mcpSessions.get(sessionId!);
      if (session) session.lastSeen = Date.now();
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          transport.handlePostMessage(req, res, JSON.parse(body));
        } catch { res.writeHead(400); res.end('Bad request'); }
      });

    } else if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        version: ORCH_MCP_VERSION,
        port: this.port,
        sessions: [...this.mcpSessions.values()].map((s) => ({
          transport: s.transport, agentId: s.agentId ?? null, client: s.client ?? null,
        })),
        controller: this.controllerId,
        cursor: this.journal.cursor,
        tools: TOOLS.map((t) => t.name),
      }));
    } else {
      res.writeHead(404); res.end();
    }
  }

  /**
   * Streamable HTTP transport (`/mcp`).
   *
   * Stateful: the first POST is an `initialize`, which mints a session id
   * returned in the Mcp-Session-Id header; later requests carry it back.
   * One Server per session — the SDK binds one Server to one transport, so
   * sharing would let a second agent displace the first.
   */
  private async handleStreamable(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    const existing = sessionId ? this.streamTransports.get(sessionId) : undefined;
    if (existing) {
      const session = this.mcpSessions.get(sessionId!);
      if (session) session.lastSeen = Date.now();
      await existing.handleRequest(req, res).catch((err) => {
        console.error('[MCP] streamable request error:', err);
        if (!res.headersSent) { res.writeHead(500); res.end(); }
      });
      return;
    }

    if (sessionId) {
      // A session id we do not know: ORCH restarted while the client held
      // the old one. 404 is the spec's signal to re-initialise, which
      // compliant clients do on their own.
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0', id: null,
        error: { code: -32001, message: 'Unknown MCP session — re-initialize' },
      }));
      return;
    }

    if (req.method !== 'POST') {
      // GET with no session is a client opening a listening stream before
      // initialising, which this server does not offer.
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      res.writeHead(400); res.end('Bad request');
      return;
    }

    const agentId = identityFromRequest(req.headers, url);
    // Built before the id exists; the session is registered under its id
    // the moment the transport mints it.
    const pendingId = `pending-${randomUUID()}`;
    const session = this.openSession(pendingId, 'stream', agentId);
    let registered = false;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      // rejectUnauthorised already refuses any request carrying an Origin
      // header at all, which is stricter than host allow-listing: a real
      // MCP client never sends one.
      enableDnsRebindingProtection: false,
      onsessioninitialized: (sid) => {
        registered = true;
        this.streamTransports.set(sid, transport);
        this.mcpSessions.delete(pendingId);
        session.id = sid;
        this.mcpSessions.set(sid, session);
      },
      onsessionclosed: (sid) => {
        this.streamTransports.delete(sid);
        this.closeSession(sid);
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && this.streamTransports.delete(sid)) this.closeSession(sid);
    };

    try {
      await session.server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error('[MCP] streamable connect error:', err);
      if (!res.headersSent) { res.writeHead(500); res.end(); }
    } finally {
      // A first request that was not a valid initialize never gets an id.
      if (!registered) this.mcpSessions.delete(pendingId);
    }
  }

  private openSession(id: string, transport: 'stream' | 'sse', agentId: string | undefined): McpSession {
    const session = {
      id, transport, agentId,
      connectedAt: Date.now(), lastSeen: Date.now(),
      seen: this.journal.cursor,
      toldController: !!agentId && agentId === this.controllerId,
      subscriptions: new Set<string>(),
    } as McpSession;
    session.server = this.buildServer(session);
    this.mcpSessions.set(id, session);
    return session;
  }

  /** Called once the client has completed initialize. */
  private sessionReady(session: McpSession) {
    const v = session.server.getClientVersion();
    session.client = v ? `${v.name}${v.version ? ' ' + v.version : ''}` : undefined;
    const agentId = session.agentId;
    console.log(`[MCP] ${session.transport} session connected — ${agentId ? this.nameOf(agentId) : 'unlinked client'}` +
      `${session.client ? ` (${session.client})` : ''}; ${this.mcpSessions.size} active`);
    if (!agentId) return;
    const others = [...this.mcpSessions.values()].filter((s) => s !== session && s.agentId === agentId);
    if (others.length) return;
    this.journal.append({
      type: 'mcp_connected', agentId, agentName: this.nameOf(agentId),
      summary: `${this.nameOf(agentId)} connected to ORCH${session.client ? ` (${session.client})` : ''}`,
      data: { client: session.client },
    });
    this.onAgentConnection(agentId, { connected: true, client: session.client });
  }

  private closeSession(id: string) {
    const session = this.mcpSessions.get(id);
    if (!session) return;
    this.mcpSessions.delete(id);
    if (session.notifyTimer) clearTimeout(session.notifyTimer);
    const agentId = session.agentId;
    console.log(`[MCP] session closed — ${agentId ? this.nameOf(agentId) : 'unlinked client'}; ${this.mcpSessions.size} active`);
    if (!agentId || this.connectedAgentIds().has(agentId)) return;
    this.journal.append({
      type: 'mcp_disconnected', agentId, agentName: this.nameOf(agentId),
      summary: `${this.nameOf(agentId)} disconnected from ORCH`,
    });
    this.onAgentConnection(agentId, { connected: false });
  }

  // ── Real-time: resource subscriptions ───────────────────────

  /** Push resources/updated to subscribed sessions, coalesced so a burst
   *  of events costs one notification. */
  private scheduleResourceUpdates() {
    for (const session of this.mcpSessions.values()) {
      if (session.subscriptions.size === 0 || session.notifyTimer) continue;
      session.notifyTimer = setTimeout(() => {
        session.notifyTimer = undefined;
        for (const uri of session.subscriptions) {
          session.server.sendResourceUpdated({ uri }).catch(() => { /* client went away */ });
        }
      }, 200);
    }
  }

  // ── Scheduler: show event notifications to subscribed agents ──
  private scheduleEventNotification(event: OrchEvent): void {
    for (const sub of this.eventBus.findMatchingSubscriptions(event)) {
      const summary = JSON.stringify(event.data).slice(0, 200);
      this.notifyAgentView(sub.agentId,
        `\r\n\x1b[33m[ORCH] Event: ${event.type} from ${this.nameOf(event.sourceAgentId)} → ${summary}\x1b[0m\r\n`);
    }
  }

  // ── Orientation text ────────────────────────────────────────

  private buildInstructions(agentId: string | undefined): string {
    const me = agentId ? this.knownAgents().find((a) => a.agentId === agentId) : undefined;
    const controller = this.controllerId ? this.nameOf(this.controllerId) : null;
    const lines = [
      'ORCH is the desktop app you are running inside: a shared canvas where several AI coding agents work on the same project at the same time, watched and directed by the user (often by voice). This MCP server is how you see and act on that canvas.',
      '',
      me
        ? `You are "${me.name}" (agent id ${me.agentId}). ORCH knows this connection is you: never pass your own id — sourceAgentId is filled in for you.`
        : 'This connection is not linked to a canvas agent. Where a tool asks for sourceAgentId, use the ORCH_AGENT_ID environment variable if you have one.',
    ];
    if (agentId && agentId === this.controllerId) {
      lines.push('', ...CONTROLLER_BRIEF);
    } else {
      lines.push(
        '',
        controller
          ? `${controller} is the controller coordinating the agents. To report to it — or to the user — use agent_send with to: "orch".`
          : 'No agent is the controller right now. agent_send with to: "orch" reaches the user.',
        '',
        'How to work here:',
        '- At the start of a task call orch_whoami (or agent_roster) to see who else is working, so you do not duplicate or collide.',
        '- Report with agent_set_status: phase "working" plus the files you are editing when you start, then "done", "blocked" or "failed".',
        '- Message other agents by name with agent_send (to: "Max"); read replies with agent_inbox. When a reply says you have unread messages, read them.',
        '- To show the user something you produced, call canvas_add_file with its absolute path.',
      );
    }
    return lines.join('\n');
  }

  // ── State views ─────────────────────────────────────────────

  private snapshot(callerId: string | undefined): string {
    const runtime = new Map(this.getAgentRuntime().map((r) => [r.agentId, r]));
    const statuses = new Map(this.mesh.allStatuses().map((s) => [s.agentId, s]));
    const connected = this.connectedAgentIds();
    const agents = this.knownAgents();
    const fmtIdle = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`; };

    const rows = agents.map((a) => {
      const st = statuses.get(a.agentId);
      const rt = runtime.get(a.agentId);
      const label = `${a.name}${a.agentId === callerId ? ' (you)' : ''}${a.agentId === this.controllerId ? ' ★controller' : ''}`;
      const doing = st ? `${st.phase}${st.progress !== undefined ? ` ${st.progress}%` : ''}${st.task && st.task !== 'Waiting for work' ? ` — ${st.task}` : ''}` : '-';
      const term = rt ? `${rt.terminal}, idle ${fmtIdle(rt.idleMs)}` : 'none';
      const waiting = rt?.approval ? `⚠ ${rt.approval.kind === 'trust' ? 'trust folder' : rt.approval.detail}` : '-';
      return `| ${label} | ${a.agentId} | ${a.providerId || 'shell'} | ${doing} | ${term} | ${connected.has(a.agentId) ? 'yes' : 'no'} | ${waiting} |`;
    });

    const approvals = [...runtime.values()].filter((r) => r.approval);
    const tasks = this.eventBus.queryTasks({ limit: 50 }).filter((t) => t.status === 'pending' || t.status === 'in-progress');
    const conflicts = this.mesh.fileConflicts();
    const unread = callerId ? this.mesh.inbox(callerId, { unreadOnly: true }).length : 0;

    return [
      `## ORCH snapshot · cursor ${this.journal.cursor}`,
      `Controller: ${this.controllerId ? this.nameOf(this.controllerId) + (this.controllerId === callerId ? ' (you)' : '') : 'none'}`,
      '',
      agents.length === 0 ? 'No agents on the canvas.' : [
        '| Agent | Id | Provider | Doing | Terminal | Connected | Waiting on user |',
        '|---|---|---|---|---|---|---|',
        ...rows,
      ].join('\n'),
      approvals.length
        ? '\n### Waiting for the user\n' + approvals.map((r) => `- ${r.name}: ${r.approval!.kind === 'trust' ? 'trust its folder' : r.approval!.detail}`).join('\n') +
          '\nOnly the user can answer these (on the agent\'s card or by voice).'
        : '',
      tasks.length
        ? '\n### Open tasks\n' + tasks.map((t) => `- ${t.id} [${t.status}] ${t.title}${t.claimantAgentId ? ` — ${this.nameOf(t.claimantAgentId)}` : ''}`).join('\n')
        : '',
      conflicts.length
        ? '\n### File conflicts\n' + conflicts.map((c) => `- ${c.file}: ${c.agents.map((x) => x.name).join(' + ')}`).join('\n')
        : '',
      unread ? `\n📨 You have ${unread} unread message${unread === 1 ? '' : 's'} — agent_inbox.` : '',
      `\nStay in sync: orch_wait_for_events { "cursor": ${this.journal.cursor} }`,
    ].filter(Boolean).join('\n');
  }

  private whoami(session: McpSession): string {
    const me = session.agentId ? this.knownAgents().find((a) => a.agentId === session.agentId) : undefined;
    const runtime = this.getAgentRuntime();
    const statuses = this.mesh.allStatuses();
    const working = statuses.filter((s) => s.phase === 'working').length;
    const waiting = runtime.filter((r) => r.approval).length;
    const openTasks = this.eventBus.queryTasks({ limit: 100 }).filter((t) => t.status === 'pending').length;
    const isController = !!session.agentId && session.agentId === this.controllerId;
    session.toldController = isController;
    return [
      me ? `## You are ${me.name}` : '## Unlinked connection',
      me ? `- Agent id: ${me.agentId} (filled in for you — never pass it)` : '- Not linked to a canvas agent; pass sourceAgentId explicitly.',
      me ? `- Provider: ${me.providerId || 'shell'}` : '',
      `- Role: ${isController ? 'CONTROLLER — you coordinate the other agents' : 'agent'}`,
      `- Controller: ${this.controllerId ? this.nameOf(this.controllerId) : 'none'}`,
      `- Canvas: ${statuses.length} agent${statuses.length === 1 ? '' : 's'} (${working} working)` +
        `${waiting ? `, ${waiting} waiting on the user` : ''}${openTasks ? `, ${openTasks} open task${openTasks === 1 ? '' : 's'}` : ''}`,
      '',
      isController ? CONTROLLER_BRIEF.join('\n') : 'Next: agent_roster to see who is doing what, then agent_set_status to say what you are taking on.',
    ].filter(Boolean).join('\n');
  }

  /** What a session has not been told yet, appended to tool replies. */
  private syncFooter(session: McpSession): string {
    const parts: string[] = [];
    const isController = !!session.agentId && session.agentId === this.controllerId;
    if (isController !== session.toldController) {
      session.toldController = isController;
      parts.push(isController
        ? 'ORCH: the user made you the CONTROLLER. Call orch_whoami for your brief.'
        : 'ORCH: you are no longer the controller.');
    }
    if (session.agentId) {
      const unread = this.mesh.inbox(session.agentId, { unreadOnly: true }).length;
      if (unread) parts.push(`📨 ${unread} unread message${unread === 1 ? '' : 's'} — read with agent_inbox.`);
    }
    if (isController) {
      const batch = this.journal.since(session.seen, relevantTo(session.agentId));
      session.seen = batch.cursor;
      if (batch.events.length) {
        parts.push(`⟳ Since your last ORCH call:\n${formatEvents(batch.events, 8)}\n(cursor ${batch.cursor})`);
      }
    }
    return parts.join('\n');
  }

  // ── Server per session ──────────────────────────────────────

  /** Create a fresh Server with the full tool surface bound to it.
   *  Every connection gets its own instance; they all share the same
   *  sessions map, event bus, journal and artifact registry via `this`. */
  private buildServer(session: McpSession): Server {
    const server = new Server(
      { name: 'orch', title: 'ORCH', version: ORCH_MCP_VERSION },
      {
        capabilities: { tools: { listChanged: false }, resources: { subscribe: true, listChanged: false } },
        instructions: this.buildInstructions(session.agentId),
      },
    );
    server.oninitialized = () => this.sessionReady(session);

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }));
    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      if (uri === 'orch://snapshot') {
        return { contents: [{ uri, mimeType: 'text/markdown', text: this.snapshot(session.agentId) }] };
      }
      if (uri === 'orch://events') {
        const batch = this.journal.since(Math.max(0, this.journal.cursor - 50), relevantTo(session.agentId));
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(batch, null, 2) }] };
      }
      throw new Error(`Unknown resource ${uri}. Available: ${RESOURCES.map((r) => r.uri).join(', ')}`);
    });
    server.setRequestHandler(SubscribeRequestSchema, async (request) => {
      session.subscriptions.add(request.params.uri);
      return {};
    });
    server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
      session.subscriptions.delete(request.params.uri);
      return {};
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      session.lastSeen = Date.now();
      const { name } = request.params;
      let result: CallToolResult;
      try {
        const prepared = this.prepareArgs(name, request.params.arguments ?? {}, session);
        result = 'error' in prepared ? fail(prepared.error) : await this.callTool(name, prepared.args, session);
      } catch (err) {
        result = fail(`Error in ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (name !== 'orch_wait_for_events' && name !== 'orch_snapshot' && name !== 'canvas_get_state') {
        const footer = this.syncFooter(session);
        if (footer) result = { ...result, content: [...result.content, { type: 'text', text: `\n---\n${footer}` }] };
      }
      return result;
    });

    return server;
  }

  /** Validate, coerce and resolve a call's arguments. */
  private prepareArgs(name: string, raw: Record<string, unknown>, session: McpSession):
    { args: Record<string, unknown> } | { error: string } {
    const tool = TOOL_BY_NAME.get(name);
    if (!tool) {
      const near = TOOLS.map((t) => t.name).filter((t) => t.includes(name.split('_').pop() ?? name)).slice(0, 4);
      return { error: `Unknown tool "${name}".${near.length ? ` Did you mean ${near.join(', ')}?` : ''}` };
    }
    const props = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) args[k] = coerce(v, props[k]?.type);

    const agents = this.knownAgents();
    const filters = AGENT_FILTER_FIELDS[name] ?? [];

    // The caller. A linked connection always acts as itself, whatever the
    // model typed: it cannot know its id, and must not be able to act as
    // another agent.
    for (const f of SELF_FIELDS) {
      if (!(f in props) || filters.includes(f)) continue;
      if (session.agentId) { args[f] = session.agentId; continue; }
      if (args[f] !== undefined) {
        const ref = resolveAgentRef(args[f], agents);
        if (ref.kind === 'agent') args[f] = ref.agent.agentId;
      }
    }

    for (const r of tool.inputSchema.required ?? []) {
      if (args[r] === undefined || args[r] === null || args[r] === '') {
        return { error: `Missing required argument "${r}". Expected ${describeParams(tool)}.` };
      }
    }

    for (const f of [...(AGENT_REF_FIELDS[name] ?? []), ...filters]) {
      if (args[f] === undefined || args[f] === null || args[f] === '') continue;
      const ref = resolveAgentRef(args[f], agents, session.agentId);
      if (ref.kind === 'agent') { args[f] = ref.agent.agentId; continue; }
      if (ref.kind === 'orch' && name === 'agent_send') { args[f] = '__orch__'; continue; }
      return {
        error: `${f}: ${ref.kind === 'orch' ? `"${String(args[f])}" is not an agent here` : ref.reason}. ${knownAgentsLine(agents)}` +
          (name === 'agent_send' ? ' To reach the controller or the user, use to: "orch".' : ''),
      };
    }
    return { args };
  }

  // ── Tool implementations ────────────────────────────────────

  private async callTool(name: string, args: Record<string, unknown>, session: McpSession): Promise<CallToolResult> {
    const caller = session.agentId;
    switch (name) {
      case 'orch_whoami':
        return text(this.whoami(session));

      case 'orch_snapshot':
      case 'canvas_get_state':
        session.seen = this.journal.cursor;
        return text(this.snapshot(caller));

      case 'orch_wait_for_events': {
        const timeout = Math.min(55, Math.max(0, Number(args.timeoutSeconds ?? 25))) * 1000;
        const cursor = typeof args.cursor === 'number' ? args.cursor : session.seen;
        const types = Array.isArray(args.types) ? (args.types as string[]) : null;
        const about = args.agent as string | undefined;
        const base = relevantTo(caller);
        const batch = await this.journal.waitFor(cursor, timeout,
          (e) => base(e) && (!types || types.includes(e.type)) && (!about || e.agentId === about));
        session.seen = Math.max(session.seen, batch.cursor);
        const head = batch.events.length
          ? `## ${batch.events.length} event${batch.events.length === 1 ? '' : 's'}\n${formatEvents(batch.events, 40)}`
          : `No changes in ${Math.round(timeout / 1000)}s.`;
        return text([
          head,
          batch.missed ? '\n⚠ Some older events were dropped from the journal — call orch_snapshot to resync.' : '',
          `\ncursor: ${batch.cursor}  (pass this to the next orch_wait_for_events)`,
        ].filter(Boolean).join('\n'));
      }

      case 'canvas_get_elements':
        return json(await this.getCanvasElements());

      case 'canvas_get_agent': {
        const id = args.agentId as string;
        const agent = this.knownAgents().find((a) => a.agentId === id)!;
        const st = this.mesh.getStatus(id);
        const rt = this.getAgentRuntime().find((r) => r.agentId === id);
        const output = await this.readAgentOutput(id, 40);
        return text([
          `## ${agent.name} (${agent.providerId || 'shell'}) — id ${id}${id === this.controllerId ? ' ★controller' : ''}`,
          `- Doing: ${st ? `${st.phase}${st.task ? ' — ' + st.task : ''}` : 'has not reported'}`,
          st?.files.length ? `- Files: ${st.files.join(', ')}` : '',
          `- Terminal: ${rt ? `${rt.terminal}, idle ${Math.round(rt.idleMs / 1000)}s` : 'none'}`,
          `- Connected to ORCH: ${this.connectedAgentIds().has(id) ? 'yes' : 'no'}`,
          rt?.approval ? `- ⚠ Waiting for the user: ${rt.approval.detail}` : '',
          '', '--- Recent terminal output ---', output || '(nothing yet)',
        ].filter(Boolean).join('\n'));
      }

      case 'canvas_move_agent':
        await this.moveAgent(args.agentId as string, args.x as number, args.y as number);
        return text(`Moved ${this.nameOf(args.agentId as string)} → (${args.x}, ${args.y})`);

      case 'canvas_send_message': {
        const id = args.agentId as string;
        if (id === caller) return fail('That is you. canvas_send_message types into another agent\'s terminal.');
        const r = await this.sendToAgent(id, String(args.message));
        return r.ok ? text(`Typed into ${this.nameOf(id)}'s terminal and submitted.`) : fail(`Could not reach ${this.nameOf(id)}: ${r.reason}`);
      }

      case 'canvas_read_output': {
        const lines = Math.min(400, Math.max(1, Number(args.lines ?? 50)));
        const out = await this.readAgentOutput(args.agentId as string, lines);
        return text(out || `${this.nameOf(args.agentId as string)} has no terminal output yet.`);
      }

      case 'canvas_create_agent':
        return json(await this.createAgent(
          args.providerId as string, args.name as string | undefined, args.contextSnapshot as string | undefined));

      case 'canvas_remove_agent': {
        const id = args.agentId as string;
        const name = this.nameOf(id);
        await this.removeAgent(id);
        return text(`${name} removed`);
      }

      case 'canvas_list_sessions':
        return json(Array.from(this.sessions.entries()).map(([id, s]) => ({
          id, agentId: s.agentId, name: s.name, kind: s.kind, providerId: s.providerId,
          hibernating: s.hibernating, bufferChunks: s.buffer.length,
        })));

      // ── Event Bus tools ──────────────────────────────────
      case 'canvas_emit_event': {
        const event = this.eventBus.emit(
          args.type as string, (args.sourceAgentId as string) || 'orch',
          (args.data as Record<string, unknown>) || {}, args.targetAgentId as string | undefined);
        this.scheduleEventNotification(event);
        return text(`Event ${event.id} emitted`);
      }

      case 'canvas_get_events':
        return json(this.eventBus.getEvents({
          since: args.since as number | undefined,
          eventTypes: args.eventTypes as string[] | undefined,
          limit: (args.limit as number) || 20,
        }).filter((e) => e.type !== 'terminal_line'));

      case 'canvas_subscribe': {
        const agentId = (args.sourceAgentId as string) || 'orch';
        const types = args.eventTypes as string[] | undefined;
        this.eventBus.subscribe(agentId, types || []);
        return text(`Subscribed ${this.nameOf(agentId)} to ${types?.length ? types.join(', ') : 'all events'}`);
      }

      // ── Blackboard / Delegation tools ────────────────────
      case 'delegate_task': {
        const sourceAgentId = args.sourceAgentId as string;
        let delegationDepth = 0;
        const parentTaskId = args.parentTaskId as string | undefined;
        if (parentTaskId) {
          const parent = this.eventBus.getTask(parentTaskId);
          if (!parent) return fail(`No task ${parentTaskId}. query_tasks lists the open ones.`);
          delegationDepth = parent.delegationDepth + 1;
        }
        const task = this.eventBus.postTask(
          args.title as string, args.description as string, sourceAgentId,
          (args.contextSnapshot as string) || JSON.stringify({}), parentTaskId, delegationDepth,
          (args.tags as string[]) || []);
        if (!task) {
          return fail(`Delegation rejected: max depth (${this.eventBus.getMaxDelegationDepth()}) reached. Cannot delegate further.`);
        }
        this.eventBus.emit('delegation_created', sourceAgentId, {
          taskId: task.id, title: task.title, delegationDepth: task.delegationDepth, parentTaskId,
        });
        return json(task);
      }

      case 'claim_task': {
        const existing = this.eventBus.getTask(args.taskId as string);
        if (!existing) return fail(`No task ${args.taskId}. query_tasks { status: "pending" } lists claimable ones.`);
        const task = this.eventBus.claimTask(args.taskId as string, args.claimantAgentId as string);
        if (!task) return fail(`Task ${args.taskId} is ${existing.status}${existing.claimantAgentId ? ` (claimed by ${this.nameOf(existing.claimantAgentId)})` : ''}; only pending tasks can be claimed.`);
        return json(task);
      }

      case 'complete_task': {
        const task = this.eventBus.completeTask(args.taskId as string, args.result as string);
        if (!task) return fail(`No task ${args.taskId}.`);
        this.artifactRegistry.storeMemory(
          task.claimantAgentId || caller || 'unknown', task.title, 'success', [], [], task.tags,
          task.delegationDepth, { taskId: task.id, result: String(args.result).slice(0, 2000) });
        return json(task);
      }

      case 'fail_task': {
        const task = this.eventBus.failTask(args.taskId as string, args.error as string);
        if (!task) return fail(`No task ${args.taskId}.`);
        this.artifactRegistry.storeMemory(
          task.claimantAgentId || caller || 'unknown', task.title, 'failure', [],
          [String(args.error).slice(0, 500)], task.tags, task.delegationDepth, { taskId: task.id });
        return json(task);
      }

      case 'query_tasks':
        return json(this.eventBus.queryTasks({
          status: args.status as any,
          sourceAgentId: args.sourceAgentId as string | undefined,
          claimantAgentId: args.claimantAgentId as string | undefined,
          tags: args.tags as string[] | undefined,
          limit: (args.limit as number) || 20,
        }));

      case 'get_task': {
        const task = this.eventBus.getTask(args.taskId as string);
        return task ? json(task) : fail(`No task ${args.taskId}.`);
      }

      // ── Artifact / Memory tools ──────────────────────────
      case 'canvas_store_artifact': {
        const artifact = this.artifactRegistry.create(
          args.sourceAgentId as string, args.type as any, args.title as string,
          (args.description as string) || '', (args.data as Record<string, unknown>) || {}, (args.tags as string[]) || []);
        this.eventBus.emit('artifact_created', args.sourceAgentId as string, {
          artifactId: artifact.id, type: artifact.type, title: artifact.title,
        });
        return json(artifact);
      }

      case 'canvas_store_memory': {
        const memory = this.artifactRegistry.storeMemory(
          args.sourceAgentId as string, args.taskIntent as string, args.outcome as any,
          (args.criticalFilesMutated as string[]) || [], (args.errorsEncountered as string[]) || [],
          (args.workspaceKeywords as string[]) || [], (args.delegationDepth as number) || 0,
          (args.extraData as Record<string, unknown>) || {});
        this.eventBus.emit('memory_created', args.sourceAgentId as string, {
          artifactId: memory.id, taskIntent: memory.data.taskIntent, outcome: memory.data.outcome,
        });
        return json(memory);
      }

      case 'canvas_get_artifacts':
        return json(this.artifactRegistry.query({
          agentId: args.agentId as string | undefined,
          types: args.types as any[] | undefined,
          tags: args.tags as string[] | undefined,
          limit: (args.limit as number) || 20,
        }));

      case 'canvas_get_artifact': {
        const a = this.artifactRegistry.getById(args.artifactId as string);
        return a ? json(a) : fail(`No artifact ${args.artifactId}. canvas_get_artifacts lists them.`);
      }

      case 'canvas_recall':
        return json(this.artifactRegistry.recall(args.keywords as string[], {
          agentId: args.agentId as string | undefined,
          types: args.types as any[] | undefined,
          limit: (args.limit as number) || 10,
        }));

      // ── Agent mesh ────────────────────────────────────────
      case 'agent_set_status': {
        const id = args.sourceAgentId as string;
        const status = this.mesh.setStatus(id, {
          phase: args.phase as any,
          task: args.task as string | undefined,
          detail: args.detail as string | undefined,
          progress: args.progress as number | undefined,
          files: args.files as string[] | undefined,
          tags: args.tags as string[] | undefined,
        });
        if (!status) {
          return fail(`ORCH has no agent ${id}. ${knownAgentsLine(this.knownAgents())}`);
        }
        // Surface collisions immediately — an agent that learns about a
        // shared file only at merge time has already lost the work.
        const conflicts = this.mesh.fileConflicts().filter((c) => c.agents.some((a) => a.agentId === id));
        const warn = conflicts.length
          ? '\n\nHEADS UP - you share files with other agents:\n' +
            conflicts.map((c) => '  ' + c.file + ': also ' +
              c.agents.filter((a) => a.agentId !== id).map((a) => a.name).join(', ')).join('\n')
          : '';
        return text(`Status updated: ${status.phase}${status.task ? ' - ' + status.task : ''}${warn}`);
      }

      case 'agent_roster': {
        const digest = this.mesh.digest();
        if (digest.length === 0) return text('No agents registered.');
        // Compact markdown rather than JSON: this lands in another
        // model's context window, where tokens are the scarce resource.
        const connected = this.connectedAgentIds();
        const rows = digest.map((d) => {
          const mins = Math.round(d.elapsedMs / 60000);
          const age = mins < 1 ? '<1m' : mins + 'm';
          const prog = d.progress !== undefined ? ' ' + d.progress + '%' : '';
          const files = d.files.length ? d.files.slice(0, 3).join(', ') : '-';
          const tag = `${d.agentId === caller ? ' (you)' : ''}${d.agentId === this.controllerId ? ' ★' : ''}`;
          return `| ${d.name}${tag} | ${d.providerId} | ${d.phase}${prog} | ${d.task || '-'} | ${age} | ${files} | ${connected.has(d.agentId) ? 'yes' : 'no'} |`;
        });
        const conflicts = this.mesh.fileConflicts();
        const conflictText = conflicts.length
          ? '\n\n### File conflicts\n' + conflicts.map((c) =>
              '- ' + c.file + ' - ' + c.agents.map((a) => a.name).join(' + ')).join('\n')
          : '';
        return text([
          '## Agents (' + digest.length + ')' + (this.controllerId ? ` · controller: ${this.nameOf(this.controllerId)}` : ''), '',
          '| Agent | Provider | Phase | Working on | For | Files | Connected |',
          '|---|---|---|---|---|---|---|',
          ...rows,
          conflictText,
        ].join('\n'));
      }

      case 'agent_send': {
        const fromId = args.sourceAgentId as string;
        const fromName = this.mesh.getStatus(fromId)?.name ?? this.nameOf(fromId);
        let toId: string | null = null;
        let toName: string | undefined;
        let toUser = false;
        if (args.to === '__orch__') {
          if (this.controllerId && this.controllerId !== fromId) {
            toId = this.controllerId;
            toName = this.nameOf(this.controllerId);
          } else {
            toUser = true;
            toName = 'the user';
          }
        } else if (args.to) {
          toId = args.to as string;
          if (toId === fromId) return fail('That is you. Name another agent, or use to: "orch".');
          toName = this.nameOf(toId);
        }
        const message = this.mesh.send({
          from: fromId, fromName, to: toUser ? '__user__' : toId, toName,
          subject: args.subject as string, body: args.body as string,
          kind: (args.kind as AgentMessage['kind']) ?? 'note', replyTo: args.replyTo as string | undefined,
        });
        if (toUser) {
          this.journal.append({
            type: 'message_to_user', agentId: fromId, agentName: fromName,
            summary: `${fromName} to the user: ${message.subject}`, data: { messageId: message.id },
          });
          this.onUserMessage(message);
          return text(`Delivered to the user (no other controller is set). Message ${message.id}.`);
        }
        return text(`Sent ${message.id} to ${toName ?? 'all agents'}${toId && toId === this.controllerId ? ' (the controller)' : ''}.`);
      }

      case 'agent_inbox': {
        const id = args.sourceAgentId as string;
        const msgs = this.mesh.inbox(id, { unreadOnly: args.unreadOnly !== false });
        if (args.markRead !== false) this.mesh.markRead(id, msgs.map((m) => m.id));
        if (msgs.length === 0) return text('No new messages.');
        return text('## Inbox (' + msgs.length + ')\n\n' + msgs.map((m) =>
          '### ' + m.kind.toUpperCase() + ' from ' + m.fromName + (m.to === null ? ' (broadcast)' : '') + '\n' +
          '**' + m.subject + '**\n' + m.body + '\n_id: ' + m.id + (m.replyTo ? ', replying to ' + m.replyTo : '') + '_',
        ).join('\n\n'));
      }

      // ── App actions ───────────────────────────────────────
      case 'canvas_add_file': {
        const result = await this.addCanvasFile({
          agentId: args.sourceAgentId as string, path: args.path as string, title: args.title as string | undefined,
          x: args.x as number | undefined, y: args.y as number | undefined,
          width: args.width as number | undefined, height: args.height as number | undefined,
        });
        return { ...json(result), isError: !!(result as any)?.error };
      }

      case 'canvas_add_note':
        return json(await this.addCanvasNote({
          agentId: args.sourceAgentId as string, text: args.text as string,
          x: args.x as number | undefined, y: args.y as number | undefined,
        }));

      case 'app_action': {
        const result = await this.appAction(args.action as string, (args.params as Record<string, unknown>) ?? {});
        return { ...json(result), isError: !!(result as any)?.error };
      }

      case 'list_app_actions':
        return text(APP_ACTION_HELP);

      // ── Layout tools ──────────────────────────────────────
      case 'canvas_arrange': {
        const mode = (args.mode as string) || 'grid';
        return text(`Canvas arranged: ${mode}\n${JSON.stringify(await this.arrange(mode))}`);
      }

      // ── Provider tools ────────────────────────────────────
      case 'list_providers':
        return json(this.getProviders?.() || []);

      default:
        return fail(`Unknown tool: ${name}`);
    }
  }
}

/** What the controller is told, in its instructions and by orch_whoami. */
const CONTROLLER_BRIEF = [
  'You are the ORCH CONTROLLER: the user chose you to coordinate the other agents on the canvas.',
  '- Get the full picture with orch_snapshot (it returns a cursor).',
  '- Stay in sync in real time: call orch_wait_for_events with that cursor. It returns the moment anything changes — an agent starts, finishes, gets blocked or fails, messages arrive for you, a permission prompt opens, an agent joins or leaves, a task moves — and gives you the next cursor. Every other ORCH reply also ends with what changed since your last call.',
  '- Hand out work with canvas_send_message (types a prompt into an agent) or agent_send (a note it reads when ready); use delegate_task for work any agent may claim.',
  '- Agents report to you with agent_send to "orch"; read them with agent_inbox.',
  '- You cannot answer another agent\'s permission prompt. When one is waiting, tell the user what it needs.',
];

export type { SyncEvent };
export { shortAgentName };
