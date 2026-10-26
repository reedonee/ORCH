import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useThemeStore } from '../stores/useThemeStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { Z_BASE_LAYERS } from '../lib/z-stack-manager';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { executeAppCommand, type AppCommand } from '../lib/agent-commands';
import { listen } from '../lib/electron-api';
import {
  analyzeInput, pushHistory, loadHistory,
  type Completion, type InputAnalysis,
} from '../lib/command-bar';

// ── Brand constants ────────────────────────────────────────────
// These are populated at render time from the active theme.
// Defaults used as fallback before theme is loaded.

const SUGGESTIONS = [
  'Open Hermes ...',
  'Open Claude Code ...',
  'Ask me anything ...',
  'Deploy to production ...',
  'Run the test suite ...',
  'Summarize the changes ...',
  'Debug the last error ...',
  'Search the codebase ...',
  'Review my PR ...',
  'Write a commit message ...',
];

export const ChatBar: React.FC = () => {
  const [value, setValue] = useState('');
  const [displayIdx, setDisplayIdx] = useState(0);
  // ── Command bar intelligence ────────────────────────────────
  const [history, setHistory] = useState<string[]>(() => loadHistory());
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState('');            // preserved while browsing history
  const [completionIdx, setCompletionIdx] = useState(0);
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [slideOut, setSlideOut] = useState(false);
  const [isBargeIn, setIsBargeIn] = useState(false);
  const cycleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const idxRef = useRef(0);
  const bargeInTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const agents = useAppStore((s) => s.agents);
  const brandColor = useThemeStore((s) => s.theme.colors.brand);
  const infoColor = useThemeStore((s) => s.theme.colors.info);
  // Parse brand hex to RGB for rgba usage
  const brandHex = brandColor.replace('#', '');
  const brandR = parseInt(brandHex.slice(0,2), 16) || 244;
  const brandG = parseInt(brandHex.slice(2,4), 16) || 162;
  const brandB = parseInt(brandHex.slice(4,6), 16) || 97;
  const brandRGB = `${brandR},${brandG},${brandB}`;
  const infoHex = infoColor.replace('#', '');
  const infoR = parseInt(infoHex.slice(0,2), 16) || 78;
  const infoG = parseInt(infoHex.slice(2,4), 16) || 168;
  const infoB = parseInt(infoHex.slice(4,6), 16) || 222;
  const infoRGB = `${infoR},${infoG},${infoB}`;

  // ── Voice Input Integration ──────────────────────────────────
  // Remove unused icon imports
  const handleVoiceTranscript = useCallback(async (text: string) => {
    const command: AppCommand = { kind: 'message', text };
    await executeAppCommand(command);
    setValue('');
  }, []);

  const {
    voiceState,
    waveform,
    startCapture,
    stopCapture,
  } = useVoiceInput({ onTranscript: handleVoiceTranscript });

  // ── Voice state booleans (used by effects + render) ──────────
  const isListening  = voiceState === 'listening';
  const isProcessing = voiceState === 'processing';
  const isSpeaking   = voiceState === 'speaking';
  const voiceActive  = isListening || isProcessing || isSpeaking;

  // ── Smooth waveform via exponential moving average ──────────
  const waveformRef = useRef(waveform);
  waveformRef.current = waveform;
  const smoothRef = useRef<number[]>([0, 0, 0, 0]);
  const [smoothWaveform, setSmoothWaveform] = useState<number[]>([0, 0, 0, 0]);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const active = voiceState === 'listening' || voiceState === 'speaking';
    if (!active) {
      smoothRef.current = [0, 0, 0, 0];
      setSmoothWaveform([0, 0, 0, 0]);
      return;
    }
    const SMOOTH = 0.2;
    let running = true;
    const tick = () => {
      if (!running) return;
      const raw = waveformRef.current;
      if (raw.length >= 4) {
        const prev = smoothRef.current;
        const next = prev.map((v, i) => v + (raw[i] - v) * SMOOTH);
        smoothRef.current = next;
        setSmoothWaveform(next);
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { running = false; cancelAnimationFrame(rafRef.current); };
  }, [voiceState]);

  // ── Push-to-Talk: configurable key ────────────────────────
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const pttCombo = useSettingsStore.getState().pttKey;
      const parts = pttCombo.split('+');
      const needsCtrl = parts.includes('Ctrl');
      const needsShift = parts.includes('Shift');
      const keyPart = parts.filter((p) => p !== 'Ctrl' && p !== 'Shift')[0] || '';
      if ((!needsCtrl || e.ctrlKey || e.metaKey) &&
          (!needsShift || e.shiftKey) &&
          (e.key === keyPart || e.key === keyPart.toUpperCase() || e.key === keyPart.toLowerCase())) {
        e.preventDefault();
        startCapture();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const pttCombo = useSettingsStore.getState().pttKey;
      const parts = pttCombo.split('+');
      const needsCtrl = parts.includes('Ctrl');
      const needsShift = parts.includes('Shift');
      const keyPart = parts.filter((p) => p !== 'Ctrl' && p !== 'Shift')[0] || '';
      if ((!needsCtrl || e.ctrlKey || e.metaKey) &&
          (!needsShift || e.shiftKey) &&
          (e.key === keyPart || e.key === keyPart.toUpperCase() || e.key === keyPart.toLowerCase())) {
        stopCapture();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [startCapture, stopCapture]);

  // Listen for barge-in interrupt events
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    listen('bargein-interrupt', () => {
      setIsBargeIn(true);
      if (bargeInTimerRef.current) clearTimeout(bargeInTimerRef.current);
      bargeInTimerRef.current = setTimeout(() => setIsBargeIn(false), 800);
    }).then((unsub) => { unsubscribe = unsub; });
    return () => { if (unsubscribe) unsubscribe(); };
  }, []);

  // ── Suggestion chip cycle ────────────────────────────────────
  const flip = useCallback(() => {
    if (slideOut) return;
    setSlideOut(true);
    setTimeout(() => {
      idxRef.current = (idxRef.current + 1) % SUGGESTIONS.length;
      setDisplayIdx(idxRef.current);
      setSlideOut(false);
    }, 300);
  }, [slideOut]);

  const startCycle = useCallback(() => {
    if (cycleRef.current) clearInterval(cycleRef.current);
    cycleRef.current = setInterval(flip, 4000);
  }, [flip]);

  const stopCycle = useCallback(() => {
    if (cycleRef.current) {
      clearInterval(cycleRef.current);
      cycleRef.current = null;
    }
  }, []);

  // Start cycle on mount
  useEffect(() => {
    startCycle();
    return () => { stopCycle(); if (blurTimerRef.current) clearTimeout(blurTimerRef.current); };
  }, [startCycle, stopCycle]);

  // ── Voice active → stop suggestions, show "Listening …" ──
  useEffect(() => {
    if (voiceActive) {
      stopCycle();
    } else if (!cycleRef.current && !value) {
      startCycle();
    }
  }, [voiceActive, startCycle, stopCycle, value]);

  // Cmd+K / Ctrl+K to focus
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
      if (e.key === 'Escape') {
        inputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const handleFocus = () => {
    stopCycle();
    if (blurTimerRef.current) clearTimeout(blurTimerRef.current);
  };

  const handleBlur = () => {
    blurTimerRef.current = setTimeout(() => {
      if (!value) startCycle();
    }, 4000);
  };

  // ── Live analysis ──────────────────────────────────────────
  // Runs on every keystroke so the bar can show what it understood
  // before Enter, rather than silently doing something unexpected.
  const analysis: InputAnalysis = React.useMemo(
    () => analyzeInput(value, agents),
    [value, agents],
  );

  const showFeedback = useCallback((text: string, ok: boolean) => {
    setFeedback({ text, ok });
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(null), ok ? 2600 : 5000);
  }, []);

  useEffect(() => () => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
  }, []);

  const acceptCompletion = useCallback((c: Completion) => {
    // Replace the trailing token with the completion.
    const parts = value.split(/(\s+)/);
    let i = parts.length - 1;
    while (i >= 0 && /^\s+$/.test(parts[i])) i--;
    if (i >= 0) parts[i] = c.value.trimEnd();
    const next = parts.join('') + (c.value.endsWith(' ') ? ' ' : '');
    setValue(next);
    setCompletionIdx(0);
    inputRef.current?.focus();
  }, [value]);

  // ── Handle Submit ────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    const text = value.trim();
    if (!text) return;

    // An unresolvable @mention is almost always a typo. Running it as a
    // plain message would silently send it to whatever card happens to be
    // selected, which is the wrong agent — say so instead.
    if (analysis.unknownMention) {
      showFeedback(`No agent called "${analysis.unknownMention}"`, false);
      return;
    }

    setHistory(pushHistory(text));
    setHistoryIdx(null);

    const result = await executeAppCommand(analysis.command);
    // Results used to go to console.warn, so a failed command was
    // indistinguishable from a successful one: the input just cleared.
    showFeedback(result.message, result.ok);
    if (result.ok) setValue('');
  }, [value, analysis, showFeedback]);

  const hasActivity = agents.some(a => a.status === 'busy' || a.status === 'active');
  const showPlaceholder = !value;
  const currentText = SUGGESTIONS[displayIdx];
  const nextText = SUGGESTIONS[(displayIdx + 1) % SUGGESTIONS.length];

  // ── Voice-reactive energy & border glow ──────────────────────
  const activeWaveform = smoothWaveform.length >= 4 ? smoothWaveform : [0, 0, 0, 0];
  const voiceEnergy = Math.min(1,
    (activeWaveform[0] + activeWaveform[1] + activeWaveform[2] + activeWaveform[3]) / 4
  );

  const barRgb   = isSpeaking ? infoRGB : brandRGB;
  const showGlow = voiceActive || isBargeIn;

  // Border glow: intensity varies with voice volume
  const bargeBoost = isBargeIn ? 0.25 : 0;
  const borderAlpha = Math.min(0.65,
    (isProcessing ? 0.2 : 0.12 + voiceEnergy * 0.48) + bargeBoost
  );
  const glowRadius = isProcessing ? 3 : 3 + voiceEnergy * 8;
  const glowShadowAlpha = isProcessing
    ? 0.06
    : Math.min(0.25, 0.04 + voiceEnergy * 0.2);

  return (
    <div
      data-chrome="chat-bar"
      style={{
        position: 'fixed', bottom: 28, left: '50%', transform: 'translateX(-50%)',
        width: 540, maxWidth: 'calc(100vw - 48px)', height: 44,
        zIndex: Z_BASE_LAYERS.pillBar,
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '0 18px',
        borderRadius: 9999,
        background: '#222524',
        transition: 'border-color 0.15s ease, box-shadow 0.2s ease',
        // Real border glow — the border itself shines, NOT a backdrop shadow
        border: showGlow
          ? `1.5px solid rgba(${barRgb},${borderAlpha.toFixed(2)})`
          : '1px solid rgba(234, 244, 244, 0.06)',
        // Tight glow hugging the border (NOT a wide backdrop — stays close)
        boxShadow: showGlow
          ? `0 4px 20px rgba(0,0,0,0.5), 0 0 ${glowRadius.toFixed(0)}px rgba(${barRgb},${glowShadowAlpha.toFixed(2)})`
          : '0 4px 20px rgba(0,0,0,0.5)',
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      {/* ── Voice indicator: dot → reactive bars → processing dot ── */}
      <div style={{
        position: 'relative', width: 24, height: 24,
        flexShrink: 0, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
      }}>
        {/* Layer 1: Idle dot — visible when idle/loading */}
        <div style={{
          position: 'absolute',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
          opacity: (!voiceActive) ? 1 : 0,
          transform: (!voiceActive) ? 'scale(1)' : 'scale(0.3)',
        }}>
          <div style={{
            width: 8, height: 8, borderRadius: '50%',
            background: hasActivity ? brandColor : 'rgba(255,255,255,0.2)',
            boxShadow: hasActivity ? `0 0 6px ${brandColor}80` : 'none',
          }} />
        </div>

        {/* Layer 2: Processing dot — pulsing center + spinning ring */}
        <div style={{
          position: 'absolute',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
          opacity: isProcessing ? 1 : 0,
          transform: isProcessing ? 'scale(1)' : 'scale(0.3)',
        }}>
          <div style={{ position: 'relative', width: 16, height: 16 }}>
            {/* Spinning aura ring */}
            <div style={{
              position: 'absolute', inset: 0,
              borderRadius: '50%',
              border: '2px solid rgba(244,162,97,0.12)',
              borderTopColor: brandColor,
              animation: 'spin 0.7s linear infinite',
            }} />
            {/* Pulsing center dot */}
            <div style={{
              position: 'absolute', top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 5, height: 5, borderRadius: '50%',
              background: brandColor,
              boxShadow: `0 0 6px ${brandColor}80`,
              animation: 'pulse 1s ease-in-out infinite',
            }} />
          </div>
        </div>

        {/* Layer 3: 4 reactive bars — voice-driven heights */}
        <div style={{
          position: 'absolute',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2,
          transition: 'all 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
          opacity: (isListening || isSpeaking) ? 1 : 0,
          transform: (isListening || isSpeaking) ? 'scale(1)' : 'scale(0.3)',
          ...(isBargeIn ? { filter: 'brightness(1.6)' } : {}),
        }}>
          {[0, 1, 2, 3].map((i) => {
            const barColor = isSpeaking ? infoColor : brandColor;
            const h = isListening && activeWaveform.length >= 4
              ? Math.max(3, activeWaveform[i] * 18)
              : 4 + i * 3;
            return (
              <div
                key={i}
                style={{
                  width: 2, borderRadius: 3,
                  height: h,
                  background: barColor,
                  transition: 'height 0.06s linear, background 0.3s ease',
                  // Gentle idle-wave when energy is very low (prevents dead silence)
                  animationName: isListening && voiceEnergy < 0.04
                    ? 'voiceWave'
                    : undefined,
                  animationDuration: '1.5s',
                  animationTimingFunction: 'ease-in-out',
                  animationIterationCount: 'infinite',
                  animationDelay: isListening && voiceEnergy < 0.04 ? `${i * 0.12}s` : undefined,
                }}
              />
            );
          })}
        </div>
      </div>

      {/* ── Input area with suggestion chips / voice overlay ── */}
      <div style={{
        flex: 1, position: 'relative', height: '100%',
        display: 'flex', alignItems: 'center', overflow: 'hidden',
      }}>
        {/* Voice overlay: "Listening …" */}
        {isListening && (
          <span style={{
            position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
            fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
            fontSize: 13, letterSpacing: 0.8,
            color: `${brandColor}B3`,
            pointerEvents: 'none', whiteSpace: 'nowrap',
            animation: 'pulse 1.5s ease-in-out infinite',
          }}>
            Listening<span style={{ animation: 'listeningCursor 0.7s step-end infinite', marginLeft: 1 }}>▊</span>
          </span>
        )}

        {/* Voice overlay: "Processing …" */}
        {isProcessing && (
          <span style={{
            position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
            fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
            fontSize: 13, letterSpacing: 0.5,
            color: `${brandColor}99`,
            pointerEvents: 'none', whiteSpace: 'nowrap',
          }}>
            Processing<span style={{ animation: 'listeningCursor 0.9s step-end infinite', marginLeft: 1 }}>…</span>
          </span>
        )}

        {/* Suggestion chips — hidden during voice active */}
        {(!voiceActive) && (
          <>
            <span
              key={slideOut ? 'out' : `idle-${displayIdx}`}
              style={{
                position: 'absolute', left: 0, top: '50%', transform: 'translateY(-50%)',
                fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
                fontSize: 13, letterSpacing: 0.3,
                color: 'rgba(234, 244, 244, 0.35)',
                pointerEvents: 'none', whiteSpace: 'nowrap',
                opacity: showPlaceholder && !slideOut ? 1 : slideOut ? 1 : 0,
                animation: slideOut ? 'chatSlideOut 0.25s ease forwards' : 'none',
              }}
            >
              {currentText}
            </span>
            <span
              key={slideOut ? 'in' : `idle-next-${displayIdx}`}
              style={{
                position: 'absolute', left: 0, top: '50%',
                fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
                fontSize: 13, letterSpacing: 0.3,
                color: 'rgba(234, 244, 244, 0.35)',
                pointerEvents: 'none', whiteSpace: 'nowrap',
                transform: 'translateY(-50%)',
                opacity: slideOut ? 1 : 0,
                animation: slideOut ? 'chatSlideIn 0.25s ease forwards' : 'none',
              }}
            >
              {nextText}
            </span>
          </>
        )}

        {/* Actual input */}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => { setValue(e.target.value); setCompletionIdx(0); setHistoryIdx(null); }}
          onFocus={handleFocus}
          onBlur={handleBlur}
          aria-label="Command and chat input"
          aria-describedby={analysis.preview ? 'orch-cmd-preview' : undefined}
          autoComplete="off"
          spellCheck={false}
          onKeyDown={(e) => {
            const comps = analysis.completions;

            // Tab / Enter accept the highlighted completion when the list
            // is open, so completing never costs a round-trip to the mouse.
            if (comps.length > 0 && (e.key === 'Tab' || (e.key === 'Enter' && completionIdx > 0))) {
              e.preventDefault();
              acceptCompletion(comps[Math.min(completionIdx, comps.length - 1)]);
              return;
            }
            if (comps.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setCompletionIdx((i) => {
                const n = comps.length;
                return e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n;
              });
              return;
            }

            if (e.key === 'Enter') { handleSubmit(); return; }

            if (e.key === 'Escape') {
              if (value) { setValue(''); setHistoryIdx(null); }
              else inputRef.current?.blur();
              return;
            }

            // ── History ──
            // Only when there is no completion list to navigate.
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              if (history.length === 0) return;
              const next = historyIdx === null ? history.length - 1 : Math.max(0, historyIdx - 1);
              if (historyIdx === null) setDraft(value);
              setHistoryIdx(next);
              setValue(history[next]);
              return;
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              if (historyIdx === null) return;
              const next = historyIdx + 1;
              if (next >= history.length) { setHistoryIdx(null); setValue(draft); }
              else { setHistoryIdx(next); setValue(history[next]); }
              return;
            }
          }}
          style={{
            width: '100%', background: 'transparent', border: 'none', outline: 'none',
            fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
            fontSize: 13, letterSpacing: 0.3,
            color: 'rgba(234, 244, 244, 0.88)',
            caretColor: brandColor,
            position: 'relative', zIndex: 1,
          }}
        />
      </div>

      {/* ── Completions ── */}
      {analysis.completions.length > 0 && value.trim() && (
        <div
          role="listbox"
          aria-label="Suggestions"
          style={{
            position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, right: 0,
            background: 'var(--menu-bg, rgba(14,26,20,0.96))',
            border: '1px solid var(--border-dim)', borderRadius: 'var(--radius-md)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)', overflow: 'hidden',
            backdropFilter: 'blur(20px)',
          }}
        >
          {analysis.completions.map((c, i) => (
            <button
              key={`${c.kind}-${c.value}`}
              role="option"
              aria-selected={i === completionIdx}
              onMouseDown={(e) => { e.preventDefault(); acceptCompletion(c); }}
              onMouseEnter={() => setCompletionIdx(i)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                padding: '7px 12px', border: 'none', textAlign: 'left', cursor: 'pointer',
                background: i === completionIdx ? `rgba(${brandRGB},0.14)` : 'transparent',
                color: 'var(--text)', fontFamily: "'JetBrains Mono', monospace", fontSize: 12,
              }}
            >
              <span style={{
                fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.5,
                minWidth: 52,
              }}>
                {c.kind}
              </span>
              <span style={{ fontWeight: 600 }}>{c.label}</span>
              {c.hint && <span style={{ opacity: 0.45, fontSize: 11 }}>{c.hint}</span>}
            </button>
          ))}
          <div style={{
            padding: '4px 12px', fontSize: 9, opacity: 0.35,
            borderTop: '1px solid var(--border-dim)',
            fontFamily: "'JetBrains Mono', monospace",
          }}>
            Tab to complete · ↑↓ to choose
          </div>
        </div>
      )}

      {/* ── Intent preview ── */}
      {value.trim() && analysis.completions.length === 0 && (
        <div
          id="orch-cmd-preview"
          aria-live="polite"
          style={{
            position: 'absolute', bottom: 'calc(100% + 6px)', left: 14,
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 10.5, fontFamily: "'JetBrains Mono', monospace",
            color: analysis.unknownMention ? 'var(--error, #E76F51)' : `rgba(${brandRGB},0.85)`,
            pointerEvents: 'none', whiteSpace: 'nowrap',
          }}
        >
          <span style={{ opacity: 0.6 }}>→</span>
          {analysis.unknownMention
            ? `No agent called "${analysis.unknownMention}"`
            : analysis.preview}
        </div>
      )}

      {/* ── Result feedback ── */}
      {feedback && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'absolute', bottom: 'calc(100% + 6px)', right: 14,
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: 999,
            background: feedback.ok ? `rgba(${brandRGB},0.16)` : 'rgba(231,111,81,0.18)',
            border: `1px solid ${feedback.ok ? `rgba(${brandRGB},0.4)` : 'rgba(231,111,81,0.5)'}`,
            color: feedback.ok ? 'var(--text)' : 'var(--error, #E76F51)',
            fontSize: 10.5, fontFamily: "'JetBrains Mono', monospace",
            maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {feedback.text}
        </div>
      )}
    </div>
  );
};
