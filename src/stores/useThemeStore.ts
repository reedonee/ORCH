import { create } from 'zustand';
import { edenTheme, themes, type ThemeTokens, type ThemeName } from '../styles/theme';

interface ThemeState {
  theme: ThemeTokens;
  themeName: ThemeName;
  setTheme: (name: ThemeName) => void;
}

export const useThemeStore = create<ThemeState>()((set) => ({
  theme: edenTheme,
  themeName: 'eden',
  setTheme: (name: ThemeName) => {
    const t = themes[name];
    if (t) set({ theme: t, themeName: name });
  },
}));
