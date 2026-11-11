import { perfInteraction } from './perfMarks';
import { useCallback } from 'react';
import { useTheme } from '@plannotator/ui/components/ThemeProvider';
import { useThemePaletteHalves, type ThemePaletteHalves } from '@plannotator/ui/hooks/useThemePaletteHalves';
import { themeSupportsHalf, type ThemeHalf } from '@plannotator/ui/utils/themeRegistry';
import { configStore, type ServerSyncFn } from '@plannotator/ui/config';
import type { Mode } from '@plannotator/ui/theme-modes';
import { inboxApi, type InboxThemeConfig } from './api';
import { diffOptionsToWire } from './diffOptions';

/** Only fields the person chose on this page are sent: this tab's copy of the other parts can be stale (a palette picked in plan review since load) or defaults, and sending them would undo those choices. */
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
  const diffOptions = diffOptionsToWire(payload.diffOptions);
  if (diffOptions) void inboxApi.saveDiffOptions(diffOptions).catch(() => {});
};

let adopted = false;
const chosenFields = new Set<ThemeField>();

function markChosen(field: ThemeField): void {
  chosenFields.add(field);
  changedThemeFields.add(field);
}

/** config.json's `theme` wins over the cookie, but only from the first settings read and per field: parts chosen on this page before that read keep the page's value. */
export function adoptSavedTheme(theme: InboxThemeConfig | null | undefined): void {
  if (adopted) return;
  adopted = true;
  if (!theme) return;
  if (chosenFields.size === 0) {
    configStore.init({ theme });
    return;
  }
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

export function resetInboxThemeForTests(): void {
  adopted = false;
  chosenFields.clear();
  changedThemeFields.clear();
}

export interface InboxTheme {
  mode: Mode;
  shown: 'light' | 'dark';
  choose: (mode: Mode) => void;
  flip: () => void;
}

export function useInboxTheme(): InboxTheme {
  const { mode, resolvedMode, setMode } = useTheme();
  const choose = useCallback(
    (next: Mode) => {
      markChosen('mode');
      perfInteraction('theme');
      setMode(next);
    },
    [setMode],
  );
  const flip = useCallback(() => choose(resolvedMode === 'dark' ? 'light' : 'dark'), [choose, resolvedMode]);
  return { mode, shown: resolvedMode, choose, flip };
}

export interface InboxPalettes extends ThemePaletteHalves {
  shown: ThemeHalf;
}

export function useInboxPalettes(): InboxPalettes {
  const halves = useThemePaletteHalves();
  const { resolvedMode } = useTheme();
  const { choose: assign } = halves;
  const choose = useCallback(
    (half: ThemeHalf, id: string) => {
      // A palette that cannot draw this half is refused by the provider, so nothing would be written.
      if (!themeSupportsHalf(id, half)) return;
      markChosen(half);
      assign(half, id);
    },
    [assign],
  );
  return { ...halves, choose, shown: resolvedMode };
}

export function useInboxThemePick(): (pick: { light: string; dark: string; mode: Mode }) => void {
  const { mode, choose: chooseMode } = useInboxTheme();
  const { pair, choose: choosePalette } = useInboxPalettes();
  return useCallback(
    (pick) => {
      if (pick.light !== pair.light) choosePalette('light', pick.light);
      if (pick.dark !== pair.dark) choosePalette('dark', pick.dark);
      if (pick.mode !== mode) chooseMode(pick.mode);
    },
    [mode, pair.light, pair.dark, chooseMode, choosePalette],
  );
}
