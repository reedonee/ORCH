import React, { useEffect, useCallback } from 'react';
import { invoke, listen } from '../lib/electron-api';
import { useVoiceStore, type VoiceStatus } from '../stores/useVoiceStore';

// Thin mic SVG — matches the PlusIcon style
const MicIcon: React.FC<{ size?: number }> = ({ size = 15 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
    <rect x="9" y="2" width="6" height="11" rx="3" />
    <path d="M5 12a7 7 0 0 0 14 0" />
    <line x1="12" y1="19" x2="12" y2="22" />
  </svg>
);

const STATUS_STYLES: Record<VoiceStatus, { color: string; label: string; pulse: boolean }> = {
  idle:        { color: 'var(--text)', label: '', pulse: false },
  listening:   { color: '#4ade80', label: 'Listening…', pulse: true },
  transcribing:{ color: '#facc15', label: 'Transcribing…', pulse: true },
  processing:  { color: '#60a5fa', label: 'Processing…', pulse: true },
  speaking:    { color: '#c084fc', label: 'Speaking…', pulse: true },
};

export const VoiceButton: React.FC = () => {
  const { status, heard, setStatus, setHeard } = useVoiceStore();

  // Listen for Rust backend voice events
  useEffect(() => {
    const unlistenStatus = listen<string>('voice-status', (payload) => {
      const raw = (payload ?? '').toLowerCase();
      if (raw.includes('listen')) setStatus('listening');
      else if (raw.includes('transcrib')) setStatus('transcribing');
      else if (raw.includes('process') || raw.includes('speak')) setStatus('processing');
      else if (raw.includes('idle')) setStatus('idle');
    });

    const unlistenHeard = listen<string>('voice-heard', (payload) => {
      setHeard(payload);
      setTimeout(() => setHeard(null), 6000);
    });

    return () => {
      unlistenStatus.then((fn) => fn());
      unlistenHeard.then((fn) => fn());
    };
  }, [setStatus, setHeard]);

  const toggleVoice = useCallback(() => {
    invoke<string>('toggle_voice').catch((e) => console.error('Voice toggle:', e));
  }, []);

  const s = STATUS_STYLES[status];

  return (
    <>
      {/* Mic button */}
      <button
        className="glass-btn"
        onClick={toggleVoice}
        title={status === 'idle' ? 'Voice command (Ctrl+Shift+Space)' : s.label}
        style={{
          width: 32, height: 32, padding: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: status === 'idle' ? 'var(--text)' : s.color,
          borderRadius: '50%',
          position: 'relative',
          transition: 'all var(--anim-fast)',
          ...(status !== 'idle' ? {
            boxShadow: `0 0 10px ${s.color}60`,
            background: `${s.color}15`,
          } : {}),
        }}
      >
        <MicIcon size={15} />
        {s.pulse && (
          <span style={{
            position: 'absolute', inset: -2, borderRadius: '50%',
            border: `2px solid ${s.color}`,
            opacity: 0.4, animation: 'pulse-ring 1.5s ease infinite',
            pointerEvents: 'none',
          }} />
        )}
      </button>

      {/* Heard transcript toast */}
      {heard && (
        <div
          className="glass animate-fade-in"
          style={{
            position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
            zIndex: 5000,
            padding: '8px 18px', borderRadius: 'var(--radius-pill)',
            fontSize: 13, fontWeight: 500,
            color: 'var(--text)',
            background: 'rgba(30, 58, 58, 0.80)',
            border: '1px solid rgba(234, 244, 244, 0.1)',
            whiteSpace: 'nowrap', maxWidth: '60vw', overflow: 'hidden', textOverflow: 'ellipsis',
            pointerEvents: 'none',
          }}
        >
          🎤 {heard}
        </div>
      )}
    </>
  );
};
