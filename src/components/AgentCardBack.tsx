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
  report, agentName, providerId, color, conflicts = [], unread = 0,
}) => {
  // Elapsed time is derived in an effect, not during render: reading
  // the clock while rendering is impure (two renders disagree) and the
  // value would freeze until something else re-rendered the card.
  const [elapsed, setElapsed] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!report || report.phase === 'idle') { setElapsed(null); return; }
    const tick = () => setElapsed(Date.now() - report.startedAt);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [report?.startedAt, report?.phase, report]);

  const phase = report?.phase ?? 'idle';
  const meta = PHASE_META[phase];
  const { Icon } = meta;

  return (
    <div
      style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column',
        padding: '14px 16px', gap: 12,
        overflow: 'hidden',
        // The back is deliberately opaque relative to the front: it is a
        // reading surface, not a window onto a terminal.
        background: 'linear-gradient(150deg, rgba(18,32,24,0.94) 0%, rgba(10,18,14,0.97) 100%)',
        borderRadius: 'inherit',
      }}
      role="region"
      aria-label={`${agentName} status summary`}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0,
          boxShadow: `0 0 8px ${color}`,
        }} />
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', letterSpacing: 0.2 }}>
          {agentName.split(' - ')[0]}
        </span>
        {providerId && (
          <span style={{
            fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.8,
            color: 'var(--text-muted)', padding: '1px 6px',
            border: '1px solid var(--border-dim)', borderRadius: 999,
          }}>
            {providerId}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {unread > 0 && (
          <span
            title={`${unread} unread message${unread === 1 ? '' : 's'}`}
            style={{
              display: 'flex', alignItems: 'center', gap: 3,
              fontSize: 10, color: '#F4A261',
            }}
          >
            <Mail size={11} />{unread}
          </span>
        )}
      </div>

      {/* Phase */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Icon
          size={14}
          style={{
            color: meta.color,
            animation: meta.spin ? 'orch-spin 1.4s linear infinite' : undefined,
          }}
        />
        <span style={{ fontSize: 12, fontWeight: 600, color: meta.color }}>{meta.label}</span>
        {report && report.phase !== 'idle' && elapsed !== null && (
          <span style={{
            display: 'flex', alignItems: 'center', gap: 3,
            fontSize: 10, color: 'var(--text-muted)',
          }}>
            <Clock size={10} />
            {humanDuration(elapsed)}
          </span>
        )}
      </div>

      {/* Task */}
      <div style={{
        fontSize: 13, lineHeight: 1.5, color: 'var(--text)',
        // Clamp rather than scroll: this is a glance surface, and a card
        // that needs scrolling has already failed at being one.
        display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}>
        {report?.task || (
          <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>
            Hasn&apos;t reported what it&apos;s doing yet
          </span>
        )}
      </div>

      {/* Progress */}
      {report?.progress !== undefined && (
        <div>
          <div style={{
            height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.1)', overflow: 'hidden',
          }}>
            <div style={{
              width: `${report.progress}%`, height: '100%', background: meta.color,
              transition: 'width 0.4s ease',
            }} />
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>
            {report.progress}%
          </div>
        </div>
      )}

      {/* Conflicts — the single most actionable thing on this card */}
      {conflicts.length > 0 && (
        <div style={{
          display: 'flex', gap: 7, padding: '7px 9px', borderRadius: 6,
          background: 'rgba(231,111,81,0.14)', border: '1px solid rgba(231,111,81,0.4)',
        }}>
          <FileWarning size={13} style={{ color: '#E76F51', flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 10.5, lineHeight: 1.45, color: '#E76F51', minWidth: 0 }}>
            <div style={{ fontWeight: 700 }}>Shared file{conflicts.length > 1 ? 's' : ''}</div>
            <div style={{ opacity: 0.85, wordBreak: 'break-all' }}>
              {conflicts.slice(0, 2).map((f) => f.split('/').pop()).join(', ')}
              {conflicts.length > 2 && ` +${conflicts.length - 2}`}
            </div>
          </div>
        </div>
      )}

      <span style={{ flex: 1 }} />

      {/* Files */}
      {report?.files && report.files.length > 0 && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.6 }}>
          <div style={{ textTransform: 'uppercase', letterSpacing: 0.8, opacity: 0.6, marginBottom: 2 }}>
            Touching
          </div>
          <div style={{
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            overflow: 'hidden', wordBreak: 'break-all',
          }}>
            {report.files.slice(0, 4).map((f) => f.split(/[\\/]/).pop()).join(' · ')}
            {report.files.length > 4 && ` +${report.files.length - 4}`}
          </div>
        </div>
      )}
    </div>
  );
};
