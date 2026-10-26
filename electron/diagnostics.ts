// ── ORCH Diagnostics ────────────────────────────────────────────
// Local crash and error capture.
//
// Before this, ORCH had no error sink of any kind: no crashReporter, no
// telemetry, no log file. A renderer crash showed a blank window, a main
// process throw killed the app silently, and the only way a bug reached
// the developer was a user noticing and filing one by hand.
//
// PRIVACY POSTURE: everything stays on this machine. Reports are written
// to userData and shown in-app; nothing is uploaded. Agent output can
// contain source code, file paths and credentials, so shipping crash
// dumps to a third party by default would be indefensible for this app.
// The user can attach a report to a bug report explicitly.

import { app, crashReporter, dialog } from 'electron';
import path from 'path';
import fs from 'fs';

const MAX_REPORTS = 50;

export interface CrashReport {
  id: string;
  kind: 'main-exception' | 'main-rejection' | 'renderer-crash' | 'renderer-error' | 'child-crash';
  message: string;
  stack?: string;
  timestamp: string;
  appVersion: string;
  platform: string;
  arch: string;
  electron: string;
  /** Free-form extra context from the reporting site. */
  context?: Record<string, unknown>;
}

function reportsDir(): string {
  const dir = path.join(app.getPath('userData'), 'orch-local', 'crash-reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function baseFields() {
  return {
    timestamp: new Date().toISOString(),
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron ?? 'unknown',
  };
}

/** Persist one report. Never throws — a failure here must not cascade. */
export function recordCrash(
  kind: CrashReport['kind'],
  error: unknown,
  context?: Record<string, unknown>,
): CrashReport | null {
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const report: CrashReport = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind,
      message: err.message?.slice(0, 2000) || 'Unknown error',
      stack: err.stack?.slice(0, 8000),
      ...baseFields(),
      context,
    };

    fs.writeFileSync(
      path.join(reportsDir(), `${report.id}.json`),
      JSON.stringify(report, null, 2),
      'utf-8',
    );
    pruneReports();

    console.error(`[Crash:${kind}]`, report.message);
    if (report.stack) console.error(report.stack);
    return report;
  } catch {
    return null;
  }
}

function pruneReports(): void {
  try {
    const files = fs.readdirSync(reportsDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => ({ f, t: fs.statSync(path.join(reportsDir(), f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const stale of files.slice(MAX_REPORTS)) {
      fs.rmSync(path.join(reportsDir(), stale.f), { force: true });
    }
  } catch { /* best effort */ }
}

export function listCrashReports(limit = 20): CrashReport[] {
  try {
    return fs.readdirSync(reportsDir())
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(reportsDir(), f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      .slice(0, limit)
      .map((p) => JSON.parse(fs.readFileSync(p, 'utf-8')) as CrashReport)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function clearCrashReports(): number {
  try {
    const files = fs.readdirSync(reportsDir()).filter((f) => f.endsWith('.json'));
    for (const f of files) fs.rmSync(path.join(reportsDir(), f), { force: true });
    return files.length;
  } catch {
    return 0;
  }
}

export function getCrashReportsDir(): string {
  return reportsDir();
}

/**
 * Install global handlers.
 *
 * Call once, as early as possible in main — an exception thrown during
 * startup is exactly the one that most needs recording, and it is also
 * the one most likely to be missed.
 */
export function installDiagnostics(getWindow: () => Electron.BrowserWindow | null): void {
  // Native crash minidumps stay local: no upload URL is configured, so
  // Crashpad writes to disk and nothing leaves the machine.
  try {
    crashReporter.start({
      productName: 'ORCH',
      companyName: 'redCRAFT',
      submitURL: '',
      uploadToServer: false,
      compress: true,
    });
  } catch (err) {
    console.warn('[Diagnostics] crashReporter unavailable:', err);
  }

  process.on('uncaughtException', (err) => {
    const report = recordCrash('main-exception', err);
    // An uncaught exception leaves the main process in an undefined
    // state. Tell the user rather than continuing to run something that
    // may now be corrupting their workspace file.
    try {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('orch-crash', report);
      }
      dialog.showErrorBox(
        'ORCH hit an unexpected error',
        `${err?.message ?? err}\n\nA report was saved to:\n${reportsDir()}\n\n` +
        'Your agents are still running. Restarting ORCH will reconnect the interface.',
      );
    } catch { /* dialog may be unavailable pre-ready */ }
  });

  process.on('unhandledRejection', (reason) => {
    // Recorded but not fatal: a rejected promise in a background sync is
    // routine and should not interrupt the user.
    recordCrash('main-rejection', reason);
  });

  app.on('child-process-gone', (_event, details) => {
    recordCrash('child-crash', new Error(`${details.type} process gone: ${details.reason}`), {
      type: details.type,
      reason: details.reason,
      exitCode: details.exitCode,
      serviceName: details.serviceName,
    });
  });

  app.on('render-process-gone', (_event, _contents, details) => {
    recordCrash('renderer-crash', new Error(`Renderer gone: ${details.reason}`), {
      reason: details.reason,
      exitCode: details.exitCode,
    });
    const win = getWindow();
    if (win && !win.isDestroyed() && details.reason !== 'clean-exit') {
      // The window is blank at this point; reloading is the only way back.
      win.reload();
    }
  });

  console.log(`[Diagnostics] Installed — reports at ${reportsDir()}`);
}
