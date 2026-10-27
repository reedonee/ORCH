// ── Remembered folder trust ─────────────────────────────────────
// "Do you trust this folder?" — once per agent type and folder, for good.
//
// Claude Code saves trust per project in ~/.claude.json, except for the
// home directory, where it is deliberately session-only. ORCH starts
// agents in the home directory whenever no workspace is open, so every
// new Claude agent asked again. ORCH now remembers the user's own "Trust"
// answer (on the card or by voice) per provider and folder, and answers
// that prompt on the user's behalf from then on.
//
// Only ever an answer the user already gave: nothing is trusted that the
// user did not approve once themselves, the Auto approval mode still
// never trusts a folder, and entries can be forgotten in Settings.
//
// Pure apart from the injected file path: tests/trust-store.check.mts.

import fs from 'fs';
import path from 'path';

export type TrustMap = Record<string, string[]>;

/** One spelling per folder: absolute, no trailing separator, and
 *  case-insensitive on Windows, where C:\Users and c:\users are one. */
export function normaliseFolder(folder: string, platform: NodeJS.Platform = process.platform): string {
  const P = platform === 'win32' ? path.win32 : path.posix;
  let p = P.resolve(folder).replace(/[\\/]+$/, '');
  if (/^[a-zA-Z]:$/.test(p)) p += P.sep;
  if (p === '') p = P.sep;
  return platform === 'win32' ? p.toLowerCase() : p;
}

export class TrustStore {
  private map: TrustMap = {};
  private readonly file: string;
  private readonly platform: NodeJS.Platform;

  constructor(file: string, platform: NodeJS.Platform = process.platform) {
    this.file = file;
    this.platform = platform;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
          if (Array.isArray(v)) this.map[k] = v.filter((x): x is string => typeof x === 'string');
        }
      }
    } catch { /* first run, or unreadable: start empty */ }
  }

  isTrusted(providerId: string, folder: string | undefined): boolean {
    if (!providerId || !folder) return false;
    return (this.map[providerId] ?? []).includes(normaliseFolder(folder, this.platform));
  }

  remember(providerId: string, folder: string | undefined): void {
    if (!providerId || !folder || this.isTrusted(providerId, folder)) return;
    (this.map[providerId] ??= []).push(normaliseFolder(folder, this.platform));
    this.save();
  }

  forget(providerId: string, folder: string): boolean {
    const list = this.map[providerId];
    if (!list) return false;
    const n = normaliseFolder(folder, this.platform);
    const next = list.filter((f) => f !== n);
    if (next.length === list.length) return false;
    if (next.length) this.map[providerId] = next; else delete this.map[providerId];
    this.save();
    return true;
  }

  list(): Array<{ providerId: string; folder: string }> {
    return Object.entries(this.map).flatMap(([providerId, folders]) => folders.map((folder) => ({ providerId, folder })));
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.map, null, 2), 'utf8');
    } catch (err) {
      console.warn('[Trust] could not save trusted folders:', err);
    }
  }
}
