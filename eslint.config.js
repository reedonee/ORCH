import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// ── Lint policy ─────────────────────────────────────────────────
//
// CI fails on ERRORS only. The split below is deliberate:
//
//   error — rules that catch real defects (hook misuse, unreachable
//           branches, accidental globals). These block a merge.
//   warn  — pre-existing stylistic debt. The ceiling in package.json
//           (--max-warnings) is the ratchet: lower it whenever the real
//           count drops, never raise it. Demoting them is not an endorsement;
//           it is so CI can be switched on TODAY and catch new breakage,
//           instead of being blocked behind a 260-item cleanup and
//           therefore never switched on at all.
//
// Reduce the warn list over time; do not add to it.

export default defineConfig([
  globalIgnores([
    'dist',
    'dist-electron',
    'release',
    'node_modules',
    '.venv-voice',
    'electron/voice-models',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      // ── Tracked debt (warn) ──
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // `try { … } catch {}` is a deliberate idiom throughout the main
      // process for operations that are allowed to fail (killing an
      // already-dead PTY, removing a temp dir).
      'no-empty': ['warn', { allowEmptyCatch: true }],
      '@typescript-eslint/no-require-imports': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/static-components': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/immutability': 'warn',
      'react-refresh/only-export-components': 'warn',
      'no-useless-assignment': 'warn',
      'prefer-const': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',

      // ── Genuine correctness (error) ──
      'react-hooks/rules-of-hooks': 'error',
      'no-fallthrough': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      // no-undef is off for TypeScript on purpose: tsc already proves
      // every identifier resolves, and ESLint cannot see ambient types
      // (the `Electron` namespace, DOM lib types, vite `define` globals),
      // so it reports them all as undefined. Keeping it on would mean 26
      // permanent false positives drowning out real errors.
      'no-undef': 'off',
    },
  },
  {
    // ANSI parsing legitimately needs control characters in regexes.
    files: ['electron/session-log.ts', 'electron/main.ts', 'electron/agent-approvals.ts'],
    rules: { 'no-control-regex': 'off' },
  },
])
