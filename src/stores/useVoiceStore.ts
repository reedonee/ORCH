import { create } from 'zustand';

export type VoiceStatus = 'idle' | 'listening' | 'transcribing' | 'processing' | 'speaking';

interface VoiceState {
  status: VoiceStatus;
  heard: string | null;
  setStatus: (s: VoiceStatus) => void;
  setHeard: (text: string | null) => void;
}

export const useVoiceStore = create<VoiceState>((set) => ({
  status: 'idle',
  heard: null,
  setStatus: (status) => set({ status }),
  setHeard: (heard) => set({ heard }),
}));
