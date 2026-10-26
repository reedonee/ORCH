// ── ORCH Session Transcript Log ─────────────────────────────────
// Append-only, byte-exact capture of everything a PTY ever emitted.
//
// WHY THIS EXISTS
//
// Agent output was previously lost at four independent points:
//
//   1. main.ts kept only the last 2000 chunks in memory (MAX_BUF_LINES)
//   2. read_terminal returned `buffer.join('').split('\n').slice(-200)`
//      — capped at 200 lines AND corrupting the stream, because splitting
//      on '\n' and rejoining destroys lone '\r' carriage returns, which
//      is exactly how progress bars, spinners and TUI redraws work
//   3. local-db truncated the saved buffer to 50 KB
//   4. xterm's own scrollback held 5000 lines
//
// For an app whose whole value is "an agent did work while you were
// away", silently discarding what it did is disqualifying. A build log,
// a stack trace, or the one line explaining why a task failed is
// routinely more than 2000 chunks back.
//
// The fix is to stop treating memory as the store. Raw bytes stream to a
// per-session file and are never truncated while the session lives. RAM
// keeps a bounded tail purely as a fast path; the file is the truth.

import { app } from 'electron';
import path from 'path';
import fs from 'fs';

/** Bytes of the live tail held in memory for instant reads. */
const TAIL_BYTES = 256 * 1024;

/** Sessions older than this are pruned at startup. */
const RETENTION_DAYS = 30;

/** Stop pruning once the transcript directory is under this size. */
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

function transcriptDir(): string {
  const dir = path.join(app.getPath('userData'), 'orch-local', 'transcripts');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Session ids are generated internally, but they reach here from IPC, so
 *  never let one escape the transcript directory. */
function safeName(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200);
}

function logPath(sessionId: string): string {
  return path.join(transcriptDir(), `${safeName(sessionId)}.log`);
}

interface LiveLog {
  stream: fs.WriteStream;
  /** Rolling tail of raw bytes, for reads that don't need the whole file. */
  tail: Buffer;
  bytesWritten: number;
  startedAt: number;
}

const live = new Map<string, LiveLog>();

/** Begin capturing a session. Safe to call twice. */
export function openSessionLog(sessionId: string): void {
  if (live.has(sessionId)) return;
  try {
    const stream = fs.createWriteStream(logPath(sessionId), { flags: 'a' });
    stream.on('error', (err) => {
      console.error(`[SessionLog] write error for ${sessionId}:`, err.message);
    });
    live.set(sessionId, {
      stream,
      tail: Buffer.alloc(0),
      bytesWritten: 0,
      startedAt: Date.now(),
    });
  } catch (err) {
    console.error(`[SessionLog] Failed to open log for ${sessionId}:`, err);
  }
}

/**
 * Append raw PTY output verbatim.
 *
 * `data` is written byte-for-byte: no line splitting, no ANSI stripping,
 * no trimming. Replaying the file into a terminal reproduces the session
 * exactly, including colour, cursor movement and in-place redraws.
 */
export function appendSessionLog(sessionId: string, data: string): void {
  const entry = live.get(sessionId);
  if (!entry) return;

  const buf = Buffer.from(data, 'utf8');
  entry.bytesWritten += buf.length;

  // Backpressure is handled by the stream's internal buffer; dropping
  // output to avoid it would defeat the point of this module.
  entry.stream.write(buf);

  entry.tail = entry.tail.length + buf.length <= TAIL_BYTES
    ? Buffer.concat([entry.tail, buf])
    : Buffer.concat([entry.tail, buf]).subarray(-TAIL_BYTES);
}

/** Close the stream. The file stays on disk and remains readable. */
export function closeSessionLog(sessionId: string): void {
  const entry = live.get(sessionId);
  if (!entry) return;
  try { entry.stream.end(); } catch { /* already closed */ }
  live.delete(sessionId);
}

/** In-memory tail. Fast; used for terminal restore on remount. */
export function readSessionTail(sessionId: string, maxBytes = TAIL_BYTES): string {
  const entry = live.get(sessionId);
  if (entry) {
    return entry.tail.subarray(-Math.max(0, maxBytes)).toString('utf8');
  }
  // Not live — fall back to the tail of the file on disk.
  return readSessionRange(sessionId, -maxBytes);
}

/**
 * Read from the transcript file.
 * `offset >= 0` reads forward from that byte; negative reads the last N.
 */
export function readSessionRange(sessionId: string, offset: number, length?: number): string {
  const file = logPath(sessionId);
  if (!fs.existsSync(file)) return '';
  try {
    const size = fs.statSync(file).size;
    const start = offset < 0 ? Math.max(0, size + offset) : Math.min(offset, size);
    const end = length ? Math.min(start + length, size) : size;
    if (end <= start) return '';

    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(end - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    console.error(`[SessionLog] read failed for ${sessionId}:`, err);
    return '';
  }
}

/** Whole transcript. Can be large — used for export and search. */
export function readSessionFull(sessionId: string): string {
  return readSessionRange(sessionId, 0);
}

export interface SessionLogStats {
  sessionId: string;
  bytes: number;
  live: boolean;
  modifiedAt: number;
}

export function sessionLogStats(sessionId: string): SessionLogStats | null {
  const file = logPath(sessionId);
  if (!fs.existsSync(file)) return null;
  const st = fs.statSync(file);
  return {
    sessionId,
    bytes: st.size,
    live: live.has(sessionId),
    modifiedAt: st.mtimeMs,
  };
}

export function listSessionLogs(): SessionLogStats[] {
  try {
    return fs.readdirSync(transcriptDir())
      .filter((f) => f.endsWith('.log'))
      .map((f) => {
        const st = fs.statSync(path.join(transcriptDir(), f));
        const id = f.replace(/\.log$/, '');
        return { sessionId: id, bytes: st.size, live: live.has(id), modifiedAt: st.mtimeMs };
      })
      .sort((a, b) => b.modifiedAt - a.modifiedAt);
  } catch {
    return [];
  }
}

export interface TranscriptMatch {
  /** Byte offset of the match within the transcript. */
  offset: number;
  /** 1-based line number, counting '\n' only. */
  line: number;
  /** The matching line, ANSI stripped, capped for display. */
  text: string;
}

// Matches CSI/OSC/SS2/SS3 sequences. Kept here rather than imported so the
// transcript stays the only place that decides what "plain text" means.
const ANSI_PATTERN =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-PR-TZcf-ntqry=><~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '');
}

/** Search a transcript. Returns matches with line numbers for jump-to. */
export function searchSessionLog(
  sessionId: string,
  query: string,
  opts?: { caseSensitive?: boolean; regex?: boolean; limit?: number },
): TranscriptMatch[] {
  if (!query) return [];
  const text = readSessionFull(sessionId);
  if (!text) return [];

  const limit = opts?.limit ?? 500;
  const matches: TranscriptMatch[] = [];

  let matcher: RegExp;
  try {
    const flags = opts?.caseSensitive ? 'g' : 'gi';
    matcher = opts?.regex
      ? new RegExp(query, flags)
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  } catch {
    return []; // invalid user-supplied regex
  }

  // Search the ANSI-stripped text so a colour code between characters
  // can't hide a match, then report positions in that same space.
  const plain = stripAnsi(text);
  const lines = plain.split('\n');

  let offset = 0;
  for (let i = 0; i < lines.length && matches.length < limit; i++) {
    matcher.lastIndex = 0;
    if (matcher.test(lines[i])) {
      matches.push({
        offset,
        line: i + 1,
        text: lines[i].slice(0, 500),
      });
    }
    offset += lines[i].length + 1;
  }
  return matches;
}

/** Delete one transcript. */
export function deleteSessionLog(sessionId: string): void {
  closeSessionLog(sessionId);
  try { fs.rmSync(logPath(sessionId), { force: true }); } catch { /* ignore */ }
}

/**
 * Prune old transcripts. Runs at startup only, and never touches a live
 * session — an agent's own history disappearing mid-run would be worse
 * than the disk usage it saves.
 */
export function pruneSessionLogs(): { removed: number; freedBytes: number } {
  let removed = 0;
  let freedBytes = 0;
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const all = listSessionLogs();

    for (const entry of all) {
      if (entry.live) continue;
      if (entry.modifiedAt < cutoff) {
        freedBytes += entry.bytes;
        removed++;
        deleteSessionLog(entry.sessionId);
      }
    }

    // Still oversized after the age pass — drop oldest first.
    let total = listSessionLogs().reduce((n, e) => n + e.bytes, 0);
    if (total > MAX_TOTAL_BYTES) {
      const oldestFirst = listSessionLogs().filter((e) => !e.live).reverse();
      for (const entry of oldestFirst) {
        if (total <= MAX_TOTAL_BYTES) break;
        total -= entry.bytes;
        freedBytes += entry.bytes;
        removed++;
        deleteSessionLog(entry.sessionId);
      }
    }

    if (removed > 0) {
      console.log(`[SessionLog] Pruned ${removed} transcript(s), freed ${(freedBytes / 1024 / 1024).toFixed(1)} MB`);
    }
  } catch (err) {
    console.error('[SessionLog] Prune failed:', err);
  }
  return { removed, freedBytes };
}

/** Flush every open stream. Call on quit. */
export function flushSessionLogs(): void {
  for (const [id, entry] of live) {
    try { entry.stream.end(); } catch { /* ignore */ }
    live.delete(id);
  }
}

export function getTranscriptDir(): string {
  return transcriptDir();
}
