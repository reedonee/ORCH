// Cross-platform runner for the Python sidecar checks.
//
// A bare `.venv-voice/Scripts/python.exe` in an npm script fails on
// Windows (cmd.exe rejects the forward slashes on a relative path) and is
// wrong on POSIX (bin/, no .exe). Resolve the interpreter the same way
// electron/voice-server.ts does, so the tests and the app agree on which
// Python they mean.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isWin = process.platform === 'win32';
const binDir = isWin ? 'Scripts' : 'bin';
const exe = isWin ? 'python.exe' : 'python';

function resolvePython() {
  if (process.env.ORCH_PYTHON && existsSync(process.env.ORCH_PYTHON)) {
    return process.env.ORCH_PYTHON;
  }
  for (const venv of ['.venv-voice', '.venv']) {
    const candidate = path.join(root, venv, binDir, exe);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const python = resolvePython();
if (!python) {
  console.log(
    'SKIP: no voice virtualenv found.\n' +
    '  Create one with:\n' +
    '    uv venv --python 3.11 .venv-voice\n' +
    '    uv pip install -r electron/requirements-voice.txt',
  );
  // A missing optional toolchain is not a test failure.
  process.exit(0);
}

const script = process.argv[2] ?? path.join(root, 'tests', 'voice_server_check.py');
const result = spawnSync(python, [script], { stdio: 'inherit', cwd: root });
process.exit(result.status ?? 1);
