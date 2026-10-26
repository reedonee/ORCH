// ── ORCH Voice Narration ────────────────────────────────────────
// Turns app events into spoken English.
//
// Everything the assistant says about an agent uses that agent's NAME.
// "Agent spawned" / "Agent closed" tells you nothing when four agents are
// running — you can't tell which one just finished, which is precisely
// when you need to know. "Max is ready" / "Sky is gone" is both shorter
// and unambiguous.
//
// Phrasing is drawn from small pools rather than fixed strings. A voice
// assistant that says the identical sentence every time reads as a
// machine within about three uses; light variation is most of what makes
// it feel considered. Variation is deterministic per call site, never
// random enough to be confusing about *what* happened.

/** Strip the " - Provider" suffix agents carry in their display name.
 *  Speech wants "Max", not "Max - Claude Code". */
export function shortName(name: string | undefined | null): string {
  if (!name) return 'the agent';
  return name.split(' - ')[0].trim() || 'the agent';
}

/** Join names the way a person would say them out loud. */
export function speakList(names: string[]): string {
  const clean = names.map(shortName).filter(Boolean);
  if (clean.length === 0) return 'no agents';
  if (clean.length === 1) return clean[0];
  if (clean.length === 2) return `${clean[0]} and ${clean[1]}`;
  if (clean.length === 3) return `${clean[0]}, ${clean[1]} and ${clean[2]}`;
  // Beyond three, naming them all is a mouthful and hard to follow.
  const rest = clean.length - 2;
  return `${clean[0]}, ${clean[1]} and ${rest} others`;
}

/** "is" / "are" to agree with how many agents were just named. */
function be(count: number): string {
  return count === 1 ? 'is' : 'are';
}

// ── Phrase pools ────────────────────────────────────────────────
// Rotated per event type, so consecutive events of the same kind differ
// but the vocabulary stays small and predictable.

const POOLS = {
  spinningUp: ['{n} {be} spinning up', '{n} {be} starting', 'Bringing {n} up'],
  ready:      ['{n} {be} ready', '{n} {be} good to go', '{n} {be} up'],
  removed:    ['{n} {be} gone', 'Closed {n}', '{n} {be} shut down'],
  focused:    ['Focused on {n}', 'Switched to {n}', '{n} {be} in focus'],
  sent:       ['Sent to {n}', 'Passed that to {n}', '{n} got it'],
  working:    ['{n} {be} working on it', '{n} {be} on it'],
  finished:   ['{n} finished', '{n} {be} done'],
  failed:     ['{n} hit an error', '{n} failed'],
  sleeping:   ['{n} {be} sleeping', 'Put {n} to sleep'],
  woken:      ['{n} {be} awake', 'Woke {n} up'],
  needsApproval: ['{n} needs your approval', '{n} {be} waiting for your OK', '{n} {be} asking permission'],
  approved:   ['Approved {n}', '{n} can go ahead'],
  denied:     ['Told {n} no', 'Denied {n}'],
  autoApprove:   ['{n} {be} on auto approve', 'Auto approve on for {n}'],
  manualApprove: ['{n} will ask first', 'Manual approval for {n}'],
  controllerSet: ['{n} {be} now the controller', '{n} {be} running the show', '{n} will coordinate'],
} as const;

export type NarrationEvent = keyof typeof POOLS;

const cursors = new Map<NarrationEvent, number>();

function pick(event: NarrationEvent): string {
  const pool = POOLS[event] as readonly string[];
  const i = cursors.get(event) ?? 0;
  cursors.set(event, (i + 1) % pool.length);
  return pool[i];
}

/**
 * Build a spoken sentence naming the agents involved.
 *
 *   narrate('ready', ['Max - Claude Code'])        → "Max is ready"
 *   narrate('ready', ['Max', 'Sky'])               → "Max and Sky are ready"
 *   narrate('removed', ['Zed'])                    → "Zed is gone"
 */
export function narrate(event: NarrationEvent, names: string[]): string {
  const list = speakList(names);
  return pick(event)
    .replace('{n}', list)
    .replace('{be}', be(names.length));
}

/**
 * Announce a permission prompt with what it is for, so the user can
 * decide without looking: "Max needs your approval: npm test".
 */
export function narrateApproval(name: string, detail: string, kind: 'tool' | 'trust'): string {
  const head = narrate('needsApproval', [name]);
  if (kind === 'trust') return `${head} to trust this folder`;
  // Commands can be long; the first few words are what identify them.
  const spoken = detail.length > 60 ? `${detail.slice(0, 57).replace(/\s+\S*$/, '')}…` : detail;
  return spoken ? `${head}: ${spoken}` : head;
}

/** Reset rotation. Used by tests so phrasing is deterministic. */
export function resetNarrationCursors(): void {
  cursors.clear();
}

// ── Counted phrasing ────────────────────────────────────────────

/** Small counts read better as words: "three agents", not "3 agents". */
const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten',
];

export function spokenCount(n: number): string {
  return n >= 0 && n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : String(n);
}

export function pluralAgents(n: number): string {
  return `${spokenCount(n)} agent${n === 1 ? '' : 's'}`;
}

/**
 * Describe removing agents, naming them when there are few enough for
 * that to be useful and falling back to a count when there aren't.
 */
export function narrateRemoval(names: string[]): string {
  if (names.length === 0) return 'Nothing to close';
  if (names.length <= 3) return narrate('removed', names);
  return `Closed ${pluralAgents(names.length)}`;
}

/**
 * Describe a spawn. Distinguishes "starting" from "ready" because they
 * are genuinely different moments — the process exists vs. it can accept
 * work — and conflating them makes the assistant feel like it's lying
 * when you talk to an agent that isn't listening yet.
 */
export function narrateSpawn(names: string[], phase: 'starting' | 'ready'): string {
  if (names.length === 0) return 'Nothing started';
  if (names.length > 3) {
    return phase === 'ready'
      ? `${pluralAgents(names.length)} ready`
      : `Spinning up ${pluralAgents(names.length)}`;
  }
  return narrate(phase === 'ready' ? 'ready' : 'spinningUp', names);
}

// ── Announcement claiming ───────────────────────────────────────
// Two code paths can notice the same spawn: the voice command that asked
// for it (which speaks a confirmation immediately) and App's lifecycle
// watcher (which sees the agent list change). Without coordination the
// user hears "Max is spinning up" twice, a beat apart.
//
// The command path claims the announcement; the watcher checks and skips.
// The claim is short-lived so a genuinely unrelated spawn moments later
// still gets narrated.

let claimedUntil = 0;
const CLAIM_WINDOW_MS = 1500;

/** Called by whoever is about to speak about a spawn. */
export function claimSpawnAnnouncement(): void {
  claimedUntil = Date.now() + CLAIM_WINDOW_MS;
}

/** True when someone else already announced this spawn. */
export function spawnAnnouncementClaimed(): boolean {
  return Date.now() < claimedUntil;
}
