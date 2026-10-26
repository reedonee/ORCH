// ── ORCH Bug Reporter — Canvas Panel ───────────────────────────
// Lives on the canvas as a draggable panel (not a modal overlay).

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useFeedbackStore } from '../stores/useFeedbackStore';
import type { FeedbackStatus } from '../stores/useFeedbackStore';
import { useThemeStore } from '../stores/useThemeStore';
import { usePanelDrag } from '../hooks/usePanelDrag';
import { usePanelRegistry } from '../stores/usePanelRegistry';
import { computePanelZIndex } from '../lib/z-stack-manager';
import { GlassPanel } from './GlassPanel';
import { X, Camera, Bug, CheckCircle, Circle, List, Plus } from 'lucide-react';

const PANEL_ID = 'issue-tracker';
const W = 480;
const H = 460;

const STATUS_META: Record<FeedbackStatus, { label: string; dot: string }> = {
  pending:      { label: 'Pending',      dot: '#8E7C9A' },
  in_progress:  { label: 'In Progress',  dot: '#F4A261' },
  forge_queued: { label: 'Forge Queued', dot: '#4EA8DE' },
  resolved:     { label: 'Resolved',     dot: '#00E676' },
};

const B = {
  background: 'transparent', border: 'none', padding: 0,
  cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit', color: 'inherit',
} as const;

const BugReporter: React.FC = () => {
  const themeColors = useThemeStore((s) => s.theme.colors);
  const feedbacks = useFeedbackStore((s) => s.feedbacks);
  const syncStatus = useFeedbackStore((s) => s.syncStatus);
  const isOnline = useFeedbackStore((s) => s.isOnline);
  const addFeedback = useFeedbackStore((s) => s.addFeedback);
  const panelVisible = useFeedbackStore((s) => s.panelVisible);
  const setPanelVisible = useFeedbackStore((s) => s.setPanelVisible);

  const [tab, setTab] = useState<'submit' | 'browse'>('submit');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [screenshot, setScreenshot] = useState<string | undefined>();
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  const ref = useRef<HTMLDivElement>(null);
  // Narrow selectors instead of the whole registry: subscribing to the
  // entire store re-rendered this panel on every unrelated panel move.
  const activePanelId = usePanelRegistry((s) => s.activePanelId);
  const dragPanelId = usePanelRegistry((s) => s.dragPanelId);
  const resizePanelId = usePanelRegistry((s) => s.resizePanelId);
  const zStack = usePanelRegistry((s) => s.zStack);
  const registerPanel = usePanelRegistry((s) => s.registerPanel);
  const unregisterPanel = usePanelRegistry((s) => s.unregisterPanel);
  const updatePanel = usePanelRegistry((s) => s.updatePanel);
  const focusPanel = usePanelRegistry((s) => s.focusPanel);
  const { dragHandlers, positionStyle, transition, isDragging } = usePanelDrag({ panelId: PANEL_ID, snapToGrid: 32 });

  const z = computePanelZIndex(PANEL_ID, 'canvas', 10, false,
    activePanelId, dragPanelId, resizePanelId, zStack);

  useEffect(() => {
    registerPanel({
      id: PANEL_ID, type: 'feedback', space: 'canvas',
      x: window.innerWidth - W - 60, y: 70, width: W, height: H,
      minWidth: 360, minHeight: 320, defaultWidth: W, defaultHeight: H,
      participatesInAutoLayout: true, participatesInFraming: true, participatesInCollision: true,
      draggable: true, resizable: true, focusable: true, baseZIndex: 10,
    });
    return () => { unregisterPanel(PANEL_ID); };
  }, []);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) focusPanel(null);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  useEffect(() => { titleRef.current?.focus(); }, []);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) setPanelVisible(false); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [submitting, setPanelVisible]);

  const captureScreenshot = useCallback(() => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.fillStyle = '#0E1A14';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.font = '14px monospace';
        ctx.fillStyle = '#EAF4F4';
        ctx.fillText('Screenshot captured at ' + new Date().toLocaleTimeString(), 20, 40);
      }
      setScreenshot(canvas.toDataURL('image/png'));
    } catch { /* silent */ }
  }, []);

  const handleSubmit = async () => {
    if (!title.trim() || !desc.trim() || submitting) return;
    setSubmitting(true);
    try {
      await addFeedback({ title: title.trim(), description: desc.trim(), screenshotPath: screenshot });
      setSubmitted(true);
      setTimeout(() => { setSubmitted(false); setPanelVisible(false); setTitle(''); setDesc(''); setScreenshot(undefined); }, 1800);
    } catch {
      setSubmitting(false);
    }
  };

  if (!panelVisible) return null;

  if (submitted) {
    return (
      <div ref={ref} data-agent-card
        style={{ position: 'absolute', ...positionStyle, width: W, height: H, zIndex: z, transition }}>
        <GlassPanel style={{
          width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 'var(--radius-lg)', overflow: 'hidden',
          background: `linear-gradient(135deg, ${themeColors.bgAlt}E6 0%, ${themeColors.bg}F2 100%)`,
          border: '1px solid var(--border-dim)',
        }}>
          <div style={{ textAlign: 'center', padding: 40 }}>
            <CheckCircle size={40} style={{ color: 'var(--success)', marginBottom: 12 }} />
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 6 }}>Feedback Submitted</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {isOnline ? 'Shared publicly.' : 'Saved locally.'}
            </div>
          </div>
        </GlassPanel>
      </div>
    );
  }

  return (
    <div ref={ref} data-agent-card
      style={{ position: 'absolute', ...positionStyle, width: W, zIndex: z, transition }}>
      <GlassPanel style={{
        width: '100%', display: 'flex', flexDirection: 'column',
        borderRadius: 'var(--radius-lg)', overflow: 'hidden',
        background: `linear-gradient(135deg, ${themeColors.bgAlt}E6 0%, ${themeColors.bg}F2 100%)`,
        border: '1px solid var(--border-dim)',
        boxShadow: 'var(--shadow-xl)',
      }}>
        {/* ── Header ─────────────────────────────────── */}
        <div
          onMouseDown={(e: React.MouseEvent) => {
            dragHandlers.onMouseDown(e);
          }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '10px 14px', height: 40,
            background: 'var(--surface-alt)',
            borderBottom: '1px solid var(--border-dim)',
            flexShrink: 0, cursor: isDragging ? 'grabbing' : 'grab',
            userSelect: 'none',
          }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Bug size={14} style={{ color: 'var(--accent)' }} />
            <span style={{ fontSize: 13, fontWeight: 700, fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace", color: 'var(--text)' }}>
              Issue Tracker
            </span>
            {syncStatus === 'syncing' && <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>⟳</span>}
            {!isOnline && <span style={{ fontSize: 9, color: 'var(--warning)', padding: '1px 6px', borderRadius: 'var(--radius-pill)', background: 'color-mix(in srgb, var(--warning) 15%, transparent)' }}>offline</span>}
          </div>
          <button className="glass-btn no-drag" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setPanelVisible(false); }}
            style={{ width: 24, height: 24, padding: 0, fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', color: 'var(--text-secondary)' }}>
            <X size={12} />
          </button>
        </div>

        {/* ── Tab Bar ─────────────────────────────────── */}
        <div style={{ display: 'flex', padding: '0 12px', borderBottom: '1px solid var(--border-dim)', flexShrink: 0 }}>
          {[
            { id: 'submit', label: 'Submit', icon: <Plus size={12} /> },
            { id: 'browse', label: `Issues (${feedbacks.length})`, icon: <List size={12} /> },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id as any)}
              style={{
                display: 'flex', alignItems: 'center', gap: 5, ...B,
                padding: '7px 12px', fontSize: 11, fontWeight: 600,
                borderBottom: tab === t.id ? '2px solid var(--accent)' : '2px solid transparent',
                color: tab === t.id ? 'var(--accent)' : 'var(--text)',
                background: 'none', borderTop: 'none', borderLeft: 'none', borderRight: 'none',
                cursor: 'pointer', fontFamily: 'inherit', marginBottom: -1,
              }}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Submit Tab ─────────────────────────────── */}
        {tab === 'submit' && (
          <div style={{ padding: '12px 14px', flex: 1, overflowY: 'auto' }}>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.8, textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>
                Title *
              </label>
              <input
                ref={titleRef}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Brief description"
                style={{
                  width: '100%', padding: '7px 10px', borderRadius: 'var(--radius-sm)',
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  color: 'var(--text)', fontSize: 12, fontFamily: 'inherit', outline: 'none',
                }}
              />
            </div>
            <div style={{ marginBottom: 10 }}>
              <label style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: 0.8, textTransform: 'uppercase', display: 'block', marginBottom: 4 }}>
                Description *
              </label>
              <textarea
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="What happened?"
                rows={3}
                style={{
                  width: '100%', padding: '7px 10px', borderRadius: 'var(--radius-sm)',
                  background: 'var(--surface)', border: '1px solid var(--border)',
                  color: 'var(--text)', fontSize: 12, fontFamily: 'inherit', outline: 'none',
                  resize: 'vertical', minHeight: 60,
                }}
              />
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
              <button
                onClick={captureScreenshot}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '4px 10px', borderRadius: 'var(--radius-sm)',
                  background: screenshot ? 'color-mix(in srgb, var(--success) 15%, transparent)' : 'var(--surface)',
                  border: `1px solid ${screenshot ? 'var(--success)' : 'var(--border-dim)'}`,
                  color: screenshot ? 'var(--success)' : 'var(--text-secondary)',
                  cursor: 'pointer', fontSize: 11, fontFamily: 'inherit', fontWeight: 600,
                }}
              >
                <Camera size={12} />
                {screenshot ? '✓ Attached' : 'Add Screenshot'}
              </button>
            </div>
          </div>
        )}

        {/* ── Browse Tab ──────────────────────────────── */}
        {tab === 'browse' && (
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 200 }}>
            {feedbacks.length === 0 && (
              <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
                <Bug size={24} style={{ opacity: 0.3, marginBottom: 8 }} />
                <div>No issues reported yet.</div>
              </div>
            )}
            {feedbacks.map((f) => {
              const meta = STATUS_META[f.status];
              return (
                <div key={f.id} style={{ padding: '8px 14px', borderBottom: '1px solid var(--border-dim)' }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 2 }}>{f.title}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4, overflow: 'hidden', textOverflow: 'ellipsis', maxHeight: 32 }}>
                        {f.description}
                      </div>
                    </div>
                    <span style={{
                      whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 3,
                      padding: '1px 6px', borderRadius: 'var(--radius-pill)',
                      fontSize: 8, fontWeight: 700,
                      background: `${meta.dot}18`, color: meta.dot,
                      border: `1px solid ${meta.dot}30`,
                    }}>
                      <Circle size={4} fill={meta.dot} style={{ stroke: 'none' }} />
                      {meta.label}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2, fontSize: 8, color: 'var(--text-muted)' }}>
                    <span>{new Date(f.submittedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                    {f.screenshotPath && <span style={{ display: 'flex', alignItems: 'center', gap: 2 }}><Camera size={8} /> screenshot</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── Footer (submit tab only) ───────────────── */}
        {tab === 'submit' && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6,
            padding: '10px 14px', borderTop: '1px solid var(--border-dim)',
            flexShrink: 0,
          }}>
            <button
              onClick={() => setPanelVisible(false)}
              style={{
                ...B, padding: '6px 12px', borderRadius: 'var(--radius-pill)',
                background: 'transparent', border: '1px solid var(--border-dim)',
                color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 11,
                fontFamily: 'inherit', fontWeight: 600,
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!title.trim() || !desc.trim() || submitting}
              style={{
                ...B, padding: '6px 14px', borderRadius: 'var(--radius-pill)',
                background: title.trim() && desc.trim() && !submitting ? 'var(--accent)' : 'var(--border-dim)',
                border: 'none',
                color: title.trim() && desc.trim() && !submitting ? 'var(--bg)' : 'var(--text-muted)',
                cursor: title.trim() && desc.trim() && !submitting ? 'pointer' : 'not-allowed',
                fontSize: 11, fontFamily: 'inherit', fontWeight: 700,
                display: 'flex', alignItems: 'center', gap: 5,
              }}
            >
              {submitting ? 'Submitting…' : 'Submit'}
            </button>
          </div>
        )}
      </GlassPanel>
    </div>
  );
};

export default BugReporter;
