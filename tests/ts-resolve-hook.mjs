// Registers the TS extension resolver for the current process.
// Used as: node --experimental-strip-types --import ./tests/ts-resolve-hook.mjs <test>
import { register } from 'node:module';

register('./ts-extension-resolver.mjs', import.meta.url);
