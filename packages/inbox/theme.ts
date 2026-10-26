/**
 * Light and dark in the Inbox: the sidebar's toggle and Settings' Theme row.
 *
 * Both write Plannotator's own theme mode (`themePair.mode` in
 * @plannotator/ui's config store): the `plannotator-theme` cookie at once,
 * and config.json `theme` through POST /api/inbox/settings, the value plan
 * review, code review and annotate read through /api/config. So a choice made
 * here holds in the next plan review, and one made there holds here.
 *
 * Settings' Colors row picks the palette for the light half and the dark half
 * (useInboxPalettes), the same choices as plan review's Theme tab. Only the
 * part the person changed goes to the server: a mode, or one half's palette.
 */

import { useCallback } from 'react';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { useThemePaletteHalves, type ThemePaletteHalves } from '@plannotator/ui/hooks/useThemePaletteHalves';
import { themeSupportsHalf, type ThemeHalf } from '@plannotator/ui/utils/themeRegistry';
import { configStore, type ServerSyncFn } from '@plannotator/ui/config';
import type { Mode } from '@plannotator/ui/theme-modes';
import { inboxApi, type InboxThemeConfig } from './api';

/**
 * The config store's server write-back, for the Inbox: it has no /api/config,
 * so only what the Inbox itself changes goes anywhere, through its settings
 * route (which merges per field): the parts of the theme the person changed
 * in this page (config.json `theme`) and the guided review's diff layout
 * (config.json `diffOptions.diffStyle`, diffStyle.ts). Every other
 * server-synced setting stays in the page's cookies. The store hands over the
 * whole theme pair, but this tab's copy of the parts the person did not touch
 * can be days old (a palette picked in plan review since this tab loaded) or
 * the defaults (a page with no cookies): sending them would undo the person's
 * choices. So only the fields marked by `useInboxTheme().choose` (the mode)
 * and `useInboxPalettes().choose` (one half) go; with none marked (a write the
 * Inbox did not make), only the mode, as before palettes could be picked here.
 * These marks are the POST still to send, cleared when it goes; what the
 * person chose on this page at all is `chosenFields`, below.
 */
type ThemeField = 'mode' | ThemeHalf;
const THEME_FIELDS: readonly ThemeField[] = ['mode', 'light', 'dark'];
const changedThemeFields = new Set<ThemeField>();

export const inboxServerSync: ServerSyncFn = (payload) => {
  const theme = payload.theme as InboxThemeConfig | undefined;
  if (theme) {
    const fields = changedThemeFields.size > 0 ? [...changedThemeFields] : (['mode'] as const);
    changedThemeFields.clear();
    const send: InboxThemeConfig = {};
    for (const field of fields) {
      const value = theme[field];
      if (field === 'mode') {
        if (value === 'light' || value === 'dark' || value === 'system') send.mode = value;
      } else if (typeof value === 'string' && value) {
        send[field] = value;
      }
    }
    if (Object.keys(send).length > 0) void inboxApi.saveTheme(send).catch(() => {});
  }
  const diffStyle = (payload.diffOptions as { diffStyle?: unknown } | undefined)?.diffStyle;
  if (diffStyle === 'split' || diffStyle === 'unified') {
    void inboxApi.saveDiffStyle(diffStyle).catch(() => {});
  }
};

let adopted = false;
/** The parts of the theme the person chose on this page (kept for the page's life, unlike the POST marks). */
const chosenFields = new Set<ThemeField>();

/** Mark a part of the theme as the person's choice on this page, and as still to send. */
function markChosen(field: ThemeField): void {
  chosenFields.add(field);
  changedThemeFields.add(field);
}

/**
 * config.json's `theme` wins over the cookie, as it does in plan review, but
 * only from the first settings read, and per field: a part the person chose
 * on this page before that read answered (the mode, or one half's palette)
 * keeps the page's value, and every other part comes from config.json. So a
 * mode flipped before the read still takes the palettes plan review saved.
 */
export function adoptSavedTheme(theme: InboxThemeConfig | null | undefined): void {
  if (adopted) return;
  adopted = true;
  if (!theme) return;
  if (chosenFields.size === 0) {
    configStore.init({ theme });
    return;
  }
  // Nothing in config.json the person did not already choose here: nothing to adopt.
  if (!THEME_FIELDS.some((field) => theme[field] !== undefined && !chosenFields.has(field))) return;
  const current = configStore.get('themePair');
  const merged: InboxThemeConfig = { ...theme };
  for (const field of chosenFields) {
    if (field === 'mode') merged.mode = current.mode;
    else merged[field] = current[field];
  }
  configStore.init({ theme: merged });
  // init retracts a theme write still queued; the person's pick is still owed to the server (its marks are set), so queue it again.
  if (changedThemeFields.size > 0) configStore.set('themePair', configStore.get('themePair'));
}

/** Tests only: forget the first settings read and any choice, as a fresh page would. */
export function resetInboxThemeForTests(): void {
  adopted = false;
  chosenFields.clear();
  changedThemeFields.clear();
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
      markChosen('mode');
      landInstantlyIfReducedMotion();
      setMode(next);
    },
    [setMode],
  );
  const flip = useCallback(() => choose(resolvedMode === 'dark' ? 'light' : 'dark'), [choose, resolvedMode]);
  return { mode, shown: resolvedMode, choose, flip };
}

export interface InboxPalettes extends ThemePaletteHalves {
  /** The half on screen now (its palette is the one the window shows). */
  shown: ThemeHalf;
}

/**
 * Settings' Colors row: plan review's palette choices (ThemeTab's
 * useThemePaletteHalves, the registry's palettes for each half), with a pick
 * applied at once and only that half sent to config.json.
 */
export function useInboxPalettes(): InboxPalettes {
  const halves = useThemePaletteHalves();
  const { resolvedMode } = useTheme();
  const { choose: assign } = halves;
  const choose = useCallback(
    (half: ThemeHalf, id: string) => {
      // A palette that cannot draw this half is refused by the provider, so nothing would be written.
      if (!themeSupportsHalf(id, half)) return;
      markChosen(half);
      landInstantlyIfReducedMotion();
      assign(half, id);
    },
    [assign],
  );
  return { ...halves, choose, shown: resolvedMode };
}
