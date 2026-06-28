import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useAppStore } from '../stores/useAppStore';
import { useTerminalStore } from '../stores/useTerminalStore';
import { useThemeStore } from '../stores/useThemeStore';
import { useSettingsStore } from '../stores/useSettingsStore';
import { useWorkspaceStore } from '../stores/useWorkspaceStore';
import { Z_BASE_LAYERS } from '../lib/z-stack-manager';
import { useVoiceInput, type VoiceState } from '../hooks/useVoiceInput';
import { executeAppCommand, type AppCommand } from '../lib/agent-commands';
import { listen } from '../lib/electron-api';
import { parseCommand } from '../lib/voice-parser';

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
  const [slideOut, setSlideOut] = useState(false);
  const [isBargeIn, setIsBargeIn] = useState(false);
  const cycleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const idxRef = useRef(0);
  const bargeInTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { agents, selectedAgentId } = useAppStore();
  const { writeToTerminal } = useTerminalStore();
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
    ready: voiceReady,
    startCapture,
    stopCapture,
    interrupt: interruptVoice,
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

  // ── Handle Submit ────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!value.trim()) return;

    const command = parseCommand(value.trim());
    if (command) {
      const result = await executeAppCommand(command);
      if (!result.ok) {
        console.warn('[ChatBar] Command failed:', result.message);
        if (command.kind === 'spawn' && result.message.startsWith('Provider not found')) {
          const store = useAppStore.getState();
          const id = crypto.randomUUID();
          const name = command.providerId.charAt(0).toUpperCase() + command.providerId.slice(1);
          const pos = useWorkspaceStore.getState().spawnPosition();
          await store.addAgent({
            id, name, role: 'Developer', status: 'idle',
            provider: command.providerId, x: pos.x,
            y: pos.y, color: brandColor,
          });
        }
      }
      setValue('');
      return;
    }

    const commandMsg: AppCommand = { kind: 'message', text: value };
    const msgResult = await executeAppCommand(commandMsg);
    if (!msgResult.ok) console.warn('[ChatBar]', msgResult.message);
    setValue('');
  }, [value]);

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
          onChange={(e) => setValue(e.target.value)}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
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
    </div>
  );
};
