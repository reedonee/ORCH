import React, { useState, useEffect, useRef } from 'react';
import { useThemeStore } from './stores/useThemeStore';
import { useAppStore } from './stores/useAppStore';
import { useWorkspaceStore } from './stores/useWorkspaceStore';
import { InfiniteCanvas } from './components/InfiniteCanvas';
import { PillBar } from './components/PillBar';
import { ChatBar } from './components/ChatBar';
import { SettingsDialog } from './components/SettingsDialog';
import { WorkspaceDialog } from './components/WorkspaceDialog';
import { useWorkspaceAutoSave } from './hooks/useWorkspaceAutoSave';
import { useWorkspaceFileSync } from './hooks/useWorkspaceFileSync';
import { useAuthStore } from './stores/useAuthStore';
import { AuthDialog } from './components/AuthDialog';
import { voiceSpeak } from './lib/electron-api';
import { listWorkspaces } from './lib/db';
import './styles/globals.css';
import './styles/glass.css';

const App: React.FC = () => {
  const theme = useThemeStore((s) => s.theme);
  const agents = useAppStore((s) => s.agents);
  const loadAgents = useAppStore((s) => s.loadAgents);
  const loadRecentWorkspaces = useWorkspaceStore((s) => s.loadRecentWorkspaces);
  const [showSettings, setShowSettings] = useState(false);
  const [showWorkspace, setShowWorkspace] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const isImage = theme.video.match(/\.(jpg|jpeg|png|gif|webp)$/i);
  const prevCountRef = useRef(agents.length);

  // ── Auth gate ────────────────────────────────────────────────
  const authStatus = useAuthStore((s) => s.status);

  // ── Bootstrap: initialise auth session first ────────────────
  useEffect(() => {
    useAuthStore.getState().initialize();
  }, []);

  // ── Load workspaces only when authenticated ────────────────
  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    loadRecentWorkspaces();
  }, [loadRecentWorkspaces, authStatus]);

  // ── Auto-open last workspace + preload cache ───────────────
  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    const timer = setTimeout(async () => {
      const store = useWorkspaceStore.getState();
      await store.autoOpenLastWorkspace();
      // Pre-fetch all recent workspaces into memory for instant switching
      store.preloadCache();
    }, 100);
    return () => clearTimeout(timer);
  }, [authStatus]);

  // ── Sync cloud workspaces on auth ──────────────────────────
  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    // Fire-and-forget: merge cloud workspaces into the recent list
    listWorkspaces().then((cloudWorkspaces) => {
      const store = useWorkspaceStore.getState();
      const existing = store.recentWorkspaces;
      // Only merge if we have cloud workspaces to add
      if (cloudWorkspaces.length === 0) return;
      // Prepend cloud workspaces that aren't already in the local list
      const existingPaths = new Set(existing.map((w) => w.path));
      const newEntries = cloudWorkspaces
        .filter((cw) => !existingPaths.has(cw.name))
        .map((cw) => ({
          path: cw.name, // placeholder path — user will pick folder on first open
          name: cw.name,
          lastOpened: new Date(cw.last_opened).getTime(),
        }));
      if (newEntries.length > 0) {
        store.saveRecentWorkspaces([...newEntries, ...existing]).catch(() => {});
      }
    }).catch(() => {});
  }, [authStatus]);

  // ── Wire up workspace auto-save (debounced file writes) ──
  useWorkspaceAutoSave();

  // ── Wire up VPS file sync (auto-start/stop with workspace) ──
  useWorkspaceFileSync();

  // ── Agent lifecycle TTS ────────────────────────────────────
  useEffect(() => {
    const prev = prevCountRef.current;
    const curr = agents.length;
    prevCountRef.current = curr;
    if (curr === 0 || prev === 0) return; // skip initial load
    if (curr > prev) {
      const newAgent = agents.find((_, i) => i >= prev);
      if (newAgent) voiceSpeak('lifecycle', `${newAgent.provider || 'Agent'} starting`).catch(() => {});
    } else if (curr < prev) {
      voiceSpeak('lifecycle', 'Agent closed').catch(() => {});
    }
  }, [agents.length]);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  // Apply theme CSS variables
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--bg', theme.colors.bg);
    root.style.setProperty('--bg-alt', theme.colors.bgAlt);
    root.style.setProperty('--surface', theme.colors.surface);
    root.style.setProperty('--surface-alt', theme.colors.surfaceAlt);
    root.style.setProperty('--text', theme.colors.text);
    root.style.setProperty('--text-secondary', theme.colors.textSecondary);
    root.style.setProperty('--text-muted', theme.colors.textMuted);
    root.style.setProperty('--accent', theme.colors.accent);
    root.style.setProperty('--accent-dim', theme.colors.accentDim);
    root.style.setProperty('--accent-glow', theme.colors.accentGlow);
    root.style.setProperty('--border', theme.colors.border);
    root.style.setProperty('--border-dim', theme.colors.borderDim);
    root.style.setProperty('--brand', theme.colors.brand);
    root.style.setProperty('--menu-bg', theme.colors.menuBg);
    root.style.setProperty('--glass-bg', theme.glass.bg);
    root.style.setProperty('--glass-border', theme.glass.border);
    root.style.setProperty('--glass-blur', theme.glass.blur);
    root.style.setProperty('--glass-hover', theme.glass.hover);
    root.style.setProperty('--glass-active', theme.glass.active);
    root.style.setProperty('--shadow-sm', theme.shadows.sm);
    root.style.setProperty('--shadow-md', theme.shadows.md);
    root.style.setProperty('--shadow-lg', theme.shadows.lg);
    root.style.setProperty('--shadow-xl', theme.shadows.xl);
    root.style.setProperty('--shadow-glow', theme.shadows.glow);
    root.style.setProperty('--radius-sm', theme.radius.sm);
    root.style.setProperty('--radius-md', theme.radius.md);
    root.style.setProperty('--radius-lg', theme.radius.lg);
    root.style.setProperty('--radius-xl', theme.radius.xl);
    root.style.setProperty('--radius-pill', theme.radius.pill);
    root.style.setProperty('--spacing-xs', theme.spacing.xs);
    root.style.setProperty('--spacing-sm', theme.spacing.sm);
    root.style.setProperty('--spacing-md', theme.spacing.md);
    root.style.setProperty('--spacing-lg', theme.spacing.lg);
    root.style.setProperty('--spacing-xl', theme.spacing.xl);
    root.style.setProperty('--spacing-2xl', theme.spacing['2xl']);
    root.style.setProperty('--anim-fast', theme.animation.fast);
    root.style.setProperty('--anim-normal', theme.animation.normal);
    root.style.setProperty('--anim-slow', theme.animation.slow);
  }, [theme]);

  // ── Pause video bg when window hidden — image bgs don't need this ──
  useEffect(() => {
    if (isImage || !videoRef.current) return;
    const onVisibilityChange = () => {
      if (!videoRef.current) return;
      if (document.hidden) {
        videoRef.current.pause();
      } else {
        videoRef.current.play().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, [isImage]);

  // ── Auth gate: loading splash ──────────────────────────────
  if (authStatus === 'loading') {
    return (
      <div style={{
        position: 'fixed', inset: 0, zIndex: 2000,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: 20,
        background: 'var(--bg)',
      }}>
        <div style={{
          fontSize: 28, fontWeight: 800,
          color: 'var(--brand)',
          letterSpacing: 1,
        }}>
          ORCH
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 500 }}>
          Loading…
        </div>
      </div>
    );
  }

  // ── Auth gate: login wall ──────────────────────────────────
  if (authStatus !== 'authenticated') {
    return <AuthDialog mode="gate" />;
  }

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      {/* Background — video or image per theme */}
      <div style={{
        position: 'fixed', inset: 0, zIndex: 0,
        overflow: 'hidden', pointerEvents: 'none',
      }}>
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

      <div className="drag-region" style={{ position: 'fixed', top: 0, left: 0, right: 0, height: 32, zIndex: 1001 }}>
      </div>

      <InfiniteCanvas />
      <PillBar
        onOpenSettings={() => setShowSettings(true)}
        onOpenWorkspace={() => setShowWorkspace(true)}
        onOpenAuth={() => setShowAuth(true)}
      />
      <ChatBar />
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showWorkspace && <WorkspaceDialog onClose={() => setShowWorkspace(false)} />}
      {showAuth && <AuthDialog onClose={() => setShowAuth(false)} />}
    </div>
  );
};

export default App;
