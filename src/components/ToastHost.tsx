// ── Toast Host ──────────────────────────────────────────────────
// Transient notices from agents and app actions.
//
// Agent-to-agent traffic used to be invisible: a handoff between two
// agents appeared only inside their terminals, so unless you happened to
// be reading the right card at the right moment, you never saw it. These
// surface the fact that something happened without demanding attention.

import React from 'react';
import { useAppStore } from '../stores/useAppStore';
import { Z_BASE_LAYERS } from '../lib/z-stack-manager';
import { Info, CheckCircle2, AlertTriangle, XCircle, X } from 'lucide-react';

const TONE: Record<string, { color: string; Icon: React.ComponentType<{ size?: number }> }> = {
  info:    { color: '#6B9AC4', Icon: Info },
  success: { color: '#6BBF8A', Icon: CheckCircle2 },
  warn:    { color: '#F4A261', Icon: AlertTriangle },
  error:   { color: '#E76F51', Icon: XCircle },
};

export const ToastHost: React.FC = () => {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div
      // aria-live so a screen reader announces agent activity without the
      // user having to poll the canvas.
      role="log"
      aria-live="polite"
      aria-label="Agent activity"
      style={{
        position: 'fixed', top: 70, right: 16, zIndex: Z_BASE_LAYERS.modal,
        display: 'flex', flexDirection: 'column', gap: 8,
        maxWidth: 380, pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => {
        const tone = TONE[t.tone] ?? TONE.info;
        const { Icon } = tone;
        return (
          <div
            key={t.id}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 9,
              padding: '9px 11px', borderRadius: 'var(--radius-md)',
              background: 'var(--menu-bg, rgba(14,26,20,0.94))',
              border: `1px solid ${tone.color}55`,
              borderLeft: `3px solid ${tone.color}`,
              boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
              backdropFilter: 'blur(18px)',
              color: 'var(--text)', fontSize: 12, lineHeight: 1.45,
              pointerEvents: 'auto',
              animation: 'orch-toast-in 220ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            <span style={{ color: tone.color, flexShrink: 0, marginTop: 1 }}>
              <Icon size={13} />
            </span>
            <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-word' }}>{t.text}</span>
            <button
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              style={{
                background: 'none', border: 'none', color: 'var(--text-muted)',
                cursor: 'pointer', padding: 0, display: 'flex', flexShrink: 0,
              }}
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
};
