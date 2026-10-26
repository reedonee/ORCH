import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { setupBridge } from './lib/orch-bridge';
import { ErrorBoundary } from './components/ErrorBoundary';
import { reportRendererError } from './lib/electron-api';

// Errors outside React's render path — event handlers, async callbacks,
// timers — never reach an ErrorBoundary. Without these two listeners they
// vanished into a console nobody was watching.
window.addEventListener('error', (e) => {
  reportRendererError(e.message, e.error?.stack, {
    source: e.filename, line: e.lineno, col: e.colno,
  }).catch(() => {});
});

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  reportRendererError(
    reason?.message ?? String(reason),
    reason?.stack,
    { kind: 'unhandledrejection' },
  ).catch(() => {});
});

// Initialise the ORCH bridge for MCP server access
setupBridge();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* ErrorBoundary existed in the codebase but was never mounted, so a
        throw anywhere in the tree unmounted the whole canvas and left a
        blank window with no indication of what happened — including any
        running agents' cards. */}
    <ErrorBoundary
      fallback={
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            height: '100%',
            padding: 32,
            fontFamily: "'JetBrains Mono', monospace",
            color: '#EAF4F4',
            background: '#0E1A14',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 700 }}>ORCH hit an unexpected error</div>
          <div style={{ fontSize: 12, opacity: 0.7, maxWidth: 420, lineHeight: 1.6 }}>
            Your agents are still running in the background. Reload the window to
            reconnect to them — open DevTools for the stack trace.
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 8,
              padding: '8px 18px',
              borderRadius: 6,
              border: '1px solid rgba(234,244,244,0.2)',
              background: 'rgba(234,244,244,0.08)',
              color: 'inherit',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 12,
            }}
          >
            Reload
          </button>
        </div>
      }
    >
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
