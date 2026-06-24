import React, { useState, useRef, useEffect } from 'react';
import { GlassPanel } from './GlassPanel';
import { VoiceButton } from './VoiceButton';

interface Message {
  id: string;
  role: 'user' | 'coordinator' | 'agent';
  content: string;
  timestamp: Date;
}

export const CoordinatorBar: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' }); }, [messages]);

  const send = () => {
    if (!input.trim()) return;
    const m: Message = { id: crypto.randomUUID(), role: 'user', content: input, timestamp: new Date() };
    setMessages(prev => [...prev, m]);
    setInput('');
    setTimeout(() => {
      setMessages(prev => [...prev, { id: crypto.randomUUID(), role: 'coordinator', content: 'Routing through ORCH…', timestamp: new Date() }]);
    }, 350);
  };

  return (
    <div style={{ position: 'fixed', left: '50%', bottom: 20, transform: 'translateX(-50%)', width: 'min(307px, calc(33vw - 16px))', zIndex: 999 }}>
      <GlassPanel style={{
        padding: '6px 12px', borderRadius: 'var(--radius-xl)',
        boxShadow: 'var(--shadow-xl)', display: 'flex', flexDirection: 'column', gap: 4,
        background: 'rgba(30, 58, 58, 0.65)',
        border: '1px solid rgba(234, 244, 244, 0.06)',
      }}>
        {messages.length > 0 && (
          <div ref={listRef} style={{
            maxHeight: 140, overflowY: 'auto', padding: '4px 2px 6px',
            display: 'flex', flexDirection: 'column', gap: 6,
          }}>
            {messages.map(m => (
              <div key={m.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                {m.role === 'user' ? (
                  <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 11, minWidth: 24 }}>You</span>
                ) : (
                  <span style={{ color: 'var(--info)', fontWeight: 700, fontSize: 11, minWidth: 24 }}>ORCH</span>
                )}
                <span style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-secondary)' }}>{m.content}</span>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input ref={inputRef} id="orch-cmd" name="orch-cmd" type="text" className="glass-input"
            value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); send(); } }}
            placeholder="Ask ORCH to do something…"
            style={{ flex: 1, height: 40, borderRadius: '999px', fontSize: 13, paddingLeft: 16, background: 'rgba(255,255,255,0.03)' }} />
          <VoiceButton />
        </div>
      </GlassPanel>
    </div>
  );
};
