// Resolve extensionless relative imports to their TypeScript source.
//
// The app is bundled by Vite, which resolves `../lib/canvas-geometry`
// to `.ts` for you. Node's ESM loader will not, so a store that imports
// a sibling module cannot be loaded by a test without this — which is
// why the store logic had no direct coverage.
//
// Registered by ts-resolve-hook.mjs; used with --experimental-strip-types.

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js'];

export async function resolve(specifier, context, next) {
  // Main-process modules import 'electron', which only exists inside
  // Electron. Tests get a stand-in with just what they touch.
  if (specifier === 'electron') {
    return next(new URL('./electron-stub.mjs', import.meta.url).href, context);
  }
  // electron/ sources import siblings as "./x.js" (what the bundle emits);
  // under node only the .ts exists.
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
    const candidate = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier.replace(/\.js$/, '.ts'));
    if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context);
  }
  if (specifier.startsWith('.') && !path.extname(specifier) && context.parentURL) {
    const dir = path.dirname(fileURLToPath(context.parentURL));
    for (const ext of EXTENSIONS) {
      const candidate = path.resolve(dir, specifier + ext);
      if (existsSync(candidate)) {
        return next(pathToFileURL(candidate).href, context);
      }
    }
    // Directory import — try its index file.
    for (const ext of EXTENSIONS) {
      const candidate = path.resolve(dir, specifier, `index${ext}`);
      if (existsSync(candidate)) {
        return next(pathToFileURL(candidate).href, context);
      }
    }
  }
  return next(specifier, context);
}
