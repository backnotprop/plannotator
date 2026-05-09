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
  syntaxHighlighting?: boolean;
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
    id: 'andromeeda',
    name: 'Andromeeda',
    builtIn: true,
    modeSupport: 'dark-only',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#00e8c6', secondary: '#373941', accent: '#c74ded', background: '#23262e', foreground: '#d5ced9' },
      light: { primary: '#00e8c6', secondary: '#373941', accent: '#c74ded', background: '#23262e', foreground: '#d5ced9' },
    },
  },
  {
    id: 'aurora-x',
    name: 'Aurora X',
    builtIn: true,
    modeSupport: 'dark-only',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#86a5ff', secondary: '#262e47', accent: '#c792ea', background: '#07090f', foreground: '#a8beff' },
      light: { primary: '#86a5ff', secondary: '#262e47', accent: '#c792ea', background: '#07090f', foreground: '#a8beff' },
    },
  },
  {
    id: 'ayu-dark',
    name: 'Ayu Dark',
    builtIn: true,
    modeSupport: 'dark-only',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#e6b450', secondary: '#0b0e14', accent: '#73b8ff', background: '#10141c', foreground: '#bfbdb6' },
      light: { primary: '#e6b450', secondary: '#0b0e14', accent: '#73b8ff', background: '#10141c', foreground: '#bfbdb6' },
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
    syntaxHighlighting: true,
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
    id: 'dark-plus',
    name: 'Dark+',
    builtIn: true,
    modeSupport: 'both',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#007acc', secondary: '#383b3d', accent: '#4ec9b0', background: '#1e1e1e', foreground: '#d4d4d4' },
      light: { primary: '#007acc', secondary: '#e8e8e8', accent: '#267f99', background: '#ffffff', foreground: '#000000' },
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
    syntaxHighlighting: true,
    colors: {
      dark: { primary: 'rgb(189, 147, 249)', secondary: 'rgb(68, 71, 90)', accent: 'rgb(139, 233, 253)', background: 'rgb(40, 42, 54)', foreground: 'rgb(248, 248, 242)' },
      light: { primary: 'rgb(189, 147, 249)', secondary: 'rgb(68, 71, 90)', accent: 'rgb(139, 233, 253)', background: 'rgb(40, 42, 54)', foreground: 'rgb(248, 248, 242)' },
    },
  },
  {
    id: 'everforest',
    name: 'Everforest',
    builtIn: true,
    modeSupport: 'both',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#A7C080', secondary: '#475258', accent: '#83C092', background: '#2D353B', foreground: '#D3C6AA' },
      light: { primary: '#8DA101', secondary: '#E6E2CC', accent: '#35A77C', background: '#FDF6E3', foreground: '#5C6A72' },
    },
  },
  {
    id: 'everforest-hard',
    name: 'Everforest Hard',
    builtIn: true,
    modeSupport: 'both',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#A7C080', secondary: '#414B50', accent: '#83C092', background: '#272E33', foreground: '#D3C6AA' },
      light: { primary: '#8DA101', secondary: '#EDEADA', accent: '#35A77C', background: '#FFFBEF', foreground: '#5C6A72' },
    },
  },
  {
    id: 'everforest-soft',
    name: 'Everforest Soft',
    builtIn: true,
    modeSupport: 'both',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#A7C080', secondary: '#4D5960', accent: '#83C092', background: '#333C43', foreground: '#D3C6AA' },
      light: { primary: '#8DA101', secondary: '#DDD8BE', accent: '#35A77C', background: '#F3EAD3', foreground: '#5C6A72' },
    },
  },
  {
    id: 'github',
    name: 'GitHub',
    builtIn: true,
    modeSupport: 'both',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#58a6ff', secondary: '#2f363d', accent: '#79b8ff', background: '#24292e', foreground: '#e1e4e8' },
      light: { primary: '#0366d6', secondary: '#f6f8fa', accent: '#0366d6', background: '#ffffff', foreground: '#24292e' },
    },
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    builtIn: true,
    modeSupport: 'both',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#458588', secondary: '#504945', accent: '#b8bb26', background: '#282828', foreground: '#ebdbb2' },
      light: { primary: '#076678', secondary: '#d5c4a1', accent: '#79740e', background: '#fbf1c7', foreground: '#3c3836' },
    },
  },
  {
    id: 'houston',
    name: 'Houston',
    builtIn: true,
    modeSupport: 'dark-only',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#4bf3c8', secondary: '#343841', accent: '#54b9ff', background: '#17191e', foreground: '#eef0f9' },
      light: { primary: '#4bf3c8', secondary: '#343841', accent: '#54b9ff', background: '#17191e', foreground: '#eef0f9' },
    },
  },
  {
    id: 'kanagawa-dragon',
    name: 'Kanagawa Dragon',
    builtIn: true,
    modeSupport: 'dark-only',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#7fb4ca', secondary: '#2a2625', accent: '#7aa89f', background: '#181616', foreground: '#c8c093' },
      light: { primary: '#7fb4ca', secondary: '#2a2625', accent: '#7aa89f', background: '#181616', foreground: '#c8c093' },
    },
  },
  {
    id: 'kanagawa-lotus',
    name: 'Kanagawa Lotus',
    builtIn: true,
    modeSupport: 'light-only',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#4d699b', secondary: '#dcd5ac', accent: '#624c83', background: '#f2ecbc', foreground: '#545464' },
      light: { primary: '#4d699b', secondary: '#dcd5ac', accent: '#624c83', background: '#f2ecbc', foreground: '#545464' },
    },
  },
  {
    id: 'kanagawa-wave',
    name: 'Kanagawa Wave',
    builtIn: true,
    modeSupport: 'dark-only',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#7e9cd8', secondary: '#363646', accent: '#957fb8', background: '#1f1f28', foreground: '#dcd7ba' },
      light: { primary: '#7e9cd8', secondary: '#363646', accent: '#957fb8', background: '#1f1f28', foreground: '#dcd7ba' },
    },
  },
  {
    id: 'laserwave',
    name: 'Laserwave',
    builtIn: true,
    modeSupport: 'dark-only',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#eb64b9', secondary: '#3e3549', accent: '#40b4c4', background: '#27212e', foreground: '#ffffff' },
      light: { primary: '#eb64b9', secondary: '#3e3549', accent: '#40b4c4', background: '#27212e', foreground: '#ffffff' },
    },
  },
  {
    id: 'material',
    name: 'Material',
    builtIn: true,
    modeSupport: 'both',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#80CBC4', secondary: '#1e272c', accent: '#C3E88D', background: '#263238', foreground: '#EEFFFF' },
      light: { primary: '#80CBC4', secondary: '#FAFAFA', accent: '#39ADB5', background: '#FAFAFA', foreground: '#90A4AE' },
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
    id: 'min',
    name: 'Min',
    builtIn: true,
    modeSupport: 'both',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#b392f0', secondary: '#2a2a2a', accent: '#79b8ff', background: '#1f1f1f', foreground: '#b392f0' },
      light: { primary: '#6f42c1', secondary: '#eeeeee', accent: '#1976d2', background: '#ffffff', foreground: '#24292e' },
    },
  },
  {
    id: 'monokai-pro',
    name: 'Monokai Pro',
    builtIn: true,
    modeSupport: 'dark-only',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#ffd866', secondary: '#5b595c', accent: '#78dce8', background: '#2d2a2e', foreground: '#fcfcfa' },
      light: { primary: '#ffd866', secondary: '#5b595c', accent: '#78dce8', background: '#2d2a2e', foreground: '#fcfcfa' },
    },
  },
  {
    id: 'night-owl',
    name: 'Night Owl',
    builtIn: true,
    modeSupport: 'dark-only',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#7e57c2', secondary: '#0b253a', accent: '#82aaff', background: '#011627', foreground: '#d6deeb' },
      light: { primary: '#7e57c2', secondary: '#0b253a', accent: '#82aaff', background: '#011627', foreground: '#d6deeb' },
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    builtIn: true,
    modeSupport: 'dark-only',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#88c0d0', secondary: '#434c5e', accent: '#81a1c1', background: '#2e3440', foreground: '#d8dee9' },
      light: { primary: '#88c0d0', secondary: '#434c5e', accent: '#81a1c1', background: '#2e3440', foreground: '#d8dee9' },
    },
  },
  {
    id: 'one-dark-pro',
    name: 'One Dark Pro',
    builtIn: true,
    modeSupport: 'dark-only',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#61afef', secondary: '#21252b', accent: '#c678dd', background: '#282c34', foreground: '#abb2bf' },
      light: { primary: '#61afef', secondary: '#21252b', accent: '#c678dd', background: '#282c34', foreground: '#abb2bf' },
    },
  },
  {
    id: 'one-light',
    name: 'One Light',
    builtIn: true,
    modeSupport: 'light-only',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#526fff', secondary: '#e5e5e6', accent: '#4078f2', background: '#fafafa', foreground: '#383a42' },
      light: { primary: '#526fff', secondary: '#e5e5e6', accent: '#4078f2', background: '#fafafa', foreground: '#383a42' },
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
    id: 'plastic',
    name: 'Plastic',
    builtIn: true,
    modeSupport: 'dark-only',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#1085ff', secondary: '#0d1117', accent: '#61afef', background: '#21252b', foreground: '#a9b2c3' },
      light: { primary: '#1085ff', secondary: '#0d1117', accent: '#61afef', background: '#21252b', foreground: '#a9b2c3' },
    },
  },
  {
    id: 'poimandres',
    name: 'Poimandres',
    builtIn: true,
    modeSupport: 'dark-only',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#add7ff', secondary: '#252934', accent: '#5de4c7', background: '#1b1e28', foreground: '#a6accd' },
      light: { primary: '#add7ff', secondary: '#252934', accent: '#5de4c7', background: '#1b1e28', foreground: '#a6accd' },
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
    id: 'red',
    name: 'Red',
    builtIn: true,
    modeSupport: 'dark-only',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#cc3333', secondary: '#580000', accent: '#ffd0aa', background: '#390000', foreground: '#f8f8f8' },
      light: { primary: '#cc3333', secondary: '#580000', accent: '#ffd0aa', background: '#390000', foreground: '#f8f8f8' },
    },
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    builtIn: true,
    modeSupport: 'both',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#c4a7e7', secondary: '#403d52', accent: '#f6c177', background: '#191724', foreground: '#e0def4' },
      light: { primary: '#907aa9', secondary: '#dfdad9', accent: '#ea9d34', background: '#faf4ed', foreground: '#575279' },
    },
  },
  {
    id: 'slack',
    name: 'Slack',
    builtIn: true,
    modeSupport: 'both',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#0077b5', secondary: '#141414', accent: '#1d978d', background: '#222222', foreground: '#e6e6e6' },
      light: { primary: '#5899c5', secondary: '#eeeeee', accent: '#5899c5', background: '#ffffff', foreground: '#000000' },
    },
  },
  {
    id: 'snazzy-light',
    name: 'Snazzy Light',
    builtIn: true,
    modeSupport: 'light-only',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#09a1ed', secondary: '#e9eaeb', accent: '#2dae58', background: '#fafbfc', foreground: '#565869' },
      light: { primary: '#09a1ed', secondary: '#e9eaeb', accent: '#2dae58', background: '#fafbfc', foreground: '#565869' },
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
    id: 'solarized',
    name: 'Solarized',
    builtIn: true,
    modeSupport: 'both',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#268bd2', secondary: '#073642', accent: '#2aa198', background: '#002b36', foreground: '#839496' },
      light: { primary: '#268bd2', secondary: '#eee8d5', accent: '#2aa198', background: '#fdf6e3', foreground: '#657b83' },
    },
  },
  {
    id: 'synthwave-84',
    name: "Synthwave '84",
    builtIn: true,
    modeSupport: 'dark-only',
    syntaxHighlighting: true,
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
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#7aa2f7', secondary: '#414868', accent: '#7dcfff', background: '#24283b', foreground: '#c0caf5' },
      light: { primary: '#2e7de9', secondary: '#a1a6c5', accent: '#007197', background: '#e1e2e7', foreground: '#3760bf' },
    },
  },
  {
    id: 'vesper',
    name: 'Vesper',
    builtIn: true,
    modeSupport: 'dark-only',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#FFC799', secondary: '#1C1C1C', accent: '#99FFE4', background: '#101010', foreground: '#FFFFFF' },
      light: { primary: '#FFC799', secondary: '#1C1C1C', accent: '#99FFE4', background: '#101010', foreground: '#FFFFFF' },
    },
  },
  {
    id: 'vitesse',
    name: 'Vitesse',
    builtIn: true,
    modeSupport: 'both',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#4d9375', secondary: '#181818', accent: '#e6cc77', background: '#121212', foreground: '#dbd7ca' },
      light: { primary: '#1c6b48', secondary: '#f1f1f1', accent: '#bda437', background: '#ffffff', foreground: '#393a34' },
    },
  },
  {
    id: 'vitesse-black',
    name: 'Vitesse Black',
    builtIn: true,
    modeSupport: 'dark-only',
    syntaxHighlighting: true,
    colors: {
      dark: { primary: '#4d9375', secondary: '#191919', accent: '#6394bf', background: '#000000', foreground: '#dbd7ca' },
      light: { primary: '#4d9375', secondary: '#191919', accent: '#6394bf', background: '#000000', foreground: '#dbd7ca' },
    },
  },
];
