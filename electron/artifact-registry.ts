// ── ORCH Artifact Registry ──────────────────────────────────────
// Structured shared state layer for agent outputs and episodic memory.
// Instead of dumping raw terminal buffers, agents write typed
// artifacts (files, summaries, results) that other agents can query.
// Memory artifacts include intent, outcome, files mutated, and
// errors encountered — enabling contextual recall across sessions.
//
// PERSISTENCE: every mutation is written through local-db.ts so
// artifacts survive app restarts. On construction the registry
// re-hydrates all persisted artifacts into the working store.
//
// RECALL: two-tier scoring — keyword match (fast) → trigram
// Jaccard similarity (fuzzy fallback) for semantic-like recall
// without external vector infrastructure.

import {
  saveArtifact,
  saveArtifactsBulk,
  loadAllArtifacts,
  deleteArtifact as dbDeleteArtifact,
  deleteAgentArtifacts as dbDeleteAgentArtifacts,
  clearAllArtifacts as dbClearAllArtifacts,
  type PersistedArtifact,
} from './local-db.js';

// ── Types ──────────────────────────────────────────────────────────

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

const MAX_INMEMORY_ARTIFACTS = 2000;

/** Convert a PersistedArtifact (from JSON) back to Artifact. */
function hydrate(a: PersistedArtifact): Artifact {
  return {
    id: a.id,
    agentId: a.agentId,
    type: a.type as Artifact['type'],
    title: a.title,
    description: a.description,
    data: a.data as Record<string, unknown>,
    tags: a.tags ?? [],
    timestamp: a.timestamp ?? Date.now(),
  };
}

// ── Trigram Jaccard similarity for fuzzy recall ──────────────────

/** Build a character-trigram set from a string. */
function trigrams(s: string): Set<string> {
  const set = new Set<string>();
  const norm = s.toLowerCase().replace(/[^a-z0-9\s]/g, '');
  if (norm.length <= 2) {
    set.add(norm);
    return set;
  }
  for (let i = 0; i <= norm.length - 3; i++) {
    set.add(norm.slice(i, i + 3));
  }
  return set;
}

/** Jaccard similarity between two trigram sets: |A ∩ B| / |A ∪ B| */
function jaccard(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Token-distance score: fraction of query tokens that appear in the target text. */
function tokenOverlap(queryTokens: string[], target: string): number {
  if (queryTokens.length === 0) return 0;
  const lower = target.toLowerCase();
  let hits = 0;
  for (const t of queryTokens) {
    if (lower.includes(t)) hits++;
  }
  return hits / queryTokens.length;
}

// ── Registry ─────────────────────────────────────────────────────

export class ArtifactRegistry {
  private artifacts: Artifact[] = [];
  private nextId = 1;

  constructor() {
    this.rehydrate();
  }

  /** Load persisted artifacts on startup so nothing is lost across restarts. */
  private rehydrate(): void {
    try {
      const persisted = loadAllArtifacts();
      if (persisted.length > 0) {
        this.artifacts = persisted.map(hydrate);
        // Recover nextId from highest existing id
        const maxNum = this.artifacts.reduce((max, a) => {
          const match = a.id.match(/^art_(\d+)$/);
          return match ? Math.max(max, parseInt(match[1], 10)) : max;
        }, 0);
        this.nextId = maxNum + 1;
        console.log(`[ArtifactRegistry] Re-hydrated ${this.artifacts.length} artifacts from disk (nextId=${this.nextId})`);
      }
    } catch (err) {
      console.warn('[ArtifactRegistry] Rehydration error (cold start):', err);
    }
  }

  /** Store a new artifact. Persisted immediately. */
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
    if (this.artifacts.length > MAX_INMEMORY_ARTIFACTS) {
      this.artifacts.splice(0, this.artifacts.length - MAX_INMEMORY_ARTIFACTS);
    }
    // Persist
    saveArtifact(artifact as PersistedArtifact);
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

  /** Contextual recall — two-tier scoring:
   *  1) Keyword match (fast) — scores tags > title > description > data
   *  2) Fuzzy fallback — trigram Jaccard similarity on low-result queries
   *
   * Agents call this at startup to understand what's already been done.
   */
  recall(
    keywords: string[],
    opts?: {
      agentId?: string;
      types?: Artifact['type'][];
      since?: number;
      limit?: number;
    },
  ): Artifact[] {
    const lowerKeywords = keywords.map((k) => k.toLowerCase().trim()).filter(Boolean);
    const limit = opts?.limit ?? 10;

    if (lowerKeywords.length === 0) return [];

    let pool = this.artifacts;

    // Pre-filter by agent / type / time
    if (opts?.agentId) pool = pool.filter((a) => a.agentId === opts.agentId);
    if (opts?.types) pool = pool.filter((a) => opts.types!.includes(a.type));
    if (opts?.since) pool = pool.filter((a) => a.timestamp > opts.since!);

    // ── Tier 1: Keyword scoring ────────────────────────────────
    const scored = pool.map((a) => {
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
      return { artifact: a, score, fuzzy: 0 };
    });

    const keywordHits = scored.filter((s) => s.score > 0);
    const keywordMisses = scored.filter((s) => s.score === 0);

    // If we already have enough keyword results, return those sorted
    if (keywordHits.length >= limit) {
      return keywordHits
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((s) => s.artifact);
    }

    // ── Tier 2: Fuzzy fallback (trigram Jaccard + token overlap) ──
    // Build a combined fuzzy score for the remaining artifacts
    const queryTrigrams = trigrams(lowerKeywords.join(' '));

    const fuzzyScored = keywordMisses.map((entry) => {
      const a = entry.artifact;
      const haystack = [a.title, a.description, a.tags.join(' '), JSON.stringify(a.data)].join(' ');

      const tgScore = jaccard(queryTrigrams, trigrams(haystack));
      const tokScore = tokenOverlap(lowerKeywords, haystack);
      const fuzzy = tgScore * 0.6 + tokScore * 0.4; // weighted combo

      return { artifact: a, score: 0, fuzzy };
    });

    // Merge: keyword hits first (by score), then fuzzy results (by fuzzy score)
    const merged = [
      ...keywordHits.sort((a, b) => b.score - a.score),
      ...fuzzyScored
        .filter((f) => f.fuzzy > 0.15) // noise floor
        .sort((a, b) => b.fuzzy - a.fuzzy),
    ];

    return merged.slice(0, limit).map((s) => s.artifact);
  }

  /** Get a specific artifact by ID. */
  getById(id: string): Artifact | undefined {
    return this.artifacts.find((a) => a.id === id);
  }

  /** Query artifacts with filters (fast, no fuzzy). */
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

  /** Delete a single artifact by id — removes from memory AND disk. */
  delete(id: string): boolean {
    const before = this.artifacts.length;
    this.artifacts = this.artifacts.filter((a) => a.id !== id);
    if (this.artifacts.length !== before) {
      dbDeleteArtifact(id);
      return true;
    }
    return false;
  }

  /** Delete all artifacts for an agent. */
  deleteByAgent(agentId: string): number {
    const before = this.artifacts.length;
    this.artifacts = this.artifacts.filter((a) => a.agentId !== agentId);
    const count = before - this.artifacts.length;
    if (count > 0) dbDeleteAgentArtifacts(agentId);
    return count;
  }

  /** Clear all artifacts (full reset). */
  reset(): void {
    this.artifacts = [];
    this.nextId = 1;
    dbClearAllArtifacts();
  }

  /** Current artifact count. */
  get size(): number {
    return this.artifacts.length;
  }
}
