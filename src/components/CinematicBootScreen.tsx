import React, { useState, useRef, useEffect } from 'react';
import { useThemeStore } from '../stores/useThemeStore';
import { Z_BASE_LAYERS } from '../lib/z-stack-manager';

// ── Initialization Telemetry Milestones ────────────────────────────
// Each milestone simulates a subsystem coming online. The ticker
// waterfall cycles through these to create the loading-into-life feel.

const BOOT_MILESTONES: string[] = [
  'Initializing local database',
  'Booting local SSE MCP server',
  'Syncing store layer v11',
  'Mapping local-agent keyring',
  'Mounting artifact registry',
  'Warming telemetry bridge',
  'Checking for asset hot-patches',
  'Loading session cache',
  'Injecting workspace loops',
  'Calibrating grid engine',
  'Spawning event bus',
  'Hydrating canvas state',
  'Resolving ambient shaders',
  'Priming sync horizon',
  'Verifying provider probes',
  'Settling layout engine',
];

const TELEMETRY_LINES = BOOT_MILESTONES.map((m) => `[OK] ${m}`);

// ── Cinematic Boot Screen ──────────────────────────────────────────

export const CinematicBootScreen: React.FC = () => {
  const theme = useThemeStore((s) => s.theme);
  const isImage = theme.video.match(/\.(jpg|jpeg|png|gif|webp)$/i);
  const videoRef = useRef<HTMLVideoElement>(null);

  // Telemetry ticker: the index of the *last fully visible* line
  const [tickerPos, setTickerPos] = useState(0);

  // Cascade lines upward: a new line appears every ~120 ms
  useEffect(() => {
    if (tickerPos >= TELEMETRY_LINES.length) return;
    const delay = 80 + Math.random() * 100; // 80–180ms jitter for organic feel
    const timer = setTimeout(() => setTickerPos((p) => p + 1), delay);
    return () => clearTimeout(timer);
  }, [tickerPos]);

  // ── Silent update check at "Checking for asset hot-patches" ──
  const UPDATE_CHECK_INDEX = 6; // 0-based index of the hot-patches milestone
  const updateCheckFired = useRef(false);
  useEffect(() => {
    if (tickerPos >= UPDATE_CHECK_INDEX && !updateCheckFired.current) {
      updateCheckFired.current = true;
      import('../lib/electron-api').then(({ checkForUpdates }) => {
        checkForUpdates().catch(() => {});
      });
    }
  }, [tickerPos]);

  // Loop the video if it stalls
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const handle = () => { v.play().catch(() => {}); };
    v.addEventListener('ended', handle);
    return () => v.removeEventListener('ended', handle);
  }, []);

  // ── Resolved active / visible window ──────────────────────────
  const visibleCount = Math.min(tickerPos, TELEMETRY_LINES.length);
  // Maximum lines that fit in the ticker viewport (≈5)
  const MAX_VISIBLE = 5;
  const startIdx = Math.max(0, visibleCount - MAX_VISIBLE);

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: Z_BASE_LAYERS.modal,
        overflow: 'hidden',
      }}
    >
      <style>{`
        @keyframes breathe-title {
          0%, 100% { opacity: 0.6; filter: drop-shadow(0 0 15px rgba(244,162,97,0.10)); }
          50%      { opacity: 1.0; filter: drop-shadow(0 0 30px rgba(244,162,97,0.25)); }
        }
        @keyframes tickerFadeIn {
          from { opacity: 0; transform: translateY(-4px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes blinkCaret {
          0%, 100% { opacity: 1; }
          50%      { opacity: 0; }
        }
      `}</style>

      {/* ── Layer 1: Ambient video / image backdrop ────────────── */}
      <div
        style={{
          position: 'absolute', inset: 0, zIndex: 0,
          overflow: 'hidden',
        }}
      >
        {isImage ? (
          <img
            key={theme.video}
            src={theme.video}
            alt=""
            draggable={false}
            style={{
              width: '100%', height: '100%',
              objectFit: 'cover',
            }}
          />
        ) : (
          <video
            key={theme.video}
            ref={videoRef}
            autoPlay muted loop playsInline
            style={{
              width: '100%', height: '100%',
              objectFit: 'cover',
            }}
          >
            <source src={theme.video} type="video/mp4" />
          </video>
        )}
      </div>

      {/* ── Layer 2: Heavy glassmorphic blur mask ──────────────── */}
      <div
        style={{
          position: 'absolute', inset: 0, zIndex: 1,
          backdropFilter: 'blur(40px) saturate(140%)',
          WebkitBackdropFilter: 'blur(40px) saturate(140%)',
        }}
      />

      {/* ── Layer 3: Deep vignette gradient ────────────────────── */}
      <div
        style={{
          position: 'absolute', inset: 0, zIndex: 2,
          background:
            'radial-gradient(circle, rgba(0,0,0,0.20) 0%, rgba(0,0,0,0.85) 100%)',
        }}
      />

      {/* ── Layer 4: Content ───────────────────────────────────── */}
      <div
        style={{
          position: 'relative', zIndex: 3,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          width: '100%', height: '100%',
          gap: 28,
        }}
      >
        {/* ── Asymmetric ORCH logo with breathing animation ──── */}
        <div
          style={{
            fontFamily: "'Edu AU VIC WA NT Pre', cursive",
            fontSize: '5.5rem',
            fontWeight: 400,
            lineHeight: 1,
            color: '#ffffff',
            letterSpacing: '0.04em',
            textShadow: '0 0 20px rgba(244,162,97,0.15), 0 0 60px rgba(244,162,97,0.06)',
            animation: 'breathe-title 3s ease-in-out infinite',
            userSelect: 'none',
          }}
        >
          ORCH
        </div>

        {/* ── Subsystem Telemetry Waterfall ──────────────────── */}
        <div
          style={{
            width: 380,
            maxWidth: 'calc(100vw - 64px)',
            height: 108,               // ≈5 lines × 18px + padding
            overflow: 'hidden',
            position: 'relative',
          }}
        >
          <div
            style={{
              position: 'absolute',
              bottom: 0,
              left: 0, right: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
            }}
          >
            {TELEMETRY_LINES.slice(startIdx, visibleCount).map((line, i) => (
              <div
                key={startIdx + i}
                style={{
                  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
                  fontSize: 11,
                  fontWeight: 500,
                  letterSpacing: '0.08em',
                  color: 'rgba(255,255,255,0.50)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  animation: i === visibleCount - 1 - startIdx
                    ? 'tickerFadeIn 0.2s ease forwards'
                    : 'none',
                  opacity: i === visibleCount - 1 - startIdx ? 0 : 1,
                }}
              >
                {line}
              </div>
            ))}
          </div>
        </div>

        {/* ── Blinking caret footer ──────────────────────────── */}
        <div
          style={{
            fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.12em',
            color: 'rgba(244,162,97,0.30)',
            textTransform: 'uppercase',
            animation: 'blinkCaret 1.2s step-end infinite',
            marginTop: -4,
          }}
        >
          {tickerPos >= TELEMETRY_LINES.length ? 'ready' : 'booting_'}
        </div>
      </div>
    </div>
  );
};
