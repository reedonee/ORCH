// Cycle through these names for new agents
const AGENT_NAMES = [
  'Max', 'Sky', 'Zuma', 'Astra', 'Chase',
  'Zed', 'Eve', 'Blade', 'Blue', 'Lily',
];

/**
 * Picks the next available agent name.
 * Uses first unused name from the list; if all taken, appends a number.
 */
export function pickAgentName(existingNames: string[]): string {
  // Extract base names (strip " - Provider" suffix)
  const taken = new Set(existingNames.map(n => n.split(' - ')[0]));

  // Try each name — first free one wins
  for (const name of AGENT_NAMES) {
    if (!taken.has(name)) return name;
  }

  // All names taken — use first name with incrementing suffix
  const base = AGENT_NAMES[0];
  let counter = 1;
  while (taken.has(`${base} ${counter}`)) counter++;
  return `${base} ${counter}`;
}
