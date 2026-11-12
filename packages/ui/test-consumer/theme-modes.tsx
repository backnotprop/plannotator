import type { ReactNode } from 'react';
import {
  ThemeProvider,
  useTheme,
  type Mode as LegacyMode,
} from '@plannotator/ui/components/ThemeProvider';
import { THEME_MODES, type Mode } from '@plannotator/ui/theme-modes';

const legacyMode: LegacyMode = 'system';
const publicMode: Mode = legacyMode;

export function PublishedThemeConsumer({ children }: { children: ReactNode }) {
  return <ThemeProvider defaultTheme={publicMode}>{children}</ThemeProvider>;
}

export function PublishedThemeModeLabels(): string {
  const { mode } = useTheme();
  return THEME_MODES.map(({ id, label }) => `${id === mode ? '*' : ''}${label}`).join(',');
}
