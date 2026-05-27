declare module "@plannotator/ui/hooks/useSessionFetch" {
  import type { ReactNode } from "react";
  type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  export function SessionProvider(props: { sessionId: string; children: ReactNode }): ReactNode;
  export function useSessionFetch(): FetchFn;
}

declare module "@plannotator/ui/components/ThemeProvider" {
  import type { ReactNode } from "react";
  export type Mode = "dark" | "light" | "system";
  interface ThemeInfo {
    id: string;
    name: string;
    builtIn: boolean;
    modeSupport: "both" | "dark-only" | "light-only";
  }
  interface ThemeProviderState {
    theme: Mode;
    setTheme: (mode: Mode) => void;
    mode: Mode;
    setMode: (mode: Mode) => void;
    resolvedMode: "dark" | "light";
    colorTheme: string;
    setColorTheme: (theme: string) => void;
    availableThemes: ThemeInfo[];
  }
  export function ThemeProvider(props: {
    children: ReactNode;
    defaultTheme?: Mode;
    defaultColorTheme?: string;
    storageKey?: string;
    colorThemeStorageKey?: string;
  }): ReactNode;
  export function useTheme(): ThemeProviderState;
}

declare module "*.png" {
  const src: string;
  export default src;
}

declare const __APP_VERSION__: string;
