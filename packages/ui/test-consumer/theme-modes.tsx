import type { ReactNode } from 'react';
import {
  ThemeProvider,
  useTheme,
  type Mode as LegacyMode,
} from '@plannotator/ui/components/ThemeProvider';
import { THEME_MODES, type Mode } from '@plannotator/ui/theme-modes';

const legacyMode: LegacyMode = 'system';
const publicMode: Mode = legacyMode;

/** Compile-only consumer proving both published Mode paths remain compatible. */
export function PublishedThemeConsumer({ children }: { children: ReactNode }) {
  return <ThemeProvider defaultTheme={publicMode}>{children}</ThemeProvider>;
}

/** Compile-only consumer proving the public catalog and provider agree. */
export function PublishedThemeModeLabels(): string {
  const { mode } = useTheme();
  return THEME_MODES.map(({ id, label }) => `${id === mode ? '*' : ''}${label}`).join(',');
}
