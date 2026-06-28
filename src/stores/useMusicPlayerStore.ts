import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface Track {
  id: string;
  title: string;
  duration: number; // seconds
  thumb: string;
  channel: string;
  url: string;
  source: 'youtube' | 'soundcloud';
}

export type PlayerState = 'idle' | 'loading' | 'playing' | 'paused' | 'error';

interface MusicState {
  queue: Track[];
  currentIndex: number;
  playerState: PlayerState;
  currentTime: number;
  duration: number;
  volume: number;
  shuffle: boolean;
  repeat: 'none' | 'one' | 'all';
  visible: boolean;
  searchQuery: string;
  searchResults: Track[];
  activeSource: 'youtube' | 'soundcloud';
  // Position & size for draggable/resizable panel
  x: number;
  y: number;
  width: number;
  height: number;
  // SoundCloud auth
  scToken: string;
  scUser: { id: string; username: string; avatar: string } | null;

  // Actions
  play: (track: Track) => void;
  playUrl: (url: string, title?: string) => void;
  playPlaylist: (tracks: Track[], startIndex?: number) => void;
  addToQueue: (track: Track) => void;
  removeFromQueue: (index: number) => void;
  reorderQueue: (from: number, to: number) => void;
  clearQueue: () => void;
  next: () => void;
  prev: () => void;
  pause: () => void;
  resume: () => void;
  seek: (time: number) => void;
  setVolume: (v: number) => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setSearchQuery: (q: string) => void;
  setSearchResults: (results: Track[]) => void;
  setVisible: (v: boolean) => void;
  toggleVisible: () => void;
  setPlayerState: (s: PlayerState) => void;
  setCurrentTime: (t: number) => void;
  setDuration: (d: number) => void;
  setActiveSource: (source: 'youtube' | 'soundcloud') => void;
  setPosition: (x: number, y: number) => void;
  setSize: (width: number, height: number) => void;
  // SoundCloud
  setScToken: (token: string) => void;
  setScUser: (user: { id: string; username: string; avatar: string } | null) => void;
  clearScAuth: () => void;
}

export const useMusicPlayerStore = create<MusicState>()(
  persist(
    (set, get) => ({
      queue: [],
      currentIndex: -1,
      playerState: 'idle',
      currentTime: 0,
      duration: 0,
      volume: 0.7,
      shuffle: false,
      repeat: 'none',
      visible: false,
      searchQuery: '',
      searchResults: [],
      activeSource: 'youtube',
      x: 60,
      y: 80,
      width: 420,
      height: 560,
      scToken: '',
      scUser: null,

      play: (track) => {
        const state = get();
        const existingIdx = state.queue.findIndex((t) => t.id === track.id);
        if (existingIdx >= 0) {
          set({ currentIndex: existingIdx, playerState: 'loading' });
        } else {
          set({
            queue: [...state.queue, track],
            currentIndex: state.queue.length,
            playerState: 'loading',
          });
        }
      },

      playUrl: (url, title) => {
        const track: Track = {
          id: url,
          title: title || url,
          duration: 0,
          thumb: '',
          channel: '',
          url,
          source: url.includes('soundcloud') ? 'soundcloud' : 'youtube',
        };
        get().play(track);
      },

      playPlaylist: (tracks, startIndex = 0) => {
        set({
          queue: tracks,
          currentIndex: Math.min(startIndex, tracks.length - 1),
          playerState: 'loading',
        });
      },

      addToQueue: (track) => {
        set((state) => ({ queue: [...state.queue, track] }));
      },

      removeFromQueue: (index) => {
        set((state) => {
          const queue = state.queue.filter((_, i) => i !== index);
          let ci = state.currentIndex;
          if (index < ci) ci--;
          else if (index === ci) ci = Math.min(ci, queue.length - 1);
          return { queue, currentIndex: ci };
        });
      },

      reorderQueue: (from, to) => {
        set((state) => {
          const queue = [...state.queue];
          const [moved] = queue.splice(from, 1);
          queue.splice(to, 0, moved);
          let ci = state.currentIndex;
          if (from === ci) ci = to;
          else if (from < ci && to >= ci) ci--;
          else if (from > ci && to <= ci) ci++;
          return { queue, currentIndex: ci };
        });
      },

      clearQueue: () => set({ queue: [], currentIndex: -1, playerState: 'idle' }),

      next: () => {
        const { queue, currentIndex, shuffle, repeat } = get();
        if (queue.length === 0) return;
        if (repeat === 'one') {
          set({ playerState: 'loading' });
          return;
        }
        let next: number;
        if (shuffle) {
          next = Math.floor(Math.random() * queue.length);
        } else {
          next = currentIndex + 1;
          if (next >= queue.length) {
            if (repeat === 'all') next = 0;
            else { set({ playerState: 'idle' }); return; }
          }
        }
        set({ currentIndex: next, playerState: 'loading' });
      },

      prev: () => {
        const { currentIndex, queue } = get();
        if (queue.length === 0) return;
        const prev = currentIndex > 0 ? currentIndex - 1 : queue.length - 1;
        set({ currentIndex: prev, playerState: 'loading' });
      },

      pause: () => set({ playerState: 'paused' }),
      resume: () => set({ playerState: 'playing' }),
      seek: (time) => set({ currentTime: time }),
      setVolume: (v) => set({ volume: Math.max(0, Math.min(1, v)) }),
      toggleShuffle: () => set((s) => ({ shuffle: !s.shuffle })),
      cycleRepeat: () =>
        set((s) => ({
          repeat: s.repeat === 'none' ? 'all' : s.repeat === 'all' ? 'one' : 'none',
        })),
      setSearchQuery: (q) => set({ searchQuery: q }),
      setSearchResults: (results) => set({ searchResults: results }),
      setVisible: (v) => set({ visible: v }),
      toggleVisible: () => set((s) => ({ visible: !s.visible })),
      setPlayerState: (s) => set({ playerState: s }),
      setCurrentTime: (t) => set({ currentTime: t }),
      setDuration: (d) => set({ duration: d }),
      setActiveSource: (source) => set({ activeSource: source }),
      setPosition: (x, y) => set({ x, y }),
      setSize: (width, height) => set({ width, height }),
      setScToken: (token) => set({ scToken: token }),
      setScUser: (user) => set({ scUser: user }),
      clearScAuth: () => set({ scToken: '', scUser: null }),
    }),
    {
      name: 'orch-music-player',
      partialize: (state) => ({
        volume: state.volume,
        shuffle: state.shuffle,
        repeat: state.repeat,
        scToken: state.scToken,
        scUser: state.scUser,
      }),
    }
  )
);
