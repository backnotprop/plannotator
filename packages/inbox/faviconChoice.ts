/**
 * The Inbox's favicon: Settings → General → Appearance → Favicon, the same
 * three choices as plan review's Theme tab (Glass, Yellow, Face;
 * FAVICON_STYLE_CHOICES in @plannotator/core/favicon).
 *
 * One shared choice: config.json `favicon`, which plan review, code review
 * and annotate write through POST /api/config and which the Inbox writes
 * through POST /api/inbox/settings `{ favicon }`. Every server's
 * `/favicon.ico` and `/favicon.png` answer with it, so the next page load of any of them shows it.
 *
 * A pick here shows at once, without a reload: the tab icon becomes the
 * chosen icon's data URL, and the tab count (tabCount.ts) redraws its badge
 * over it. A choice made elsewhere (plan review, another Inbox window) shows
 * in this window at its next load.
 */

import { useSyncExternalStore } from 'react';
import { faviconDataUrl, faviconPngDataUrl, isFaviconStyle, type FaviconStyle } from '@plannotator/core/favicon';
import { inboxApi } from './api';

/** config.json's choice, from the settings read; null until it answers (or from an older Inbox). */
let current: FaviconStyle | null = null;
/** The icon picked on this page: the tab shows it from then on. */
let chosenHere: FaviconStyle | null = null;
/** An icon tried on this tab only (the tab icon dialog's choices), never saved; null when none is. */
let previewing: FaviconStyle | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** config.json's choice, from each settings read, never over a choice made on this page. */
export function adoptSavedFavicon(style: unknown): void {
  if (chosenHere || !isFaviconStyle(style) || style === current) return;
  current = style;
  notify();
}

/** The person's choice: on the tab at once, then saved to config.json. */
export function chooseFavicon(style: FaviconStyle): Promise<void> {
  current = style;
  chosenHere = style;
  previewing = null;
  notify();
  return inboxApi.saveFavicon(style).then(
    () => {},
    () => {},
  );
}

/**
 * Try an icon on this tab only, without saving it (the tab icon dialog, TabIconChoice.tsx: each choice shows at once).
 * Null puts back the icon the tab showed before the first try: the one it loaded with, or one picked on this page.
 */
export function previewFavicon(style: FaviconStyle | null): void {
  if (style === previewing) return;
  previewing = style;
  notify();
}

/** A favicon was picked on this page (Settings' row): the tab icon dialog no longer asks. */
export function faviconPickedHere(): boolean {
  return chosenHere !== null;
}

/** What the tab shows: a try, else a pick made on this page; null for the icon it loaded with. */
const onTab = (): FaviconStyle | null => previewing ?? chosenHere;

export function useInboxFavicon(): FaviconStyle | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

/** The tab icon picked on this page, as a data URL; null while the page shows the icon it loaded with. */
export function useInboxFaviconHref(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => {
      const style = onTab();
      return style ? faviconDataUrl(style) : null;
    },
    () => null,
  );
}

/** The picked icon as one PNG, what the tab-count badge is drawn over; null like useInboxFaviconHref. */
export function useInboxFaviconBadgeHref(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => {
      const style = onTab();
      return style ? faviconPngDataUrl(style) : null;
    },
    () => null,
  );
}

/** Tests only: a fresh page that has not read its settings. */
export function resetInboxFaviconForTests(): void {
  current = null;
  chosenHere = null;
  previewing = null;
  notify();
}
