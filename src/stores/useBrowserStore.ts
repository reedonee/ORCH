import { create } from 'zustand';

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface BrowserState {
  tabs: BrowserTab[];
  activeTabId: string | null;
  visible: boolean;
  // Position & size for draggable/resizable panel
  x: number;
  y: number;
  width: number;
  height: number;
  // Actions
  openBrowser: (url?: string) => void;
  closeBrowser: (id: string) => void;
  setVisible: (v: boolean) => void;
  toggleVisible: () => void;
  navigateTo: (id: string, url: string) => void;
  updateTab: (id: string, updates: Partial<BrowserTab>) => void;
  removeTab: (id: string) => void;
  setActiveTab: (id: string | null) => void;
  setPosition: (x: number, y: number) => void;
  setSize: (w: number, h: number) => void;
}

export const useBrowserStore = create<BrowserState>((set) => ({
  tabs: [],
  activeTabId: null,
  visible: false,
  x: 60,
  y: 80,
  width: 920,
  height: 540,

  openBrowser: (url?: string) => {
    const id = crypto.randomUUID();
    const tab: BrowserTab = {
      id,
      url: url || 'https://www.google.com',
      title: url || 'New Tab',
      isLoading: true,
      canGoBack: false,
      canGoForward: false,
    };
    set((state) => ({
      tabs: [...state.tabs, tab],
      activeTabId: state.activeTabId || id,
      visible: true,
    }));
  },

  closeBrowser: (id: string) => {
    set((state) => {
      const tabs = state.tabs.filter((t) => t.id !== id);
      const activeTabId = state.activeTabId === id
        ? (tabs.length > 0 ? tabs[tabs.length - 1].id : null)
        : state.activeTabId;
      return { tabs, activeTabId, visible: tabs.length > 0 ? state.visible : false };
    });
  },

  setVisible: (v) => set({ visible: v }),
  toggleVisible: () => set((s) => ({ visible: !s.visible })),

  navigateTo: (id, url) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === id ? { ...t, url, title: url || 'New Tab', isLoading: true } : t
      ),
    }));
  },

  updateTab: (id, updates) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    }));
  },

  removeTab: (id) => {
    set((state) => ({
      tabs: state.tabs.filter((t) => t.id !== id),
      activeTabId: state.activeTabId === id ? null : state.activeTabId,
    }));
  },

  setActiveTab: (id) => set({ activeTabId: id }),
  setPosition: (x, y) => set({ x, y }),
  setSize: (width, height) => set({ width, height }),
}));
