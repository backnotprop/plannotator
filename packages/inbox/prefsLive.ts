/**
 * `event: prefs` (core inbox-prefs.ts): preferences saved here, in another window or by an agent. The window reads
 * its settings again and takes at once the keys that paint (the theme, the text size, the tab icon, the diffs), which
 * the first-read adoption never does. Frames that arrive close together share one read; only the newest read lands.
 * Quiet: a read that fails waits for the next frame or the stream's reconnect.
 */
import { useEffect } from 'react';
import { inboxApi, type SettingsModel } from './api';
import { prefsFrameListeners } from './eventFrames';
import { takeSavedTheme } from './theme';
import { takeSavedDiffOptions } from './diffOptions';
import { takeSavedTextSize, textSizeReadMark } from './textSize';
import { faviconReadMark, takeSavedFavicon } from './faviconChoice';
import { adoptSavedReactions, reactionsReadMark } from './reactions';
import { adoptSavedRows, listLookReadMark } from './listLook';
import { adoptSavedSidebar, sidebarLayoutReadMark } from './sidebarLayout';
import { adoptVoiceSettings } from './voice';

let readSeq = 0;

async function takeSavedPrefs(keys: readonly string[], setSettings: (next: SettingsModel) => void): Promise<void> {
  const mine = ++readSeq;
  try {
    const mark = listLookReadMark();
    const reactionsMark = reactionsReadMark();
    const sidebarMark = sidebarLayoutReadMark();
    const textSizeMark = textSizeReadMark();
    const faviconMark = faviconReadMark();
    const next = await inboxApi.settings();
    if (mine !== readSeq) return;
    if (keys.some((key) => key === 'appearance.theme' || key.endsWith('_palette'))) takeSavedTheme(next.theme);
    if (keys.includes('appearance.text_size')) takeSavedTextSize(next.text_size, textSizeMark);
    if (keys.includes('appearance.tab_icon')) takeSavedFavicon(next.favicon, faviconMark);
    if (keys.some((key) => key.startsWith('diff.'))) takeSavedDiffOptions(next.diff_options);
    adoptSavedReactions(next.reactions, next.reactions_rev, reactionsMark);
    adoptSavedRows(next.rows, next.rows_rev, mark);
    adoptSavedSidebar(next.sidebar, next.sidebar_rev, sidebarMark);
    if (keys.some((key) => key.startsWith('voice.'))) adoptVoiceSettings(next.voice);
    setSettings(next);
  } catch {
    // Kept as it is: the next frame, or the stream's reconnect, reads again.
  }
}

/** While mounted, `event: prefs` moves this window: its settings (`setSettings`), and Settings → Agents for `agents.*`. */
export function usePrefsLive(setSettings: (next: SettingsModel) => void, refreshAgents: () => unknown): void {
  useEffect(() => {
    const heard = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const hear = (keys: string[]) => {
      for (const key of keys) heard.add(key);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const now = [...heard];
        heard.clear();
        void takeSavedPrefs(now, setSettings);
        if (now.some((key) => key.startsWith('agents.'))) void refreshAgents();
      }, 60);
    };
    prefsFrameListeners.add(hear);
    return () => {
      prefsFrameListeners.delete(hear);
      if (timer) clearTimeout(timer);
    };
  }, [setSettings, refreshAgents]);
}
