import type { FC } from 'react';
import { SunIcon, MoonIcon, SystemIcon } from './icons/themeIcons';
import type { IconProps } from './icons/themeIcons';

/** A theme mode paired with how a picker draws it. */
interface ThemeMode {
  readonly id: string;
  readonly label: string;
  readonly Icon: FC<IconProps>;
}

/** The one shared list of theme modes every picker renders.
 *  `as const` preserves each literal `id`; `satisfies` checks each
 *  entry's shape without widening it. */
export const THEME_MODES = [
  { id: 'light', label: 'Light', Icon: SunIcon },
  { id: 'dark', label: 'Dark', Icon: MoonIcon },
  { id: 'system', label: 'System', Icon: SystemIcon },
] as const satisfies readonly ThemeMode[];

/** A theme mode's id — the union of every id in THEME_MODES.
 *  A mode cannot exist without a render entry. */
export type Mode = (typeof THEME_MODES)[number]['id'];
