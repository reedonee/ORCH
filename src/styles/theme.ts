// ORCH — theme system with video backgrounds
//
// Every theme has a `name`, `label`, and `video` (relative to /public/).
// The App component switches the <video> source when the theme changes.
// Paths are relative to dist/ (Vite copies public/ content into dist/ on build).

export interface ThemeTokens {
  name: string;
  label: string;
  video: string;
  colors: {
    bg: string;
    bgAlt: string;
    surface: string;
    surfaceAlt: string;
    text: string;
    textSecondary: string;
    textMuted: string;
    accent: string;
    accentDim: string;
    accentGlow: string;
    border: string;
    borderDim: string;
    error: string;
    warning: string;
    success: string;
    info: string;
    brand: string;      // pillbar logo + primary action text
    menuBg: string;     // pillbar dropdown/tooltip background
  };
  fonts: {
    ui: string;         // body text
    heading: string;    // headings
    accent: string;     // accent labels, buttons, terminals
    mono: string;       // code, terminal output
  };
  glass: { bg: string; border: string; blur: string; hover: string; active: string; };
  terminal: {
    bg: string; fg: string; cursor: string; selection: string;
    black: string; red: string; green: string; yellow: string; blue: string; magenta: string; cyan: string; white: string;
    brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string; brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
  };
  shadows: { sm: string; md: string; lg: string; xl: string; glow: string; };
  radius: { sm: string; md: string; lg: string; xl: string; pill: string; };
  spacing: { xs: string; sm: string; md: string; lg: string; xl: string; '2xl': string; };
  animation: { fast: string; normal: string; slow: string; spring: string; };
}

const sharedFonts = {
  ui: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  heading: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  accent: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  mono: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
};

// Eden gets a refined editorial typography system
const edenFonts: typeof sharedFonts = {
  ui: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  heading: "'Cormorant Garamond', Georgia, serif",
  accent: "'Space Grotesk', 'Inter', sans-serif",
  mono: "'JetBrains Mono', 'Cascadia Code', 'Fira Code', monospace",
};

const shared = {
  radius: { sm: '4px', md: '10px', lg: '16px', xl: '24px', pill: '9999px' },
  spacing: { xs: '4px', sm: '8px', md: '16px', lg: '24px', xl: '32px', '2xl': '48px' },
  animation: { fast: '140ms ease', normal: '240ms ease', slow: '420ms ease', spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
};

// ─── Overgrown Transit ──────────────────────────────────────────────
// bg/structure: Deep Forest Shadow (#122018) + Subway Steel Grey (#2C3539)
// glass:        Biophilic Glass (translucent teal #1E3A3A @ 40-60%)
// text:         Sunlit Mist (#EAF4F4)
// accent:       Sun-Drenched Amber (#F4A261)
// secondary:    Bioluminescent Cyan (#4EA8DE)
export const edenTheme: ThemeTokens = {
  name: 'eden',
  label: 'Overgrown Transit',
  video: 'last-train-to-eden.mp4',
  colors: {
    bg: '#0E1A14',
    bgAlt: '#122018',
    surface: 'rgba(30, 58, 58, 0.56)',
    surfaceAlt: 'rgba(30, 58, 58, 0.72)',
    text: '#EAF4F4',
    textSecondary: '#B7C9C9',
    textMuted: '#7A8E8E',
    accent: '#F4A261',
    accentDim: '#C97E3F',
    accentGlow: 'rgba(244, 162, 97, 0.32)',
    border: 'rgba(234, 244, 244, 0.10)',
    borderDim: 'rgba(234, 244, 244, 0.05)',
    error: '#E76F51',
    warning: '#F4A261',
    success: '#4EA8DE',
    info: '#4EA8DE',
    brand: '#ff781f',          // warm amber — logo + primary action
    menuBg: 'rgba(30, 58, 58, 0.72)',  // deep teal dropdown
  },
  glass: {
    bg: 'rgba(30, 58, 58, 0.30)',
    border: 'rgba(234, 244, 244, 0.10)',
    blur: 'none',
    hover: 'rgba(30, 58, 58, 0.45)',
    active: 'rgba(30, 58, 58, 0.60)',
  },
  fonts: edenFonts,
  terminal: {
    bg: '#0E1A14', fg: '#EAF4F4', cursor: '#F4A261', selection: 'rgba(244, 162, 97, 0.28)',
    black: '#122018', red: '#E76F51', green: '#6BBF8A', yellow: '#F4C97A',
    blue: '#4EA8DE', magenta: '#B48BC9', cyan: '#7BC9C9', white: '#EAF4F4',
    brightBlack: '#5C6E66', brightRed: '#F0907A', brightGreen: '#8AD8A4',
    brightYellow: '#F8DBA0', brightBlue: '#7BC1E6', brightMagenta: '#CDA8DC',
    brightCyan: '#A5E0E0', brightWhite: '#FFFFFF',
  },
  shadows: {
    sm: '0 4px 12px rgba(0, 0, 0, 0.32)', md: '0 10px 30px rgba(0, 0, 0, 0.40)',
    lg: '0 24px 60px rgba(0, 0, 0, 0.50)', xl: '0 40px 90px rgba(0, 0, 0, 0.60)',
    glow: '0 0 30px rgba(244, 162, 97, 0.30), 0 0 60px rgba(78, 168, 222, 0.10)',
  },
  ...shared,
};

// ─── Twilight Horizon ──────────────────────────────────────────────
// Background: open ocean sunset — deep purple/plum sky, coral horizon
// glass:      Orchid Mist (#F5E6ED @ 50%) → pinkish twilight glow inside panels
// text:       Sunset Glow (#FFF2E6) on Deep Pier Espresso (#1C1326)
// accent:     Vibrant Coral (#E76F51) — cuts through the cool plums
// secondary:  Twilight Fuchsia (#A84A74) — badges, toggles
export const twilightTheme: ThemeTokens = {
  name: 'twilight',
  label: 'Twilight Horizon',
  video: 'Twilight Horizon.mp4',
  colors: {
    bg: '#1C1326',            // Deep Pier Espresso — canvas bg
    bgAlt: '#2A1D38',         // slightly lifted for sidebar
    surface: 'rgba(245, 230, 237, 0.08)', // Orchid Mist at ~8% on dark
    surfaceAlt: 'rgba(245, 230, 237, 0.14)',
    text: '#FFF2E6',          // Sunset Glow — warm off-white
    textSecondary: '#D4C7D6',  // muted orchid-gray
    textMuted: '#8E7C9A',     // dusk-like muted
    accent: '#B48BC9',        // Orchid Purple — soft ethereal CTA
    accentDim: '#8B6FA8',
    accentGlow: 'rgba(180, 139, 201, 0.30)',
    border: 'rgba(245, 230, 237, 0.12)',
    borderDim: 'rgba(245, 230, 237, 0.05)',
    error: '#E0406B',         // rose — warm contrast to purple accent
    warning: '#F4C97A',       // pale amber
    success: '#7BC9C9',       // teal — from eden, works here too
    info: '#A84A74',          // Twilight Fuchsia
    brand: '#d44fe0',          // vibrant magenta — logo + primary action
    menuBg: 'rgba(168, 74, 116, 0.60)',  // glass fuchsia dropdown
  },
  glass: {
    bg: 'rgba(245, 230, 237, 0.10)',  // Orchid Mist — 10% tint
    border: 'rgba(245, 230, 237, 0.14)',
    blur: '24px',
    hover: 'rgba(245, 230, 237, 0.18)',
    active: 'rgba(245, 230, 237, 0.25)',
  },
  fonts: sharedFonts,
  terminal: {
    bg: '#1C1326', fg: '#FFF2E6', cursor: '#B48BC9', selection: 'rgba(180, 139, 201, 0.30)',
    black: '#1C1326', red: '#E76F51', green: '#6BBF8A', yellow: '#F4C97A',
    blue: '#7BC9C9', magenta: '#A84A74', cyan: '#4EA8DE', white: '#FFF2E6',
    brightBlack: '#3D2E4D', brightRed: '#F0907A', brightGreen: '#8AD8A4',
    brightYellow: '#F8DBA0', brightBlue: '#A5E0E0', brightMagenta: '#C97AA0',
    brightCyan: '#7BC1E6', brightWhite: '#FFFFFF',
  },
  shadows: {
    sm: '0 4px 12px rgba(0, 0, 0, 0.40)', md: '0 10px 30px rgba(0, 0, 0, 0.50)',
    lg: '0 24px 60px rgba(0, 0, 0, 0.55)', xl: '0 40px 90px rgba(0, 0, 0, 0.65)',
    glow: '0 0 30px rgba(180, 139, 201, 0.25), 0 0 60px rgba(168, 74, 116, 0.12)',
  },
  ...shared,
};

// ─── Crimson Age ────────────────────────────────────────────────
// An aggressive, cybernetic theme drawing from velvet shadows, deep
// obsidian metallic textures, and a piercing, glowing crimson heart.
export const crimsonTheme: ThemeTokens = {
  name: 'crimson',
  label: 'Crimson Age',
  video: 'crimson.jpg',
  colors: {
    bg: '#050304',
    bgAlt: '#12080a',
    surface: 'rgba(18, 8, 10, 0.5)',
    surfaceAlt: 'rgba(34, 12, 16, 0.75)',
    text: '#F5EBEF',
    textSecondary: '#A69298',
    textMuted: '#5C4E52',
    accent: '#E62E43',
    accentDim: '#991B29',
    accentGlow: 'rgba(230, 46, 67, 0.25)',
    border: 'rgba(230, 46, 67, 0.15)',
    borderDim: 'rgba(255, 255, 255, 0.05)',
    error: '#FF4D4D',
    warning: '#FFAA00',
    success: '#00E676',
    info: '#00B0FF',
    brand: '#E62E43',
    menuBg: 'rgba(10, 4, 5, 0.92)',
  },
  glass: {
    bg: 'rgba(18, 8, 10, 0.45)',
    border: 'rgba(230, 46, 67, 0.20)',
    blur: '24px',
    hover: 'rgba(230, 46, 67, 0.08)',
    active: 'rgba(230, 46, 67, 0.15)',
  },
  fonts: sharedFonts,
  terminal: {
    bg: '#0B0506', fg: '#F5EBEF', cursor: '#E62E43', selection: 'rgba(230, 46, 67, 0.3)',
    black: '#1C1214', red: '#C62828', green: '#2E7D32', yellow: '#EF6C00',
    blue: '#1565C0', magenta: '#6A1B9A', cyan: '#00838F', white: '#A69298',
    brightBlack: '#423739', brightRed: '#E62E43', brightGreen: '#4CAF50',
    brightYellow: '#FFB74D', brightBlue: '#64B5F6', brightMagenta: '#BA68C8',
    brightCyan: '#4DD0E1', brightWhite: '#FFFFFF',
  },
  shadows: {
    sm: '0 4px 12px rgba(0, 0, 0, 0.6)',
    md: '0 10px 30px rgba(0, 0, 0, 0.8)',
    lg: '0 24px 60px rgba(0, 0, 0, 0.9)',
    xl: '0 40px 90px rgba(0, 0, 0, 0.95)',
    glow: '0 0 30px rgba(230, 46, 67, 0.35), 0 0 60px rgba(230, 46, 67, 0.15)',
  },
  ...shared,
};

export const themes = { eden: edenTheme, twilight: twilightTheme, crimson: crimsonTheme } as const;
export type ThemeName = keyof typeof themes;
