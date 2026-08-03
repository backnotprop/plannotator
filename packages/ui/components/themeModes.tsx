import type { FC } from 'react';
import { MoonIcon, SunIcon, SystemIcon, type IconProps } from './icons/themeIcons';

interface ThemeMode {
  readonly id: string;
  readonly label: string;
  readonly Icon: FC<IconProps>;
}

/** The shared catalog rendered by every Light/Dark/System picker. */
export const THEME_MODES = [
  { id: 'light', label: 'Light', Icon: SunIcon },
  { id: 'dark', label: 'Dark', Icon: MoonIcon },
  { id: 'system', label: 'System', Icon: SystemIcon },
] as const satisfies readonly ThemeMode[];

/** A persisted theme-mode preference. */
export type Mode = (typeof THEME_MODES)[number]['id'];

/** Return whether an unknown persisted value is a supported theme mode. */
export function isThemeMode(value: unknown): value is Mode {
  return typeof value === 'string' && THEME_MODES.some(({ id }) => id === value);
}

/** Parse an unknown persisted value, falling back to a caller-provided mode. */
export function parseThemeMode(value: unknown, fallback: Mode): Mode {
  return isThemeMode(value) ? value : fallback;
}
