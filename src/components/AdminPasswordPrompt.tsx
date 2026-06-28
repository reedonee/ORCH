// ── Admin Password Prompt ─────────────────────────────────────
// Modal dialog that asks for the admin passkey before unlocking
// the admin features (ForgeNode Inbox tab, etc.).

import React, { useState, useRef, useEffect } from 'react';
import { Z_BASE_LAYERS } from '../lib/z-stack-manager';
import { Lock, X } from 'lucide-react';

const ADMIN_PASSWORD = 'orch@99*';

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
    if (value === ADMIN_PASSWORD) {
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
