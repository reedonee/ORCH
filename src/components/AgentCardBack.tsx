// ── Agent Card — back side ──────────────────────────────────────
// What every agent is working on, at a glance.
//
// With several agents running, the terminals themselves are the worst
// possible status display: each shows a wall of scrolling output, and
// working out "is Sky finished?" means reading four of them. Pressing the
// flip key turns every card around at once and answers that in a second.
//
// The content is the agent's own SELF-REPORT (agent_set_status), not a
// scrape of its output. An agent that says "waiting on Max's migration"
// is telling you something no amount of terminal parsing could infer.

import React from 'react';
import type { AgentReport } from '../stores/useAppStore';
import {
  Loader2, CheckCircle2, XCircle, PauseCircle, Circle,
  FileWarning, Mail, Clock,
} from 'lucide-react';

interface Props {
  report: AgentReport | undefined;
  agentName: string;
  providerId?: string;
  color: string;
  /** Files this agent shares with another — surfaced prominently. */
  conflicts?: string[];
  unread?: number;
  /** Showing (or turning). The back stays mounted while hidden so a flip
   *  never starts by building it; while hidden its clock is paused. */
  active?: boolean;
}

const PHASE_META: Record<AgentReport['phase'], {
  label: string;
  color: string;
  Icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  spin?: boolean;
}> = {
  working: { label: 'Working',  color: '#F4A261', Icon: Loader2, spin: true },
  done:    { label: 'Done',     color: '#6BBF8A', Icon: CheckCircle2 },
  failed:  { label: 'Failed',   color: '#E76F51', Icon: XCircle },
  blocked: { label: 'Blocked',  color: '#C89EC4', Icon: PauseCircle },
  idle:    { label: 'Idle',     color: '#7A8A8A', Icon: Circle },
};

/** "4m", "1h 12m" — compact enough for a card corner. */
function humanDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export const AgentCardBack: React.FC<Props> = ({
  report, agentName, providerId, color, conflicts = [], unread = 0, active = true,
}) => {
  // Elapsed time is derived in an effect, not during render: reading
  // the clock while rendering is impure (two renders disagree) and the
  // value would freeze until something else re-rendered the card.
  const [elapsed, setElapsed] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!report || report.phase === 'idle') { setElapsed(null); return; }
    const tick = () => setElapsed(Date.now() - report.startedAt);
    tick();
    if (!active) return;
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [report?.startedAt, report?.phase, report, active]);

  const phase = report?.phase ?? 'idle';
  const meta = PHASE_META[phase];
  const { Icon } = meta;
  const task = report?.task && report.task !== 'Waiting for work' ? report.task : '';

  return (
    <div
      style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        padding: '14px 18px', gap: 10,
        overflow: 'hidden',
        // Sizes below scale with the card's own width (cqw), so the status
        // stays big on a large card and still fits a small one.
        containerType: 'inline-size',
        // A reading surface, not a window onto a terminal: near-opaque,
        // lit from the centre in the colour of the agent's phase.
        background: [
          `radial-gradient(ellipse 70% 60% at 50% 48%, ${meta.color}2E 0%, transparent 70%)`,
          `linear-gradient(160deg, ${color}1F 0%, transparent 45%)`,
          'linear-gradient(150deg, rgba(20,24,30,0.95) 0%, rgba(10,12,16,0.97) 100%)',
        ].join(', '),
        borderRadius: 'inherit',
      }}
      role="region"
      aria-label={`${agentName} status summary`}
    >
      {/* Sheen that sweeps across once the card has landed face-down.
          Rendered per flip so it replays each time, with its layer created
          up front (will-change): starting it mid-turn created that layer
          on the edge-on frame and dropped frames there. */}
      {active && (
        <div aria-hidden="true" style={{
          position: 'absolute', top: '-20%', bottom: '-20%', left: 0, width: '45%', pointerEvents: 'none',
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.14), transparent)',
          willChange: 'transform, opacity',
          animation: 'orch-flip-sheen 1100ms cubic-bezier(0.4, 0, 0.2, 1) 820ms both',
        }} />
      )}

      {/* Header: who, and for how long */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
        <span style={{
          width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0,
          boxShadow: `0 0 10px ${color}`,
        }} />
        <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', letterSpacing: 0.2 }}>
          {agentName.split(' - ')[0]}
        </span>
        {providerId && (
          <span style={{
            fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.8,
            color: 'var(--text-muted)', padding: '1px 7px',
            border: '1px solid var(--border-dim)', borderRadius: 999,
          }}>
            {providerId}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {unread > 0 && (
          <span
            title={`${unread} unread message${unread === 1 ? '' : 's'}`}
            style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: '#F4A261' }}
          >
            <Mail size={12} />{unread}
          </span>
        )}
        {report && report.phase !== 'idle' && elapsed !== null && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)' }}>
            <Clock size={11} />
            {humanDuration(elapsed)}
          </span>
        )}
      </div>

      {/* The status itself — big, centred, the one thing to read. */}
      <div style={{
        flex: 1, minHeight: 0, position: 'relative',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        textAlign: 'center', gap: '1.4cqw',
      }}>
        <div style={{
          width: 'clamp(44px, 9cqw, 72px)', height: 'clamp(44px, 9cqw, 72px)', borderRadius: '50%',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: `${meta.color}1F`, border: `1.5px solid ${meta.color}66`,
          boxShadow: `0 0 28px ${meta.color}55`,
        }}>
          <Icon
            size={30}
            style={{
              color: meta.color, width: '55%', height: '55%',
              animation: meta.spin ? 'orch-spin 1.4s linear infinite' : undefined,
            }}
          />
        </div>
        <div style={{
          fontSize: 'clamp(12px, 2.1cqw, 16px)', fontWeight: 800, color: meta.color,
          textTransform: 'uppercase', letterSpacing: '0.16em',
        }}>
          {meta.label}
        </div>
        <div
          key={task || 'none'}
          style={{
            fontSize: 'clamp(17px, 4.6cqw, 34px)', fontWeight: 650, lineHeight: 1.25,
            color: task ? 'var(--text)' : 'var(--text-muted)', fontStyle: task ? 'normal' : 'italic',
            maxWidth: '88%',
            // Clamp rather than scroll: this is a glance surface.
            display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            textWrap: 'balance',
            animation: 'orch-status-in 320ms ease-out both',
          }}
        >
          {task || 'Hasn’t reported what it’s doing yet'}
        </div>
        {report?.progress !== undefined && (
          <div style={{ width: '56%', marginTop: '0.8cqw' }}>
            <div style={{ height: 6, borderRadius: 3, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
              <div style={{
                width: `${report.progress}%`, height: '100%', background: meta.color,
                boxShadow: `0 0 10px ${meta.color}`, transition: 'width 0.4s ease',
              }} />
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginTop: 5 }}>
              {report.progress}%
            </div>
          </div>
        )}
      </div>

      {/* Conflicts — the single most actionable thing on this card */}
      {conflicts.length > 0 && (
        <div style={{
          display: 'flex', gap: 7, padding: '7px 9px', borderRadius: 6, position: 'relative',
          background: 'rgba(231,111,81,0.14)', border: '1px solid rgba(231,111,81,0.4)',
        }}>
          <FileWarning size={13} style={{ color: '#E76F51', flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 11, lineHeight: 1.45, color: '#E76F51', minWidth: 0 }}>
            <span style={{ fontWeight: 700 }}>Shared file{conflicts.length > 1 ? 's' : ''}: </span>
            <span style={{ opacity: 0.85, wordBreak: 'break-all' }}>
              {conflicts.slice(0, 2).map((f) => f.split('/').pop()).join(', ')}
              {conflicts.length > 2 && ` +${conflicts.length - 2}`}
            </span>
          </div>
        </div>
      )}

      {/* Files */}
      {report?.files && report.files.length > 0 && (
        <div style={{
          fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.5, textAlign: 'center', position: 'relative',
          display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden', wordBreak: 'break-all',
        }}>
          <span style={{ textTransform: 'uppercase', letterSpacing: 0.8, opacity: 0.6 }}>Touching </span>
          {report.files.slice(0, 4).map((f) => f.split(/[\\/]/).pop()).join(' · ')}
          {report.files.length > 4 && ` +${report.files.length - 4}`}
        </div>
      )}
    </div>
  );
};
