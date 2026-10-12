/**
 * Light and dark in the Inbox: the sidebar's toggle and Settings' Theme row.
 *
 * Both write Plannotator's own theme mode (`themePair.mode` in
 * @plannotator/ui's config store): the `plannotator-theme` cookie at once,
 * and config.json `theme` through POST /api/inbox/settings, the value plan
 * review, code review and annotate read through /api/config. So a choice made
 * here holds in the next plan review, and one made there holds here. The
 * palettes for each half are left as they are; only the mode changes.
 */

import { useCallback } from 'react';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { configStore, type ServerSyncFn } from '@plannotator/ui/config';
import type { Mode } from '@plannotator/ui/theme-modes';
import { inboxApi, type InboxThemeConfig } from './api';

/**
 * The config store's server write-back, for the Inbox: it has no /api/config,
 * so only `theme` goes anywhere (to config.json through the Inbox's settings
 * route); every other server-synced setting stays in the page's cookies.
 */
export const inboxThemeSync: ServerSyncFn = (payload) => {
  const theme = payload.theme;
  if (theme && typeof theme === 'object' && !Array.isArray(theme)) {
    void inboxApi.saveTheme(theme as InboxThemeConfig).catch(() => {});
  }
};

let adopted = false;
let chosenHere = false;

/**
 * config.json's `theme` wins over the cookie, as it does in plan review, but
 * only from the first settings read, and never over a choice made in this
 * page before that read answered.
 */
export function adoptSavedTheme(theme: InboxThemeConfig | null | undefined): void {
  if (adopted) return;
  adopted = true;
  if (theme && !chosenHere) configStore.init({ theme });
}

/**
 * Under reduced motion the switch lands in one frame: the global colour
 * crossfade (theme.css's 150 ms `*` transition) is held off until the new
 * colours are painted. Otherwise it crossfades, as plan review does.
 */
function landInstantlyIfReducedMotion(): void {
  if (typeof window === 'undefined' || !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const root = document.documentElement;
  root.classList.add('ib-theme-instant');
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('ib-theme-instant')));
}

export interface InboxTheme {
  /** The stored choice: light, dark, or system (follow this computer). */
  mode: Mode;
  /** What is on screen now. */
  shown: 'light' | 'dark';
  choose: (mode: Mode) => void;
  /** The sidebar's toggle: an explicit light or dark, the opposite of what is shown. */
  flip: () => void;
}

export function useInboxTheme(): InboxTheme {
  const { mode, resolvedMode, setMode } = useTheme();
  const choose = useCallback(
    (next: Mode) => {
      chosenHere = true;
      landInstantlyIfReducedMotion();
      setMode(next);
    },
    [setMode],
  );
  const flip = useCallback(() => choose(resolvedMode === 'dark' ? 'light' : 'dark'), [choose, resolvedMode]);
  return { mode, shown: resolvedMode, choose, flip };
}
