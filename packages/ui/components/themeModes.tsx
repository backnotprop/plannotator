import type { FC } from 'react';
import { MoonIcon, SunIcon, SystemIcon, type IconProps } from './icons/themeIcons';

interface ThemeMode {
  readonly id: string;
  readonly label: string;
  readonly Icon: FC<IconProps>;
}

export const THEME_MODES = [
  { id: 'light', label: 'Light', Icon: SunIcon },
  { id: 'dark', label: 'Dark', Icon: MoonIcon },
  { id: 'system', label: 'System', Icon: SystemIcon },
] as const satisfies readonly ThemeMode[];

export type Mode = (typeof THEME_MODES)[number]['id'];

export function isThemeMode(value: unknown): value is Mode {
  return typeof value === 'string' && THEME_MODES.some(({ id }) => id === value);
}

export function parseThemeMode(value: unknown, fallback: Mode): Mode {
  return isThemeMode(value) ? value : fallback;
}
