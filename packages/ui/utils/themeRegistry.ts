export interface ThemeColors {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  foreground: string;
}

export interface ThemeInfo {
  id: string;
  name: string;
  builtIn: boolean;
  modeSupport: 'both' | 'dark-only' | 'light-only';
  colors: {
    dark: ThemeColors;
    light: ThemeColors;
  };
}

export const BUILT_IN_THEMES: ThemeInfo[] = [
  {
    id: 'plannotator',
    name: 'Plannotator',
    builtIn: true,
    modeSupport: 'both',
    colors: {
      dark: { primary: 'oklch(0.75 0.18 280)', secondary: 'oklch(0.65 0.15 180)', accent: 'oklch(0.70 0.20 60)', background: 'oklch(0.15 0.02 260)', foreground: 'oklch(0.90 0.01 260)' },
      light: { primary: 'oklch(0.50 0.25 280)', secondary: 'oklch(0.50 0.18 180)', accent: 'oklch(0.60 0.22 50)', background: 'oklch(0.97 0.005 260)', foreground: 'oklch(0.18 0.02 260)' },
    },
  },
  {
    id: 'claude-plus',
    name: 'Absolutely',
    builtIn: true,
    modeSupport: 'both',
    colors: {
      dark: { primary: 'oklch(0.6724 0.1308 38.7559)', secondary: 'oklch(0.9818 0.0054 95.0986)', accent: 'oklch(0.6724 0.1308 38.7559)', background: 'oklch(0.2679 0.0036 106.6427)', foreground: 'oklch(0.9576 0.0027 106.4494)' },
      light: { primary: 'oklch(0.6171 0.1375 39.0427)', secondary: 'oklch(0.9245 0.0138 92.9892)', accent: 'oklch(0.6171 0.1375 39.0427)', background: 'oklch(0.9818 0.0054 95.0986)', foreground: 'oklch(0.3438 0.0269 95.7226)' },
    },
  },
  {
    id: 'adwaita',
    name: 'Adwaita',
    builtIn: true,
    modeSupport: 'both',
    colors: {
      dark: { primary: '#3584E4', secondary: '#3a3a3a', accent: '#26a269', background: '#1d1d1d', foreground: '#cccccc' },
      light: { primary: '#3584E4', secondary: '#e6e6e6', accent: '#26a269', background: '#fafafa', foreground: '#323232' },
    },
  },
  {
    id: 'caffeine',
    name: 'Caffeine',
    builtIn: true,
    modeSupport: 'both',
    colors: {
      dark: { primary: 'rgb(193, 154, 107)', secondary: 'rgb(62, 47, 36)', accent: 'rgb(139, 90, 43)', background: 'rgb(30, 22, 16)', foreground: 'rgb(230, 220, 205)' },
      light: { primary: 'rgb(139, 90, 43)', secondary: 'rgb(232, 222, 210)', accent: 'rgb(193, 154, 107)', background: 'rgb(250, 245, 238)', foreground: 'rgb(40, 30, 20)' },
    },
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin',
    builtIn: true,
    modeSupport: 'both',
    colors: {
      dark: { primary: '#89b4fa', secondary: '#45475a', accent: '#f5c2e7', background: '#1e1e2e', foreground: '#cdd6f4' },
      light: { primary: '#1e66f5', secondary: '#ccd0da', accent: '#ea76cb', background: '#eff1f5', foreground: '#4c4f69' },
    },
  },
  {
    id: 'cursor-hc',
    name: 'Clean Contrast',
    builtIn: true,
    modeSupport: 'dark-only',
    colors: {
      dark: { primary: '#88C0D0', secondary: '#434C5E', accent: '#EBCB8B', background: '#0A0A0A', foreground: '#D8DEE9' },
      light: { primary: '#88C0D0', secondary: '#434C5E', accent: '#EBCB8B', background: '#0A0A0A', foreground: '#D8DEE9' },
    },
  },
  {
    id: 'cursor',
    name: 'Code Fork',
    builtIn: true,
    modeSupport: 'both',
    colors: {
      dark: { primary: '#81A1C1', secondary: '#2a2a2a', accent: '#88C0D0', background: '#181818', foreground: '#E4E4E4' },
      light: { primary: '#3C7CAB', secondary: '#E8E8E8', accent: '#4C7F8C', background: '#FCFCFC', foreground: '#141414' },
    },
  },
  {
    id: 'doom-64',
    name: 'Doom 64',
    builtIn: true,
    modeSupport: 'both',
    colors: {
      dark: { primary: 'rgb(200, 30, 30)', secondary: 'rgb(40, 35, 30)', accent: 'rgb(255, 160, 0)', background: 'rgb(15, 12, 10)', foreground: 'rgb(220, 210, 190)' },
      light: { primary: 'rgb(180, 20, 20)', secondary: 'rgb(230, 225, 215)', accent: 'rgb(200, 120, 0)', background: 'rgb(248, 244, 238)', foreground: 'rgb(25, 20, 15)' },
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    builtIn: true,
    modeSupport: 'dark-only',
    colors: {
      dark: { primary: 'rgb(189, 147, 249)', secondary: 'rgb(68, 71, 90)', accent: 'rgb(139, 233, 253)', background: 'rgb(40, 42, 54)', foreground: 'rgb(248, 248, 242)' },
      light: { primary: 'rgb(189, 147, 249)', secondary: 'rgb(68, 71, 90)', accent: 'rgb(139, 233, 253)', background: 'rgb(40, 42, 54)', foreground: 'rgb(248, 248, 242)' },
    },
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    builtIn: true,
    modeSupport: 'both',
    colors: {
      dark: { primary: '#458588', secondary: '#504945', accent: '#b8bb26', background: '#282828', foreground: '#ebdbb2' },
      light: { primary: '#076678', secondary: '#d5c4a1', accent: '#79740e', background: '#fbf1c7', foreground: '#3c3836' },
    },
  },
  {
    id: 'monokai-pro',
    name: 'Monokai Pro',
    builtIn: true,
    modeSupport: 'dark-only',
    colors: {
      dark: { primary: '#ffd866', secondary: '#5b595c', accent: '#78dce8', background: '#2d2a2e', foreground: '#fcfcfa' },
      light: { primary: '#ffd866', secondary: '#5b595c', accent: '#78dce8', background: '#2d2a2e', foreground: '#fcfcfa' },
    },
  },
  {
    id: 'cursor-midnight',
    name: 'Midnight',
    builtIn: true,
    modeSupport: 'dark-only',
    colors: {
      dark: { primary: '#88C0D0', secondary: '#434C5E', accent: '#8FBCBB', background: '#1e2127', foreground: '#D8DEE9' },
      light: { primary: '#88C0D0', secondary: '#434C5E', accent: '#8FBCBB', background: '#1e2127', foreground: '#D8DEE9' },
    },
  },
  {
    id: 'paulmillr',
    name: 'PaulMillr',
    builtIn: true,
    modeSupport: 'dark-only',
    colors: {
      dark: { primary: '#396bd7', secondary: '#414141', accent: '#66ccff', background: '#000000', foreground: '#f2f2f2' },
      light: { primary: '#396bd7', secondary: '#414141', accent: '#66ccff', background: '#000000', foreground: '#f2f2f2' },
    },
  },
  {
    id: 'quantum-rose',
    name: 'Quantum Rose',
    builtIn: true,
    modeSupport: 'both',
    colors: {
      dark: { primary: 'rgb(255, 100, 130)', secondary: 'rgb(40, 30, 35)', accent: '#c06ec4', background: 'rgb(18, 12, 15)', foreground: 'rgb(240, 230, 235)' },
      light: { primary: 'rgb(200, 50, 80)', secondary: 'rgb(240, 230, 235)', accent: '#ffc1e3', background: 'rgb(252, 248, 250)', foreground: 'rgb(25, 15, 20)' },
    },
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    builtIn: true,
    modeSupport: 'both',
    colors: {
      dark: { primary: '#c4a7e7', secondary: '#403d52', accent: '#f6c177', background: '#191724', foreground: '#e0def4' },
      light: { primary: '#907aa9', secondary: '#dfdad9', accent: '#ea9d34', background: '#faf4ed', foreground: '#575279' },
    },
  },
  {
    id: 'soft-pop',
    name: 'Soft Pop',
    builtIn: true,
    modeSupport: 'both',
    colors: {
      dark: { primary: 'oklch(0.6801 0.1583 276.9349)', secondary: 'oklch(0.7845 0.1325 181.9120)', accent: 'oklch(0.8790 0.1534 91.6054)', background: 'oklch(0 0 0)', foreground: 'oklch(1.0000 0 0)' },
      light: { primary: 'oklch(0.5106 0.2301 276.9656)', secondary: 'oklch(0.7038 0.1230 182.5025)', accent: 'oklch(0.7686 0.1647 70.0804)', background: 'oklch(0.9789 0.0082 121.6272)', foreground: 'oklch(0 0 0)' },
    },
  },
  {
    id: 'solar-dusk',
    name: 'Solar Dusk',
    builtIn: true,
    modeSupport: 'both',
    colors: {
      dark: { primary: 'oklch(0.7049 0.1867 47.6044)', secondary: 'oklch(0.3127 0.039 49.5996)', accent: 'oklch(0.6 0.12 229.3202)', background: 'oklch(0.2183 0.0268 49.7085)', foreground: 'oklch(0.8994 0.0347 70.7236)' },
      light: { primary: 'oklch(0.5553 0.1455 48.9975)', secondary: 'oklch(0.9139 0.0359 77.3089)', accent: 'oklch(0.55 0.12 229)', background: 'oklch(0.9685 0.0187 84.078)', foreground: 'oklch(0.366 0.0251 49.6085)' },
    },
  },
  {
    id: 'synthwave-84',
    name: 'Synthwave \'84',
    builtIn: true,
    modeSupport: 'dark-only',
    colors: {
      dark: { primary: '#ff7edb', secondary: '#34294f', accent: '#72f1b8', background: '#262335', foreground: '#ffffff' },
      light: { primary: '#ff7edb', secondary: '#34294f', accent: '#72f1b8', background: '#262335', foreground: '#ffffff' },
    },
  },
  {
    id: 'terminal',
    name: 'Terminal',
    builtIn: true,
    modeSupport: 'dark-only',
    colors: {
      dark: { primary: 'rgb(0, 255, 0)', secondary: 'rgb(20, 20, 20)', accent: 'rgb(0, 200, 200)', background: 'rgb(0, 0, 0)', foreground: 'rgb(0, 255, 0)' },
      light: { primary: 'rgb(0, 255, 0)', secondary: 'rgb(20, 20, 20)', accent: 'rgb(0, 200, 200)', background: 'rgb(0, 0, 0)', foreground: 'rgb(0, 255, 0)' },
    },
  },
  {
    id: 'tinacious',
    name: 'Tinacious',
    builtIn: true,
    modeSupport: 'light-only',
    colors: {
      dark: { primary: 'rgb(214, 95, 149)', secondary: 'rgb(50, 50, 60)', accent: 'rgb(119, 220, 194)', background: 'rgb(28, 28, 36)', foreground: 'rgb(230, 230, 240)' },
      light: { primary: 'rgb(214, 95, 149)', secondary: 'rgb(232, 232, 237)', accent: 'rgb(119, 220, 194)', background: 'rgb(247, 247, 250)', foreground: 'rgb(28, 28, 36)' },
    },
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    builtIn: true,
    modeSupport: 'both',
    colors: {
      dark: { primary: '#7aa2f7', secondary: '#414868', accent: '#7dcfff', background: '#24283b', foreground: '#c0caf5' },
      light: { primary: '#2e7de9', secondary: '#a1a6c5', accent: '#007197', background: '#e1e2e7', foreground: '#3760bf' },
    },
  },
];
