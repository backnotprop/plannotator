import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTheme } from "@plannotator/ui/components/ThemeProvider";
import { BUILT_IN_THEMES } from "@plannotator/ui/utils/themeRegistry";
import type { CreateAgentTerminalSessionOptions } from "@plannotator/webtui/browser";

type TerminalOptions = NonNullable<CreateAgentTerminalSessionOptions["terminalOptions"]>;
export type AnnotateAgentTerminalTheme = NonNullable<TerminalOptions["theme"]>;

export type AnnotateAgentTerminalShellStyle = CSSProperties & {
  "--webtui-background": string;
  "--webtui-foreground": string;
  "--webtui-border": string;
};

export interface AnnotateAgentTerminalThemeState {
  theme: AnnotateAgentTerminalTheme;
  terminalOptions: TerminalOptions;
  colorScheme: "dark" | "light";
  shellStyle: AnnotateAgentTerminalShellStyle;
}

type TerminalThemeMode = "dark" | "light";

type ResolvedTerminalPalette = {
  background: string;
  foreground: string;
  card: string;
  muted: string;
  mutedForeground: string;
  border: string;
  primary: string;
  secondary: string;
  accent: string;
  destructive: string;
  success: string;
  warning: string;
  focus: string;
  fontMono: string;
  terminalTheme?: AnnotateAgentTerminalTheme;
};

type ResolvedTerminalPaletteColorKey = Exclude<keyof ResolvedTerminalPalette, "terminalTheme">;

const FALLBACK_MONO_FONT =
  '"SF Mono", "Menlo", "Monaco", "Cascadia Mono", "Consolas", ui-monospace, monospace';

const PLANNOTATOR_DARK_TERMINAL_THEME: AnnotateAgentTerminalTheme = {
  background: "#11131d",
  foreground: "#e8e6f0",
  cursor: "#c084fc",
  cursorAccent: "#11131d",
  selectionBackground: "#4c1d95",
  selectionForeground: "#fbf7ff",
  selectionInactiveBackground: "#2e3142",
  black: "#11131d",
  red: "#ff6b7a",
  green: "#5ee09d",
  yellow: "#f5c451",
  blue: "#9f8cff",
  magenta: "#d78cff",
  cyan: "#47d5c8",
  white: "#d9d7e5",
  brightBlack: "#6f7387",
  brightRed: "#ff8a95",
  brightGreen: "#7ef0b6",
  brightYellow: "#ffd979",
  brightBlue: "#b8a7ff",
  brightMagenta: "#e5b2ff",
  brightCyan: "#73eadf",
  brightWhite: "#fbf7ff",
};

const PLANNOTATOR_LIGHT_TERMINAL_THEME: AnnotateAgentTerminalTheme = {
  background: "#f6f5fb",
  foreground: "#29263a",
  cursor: "#7c3aed",
  cursorAccent: "#f6f5fb",
  selectionBackground: "#ddd6fe",
  selectionForeground: "#25133f",
  selectionInactiveBackground: "#e5e1ef",
  black: "#29263a",
  red: "#c02635",
  green: "#15803d",
  yellow: "#a16207",
  blue: "#6d28d9",
  magenta: "#a21caf",
  cyan: "#0f766e",
  white: "#f6f5fb",
  brightBlack: "#706b81",
  brightRed: "#e11d48",
  brightGreen: "#16a34a",
  brightYellow: "#ca8a04",
  brightBlue: "#7c3aed",
  brightMagenta: "#c026d3",
  brightCyan: "#0d9488",
  brightWhite: "#ffffff",
};

// Browser sessions read Plannotator's live CSS variables. These presets are only
// fallback data for non-DOM startup paths where computed CSS is unavailable.
const TERMINAL_THEME_PRESETS: Record<string, Partial<Record<TerminalThemeMode, AnnotateAgentTerminalTheme>>> = {
  plannotator: {
    dark: PLANNOTATOR_DARK_TERMINAL_THEME,
    light: PLANNOTATOR_LIGHT_TERMINAL_THEME,
  },
  catppuccin: {
    dark: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      cursorAccent: "#1e1e2e",
      selectionBackground: "#585b70",
      selectionForeground: "#cdd6f4",
      selectionInactiveBackground: "#45475a",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
      brightBlack: "#585b70",
      brightRed: "#f38ba8",
      brightGreen: "#a6e3a1",
      brightYellow: "#f9e2af",
      brightBlue: "#89b4fa",
      brightMagenta: "#f5c2e7",
      brightCyan: "#94e2d5",
      brightWhite: "#a6adc8",
    },
    light: {
      background: "#eff1f5",
      foreground: "#4c4f69",
      cursor: "#dc8a78",
      cursorAccent: "#eff1f5",
      selectionBackground: "#bcc0cc",
      selectionForeground: "#4c4f69",
      selectionInactiveBackground: "#ccd0da",
      black: "#5c5f77",
      red: "#d20f39",
      green: "#40a02b",
      yellow: "#df8e1d",
      blue: "#1e66f5",
      magenta: "#ea76cb",
      cyan: "#179299",
      white: "#acb0be",
      brightBlack: "#6c6f85",
      brightRed: "#d20f39",
      brightGreen: "#40a02b",
      brightYellow: "#df8e1d",
      brightBlue: "#1e66f5",
      brightMagenta: "#ea76cb",
      brightCyan: "#179299",
      brightWhite: "#bcc0cc",
    },
  },
  dracula: {
    dark: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      cursorAccent: "#282a36",
      selectionBackground: "#44475a",
      selectionForeground: "#f8f8f2",
      selectionInactiveBackground: "#383a48",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
      brightBlack: "#6272a4",
      brightRed: "#ff6e6e",
      brightGreen: "#69ff94",
      brightYellow: "#ffffa5",
      brightBlue: "#d6acff",
      brightMagenta: "#ff92df",
      brightCyan: "#a4ffff",
      brightWhite: "#ffffff",
    },
  },
  gruvbox: {
    dark: {
      background: "#282828",
      foreground: "#ebdbb2",
      cursor: "#ebdbb2",
      cursorAccent: "#282828",
      selectionBackground: "#504945",
      selectionForeground: "#fbf1c7",
      selectionInactiveBackground: "#3c3836",
      black: "#282828",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#a89984",
      brightBlack: "#928374",
      brightRed: "#fb4934",
      brightGreen: "#b8bb26",
      brightYellow: "#fabd2f",
      brightBlue: "#83a598",
      brightMagenta: "#d3869b",
      brightCyan: "#8ec07c",
      brightWhite: "#ebdbb2",
    },
    light: {
      background: "#fbf1c7",
      foreground: "#3c3836",
      cursor: "#3c3836",
      cursorAccent: "#fbf1c7",
      selectionBackground: "#d5c4a1",
      selectionForeground: "#282828",
      selectionInactiveBackground: "#ebdbb2",
      black: "#fbf1c7",
      red: "#cc241d",
      green: "#98971a",
      yellow: "#d79921",
      blue: "#458588",
      magenta: "#b16286",
      cyan: "#689d6a",
      white: "#7c6f64",
      brightBlack: "#928374",
      brightRed: "#9d0006",
      brightGreen: "#79740e",
      brightYellow: "#b57614",
      brightBlue: "#076678",
      brightMagenta: "#8f3f71",
      brightCyan: "#427b58",
      brightWhite: "#3c3836",
    },
  },
  github: {
    dark: {
      background: "#0d1117",
      foreground: "#e6edf3",
      cursor: "#58a6ff",
      cursorAccent: "#0d1117",
      selectionBackground: "#264f78",
      selectionForeground: "#ffffff",
      selectionInactiveBackground: "#30363d",
      black: "#484f58",
      red: "#ff7b72",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#b1bac4",
      brightBlack: "#6e7681",
      brightRed: "#ffa198",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#f0f6fc",
    },
    light: {
      background: "#ffffff",
      foreground: "#24292f",
      cursor: "#0969da",
      cursorAccent: "#ffffff",
      selectionBackground: "#b6e3ff",
      selectionForeground: "#24292f",
      selectionInactiveBackground: "#d0d7de",
      black: "#24292f",
      red: "#cf222e",
      green: "#116329",
      yellow: "#4d2d00",
      blue: "#0969da",
      magenta: "#8250df",
      cyan: "#1b7c83",
      white: "#6e7781",
      brightBlack: "#57606a",
      brightRed: "#a40e26",
      brightGreen: "#1a7f37",
      brightYellow: "#9a6700",
      brightBlue: "#218bff",
      brightMagenta: "#a475f9",
      brightCyan: "#3192aa",
      brightWhite: "#8c959f",
    },
  },
  nord: {
    dark: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      cursorAccent: "#2e3440",
      selectionBackground: "#4c566a",
      selectionForeground: "#eceff4",
      selectionInactiveBackground: "#3b4252",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
      brightBlack: "#4c566a",
      brightRed: "#bf616a",
      brightGreen: "#a3be8c",
      brightYellow: "#ebcb8b",
      brightBlue: "#81a1c1",
      brightMagenta: "#b48ead",
      brightCyan: "#8fbcbb",
      brightWhite: "#eceff4",
    },
  },
  "one-dark-pro": {
    dark: {
      background: "#282c34",
      foreground: "#abb2bf",
      cursor: "#528bff",
      cursorAccent: "#282c34",
      selectionBackground: "#3e4451",
      selectionForeground: "#abb2bf",
      selectionInactiveBackground: "#353b45",
      black: "#282c34",
      red: "#e06c75",
      green: "#98c379",
      yellow: "#e5c07b",
      blue: "#61afef",
      magenta: "#c678dd",
      cyan: "#56b6c2",
      white: "#abb2bf",
      brightBlack: "#5c6370",
      brightRed: "#e06c75",
      brightGreen: "#98c379",
      brightYellow: "#e5c07b",
      brightBlue: "#61afef",
      brightMagenta: "#c678dd",
      brightCyan: "#56b6c2",
      brightWhite: "#ffffff",
    },
  },
  "rose-pine": {
    dark: {
      background: "#191724",
      foreground: "#e0def4",
      cursor: "#e0def4",
      cursorAccent: "#191724",
      selectionBackground: "#403d52",
      selectionForeground: "#e0def4",
      selectionInactiveBackground: "#26233a",
      black: "#26233a",
      red: "#eb6f92",
      green: "#31748f",
      yellow: "#f6c177",
      blue: "#9ccfd8",
      magenta: "#c4a7e7",
      cyan: "#ebbcba",
      white: "#e0def4",
      brightBlack: "#6e6a86",
      brightRed: "#eb6f92",
      brightGreen: "#31748f",
      brightYellow: "#f6c177",
      brightBlue: "#9ccfd8",
      brightMagenta: "#c4a7e7",
      brightCyan: "#ebbcba",
      brightWhite: "#e0def4",
    },
  },
  solarized: {
    dark: {
      background: "#002b36",
      foreground: "#839496",
      cursor: "#93a1a1",
      cursorAccent: "#002b36",
      selectionBackground: "#073642",
      selectionForeground: "#93a1a1",
      selectionInactiveBackground: "#073642",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
    light: {
      background: "#fdf6e3",
      foreground: "#657b83",
      cursor: "#657b83",
      cursorAccent: "#fdf6e3",
      selectionBackground: "#eee8d5",
      selectionForeground: "#586e75",
      selectionInactiveBackground: "#eee8d5",
      black: "#073642",
      red: "#dc322f",
      green: "#859900",
      yellow: "#b58900",
      blue: "#268bd2",
      magenta: "#d33682",
      cyan: "#2aa198",
      white: "#eee8d5",
      brightBlack: "#002b36",
      brightRed: "#cb4b16",
      brightGreen: "#586e75",
      brightYellow: "#657b83",
      brightBlue: "#839496",
      brightMagenta: "#6c71c4",
      brightCyan: "#93a1a1",
      brightWhite: "#fdf6e3",
    },
  },
  "tokyo-night": {
    dark: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      cursorAccent: "#1a1b26",
      selectionBackground: "#33467c",
      selectionForeground: "#c0caf5",
      selectionInactiveBackground: "#292e42",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
      brightBlack: "#414868",
      brightRed: "#f7768e",
      brightGreen: "#9ece6a",
      brightYellow: "#e0af68",
      brightBlue: "#7aa2f7",
      brightMagenta: "#bb9af7",
      brightCyan: "#7dcfff",
      brightWhite: "#c0caf5",
    },
  },
};

for (const themeId of ["everforest", "everforest-hard", "everforest-soft"]) {
  TERMINAL_THEME_PRESETS[themeId] = {
    dark: {
      background: themeId === "everforest-hard" ? "#272e33" : themeId === "everforest-soft" ? "#333c43" : "#2d353b",
      foreground: "#d3c6aa",
      cursor: "#d3c6aa",
      cursorAccent: "#2d353b",
      selectionBackground: "#4b565c",
      selectionForeground: "#d3c6aa",
      selectionInactiveBackground: "#3f4a50",
      black: "#4b565c",
      red: "#e67e80",
      green: "#a7c080",
      yellow: "#dbbc7f",
      blue: "#7fbbb3",
      magenta: "#d699b6",
      cyan: "#83c092",
      white: "#d3c6aa",
      brightBlack: "#5c6a72",
      brightRed: "#e67e80",
      brightGreen: "#a7c080",
      brightYellow: "#dbbc7f",
      brightBlue: "#7fbbb3",
      brightMagenta: "#d699b6",
      brightCyan: "#83c092",
      brightWhite: "#fff9e8",
    },
    light: {
      background: themeId === "everforest-hard" ? "#fffbef" : themeId === "everforest-soft" ? "#f3ead3" : "#fdf6e3",
      foreground: "#5c6a72",
      cursor: "#5c6a72",
      cursorAccent: "#fdf6e3",
      selectionBackground: "#e6e2cc",
      selectionForeground: "#5c6a72",
      selectionInactiveBackground: "#edeada",
      black: "#5c6a72",
      red: "#f85552",
      green: "#8da101",
      yellow: "#dfa000",
      blue: "#3a94c5",
      magenta: "#df69ba",
      cyan: "#35a77c",
      white: "#dfddc8",
      brightBlack: "#a6b0a0",
      brightRed: "#f85552",
      brightGreen: "#8da101",
      brightYellow: "#dfa000",
      brightBlue: "#3a94c5",
      brightMagenta: "#df69ba",
      brightCyan: "#35a77c",
      brightWhite: "#fffbef",
    },
  };
}

export function useAnnotateAgentTerminalTheme(): AnnotateAgentTerminalThemeState {
  const { colorTheme, resolvedMode } = useTheme();
  const terminalMode = resolveActiveAnnotateAgentTerminalMode(colorTheme, resolvedMode);
  const [palette, setPalette] = useState<ResolvedTerminalPalette>(() =>
    readResolvedTerminalPalette(terminalMode, colorTheme),
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setPalette(readResolvedTerminalPalette(terminalMode, colorTheme));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [colorTheme, terminalMode]);

  return useMemo(() => {
    const theme = resolveAnnotateAgentTerminalTheme(colorTheme, terminalMode, palette);
    return {
      theme,
      terminalOptions: {
        fontFamily: palette.fontMono,
        scrollbar: {
          width: 0,
        },
        theme,
      },
      colorScheme: terminalMode,
      shellStyle: {
        "--webtui-background": theme.background ?? PLANNOTATOR_DARK_TERMINAL_THEME.background!,
        "--webtui-foreground": theme.foreground ?? PLANNOTATOR_DARK_TERMINAL_THEME.foreground!,
        "--webtui-border": palette.border,
        backgroundColor: theme.background ?? PLANNOTATOR_DARK_TERMINAL_THEME.background,
      },
    };
  }, [colorTheme, palette, terminalMode]);
}

export function resolveAnnotateAgentTerminalMode(
  colorTheme: string,
  requestedMode: TerminalThemeMode,
): TerminalThemeMode {
  const themeInfo = BUILT_IN_THEMES.find((theme) => theme.id === colorTheme);
  if (themeInfo?.modeSupport === "dark-only") return "dark";
  if (themeInfo?.modeSupport === "light-only") return "light";
  return requestedMode;
}

export function resolveAnnotateAgentTerminalTheme(
  _colorTheme: string,
  mode: TerminalThemeMode,
  palette: ResolvedTerminalPalette,
): AnnotateAgentTerminalTheme {
  return palette.terminalTheme ?? buildAnnotateAgentTerminalTheme(palette, mode);
}

function resolveActiveAnnotateAgentTerminalMode(
  colorTheme: string,
  resolvedMode: TerminalThemeMode,
): TerminalThemeMode {
  const domMode = typeof document !== "undefined"
    ? (document.documentElement.classList.contains("light") ? "light" : "dark")
    : resolvedMode;
  return resolveAnnotateAgentTerminalMode(colorTheme, domMode);
}

export function buildAnnotateAgentTerminalTheme(
  palette: ResolvedTerminalPalette,
  mode: TerminalThemeMode,
): AnnotateAgentTerminalTheme {
  const brightTarget = mode === "light" ? "black" : "white";
  const brightMix = mode === "light" ? "84%" : "78%";
  const black = mode === "light" ? palette.foreground : palette.background;
  const white = mode === "light" ? palette.mutedForeground : palette.foreground;

  return {
    background: palette.background,
    foreground: palette.foreground,
    cursor: palette.primary,
    cursorAccent: palette.background,
    selectionBackground: palette.primary,
    selectionForeground: palette.foreground,
    selectionInactiveBackground: palette.border,
    black,
    red: palette.destructive,
    green: palette.success,
    yellow: palette.warning,
    blue: palette.primary,
    magenta: palette.accent,
    cyan: palette.secondary,
    white,
    brightBlack: palette.mutedForeground,
    brightRed: mixResolvedColor(palette.destructive, brightMix, brightTarget, palette.destructive),
    brightGreen: mixResolvedColor(palette.success, brightMix, brightTarget, palette.success),
    brightYellow: mixResolvedColor(palette.warning, brightMix, brightTarget, palette.warning),
    brightBlue: mixResolvedColor(palette.primary, brightMix, brightTarget, palette.primary),
    brightMagenta: mixResolvedColor(palette.accent, brightMix, brightTarget, palette.accent),
    brightCyan: mixResolvedColor(palette.focus, brightMix, brightTarget, palette.focus),
    brightWhite: palette.foreground,
  };
}

function readResolvedTerminalPalette(
  mode: TerminalThemeMode,
  colorTheme: string,
): ResolvedTerminalPalette {
  const fallbackPalette = createFallbackTerminalPalette(colorTheme, mode);
  if (typeof document === "undefined") return fallbackPalette;

  const style = window.getComputedStyle(document.documentElement);
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.position = "fixed";
  probe.style.pointerEvents = "none";
  probe.style.setProperty("transition", "none", "important");
  probe.style.visibility = "hidden";
  probe.style.color = fallbackPalette.foreground;
  document.documentElement.appendChild(probe);

  try {
    const readToken = (token: ResolvedTerminalPaletteColorKey, cssVar: string) =>
      resolveTokenColor(style, probe, cssVar, fallbackPalette[token]);
    const card = readToken("card", "--card");
    const foreground = resolveTokenColor(
      style,
      probe,
      "--terminal-foreground",
      readToken("foreground", "--foreground"),
    );
    const mutedForeground = readToken("mutedForeground", "--muted-foreground");
    const themedBackground = resolveTokenColor(
      style,
      probe,
      "--terminal-background",
      readToken("background", "--background"),
    );
    const terminalBackground = resolveTerminalBackground(themedBackground, fallbackPalette.background);
    const terminalForeground = resolveTerminalForeground(foreground, terminalBackground, fallbackPalette.foreground);

    const resolvedPalette: ResolvedTerminalPalette = {
      background: terminalBackground,
      foreground: terminalForeground,
      card,
      muted: readToken("muted", "--muted"),
      mutedForeground: resolveTerminalMutedForeground(
        mutedForeground,
        terminalBackground,
        fallbackPalette.mutedForeground,
      ),
      border: readToken("border", "--border"),
      primary: readToken("primary", "--primary"),
      secondary: readToken("secondary", "--secondary"),
      accent: readToken("accent", "--accent"),
      destructive: readToken("destructive", "--destructive"),
      success: readToken("success", "--success"),
      warning: readToken("warning", "--warning"),
      focus: resolveTokenColor(style, probe, "--focus-highlight", readToken("secondary", "--secondary")),
      fontMono: style.getPropertyValue("--font-mono").trim() || FALLBACK_MONO_FONT,
    };

    const derivedTheme = buildAnnotateAgentTerminalTheme(resolvedPalette, mode);
    const readTerminalColor = (
      cssVar: string,
      fallback: string | undefined,
    ): string => resolveTokenColor(style, probe, cssVar, fallback ?? terminalForeground);

    return {
      ...resolvedPalette,
      terminalTheme: {
        background: terminalBackground,
        foreground: terminalForeground,
        cursor: readTerminalColor("--terminal-cursor", derivedTheme.cursor),
        cursorAccent: readTerminalColor("--terminal-cursor-accent", derivedTheme.cursorAccent),
        selectionBackground: readTerminalColor(
          "--terminal-selection-background",
          derivedTheme.selectionBackground,
        ),
        selectionForeground: readTerminalColor(
          "--terminal-selection-foreground",
          derivedTheme.selectionForeground,
        ),
        selectionInactiveBackground: readTerminalColor(
          "--terminal-selection-inactive-background",
          derivedTheme.selectionInactiveBackground,
        ),
        black: readTerminalColor("--terminal-black", derivedTheme.black),
        red: readTerminalColor("--terminal-red", derivedTheme.red),
        green: readTerminalColor("--terminal-green", derivedTheme.green),
        yellow: readTerminalColor("--terminal-yellow", derivedTheme.yellow),
        blue: readTerminalColor("--terminal-blue", derivedTheme.blue),
        magenta: readTerminalColor("--terminal-magenta", derivedTheme.magenta),
        cyan: readTerminalColor("--terminal-cyan", derivedTheme.cyan),
        white: readTerminalColor("--terminal-white", derivedTheme.white),
        brightBlack: readTerminalColor("--terminal-bright-black", derivedTheme.brightBlack),
        brightRed: readTerminalColor("--terminal-bright-red", derivedTheme.brightRed),
        brightGreen: readTerminalColor("--terminal-bright-green", derivedTheme.brightGreen),
        brightYellow: readTerminalColor("--terminal-bright-yellow", derivedTheme.brightYellow),
        brightBlue: readTerminalColor("--terminal-bright-blue", derivedTheme.brightBlue),
        brightMagenta: readTerminalColor("--terminal-bright-magenta", derivedTheme.brightMagenta),
        brightCyan: readTerminalColor("--terminal-bright-cyan", derivedTheme.brightCyan),
        brightWhite: readTerminalColor("--terminal-bright-white", derivedTheme.brightWhite),
      },
    };
  } finally {
    probe.remove();
  }
}

function createFallbackTerminalPalette(
  colorTheme: string,
  mode: TerminalThemeMode,
): ResolvedTerminalPalette {
  const themeInfo = BUILT_IN_THEMES.find((theme) => theme.id === colorTheme)
    ?? BUILT_IN_THEMES.find((theme) => theme.id === "plannotator");
  const colors = themeInfo?.colors[mode] ?? themeInfo?.colors.dark;
  const defaultTheme = mode === "light"
    ? PLANNOTATOR_LIGHT_TERMINAL_THEME
    : PLANNOTATOR_DARK_TERMINAL_THEME;
  const background = normalizeStaticColor(colors?.background, defaultTheme.background!);
  const foreground = normalizeStaticColor(colors?.foreground, defaultTheme.foreground!);
  const primary = normalizeStaticColor(colors?.primary, defaultTheme.blue!);
  const secondary = normalizeStaticColor(colors?.secondary, defaultTheme.cyan!);
  const accent = normalizeStaticColor(colors?.accent, defaultTheme.magenta!);
  const preset = TERMINAL_THEME_PRESETS[colorTheme]?.[mode];
  const terminalTheme = preset
    ? {
        ...preset,
        background,
        foreground,
        cursor: primary,
        cursorAccent: background,
        selectionForeground: foreground,
        brightWhite: foreground,
      }
    : undefined;

  return {
    background,
    foreground,
    card: background,
    muted: mode === "light" ? "#ebe8f2" : "#252838",
    mutedForeground: mode === "light" ? "#6f6a7d" : "#aeb0c0",
    border: mode === "light" ? "#ddd9e8" : "#363a4d",
    primary,
    secondary,
    accent,
    destructive: mode === "light" ? "#c02635" : "#ff6b7a",
    success: mode === "light" ? "#15803d" : "#5ee09d",
    warning: mode === "light" ? "#a16207" : "#f5c451",
    focus: secondary,
    fontMono: FALLBACK_MONO_FONT,
    terminalTheme,
  };
}

function normalizeStaticColor(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  return normalizeKnownCssColor(value) ?? value;
}

function resolveTokenColor(
  style: CSSStyleDeclaration,
  probe: HTMLElement,
  cssVar: string,
  fallback: string,
): string {
  const rawValue = style.getPropertyValue(cssVar).trim();
  if (!rawValue) return fallback;
  const normalizedToken = normalizeKnownCssColor(rawValue);
  if (normalizedToken) return normalizedToken;
  return resolveCssColor(probe, `var(${cssVar})`, fallback);
}

function mixResolvedColor(
  color: string,
  colorMix: string,
  target: "black" | "white",
  fallback: string,
): string {
  if (typeof document === "undefined") return fallback;

  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.position = "fixed";
  probe.style.pointerEvents = "none";
  probe.style.visibility = "hidden";
  document.documentElement.appendChild(probe);

  try {
    return resolveCssColor(probe, `color-mix(in srgb, ${color} ${colorMix}, ${target})`, fallback);
  } finally {
    probe.remove();
  }
}

function resolveCssColor(probe: HTMLElement, value: string, fallback: string): string {
  probe.style.color = fallback;
  probe.style.color = value;
  const resolved = window.getComputedStyle(probe).color.trim();
  if (!resolved) return fallback;
  return normalizeWithCanvas(resolved, fallback);
}

function normalizeWithCanvas(value: string, fallback: string): string {
  const knownColor = normalizeKnownCssColor(value);
  if (knownColor) return knownColor;

  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return value;

  const sentinel = "#010203";
  context.fillStyle = sentinel;
  context.fillStyle = value;
  if (context.fillStyle === sentinel && !isSentinelColor(value)) return fallback;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
  if (a === 0) return fallback;
  if (a < 255) return `rgb(${blendChannel(r, a)}, ${blendChannel(g, a)}, ${blendChannel(b, a)})`;
  return `rgb(${r}, ${g}, ${b})`;
}

function normalizeKnownCssColor(value: string): string | null {
  const rgb = parseRgb(value);
  if (rgb) return rgbToCss(rgb);
  const hex = parseHex(value);
  if (hex) return rgbToCss(hex);
  const oklab = parseOklab(value);
  if (oklab) return rgbToCss(oklab);
  const oklch = parseOklch(value);
  if (oklch) return rgbToCss(oklch);
  return null;
}

function isSentinelColor(value: string): boolean {
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  return normalized === "#010203" || normalized === "rgb(1,2,3)";
}

function resolveTerminalBackground(color: string, fallback: string): string {
  const rgb = parseRgb(color);
  if (!rgb) return fallback;
  return color;
}

function resolveTerminalForeground(color: string, background: string, fallback: string): string {
  const foreground = parseRgb(color);
  const bg = parseRgb(background);
  if (!foreground || !bg) return fallback;
  return color;
}

function resolveTerminalMutedForeground(color: string, background: string, fallback: string): string {
  const foreground = parseRgb(color);
  const bg = parseRgb(background);
  if (!foreground || !bg) return fallback;
  return color;
}

function parseRgb(color: string): [number, number, number] | null {
  const match = color.match(/rgba?\(\s*([\d.]+)(?:,|\s)\s*([\d.]+)(?:,|\s)\s*([\d.]+)/i);
  if (!match) return null;
  return [
    clampColorChannel(Number(match[1])),
    clampColorChannel(Number(match[2])),
    clampColorChannel(Number(match[3])),
  ];
}

function parseHex(color: string): [number, number, number] | null {
  const trimmed = color.trim();
  const short = trimmed.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) {
    return [
      parseInt(short[1] + short[1], 16),
      parseInt(short[2] + short[2], 16),
      parseInt(short[3] + short[3], 16),
    ];
  }
  const long = trimmed.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (!long) return null;
  return [parseInt(long[1], 16), parseInt(long[2], 16), parseInt(long[3], 16)];
}

function parseOklch(color: string): [number, number, number] | null {
  const match = color
    .trim()
    .match(/^oklch\(\s*([+-]?[\d.]+%?)\s+([+-]?[\d.]+%?)\s+([+-]?[\d.]+)(?:deg)?(?:\s*\/\s*[\d.]+%?)?\s*\)$/i);
  if (!match) return null;
  const l = parseCssNumber(match[1], 1);
  const c = parseCssNumber(match[2], 0.4);
  const h = Number(match[3]);
  if (![l, c, h].every(Number.isFinite)) return null;
  return oklchToRgb(l, c, h);
}

function parseOklab(color: string): [number, number, number] | null {
  const match = color
    .trim()
    .match(/^oklab\(\s*([+-]?[\d.]+%?)\s+([+-]?[\d.]+%?)\s+([+-]?[\d.]+%?)(?:\s*\/\s*[\d.]+%?)?\s*\)$/i);
  if (!match) return null;
  const l = parseCssNumber(match[1], 1);
  const a = parseCssNumber(match[2], 0.4);
  const b = parseCssNumber(match[3], 0.4);
  if (![l, a, b].every(Number.isFinite)) return null;
  return oklabToRgb(l, a, b);
}

function parseCssNumber(value: string, percentScale: number): number {
  if (value.endsWith("%")) return (Number(value.slice(0, -1)) / 100) * percentScale;
  return Number(value);
}

function oklchToRgb(l: number, c: number, h: number): [number, number, number] {
  const hue = (h * Math.PI) / 180;
  const a = c * Math.cos(hue);
  const b = c * Math.sin(hue);

  return oklabToRgb(l, a, b);
}

function oklabToRgb(l: number, a: number, b: number): [number, number, number] {
  const lPrime = l + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = l - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = l - 0.0894841775 * a - 1.291485548 * b;

  const lCubed = lPrime ** 3;
  const mCubed = mPrime ** 3;
  const sCubed = sPrime ** 3;

  return [
    linearSrgbToByte(4.0767416621 * lCubed - 3.3077115913 * mCubed + 0.2309699292 * sCubed),
    linearSrgbToByte(-1.2684380046 * lCubed + 2.6097574011 * mCubed - 0.3413193965 * sCubed),
    linearSrgbToByte(-0.0041960863 * lCubed - 0.7034186147 * mCubed + 1.707614701 * sCubed),
  ];
}

function linearSrgbToByte(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  const srgb = clamped <= 0.0031308
    ? 12.92 * clamped
    : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return clampColorChannel(srgb * 255);
}

function rgbToCss([r, g, b]: [number, number, number]): string {
  return `rgb(${r}, ${g}, ${b})`;
}

function clampColorChannel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

function blendChannel(channel: number, alpha: number): number {
  return Math.round((channel * alpha + 255 * (255 - alpha)) / 255);
}
