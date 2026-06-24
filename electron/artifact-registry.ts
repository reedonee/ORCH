// ── ORCH Artifact Registry ──────────────────────────────────────
// Structured shared state layer for agent outputs and episodic memory.
// Instead of dumping raw terminal buffers, agents write typed
// artifacts (files, summaries, results) that other agents can query.
// Memory artifacts include intent, outcome, files mutated, and
// errors encountered — enabling contextual recall across sessions.

export interface Artifact {
  id: string;
  agentId: string;
  type: 'file' | 'summary' | 'status' | 'error' | 'result' | 'message' | 'memory';
  title: string;
  description: string;
  data: Record<string, unknown>;
  tags: string[];
  timestamp: number;
}

/** Episodic memory — richer than a basic artifact, captures intent + outcome. */
export interface MemoryArtifact extends Artifact {
  type: 'memory';
  data: {
    taskIntent: string;
    outcome: 'success' | 'failure' | 'cancelled' | 'unknown';
    criticalFilesMutated: string[];
    errorsEncountered: string[];
    delegationDepth: number;
    workspaceKeywords: string[];
    [key: string]: unknown;
  };
}

const MAX_ARTIFACTS = 1000;

export class ArtifactRegistry {
  private artifacts: Artifact[] = [];
  private nextId = 1;

  /** Store a new artifact. */
  create(
    agentId: string,
    type: Artifact['type'],
    title: string,
    description: string = '',
    data: Record<string, unknown> = {},
    tags: string[] = [],
  ): Artifact {
    const artifact: Artifact = {
      id: `art_${this.nextId++}`,
      agentId,
      type,
      title,
      description,
      data,
      tags,
      timestamp: Date.now(),
    };
    this.artifacts.push(artifact);
    if (this.artifacts.length > MAX_ARTIFACTS) {
      this.artifacts.splice(0, this.artifacts.length - MAX_ARTIFACTS);
    }
    return artifact;
  }

  /** Store an episodic memory artifact — structured intent/outcome/mutations. */
  storeMemory(
    agentId: string,
    taskIntent: string,
    outcome: MemoryArtifact['data']['outcome'],
    criticalFilesMutated: string[] = [],
    errorsEncountered: string[] = [],
    workspaceKeywords: string[] = [],
    delegationDepth: number = 0,
    extraData: Record<string, unknown> = {},
  ): MemoryArtifact {
    const artifact = this.create(
      agentId,
      'memory',
      `Memory: ${taskIntent.slice(0, 60)}`,
      outcome === 'success' ? `✅ ${taskIntent}` : `❌ ${taskIntent}`,
      {
        taskIntent,
        outcome,
        criticalFilesMutated,
        errorsEncountered,
        delegationDepth,
        workspaceKeywords,
        ...extraData,
      } as MemoryArtifact['data'],
      ['memory', outcome, ...workspaceKeywords],
    ) as MemoryArtifact;
    return artifact;
  }

  /** Contextual recall — find artifacts relevant to a set of keywords.
   *  This is what agents call when they start a new task to understand
   *  what has already been done. It matches against tags, titles, and
   *  descriptions that contain the given keywords. */
  recall(
    keywords: string[],
    opts?: {
      agentId?: string;
      types?: Artifact['type'][];
      since?: number;
      limit?: number;
    },
  ): Artifact[] {
    const lowerKeywords = keywords.map((k) => k.toLowerCase());
    let filtered = this.artifacts;

    if (opts?.agentId) filtered = filtered.filter((a) => a.agentId === opts.agentId);
    if (opts?.types) filtered = filtered.filter((a) => opts.types!.includes(a.type));
    if (opts?.since) filtered = filtered.filter((a) => a.timestamp > opts.since!);

    // Score by relevance: tag match > title match > description match
    const scored = filtered.map((a) => {
      let score = 0;
      const tagText = a.tags.join(' ').toLowerCase();
      const titleText = a.title.toLowerCase();
      const descText = a.description.toLowerCase();
      const dataText = JSON.stringify(a.data).toLowerCase();

      for (const kw of lowerKeywords) {
        if (tagText.includes(kw)) score += 3;
        if (titleText.includes(kw)) score += 2;
        if (descText.includes(kw)) score += 1;
        if (dataText.includes(kw)) score += 1;
      }
      return { artifact: a, score };
    });

    const limit = opts?.limit ?? 10;
    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.artifact);
  }

  /** Get a specific artifact by ID. */
  getById(id: string): Artifact | undefined {
    return this.artifacts.find((a) => a.id === id);
  }

  /** Query artifacts with filters. */
  query(opts?: {
    agentId?: string;
    types?: Artifact['type'][];
    tags?: string[];
    since?: number;
    limit?: number;
  }): Artifact[] {
    let filtered = this.artifacts;
    if (opts?.agentId) filtered = filtered.filter((a) => a.agentId === opts.agentId);
    if (opts?.types) filtered = filtered.filter((a) => opts.types!.includes(a.type));
    if (opts?.tags) filtered = filtered.filter((a) => opts.tags!.some((t) => a.tags.includes(t)));
    if (opts?.since) filtered = filtered.filter((a) => a.timestamp > opts.since!);
    return filtered.slice(-(opts?.limit ?? 50));
  }

  /** Get all artifacts for a specific agent (newest first). */
  getByAgent(agentId: string, limit: number = 20): Artifact[] {
    return this.artifacts
      .filter((a) => a.agentId === agentId)
      .reverse()
      .slice(0, limit);
  }

  /** Clear all artifacts. */
  reset(): void {
    this.artifacts = [];
  }
}
