// Stand-in for the 'electron' module, so main-process code can be loaded
// by node-based checks. Only what those modules touch at import time or in
// the paths the checks drive. Data goes to a throwaway temp directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-check-'));

export const app = {
  getPath: () => dir,
  getVersion: () => '0.0.0-check',
  isPackaged: false,
  on: () => {},
};

export default { app };
