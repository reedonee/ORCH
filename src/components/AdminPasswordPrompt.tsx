// ── Admin Panel Unlock ────────────────────────────────────────
// Reveals admin-only UI (the ForgeNode Inbox tab, etc.).
//
// THIS IS NOT A SECURITY BOUNDARY, and must not be treated as one.
// Everything here runs in the renderer, so anyone can bypass it by
// editing the bundle or calling the store setter from devtools. It exists
// only to keep admin UI out of the way during normal use.
//
// The real authorization lives in Postgres: supabase/migrations/
// 003_feedbacks_rls.sql restricts feedback rows to their author plus
// members of admin_users, enforced by RLS. Unlocking this panel without
// a matching admin row shows an empty inbox, because the server refuses
// to return anyone else's rows.
//
// The passphrase previously sat here as a string literal
// (`const ADMIN_PASSWORD = '...'`), shipped inside every binary and
// committed to the repo. It now comes from a build-time env var, so at
// least it is not published — but the point above still stands.

import React, { useState, useRef, useEffect } from 'react';
import { Z_BASE_LAYERS } from '../lib/z-stack-manager';
import { Lock, X } from 'lucide-react';

/** Set VITE_ADMIN_PASSPHRASE at build time. Empty disables the prompt. */
const ADMIN_PASSWORD = import.meta.env.VITE_ADMIN_PASSPHRASE ?? '';

interface AdminPasswordPromptProps {
  onSuccess: () => void;
  onClose: () => void;
}

const AdminPasswordPrompt: React.FC<AdminPasswordPromptProps> = ({ onSuccess, onClose }) => {
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const [locked, setLocked] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const handleSubmit = () => {
    // An unset passphrase must never unlock — otherwise a build that
    // forgot the env var would grant admin UI to an empty input.
    if (ADMIN_PASSWORD.length > 0 && value === ADMIN_PASSWORD) {
      setLocked(true);
      setTimeout(onSuccess, 300);
    } else {
      setError(true);
      setValue('');
      setTimeout(() => setError(false), 1200);
      inputRef.current?.focus();
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: Z_BASE_LAYERS.modal,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.5)',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          padding: '28px 32px', borderRadius: 'var(--radius-lg)',
          background: 'var(--bg)', border: '1px solid var(--border)',
          boxShadow: 'var(--shadow-xl)', width: 340,
          display: 'flex', flexDirection: 'column', gap: 16,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Lock size={16} style={{ color: 'var(--accent)' }} />
            <span style={{ fontSize: 14, fontWeight: 700 }}>Admin Passkey</span>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4, display: 'flex' }}>
            <X size={14} />
          </button>
        </div>

        <input
          ref={inputRef}
          type="password"
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(false); }}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
          placeholder="Enter admin password"
          style={{
            width: '100%', padding: '9px 12px', borderRadius: 'var(--radius-sm)',
            background: 'var(--surface)', border: `1px solid ${error ? 'var(--error)' : 'var(--border)'}`,
            color: 'var(--text)', fontSize: 13, fontFamily: 'inherit', outline: 'none',
            transition: 'border-color 0.2s',
          }}
        />

        {error && (
          <div style={{ fontSize: 11, color: 'var(--error)', fontWeight: 600 }}>
            Incorrect password
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onClose}
            style={{
              padding: '7px 14px', borderRadius: 'var(--radius-pill)',
              background: 'transparent', border: '1px solid var(--border-dim)',
              color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 12,
              fontFamily: 'inherit', fontWeight: 600,
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={locked}
            style={{
              padding: '7px 16px', borderRadius: 'var(--radius-pill)',
              background: locked ? 'var(--success)' : 'var(--accent)',
              border: 'none',
              color: locked ? 'var(--bg)' : 'var(--bg)',
              cursor: locked ? 'default' : 'pointer', fontSize: 12,
              fontFamily: 'inherit', fontWeight: 700,
              display: 'flex', alignItems: 'center', gap: 5,
              opacity: locked ? 0.7 : 1,
            }}
          >
            {locked ? '✓ Unlocked' : 'Unlock'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AdminPasswordPrompt;
