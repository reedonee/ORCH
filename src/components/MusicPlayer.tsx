import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useMusicPlayerStore, type Track } from '../stores/useMusicPlayerStore';
import { useThemeStore } from '../stores/useThemeStore';
import { usePanelRegistry } from '../stores/usePanelRegistry';
import { usePanelDrag } from '../hooks/usePanelDrag';
import { computePanelZIndex } from '../lib/z-stack-manager';
import { musicResolveUrl, musicSearch, musicPlaylist } from '../lib/electron-api';
import {
  X, Play, Pause, SkipForward, SkipBack, Shuffle, Repeat, Volume2, Volume1, VolumeX,
  Search, Music, ListMusic, Loader2
} from 'lucide-react';

const MIN_W = 380;
const MIN_H = 340;
const HEADER_H = 36;

/** Proper SoundCloud cloud logo SVG */
const SoundCloudIcon: React.FC<{ size?: number; color?: string }> = ({ size = 14, color }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill={color || 'currentColor'} style={{ flexShrink: 0 }}>
    <path d="M11.56 8.87V17h8.47a1.85 1.85 0 0 0 0-3.7 1.82 1.82 0 0 0-.42.05 3.49 3.49 0 0 0-3.36-4.14 3.56 3.56 0 0 0-1.16.2 4.55 4.55 0 0 0-3.53-2.09z"/>
    <path d="M8.74 10.24V17h1.57V9.49a2.05 2.05 0 0 0-1.57.75zM5.75 11.37V17h1.57v-5.62a3.1 3.1 0 0 0-1.57 0zM2.82 12.74V17h1.57v-4.46a2.44 2.44 0 0 0-1.57.2zM0 14.42V17h1.57v-2.93a2.1 2.1 0 0 0-1.57.35z"/>
  </svg>
);

function fmtTime(s: number): string {
  if (!s || isNaN(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function isPlaylist(url: string): boolean { return url.includes('playlist?list=') || url.includes('&list='); }
function isSoundCloud(url: string): boolean { return url.includes('soundcloud.com'); }

function extractYoutubeId(url: string): string | null {
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

// ── YouTube IFrame Video Player ─────────────────────────────────
let ytApiInjected = false;
function injectYtApi() {
  if (ytApiInjected) return;
  ytApiInjected = true;
  const tag = document.createElement('script');
  tag.src = 'https://www.youtube.com/iframe_api';
  const first = document.getElementsByTagName('script')[0];
  first?.parentNode?.insertBefore(tag, first);
}

let ytPlayerInstance: any = null;
let ytPlayerReady = false;
let ytPlayerCallbacks: Array<() => void> = [];

(window as any).onYouTubeIframeAPIReady = () => {
  ytPlayerReady = true;
  ytPlayerCallbacks.forEach((cb) => cb());
  ytPlayerCallbacks = [];
};

function onYtReady(cb: () => void) {
  if (ytPlayerReady) { cb(); return; }
  ytPlayerCallbacks.push(cb);
}

const YoutubeVideoPlayer: React.FC<{
  videoId: string;
  onStateChange: (state: number) => void;
  onReady: () => void;
  onTimeUpdate?: (current: number, duration: number) => void;
}> = ({ videoId, onStateChange, onReady, onTimeUpdate }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    injectYtApi();
    onYtReady(() => setReady(true));
  }, []);

  useEffect(() => {
    if (!ready || !containerRef.current) return;
    if (playerRef.current) {
      try { playerRef.current.destroy(); } catch {}
      playerRef.current = null;
    }
    const id = `yt-player-${videoId}`;
    containerRef.current.innerHTML = `<div id="${id}" style="width:100%;height:100%"></div>`;

    const player = new (window as any).YT.Player(id, {
      videoId,
      height: '100%',
      width: '100%',
      playerVars: {
        autoplay: 1,
        controls: 0,
        modestbranding: 0,
        rel: 0,
        showinfo: 0,
        iv_load_policy: 3,
        fs: 0,
        cc_load_policy: 0,
        disablekb: 0,
        playsinline: 1,
      },
      events: {
        onReady: () => {
          playerRef.current = player;
          ytPlayerInstance = player;
          onReady();
        },
        onStateChange: (e: any) => {
          onStateChange(e.data);
          if (e.data === 0) {
            const store = useMusicPlayerStore.getState();
            store.next();
          }
        },
      },
    });
    return () => {
      try { player.destroy(); } catch {}
      playerRef.current = null;
    };
  }, [videoId, ready]);

  // Poll progress
  useEffect(() => {
    if (!ready) return;
    const id = setInterval(() => {
      const p = ytPlayerInstance;
      if (!p || !p.getCurrentTime) return;
      const ct = p.getCurrentTime();
      const dur = p.getDuration();
      if (onTimeUpdate && typeof ct === 'number' && typeof dur === 'number') {
        onTimeUpdate(ct, dur);
      }
    }, 250);
    return () => clearInterval(id);
  }, [videoId, ready, onTimeUpdate]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Invisible click-block overlay — lets our controls handle clicks */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'auto' }} />
    </div>
  );
};

// ── Search Result Card ──────────────────────────────────────────
const SearchResult: React.FC<{ track: Track; onAdd: (t: Track) => void }> = ({ track, onAdd }) => (
  <div onClick={() => onAdd(track)}
    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 'var(--radius-md)', cursor: 'pointer', transition: 'background var(--anim-fast)' }}>
    {track.thumb ? (
      <img src={track.thumb} alt="" style={{ width: 28, height: 20, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }} />
    ) : (
      <div style={{ width: 28, height: 20, borderRadius: 4, background: 'rgba(255,255,255,0.04)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Music size={10} style={{ color: 'var(--text-muted)' }} />
      </div>
    )}
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{track.title}</div>
      <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{track.channel} · {fmtTime(track.duration)}</div>
    </div>
    {track.source === 'youtube' ? (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="#FF0000" style={{ flexShrink: 0 }}>
        <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
      </svg>
    ) : <SoundCloudIcon size={11} />}
  </div>
);

// ── Main MusicPlayer Panel ──────────────────────────────────────
export const MusicPlayer: React.FC = () => {
  const store = useMusicPlayerStore();
  const {
    queue, currentIndex, playerState, currentTime, duration, volume,
    shuffle, repeat, visible, searchQuery, searchResults, activeSource,
    play, addToQueue, removeFromQueue, clearQueue,
    next, prev, pause, resume, seek, setCurrentTime, setDuration,
    setVolume, toggleShuffle, cycleRepeat,
    setSearchQuery, setSearchResults, setVisible,
    setActiveSource, setPosition, setSize, setPlayerState,
    scUser,
  } = store;

  const brandColor = useThemeStore((s) => s.theme.colors.brand);
  const c = useThemeStore((s) => s.theme.colors);

  const [searching, setSearching] = useState(false);
  const [showQueue, setShowQueue] = useState(false);
  const [ytVideoId, setYtVideoId] = useState<string | null>(null);
  const [ytPlaying, setYtPlaying] = useState(false);
  const seekRef = useRef<HTMLDivElement>(null);
  const volRef = useRef<HTMLDivElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ytReadyRef = useRef(false);
  const currentTrack = queue[currentIndex] || null;

  // ── Register with the panel registry ───────────────────────
  const registry = usePanelRegistry();
  useEffect(() => {
    registry.registerPanel({
      id: 'music',
      type: 'music',
      space: 'canvas',
      x: store.x, y: store.y, width: store.width, height: store.height,
      minWidth: MIN_W,
      minHeight: MIN_H,
      defaultWidth: 420,
      defaultHeight: 560,
      participatesInAutoLayout: true,
      participatesInFraming: true,
      participatesInCollision: true,
      draggable: true,
      resizable: true,
      focusable: true,
      baseZIndex: 105,
      persistent: false,
    });
    return () => { registry.unregisterPanel('music'); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync registry → music store after hook commits position/size
  const panel = usePanelRegistry((s) => s.panels['music']);
  const lastSyncRef = useRef({ x: 0, y: 0, w: 0, h: 0 });
  useEffect(() => {
    if (!panel) return;
    const ls = lastSyncRef.current;
    if (panel.x !== ls.x || panel.y !== ls.y) {
      setPosition(panel.x, panel.y);
    }
    if (panel.width !== ls.w || panel.height !== ls.h) {
      setSize(panel.width, panel.height);
    }
    lastSyncRef.current = { x: panel.x, y: panel.y, w: panel.width, h: panel.height };
  }, [panel?.x, panel?.y, panel?.width, panel?.height, setPosition, setSize]);

  // ── Unified drag/resize via panel registry ─────────────────
  const {
    dragHandlers,
    resizeHandlers,
    positionStyle,
    transition,
    isDragging,
    isResizing,
  } = usePanelDrag({
    panelId: 'music',
    snapToGrid: 32,
  });

  // ── Z-index from central stack manager ─────────────────────
  const zIndex = computePanelZIndex(
    'music',
    'canvas',
    105,
    true,
    registry.activePanelId,
    registry.dragPanelId,
    registry.resizePanelId,
    registry.zStack,
  );

  // ── YouTube video detection ──────────────────────────────────
  useEffect(() => {
    if (currentTrack && currentTrack.source === 'youtube') {
      const vid = extractYoutubeId(currentTrack.url);
      setYtVideoId(vid);
      if (vid) injectYtApi();
    } else {
      setYtVideoId(null);
    }
  }, [currentTrack?.url, currentIndex]);

  // ── Search ──────────────────────────────────────────────────
  const handleSearch = async (q: string) => {
    setSearchQuery(q);
    if (!q.trim()) { setSearchResults([]); return; }
    setSearching(true);
    try {
      const result = await musicSearch(q, activeSource);
      if (result.success && result.data) setSearchResults(result.data as Track[]);
    } catch {}
    setSearching(false);
  };

  const onSearchChange = (q: string) => {
    setSearchQuery(q);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => handleSearch(q), 500);
  };

  // ── URL input ───────────────────────────────────────────────
  const [urlInput, setUrlInput] = useState('');
  const handleUrlSubmit = async () => {
    const url = urlInput.trim();
    if (!url) return;
    try {
      if (isPlaylist(url)) {
        const result = await musicPlaylist(url);
        if (result.success && result.data?.tracks) store.playPlaylist(result.data.tracks, 0);
      } else {
        const source = isSoundCloud(url) ? 'soundcloud' : 'youtube';
        setActiveSource(source);
        const result = await musicResolveUrl(url);
        if (result.success && result.data) {
          const t: Track = {
            id: url, title: result.data.title || url, duration: result.data.duration || 0,
            thumb: result.data.thumb || '', channel: result.data.channel || '', url, source,
          };
          play(t);
        }
      }
    } catch (err: any) { console.warn('[Music] URL resolve failed:', err); }
    setUrlInput('');
  };

  // ── Add search result ───────────────────────────────────────
  const handleAddTrack = (track: Track) => {
    addToQueue(track);
    if (queue.length === 0) play(track);
  };

  const handleYtReady = useCallback(() => { ytReadyRef.current = true; }, []);
  const handleYtState = useCallback((state: number) => {
    setYtPlaying(state === 1);
    if (state === 1) { setPlayerState('playing'); }
    else if (state === 2) { setPlayerState('paused'); }
  }, []);

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  const handleSeek = (e: React.MouseEvent) => {
    if (!seekRef.current || !duration) return;
    const rect = seekRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (ytPlayerInstance && ytVideoId) {
      ytPlayerInstance.seekTo(pct * duration, true);
    }
    seek(pct * duration);
  };

  const handleVolume = (e: React.MouseEvent) => {
    if (!volRef.current) return;
    const rect = volRef.current.getBoundingClientRect();
    setVolume(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
  };

  if (!visible) return null;

  const vidHeight = ytVideoId ? Math.min(240, (positionStyle.height as number) * 0.4) : 0;
  const hasVideo = ytVideoId && activeSource === 'youtube';

  return (
    <div
      className="animate-scale-in"
      style={{
        position: 'absolute',
        left: positionStyle.left as number,
        top: positionStyle.top as number,
        width: positionStyle.width as number,
        height: positionStyle.height as number,
        zIndex,
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        display: 'flex', flexDirection: 'column',
        background: c.bgAlt,
        border: `1px solid ${c.border}`,
        boxShadow: 'none',
        cursor: isDragging ? 'grabbing' : isResizing ? 'nwse-resize' : 'default',
        transition,
      }}
    >
      {/* ── Header ──────────────────────────────────────────────── */}
      <div onMouseDown={(e) => {
        e.stopPropagation();
        registry.focusPanel('music');
        dragHandlers.onMouseDown(e);
      }}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, height: HEADER_H,
          padding: '0 8px', background: c.surfaceAlt,
          borderBottom: `1px solid ${c.borderDim}`,
          cursor: 'grab', userSelect: 'none', flexShrink: 0,
        }}>
        <Music size={12} style={{ color: brandColor, flexShrink: 0 }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', flex: 1, fontFamily: 'var(--font-heading)' }}>
          Music {currentTrack ? `· ${currentTrack.title.slice(0, 30)}` : ''}
        </span>
        <span className="no-drag" onClick={() => setVisible(false)}
          style={{ width: 20, height: 20, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--text-muted)', flexShrink: 0 }}>
          <X size={12} />
        </span>
      </div>

      {/* ── Source tabs ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 0, flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
        <button className="no-drag" onClick={() => setActiveSource('youtube')}
          style={{
            flex: 1, padding: '6px 0', fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
            background: activeSource === 'youtube' ? c.surfaceAlt : 'transparent',
            color: activeSource === 'youtube' ? brandColor : 'var(--text-muted)',
            border: 'none', borderBottom: activeSource === 'youtube' ? `2px solid ${brandColor}` : '2px solid transparent',
            cursor: 'pointer', fontFamily: 'var(--font-accent)', textTransform: 'uppercase',
            transition: 'all var(--anim-fast)',
          }}>
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>
            YouTube
          </span>
        </button>
        <button className="no-drag" onClick={() => setActiveSource('soundcloud')}
          style={{
            flex: 1, padding: '6px 0', fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
            background: activeSource === 'soundcloud' ? c.surfaceAlt : 'transparent',
            color: activeSource === 'soundcloud' ? brandColor : 'var(--text-muted)',
            border: 'none', borderBottom: activeSource === 'soundcloud' ? `2px solid ${brandColor}` : '2px solid transparent',
            cursor: 'pointer', fontFamily: 'var(--font-accent)', textTransform: 'uppercase',
            transition: 'all var(--anim-fast)',
          }}>
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            <SoundCloudIcon size={13} />
            SoundCloud
          </span>
        </button>
      </div>

      {/* ── YouTube Video Player ────────────────────────────────── */}
      {hasVideo && (
        <div style={{ width: '100%', height: vidHeight, flexShrink: 0, position: 'relative', background: '#000' }}>
          {ytVideoId && <YoutubeVideoPlayer key={ytVideoId} videoId={ytVideoId} onReady={handleYtReady} onStateChange={handleYtState}
            onTimeUpdate={(ct, dur) => { setCurrentTime(ct); setDuration(dur); }} />}
        </div>
      )}

      {/* ── Content area ─────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>

        {/* URL input + Search */}
        <div style={{ padding: '6px 10px', display: 'flex', gap: 4, flexShrink: 0 }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <input value={urlInput} onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleUrlSubmit(); }}
              placeholder={activeSource === 'soundcloud' ? 'SoundCloud URL…' : 'YouTube URL…'}
              className="no-drag"
              style={{
                width: '100%', padding: '4px 8px', borderRadius: 9999,
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)',
                color: 'var(--text)', fontSize: 10, fontFamily: "'JetBrains Mono', monospace", outline: 'none',
              }}
            />
          </div>
        </div>

        {/* Search */}
        <div style={{ padding: '0 10px 4px', flexShrink: 0 }}>
          <div style={{ position: 'relative' }}>
            <Search size={10} style={{ position: 'absolute', left: 6, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input value={searchQuery} onChange={(e) => onSearchChange(e.target.value)}
              placeholder={`Search ${activeSource === 'soundcloud' ? 'SoundCloud' : 'YouTube'}…`}
              className="no-drag"
              style={{
                width: '100%', padding: '4px 8px 4px 24px', borderRadius: 9999,
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.06)',
                color: 'var(--text)', fontSize: 10, fontFamily: "'JetBrains Mono', monospace", outline: 'none',
              }}
            />
            {searching && <Loader2 size={10} style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', color: brandColor, animation: 'spin 0.8s linear infinite' }} />}
          </div>
        </div>

        {/* Search results */}
        {searchResults.length > 0 && (
          <div style={{ flex: '0 0 auto', maxHeight: 100, overflow: 'auto', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            {searchResults.map((t, i) => (<SearchResult key={t.id || i} track={t} onAdd={handleAddTrack} />))}
          </div>
        )}

        {/* Now Playing (collapsed when video is showing) */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: hasVideo ? '4px 14px' : '8px 14px', textAlign: 'center', minHeight: hasVideo ? 'auto' : undefined }}>
          {currentTrack ? (
            <>
              {/* Album art - only when no video */}
              {!hasVideo && currentTrack.thumb && (
                <img src={currentTrack.thumb} alt="" style={{ width: 80, height: 60, borderRadius: 'var(--radius-sm)', objectFit: 'cover', margin: '0 auto 8px' }} />
              )}
              {!hasVideo && !currentTrack.thumb && (
                <div style={{ width: 80, height: 60, borderRadius: 'var(--radius-sm)', background: 'rgba(244,162,97,0.06)', margin: '0 auto 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(244,162,97,0.1)' }}>
                  <Music size={20} style={{ color: `${brandColor}60` }} />
                </div>
              )}
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.3, fontFamily: 'var(--font-heading)' }}>{currentTrack.title}</div>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{currentTrack.channel}</div>
              {!hasVideo && <div style={{ fontSize: 9, color: 'var(--text-muted)', marginTop: 2 }}>{fmtTime(currentTime)} / {fmtTime(duration)}</div>}
            </>
          ) : (
            <div style={{ color: 'var(--text-muted)', fontSize: 11, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
              <Music size={18} style={{ opacity: 0.3 }} />
              {activeSource === 'soundcloud' ? (scUser ? `Search as ${scUser.username}` : 'Paste a SoundCloud URL') : 'Search or paste a YouTube URL'}
            </div>
          )}
        </div>

        {/* Progress seek */}
        <div ref={seekRef} onClick={handleSeek} className="no-drag"
          style={{
            height: 3, cursor: 'pointer', flexShrink: 0,
            background: 'rgba(255,255,255,0.06)', margin: '0 14px 2px', borderRadius: 2, position: 'relative',
          }}>
          <div style={{
            height: '100%', borderRadius: 2, width: `${progress}%`,
            background: `linear-gradient(90deg, ${brandColor}, ${brandColor}bb)`,
            transition: isDragging ? 'none' : 'width 0.3s linear',
          }} />
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, padding: '4px 14px 6px', flexShrink: 0 }}>
          <button className="no-drag" onClick={toggleShuffle}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 3, color: shuffle ? brandColor : 'var(--text-muted)', fontFamily: 'inherit', display: 'flex' }}>
            <Shuffle size={12} />
          </button>
          <button className="no-drag" onClick={prev} disabled={queue.length === 0}
            style={{ background: 'transparent', border: 'none', cursor: queue.length > 0 ? 'pointer' : 'default', padding: 4, color: queue.length > 0 ? 'var(--text)' : 'var(--text-muted)', opacity: queue.length > 0 ? 1 : 0.3, fontFamily: 'inherit', display: 'flex' }}>
            <SkipBack size={14} />
          </button>
          <button onClick={() => {
            if (ytPlayerInstance && ytVideoId) {
              if (ytPlaying) ytPlayerInstance.pauseVideo();
              else ytPlayerInstance.playVideo();
            } else if (playerState === 'playing') { pause(); }
            else if (playerState === 'paused') { resume(); }
          }} disabled={queue.length === 0} className="no-drag"
            style={{
              width: 34, height: 34, borderRadius: '50%', border: 'none', cursor: queue.length > 0 ? 'pointer' : 'default',
              background: `linear-gradient(135deg, ${brandColor}, ${brandColor}99)`,
              color: '#0E1A14', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontFamily: 'inherit', opacity: queue.length > 0 ? 1 : 0.4,
            }}>
            {(ytPlaying || playerState === 'playing') ? <Pause size={15} /> : <Play size={15} style={{ marginLeft: 1 }} />}
          </button>
          <button className="no-drag" onClick={next} disabled={queue.length === 0}
            style={{ background: 'transparent', border: 'none', cursor: queue.length > 0 ? 'pointer' : 'default', padding: 4, color: queue.length > 0 ? 'var(--text)' : 'var(--text-muted)', opacity: queue.length > 0 ? 1 : 0.3, fontFamily: 'inherit', display: 'flex' }}>
            <SkipForward size={14} />
          </button>
          <button className="no-drag" onClick={cycleRepeat}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 3, color: repeat !== 'none' ? brandColor : 'var(--text-muted)', fontFamily: 'inherit', display: 'flex', position: 'relative' }}>
            <Repeat size={12} />
            {repeat === 'one' && <span style={{ position: 'absolute', top: -1, right: -1, fontSize: 7, fontWeight: 700 }}>1</span>}
          </button>
        </div>

        {/* Volume + Queue toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 14px 8px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
            <button className="no-drag" onClick={() => setVolume(volume > 0 ? 0 : 0.7)}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'flex', fontFamily: 'inherit' }}>
              {volume === 0 ? <VolumeX size={10} /> : volume < 0.5 ? <Volume1 size={10} /> : <Volume2 size={10} />}
            </button>
            <div ref={volRef} onClick={handleVolume} className="no-drag"
              style={{ flex: 1, height: 3, background: 'rgba(255,255,255,0.08)', borderRadius: 2, cursor: 'pointer', position: 'relative' }}>
              <div style={{ height: '100%', borderRadius: 2, width: `${volume * 100}%`, background: brandColor, transition: 'width 0.1s linear' }} />
            </div>
          </div>
          <button className="no-drag" onClick={() => setShowQueue(!showQueue)}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2, color: showQueue ? brandColor : 'var(--text-muted)', fontFamily: 'inherit', display: 'flex' }}>
            <ListMusic size={11} />
            <span style={{ fontSize: 9, marginLeft: 2 }}>{queue.length}</span>
          </button>
        </div>

        {/* Queue */}
        {showQueue && (
          <div style={{ flex: '0 0 auto', maxHeight: 120, overflow: 'auto', borderTop: '1px solid rgba(255,255,255,0.04)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 10px' }}>
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Queue ({queue.length})</span>
              {queue.length > 0 && (
                <button className="no-drag" onClick={clearQueue}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 9, color: 'var(--text-muted)', fontFamily: 'inherit', padding: '2px 6px', borderRadius: 'var(--radius-sm)' }}>
                  Clear
                </button>
              )}
            </div>
            {queue.map((t, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 4, padding: '3px 10px',
                background: i === currentIndex ? c.surfaceAlt : 'transparent',
                borderLeft: i === currentIndex ? `2px solid ${brandColor}` : '2px solid transparent',
              }}>
                <span style={{ fontSize: 9, color: 'var(--text-muted)', width: 14, textAlign: 'right', flexShrink: 0 }}>{i + 1}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10, fontWeight: i === currentIndex ? 600 : 400, color: i === currentIndex ? brandColor : 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'var(--font-accent)' }}>{t.title}</div>
                </div>
                <button className="no-drag" onClick={() => removeFromQueue(i)}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--text-muted)', fontFamily: 'inherit', display: 'flex', opacity: 0 }}>
                  <X size={9} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Resize handle ───────────────────────────────────────── */}
      <div className="no-drag" onMouseDown={(e) => {
        e.stopPropagation();
        resizeHandlers.onMouseDown(e);
      }}
        style={{
          position: 'absolute', bottom: 0, right: 0, width: 20, height: 20,
          cursor: 'nwse-resize', zIndex: 10, display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end', padding: 2, pointerEvents: 'auto',
        }}>
        <svg width="10" height="10" viewBox="0 0 10 10" style={{ opacity: 0.35 }}>
          <line x1="8" y1="10" x2="10" y2="10" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="10" y1="8" x2="10" y2="10" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" />
          <line x1="4" y1="10" x2="10" y2="10" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
          <line x1="10" y1="4" x2="10" y2="10" stroke="var(--text-muted)" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
        </svg>
      </div>
    </div>
  );
};
